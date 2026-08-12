'use client';

/**
 * Authenticated file downloads.
 *
 * Kept out of apiFetch because apiFetch is JSON end to end — it forces a JSON
 * Content-Type and finishes with res.json(). Everything else about it has to be
 * repeated here rather than skipped: the bearer header and the single-flight
 * refresh are not conveniences, they are the whole reason a plain
 * `<a href download>` cannot be used against this API. An anchor sends no
 * Authorization header, the guard chain is fail-closed, and the browser then
 * either saves the 401 body or does nothing at all — with no error anywhere.
 */

import { API_BASE, ApiError, refreshTokens, tokens } from './api';

export interface DownloadResult {
  /**
   * Byte length of what was saved. Zero is a perfectly valid response and a
   * worthless piece of evidence, so the caller is given the chance to say so
   * instead of handing someone an empty file in the middle of a dispute.
   */
  bytes: number;
  filename: string;
}

/**
 * Fetch `path` with the dispatcher's access token and hand the body to the
 * browser as a file. Throws ApiError on anything but success — a download that
 * fails must be visible, because an invisible one survives for months.
 */
export async function downloadAuthed(
  path: string,
  filename: string,
  retry = true,
): Promise<DownloadResult> {
  const headers = new Headers();
  const access = tokens.access;
  if (access) headers.set('Authorization', `Bearer ${access}`);

  const res = await fetch(`${API_BASE}${path}`, { headers });

  /*
   * Same contract as apiFetch: refresh once, then send the user to /login.
   *
   * Going through the shared refreshTokens() rather than refreshing inline is
   * what keeps an export that races the dashboard's 30-second polling from
   * firing a second refresh — which the server's reuse detection reads as a
   * stolen token and answers by killing the whole family.
   */
  if (res.status === 401 && retry) {
    if (await refreshTokens()) return downloadAuthed(path, filename, false);
    if (typeof window !== 'undefined') window.location.href = '/login';
    throw new ApiError(401, 'UNAUTHORIZED', 'Oturum süresi doldu.');
  }

  if (!res.ok) {
    const body = await res.json().catch(() => null);
    const error = (body?.error ?? {}) as { code?: string; message?: string };
    throw new ApiError(res.status, error.code ?? 'ERROR', error.message ?? res.statusText);
  }

  // blob.size, not Content-Length: the export is streamed chunked and the API
  // compresses globally, so the header is either absent or the wrong number.
  const blob = await res.blob();
  const safe = safeFilename(filename);
  saveBlob(blob, safe);
  return { bytes: blob.size, filename: safe };
}

/* -------------------------------------------------------------------------- */

function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  // Firefox ignores a click on a node that is not in the document.
  document.body.append(a);
  a.click();
  a.remove();
  // Revoking in the same tick cancels the save in Safari; one turn of the event
  // loop is enough for the click to have been consumed.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * The server does send a Content-Disposition filename, and the browser will not
 * let us read it: the API is on another origin and only X-KH-Server-Time is in
 * Access-Control-Expose-Headers. So the caller names the file — and because the
 * caller builds that name out of session data, it gets scrubbed. A separator or
 * a quote inside a `download` attribute is how a filename leaves its folder.
 *
 * An allow-list, not a deny-list: a deny-list has to be right about every
 * filesystem and every separator, this only has to be right about what a
 * filename may contain.
 */
function safeFilename(name: string): string {
  return name.replace(/[^\p{L}\p{N}._-]+/gu, '-').slice(0, 120) || 'export';
}

'use client';

import { clientDictionary } from '@/lib/i18n';

/**
 * A ring buffer of failed requests, kept in the browser.
 *
 * WHY THIS EXISTS: a dispatcher reported "Oturum oluşturulamadı" with nothing
 * underneath it and no way to find out more. The page was passing the error's
 * message through correctly — the message itself was the empty string, and
 * there was no record anywhere of what had actually happened. The server logs
 * nothing for a request that never reached it, so between a proxy 502 during a
 * deploy, a dropped connection and a real validation failure, the screen looked
 * identical and the evidence was gone the moment the page re-rendered.
 *
 * Client-side on purpose. The failures worth capturing are exactly the ones the
 * server never sees.
 *
 * Never records request bodies or tokens: this ends up pasted into a chat
 * window, and a shipment's contents or an Authorization header must not travel
 * with it.
 */

const KEY = 'kh.diag';
const MAX = 50;

export interface DiagEntry {
  at: string;
  method: string;
  path: string;
  /** 0 when the request never got a response — offline, DNS, CORS, aborted. */
  status: number;
  code: string;
  message: string;
  /** The API stamps every response with one; it ties this to a server log line. */
  requestId?: string;
}

type Listener = () => void;
const listeners = new Set<Listener>();

function read(): DiagEntry[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as DiagEntry[]) : [];
  } catch {
    // A corrupt buffer must never break the app it exists to diagnose.
    return [];
  }
}

export function recordFailure(entry: DiagEntry): void {
  if (typeof window === 'undefined') return;
  try {
    const next = [entry, ...read()].slice(0, MAX);
    localStorage.setItem(KEY, JSON.stringify(next));
    listeners.forEach((l) => l());
  } catch {
    /* quota, private mode — diagnostics are never worth an exception */
  }
}

export function readFailures(): DiagEntry[] {
  return read();
}

export function clearFailures(): void {
  try {
    localStorage.removeItem(KEY);
    listeners.forEach((l) => l());
  } catch {
    /* ignore */
  }
}

export function subscribeFailures(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Plain text, ready to paste into WhatsApp or an e-mail to whoever fixes it. */
export function formatFailures(entries: DiagEntry[]): string {
  const t = clientDictionary();
  if (!entries.length) return t.http.noEntries;
  const head = [
    t.http.reportHeading,
    `${t.http.reportGenerated}: ${new Date().toISOString()}`,
    `${t.http.reportBrowser}: ${typeof navigator === 'undefined' ? '-' : navigator.userAgent}`,
    '',
  ];
  const rows = entries.map(
    (e) =>
      `${e.at}  ${e.method} ${e.path}\n` +
      `    HTTP ${e.status || t.http.noConnection}  ${e.code}\n` +
      `    ${e.message}` +
      (e.requestId ? `\n    requestId: ${e.requestId}` : ''),
  );
  return [...head, ...rows].join('\n');
}

/**
 * A message that is never empty, in the user's language.
 *
 * The old chain was `error.message ?? res.statusText`, and both halves can be
 * blank: `??` passes an empty string straight through, and `res.statusText` is
 * ALWAYS empty over HTTP/2 because RFC 9113 removed the reason phrase — which
 * is what the browser negotiates against this API. A 502 from the proxy during
 * a deploy therefore rendered as a red box with a title and nothing else.
 */
export function describeHttp(status: number, serverMessage?: string): string {
  const trimmed = serverMessage?.trim();
  if (trimmed) return trimmed;

  /*
   * clientDictionary rather than a hook: this is called from the API client and
   * from error boundaries, and neither of those is a component.
   */
  const t = clientDictionary();
  if (status === 0) return t.http.unreachable;
  if (status === 400) return t.http.badRequest;
  if (status === 401) return t.http.unauthorised;
  if (status === 403) return t.http.forbidden;
  if (status === 404) return t.http.notFound;
  if (status === 409) return t.http.conflict;
  if (status === 429) return t.http.rateLimited;
  if (status === 502 || status === 503 || status === 504) {
    // The most likely one in practice, and the least obvious to a dispatcher:
    // a deploy takes the API down for a few seconds and the proxy answers with
    // HTML that json() cannot parse.
    return t.http.unavailable;
  }
  if (status >= 500) return t.http.serverError(String(status));
  return t.http.unexpected(String(status));
}

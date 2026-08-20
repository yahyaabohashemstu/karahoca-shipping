'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useToast } from './ui/Toast';
import { Button } from './ui/Button';
import { useFormat, useT } from '@/lib/i18n';

/*
 * The consignee links on a session, and the ability to get one back.
 *
 * The link used to be shown exactly once, on the screen that appears
 * immediately after a session is created. Navigate away and it was gone — the
 * server stored only sha256(token) — so a dispatcher who closed the tab, or
 * who wanted to re-send the link a week later, had no way back to it. Their
 * only option was minting a second link, which leaves the agent holding two
 * URLs and the dispatcher unsure which one they actually sent.
 *
 * Migration 0010 stores the token encrypted alongside the hash, so this panel
 * can show it again. It lives on the session detail page because that is where
 * a dispatcher goes when a customer rings.
 */

interface ShareLink {
  id: string;
  label: string | null;
  url: string | null;
  showRoute: boolean;
  showDriver: boolean;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  lastViewedAt: string | null;
  viewCount: number;
  active: boolean;
}

export function ShareLinks({ sessionId, orderNumber, customerName }: {
  sessionId: string;
  orderNumber?: string | null;
  customerName?: string | null;
}) {
  const t = useT();
  const fmt = useFormat();
  const toast = useToast();
  const qc = useQueryClient();

  const links = useQuery({
    queryKey: ['share-links', sessionId],
    queryFn: () => api.listShareLinks(sessionId),
  });

  const mint = useMutation({
    mutationFn: () => api.createShareLink(sessionId, {}),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['share-links', sessionId] });
      toast.success(t.share.created, t.share.createdBody);
    },
    onError: (e: Error) => toast.error(t.share.createFailed, e.message),
  });

  const revoke = useMutation({
    mutationFn: (id: string) => api.revokeShareLink(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['share-links', sessionId] });
      toast.success(t.share.revoked, t.share.revokedBody);
    },
    onError: (e: Error) => toast.error(t.share.revokeFailed, e.message),
  });

  const rows = (links.data ?? []) as ShareLink[];
  const live = rows.filter((r) => r.active);
  const dead = rows.filter((r) => !r.active);

  const send = (url: string) => {
    const text = t.share.whatsappText(customerName ?? '', orderNumber ?? '', url);
    window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank', 'noreferrer');
  };

  return (
    <section className="m-3 rounded-xl border border-line bg-surface-2 p-3.5">
      <div className="flex items-start justify-between gap-2">
        <p className="text-2xs font-semibold uppercase tracking-[0.16em] text-ink-3">
          {t.share.heading}
        </p>
        <Button size="sm" variant="ghost" loading={mint.isPending} onClick={() => mint.mutate()}>
          {t.share.create}
        </Button>
      </div>

      {links.isLoading && <p className="mt-2 text-sm text-ink-3">{t.common.loading}</p>}

      {!links.isLoading && rows.length === 0 && (
        <p className="mt-2 text-sm text-ink-3">
          {t.share.none}
        </p>
      )}

      {live.map((l) => (
        <div key={l.id} className="mt-3 rounded-lg border border-line bg-surface p-2.5">
          {l.url ? (
            <p className="select-all break-all font-mono text-2xs text-ink-2">{l.url}</p>
          ) : (
            /* Minted before 0010, or the key rotated. Nothing can recover it. */
            <p className="text-2xs text-ink-3">
              {t.share.unrecoverable}
            </p>
          )}

          <p className="mt-1.5 text-2xs text-ink-3">
            {l.viewCount > 0
              ? t.share.viewed(String(l.viewCount), fmt.dateTime(l.lastViewedAt))
              : /* The useful negative: the agent has not looked, so they are
                   about to telephone. */
                t.share.notOpened}
            {' · '}
            {t.share.validUntil(fmt.date(l.expiresAt))}
          </p>

          <div className="mt-2 flex flex-wrap gap-1.5">
            {l.url && (
              <>
                <Button size="sm" variant="primary" onClick={() => send(l.url!)}>
                  {t.share.whatsapp}
                </Button>
                <Button
                  size="sm"
                  onClick={() => {
                    navigator.clipboard
                      ?.writeText(l.url!)
                      .then(() => toast.success(t.share.copied))
                      .catch(() => toast.error(t.share.copyFailed, t.share.copyFailedBody));
                  }}
                >
                  {t.share.copy}
                </Button>
                <a href={l.url} target="_blank" rel="noreferrer">
                  <Button size="sm" variant="ghost">{t.share.preview}</Button>
                </a>
              </>
            )}
            <Button
              size="sm"
              variant="ghost"
              className="text-danger hover:bg-danger-bg"
              loading={revoke.isPending}
              onClick={() => revoke.mutate(l.id)}
            >
              {t.share.revoke}
            </Button>
          </div>
        </div>
      ))}

      {dead.length > 0 && (
        <p className="mt-2.5 text-2xs text-ink-3">
          {t.share.closed(String(dead.length))}
        </p>
      )}
    </section>
  );
}

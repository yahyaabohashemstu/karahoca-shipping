'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useToast } from './ui/Toast';
import { Button } from './ui/Button';

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
      toast.success('Takip bağlantısı oluşturuldu', 'Alıcıya gönderebilirsiniz.');
    },
    onError: (e: Error) => toast.error('Bağlantı oluşturulamadı', e.message),
  });

  const revoke = useMutation({
    mutationFn: (id: string) => api.revokeShareLink(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['share-links', sessionId] });
      toast.success('Bağlantı iptal edildi', 'Bu bağlantı artık açılmıyor.');
    },
    onError: (e: Error) => toast.error('İptal edilemedi', e.message),
  });

  const rows = (links.data ?? []) as ShareLink[];
  const live = rows.filter((r) => r.active);
  const dead = rows.filter((r) => !r.active);

  const send = (url: string) => {
    const text = `${customerName ?? ''} — ${orderNumber ?? ''} sevkiyatınızı buradan canlı takip edebilirsiniz:\n${url}`;
    window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank', 'noreferrer');
  };

  return (
    <section className="m-3 rounded-md border border-line bg-surface-2 p-3.5">
      <div className="flex items-start justify-between gap-2">
        <p className="text-2xs font-semibold uppercase tracking-[0.16em] text-ink-3">
          Alıcı takip bağlantısı
        </p>
        <Button size="sm" variant="ghost" loading={mint.isPending} onClick={() => mint.mutate()}>
          Yeni bağlantı
        </Button>
      </div>

      {links.isLoading && <p className="mt-2 text-sm text-ink-3">Yükleniyor…</p>}

      {!links.isLoading && rows.length === 0 && (
        <p className="mt-2 text-sm text-ink-3">
          Bu sevkiyat için henüz bağlantı yok.
        </p>
      )}

      {live.map((l) => (
        <div key={l.id} className="mt-3 rounded border border-line bg-surface p-2.5">
          {l.url ? (
            <p className="select-all break-all font-mono text-2xs text-ink-2">{l.url}</p>
          ) : (
            /* Minted before 0010, or the key rotated. Nothing can recover it. */
            <p className="text-2xs text-ink-3">
              Bu bağlantının adresi geri getirilemiyor. Yeni bir bağlantı oluşturun.
            </p>
          )}

          <p className="mt-1.5 text-2xs text-ink-3">
            {l.viewCount > 0
              ? `${l.viewCount} kez görüntülendi · son ${new Date(l.lastViewedAt!).toLocaleString('tr-TR')}`
              : /* The useful negative: the agent has not looked, so they are
                   about to telephone. */
                'Alıcı henüz açmadı'}
            {' · '}
            {new Date(l.expiresAt).toLocaleDateString('tr-TR')} tarihine kadar geçerli
          </p>

          <div className="mt-2 flex flex-wrap gap-1.5">
            {l.url && (
              <>
                <Button size="sm" variant="primary" onClick={() => send(l.url!)}>
                  WhatsApp
                </Button>
                <Button
                  size="sm"
                  onClick={() => {
                    navigator.clipboard
                      ?.writeText(l.url!)
                      .then(() => toast.success('Kopyalandı'))
                      .catch(() => toast.error('Kopyalanamadı', 'Adresi elle seçip kopyalayın.'));
                  }}
                >
                  Kopyala
                </Button>
                <a href={l.url} target="_blank" rel="noreferrer">
                  <Button size="sm" variant="ghost">Önizle</Button>
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
              İptal et
            </Button>
          </div>
        </div>
      ))}

      {dead.length > 0 && (
        <p className="mt-2.5 text-2xs text-ink-3">
          {dead.length} kapalı bağlantı (iptal edilmiş veya süresi dolmuş)
        </p>
      )}
    </section>
  );
}

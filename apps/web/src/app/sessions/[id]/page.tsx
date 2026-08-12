'use client';

import { use, useEffect, useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, API_BASE } from '@/lib/api';
import { useSessionStream } from '@/lib/useRealtime';
import { freshness, useNow } from '@/lib/signal';
import { AppShell, useRequireAuth } from '@/components/AppShell';
import {
  Badge,
  Button,
  ButtonLink,
  ConfirmDialog,
  ConnectionPill,
  ErrorState,
  Row,
  SignalBadge,
  Skeleton,
  StatusBadge,
  useToast,
} from '@/components/ui';

// MapLibre is ~215 kB. Loading it on demand keeps this route's first-load JS in
// line with every other screen instead of nearly tripling it.
const SessionMap = dynamic(() => import('@/components/SessionMap'), {
  ssr: false,
  loading: () => (
    <div className="grid h-full place-items-center bg-surface-2 text-sm text-ink-3">
      Harita yükleniyor…
    </div>
  ),
});

type Action = 'pause' | 'resume' | 'complete' | 'cancel';

const ACTION_COPY: Record<Action, { title: string; verb: string; tone: 'primary' | 'danger' | 'success' }> = {
  pause: { title: 'Takibi duraklat', verb: 'Duraklat', tone: 'primary' },
  resume: { title: 'Takibi sürdür', verb: 'Devam et', tone: 'primary' },
  complete: { title: 'Sevkiyatı teslim edildi olarak kapat', verb: 'Teslim edildi', tone: 'success' },
  cancel: { title: 'Sevkiyatı iptal et', verb: 'İptal et', tone: 'danger' },
};

/**
 * Session detail: live position, full route, coverage gaps, and the audit trail.
 *
 * The gap list is the page's most useful feature in practice. When a carrier
 * says "the app stopped working", this shows exactly when telemetry stopped,
 * where the truck was, and how far it moved while dark — which converts an
 * argument into a fact.
 */
export default function SessionDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const authed = useRequireAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const now = useNow();

  const [confirming, setConfirming] = useState<Action | null>(null);

  const { live, backfills, events, status, connected, needsRefetch } = useSessionStream(
    authed ? id : null,
  );

  const sessionQ = useQuery({
    queryKey: ['session', id],
    queryFn: () => api.session(id),
    enabled: authed,
    refetchInterval: 30_000,
  });
  const session = sessionQ.data;
  const loading = sessionQ.isLoading;

  const routeQ = useQuery({
    queryKey: ['route', id, needsRefetch],
    queryFn: () => api.route(id, { toleranceM: 8 }),
    enabled: authed,
  });

  const gapsQ = useQuery({
    queryKey: ['gaps', id],
    queryFn: () => api.gaps(id, 120),
    enabled: authed,
  });

  // A server-side state change (completed, expired) invalidates the detail read.
  useEffect(() => {
    if (status) qc.invalidateQueries({ queryKey: ['session', id] });
  }, [status, id, qc]);

  /*
   * Every mutation goes through useMutation, so there is a pending state, an
   * error, and a disabled button.
   *
   * Before this, `act()` was a bare async function whose rejection went
   * nowhere: a 409 on an already-completed session, or an offline laptop,
   * rendered exactly like success. The dispatcher believed the shipment was
   * closed and moved on.
   */
  const action = useMutation({
    mutationFn: (a: Action) => api.sessionAction(id, a),
    onSuccess: (_res, a) => {
      setConfirming(null);
      qc.invalidateQueries({ queryKey: ['session', id] });
      qc.invalidateQueries({ queryKey: ['live-fleet'] });
      toast.success(`${ACTION_COPY[a].verb} uygulandı`, session?.reference);
    },
    onError: (e) => toast.error('İşlem başarısız', (e as Error).message),
  });

  const regenerate = useMutation({
    mutationFn: () => api.regenerateCode(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['session', id] });
      toast.success('Yeni kod üretildi', 'Önceki cihazın bağlantısı kesildi.');
    },
    onError: (e) => toast.error('Kod üretilemedi', (e as Error).message),
  });

  const signal = useMemo(
    () =>
      session
        ? freshness(
            live
              ? { recordedAt: live.recordedAt, secondsSinceFix: null, signalState: session.signalState }
              : session,
            now,
          )
        : null,
    [session, live, now],
  );

  const timeline = useMemo(
    () =>
      [
        ...events,
        ...(session?.events ?? []).map((e) => ({ type: e.type, message: e.message, at: e.occurred_at })),
      ].slice(0, 40),
    [events, session?.events],
  );

  const currentStatus = status ?? session?.status ?? null;
  const closed = currentStatus === 'COMPLETED' || currentStatus === 'CANCELLED' || currentStatus === 'EXPIRED';

  if (!authed) return null;

  return (
    <AppShell fill>
      {/* --------------------------------------------------------- toolbar -- */}
      <div className="flex flex-wrap items-center gap-2 border-b border-line bg-surface px-4 py-2">
        <Link href="/" className="text-sm text-brand-text hover:underline">
          ← Canlı harita
        </Link>
        <span className="kh-num ml-2 font-semibold tracking-tight">
          {loading ? <Skeleton className="inline-block h-3.5 w-24 align-middle" /> : session?.reference ?? id.slice(0, 8)}
        </span>
        <StatusBadge status={currentStatus} />
        {signal && currentStatus === 'ACTIVE' && <SignalBadge state={signal.state} />}
        <ConnectionPill connected={connected} />

        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          <Button
            size="sm"
            onClick={() => setConfirming('pause')}
            disabled={closed || currentStatus === 'PAUSED' || action.isPending}
          >
            Duraklat
          </Button>
          <Button
            size="sm"
            onClick={() => setConfirming('resume')}
            disabled={closed || currentStatus !== 'PAUSED' || action.isPending}
          >
            Devam
          </Button>
          <Button
            size="sm"
            variant="success"
            onClick={() => setConfirming('complete')}
            disabled={closed || action.isPending}
          >
            Teslim edildi
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setConfirming('cancel')}
            disabled={closed || action.isPending}
            className="text-danger hover:bg-danger-bg"
          >
            İptal
          </Button>
          <ButtonLink
            size="sm"
            href={`${API_BASE}/tracking/sessions/${id}/export.ndjson`}
            download
          >
            Ham veri
          </ButtonLink>
        </div>
      </div>

      {sessionQ.isError && (
        <ErrorState
          className="m-4"
          title="Oturum bilgileri alınamadı"
          message={(sessionQ.error as Error)?.message}
          onRetry={() => sessionQ.refetch()}
          retrying={sessionQ.isFetching}
        />
      )}

      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1">
          <SessionMap
            route={routeQ.data}
            backfills={backfills}
            live={live}
            fallbackLat={session?.lat}
            fallbackLon={session?.lon}
          />
        </div>

        {/* ------------------------------------------------------ sidebar -- */}
        <aside className="kh-scroll w-[23rem] shrink-0 overflow-y-auto border-l border-line bg-surface">
          {session?.handoff && (
            <section className="m-3 rounded-md border-2 border-dashed border-brand/40 bg-brand-soft/60 p-3.5 text-center">
              <p className="text-2xs font-semibold uppercase tracking-[0.16em] text-brand-text">
                Sürücüye verilecek kod
              </p>
              <p className="my-2 select-all font-mono text-[1.9rem] font-bold leading-none tracking-[0.16em]">
                {session.handoff.prettyCode}
              </p>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={session.handoff.qrDataUrl}
                alt="Oturum QR kodu"
                className="mx-auto h-36 w-36 rounded bg-white p-1"
              />
              <Button
                size="sm"
                variant="ghost"
                className="mt-2"
                loading={regenerate.isPending}
                onClick={() => regenerate.mutate()}
              >
                Yeni kod üret (mevcut cihazı iptal eder)
              </Button>
            </section>
          )}

          <Section title="Sevkiyat">
            <Row label="Sipariş" value={session?.orderNumber ?? '—'} loading={loading} mono />
            <Row label="Müşteri" value={session?.customerName ?? '—'} loading={loading} />
            <Row label="Nakliyeci" value={session?.carrierName ?? '—'} loading={loading} />
            <Row label="Araç" value={session?.vehiclePlate ?? '—'} loading={loading} mono />
            <Row label="Sürücü" value={session?.driverName ?? '—'} loading={loading} />
            <Row
              label="Telefon"
              loading={loading}
              value={
                session?.driverPhone ? (
                  <a href={`tel:${session.driverPhone}`} className="kh-num text-brand-text hover:underline">
                    {session.driverPhone}
                  </a>
                ) : (
                  '—'
                )
              }
            />
          </Section>

          <Section title="Telemetri">
            <Row label="Toplam nokta" value={fmt(session?.pointsTotal)} loading={loading} mono />
            <Row label="Mesafe" value={`${session?.distanceKm ?? 0} km`} loading={loading} mono />
            <Row label="Çevrimdışı senkron" value={fmt(session?.offlineBatches)} loading={loading} mono />
            <Row label="Reddedilen nokta" value={fmt(session?.pointsRejected)} loading={loading} mono />
            <Row
              label="Rota noktası"
              loading={routeQ.isLoading}
              mono
              value={
                routeQ.data
                  ? `${routeQ.data.renderedPointCount} / ${routeQ.data.pointCount}`
                  : '—'
              }
            />
            {(session?.mockLocationCount ?? 0) > 0 && (
              <div className="mt-2 flex items-center justify-between gap-2 rounded bg-danger-bg px-2 py-1.5 ring-1 ring-inset ring-danger-ring">
                <span className="text-sm font-medium text-danger">Sahte konum tespit edildi</span>
                <span className="kh-num text-sm font-semibold text-danger">
                  {session?.mockLocationCount}
                </span>
              </div>
            )}
          </Section>

          {session?.device && (
            <Section title="Cihaz">
              <Row
                label="Model"
                value={
                  `${session.device.manufacturer ?? ''} ${session.device.model ?? ''}`.trim() || '—'
                }
              />
              <Row label="Android" value={String(session.device.os_version ?? '—')} mono />
              <DeviceFlag
                label="Pil optimizasyonu"
                ok={Boolean(session.device.battery_optimisation_ignored)}
                okText="Muaf"
                badText="Açık — takip durabilir"
              />
              <DeviceFlag
                label="Arka plan konumu"
                ok={Boolean(session.device.has_background_location)}
                okText="İzin var"
                badText="İzin yok — takip durabilir"
              />
            </Section>
          )}

          {gapsQ.data && gapsQ.data.length > 0 && (
            <Section title={`Kapsama boşlukları (${gapsQ.data.length})`}>
              <div className="space-y-1.5">
                {gapsQ.data.slice(0, 10).map((gap) => (
                  <div
                    key={gap.from}
                    className="rounded bg-warn-bg px-2 py-1.5 text-sm ring-1 ring-inset ring-delayed-ring/35"
                  >
                    <div className="kh-num font-medium text-warn">
                      {Math.round(gap.durationSec / 60)} dakika sinyalsiz
                    </div>
                    <div className="kh-num mt-0.5 text-sm text-ink-2">
                      {new Date(gap.from).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })}
                      {' → '}
                      {new Date(gap.to).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })}
                      {' · '}
                      {Math.round(gap.straightLineM / 1000)} km yol
                    </div>
                  </div>
                ))}
                {gapsQ.data.length > 10 && (
                  <p className="text-sm text-ink-3">+{gapsQ.data.length - 10} boşluk daha</p>
                )}
              </div>
            </Section>
          )}

          <Section title="Olay geçmişi">
            {timeline.length === 0 ? (
              <p className="text-sm text-ink-3">Henüz olay yok.</p>
            ) : (
              <ol className="space-y-1.5">
                {timeline.map((event, i) => (
                  <li key={`${event.at}-${i}`} className="flex gap-2 text-sm">
                    <span className="kh-num shrink-0 text-ink-3">
                      {new Date(event.at).toLocaleTimeString('tr-TR', {
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </span>
                    <span className="min-w-0">
                      <Badge tone="neutral">{event.type}</Badge>
                      {event.message && <div className="mt-0.5 text-ink-2">{event.message}</div>}
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </Section>
        </aside>
      </div>

      {/* Naming the plate and the order number is the safeguard. "Emin misiniz?"
          is not. */}
      <ConfirmDialog
        open={confirming !== null}
        onCancel={() => setConfirming(null)}
        onConfirm={() => confirming && action.mutate(confirming)}
        title={confirming ? ACTION_COPY[confirming].title : ''}
        confirmLabel={confirming ? ACTION_COPY[confirming].verb : ''}
        tone={confirming ? ACTION_COPY[confirming].tone : 'primary'}
        loading={action.isPending}
        error={action.isError ? (action.error as Error).message : null}
        detail={
          <div className="space-y-1">
            <p>
              <span className="kh-num font-medium text-ink">{session?.vehiclePlate ?? session?.reference}</span>
              {' — '}
              <span className="kh-num">{session?.orderNumber}</span>
              {session?.customerName ? ` · ${session.customerName}` : ''}
            </p>
            {(confirming === 'complete' || confirming === 'cancel') && (
              <p className="text-danger">
                Bu işlem geri alınamaz. Oturum kapanır ve sürücünün cihazı konum göndermeyi durdurur.
              </p>
            )}
            {confirming === 'resume' && currentStatus !== 'PAUSED' && (
              <p className="text-warn">Bu oturum duraklatılmış değil.</p>
            )}
          </div>
        }
      />
    </AppShell>
  );
}

/* -------------------------------------------------------------------------- */

function empty(): GeoJSON.FeatureCollection {
  return { type: 'FeatureCollection', features: [] };
}

function fmt(n: number | null | undefined): string {
  return n === null || n === undefined ? '—' : n.toLocaleString('tr-TR');
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-b border-line px-3.5 py-3 last:border-b-0">
      <h2 className="mb-1.5 text-2xs font-semibold uppercase tracking-wider text-ink-3">{title}</h2>
      {children}
    </section>
  );
}

/**
 * A device permission is either fine or it is a live risk to the shipment. The
 * old version wrote "Muaf ✓" and "AÇIK ⚠" into a value string, which meant the
 * severity was carried by an emoji at the end of a sentence.
 */
function DeviceFlag({
  label,
  ok,
  okText,
  badText,
}: {
  label: string;
  ok: boolean;
  okText: string;
  badText: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1">
      <span className="shrink-0 text-sm text-ink-2">{label}</span>
      <Badge tone={ok ? 'success' : 'danger'}>{ok ? okText : badText}</Badge>
    </div>
  );
}

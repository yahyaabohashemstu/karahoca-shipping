'use client';

import { use, useEffect, useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type SessionDetail } from '@/lib/api';
import { downloadAuthed } from '@/lib/download';
import { useSessionStream } from '@/lib/useRealtime';
import { displayState, useNow } from '@/lib/signal';
import { ShareLinks } from '@/components/ShareLinks';
import { AppShell, useRequireAuth } from '@/components/AppShell';
import {
  Badge,
  Button,
  ConfirmDialog,
  ConnectionPill,
  ErrorState,
  Row,
  SignalBadge,
  Skeleton,
  StatusBadge,
  useToast,
} from '@/components/ui';
import { useFormat, useI18n, useT, type Dictionary } from '@/lib/i18n';
import { formatNumber } from '@/lib/format';
import type { Locale } from '@/lib/i18n/locale';

// MapLibre is ~215 kB. Loading it on demand keeps this route's first-load JS in
// line with every other screen instead of nearly tripling it.
const SessionMap = dynamic(() => import('@/components/SessionMap'), {
  ssr: false,
  loading: MapLoading,
});

type Action = 'pause' | 'resume' | 'complete' | 'cancel';

/*
 * Tone here, wording in the dictionary. A module-level table is evaluated once
 * at import, so any Turkish written here would outlive every language choice.
 */
const ACTION_TONE: Record<Action, 'primary' | 'danger' | 'success'> = {
  pause: 'primary',
  resume: 'primary',
  complete: 'success',
  cancel: 'danger',
};

function actionCopy(t: Dictionary, action: Action): { title: string; verb: string } {
  const a = t.sessionDetail.actions;
  switch (action) {
    case 'pause':
      return { title: a.pauseTitle, verb: a.pauseVerb };
    case 'resume':
      return { title: a.resumeTitle, verb: a.resumeVerb };
    case 'complete':
      return { title: a.completeTitle, verb: a.completeVerb };
    case 'cancel':
      return { title: a.cancelTitle, verb: a.cancelVerb };
  }
}

/**
 * Session detail: live position, full route, coverage gaps, and the audit trail.
 *
 * The gap list is the page's most useful feature in practice. When a carrier
 * says "the app stopped working", this shows exactly when telemetry stopped,
 * where the truck was, and how far it moved while dark — which converts an
 * argument into a fact.
 */
export default function SessionDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const t = useT();
  const { locale } = useI18n();
  const f = useFormat();
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
      toast.success(t.sessionDetail.actionApplied(actionCopy(t, a).verb), session?.reference);
    },
    onError: (e) => toast.error(t.sessionDetail.actionFailed, (e as Error).message),
  });

  /*
   * The raw export was a bare `<a href download>` pointing straight at the API.
   *
   * An anchor carries no Authorization header and the guard chain is
   * fail-closed, so every click since this page shipped fetched a 401 — and
   * because a failed navigation-download reports nothing, the button looked
   * merely unresponsive rather than broken. Fetching the body ourselves is the
   * only way to attach the token; routing it through useMutation is what gives
   * the failure somewhere to surface.
   */
  const exportRaw = useMutation({
    mutationFn: () =>
      downloadAuthed(`/tracking/sessions/${id}/export.ndjson`, exportFilename(session, id)),
    onSuccess: ({ bytes, filename }) =>
      // An empty file is the worst outcome available here: handed to a lawyer
      // it reads as proof that the shipment was never tracked, when it in fact
      // means this session never received a single point. Say which it is.
      bytes === 0
        ? toast.error(t.sessionDetail.rawEmpty, t.sessionDetail.rawEmptyBody)
        : toast.success(t.sessionDetail.rawDownloaded, `${filename} · ${formatBytes(bytes, locale)}`),
    onError: (e) => toast.error(t.sessionDetail.rawFailed, (e as Error).message),
  });

  const regenerate = useMutation({
    mutationFn: () => api.regenerateCode(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['session', id] });
      toast.success(t.sessionDetail.codeRegenerated, t.sessionDetail.codeRegeneratedBody);
    },
    onError: (e) => toast.error(t.sessionDetail.regenerateFailed, (e as Error).message),
  });

  const signal = useMemo(
    () =>
      session
        ? displayState(
            live
              ? {
                  status: session.status,
                  recordedAt: live.recordedAt,
                  secondsSinceFix: null,
                  signalState: session.signalState,
                }
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
          {t.sessionDetail.back}
        </Link>
        <span className="kh-num ms-2 font-semibold tracking-tight">
          {loading ? <Skeleton className="inline-block h-3.5 w-24 align-middle" /> : session?.reference ?? id.slice(0, 8)}
        </span>
        <StatusBadge status={currentStatus} />
        {signal && (currentStatus === 'ACTIVE' || currentStatus === 'PAUSED') && (
          <SignalBadge state={signal.state} />
        )}
        <ConnectionPill connected={connected} />

        <div className="ms-auto flex flex-wrap items-center gap-1.5">
          <Button
            size="sm"
            onClick={() => setConfirming('pause')}
            disabled={closed || currentStatus === 'PAUSED' || action.isPending}
          >
            {t.sessionDetail.actions.pauseVerb}
          </Button>
          <Button
            size="sm"
            onClick={() => setConfirming('resume')}
            disabled={closed || currentStatus !== 'PAUSED' || action.isPending}
          >
            {t.sessionDetail.actions.resumeVerb}
          </Button>
          <Button
            size="sm"
            variant="success"
            onClick={() => setConfirming('complete')}
            disabled={closed || action.isPending}
          >
            {t.sessionDetail.actions.completeVerb}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setConfirming('cancel')}
            disabled={closed || action.isPending}
            className="text-danger hover:bg-danger-bg"
          >
            {t.sessionDetail.actions.cancelVerb}
          </Button>
          <Button size="sm" loading={exportRaw.isPending} onClick={() => exportRaw.mutate()}>
            {t.sessionDetail.rawData}
          </Button>
        </div>
      </div>

      {sessionQ.isError && (
        <ErrorState
          className="m-4"
          title={t.sessionDetail.loadFailed}
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
        <aside className="kh-scroll w-[23rem] shrink-0 overflow-y-auto border-s border-line bg-surface">
          {session?.handoff && (
            <section className="m-3 rounded-md border-2 border-dashed border-brand/40 bg-brand-soft/60 p-3.5 text-center">
              <p className="text-2xs font-semibold uppercase tracking-[0.16em] text-brand-text">
                {t.sessionDetail.codeForDriver}
              </p>
              <p className="my-2 select-all font-mono text-[1.9rem] font-bold leading-none tracking-[0.16em]">
                {session.handoff.prettyCode}
              </p>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={session.handoff.qrDataUrl}
                alt={t.sessionDetail.qrAlt}
                className="mx-auto h-36 w-36 rounded bg-white p-1"
              />
              <Button
                size="sm"
                variant="ghost"
                className="mt-2"
                loading={regenerate.isPending}
                onClick={() => regenerate.mutate()}
              >
                {t.sessionDetail.regenerate}
              </Button>
            </section>
          )}

          {/*
            The claim code is NULLed the moment a driver claims the session, so
            the block above disappears and there is nothing here to show. That
            is correct — the code is spent and reprinting it would be a lie —
            but leaving the space blank reads like the panel broke. Say what
            happened, and offer the one action that still makes sense.
          */}
          {session && !session.handoff && (
            <section className="m-3 rounded-md border border-line bg-surface-2 p-3.5 text-center">
              <p className="text-2xs font-semibold uppercase tracking-[0.16em] text-ink-3">
                {t.sessionDetail.driverCode}
              </p>
              <p className="mt-1.5 text-sm text-ink-2">
                {t.sessionDetail.codeUsed}
              </p>
              <Button
                size="sm"
                variant="ghost"
                className="mt-2"
                loading={regenerate.isPending}
                onClick={() => regenerate.mutate()}
              >
                {t.sessionDetail.regenerate}
              </Button>
            </section>
          )}

          {/*
            The consignee's link, on the page a dispatcher opens when the
            customer rings — not only on the screen that flashes past once
            after the session is created.
          */}
          {session && (
            <ShareLinks
              sessionId={id}
              orderNumber={session.orderNumber}
              customerName={session.customerName}
            />
          )}

          <Section title={t.sessionDetail.sectionShipment}>
            <Row label={t.sessionDetail.order} value={session?.orderNumber ?? '—'} loading={loading} mono />
            <Row label={t.sessionDetail.customer} value={session?.customerName ?? '—'} loading={loading} />
            <Row label={t.sessionDetail.carrier} value={session?.carrierName ?? '—'} loading={loading} />
            <Row label={t.sessionDetail.vehicle} value={session?.vehiclePlate ?? '—'} loading={loading} mono />
            <Row label={t.sessionDetail.driver} value={session?.driverName ?? '—'} loading={loading} />
            <Row
              label={t.sessionDetail.phone}
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

          <Section title={t.sessionDetail.sectionTelemetry}>
            <Row label={t.sessionDetail.pointsTotal} value={fmt(session?.pointsTotal)} loading={loading} mono />
            <Row label={t.sessionDetail.distance} value={`${session?.distanceKm ?? 0} km`} loading={loading} mono />
            <Row label={t.sessionDetail.offlineBatches} value={fmt(session?.offlineBatches)} loading={loading} mono />
            <Row label={t.sessionDetail.pointsRejected} value={fmt(session?.pointsRejected)} loading={loading} mono />
            <Row
              label={t.sessionDetail.routePoints}
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
                <span className="text-sm font-medium text-danger">{t.sessionDetail.mockDetected}</span>
                <span className="kh-num text-sm font-semibold text-danger">
                  {session?.mockLocationCount}
                </span>
              </div>
            )}
          </Section>

          {session?.device && (
            <Section title={t.sessionDetail.sectionDevice}>
              <Row
                label={t.sessionDetail.model}
                value={
                  `${session.device.manufacturer ?? ''} ${session.device.model ?? ''}`.trim() || '—'
                }
              />
              <Row label={t.sessionDetail.android} value={String(session.device.os_version ?? '—')} mono />
              <DeviceFlag
                label={t.sessionDetail.batteryOptimisation}
                ok={Boolean(session.device.battery_optimisation_ignored)}
                okText={t.sessionDetail.batteryOk}
                badText={t.sessionDetail.batteryBad}
              />
              <DeviceFlag
                label={t.sessionDetail.backgroundLocation}
                ok={Boolean(session.device.has_background_location)}
                okText={t.sessionDetail.backgroundOk}
                badText={t.sessionDetail.backgroundBad}
              />
            </Section>
          )}

          {gapsQ.data && gapsQ.data.length > 0 && (
            <Section title={t.sessionDetail.sectionGaps(String(gapsQ.data.length))}>
              <div className="space-y-1.5">
                {gapsQ.data.slice(0, 10).map((gap) => (
                  <div
                    key={gap.from}
                    className="rounded bg-warn-bg px-2 py-1.5 text-sm ring-1 ring-inset ring-delayed-ring/35"
                  >
                    <div className="kh-num font-medium text-warn">
                      {t.sessionDetail.gapMinutes(String(Math.round(gap.durationSec / 60)))}
                    </div>
                    <div className="kh-num mt-0.5 text-sm text-ink-2">
                      {f.time(gap.from)}
                      {' → '}
                      {f.time(gap.to)}
                      {' · '}
                      {t.sessionDetail.gapDistance(String(Math.round(gap.straightLineM / 1000)))}
                    </div>
                  </div>
                ))}
                {gapsQ.data.length > 10 && (
                  <p className="text-sm text-ink-3">{t.sessionDetail.gapsMore(String(gapsQ.data.length - 10))}</p>
                )}
              </div>
            </Section>
          )}

          <Section title={t.sessionDetail.sectionEvents}>
            {timeline.length === 0 ? (
              <p className="text-sm text-ink-3">{t.sessionDetail.noEvents}</p>
            ) : (
              <ol className="space-y-1.5">
                {timeline.map((event, i) => (
                  <li key={`${event.at}-${i}`} className="flex gap-2 text-sm">
                    <span className="kh-num shrink-0 text-ink-3">
                      {f.time(event.at)}
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
        title={confirming ? actionCopy(t, confirming).title : ''}
        confirmLabel={confirming ? actionCopy(t, confirming).verb : ''}
        tone={confirming ? ACTION_TONE[confirming] : 'primary'}
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
                {t.sessionDetail.irreversible}
              </p>
            )}
            {confirming === 'resume' && currentStatus !== 'PAUSED' && (
              <p className="text-warn">{t.sessionDetail.notPaused}</p>
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

/**
 * The browser cannot read the server's Content-Disposition — the API is on a
 * different origin and only X-KH-Server-Time is exposed — so the name is built
 * here instead. Reference, plate and the day the shipment ran, because these
 * files pile up in one folder during a dispute and the server's
 * `karahoca-session-<uuid>.ndjson` tells nobody which truck it belongs to.
 */
function exportFilename(session: SessionDetail | undefined, id: string): string {
  // The shipment's own day, not today's: the file is evidence about a date.
  const day = (session?.startedAt ? new Date(session.startedAt) : new Date())
    .toISOString()
    .slice(0, 10);
  return [session?.reference ?? id.slice(0, 8), session?.vehiclePlate, day]
    .filter(Boolean)
    .join('-')
    .concat('.ndjson');
}

function formatBytes(bytes: number, locale: Locale): string {
  if (bytes < 1024) return `${bytes} B`;
  const [value, unit] =
    bytes < 1024 * 1024 ? [bytes / 1024, 'KB'] : [bytes / (1024 * 1024), 'MB'];
  return `${formatNumber(locale, value, { maximumFractionDigits: 1 })} ${unit}`;
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

/** See the note on the live map's copy of this. */
function MapLoading() {
  const t = useT();
  return (
    <div className="grid h-full place-items-center bg-surface-2 text-sm text-ink-3">
      {t.fleet.mapLoading}
    </div>
  );
}

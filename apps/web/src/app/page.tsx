'use client';

import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, type FleetPosition } from '@/lib/api';
import { useFleetStream } from '@/lib/useRealtime';
import { displayState, isSilent, SIGNAL_RANK, useNow, type DisplayState } from '@/lib/signal';
import { AppShell, useRequireAuth } from '@/components/AppShell';
import {
  Button,
  ConnectionPill,
  EmptyState,
  ErrorState,
  IconButton,
  SearchInput,
  SignalBadge,
  SkeletonList,
  StaleBanner,
  Stat,
} from '@/components/ui';
import { useT, type Dictionary } from '@/lib/i18n';

// MapLibre touches `window` at import time — must not be server-rendered.
const FleetMap = dynamic(() => import('@/components/FleetMap'), {
  ssr: false,
  loading: MapLoading,
});

/** A row plus the freshness we recomputed for it, so nothing downstream re-derives it. */
interface Row {
  p: FleetPosition;
  state: DisplayState;
  secondsSinceFix: number | null;
  speedKmh: number;
}

export default function LiveDashboard() {
  const t = useT();
  const authed = useRequireAuth();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<'all' | 'silent'>('all');

  // One clock for the list, the badges, the counters and the map. See lib/signal.
  const now = useNow();

  const { connected, authFailed, positions: liveUpdates } = useFleetStream();

  const { data, isLoading, isError, error, isFetching, refetch } = useQuery({
    queryKey: ['live-fleet'],
    queryFn: api.liveFleet,
    enabled: authed,
  });

  const { data: stats } = useQuery({
    queryKey: ['stats'],
    queryFn: api.stats,
    enabled: authed,
    refetchInterval: 60_000,
  });

  // Single source of truth: the socket writes snapshots into this same cache
  // entry, so there is no second copy to fall out of step with.
  const fleet = useMemo(() => data?.positions ?? [], [data]);

  const rows: Row[] = useMemo(() => {
    const out = fleet.map((p) => {
      const live = liveUpdates.get(p.sessionId);
      const f = displayState(
        live
          ? {
              status: p.status,
              recordedAt: live.recordedAt,
              secondsSinceFix: null,
              signalState: p.signalState,
            }
          : p,
        now,
      );
      return {
        p,
        state: f.state,
        secondsSinceFix: f.secondsSinceFix,
        speedKmh: Math.round(((live?.speedMps ?? p.speedMps) ?? 0) * 3.6),
      };
    });
    // Trucks that need attention first — LOST, then STALE, then the rest.
    out.sort((a, b) => (SIGNAL_RANK[a.state] ?? 9) - (SIGNAL_RANK[b.state] ?? 9));
    return out;
  }, [fleet, liveUpdates, now]);

  const silentCount = useMemo(() => rows.filter((r) => isSilent(r.state)).length, [rows]);

  const visible = useMemo(() => {
    const q = search.trim().toLocaleLowerCase('tr');
    return rows.filter((r) => {
      if (filter === 'silent' && !isSilent(r.state)) return false;
      if (!q) return true;
      return [r.p.vehiclePlate, r.p.reference, r.p.orderNumber, r.p.customerName, r.p.carrierName, r.p.driverName]
        .filter(Boolean)
        .some((v) => String(v).toLocaleLowerCase('tr').includes(q));
    });
  }, [rows, search, filter]);

  const selected = rows.find((r) => r.p.sessionId === selectedId) ?? null;

  if (!authed) return null;

  return (
    <AppShell
      fill
      right={
        <div className="flex items-center gap-3">
          <Stat label={t.fleet.statActive} value={stats?.activeSessions ?? fleet.length} loading={isLoading} />
          <Stat label={t.fleet.statAwaiting} value={stats?.awaitingClaim ?? 0} />
          <Stat
            label={t.fleet.statSilent}
            value={silentCount}
            tone={silentCount > 0 ? 'warn' : 'neutral'}
            onClick={() => setFilter(filter === 'silent' ? 'all' : 'silent')}
            active={filter === 'silent'}
          />
          <ConnectionPill connected={connected} />
        </div>
      }
    >
      {/* The feed is frozen but data is still on screen — say so, do not let a
          stale map masquerade as a live one. */}
      {!connected && !isLoading && (
        <StaleBanner
          message={
            authFailed
              ? t.fleet.socketAuthLost
              : t.fleet.socketLost
          }
          onRetry={() => refetch()}
        />
      )}

      <div className="flex min-h-0 flex-1">
        {/* -------------------------------------------------- sidebar -------- */}
        <aside className="flex w-[22rem] shrink-0 flex-col border-r border-line bg-surface">
          <div className="flex items-center gap-2 border-b border-line px-3 py-2">
            <SearchInput
              value={search}
              onValueChange={setSearch}
              placeholder={t.fleet.searchPlaceholder}
              className="flex-1"
            />
            {filter === 'silent' && (
              <IconButton label={t.fleet.clearFilter} size="sm" onClick={() => setFilter('all')}>
                <svg viewBox="0 0 12 12" className="h-3 w-3" fill="none" aria-hidden>
                  <path d="m3 3 6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                </svg>
              </IconButton>
            )}
          </div>

          <div className="kh-scroll min-h-0 flex-1 overflow-y-auto">
            {/* Three distinct states. A failed request must never render as
                "no vehicles en route" — that reads as good news. */}
            {isLoading ? (
              <SkeletonList rows={7} />
            ) : isError ? (
              <ErrorState
                className="m-3"
                title={t.fleet.loadFailed}
                message={(error as Error)?.message}
                onRetry={() => refetch()}
                retrying={isFetching}
              />
            ) : visible.length === 0 ? (
              <EmptyState
                title={
                  rows.length === 0
                    ? t.fleet.emptyActive
                    : filter === 'silent'
                      ? t.fleet.emptySilent
                      : t.fleet.emptyMatch
                }
                description={
                  rows.length === 0
                    ? t.fleet.emptyBody
                    : undefined
                }
                action={
                  rows.length === 0 ? (
                    <Link href="/sessions/new">
                      <Button variant="primary" size="sm">
                        {t.fleet.openSession}
                      </Button>
                    </Link>
                  ) : (
                    <Button size="sm" onClick={() => { setSearch(''); setFilter('all'); }}>
                      {t.fleet.clearFilters}
                    </Button>
                  )
                }
              />
            ) : (
              <ul>
                {visible.map((r) => (
                  <FleetRow
                    key={r.p.sessionId}
                    row={r}
                    selected={selectedId === r.p.sessionId}
                    onSelect={() => setSelectedId(r.p.sessionId)}
                  />
                ))}
              </ul>
            )}
          </div>

          {visible.length > 0 && (
            <div className="border-t border-line px-3 py-1.5 text-2xs text-ink-3">
              <span className="kh-num">{visible.length}</span>
              {visible.length !== rows.length && <span className="kh-num"> / {rows.length}</span>} araç
            </div>
          )}
        </aside>

        {/* ------------------------------------------------------ map -------- */}
        <main className="relative min-w-0 flex-1">
          <FleetMap
            positions={fleet}
            liveUpdates={liveUpdates}
            selectedId={selectedId}
            onSelect={setSelectedId}
            now={now}
            stale={!connected && !isLoading}
          />
          {selected && (
            /*
             * bottom-12, not bottom-3: the status legend sits at bottom-3 and
             * is 25 px tall, so it tops out 37 px from the bottom edge. This
             * clears it by 11 px — the same gap as the right margin — instead
             * of covering it, which is what the panel used to do.
             *
             * The map credit is no longer part of this arithmetic; FleetMap
             * moved it to the opposite corner so that a taller panel can never
             * hide it again.
             */
            <div className="kh-enter absolute bottom-12 right-3 w-[19rem]">
              <SelectedPanel row={selected} onClose={() => setSelectedId(null)} />
            </div>
          )}
        </main>
      </div>
    </AppShell>
  );
}

/* -------------------------------------------------------------------------- */

function FleetRow({ row, selected, onSelect }: { row: Row; selected: boolean; onSelect: () => void }) {
  const t = useT();
  const { p, state, speedKmh } = row;
  const lowBattery = p.batteryPct !== null && p.batteryPct < 20;
  const paused = state === 'PAUSED';

  return (
    <li>
      <button
        onClick={onSelect}
        aria-current={selected ? 'true' : undefined}
        /*
         * A driver who stopped the app gets an orange card, not just an orange
         * badge. A badge is 60 square pixels at the right-hand edge of a row; a
         * tinted card with a coloured left edge is what a dispatcher notices
         * while scanning the column, which is the whole point of flagging it.
         *
         * Selection still wins visually — you must be able to see which row you
         * clicked — but the left edge survives, so the state is never lost.
         */
        className={`block w-full border-b border-line/70 px-3 py-2.5 text-left transition-colors ${
          paused ? 'border-l-[3px] border-l-paused-ring pl-[9px]' : ''
        } ${
          selected
            ? 'bg-brand-soft'
            : paused
              ? 'bg-paused-bg/45 hover:bg-paused-bg/70'
              : 'hover:bg-surface-2'
        }`}
      >
        <div className="flex items-center justify-between gap-2">
          <span className="kh-num truncate font-semibold tracking-tight">
            {p.vehiclePlate ?? p.reference}
          </span>
          <SignalBadge state={state} />
        </div>

        <div className="mt-0.5 truncate text-sm text-ink-2">
          <span className="kh-num">{p.orderNumber}</span>
          <span className="text-ink-3"> · </span>
          {p.customerName}
        </div>

        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-sm text-ink-3">
          <span className="kh-num">{speedKmh} km/s</span>
          {p.remainingKm !== null && <span className="kh-num">{p.remainingKm} km kaldı</span>}
          {p.batteryPct !== null && (
            <span className={`kh-num inline-flex items-center gap-1 ${lowBattery ? 'font-medium text-danger' : ''}`}>
              <BatteryIcon pct={p.batteryPct} />
              {p.batteryPct}%
            </span>
          )}
          {p.mockLocationCount > 0 && (
            <span className="inline-flex items-center gap-1 font-medium text-danger" title={t.fleet.mockTitle}>
              <WarnIcon />
              {t.fleet.mockShort}
            </span>
          )}
        </div>
      </button>
    </li>
  );
}

/* Emoji were doing icon duty (🔋 and ⚠). They render at a different size, in a
   different colour, and as a completely different picture on every platform —
   and they cannot inherit the danger colour when the battery is low. */
function BatteryIcon({ pct }: { pct: number }) {
  const fill = Math.max(0.08, Math.min(1, pct / 100));
  return (
    <svg viewBox="0 0 16 10" className="h-2.5 w-4 shrink-0" fill="none" aria-hidden>
      <rect x="0.6" y="0.6" width="12.8" height="8.8" rx="1.6" stroke="currentColor" strokeWidth="1.2" />
      <rect x="2.1" y="2.1" width={10.3 * fill} height="5.8" rx="0.6" fill="currentColor" />
      <path d="M14.6 3.6v2.8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function WarnIcon() {
  return (
    <svg viewBox="0 0 12 12" className="h-3 w-3 shrink-0" fill="none" aria-hidden>
      <path d="M6 1.4 11.2 10.6H0.8z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
      <path d="M6 4.9v2.3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      <circle cx="6" cy="8.8" r="0.6" fill="currentColor" />
    </svg>
  );
}

function SelectedPanel({ row, onClose }: { row: Row; onClose: () => void }) {
  const t = useT();
  const { p, state, secondsSinceFix } = row;
  return (
    <div className="rounded-md bg-surface p-3.5 shadow-panel ring-1 ring-line">
      <div className="mb-2.5 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="kh-num truncate text-md font-semibold tracking-tight">
            {p.vehiclePlate ?? p.reference}
          </div>
          <div className="truncate text-sm text-ink-2">{p.carrierName}</div>
        </div>
        <IconButton label={t.fleet.closePanel} size="sm" onClick={onClose}>
          <svg viewBox="0 0 12 12" className="h-3 w-3" fill="none" aria-hidden>
            <path d="m3 3 6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </IconButton>
      </div>

      <div className="mb-2.5 flex items-center gap-2">
        <SignalBadge state={state} />
        {secondsSinceFix !== null && (
          <span className="kh-num text-sm text-ink-3">{t.fleet.ago(formatAge(secondsSinceFix, t))}</span>
        )}
      </div>

      <dl className="space-y-0.5 border-t border-line pt-2 text-base">
        <PanelRow label={t.fleet.order} value={p.orderNumber} mono />
        <PanelRow label={t.fleet.customer} value={p.customerName} />
        <PanelRow label={t.fleet.driver} value={p.driverName ?? '—'} />
        <PanelRow
          label={t.fleet.phone}
          value={
            p.driverPhone ? (
              // A dispatcher chasing a silent truck should not have to copy a
              // number out by hand into a desk phone.
              <a href={`tel:${p.driverPhone}`} className="kh-num text-brand-text hover:underline">
                {p.driverPhone}
              </a>
            ) : (
              '—'
            )
          }
        />
        <PanelRow label={t.fleet.travelled} value={`${p.distanceKm ?? 0} km`} mono />
        <PanelRow label={t.fleet.remaining} value={p.remainingKm !== null ? `${p.remainingKm} km` : '—'} mono />
      </dl>

      <Link href={`/sessions/${p.sessionId}`} className="mt-3 block">
        <Button variant="primary" block size="sm">
          {t.fleet.detail}
        </Button>
      </Link>
    </div>
  );
}

function PanelRow({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-0.5">
      <dt className="shrink-0 text-sm text-ink-2">{label}</dt>
      <dd className={`min-w-0 truncate text-right font-medium ${mono ? 'kh-num' : ''}`}>{value}</dd>
    </div>
  );
}

function formatAge(seconds: number, t: Dictionary): string {
  if (seconds < 60) return t.fleet.ageSec(String(seconds));
  if (seconds < 3600) return t.fleet.ageMin(String(Math.floor(seconds / 60)));
  const h = Math.floor(seconds / 3600);
  if (h < 24) return t.fleet.ageHour(String(h));
  return t.fleet.ageDay(String(Math.floor(h / 24)));
}

/**
 * The map's loading state, as a named component rather than an inline arrow.
 *
 * next/dynamic renders `loading` as a component, so a hook is legal inside it —
 * but only if it *is* a component. An inline arrow in an options object reads
 * like a render callback, and the next person to touch it would have no reason
 * to think a hook belonged there.
 */
function MapLoading() {
  const t = useT();
  return (
    <div className="grid h-full place-items-center bg-surface-2">
      <div className="flex flex-col items-center gap-2 text-ink-3">
        <span className="kh-skeleton h-8 w-8 rounded-full" />
        <span className="text-sm">{t.fleet.mapLoading}</span>
      </div>
    </div>
  );
}

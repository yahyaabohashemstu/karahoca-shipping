'use client';

import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { api, type FleetPosition } from '@/lib/api';
import { useFleetStream } from '@/lib/useRealtime';
import { displayState, isSilent, SIGNAL_RANK, useNow, type DisplayState } from '@/lib/signal';
import { AppShell, useRequireAuth, useShell } from '@/components/AppShell';
import {
  Button,
  ConnectionPill,
  EmptyState,
  ErrorState,
  SignalBadge,
  SkeletonList,
  StaleBanner,
  Stat,
} from '@/components/ui';
import { Kbd, Tip } from '@/components/ui/Hint';
import { IconChevron, IconClose, IconFocus, IconSearch } from '@/components/shell/Icons';
import { dirOf, useI18n, useT, type Dictionary } from '@/lib/i18n';
import { searchFold } from '@/lib/search';
import { useHotkeys } from '@/lib/useHotkeys';

/* =============================================================================
   The live fleet
   =============================================================================
   The map is not a panel on this screen. It is the screen: it fills the
   viewport corner to corner, and the fleet list, the counters, the camera
   controls and the vehicle detail all float on top of it.

   That is a decision about the work rather than about taste. Nearly every
   question a dispatcher asks here is geographic — where is it, how far is left,
   has it reached the border, which two are nearest Mosul — and a map large
   enough to answer those without panning is doing the work. A map in a pane
   beside a table is a picture of the work.

   The cost of the decision is paid here, in three places. Every floating panel
   has to earn the pixels it covers, so all of them collapse and one key clears
   the lot. Every panel has to stay legible over terrain rather than over a
   neutral background, which is what the glass material is for. And the camera
   has to know what is covering it, or "fit all vehicles" quietly parks the
   nearest lorry underneath the fleet rail — see the `inset` prop below.
   ========================================================================== */

// MapLibre touches `window` at import time — must not be server-rendered.
const FleetMap = dynamic(() => import('@/components/FleetMap'), {
  ssr: false,
  loading: MapLoading,
});

/** Root font-size. Layout is authored in rem; a camera deals only in pixels. */
const REM = 14;

const DOCK_ZONE = 5.3; // dock width plus the margin either side of it
const RAIL_WIDTH = 20.5;
const PANEL_WIDTH = 20.5;
const GAP = 0.75;
/*
 * The status cluster's height, declared rather than left to its contents.
 *
 * Three things are measured from the bottom of that cluster: where the map's
 * control stack starts, how much of the top of the map the camera must avoid,
 * and — indirectly — whether the two overlap. Letting it size itself meant
 * those were three guesses at the same number, and the guess was 7px short:
 * the zoom control was drawn through the corner of the cluster above it.
 */
const CLUSTER_H = 3.5;
/** The first pixel below the status cluster that is free. */
const BELOW_CLUSTER = (GAP + CLUSTER_H + GAP) * 14;
/**
 * Where the map's camera stack ends.
 *
 * Three glass groups of one or two 2rem buttons, each with 0.5rem of padding and
 * 1.5rem of gap between groups — measured at 187px, rounded up so that a future
 * fourth button does not silently start overlapping the detail panel.
 */
const CAMERA_STACK_BOTTOM = BELOW_CLUSTER + 200;

const RAIL_KEY = 'kh.fleet.rail';

type Filter = 'all' | 'silent' | 'paused';

/** A row plus the freshness we recomputed for it, so nothing downstream re-derives it. */
interface Row {
  p: FleetPosition;
  state: DisplayState;
  secondsSinceFix: number | null;
  speedKmh: number;
}

export default function LiveDashboard() {
  const authed = useRequireAuth();
  // Nothing renders — not even the shell — until the token check has run. A
  // dashboard that paints and then redirects is a flash of somebody else's data.
  if (!authed) return null;
  return (
    <AppShell canvas>
      <FleetConsole />
    </AppShell>
  );
}

/* -------------------------------------------------------------------------- */

/**
 * Everything on the live screen, below the shell's provider.
 *
 * A separate component rather than the page itself, because focus mode is owned
 * by the shell and read through context — and a component cannot consume a
 * context it is itself rendering the provider for.
 */
function FleetConsole() {
  const t = useT();
  const { locale } = useI18n();
  const { focus, setFocus } = useShell();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [railOpen, setRailOpen] = useState(true);
  const searchRef = useRef<HTMLInputElement>(null);
  /*
   * A counter, not a boolean, and not a call to focus().
   *
   * Pressing `/` while the rail is collapsed has to open it first, and the input
   * does not exist until React has rendered that. Bumping a counter and focusing
   * from an effect keyed on it means the focus lands on the render that created
   * the field, deterministically. The obvious alternative — focusing inside a
   * requestAnimationFrame after setState — depends on the browser producing a
   * frame, which is not something a keyboard shortcut should depend on.
   */
  const [focusSearch, setFocusSearch] = useState(0);
  useEffect(() => {
    if (focusSearch > 0) searchRef.current?.focus();
  }, [focusSearch]);

  // One clock for the list, the badges, the counters and the map. See lib/signal.
  const now = useNow();

  const { connected, authFailed, positions: liveUpdates } = useFleetStream();

  const { data, isLoading, isError, error, isFetching, refetch } = useQuery({
    queryKey: ['live-fleet'],
    queryFn: api.liveFleet,
  });

  const { data: stats } = useQuery({
    queryKey: ['stats'],
    queryFn: api.stats,
    refetchInterval: 60_000,
  });

  /*
   * The rail's last state, restored after mount rather than during render.
   *
   * localStorage is not readable on the server, so seeding it into useState
   * would make the server and the client disagree about a 20rem panel and React
   * would tear the whole tree down to fix it. With no stored preference the
   * width of the window decides: on a warehouse tablet the rail would cover
   * most of the map it is meant to be an index of.
   */
  useEffect(() => {
    const stored = window.localStorage.getItem(RAIL_KEY);
    if (stored === '0' || stored === '1') setRailOpen(stored === '1');
    else setRailOpen(window.innerWidth >= 1024);
  }, []);

  /*
   * One way in and out of the rail, and the write is not inside the updater.
   *
   * It was: `setRailOpen(open => { localStorage.setItem(...); return !open })`.
   * A state updater must be pure — React is free to call it more than once, and
   * does in development — so a side effect in there runs twice for one press.
   * Harmless with a localStorage write of the same value, and exactly the kind
   * of thing that stops being harmless the day somebody puts a POST in it.
   */
  function setRail(open: boolean) {
    setRailOpen(open);
    window.localStorage.setItem(RAIL_KEY, open ? '1' : '0');
  }

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
  const pausedCount = useMemo(() => rows.filter((r) => r.state === 'PAUSED').length, [rows]);

  const visible = useMemo(() => {
    const q = searchFold(search.trim());
    return rows.filter((r) => {
      if (filter === 'silent' && !isSilent(r.state)) return false;
      if (filter === 'paused' && r.state !== 'PAUSED') return false;
      if (!q) return true;
      return [
        r.p.vehiclePlate,
        r.p.reference,
        r.p.orderNumber,
        r.p.customerName,
        r.p.carrierName,
        r.p.driverName,
      ]
        .filter(Boolean)
        .some((v) => searchFold(String(v)).includes(q));
    });
  }, [rows, search, filter]);

  const selected = rows.find((r) => r.p.sessionId === selectedId) ?? null;

  /**
   * Walk the visible list.
   *
   * Bound to the arrow keys and reused by the search box, so typing a plate and
   * pressing Down goes straight into the results without the hand leaving the
   * keyboard. Starting from -1 when nothing is selected means the first Down
   * lands on the first row rather than the second.
   */
  function move(delta: number) {
    if (visible.length === 0) return;
    const at = visible.findIndex((r) => r.p.sessionId === selectedId);
    const next = at === -1 ? (delta > 0 ? 0 : visible.length - 1) : (at + delta + visible.length) % visible.length;
    setSelectedId(visible[next].p.sessionId);
    // Walking the list with the rail shut would move a selection nobody can
    // see. Opening it is the only reading of the keypress that makes sense.
    if (!railOpen) setRail(true);
  }

  useHotkeys({
    // The web's own convention for "search this page", and it costs no modifier.
    '/': () => {
      setRail(true);
      setFocusSearch((n) => n + 1);
    },
    'mod+b': () => setRail(!railOpen),
    arrowdown: () => move(1),
    arrowup: () => move(-1),
    /*
     * Escape peels one layer at a time rather than resetting the screen.
     *
     * Focus mode is handled by the shell, which sits outside this component and
     * runs first; what is left here is the selection and then the search, in
     * the order a dispatcher would want them undone.
     */
    escape: () => {
      if (focus) return;
      if (selectedId) setSelectedId(null);
      else if (search) setSearch('');
      else if (filter !== 'all') setFilter('all');
    },
  });

  /*
   * What the camera must not aim at.
   *
   * Logical panels, physical pixels: the rail is on the inline-start edge, which
   * is the right-hand side of an Arabic screen, and a map camera has never
   * heard of inline-start. Everything vanishes in focus mode, which is the point
   * of focus mode — the camera gets the whole viewport back too.
   */
  const rtl = dirOf(locale) === 'rtl';
  const startPx = focus ? 0 : (railOpen ? DOCK_ZONE + RAIL_WIDTH + GAP : DOCK_ZONE) * REM;
  const endPx = focus ? 0 : (selected ? PANEL_WIDTH + GAP * 2 : 3.5) * REM;
  const inset = {
    top: focus ? 0 : BELOW_CLUSTER,
    bottom: focus ? 0 : 3 * REM,
    left: rtl ? endPx : startPx,
    right: rtl ? startPx : endPx,
  };

  return (
    <>
      <FleetMap
        positions={fleet}
        liveUpdates={liveUpdates}
        selectedId={selectedId}
        onSelect={setSelectedId}
        now={now}
        stale={!connected && !isLoading}
        inset={inset}
        // Clear of the status cluster, which floats in the same corner.
        controlsTop={focus ? GAP * REM : BELOW_CLUSTER}
      />

      {/* The feed is frozen but data is still on screen — say so, and do not let
          a stale map masquerade as a live one. */}
      {!connected && !isLoading && (
        <div className="pointer-events-none absolute inset-x-0 top-3 z-overlay flex justify-center px-3">
          <StaleBanner
            className="kh-pop-in pointer-events-auto max-w-[min(34rem,100%)]"
            message={authFailed ? t.fleet.socketAuthLost : t.fleet.socketLost}
            onRetry={() => refetch()}
          />
        </div>
      )}

      {!focus && (
        <div
          className="kh-glass kh-aside-in absolute end-3 top-3 z-cluster flex items-center gap-1 rounded-2xl p-1"
          style={{ height: `${CLUSTER_H}rem` }}
        >
          <Stat
            label={t.fleet.statActive}
            value={stats?.activeSessions ?? fleet.length}
            loading={isLoading}
          />
          <Stat label={t.fleet.statAwaiting} value={stats?.awaitingClaim ?? 0} />
          <Stat
            label={t.fleet.statSilent}
            value={silentCount}
            tone={silentCount > 0 ? 'warn' : 'neutral'}
            onClick={() => setFilter(filter === 'silent' ? 'all' : 'silent')}
            active={filter === 'silent'}
          />
          <span className="mx-0.5 h-7 w-px bg-line" aria-hidden />
          <ConnectionPill connected={connected} />
          {/*
            Focus mode, beside the other controls that change what is on screen
            rather than what is on the road.

            It began as a hint chip along the bottom edge and had to move: the
            chip sat between the fleet rail and the legend, and at 1280px those
            three met with a pixel to spare. A control that only fits on a wide
            monitor is a control that gets removed later by somebody who cannot
            see what it was for.
          */}
          <button
            type="button"
            onClick={() => setFocus(true)}
            aria-label={t.fleet.focusHint}
            className="group relative ms-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-xl text-ink-3 transition-colors hover:bg-surface-3/70 hover:text-ink"
          >
            <IconFocus />
            <Tip side="start">
              <span className="flex items-center gap-1.5">
                {t.fleet.focusHint}
                <Kbd>F</Kbd>
              </span>
            </Tip>
          </button>
        </div>
      )}

      {!focus && (
        <FleetRail
          open={railOpen}
          onToggle={() => setRail(!railOpen)}
          rows={rows}
          visible={visible}
          counts={{ all: rows.length, silent: silentCount, paused: pausedCount }}
          filter={filter}
          onFilter={setFilter}
          search={search}
          onSearch={setSearch}
          searchRef={searchRef}
          selectedId={selectedId}
          onSelect={setSelectedId}
          onMove={move}
          isLoading={isLoading}
          isError={isError}
          error={error as Error | null}
          isFetching={isFetching}
          onRetry={() => refetch()}
        />
      )}

      {!focus && selected && (
        <div
          className="absolute bottom-3 end-3 z-overlay flex"
          style={{
            width: `${PANEL_WIDTH}rem`,
            maxWidth: 'calc(100vw - 1.5rem)',
            /*
             * The panel and the camera stack share the inline-end edge and only
             * avoid each other vertically, so on a short window the panel would
             * grow up into the zoom buttons. Capping it at whatever is left below
             * them means it scrolls instead — 273px of content on a 720px screen
             * never sees this, and a 540px laptop lid does.
             */
            maxHeight: `calc(100vh - ${CAMERA_STACK_BOTTOM}px - ${GAP * 2}rem)`,
          }}
        >
          <DetailPanel row={selected} onClose={() => setSelectedId(null)} />
        </div>
      )}

    </>
  );
}

/* -------------------------------------------------------------------------- */

/**
 * The fleet, as an index to the map.
 *
 * It floats over the map rather than sitting beside it, which means it has to
 * be dismissible — and dismissing it must not lose the dispatcher's place, so
 * collapsed it leaves a handle carrying the number of vehicles it is hiding.
 */
function FleetRail({
  open,
  onToggle,
  rows,
  visible,
  counts,
  filter,
  onFilter,
  search,
  onSearch,
  searchRef,
  selectedId,
  onSelect,
  onMove,
  isLoading,
  isError,
  error,
  isFetching,
  onRetry,
}: {
  open: boolean;
  onToggle: () => void;
  rows: Row[];
  visible: Row[];
  counts: { all: number; silent: number; paused: number };
  filter: Filter;
  onFilter: (f: Filter) => void;
  search: string;
  onSearch: (v: string) => void;
  searchRef: React.RefObject<HTMLInputElement | null>;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onMove: (delta: number) => void;
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
  isFetching: boolean;
  onRetry: () => void;
}) {
  const t = useT();
  const listRef = useRef<HTMLUListElement>(null);

  // Keep the selected row on screen when the arrow keys walk past the edge of
  // the viewport, or when a click on the map selects something scrolled away.
  useEffect(() => {
    if (!open || !selectedId) return;
    listRef.current
      ?.querySelector<HTMLElement>(`[data-session="${selectedId}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [selectedId, open]);

  if (!open) {
    return (
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={false}
        className="kh-glass kh-rail-in group absolute top-3 z-overlay flex flex-col items-center gap-2 rounded-2xl px-1.5 py-3 text-ink-2 transition-colors hover:text-ink"
        style={{ insetInlineStart: `${DOCK_ZONE}rem` }}
      >
        <IconChevron />
        {/* The count is the whole reason this handle is not just an arrow: it
            says what is behind it, so reopening is a decision rather than a
            guess. */}
        <span className="kh-num text-2xs font-semibold" style={{ writingMode: 'vertical-rl' }}>
          {counts.all}
        </span>
        <Tip>{t.fleet.railExpand}</Tip>
      </button>
    );
  }

  return (
    <aside
      aria-label={t.fleet.railTitle}
      className="kh-glass kh-rail-in absolute bottom-3 top-3 z-overlay flex flex-col overflow-hidden rounded-2xl"
      style={{
        insetInlineStart: `${DOCK_ZONE}rem`,
        width: `${RAIL_WIDTH}rem`,
        maxWidth: 'calc(100vw - 6rem)',
      }}
    >
      {/* ---------------------------------------------------------- search -- */}
      <div className="flex shrink-0 items-center gap-2 px-2.5 pt-2.5">
        <div className="group relative flex min-w-0 flex-1 items-center gap-2 rounded-xl bg-surface-3/60 px-2.5 focus-within:ring-2 focus-within:ring-brand">
          <span className="text-ink-3" aria-hidden>
            <IconSearch className="h-4 w-4" />
          </span>
          <input
            ref={searchRef}
            value={search}
            onChange={(event) => onSearch(event.target.value)}
            // Down from inside the box walks into the results. Without this the
            // dispatcher has to take a hand off the keyboard to pick the row
            // they have just finished typing the name of.
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault();
                onMove(1);
              } else if (event.key === 'ArrowUp') {
                event.preventDefault();
                onMove(-1);
              }
            }}
            placeholder={t.fleet.searchPlaceholder}
            aria-label={t.fleet.searchPlaceholder}
            autoComplete="off"
            spellCheck={false}
            className="h-8 min-w-0 flex-1 bg-transparent text-base text-ink outline-none placeholder:text-ink-3"
          />
          {search ? (
            <button
              type="button"
              onClick={() => onSearch('')}
              aria-label={t.common.clearSearch}
              className="shrink-0 rounded-md p-0.5 text-ink-3 transition-colors hover:text-ink"
            >
              <IconClose className="h-3.5 w-3.5" />
            </button>
          ) : (
            <Kbd className="shrink-0">/</Kbd>
          )}
        </div>

        <button
          type="button"
          onClick={onToggle}
          aria-expanded
          className="group relative grid h-8 w-8 shrink-0 place-items-center rounded-xl text-ink-3 transition-colors hover:bg-surface-3/70 hover:text-ink"
        >
          <IconChevron back />
          <Tip side="start">{t.fleet.railCollapse}</Tip>
        </button>
      </div>

      {/* --------------------------------------------------------- filters -- */}
      <div className="flex shrink-0 gap-1 px-2.5 py-2" role="group" aria-label={t.fleet.filterLabel}>
        <Chip active={filter === 'all'} count={counts.all} onClick={() => onFilter('all')}>
          {t.fleet.filterAll}
        </Chip>
        <Chip
          active={filter === 'silent'}
          count={counts.silent}
          tone={counts.silent > 0 ? 'warn' : undefined}
          onClick={() => onFilter(filter === 'silent' ? 'all' : 'silent')}
        >
          {t.fleet.filterSilent}
        </Chip>
        <Chip
          active={filter === 'paused'}
          count={counts.paused}
          tone={counts.paused > 0 ? 'paused' : undefined}
          onClick={() => onFilter(filter === 'paused' ? 'all' : 'paused')}
        >
          {t.fleet.filterPaused}
        </Chip>
      </div>

      {/* ------------------------------------------------------------ list -- */}
      <div className="kh-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain px-1.5 pb-1.5">
        {/* Three distinct states. A failed request must never render as "no
            vehicles en route" — that reads as good news. */}
        {isLoading ? (
          <SkeletonList rows={7} />
        ) : isError ? (
          <ErrorState
            className="m-1.5"
            title={t.fleet.loadFailed}
            message={error?.message}
            onRetry={onRetry}
            retrying={isFetching}
          />
        ) : visible.length === 0 ? (
          <EmptyState
            title={
              rows.length === 0
                ? t.fleet.emptyActive
                : filter === 'silent'
                  ? t.fleet.emptySilent
                  : filter === 'paused'
                    ? t.fleet.emptyPaused
                    : t.fleet.emptyMatch
            }
            description={rows.length === 0 ? t.fleet.emptyBody : undefined}
            action={
              rows.length === 0 ? (
                <Link href="/sessions/new">
                  <Button variant="primary" size="sm">
                    {t.fleet.openSession}
                  </Button>
                </Link>
              ) : (
                <Button
                  size="sm"
                  onClick={() => {
                    onSearch('');
                    onFilter('all');
                  }}
                >
                  {t.fleet.clearFilters}
                </Button>
              )
            }
          />
        ) : (
          <ul ref={listRef} className="flex flex-col gap-0.5">
            {visible.map((r) => (
              <FleetRow
                key={r.p.sessionId}
                row={r}
                selected={selectedId === r.p.sessionId}
                onSelect={() => onSelect(r.p.sessionId)}
              />
            ))}
          </ul>
        )}
      </div>

      {/* ---------------------------------------------------------- footer -- */}
      {visible.length > 0 && (
        <div className="flex shrink-0 items-center justify-between border-t border-line px-3 py-1.5 text-2xs text-ink-3">
          <span>
            <span className="kh-num">{visible.length}</span>
            {visible.length !== rows.length && (
              <span className="kh-num text-ink-3"> / {rows.length}</span>
            )}{' '}
            {t.fleet.vehicles}
          </span>
          <span className="flex items-center gap-1">
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd>
          </span>
        </div>
      )}
    </aside>
  );
}

/**
 * A filter pill.
 *
 * Every one of them shows its count, including the zeroes, and none of them is
 * disabled. A chip that vanishes when its count drops to nought makes the row
 * reflow under the cursor, and a chip that greys out cannot answer the question
 * the dispatcher is actually asking, which is "how many are silent" — nought is
 * the answer they most want to see.
 */
function Chip({
  children,
  count,
  active,
  tone,
  onClick,
}: {
  children: React.ReactNode;
  count: number;
  active: boolean;
  tone?: 'warn' | 'paused';
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={clsx(
        'flex min-w-0 flex-1 items-center justify-center gap-1.5 rounded-lg px-2 py-1 text-2xs font-medium transition-colors',
        active
          ? 'bg-brand text-ink-inverse'
          : 'bg-surface-3/50 text-ink-2 hover:bg-surface-3 hover:text-ink',
      )}
    >
      <span className="truncate">{children}</span>
      <span
        className={clsx(
          'kh-num shrink-0 rounded-full px-1 text-2xs font-semibold',
          active
            ? 'bg-black/15 text-ink-inverse'
            : tone === 'warn'
              ? 'bg-warn-bg text-warn'
              : tone === 'paused'
                ? 'bg-paused-bg text-paused'
                : 'text-ink-3',
        )}
      >
        {count}
      </span>
    </button>
  );
}

/**
 * The edge colour of a row, keyed to the marker colour on the map.
 *
 * Same value, same variable: a lorry that is graphite on the map is graphite in
 * the list, and the eye moves between the two without translating. It is never
 * the only encoding — the badge beside it carries a word and a glyph — but it
 * is what makes a column of forty rows scannable at a glance, which is the one
 * thing the badge cannot do.
 */
const EDGE: Record<DisplayState, string> = {
  LIVE: 'bg-[rgb(var(--kh-map-live))]',
  DELAYED: 'bg-[rgb(var(--kh-map-delayed))]',
  STALE: 'bg-[rgb(var(--kh-map-stale))]',
  LOST: 'bg-[rgb(var(--kh-map-lost))]',
  NO_SIGNAL: 'bg-[rgb(var(--kh-map-nosignal))]',
  PAUSED: 'bg-[rgb(var(--kh-map-paused))]',
};

function FleetRow({
  row,
  selected,
  onSelect,
}: {
  row: Row;
  selected: boolean;
  onSelect: () => void;
}) {
  const t = useT();
  const { p, state, speedKmh, secondsSinceFix } = row;
  const lowBattery = p.batteryPct !== null && p.batteryPct < 20;

  return (
    <li>
      <button
        onClick={onSelect}
        data-session={p.sessionId}
        aria-current={selected ? 'true' : undefined}
        className={clsx(
          'relative block w-full rounded-xl py-2 pe-2.5 ps-3.5 text-start transition-colors',
          selected
            ? 'bg-brand-soft ring-1 ring-inset ring-brand/30'
            : 'hover:bg-surface-3/60',
        )}
      >
        <span
          aria-hidden
          className={clsx('absolute inset-y-2 start-1.5 w-[3px] rounded-full', EDGE[state])}
        />

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

        <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-sm text-ink-3">
          {/*
            Speed is only true of something that is moving. On a lorry that has
            been silent for two hours "0 km/s" is not a fact about the lorry, it
            is a fact about the last packet — and how old that packet is happens
            to be the only thing worth knowing about it.
          */}
          {state === 'LIVE' || state === 'DELAYED' ? (
            <span className="kh-num">{t.fleet.speed(String(speedKmh))}</span>
          ) : (
            secondsSinceFix !== null && (
              <span className="kh-num font-medium text-ink-2">
                {t.fleet.ago(formatAge(secondsSinceFix, t))}
              </span>
            )
          )}
          {p.remainingKm !== null && (
            <span className="kh-num">{t.fleet.remainingShort(String(p.remainingKm))}</span>
          )}
          {p.batteryPct !== null && (
            <span
              className={clsx(
                'kh-num inline-flex items-center gap-1',
                lowBattery && 'font-medium text-danger',
              )}
            >
              <BatteryIcon pct={p.batteryPct} />
              {p.batteryPct}%
            </span>
          )}
          {p.mockLocationCount > 0 && (
            <span
              className="inline-flex items-center gap-1 font-medium text-danger"
              title={t.fleet.mockTitle}
            >
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

/* -------------------------------------------------------------------------- */

/**
 * The selected lorry, without leaving the map.
 *
 * Everything a dispatcher is asked for down a telephone, in the order they are
 * asked for it, and then a way to reach the full record. The driver's number is
 * a button rather than a line of text because the times this panel is open are
 * disproportionately the times somebody needs to be rung.
 */
function DetailPanel({ row, onClose }: { row: Row; onClose: () => void }) {
  const t = useT();
  const { p, state, secondsSinceFix } = row;

  return (
    // min-h-0 on a flex child is what lets the middle section actually shrink;
    // without it the dl keeps its full height and the cap above does nothing.
    <div className="kh-glass kh-panel-in flex min-h-0 w-full flex-col overflow-hidden rounded-2xl">
      <div className="flex shrink-0 items-start justify-between gap-2 px-3.5 pb-2 pt-3">
        <div className="min-w-0">
          <div className="kh-num truncate text-md font-semibold tracking-tight">
            {p.vehiclePlate ?? p.reference}
          </div>
          <div className="truncate text-sm text-ink-2">{p.carrierName}</div>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label={t.fleet.closePanel}
          className="-me-1 -mt-1 shrink-0 rounded-lg p-1.5 text-ink-3 transition-colors hover:bg-surface-3/70 hover:text-ink"
        >
          <IconClose className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="flex shrink-0 items-center gap-2 px-3.5 pb-2.5">
        <SignalBadge state={state} />
        {secondsSinceFix !== null && (
          <span className="kh-num text-sm text-ink-3">
            {t.fleet.ago(formatAge(secondsSinceFix, t))}
          </span>
        )}
      </div>

      <dl className="kh-scroll min-h-0 flex-1 space-y-0.5 overflow-y-auto border-t border-line px-3.5 py-2 text-base">
        <PanelRow label={t.fleet.order} value={p.orderNumber} mono />
        <PanelRow label={t.fleet.customer} value={p.customerName} />
        <PanelRow label={t.fleet.driver} value={p.driverName ?? '—'} />
        <PanelRow label={t.fleet.travelled} value={`${p.distanceKm ?? 0} km`} mono />
        <PanelRow
          label={t.fleet.remaining}
          value={p.remainingKm !== null ? `${p.remainingKm} km` : '—'}
          mono
        />
      </dl>

      <div className="flex shrink-0 gap-1.5 border-t border-line p-2.5">
        {p.driverPhone && (
          // A dispatcher chasing a silent lorry should not have to copy a number
          // out by hand into a desk phone.
          <a
            href={`tel:${p.driverPhone}`}
            className="kh-num inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-surface-3/70 px-2.5 text-sm font-medium text-ink transition-colors hover:bg-surface-3"
            title={p.driverPhone}
          >
            <PhoneIcon />
            <span className="max-w-[7rem] truncate" dir="ltr">
              {p.driverPhone}
            </span>
          </a>
        )}
        <Link href={`/sessions/${p.sessionId}`} className="min-w-0 flex-1">
          <Button variant="primary" block size="sm" className="!h-8 !rounded-lg">
            {t.fleet.detail}
          </Button>
        </Link>
      </div>
    </div>
  );
}

function PhoneIcon() {
  return (
    <svg viewBox="0 0 14 14" className="h-3.5 w-3.5 shrink-0" fill="none" aria-hidden>
      <path
        d="M4.6 2.1 5.9 4.5 4.7 5.7c.6 1.3 1.6 2.3 2.9 2.9l1.2-1.2 2.4 1.3-.4 2.2c-.1.4-.5.7-.9.6C5.9 11 3 8.1 2.3 4.1c-.1-.4.2-.8.6-.9l1.7-.3Z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function PanelRow({
  label,
  value,
  mono,
}: {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-0.5">
      <dt className="shrink-0 text-sm text-ink-2">{label}</dt>
      <dd className={clsx('min-w-0 truncate text-end font-medium', mono && 'kh-num')}>{value}</dd>
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

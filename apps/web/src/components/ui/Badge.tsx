'use client';

import clsx from 'clsx';
import type { DisplayState } from '@/lib/signal';
import { useT } from '@/lib/i18n';

/* =============================================================================
   Signal badges
   =============================================================================
   The previous badges encoded state in hue alone, and two of the five hues were
   a pair of near-identical tans: DELAYED #fef3c7 against STALE #ffedd5, six
   values apart in green and fourteen in blue. At 11px they were the same pill.
   Under a red-green deficiency — roughly 8% of men — LIVE, DELAYED, STALE and
   LOST all collapsed toward one wash and the badge column carried no
   information at all.

   Three independent encodings now, so any one of them surviving is enough:

     1. HUE          green · amber · graphite · red · none
     2. GLYPH        ● filled · ◐ half · ○ hollow · ■ square · ◌ dashed
     3. FILL WEIGHT  LOST is the only solid, inverted badge in the product

   STALE is graphite rather than orange on purpose. "Ageing out" reads correctly
   as a fading grey, and grey cannot be confused with amber under any form of
   colour-vision deficiency — which orange absolutely could.

   The inversion on LOST is what makes a dead truck findable while scrolling
   forty rows: it is the only place in the interface where a small element is
   filled with a saturated colour.
   ========================================================================== */

const SIGNAL_STYLE: Record<DisplayState, string> = {
  LIVE: 'bg-live-bg text-live ring-1 ring-inset ring-live-ring/45',
  DELAYED: 'bg-delayed-bg text-delayed ring-1 ring-inset ring-delayed-ring/50',
  STALE: 'bg-stale-bg text-stale ring-1 ring-inset ring-stale-ring/50',
  LOST: 'bg-lost-bg text-lost ring-1 ring-inset ring-lost-ring font-semibold',
  NO_SIGNAL: 'bg-transparent text-nosignal ring-1 ring-inset ring-nosignal-ring border-dashed',
  // Lifecycle, not freshness: the driver stopped the app, so the last fix time
  // is irrelevant and a green LIVE badge would be a lie.
  PAUSED: 'bg-paused-bg text-paused ring-1 ring-inset ring-paused-ring/60 font-medium',
};

function Glyph({ state }: { state: DisplayState }) {
  const common = 'shrink-0';
  switch (state) {
    case 'LIVE':
      return <span className={clsx(common, 'h-2 w-2 rounded-full bg-current')} aria-hidden />;
    case 'DELAYED':
      // Half-filled: a disc with the left half solid, drawn with a border trick
      // so it needs no SVG and inherits currentColor.
      return (
        <span
          className={clsx(common, 'h-2 w-2 overflow-hidden rounded-full ring-1 ring-current')}
          aria-hidden
        >
          <span className="block h-full w-1/2 bg-current" />
        </span>
      );
    case 'STALE':
      return (
        <span className={clsx(common, 'h-2 w-2 rounded-full ring-[1.5px] ring-inset ring-current')} aria-hidden />
      );
    case 'LOST':
      return <span className={clsx(common, 'h-2 w-2 rounded-[1px] bg-current')} aria-hidden />;
    case 'NO_SIGNAL':
      return (
        <span
          className={clsx(common, 'h-2 w-2 rounded-full border border-dashed border-current')}
          aria-hidden
        />
      );
    case 'PAUSED':
      // Two bars — the universal pause mark. It is what separates this from
      // DELAYED's amber at a glance and under any colour-vision deficiency.
      return (
        <span className={clsx(common, 'flex h-2 w-2 items-center justify-between')} aria-hidden>
          <span className="block h-2 w-[3px] rounded-[1px] bg-current" />
          <span className="block h-2 w-[3px] rounded-[1px] bg-current" />
        </span>
      );
  }
}

export function SignalBadge({
  state,
  className,
  compact,
}: {
  state: DisplayState;
  className?: string;
  compact?: boolean;
}) {
  const t = useT();
  // Any state the API grows later (PAUSED, CANCELLED) used to interpolate
  // `undefined` into the class string and render an empty transparent pill with
  // no text — a truck with no status at all, which a dispatcher reads as fine.
  const style = SIGNAL_STYLE[state] ?? 'bg-surface-3 text-ink-2 ring-1 ring-inset ring-line-strong';
  const label = t.signal.label[state] ?? state;

  return (
    <span
      title={t.signal.description[state] ?? label}
      className={clsx(
        'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs leading-none',
        style,
        className,
      )}
    >
      <Glyph state={state} />
      {!compact && <span>{label}</span>}
    </span>
  );
}

/** Just the glyph, for dense table cells where the label is a column header. */
export function SignalDot({ state, className }: { state: DisplayState; className?: string }) {
  const t = useT();
  const tone: Record<DisplayState, string> = {
    LIVE: 'text-live-ring',
    DELAYED: 'text-delayed-ring',
    STALE: 'text-stale-ring',
    LOST: 'text-lost-bg',
    NO_SIGNAL: 'text-nosignal-ring',
    PAUSED: 'text-paused-ring',
  };
  return (
    <span
      className={clsx('inline-flex items-center', tone[state] ?? 'text-ink-3', className)}
      title={`${t.signal.label[state] ?? state} — ${t.signal.description[state] ?? ''}`}
    >
      <Glyph state={state} />
      <span className="sr-only">{t.signal.label[state] ?? state}</span>
    </span>
  );
}

/* -----------------------------------------------------------------------------
   Lifecycle status — a different axis from signal freshness
   -------------------------------------------------------------------------- */

const STATUS_STYLE: Record<string, string> = {
  ASSIGNED: 'bg-brand-soft text-brand-text ring-brand/25',
  CLAIMED: 'bg-brand-soft text-brand-text ring-brand/25',
  ACTIVE: 'bg-live-bg text-live ring-live-ring/40',
  // The same orange as the signal badge and the map marker, so "durduruldu"
  // means one thing everywhere in the product.
  PAUSED: 'bg-paused-bg text-paused ring-paused-ring/60',
  COMPLETED: 'bg-surface-3 text-ink-2 ring-line-strong',
  CANCELLED: 'bg-surface-3 text-ink-3 ring-line-strong',
  EXPIRED: 'bg-danger-bg text-danger ring-danger-ring',
};

export function StatusBadge({ status, className }: { status: string | null; className?: string }) {
  const t = useT();
  // The sessions table used to print the raw English enum — ASSIGNED, EXPIRED —
  // in a Turkish interface, in one uniform grey pill, in the single column that
  // says what happened to a shipment.
  const style = STATUS_STYLE[status ?? ''] ?? 'bg-surface-3 text-ink-2 ring-line-strong';
  return (
    <span
      className={clsx(
        'inline-flex items-center rounded-full px-2 py-0.5 text-xs leading-none ring-1 ring-inset',
        style,
        className,
      )}
    >
      {(status && t.status[status as keyof typeof t.status]) || status || '—'}
    </span>
  );
}

/* -----------------------------------------------------------------------------
   Generic
   -------------------------------------------------------------------------- */

export function Badge({
  tone = 'neutral',
  className,
  children,
}: {
  tone?: 'neutral' | 'brand' | 'danger' | 'warn' | 'success';
  className?: string;
  children: React.ReactNode;
}) {
  const tones = {
    neutral: 'bg-surface-3 text-ink-2 ring-line-strong',
    brand: 'bg-brand-soft text-brand-text ring-brand/25',
    danger: 'bg-danger-bg text-danger ring-danger-ring',
    warn: 'bg-warn-bg text-warn ring-delayed-ring/45',
    success: 'bg-success-bg text-success ring-live-ring/40',
  } as const;
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs leading-none ring-1 ring-inset',
        tones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

'use client';

import { useEffect, useState } from 'react';
import type { SignalState } from './api';

/* =============================================================================
   One definition of "how fresh is this truck", used everywhere.
   =============================================================================
   This used to exist twice. FleetMap recomputed freshness locally against the
   wall clock, while the sidebar badge, the sort order and the "Sessiz" counter
   all trusted `signalState` as it arrived from the server. The map therefore
   aged a truck to red continuously while the list beside it stayed green until
   the next snapshot — the same truck, two colours, side by side, with the
   header count agreeing with the wrong one.

   Worse, the map's version only recomputed when a socket frame arrived, so
   during the exact outage where ageing matters most, every truck froze green.

   Both problems are solved the same way: one function, driven by a clock tick
   rather than by data arrival.
   ========================================================================== */

/** Seconds since last fix at which a truck leaves each state. */
export const SIGNAL_THRESHOLDS = {
  live: 90,      // a ping every 30–60s in motion; 90s is one missed ping
  delayed: 600,  // 10 minutes — a tunnel, a valley, a stop
  stale: 7200,   // 2 hours — beyond this the phone is off, not merely quiet
} as const;

export function signalFrom(secondsSinceFix: number | null | undefined): SignalState {
  if (secondsSinceFix === null || secondsSinceFix === undefined) return 'NO_SIGNAL';
  if (secondsSinceFix < SIGNAL_THRESHOLDS.live) return 'LIVE';
  if (secondsSinceFix < SIGNAL_THRESHOLDS.delayed) return 'DELAYED';
  if (secondsSinceFix < SIGNAL_THRESHOLDS.stale) return 'STALE';
  return 'LOST';
}

/**
 * Freshness for one fleet row, recomputed against `now` rather than trusting
 * the server's snapshot-time answer.
 *
 * `recordedAt` is preferred over the server's `secondsSinceFix` because the
 * latter was correct when the snapshot was generated and is wrong by however
 * long the page has been holding it — which, on a screen that stays open all
 * day through a socket outage, can be hours.
 */
export function freshness(
  row: { recordedAt: string | null; secondsSinceFix: number | null; signalState: SignalState },
  nowMs: number,
): { state: SignalState; secondsSinceFix: number | null } {
  if (!row.recordedAt) {
    // Never reported. secondsSinceFix cannot be derived, so the server's own
    // classification (NO_SIGNAL, or a terminal state) is the only truth there is.
    return { state: row.signalState ?? 'NO_SIGNAL', secondsSinceFix: row.secondsSinceFix };
  }
  const t = Date.parse(row.recordedAt);
  if (Number.isNaN(t)) return { state: row.signalState, secondsSinceFix: row.secondsSinceFix };

  // A phone with a skewed clock, or a server slightly ahead of the browser, can
  // produce a future timestamp. Clamping at zero keeps that reading as LIVE
  // instead of wrapping into a negative that classifies as LOST.
  const secs = Math.max(0, Math.round((nowMs - t) / 1000));
  return { state: signalFrom(secs), secondsSinceFix: secs };
}

/* -----------------------------------------------------------------------------
   Lifecycle beats freshness
   -------------------------------------------------------------------------- */

/**
 * What the dispatcher sees, which is not the same as how fresh the fix is.
 *
 * A driver who taps Stop leaves a session in PAUSED with a perfectly recent
 * last position. Judged on freshness alone that reads LIVE — green, healthy,
 * nothing to do — when in fact the truck has stopped reporting and will not
 * report again until someone acts. Lifecycle therefore overrides freshness.
 */
export type DisplayState = SignalState | 'PAUSED';

export function displayState(
  row: { status?: string | null; recordedAt: string | null; secondsSinceFix: number | null; signalState: SignalState },
  nowMs: number,
): { state: DisplayState; secondsSinceFix: number | null } {
  const f = freshness(row, nowMs);
  if (row.status === 'PAUSED') return { state: 'PAUSED', secondsSinceFix: f.secondsSinceFix };
  return f;
}

/** Rank for sorting: the trucks that need attention float to the top. */
export const SIGNAL_RANK: Record<DisplayState, number> = {
  LOST: 0,
  STALE: 1,
  // A driver who stopped tracking outranks a merely delayed one: a delay
  // resolves itself when the next fix lands, a stop does not.
  PAUSED: 2,
  DELAYED: 3,
  LIVE: 4,
  NO_SIGNAL: 5,
};

/** States a dispatcher is expected to act on. */
export function isSilent(state: DisplayState): boolean {
  return state === 'LOST' || state === 'STALE' || state === 'PAUSED';
}

/**
 * A shared clock.
 *
 * Every consumer of `freshness` needs a re-render on a timer, not on data
 * arrival. 15 seconds is the coarsest tick that still moves a truck out of
 * LIVE within a sixth of the 90-second threshold, and it costs one render per
 * quarter-minute on a page that already renders on every websocket frame.
 */
export function useNow(intervalMs = 15_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

// -----------------------------------------------------------------------------
// Turkish labels, in one place so the map legend, the badges and the filters
// can never disagree about what a state is called.
// -----------------------------------------------------------------------------

export const SIGNAL_LABEL: Record<DisplayState, string> = {
  LIVE: 'Canlı',
  DELAYED: 'Gecikmeli',
  STALE: 'Eski',
  LOST: 'Sinyal yok',
  NO_SIGNAL: 'Başlamadı',
  PAUSED: 'Durduruldu',
};

export const SIGNAL_DESCRIPTION: Record<DisplayState, string> = {
  LIVE: 'Son 90 saniye içinde konum alındı',
  DELAYED: 'Son konum 90 saniye – 10 dakika önce',
  STALE: 'Son konum 10 dakika – 2 saat önce',
  LOST: 'Son konumun üzerinden 2 saatten fazla geçti',
  NO_SIGNAL: 'Sürücü henüz takibi başlatmadı',
  PAUSED: 'Sürücü takibi durdurdu — araç konum göndermiyor',
};

/** Session lifecycle status, distinct from signal freshness. */
export const STATUS_LABEL: Record<string, string> = {
  ASSIGNED: 'Kod bekliyor',
  CLAIMED: 'Cihaz bağlandı',
  ACTIVE: 'Yolda',
  PAUSED: 'Duraklatıldı',
  COMPLETED: 'Teslim edildi',
  CANCELLED: 'İptal edildi',
  EXPIRED: 'Süresi doldu',
};

export function statusLabel(status: string | null | undefined): string {
  if (!status) return '—';
  return STATUS_LABEL[status] ?? status;
}

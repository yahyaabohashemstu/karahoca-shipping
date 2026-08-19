'use client';

import { Field, Input, SegmentedControl } from './ui';
import { clientDictionary, interpolate, useI18n, useT, type Dictionary } from '@/lib/i18n';
import { formatNumber } from '@/lib/format';
import type { Locale } from '@/lib/i18n/locale';

/* =============================================================================
   How often a truck reports
   =============================================================================
   Two genuinely different questions, and the interface used to answer only one
   of them with a slider that stopped at 60 seconds:

     TIME     — a fix every N seconds. Predictable row count, predictable
                battery, and a parked truck keeps proving it is parked.

     DISTANCE — a fix every N metres travelled. The trace has the same detail
                per kilometre whether the truck is crawling through Istanbul or
                running at 90 on the D100, and a slow city leg stops producing
                a thousand rows of the same junction.

   Distance mode is not "no time component". The device still samples on the
   time interval — that is what a GNSS receiver does — and it still emits a
   heartbeat on the idle cadence so a stationary truck does not go silent and
   get reported as a lost signal. The distance figure decides which of those
   samples is worth storing and uploading.

   Both fields are free numeric input, not sliders. A slider communicates a
   recommended range, and there is no recommended range here: a shuttle between
   two factory gates and a four-day run to the Iranian border want numbers two
   orders of magnitude apart, and the dispatcher knows which they are dispatching.
   ========================================================================== */

export type CadenceMode = 'time' | 'distance';

export interface Cadence {
  mode: CadenceMode;
  /** Seconds between fixes while moving. Also the sampling floor in distance mode. */
  intervalSec: number;
  /** Metres between stored fixes. Only meaningful in distance mode. */
  distanceM: number;
  /** Seconds between fixes while stationary. Also the distance-mode heartbeat. */
  idleSec: number;
}

export const DEFAULT_CADENCE: Cadence = {
  mode: 'time',
  intervalSec: 10,
  distanceM: 250,
  idleSec: 60,
};

/** API bounds, mirrored so the field can say why a value was refused. */
const LIMITS = {
  intervalSec: { min: 2, max: 3600 },
  distanceM: { min: 10, max: 20000 },
  idleSec: { min: 5, max: 14400 },
};

export function validateCadence(c: Cadence): string | null {
  const t = clientDictionary();
  if (!Number.isFinite(c.intervalSec) || c.intervalSec < LIMITS.intervalSec.min || c.intervalSec > LIMITS.intervalSec.max) {
    return t.cadence.errInterval(String(LIMITS.intervalSec.min), String(LIMITS.intervalSec.max));
  }
  if (c.mode === 'distance') {
    if (!Number.isFinite(c.distanceM) || c.distanceM < LIMITS.distanceM.min || c.distanceM > LIMITS.distanceM.max) {
      return t.cadence.errDistance(String(LIMITS.distanceM.min), String(LIMITS.distanceM.max));
    }
  }
  if (!Number.isFinite(c.idleSec) || c.idleSec < LIMITS.idleSec.min || c.idleSec > LIMITS.idleSec.max) {
    return t.cadence.errIdle(String(LIMITS.idleSec.min), String(LIMITS.idleSec.max));
  }
  return null;
}

/** The three fields the API actually takes. */
export function cadenceToPolicy(c: Cadence) {
  return {
    pingIntervalSec: c.intervalSec,
    // The server coerces this up to at least pingIntervalSec; sending the larger
    // of the two here means the dispatcher's own number is never silently
    // changed when they asked for something slower than the idle default.
    idleIntervalSec: Math.max(c.idleSec, c.intervalSec),
    // Zero IS time mode. There is no separate mode column anywhere in the
    // system — the distance being non-zero is the mode.
    minDistanceM: c.mode === 'distance' ? c.distanceM : 0,
  };
}

export function CadencePicker({
  value,
  onChange,
}: {
  value: Cadence;
  onChange: (c: Cadence) => void;
}) {
  const t = useT();
  const { locale } = useI18n();
  const set = <K extends keyof Cadence>(k: K, v: Cadence[K]) => onChange({ ...value, [k]: v });
  const error = validateCadence(value);

  return (
    <div className="rounded-md bg-surface-2 p-3.5 ring-1 ring-inset ring-line">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-medium text-ink-2">{t.cadence.heading}</span>
        <SegmentedControl
          label={t.cadence.modeLabel}
          value={value.mode}
          onChange={(m) => set('mode', m)}
          options={[
            { value: 'time', label: t.cadence.modeTime },
            { value: 'distance', label: t.cadence.modeDistance },
          ]}
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {value.mode === 'distance' ? (
          <>
            <NumberField
              label={t.cadence.everyMetres}
              suffix={t.cadence.unitMetre}
              value={value.distanceM}
              onChange={(n) => set('distanceM', n)}
              hint={t.cadence.everyMetresHint}
            />
            <NumberField
              label={t.cadence.maxRate}
              suffix={t.cadence.unitSec}
              value={value.intervalSec}
              onChange={(n) => set('intervalSec', n)}
              hint={t.cadence.maxRateHint}
            />
          </>
        ) : (
          <NumberField
            label={t.cadence.everySeconds}
            suffix={t.cadence.unitSec}
            value={value.intervalSec}
            onChange={(n) => set('intervalSec', n)}
            hint={t.cadence.everySecondsHint}
          />
        )}

        <NumberField
          label={t.cadence.idle}
          suffix={t.cadence.unitSec}
          value={value.idleSec}
          onChange={(n) => set('idleSec', n)}
          hint={
            value.mode === 'distance'
              ? t.cadence.idleHintDistance
              : t.cadence.idleHintTime
          }
        />
      </div>

      {error && (
        <p role="alert" className="mt-2.5 text-sm text-danger">
          {error}
        </p>
      )}

      <p className="mt-2.5 border-t border-line pt-2.5 text-sm text-ink-3">
        {value.mode === 'distance' ? (
          <>
            {interpolate(t.cadence.estimateDistance, [
              <Est key="rows">{estimateDistanceRows(value, locale)}</Est>,
              <Est key="idle">{fmtDuration(value.idleSec, t)}</Est>,
            ])}
          </>
        ) : (
          <>
            {interpolate(t.cadence.estimateTime, [
              <Est key="rows">{estimateTimeRows(value, locale)}</Est>,
            ])}
          </>
        )}
      </p>
    </div>
  );
}

function Est({ children }: { children: React.ReactNode }) {
  return <span className="kh-num font-medium text-ink-2">{children}</span>;
}

/**
 * A free numeric field.
 *
 * `type="text"` with `inputMode="numeric"`, not `type="number"`: a number input
 * silently swallows a scroll wheel over the field and turns it into a value
 * change, which on a form that configures a truck's whole shipment is a bad
 * trade for the spinner arrows.
 */
function NumberField({
  label,
  suffix,
  value,
  onChange,
  hint,
}: {
  label: string;
  suffix: string;
  value: number;
  onChange: (n: number) => void;
  hint?: string;
}) {
  return (
    <Field label={label} hint={hint}>
      <div className="relative">
        <Input
          type="text"
          inputMode="numeric"
          numeric
          value={Number.isFinite(value) ? String(value) : ''}
          onChange={(e) => {
            const digits = e.target.value.replace(/[^\d]/g, '');
            onChange(digits === '' ? NaN : Number(digits));
          }}
          className="pe-9"
          aria-label={`${label} (${suffix})`}
        />
        <span className="pointer-events-none absolute end-2.5 top-1/2 -translate-y-1/2 text-sm text-ink-3">
          {suffix}
        </span>
      </div>
    </Field>
  );
}

/* -------------------------------------------------------------------------- */

function estimateTimeRows(c: Cadence, locale: Locale): string {
  if (!Number.isFinite(c.intervalSec) || c.intervalSec <= 0) return '—';
  return formatNumber(locale, Math.round(3600 / c.intervalSec));
}

function estimateDistanceRows(c: Cadence, locale: Locale): string {
  if (!Number.isFinite(c.distanceM) || c.distanceM <= 0) return '—';
  return formatNumber(locale, Math.round(500_000 / c.distanceM));
}

function fmtDuration(seconds: number, t: Dictionary): string {
  if (!Number.isFinite(seconds)) return '—';
  if (seconds < 60) return `${seconds} ${t.cadence.unitSec}`;
  if (seconds < 3600) {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return s ? `${m} ${t.cadence.unitMin} ${s} ${t.cadence.unitSec}` : `${m} ${t.cadence.unitMin}`;
  }
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return m ? `${h} ${t.cadence.unitHour} ${m} ${t.cadence.unitMin}` : `${h} ${t.cadence.unitHour}`;
}

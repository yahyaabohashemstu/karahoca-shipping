'use client';

/* =============================================================================
   Finding out what the machine can actually draw
   =============================================================================
   The 3D map froze on a dispatcher's computer and not on the developer's. That
   is not a bug with a location, it is a budget that some hardware has and some
   does not, and no threshold picked in advance can be right for both — the
   office in Gaziantep, a laptop on a hotel wifi, and whatever gets bought next
   year are three different machines and none of them is this one.

   Measured, under software rendering, dragging a city view with 25 vehicles:

       terrain + buildings + models     1069 ms per frame, worst 4032 ms
       buildings + models                396 ms per frame, worst  452 ms
       flat markers                      207 ms per frame, worst  257 ms

   So terrain is the expensive one by a factor of nearly three, and it is the
   only setting that produced multi-second frames — which is what a person calls
   freezing. A real GPU is far quicker than that in absolute terms, but the
   ratios are the point: whatever a machine can afford, terrain is what it
   cannot afford first.

   Hence this. The map starts at a tier, watches how long its own frames take
   WHILE IT IS MOVING, and drops a tier when it cannot keep up — terrain first,
   then buildings, then the models, then back to the flat map that never had a
   problem. It climbs back only when the machine has proved it has room. The
   answer is remembered, so the second shift on that computer starts where the
   first one finished and the dispatcher never sees the search.

   What this deliberately does not do is guess from a GPU string or a device
   memory figure. Both lie, and neither knows what else the machine is running.
   ========================================================================== */

import type { Map as MapLibreMap } from 'maplibre-gl';

/**
 * What the map is currently allowed to draw.
 *
 * Ordered so that a numeric comparison is meaningful: every tier includes
 * everything below it, and dropping one is always the cheapest useful step.
 */
export enum Quality {
  /** No pitch, no models, flat markers. The map as it was before any of this. */
  Flat = 0,
  /** Pitched camera and 3D vehicles. The feature that was actually asked for. */
  Vehicles = 1,
  /** Extruded buildings as well. */
  Buildings = 2,
  /** Real elevation. Only for machines that can carry it. */
  Terrain = 3,
}

export const QUALITY_KEY = 'kh.map.quality';

/** Where a machine with no history starts. */
const DEFAULT_QUALITY = Quality.Buildings;

/**
 * Frame budget while the camera is moving, in milliseconds.
 *
 * 55 ms is about 18 frames a second: visibly not smooth, but still a map that
 * responds to a hand on a mouse. Below that a dispatcher describes it as
 * freezing, which is the word that started this. Deliberately not 16 ms —
 * demanding 60 fps would strip a perfectly usable map down to flat markers on
 * hardware that was coping.
 */
const BUDGET_MS = 55;

/** Comfortably better than the budget, and worth spending on more detail. */
const PROMOTE_MS = 20;

/*
 * Windows are measured in milliseconds, not frames, and that is the whole
 * trick.
 *
 * Counting frames sounds equivalent and is not. The first version waited 30
 * frames after a change and then collected 24 more before judging again — on a
 * machine drawing at 400 ms a frame, that is twenty-two seconds, and the test
 * drag lasted ten. So it shed terrain, halved the frame time, and then never
 * spoke again while the map ran at two frames a second. The slower the machine,
 * the longer it took to notice it was slow.
 *
 * Wall-clock inverts that. A struggling machine produces four samples in a
 * second and a half and four samples of 400 ms are not ambiguous; a fast one
 * produces ninety in the same window and gets a properly smoothed median. Both
 * get an answer in about the same time, which is what a person expects.
 */
const SETTLE_MS = 1200;
const WINDOW_MS = 1200;

/** Below this a window is too thin to judge, however long it took. */
const MIN_SAMPLES = 5;

/** And above this there is no point waiting out the rest of the window. */
const MAX_SAMPLES = 90;

/**
 * Consecutive good windows before spending more.
 *
 * Asymmetric on purpose: drop on the first bad window, because the dispatcher
 * is watching it stutter right now, but earn a promotion three times over. A
 * governor that climbs as eagerly as it descends oscillates, and a map that
 * changes appearance every few seconds is worse than one that is merely slow.
 */
const PROMOTE_STREAK = 3;

export function loadQuality(): Quality {
  if (typeof window === 'undefined') return DEFAULT_QUALITY;
  const raw = window.localStorage.getItem(QUALITY_KEY);
  const n = raw === null ? NaN : Number(raw);
  if (Number.isInteger(n) && n >= Quality.Flat && n <= Quality.Terrain) return n as Quality;
  return DEFAULT_QUALITY;
}

export function saveQuality(quality: Quality) {
  try {
    window.localStorage.setItem(QUALITY_KEY, String(quality));
  } catch {
    /* private mode, or storage full. The governor still works for this session. */
  }
}

export interface GovernorEvent {
  quality: Quality;
  /** Median moving-frame time that triggered this, in ms. */
  medianMs: number;
  direction: 'down' | 'up';
}

/**
 * Watches the map's own frames and adjusts what it draws.
 *
 * Attaches to MapLibre's `render` event, which fires once per painted frame —
 * the only honest signal available. requestAnimationFrame is not a substitute:
 * the browser keeps servicing it at 60 Hz whether or not the map is painting,
 * so a completely stalled canvas measures as perfectly healthy. That mistake
 * cost an afternoon and is why this class exists rather than a rAF counter.
 */
export class QualityGovernor {
  private readonly map: MapLibreMap;
  private readonly onChange: (event: GovernorEvent) => void;

  private quality: Quality;
  private samples: number[] = [];
  private settleUntil = 0;
  private windowStart = 0;
  private goodStreak = 0;
  private lastFrameAt = 0;
  private running = false;
  /*
   * Nothing is measured until the map has finished loading once.
   *
   * The opening fly-in is the worst sequence of frames a session ever
   * contains: the camera is animating while every tile in the new viewport is
   * being fetched, parsed and uploaded to the GPU. Judging the machine on that
   * is judging a car by how it pulls away with the handbrake on — and it is
   * not hypothetical, it is what the first version of this class did. It
   * demoted straight past buildings and vehicles to a flat map before the
   * dispatcher had touched anything, every single time.
   */
  private armed = false;
  private armTimer = 0;
  private readonly onIdle = () => { this.arm(); };

  private arm() {
    this.armed = true;
    if (this.armTimer) {
      window.clearTimeout(this.armTimer);
      this.armTimer = 0;
    }
  }

  /** Bound once so it can be removed again. */
  private readonly onRender = () => this.sample();

  constructor(map: MapLibreMap, quality: Quality, onChange: (event: GovernorEvent) => void) {
    this.map = map;
    this.quality = quality;
    this.onChange = onChange;
  }

  start() {
    if (this.running) return;
    this.running = true;
    /*
     * Armed by `idle`, or by the clock — whichever comes first.
     *
     * `idle` alone was not enough and the failure was silent. It fires when
     * MapLibre has nothing left to do, and this dashboard gives it something
     * every second: a position tick rebuilds the vehicle source and calls
     * triggerRepaint. On a busy fleet the map may never be idle for as long as
     * it is open, so the governor sat permanently disarmed, measured nothing,
     * and looked exactly like a governor that had decided everything was fine.
     *
     * The timeout is the floor: after five seconds the opening load is over
     * whatever else is happening, and measuring can begin.
     */
    this.map.once('idle', this.onIdle);
    this.armTimer = window.setTimeout(() => this.arm(), 5000);
    this.map.on('render', this.onRender);
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    if (this.armTimer) window.clearTimeout(this.armTimer);
    this.armTimer = 0;
    this.map.off('idle', this.onIdle);
    this.map.off('render', this.onRender);
  }

  /** Called when the tier changes from outside — the 3D button, say. */
  reset(quality: Quality) {
    this.quality = quality;
    this.arm();
    this.samples = [];
    this.goodStreak = 0;
    this.settleUntil = performance.now() + SETTLE_MS;
    this.windowStart = 0;
    this.lastFrameAt = 0;
  }

  private sample() {
    const at = performance.now();
    const previous = this.lastFrameAt;
    this.lastFrameAt = at;
    if (!previous || !this.armed) return;

    /*
     * Frames drawn while tiles are still arriving are counted.
     *
     * The first version discarded them, reasoning that tile parsing costs the
     * same at every tier and would unfairly demote a machine for looking
     * somewhere new. That was wrong in practice for a simple reason: during a
     * continuous drag — the exact interaction that has to be smooth — tiles are
     * ALWAYS loading, so the window never filled and the governor stopped
     * judging after its first decision. Measured: it shed terrain, halved the
     * frame time from 1069 ms to 406 ms, and then sat there at seven frames a
     * second because it had nothing left to sample.
     *
     * A dispatcher does not care why a frame took 400 ms. Counting every
     * moving frame measures what they actually feel, and the median over a
     * window of 24 is robust enough that a single tile upload does not decide
     * anything.
     */

    /*
     * Only frames drawn while the camera is moving count.
     *
     * An idle MapLibre map renders on demand, so the gap between two frames
     * with nobody touching it is however long it happened to sit still —
     * seconds, routinely. Those are not slow frames, they are absent ones, and
     * averaging them in makes every machine look catastrophic.
     */
    if (!this.map.isMoving() && !this.map.isZooming() && !this.map.isRotating()) {
      this.samples.length = 0;
      this.windowStart = 0;
      return;
    }

    if (at < this.settleUntil) return;

    if (!this.windowStart) this.windowStart = previous;
    this.samples.push(at - previous);

    const elapsed = at - this.windowStart;
    const enough =
      (this.samples.length >= MIN_SAMPLES && elapsed >= WINDOW_MS) ||
      this.samples.length >= MAX_SAMPLES;
    if (!enough) return;

    const sorted = [...this.samples].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    this.samples.length = 0;
    this.windowStart = 0;

    if (median > BUDGET_MS && this.quality > Quality.Flat) {
      this.goodStreak = 0;
      this.apply((this.quality - 1) as Quality, median, 'down');
      return;
    }

    if (median < PROMOTE_MS && this.quality < Quality.Terrain) {
      this.goodStreak++;
      if (this.goodStreak >= PROMOTE_STREAK) {
        this.goodStreak = 0;
        this.apply((this.quality + 1) as Quality, median, 'up');
      }
      return;
    }

    this.goodStreak = 0;
  }

  private apply(quality: Quality, medianMs: number, direction: 'down' | 'up') {
    this.quality = quality;
    this.settleUntil = performance.now() + SETTLE_MS;
    this.windowStart = 0;
    saveQuality(quality);
    this.onChange({ quality, medianMs: Math.round(medianMs), direction });
  }
}

/** Turkish, for the notice over the map. */
export const QUALITY_LABEL: Record<Quality, string> = {
  [Quality.Flat]: 'Düz harita',
  [Quality.Vehicles]: '3B araçlar',
  [Quality.Buildings]: '3B araçlar ve binalar',
  [Quality.Terrain]: '3B araçlar, binalar ve arazi',
};

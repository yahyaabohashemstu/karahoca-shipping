'use client';

import dynamic from 'next/dynamic';
import { useEffect, useMemo, useState } from 'react';
import type { FleetPosition } from '@/lib/api';

/* =============================================================================
   A fleet that does not need a database
   =============================================================================
   The 3D map cannot be checked against the real dashboard without a session, a
   driver and a live socket, and none of those exist on a laptop. This route
   feeds FleetMap synthetic vehicles driving real roads so the rendering — the
   models, their heading, the terrain they sit on, the buildings they drive
   between — can be looked at directly.

   It is not a demo and not a fixture for tests. It is the harness that makes a
   visual feature reviewable at all, which on a map is the only review that
   counts: every bug in here is a bug you can only see.

   Deliberately not linked from the navigation. Reachable at /map-preview by
   anyone who knows the path, and it exposes nothing — the positions below are
   arithmetic, not data.
   ========================================================================== */

const FleetMap = dynamic(() => import('@/components/FleetMap'), { ssr: false });

/**
 * The real corridor: Gaziantep to the Habur crossing.
 *
 * Chosen over a straight line or a random scatter because it is the route this
 * system actually watches, and because it climbs — the ground between Şanlıurfa
 * and Cizre rises past 1,200 m, which is the only way to tell whether terrain
 * is loading or whether the DEM proxy is quietly returning nothing.
 */
const CORRIDOR: Array<[number, number]> = [
  [37.3825, 37.0662], // Gaziantep — the plant
  [38.3216, 37.1591],
  [38.7955, 37.1671], // Şanlıurfa
  [39.7793, 37.9144], // Siverek
  [40.2189, 37.9144], // Diyarbakır
  [41.2076, 37.9269], // Batman
  [42.1861, 37.5266], // Cizre
  [42.6167, 37.3500], // Habur
];

const STATES = ['LIVE', 'LIVE', 'LIVE', 'DELAYED', 'PAUSED', 'STALE', 'LOST'] as const;

/** Great-circle bearing, so a truck points where it is actually going. */
function bearing(a: [number, number], b: [number, number]): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const [lon1, lat1] = a.map(toRad) as [number, number];
  const [lon2, lat2] = b.map(toRad) as [number, number];
  const y = Math.sin(lon2 - lon1) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(lon2 - lon1);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/** Position along the corridor at t in [0,1), with the heading it implies. */
function along(t: number): { lon: number; lat: number; bearingDeg: number } {
  const span = CORRIDOR.length - 1;
  const scaled = (t % 1) * span;
  const i = Math.min(Math.floor(scaled), span - 1);
  const f = scaled - i;
  const a = CORRIDOR[i];
  const b = CORRIDOR[i + 1];
  return {
    lon: a[0] + (b[0] - a[0]) * f,
    lat: a[1] + (b[1] - a[1]) * f,
    bearingDeg: bearing(a, b),
  };
}

/**
 * A few streets of Gaziantep, for looking at the models rather than the fleet.
 *
 * FleetMap frames its vehicles once, on first data, capped at zoom 13 — so the
 * spread of the synthetic fleet is what decides the zoom the preview opens at,
 * and there is no need for the component to grow a camera prop it would never
 * use in production. Trucks a kilometre apart put the map at 13-14, which is
 * where the extrusions come out of the ground and the lorries become lorries.
 */
const CITY: Array<[number, number]> = [
  [37.3780, 37.0625],
  [37.3862, 37.0648],
  [37.3901, 37.0702],
  [37.3835, 37.0741],
  [37.3752, 37.0698],
  [37.3712, 37.0644],
];

function cityAt(t: number): { lon: number; lat: number; bearingDeg: number } {
  const span = CITY.length;
  const scaled = (t % 1) * span;
  const i = Math.floor(scaled);
  const f = scaled - i;
  const a = CITY[i % span];
  const b = CITY[(i + 1) % span];
  return {
    lon: a[0] + (b[0] - a[0]) * f,
    lat: a[1] + (b[1] - a[1]) * f,
    bearingDeg: bearing(a, b),
  };
}

export default function MapPreviewPage() {
  const [tick, setTick] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [selected, setSelected] = useState<string | null>(null);
  const [count, setCount] = useState(14);

  /*
   * ?view=city for the close-up.
   *
   * Read once, in an effect, for the same hydration reason the 3D preference
   * is: window.location does not exist while this renders on the server.
   */
  const [closeUp, setCloseUp] = useState(false);
  const [camera, setCamera] = useState<{
    pitch: number; bearing: number; zoom: number; maxPitch: number; terrain: boolean;
  } | null>(null);
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    setCloseUp(q.get('view') === 'city');
    // ?count=0 removes every vehicle while leaving the layer registered, which
    // is the only way to ask whether it is the layer or the drawing that hurts.
    if (q.has('count')) setCount(Math.max(0, Math.min(40, Number(q.get('count')))));
  }, []);

  // Two clocks on purpose: the vehicles move on one, and FleetMap ages its
  // freshness colours on the other, exactly as they do in production.
  useEffect(() => {
    const move = window.setInterval(() => setTick((n) => n + 1), 1000);
    const clock = window.setInterval(() => setNow(Date.now()), 1000);
    return () => {
      window.clearInterval(move);
      window.clearInterval(clock);
    };
  }, []);

  const positions = useMemo<FleetPosition[]>(() => {
    return Array.from({ length: count }, (_, n) => {
      // Spread along the corridor, each at its own speed so the pack spreads
      // out rather than driving in formation.
      const t = ((n / count) + tick * (0.00018 + (n % 5) * 0.00004)) % 1;
      const at = closeUp ? cityAt(((n / count) + tick * 0.004 * (1 + (n % 3) * 0.2)) % 1) : along(t);
      const state = STATES[n % STATES.length];
      // Freshness is derived from the timestamp, so it has to be backdated to
      // produce anything other than LIVE.
      const ageSec = { LIVE: 5, DELAYED: 90, PAUSED: 20, STALE: 700, LOST: 4000 }[state];
      const parked = state === 'PAUSED' || state === 'LOST';

      return {
        sessionId: `preview-${n}`,
        reference: `SVK-${2600 + n}`,
        status: parked ? 'PAUSED' : 'ACTIVE',
        vehiclePlate: `27 ${String.fromCharCode(65 + (n % 26))}${String.fromCharCode(65 + ((n * 7) % 26))} ${100 + n * 13}`,
        driverName: null,
        lat: at.lat,
        lon: at.lon,
        recordedAt: new Date(now - ageSec * 1000).toISOString(),
        secondsSinceFix: ageSec,
        signalState: null,
        speedMps: parked ? 0 : 19 + (n % 4) * 2,
        bearingDeg: at.bearingDeg,
        accuracyM: 8 + (n % 5) * 4,
        destinationLat: 37.35,
        destinationLon: 42.6167,
      } as unknown as FleetPosition;
    });
  }, [tick, now, count, closeUp]);

  return (
    <div className="flex h-screen flex-col">
      <div className="flex items-center gap-4 border-b border-line bg-surface px-4 py-2 text-sm">
        <span className="font-semibold text-ink">3B harita önizleme</span>
        <span className="text-ink-2">
          {closeUp ? 'Gaziantep merkez · yakın plan' : 'Gaziantep → Habur'} · sentetik veri, veritabanı yok
        </span>
        <span className="hidden" id="kh-render-count" data-testid="renders">0</span>
        {camera && (
          <span className="font-mono text-2xs text-ink-2" data-testid="camera">
            pitch {camera.pitch}° / max {camera.maxPitch}° · bearing {camera.bearing}° ·
            zoom {camera.zoom} · arazi {camera.terrain ? 'açık' : 'kapalı'}
          </span>
        )}
        <label className="ml-auto flex items-center gap-2 text-ink-2">
          Araç
          <input
            type="range"
            min={1}
            max={40}
            value={count}
            onChange={(e) => setCount(Number(e.target.value))}
            className="w-32"
          />
          <span className="w-6 tabular-nums text-ink">{count}</span>
        </label>
      </div>
      <div className="min-h-0 flex-1">
        <FleetMap
          onMapReady={(instance) => {
            /*
             * A live camera readout, and the thing that found the bug this
             * harness exists for: the 3D button was lit, buildings and terrain
             * were both rendering, and the map was still perfectly flat. From
             * outside the component there was no way to ask what the pitch
             * actually was, so it looked like the 3D toggle did nothing.
             */
            const publish = () =>
              setCamera({
                pitch: Math.round(instance.getPitch()),
                bearing: Math.round(instance.getBearing()),
                zoom: Number(instance.getZoom().toFixed(2)),
                maxPitch: Math.round(instance.transform.maxPitch),
                terrain: !!instance.getTerrain(),
              });
            publish();
            for (const event of ['move', 'pitch', 'rotate', 'zoom', 'terrain', 'idle'] as const) {
              instance.on(event, publish);
            }

            /*
             * How many frames the MAP has drawn.
             *
             * Not the page's requestAnimationFrame count, which is what the
             * first attempt at a freeze test measured and why it found nothing:
             * the browser keeps servicing rAF at sixty a second whether or not
             * MapLibre is still painting, so a completely dead canvas looks
             * perfectly healthy from outside. MapLibre's own `render` event is
             * the only honest signal that the map is still alive.
             */
            let frames = 0;
            let lastRenderAt = 0;
            /*
             * Inter-frame gaps, worst-first.
             *
             * "Freezing" is not a boolean. A map that draws every 900 ms is
             * alive by any liveness check and unusable to a dispatcher, so
             * counting frames finds nothing — the first harness did exactly
             * that and reported the map healthy while a user was watching it
             * stall. What matters is the distribution of the gap between
             * consecutive renders WHILE THE CAMERA IS MOVING: a smooth map
             * sits near 16 ms, and a stutter is a 300 ms outlier among
             * hundreds of good frames, which an average would hide completely.
             */
            const gaps: number[] = [];
            instance.on('render', () => {
              frames++;
              const at = performance.now();
              if (lastRenderAt) {
                gaps.push(at - lastRenderAt);
                if (gaps.length > 4000) gaps.splice(0, 2000);
              }
              lastRenderAt = at;
              const el = document.getElementById('kh-render-count');
              if (el) el.textContent = String(frames);
            });

            // Read by the frame-time harness over CDP. Deliberately a plain
            // global: it is a measurement tap, not application state.
            (window as unknown as Record<string, unknown>).__khFrames = {
              reset: () => { gaps.length = 0; },
              stats: () => {
                if (gaps.length === 0) return null;
                const sorted = [...gaps].sort((a, b) => a - b);
                const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
                return {
                  frames: sorted.length,
                  p50: Math.round(at(0.5)),
                  p95: Math.round(at(0.95)),
                  worst: Math.round(sorted[sorted.length - 1]),
                  // Frames a person would call a stutter, and ones they would
                  // call a freeze.
                  over100: sorted.filter((g) => g > 100).length,
                  over500: sorted.filter((g) => g > 500).length,
                };
              },
            };

            /*
             * ?zoom= &pitch= &bearing= &lng= &lat= — the camera, on demand.
             *
             * FleetMap frames the fleet once and then the viewport belongs to
             * the user, which is right in production and useless for a review
             * that has to look at the same street from the same angle twice.
             * Applied after a beat so it lands on top of that initial fit
             * rather than being overwritten by it.
             */
            const q = new URLSearchParams(window.location.search);
            const num = (key: string) => (q.has(key) ? Number(q.get(key)) : undefined);

            /*
             * ?terrain=off — the same 3D view minus the elevation.
             *
             * Terrain is the one part of the 3D map that changes how MapLibre
             * renders everything else: with it on, the basemap is drawn to a
             * texture and draped over a mesh instead of straight to the screen.
             * When something disappears, this is the switch that says whether
             * the draping is to blame, and it is not reachable from the 3D
             * toggle because that turns off the vehicles too.
             */
            if (q.get('terrain') === 'off') {
              /*
               * Held off, not switched off once.
               *
               * FleetMap re-enables terrain from its own moveend handler
               * whenever the zoom drops back under the ceiling, so a single
               * setTerrain(null) here only lasts until the first movement —
               * which is precisely the period a measurement run spends moving.
               * The first frame-time comparison taken with this switch was
               * therefore measuring terrain being repeatedly torn down and
               * rebuilt, which is worse than either state.
               */
              const hold = () => { if (instance.getTerrain()) instance.setTerrain(null); };
              hold();
              instance.on('moveend', () => window.setTimeout(hold, 10));
              instance.on('terrain', hold);
            }
            if (['zoom', 'pitch', 'bearing', 'lng', 'lat'].some((k) => q.has(k))) {
              window.setTimeout(() => {
                instance.jumpTo({
                  zoom: num('zoom') ?? instance.getZoom(),
                  pitch: num('pitch') ?? instance.getPitch(),
                  bearing: num('bearing') ?? instance.getBearing(),
                  center: [
                    num('lng') ?? instance.getCenter().lng,
                    num('lat') ?? instance.getCenter().lat,
                  ],
                });
              }, 1200);
            }
          }}
          positions={positions}
          liveUpdates={new Map()}
          selectedId={selected}
          onSelect={setSelected}
          now={now}
        />
      </div>
    </div>
  );
}

'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import maplibregl, { type Map as MapLibreMap } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { FleetPosition } from '@/lib/api';
import type { LivePositionEvent } from '@/lib/useRealtime';
import { displayState, SIGNAL_LABEL, type DisplayState } from '@/lib/signal';
import { mapColors, mapStyleFor } from '@/lib/mapStyle';
import { useTheme } from '@/lib/theme';

/** Gebze — the KaraHoca plant. Sensible default view before any truck loads. */
const HOME: [number, number] = [29.4318, 40.7989];

interface Props {
  positions: FleetPosition[];
  liveUpdates: Map<string, LivePositionEvent>;
  selectedId: string | null;
  onSelect: (sessionId: string) => void;
  /** Shared clock. See lib/signal.ts — freshness must age on a timer, not on data. */
  now: number;
  /** Dims the overlay when the feed is frozen, so staleness is visible peripherally. */
  stale?: boolean;
}

/**
 * The live fleet map.
 *
 * Rendered with MapLibre GL symbol layers driven by a GeoJSON source, not with
 * one DOM Marker per truck. With 40+ vehicles updating every few seconds, DOM
 * markers force a layout pass per update and the tab drops to single-digit
 * frame rates; a GeoJSON source is a single `setData` call and the GPU does the
 * rest. It also gives data-driven styling — colour by signal state, rotation by
 * bearing — for free.
 */
export default function FleetMap({ positions, liveUpdates, selectedId, onSelect, now, stale }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<MapLibreMap | null>(null);
  /*
   * STATE, not a ref. This is the bug that hid every truck.
   *
   * Effects re-run on dependency change, and mutating a ref changes nothing.
   * Setting ready.current in the load handler therefore never re-ran the
   * effect that calls setData, so the GeoJSON sources stayed empty. The theme
   * effect made it permanent: it set the flag false, setStyle discarded every
   * layer, and the reinstall had no way to say "now draw again".
   *
   * SessionMap has always used useState here — which is exactly why the driver
   * showed up on the detail page and nowhere on the main map.
   */
  const [ready, setReady] = useState(false);
  /*
   * Which style URL the map is currently showing.
   *
   * Needed now that  is state and therefore a dependency: without it the
   * sequence load → ready → effect → setStyle → ready:false → effect → … is a
   * loop that reloads the basemap forever. Comparing against the applied URL
   * makes the effect idempotent, so it fires exactly once per genuine theme
   * change and is a no-op every other time.
   *
   * Seeded in the init effect with the style the map was constructed with.
   */
  const appliedStyle = useRef<string | null>(null);

  /** The fleet is framed once per mount; after that the viewport is the user's. */
  const hasFitted = useRef(false);

  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const { resolved, ready: themeReady } = useTheme();

  /*
   * Layer setup is a named function rather than inline in the load handler
   * because `setStyle` — which is how the dark theme switches basemaps —
   * discards every source and layer the application added. They have to be
   * rebuilt on each style load, or switching theme silently empties the map.
   */
  const installLayers = useCallback((instance: MapLibreMap) => {
    if (instance.getSource('trucks')) return;
    const c = mapColors();

    instance.addSource('trucks', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    instance.addSource('destinations', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });

    // Destination pins sit under the trucks so a truck never hides itself.
    instance.addLayer({
      id: 'destination-pins',
      type: 'circle',
      source: 'destinations',
      paint: {
        'circle-radius': 5,
        'circle-color': c.destination,
        'circle-opacity': 0.35,
        'circle-stroke-width': 2,
        'circle-stroke-color': c.destination,
      },
    });

    // Accuracy halo: honest about how sure we are of a position.
    instance.addLayer({
      id: 'truck-accuracy',
      type: 'circle',
      source: 'trucks',
      paint: {
        'circle-radius': [
          'interpolate', ['linear'], ['zoom'],
          8, 4,
          16, ['/', ['coalesce', ['get', 'accuracyM'], 20], 2],
        ],
        'circle-color': ['get', 'colour'],
        'circle-opacity': 0.12,
      },
    });

    instance.addLayer({
      id: 'truck-halo',
      type: 'circle',
      source: 'trucks',
      paint: {
        'circle-radius': ['case', ['get', 'selected'], 18, 13],
        'circle-color': ['get', 'colour'],
        'circle-opacity': ['case', ['get', 'selected'], 0.34, 0.22],
      },
    });

    instance.addLayer({
      id: 'truck-dot',
      type: 'circle',
      source: 'trucks',
      paint: {
        'circle-radius': ['case', ['get', 'selected'], 9, 7],
        'circle-color': ['get', 'colour'],
        'circle-stroke-width': ['case', ['get', 'selected'], 3, 2],
        // The ring is the surface colour, not hard white: a white ring on the
        // dark basemap reads as a second, brighter dot.
        'circle-stroke-color': c.ring,
      },
    });

    // Heading arrow, only when the truck is actually moving — a rotating arrow
    // on a parked vehicle is noise that reads as movement.
    instance.addLayer({
      id: 'truck-heading',
      type: 'symbol',
      source: 'trucks',
      filter: ['>', ['coalesce', ['get', 'speedMps'], 0], 1],
      layout: {
        'text-field': '▲',
        'text-size': 11,
        'text-rotate': ['coalesce', ['get', 'bearingDeg'], 0],
        'text-rotation-alignment': 'map',
        'text-offset': [0, -1.4],
        'text-allow-overlap': true,
        'text-ignore-placement': true,
      },
      paint: { 'text-color': ['get', 'colour'] },
    });

    instance.addLayer({
      id: 'truck-label',
      type: 'symbol',
      source: 'trucks',
      layout: {
        'text-field': ['get', 'label'],
        'text-size': 11,
        'text-offset': [0, 1.6],
        'text-anchor': 'top',
        'text-allow-overlap': false,
      },
      paint: {
        'text-color': c.label,
        'text-halo-color': c.labelHalo,
        'text-halo-width': 1.6,
      },
    });
  }, []);

  // ---- Init -----------------------------------------------------------------
  useEffect(() => {
    /*
     * Wait for the theme before building anything.
     *
     * Child effects run before parent effects, so without this gate the map was
     * always constructed with the provider's provisional 'light' and then had
     * to setStyle the moment the real preference resolved. setStyle discards
     * every source and layer the application added, and re-adding them from a
     * styledata handler races the style load: the source ends up present in
     * JavaScript with no tiles behind it, the layers report visible, and
     * MapLibre paints nothing at all.
     *
     * That is not a theory. queryRenderedFeatures against a camera parked
     * directly on a truck at zoom 12 returned an empty array while the source
     * held two correct features and all five layers reported visible.
     */
    if (!themeReady) return;
    if (map.current || !container.current) return;

    const initialStyle = mapStyleFor(resolved);
    appliedStyle.current = initialStyle;

    const instance = new maplibregl.Map({
      container: container.current,
      style: initialStyle,
      center: HOME,
      zoom: 6.5,
      attributionControl: { compact: true },
      // The dashboard is a 2D operations view; disabling rotation removes an
      // entire class of "the map is sideways and I can't fix it" support calls.
      pitchWithRotate: false,
      dragRotate: false,
    });

    instance.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    instance.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');

    instance.on('load', () => {
      installLayers(instance);
      setReady(true);

      instance.on('click', 'truck-dot', (e) => {
        const id = e.features?.[0]?.properties?.sessionId;
        if (typeof id === 'string') onSelectRef.current(id);
      });
      instance.on('mouseenter', 'truck-dot', () => {
        instance.getCanvas().style.cursor = 'pointer';
      });
      instance.on('mouseleave', 'truck-dot', () => {
        instance.getCanvas().style.cursor = '';
      });
    });

    /*
     * MapLibre measures its container exactly once, at construction, and never
     * recovers if the answer was zero.
     *
     * That is a real hazard here and not a theoretical one: this component is
     * loaded with next/dynamic into a flex column, so there is a frame in which
     * the container exists with height 0 — and a map built in that frame gets a
     * 0×0 canvas, renders nothing at all, and never fires `load`. Observed
     * exactly that while debugging: every ancestor measured 862px while
     * MapLibre's own canvas container sat at 0.
     *
     * The observer costs nothing and removes the whole class of failure.
     */
    const ro = new ResizeObserver(() => instance.resize());
    ro.observe(container.current);

    map.current = instance;
    return () => {
      ro.disconnect();
      instance.remove();
      map.current = null;
      setReady(false);
    };
    // Runs once the theme is known. Later theme changes go through the effect
    // below, which swaps the style in place rather than destroying the map and
    // losing the viewport.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [themeReady]);

  // ---- Theme -----------------------------------------------------------------
  useEffect(() => {
    const instance = map.current;
    if (!instance || !ready) return;
    const wanted = mapStyleFor(resolved);
    if (appliedStyle.current === wanted) return;
    appliedStyle.current = wanted;
    setReady(false);
    instance.setStyle(wanted);
    /*
     * NOT once('styledata'). MapLibre emits styledata several times while a
     * style loads, and the first one arrives before the style is actually in
     * place. Sources added at that moment attach to a transient style and end
     * up with no worker-side tile index: the source holds the features, the
     * layers report visible, and nothing is ever painted.
     *
     * isStyleLoaded() is the only reliable "the swap is complete" signal.
     */
    const onStyle = () => {
      if (!instance.isStyleLoaded()) return;
      instance.off('styledata', onStyle);
      installLayers(instance);
      setReady(true);
    };
    instance.on('styledata', onStyle);
  }, [resolved, ready, installLayers]);

  // ---- Data -----------------------------------------------------------------
  useEffect(() => {
    const instance = map.current;
    if (!instance || !ready) return;

    const c = mapColors();
    const colourFor: Record<DisplayState, string> = {
      LIVE: c.LIVE,
      DELAYED: c.DELAYED,
      STALE: c.STALE,
      LOST: c.LOST,
      NO_SIGNAL: c.NO_SIGNAL,
      PAUSED: c.PAUSED,
    };

    const truckFeatures: GeoJSON.Feature[] = [];
    const destinationFeatures: GeoJSON.Feature[] = [];

    for (const position of positions) {
      // A socket frame is newer than the last HTTP snapshot; prefer it.
      const live = liveUpdates.get(position.sessionId);
      const lat = live?.lat ?? position.lat;
      const lon = live?.lon ?? position.lon;
      if (lat === null || lon === null) continue;

      /*
       * One freshness function, shared with the sidebar badge, the sort order
       * and the header counters — and driven by `now`, which ticks on a timer.
       *
       * Both halves of that matter. The old code recomputed freshness here with
       * its own thresholds while the list trusted the server's field, so the
       * same truck was orange on the map and green in the list. And because the
       * effect only re-ran when `positions` or `liveUpdates` changed identity,
       * a socket outage — the exact moment ageing matters — froze every truck
       * at whatever colour it had when the feed died.
       */
      const { state } = displayState(
        live
          ? {
              status: position.status,
              recordedAt: live.recordedAt,
              secondsSinceFix: null,
              signalState: position.signalState,
            }
          : position,
        now,
      );

      truckFeatures.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [lon, lat] },
        properties: {
          sessionId: position.sessionId,
          label: position.vehiclePlate ?? position.reference,
          colour: colourFor[state] ?? c.NO_SIGNAL,
          selected: position.sessionId === selectedId,
          speedMps: live?.speedMps ?? position.speedMps ?? 0,
          bearingDeg: live?.bearingDeg ?? position.bearingDeg ?? 0,
          accuracyM: live?.accuracyM ?? position.accuracyM ?? 20,
        },
      });

      if (position.destinationLat !== null && position.destinationLon !== null) {
        destinationFeatures.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [position.destinationLon, position.destinationLat] },
          properties: { sessionId: position.sessionId },
        });
      }
    }

    (instance.getSource('trucks') as maplibregl.GeoJSONSource | undefined)?.setData({
      type: 'FeatureCollection',
      features: truckFeatures,
    });
    (instance.getSource('destinations') as maplibregl.GeoJSONSource | undefined)?.setData({
      type: 'FeatureCollection',
      features: destinationFeatures,
    });

    /*
     * Frame the fleet the first time there is one.
     *
     * The map opens on the plant at Gebze, which is the right default with
     * nothing on the road — and completely wrong the moment there is. A truck
     * running to Kilis is 800 km outside that viewport, so the dispatcher's
     * first impression of a working system was an empty map of the Marmara,
     * and finding the vehicle meant panning across Anatolia by hand.
     *
     * Once only, and never while something is selected: after that the viewport
     * belongs to the dispatcher, and a map that keeps yanking itself back is
     * worse than one that never moved.
     */
    if (!hasFitted.current && truckFeatures.length > 0 && !selectedId) {
      hasFitted.current = true;
      fitTo(instance, truckFeatures);
    }
  }, [ready, positions, liveUpdates, selectedId, now, resolved]);

  /** Re-frame every truck on demand. Wired to the button over the map. */
  const fitAll = useCallback(() => {
    const instance = map.current;
    const source = instance?.getSource('trucks') as maplibregl.GeoJSONSource | undefined;
    const data = (source as unknown as { _data?: GeoJSON.FeatureCollection })?._data;
    if (!instance || !data?.features?.length) return;
    fitTo(instance, data.features);
  }, []);

  // ---- Follow the selection --------------------------------------------------
  useEffect(() => {
    const instance = map.current;
    if (!instance || !ready || !selectedId) return;
    const selected = positions.find((p) => p.sessionId === selectedId);
    const live = liveUpdates.get(selectedId);
    const lat = live?.lat ?? selected?.lat;
    const lon = live?.lon ?? selected?.lon;
    if (lat == null || lon == null) return;
    instance.easeTo({ center: [lon, lat], zoom: Math.max(instance.getZoom(), 11), duration: 800 });
    // Intentionally keyed on selectedId only: re-centring on every position
    // frame would fight the dispatcher for control of the map.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  return (
    <div className="relative h-full w-full">
      <div
        ref={container}
        className={`h-full w-full transition-opacity duration-500 ${stale ? 'opacity-55' : ''}`}
      />

      {/* Below the zoom controls, which MapLibre puts at top-right. */}
      <button
        type="button"
        onClick={fitAll}
        title="Tüm araçları haritaya sığdır"
        className="absolute right-2 top-[4.75rem] flex h-8 items-center gap-1.5 rounded-md bg-surface px-2.5 text-sm text-ink-2 shadow-sm ring-1 ring-line transition-colors hover:bg-surface-2 hover:text-ink"
      >
        <svg viewBox="0 0 14 14" className="h-3.5 w-3.5" fill="none" aria-hidden>
          <path
            d="M1.5 4.5v-3h3M12.5 4.5v-3h-3M1.5 9.5v3h3M12.5 9.5v3h-3"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <circle cx="7" cy="7" r="1.6" fill="currentColor" />
        </svg>
        Tümünü göster
      </button>

      <MapLegend />
    </div>
  );
}

/**
 * Fit the camera to every truck.
 *
 * `maxZoom` matters: a single vehicle, or several parked in the same yard,
 * collapses the bounding box to a point and fitBounds happily zooms to 22 —
 * street furniture filling the screen with no context at all.
 */
function fitTo(instance: MapLibreMap, features: GeoJSON.Feature[]) {
  const points = features
    .map((f) => (f.geometry?.type === 'Point' ? (f.geometry.coordinates as [number, number]) : null))
    .filter((c): c is [number, number] => Array.isArray(c));
  if (points.length === 0) return;

  const bounds = points.reduce(
    (acc, c) => acc.extend(c),
    new maplibregl.LngLatBounds(points[0], points[0]),
  );
  instance.fitBounds(bounds, {
    // Right padding clears the selected-truck panel; bottom clears the legend.
    padding: { top: 60, right: 80, bottom: 70, left: 60 },
    maxZoom: 13,
    duration: 700,
  });
}

/**
 * Without this, the colour of a dot is a private convention. With forty trucks
 * on screen and five states, a dispatcher on their first week has no way to
 * learn what graphite means except by asking someone.
 */
function MapLegend() {
  const items: DisplayState[] = ['LIVE', 'DELAYED', 'PAUSED', 'STALE', 'LOST'];
  const dot: Record<DisplayState, string> = {
    LIVE: 'bg-[rgb(var(--kh-map-live))]',
    DELAYED: 'bg-[rgb(var(--kh-map-delayed))]',
    STALE: 'bg-[rgb(var(--kh-map-stale))]',
    LOST: 'bg-[rgb(var(--kh-map-lost))]',
    NO_SIGNAL: 'bg-[rgb(var(--kh-map-nosignal))]',
    PAUSED: 'bg-[rgb(var(--kh-map-paused))]',
  };
  return (
    <div className="pointer-events-none absolute bottom-2 right-2 flex items-center gap-3 rounded-md bg-surface/90 px-2.5 py-1.5 text-2xs text-ink-2 shadow-sm ring-1 ring-line backdrop-blur">
      {items.map((s) => (
        <span key={s} className="flex items-center gap-1.5">
          <span className={`h-2 w-2 rounded-full ${dot[s]}`} aria-hidden />
          {SIGNAL_LABEL[s]}
        </span>
      ))}
    </div>
  );
}

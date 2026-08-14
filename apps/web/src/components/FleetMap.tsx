'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import maplibregl, { type Map as MapLibreMap } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { FleetPosition } from '@/lib/api';
import type { LivePositionEvent } from '@/lib/useRealtime';
import { displayState, SIGNAL_LABEL, type DisplayState } from '@/lib/signal';
import { mapColors, mapStyleFor } from '@/lib/mapStyle';
import { useTheme } from '@/lib/theme';
import { TruckLayer, TRUCK_3D_MIN_ZOOM, type Truck } from '@/lib/truck3d';
import {
  DEFAULT_PITCH,
  installBuildings,
  installSky,
  removeBuildings,
  removeTerrain,
  setDimensional,
  syncTerrain,
} from '@/lib/map3d';

/** Remembered across mounts, so the view a dispatcher chose survives a route change. */
const DIMENSIONAL_KEY = 'kh.map.3d';

function readDimensionalPreference(): boolean {
  if (typeof window === 'undefined') return true;
  const stored = window.localStorage.getItem(DIMENSIONAL_KEY);
  if (stored === '0') return false;
  if (stored === '1') return true;
  // Default on. The 3D view is the one that was asked for; a dispatcher who
  // wants the flat map has a button, and the choice sticks after that.
  return !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

/** '#rrggbb' or 'rgb(r,g,b)' to the 0-255 triple the GPU layer wants. */
function parseColour(value: string): [number, number, number] {
  const rgb = value.match(/rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i);
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  const hex = value.trim().replace('#', '');
  if (hex.length === 6) {
    return [
      parseInt(hex.slice(0, 2), 16),
      parseInt(hex.slice(2, 4), 16),
      parseInt(hex.slice(4, 6), 16),
    ];
  }
  return [136, 136, 136];
}

/** Gebze — the KaraHoca plant. Sensible default view before any truck loads. */
const HOME: [number, number] = [29.4318, 40.7989];

/**
 * A fontstack the current basemap can actually serve.
 *
 * Takes the first `text-font` the loaded style uses for its own labels, which
 * is by definition available from its glyph endpoint. Falls back to Noto Sans,
 * which is what OpenFreeMap serves, and which is a far safer default than
 * MapLibre's built-in Open Sans — see the note in installLayers for what a
 * missing fontstack does to an entire source.
 */
function styleFont(instance: MapLibreMap): string[] {
  try {
    for (const layer of instance.getStyle()?.layers ?? []) {
      const font = (layer as { layout?: { 'text-font'?: unknown } }).layout?.['text-font'];
      if (Array.isArray(font) && font.length > 0 && typeof font[0] === 'string') {
        return font as string[];
      }
    }
  } catch {
    /* style not readable yet — fall through */
  }
  return ['Noto Sans Regular'];
}

interface Props {
  positions: FleetPosition[];
  liveUpdates: Map<string, LivePositionEvent>;
  selectedId: string | null;
  onSelect: (sessionId: string) => void;
  /** Shared clock. See lib/signal.ts — freshness must age on a timer, not on data. */
  now: number;
  /** Dims the overlay when the feed is frozen, so staleness is visible peripherally. */
  stale?: boolean;
  /**
   * Handed the MapLibre instance once it has loaded.
   *
   * The map is otherwise entirely sealed inside this component, which is right
   * for the dashboard and impossible to review: a camera bug on a canvas can
   * only be found by asking the camera where it is. /map-preview uses this to
   * put the live pitch, bearing and zoom on screen.
   */
  onMapReady?: (instance: MapLibreMap) => void;
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
export default function FleetMap({ positions, liveUpdates, selectedId, onSelect, now, stale, onMapReady }: Props) {
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
  const onMapReadyRef = useRef(onMapReady);
  onMapReadyRef.current = onMapReady;
  const { resolved, ready: themeReady } = useTheme();

  /*
   * The 3D vehicle layer.
   *
   * Held in a ref rather than rebuilt, because it owns GPU objects — a shader
   * program, three buffers — and a new one per render would leak them until the
   * context ran out. The instance survives setStyle; only its re-registration
   * with the map has to be redone, which installLayers handles.
   */
  const truckLayer = useRef<TruckLayer | null>(null);
  if (!truckLayer.current && typeof window !== 'undefined') truckLayer.current = new TruckLayer();

  const [dimensional, setDimensionalState] = useState(true);
  /*
   * The zoom handler is registered once, in the load callback, so it cannot
   * read `dimensional` directly — it would close over the value from the first
   * render and keep re-enabling terrain after the dispatcher switched 3D off.
   */
  const dimensionalRef = useRef(true);
  dimensionalRef.current = dimensional;
  /*
   * Read from storage in an effect, not in useState's initialiser.
   *
   * localStorage does not exist while Next renders this on the server, and a
   * value read on the client that differs from the server's would be a
   * hydration mismatch — React would discard the whole subtree, which here
   * means destroying and rebuilding the map on first paint.
   */
  useEffect(() => setDimensionalState(readDimensionalPreference()), []);

  /**
   * Whether the camera is below the zoom at which vehicle models draw.
   *
   * A boolean rather than the zoom itself, deliberately. The only consumer is
   * the hint over the map, and holding the number here meant a React render on
   * every frame of every zoom — see the note on the zoom handler below.
   */
  const [belowModelZoom, setBelowModelZoom] = useState(true);

  /**
   * Last heading each vehicle was seen moving on.
   *
   * The server reports bearing 0 for a stationary fix, because a parked lorry
   * has no direction of travel. That is correct as data and wrong as a picture:
   * a yard of trucks all snapping to due north the moment their engines stop is
   * both false and the most conspicuous thing on the screen. A flat dot could
   * hide it — the heading arrow is filtered on speed — but a solid model cannot,
   * it has to point somewhere.
   */
  const lastHeading = useRef(new Map<string, number>());

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

    /*
     * The flat marker, and its hand-over to the 3D model.
     *
     * Both exist because neither works everywhere. At country zoom forty
     * perspective lorries is a mess and a 7 px dot is exactly right; at street
     * zoom the dot is a lie about a 16 m vehicle and the model is right. So the
     * dot shrinks to nothing across the two zoom levels either side of
     * TRUCK_3D_MIN_ZOOM, which is where the model starts drawing, and the two
     * cross over rather than either popping.
     *
     * The halo and accuracy circles underneath are NOT faded. They sit on the
     * ground plane, so under a pitched camera they read as a pool of light the
     * truck is standing in — which is both the selection cue and the only thing
     * that keeps a vehicle findable behind a building.
     */
    const dotFade = (near: number, far: number) => [
      'interpolate', ['linear'], ['zoom'],
      TRUCK_3D_MIN_ZOOM, near,
      TRUCK_3D_MIN_ZOOM + 1.5, far,
    ];

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
        'circle-opacity': dotFade(1, 0) as unknown as number,
        'circle-stroke-opacity': dotFade(1, 0) as unknown as number,
      },
    });

    /*
     * The vehicles themselves, above the flat layers and below the labels.
     *
     * Added last of the truck layers so the plate label, added after it, still
     * draws on top — a 3D model that covers its own registration number is
     * worse than no model.
     */
    if (truckLayer.current && !instance.getLayer(truckLayer.current.id)) {
      instance.addLayer(truckLayer.current);
    }

    /*
     * text-font IS MANDATORY HERE, and leaving it out is what hid every truck.
     *
     * Omit it and MapLibre falls back to its built-in default,
     * ["Open Sans Regular", "Arial Unicode MS Regular"]. OpenFreeMap serves
     * exactly one fontstack — Noto Sans Regular — so the glyph request 404s.
     *
     * The consequence is far worse than missing text. A failed glyph fetch
     * fails the whole TILE PARSE for that source, so nothing on the source
     * renders: not the labels, not the heading arrows, and not the circle
     * layers either. The source reports loaded, the layers report visible,
     * setData succeeds, and querySourceFeatures returns zero.
     *
     * Measured: a working GeoJSON source rendering two features dropped to an
     * empty tile index the instant a font-less symbol layer was added to it.
     *
     * The font is read from the style rather than hard-coded, so pointing
     * NEXT_PUBLIC_MAP_STYLE at a different tile server cannot silently
     * reintroduce this.
     */
    const font = styleFont(instance);

    // Heading arrow, only when the truck is actually moving — a rotating arrow
    // on a parked vehicle is noise that reads as movement.
    instance.addLayer({
      id: 'truck-heading',
      type: 'symbol',
      source: 'trucks',
      filter: ['>', ['coalesce', ['get', 'speedMps'], 0], 1],
      layout: {
        'text-field': '▲',
        'text-font': font,
        'text-size': 11,
        'text-rotate': ['coalesce', ['get', 'bearingDeg'], 0],
        'text-rotation-alignment': 'map',
        'text-offset': [0, -1.4],
        'text-allow-overlap': true,
        'text-ignore-placement': true,
      },
      paint: {
        'text-color': ['get', 'colour'],
        // Fades out with the dot. Once the model is drawing, the vehicle's own
        // orientation is the heading indicator, and a second arrow floating
        // above the cab is a duplicate that reads as a separate object.
        'text-opacity': dotFade(1, 0) as unknown as number,
      },
    });

    instance.addLayer({
      id: 'truck-label',
      type: 'symbol',
      source: 'trucks',
      layout: {
        'text-field': ['get', 'label'],
        'text-font': font,
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
      /*
       * The default attribution control is disabled here and re-added at
       * bottom-LEFT below.
       *
       * MapLibre puts it bottom-right, which is also where the status legend
       * and the selected-vehicle panel live. Measured on production: the
       * legend covered the attribution by 298 × 21 px with nothing selected,
       * and the panel covered all 24 px of its height on top of that. The
       * OpenFreeMap / OpenMapTiles / OpenStreetMap credit was never visible on
       * this screen, which is a licence term and not a cosmetic detail.
       *
       * Moving it — rather than nudging the panel up by a magic number — is
       * what makes it stay fixed: the right edge is application UI whose
       * height changes with content, the left edge holds map furniture. The
       * scale control is already there and MapLibre stacks same-corner
       * controls in a column, so the two coexist without arithmetic.
       *
       * `compact` is left unset on purpose. MapLibre then collapses it to an
       * ⓘ button below 640 px of map width and shows it in full above that,
       * which is the behaviour we want; passing compact:true here did not even
       * achieve it, as the measurement showed.
       */
      attributionControl: false,
      /*
       * Rotation starts disabled and `setDimensional` turns it on with the 3D
       * view. The original reasoning for disabling it — a dispatcher who
       * rotates the map by accident and cannot find north again is a support
       * call — is still true, so the compass below is the way back, and the
       * flat view keeps the old behaviour exactly.
       */
      pitchWithRotate: true,
      dragRotate: false,
      maxPitch: 0,
      /*
       * Multisampling, which MapLibre leaves off by default.
       *
       * Off, every edge on the extruded buildings and every edge on a truck is
       * a hard staircase, and a truck is 26 px of mostly-diagonal edges. This
       * is the single largest visual difference in the whole 3D view and it
       * costs one framebuffer.
       */
      antialias: true,
    });

    instance.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
    instance.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');
    instance.addControl(new maplibregl.AttributionControl(), 'bottom-left');

    /*
     * The OpenFreeMap style references sprite images its own sprite sheet does
     * not contain — `circle-11` and `wood-pattern` were both observed on the
     * console. MapLibre re-reports each miss as the tiles that need them load,
     * so the log fills with warnings about a third-party basemap we do not
     * control, and any real warning is buried underneath.
     *
     * Answering with a transparent 1×1 satisfies the lookup and caches it, so
     * each name is resolved once. Nothing visible changes: these are basemap
     * decorations that were already not rendering.
     */
    instance.on('styleimagemissing', (e) => {
      if (instance.hasImage(e.id)) return;
      instance.addImage(e.id, { width: 1, height: 1, data: new Uint8Array(4) });
    });

    instance.on('load', () => {
      installLayers(instance);
      setReady(true);

      /*
       * Terrain heights arrive long after the trucks are placed.
       *
       * DEM tiles are the slowest thing on the page, so a vehicle positioned
       * during the first paint sits at elevation zero — which for a lorry in
       * the pass above Cizre is 1,300 m underground, and it renders as a truck
       * buried in a mountain. Both events matter: `terrain` fires when the
       * terrain is enabled or swapped, `idle` fires once the tiles for the
       * current viewport have actually landed.
       */
      const relift = () => truckLayer.current?.refreshElevation();
      instance.on('terrain', relift);
      /*
       * `sourcedata`, filtered, rather than `idle`.
       *
       * idle is the obvious choice and it is wrong twice over: it fires after
       * every paint, including the paint that refreshing elevation causes, and
       * it fires for tile loads that have nothing to do with the DEM. The
       * filter below narrows it to "a terrain tile finished", which is the only
       * event that can change a truck's height, and refreshElevation itself
       * refuses to repaint when nothing moved.
       */
      /*
       * Throttled, because a pan over the mountains loads DEM tiles in a
       * stream and each one fires this. refreshElevation re-queries the
       * terrain height of every vehicle and allocates a copy of the instance
       * buffer to compare against, so at one call per tile it is real work in
       * the middle of the one interaction that has to stay smooth. Heights
       * settle within a second of the movement stopping; nothing needs them
       * sooner than that.
       */
      let liftPending = 0;
      instance.on('sourcedata', (e) => {
        if (e.sourceId !== 'kh-terrain' || !e.isSourceLoaded) return;
        if (liftPending) return;
        liftPending = window.setTimeout(() => {
          liftPending = 0;
          if (map.current === instance) relift();
        }, 400);
      });

      /*
       * Zoom reactions, and why neither of them runs on the `zoom` event.
       *
       * MapLibre emits `zoom` from inside its render pass, once per frame for
       * the whole of a zoom animation. Two things were hung off it and both
       * were wrong:
       *
       *   syncTerrain calls addSource and setTerrain. Doing that re-entrantly,
       *   while the map is part-way through drawing the frame that emitted the
       *   event, is how a render loop dies: the exception leaves MapLibre's
       *   requestAnimationFrame chain broken, and from then on the canvas is
       *   frozen while the rest of the page carries on working normally. Which
       *   is exactly what a dispatcher reported — the map stopped after two or
       *   three movements, the sidebar kept responding.
       *
       *   setZoom() is a React state update, so it re-rendered this component
       *   sixty times a second for the length of every zoom.
       *
       * So: terrain waits for the movement to finish, and is deferred out of
       * the event with a timeout so it can never run inside a render. And the
       * zoom the UI needs is a threshold, not a number, so it changes twice a
       * session instead of once a frame.
       */
      instance.on('zoom', () => {
        const below = instance.getZoom() < TRUCK_3D_MIN_ZOOM;
        setBelowModelZoom((current) => (current === below ? current : below));
      });

      instance.on('moveend', () => {
        window.setTimeout(() => {
          if (map.current !== instance) return;
          syncTerrain(instance, dimensionalRef.current);
        }, 0);
      });

      onMapReadyRef.current?.(instance);

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

  // ---- The third dimension ---------------------------------------------------
  /*
   * Everything that makes the map dimensional, applied together.
   *
   * Keyed on `ready` as well as on the toggle, so it re-runs after a theme
   * change: setStyle discards the sky and the extrusion layer along with
   * everything else the application added, and a dark map with a daylight
   * horizon is worse than no sky at all. Terrain survives setStyle — it lives
   * on the map rather than the style — which is why it is guarded rather than
   * reinstalled unconditionally.
   */
  useEffect(() => {
    const instance = map.current;
    if (!instance || !ready) return;

    if (truckLayer.current) truckLayer.current.enabled = dimensional;

    // The flat markers hold the map on their own when the model is off.
    const fade = dimensional
      ? (['interpolate', ['linear'], ['zoom'], TRUCK_3D_MIN_ZOOM, 1, TRUCK_3D_MIN_ZOOM + 1.5, 0] as unknown as number)
      : (1 as unknown as number);
    for (const [layer, property] of [
      ['truck-dot', 'circle-opacity'],
      ['truck-dot', 'circle-stroke-opacity'],
      ['truck-heading', 'text-opacity'],
    ] as const) {
      if (instance.getLayer(layer)) instance.setPaintProperty(layer, property, fade);
    }

    if (dimensional) {
      installSky(instance, resolved);
      installBuildings(instance, resolved);
      syncTerrain(instance, true);
    } else {
      removeBuildings(instance);
      // Terrain is torn down and not merely hidden: a DEM source left attached
      // keeps fetching tiles for a viewport nobody is looking at in 3D.
      removeTerrain(instance);
    }

    setDimensional(instance, dimensional);
    instance.triggerRepaint();
  }, [dimensional, ready, resolved]);

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
    const models: Truck[] = [];
    /*
     * One parse per state, not one per vehicle.
     *
     * mapColors() returns CSS strings read off the theme's custom properties,
     * and the GPU layer needs numeric triples. With forty trucks updating every
     * two seconds, parsing the same six colour strings forty times a tick is
     * pure waste — and the strings only change when the theme does, which is
     * already a dependency of this effect.
     */
    const rgbCache = new Map<string, [number, number, number]>();
    const rgbFor = (css: string) => {
      let parsed = rgbCache.get(css);
      if (!parsed) {
        parsed = parseColour(css);
        rgbCache.set(css, parsed);
      }
      return parsed;
    };

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

      const colour = colourFor[state] ?? c.NO_SIGNAL;
      const reportedBearing = live?.bearingDeg ?? position.bearingDeg ?? 0;
      const speedMps = live?.speedMps ?? position.speedMps ?? 0;
      const selected = position.sessionId === selectedId;

      // 1 m/s is the same threshold the heading arrow is filtered on, so the
      // arrow and the model can never disagree about which way a truck faces.
      if (speedMps > 1) lastHeading.current.set(position.sessionId, reportedBearing);
      const bearingDeg = speedMps > 1
        ? reportedBearing
        : lastHeading.current.get(position.sessionId) ?? reportedBearing;

      truckFeatures.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [lon, lat] },
        properties: {
          sessionId: position.sessionId,
          label: position.vehiclePlate ?? position.reference,
          colour,
          selected,
          speedMps,
          bearingDeg,
          accuracyM: live?.accuracyM ?? position.accuracyM ?? 20,
        },
      });

      models.push({
        id: position.sessionId,
        lng: lon,
        lat,
        /*
         * A parked lorry keeps its last heading rather than snapping to north.
         *
         * The server sends bearing 0 for a stationary fix because there is no
         * direction of travel to report, and a yard full of trucks all pointing
         * due north is both wrong and conspicuous. Zero from a moving vehicle is
         * genuinely north, which is why the speed is what decides.
         */
        bearingDeg,
        colour: rgbFor(colour),
        selected,
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

    truckLayer.current?.setTrucks(models);

    /*
     * Forget vehicles that have left the fleet.
     *
     * Without this, `lastHeading` accumulates one entry per session for as long
     * as the dashboard is open — which is a shift, and on a busy week is
     * thousands of finished shipments. Small, but it is a leak, and the map is
     * the one component in this app that stays mounted for eight hours.
     */
    if (lastHeading.current.size > models.length * 2 + 32) {
      const live = new Set(models.map((m) => m.id));
      for (const id of lastHeading.current.keys()) {
        if (!live.has(id)) lastHeading.current.delete(id);
      }
    }

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
      fitTo(instance, truckFeatures, dimensional ? DEFAULT_PITCH : 0);
    }
  }, [ready, positions, liveUpdates, selectedId, now, resolved, dimensional]);

  /** Re-frame every truck on demand. Wired to the button over the map. */
  const fitAll = useCallback(() => {
    const instance = map.current;
    const source = instance?.getSource('trucks') as maplibregl.GeoJSONSource | undefined;
    const data = (source as unknown as { _data?: GeoJSON.FeatureCollection })?._data;
    if (!instance || !data?.features?.length) return;
    // Re-framing must not flatten a dispatcher's tilted view either.
    fitTo(instance, data.features, instance.getPitch());
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

      {/*
        The dimension switch, directly under MapLibre's own controls.

        Labelled with the mode it will switch TO, which is the convention the
        rest of this dashboard uses and the one that does not require a
        dispatcher to work out whether a highlighted "3D" means it is on or
        that pressing it turns it on.
      */}
      <button
        type="button"
        onClick={() => {
          const next = !dimensional;
          setDimensionalState(next);
          window.localStorage.setItem(DIMENSIONAL_KEY, next ? '1' : '0');
        }}
        title={
          dimensional
            ? 'Düz haritaya geç'
            : 'Üç boyutlu görünüme geç — araçlar, binalar ve arazi'
        }
        aria-pressed={dimensional}
        className={`absolute right-2 top-[7.75rem] flex h-8 items-center gap-1.5 rounded-md px-2.5 text-sm shadow-sm ring-1 transition-colors ${
          dimensional
            ? 'bg-accent text-white ring-accent'
            : 'bg-surface text-ink-2 ring-line hover:bg-surface-2 hover:text-ink'
        }`}
      >
        <svg viewBox="0 0 14 14" className="h-3.5 w-3.5" fill="none" aria-hidden>
          <path
            d="M7 1.2 12.4 4v6L7 12.8 1.6 10V4L7 1.2Z"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinejoin="round"
          />
          <path d="M7 6.4 12.4 4M7 6.4 1.6 4M7 6.4v6.4" stroke="currentColor" strokeWidth="1.1" />
        </svg>
        3B
      </button>

      {/*
        Why the trucks are still dots.

        The single most likely support question about this feature, answered
        before it is asked. Shown only in the band where a dispatcher has turned
        3D on, can see it is on, and is looking at flat markers — which is every
        zoom below the threshold, and is correct behaviour rather than a fault.
      */}
      {dimensional && belowModelZoom && (
        <div className="pointer-events-none absolute left-1/2 top-3 -translate-x-1/2 rounded-md bg-surface/90 px-2.5 py-1 text-2xs text-ink-2 shadow-sm ring-1 ring-line backdrop-blur">
          Araç modelleri için yakınlaştırın
        </div>
      )}

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
function fitTo(instance: MapLibreMap, features: GeoJSON.Feature[], pitch?: number) {
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
    /*
     * Pitch is passed explicitly, and that is a bug fix rather than a detail.
     *
     * Both this and the 3D effect issue a camera animation on the render where
     * the map becomes ready, and the second one wins. fitBounds does not carry
     * pitch, so it inherited whatever the tilt happened to be a few
     * milliseconds into the other animation — which is nearly zero — and the
     * map settled flat with the 3D button lit. Seen exactly that, in a
     * screenshot, before this argument existed.
     */
    pitch,
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
    // right-3 to share an edge with the selected-vehicle panel, which sits
    // directly above this and is measured against its height.
    <div className="pointer-events-none absolute bottom-3 right-3 flex items-center gap-3 rounded-md bg-surface/90 px-2.5 py-1.5 text-2xs text-ink-2 shadow-sm ring-1 ring-line backdrop-blur">
      {items.map((s) => (
        <span key={s} className="flex items-center gap-1.5">
          <span className={`h-2 w-2 rounded-full ${dot[s]}`} aria-hidden />
          {SIGNAL_LABEL[s]}
        </span>
      ))}
    </div>
  );
}

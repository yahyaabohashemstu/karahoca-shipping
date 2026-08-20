'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import maplibregl, { type Map as MapLibreMap } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { mapColors, mapStyleFor } from '@/lib/mapStyle';
import { useTheme } from '@/lib/theme';
import type { BackfillEvent, LivePositionEvent } from '@/lib/useRealtime';

/*
 * Extracted from the session detail page so it can be dynamically imported.
 *
 * MapLibre is ~215 kB of the bundle. Imported statically it landed in the
 * route's first-load JS and made /sessions/[id] 353 kB against 143 kB for
 * every other screen — a quarter of a megabyte parsed before a dispatcher can
 * read a plate number, on a page they open from a phone call.
 */

interface Props {
  /**
   * Pixels of each edge hidden behind floating chrome. Physical left/right,
   * because a camera has never heard of inline-start.
   */
  inset?: { top: number; right: number; bottom: number; left: number };
  route: (GeoJSON.FeatureCollection & { pointCount: number; renderedPointCount: number }) | undefined;
  backfills: BackfillEvent[];
  live: LivePositionEvent | null;
  fallbackLat: number | null | undefined;
  fallbackLon: number | null | undefined;
}

export default function SessionMap({
  route,
  backfills,
  live,
  fallbackLat,
  fallbackLon,
  inset,
}: Props) {
  /*
   * Read through a ref by the framing effect, which must not re-run — and so
   * re-frame the camera — merely because the dispatcher collapsed the panel.
   */
  const insetRef = useRef(inset);
  insetRef.current = inset;
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<MapLibreMap | null>(null);
  const [ready, setReady] = useState(false);
  const fitted = useRef(false);
  const { resolved, ready: themeReady } = useTheme();

  const installLayers = useCallback((instance: MapLibreMap) => {
    // Guarded per item, matching FleetMap — see the note there for why one
    // surviving source is not proof that everything else survived with it.
    const addSource = (id: string, spec: maplibregl.SourceSpecification) => {
      if (!instance.getSource(id)) addSource(id, spec);
    };
    const addLayer = (spec: maplibregl.LayerSpecification) => {
      if (!instance.getLayer(spec.id)) addLayer(spec);
    };
    const c = mapColors();

    addSource('route', { type: 'geojson', data: empty() });
    addSource('backfill', { type: 'geojson', data: empty() });
    addSource('current', { type: 'geojson', data: empty() });

    addLayer({
      id: 'route-line',
      type: 'line',
      source: 'route',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': c.route, 'line-width': 4, 'line-opacity': 0.9 },
    });

    // Backfilled geometry is dashed and amber so a dispatcher can see at a
    // glance which part of the route arrived late out of a dead zone.
    addLayer({
      id: 'backfill-line',
      type: 'line',
      source: 'backfill',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': c.DELAYED, 'line-width': 4, 'line-dasharray': [2, 1] },
    });

    addLayer({
      id: 'current-dot',
      type: 'circle',
      source: 'current',
      paint: {
        'circle-radius': 8,
        'circle-color': c.LIVE,
        'circle-stroke-width': 3,
        'circle-stroke-color': c.ring,
      },
    });
  }, []);

  useEffect(() => {
    // Same gate as FleetMap: building the map before the theme is known forces
    // a setStyle that discards every source and layer. See lib/theme.tsx.
    if (!themeReady) return;
    if (map.current || !container.current) return;
    const instance = new maplibregl.Map({
      container: container.current,
      style: mapStyleFor(resolved),
      center: [29.43, 40.8],
      zoom: 6,
      dragRotate: false,
      pitchWithRotate: false,
      // Disabled here and re-added below on the side nothing floats over.
      attributionControl: false,
    });
    /*
     * Every control on the inline-START edge, because the facts panel occupies
     * the whole inline-end edge of this screen.
     *
     * MapLibre names four physical corners and offers no direction-aware
     * placement, so the corner is chosen here instead. Left alone it put the
     * zoom control at top-right and the attribution at bottom-right — directly
     * underneath a 23rem panel, which hid the zoom entirely and covered the
     * OpenFreeMap credit. The credit is a licence term.
     *
     * Reading the document's dir once, at construction, is safe: changing the
     * language reloads the page (see I18nProvider), so this component is never
     * alive across a direction flip.
     */
    const start =
      typeof document !== 'undefined' && document.documentElement.dir === 'rtl' ? 'right' : 'left';
    instance.addControl(new maplibregl.NavigationControl({ showCompass: false }), `top-${start}`);
    instance.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), `bottom-${start}`);
    instance.addControl(new maplibregl.AttributionControl(), `bottom-${start}`);
    // Same third-party sprite gaps as FleetMap; see the comment there.
    instance.on('styleimagemissing', (e) => {
      if (instance.hasImage(e.id)) return;
      instance.addImage(e.id, { width: 1, height: 1, data: new Uint8Array(4) });
    });
    instance.on('load', () => {
      installLayers(instance);
      setReady(true);
    });
    // MapLibre measures its container once, at construction, and never recovers
    // from a zero. See the same guard in FleetMap.
    const ro = new ResizeObserver(() => instance.resize());
    ro.observe(container.current);

    map.current = instance;
    return () => {
      ro.disconnect();
      instance.remove();
      map.current = null;
      setReady(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [themeReady]);

  // setStyle discards application sources and layers; rebuild them.
  useEffect(() => {
    const instance = map.current;
    if (!instance || !ready) return;
    setReady(false);
    instance.setStyle(mapStyleFor(resolved));
    /*
     * See FleetMap for the full account. In short: setStyle with a URL fetches
     * before it swaps, so until the response lands map.style is still the old
     * style and isStyleLoaded() answers true about that one. A styledata fired
     * in that window ran this handler against the style on its way out, and the
     * route and the driver marker went with it when the real one arrived.
     *
     * style.load fires from Style._load, once, for the style actually installed.
     */
    instance.once('style.load', () => {
      installLayers(instance);
      setReady(true);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolved]);

  useEffect(() => {
    if (!ready || !route?.features?.length) return;
    const instance = map.current;
    // Self-heal — see the note in FleetMap. A style swap that finishes without
    // the layers being reinstalled leaves ready true, the route gone and no
    // pending event that would ever bring it back.
    if (instance && !instance.getSource('route')) installLayers(instance);
    const src = instance?.getSource('route') as maplibregl.GeoJSONSource | undefined;
    src?.setData(route);

    const geom = route.features[0]?.geometry;
    // The previous version asserted LineString and read .coordinates off
    // whatever came back. A MultiLineString, or a Point from a session with a
    // single fix, threw — and with no error boundary anywhere that blanked the
    // whole page.
    if (!geom || geom.type !== 'LineString') return;
    const coords = geom.coordinates;
    if (coords.length < 2) return;

    // Fit once. Refitting on every refetch yanks the viewport out from under a
    // dispatcher who has zoomed in on a junction.
    if (fitted.current) return;
    const bounds = coords.reduce(
      (acc, c) => acc.extend(c as [number, number]),
      new maplibregl.LngLatBounds(coords[0] as [number, number], coords[0] as [number, number]),
    );
    /*
     * Padded by what is actually covering the map, not by one number.
     *
     * The facts panel floats over the route rather than sitting beside it, so a
     * symmetric 60px pad framed the journey underneath it — on a Gaziantep to
     * Kirkuk run the destination end of the line landed behind the panel every
     * time the page loaded.
     */
    if (!instance) return;
    /*
     * Clamped to what the container can hold, for the reason spelled out on
     * FleetMap's safePadding: MapLibre answers padding it cannot honour by
     * doing nothing at all, and the panel floating over this map asks for a
     * third of the width.
     */
    const pad = insetRef.current ?? { top: 0, right: 0, bottom: 0, left: 0 };
    const { width, height } = instance.getCanvas().getBoundingClientRect();
    const clamp = (near: number, far: number, extent: number): [number, number] => {
      const budget = extent * 0.45;
      const asked = near + far;
      if (extent <= 0 || asked <= budget) return [near, far];
      const factor = budget / asked;
      return [near * factor, far * factor];
    };
    const [left, right] = clamp(24 + pad.left, 24 + pad.right, width);
    const [top, bottom] = clamp(24 + pad.top, 24 + pad.bottom, height);

    instance.fitBounds(bounds, {
      padding: { top, right, bottom, left },
      /*
       * A ceiling, which this call has never had — and it is the whole bug.
       *
       * A session created minutes ago is a handful of fixes in one yard, so the
       * bounding box is a few metres across. MapLibre answers a degenerate box
       * with maximum zoom, which here is 22: a screen of bare ground, no town,
       * no road, and at that zoom no basemap tiles for most of this corridor
       * either. The lorry is on it and nobody can tell, so the natural thing to
       * do is zoom out looking for it — and from zoom 22 you arrive somewhere
       * around 7, where a fifty-metre route and a nine-pixel dot are lost in
       * the labels. That is exactly the report: invisible on the dispatcher's
       * map, correct on the customer's link.
       *
       * The customer's link is correct because it already knows this. Its map
       * opens at a fixed zoom 8 on the lorry and only fits when there is a
       * second thing to fit to, capped at 11 — see the comment beside
       * `if (extended)` in apps/api/src/share/share.controller.ts, which
       * describes this failure in as many words. FleetMap has carried a maxZoom
       * since it was written. This was the one map of the three that never got
       * one.
       *
       * 13, the same as FleetMap, so a yard, a town and the road out of it are
       * all on screen whatever the route turns out to be.
       */
      maxZoom: 13,
      duration: 600,
    });
    fitted.current = true;
  }, [ready, route]);

  useEffect(() => {
    if (!ready) return;
    const src = map.current?.getSource('backfill') as maplibregl.GeoJSONSource | undefined;
    src?.setData({
      type: 'FeatureCollection',
      features: backfills
        .filter((b) => b.points.length > 1)
        .map((b) => ({
          type: 'Feature' as const,
          properties: { batchId: b.batchId },
          geometry: {
            type: 'LineString' as const,
            coordinates: b.points.map(([lon, lat]) => [lon, lat]),
          },
        })),
    });
  }, [ready, backfills]);

  useEffect(() => {
    if (!ready) return;
    const lat = live?.lat ?? fallbackLat;
    const lon = live?.lon ?? fallbackLon;
    if (lat == null || lon == null) return;
    const src = map.current?.getSource('current') as maplibregl.GeoJSONSource | undefined;
    src?.setData({
      type: 'FeatureCollection',
      features: [{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [lon, lat] } }],
    });
  }, [ready, live, fallbackLat, fallbackLon]);

  return <div ref={container} className="h-full w-full" />;
}

function empty(): GeoJSON.FeatureCollection {
  return { type: 'FeatureCollection', features: [] };
}

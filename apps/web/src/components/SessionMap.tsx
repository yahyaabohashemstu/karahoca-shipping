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
  route: (GeoJSON.FeatureCollection & { pointCount: number; renderedPointCount: number }) | undefined;
  backfills: BackfillEvent[];
  live: LivePositionEvent | null;
  fallbackLat: number | null | undefined;
  fallbackLon: number | null | undefined;
}

export default function SessionMap({ route, backfills, live, fallbackLat, fallbackLon }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<MapLibreMap | null>(null);
  const [ready, setReady] = useState(false);
  const fitted = useRef(false);
  const { resolved, ready: themeReady } = useTheme();

  const installLayers = useCallback((instance: MapLibreMap) => {
    if (instance.getSource('route')) return;
    const c = mapColors();

    instance.addSource('route', { type: 'geojson', data: empty() });
    instance.addSource('backfill', { type: 'geojson', data: empty() });
    instance.addSource('current', { type: 'geojson', data: empty() });

    instance.addLayer({
      id: 'route-line',
      type: 'line',
      source: 'route',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': c.route, 'line-width': 4, 'line-opacity': 0.9 },
    });

    // Backfilled geometry is dashed and amber so a dispatcher can see at a
    // glance which part of the route arrived late out of a dead zone.
    instance.addLayer({
      id: 'backfill-line',
      type: 'line',
      source: 'backfill',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': c.DELAYED, 'line-width': 4, 'line-dasharray': [2, 1] },
    });

    instance.addLayer({
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
    });
    instance.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    instance.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');
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
    // See FleetMap: styledata fires repeatedly and the first one is too early.
    const onStyle = () => {
      if (!instance.isStyleLoaded()) return;
      instance.off('styledata', onStyle);
      installLayers(instance);
      setReady(true);
    };
    instance.on('styledata', onStyle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolved]);

  useEffect(() => {
    if (!ready || !route?.features?.length) return;
    const src = map.current?.getSource('route') as maplibregl.GeoJSONSource | undefined;
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
    map.current?.fitBounds(bounds, { padding: 60, duration: 600 });
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

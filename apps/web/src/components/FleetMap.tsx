'use client';

import { useEffect, useRef } from 'react';
import maplibregl, { type Map as MapLibreMap } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { FleetPosition } from '@/lib/api';
import type { LivePositionEvent } from '@/lib/useRealtime';

const MAP_STYLE =
  process.env.NEXT_PUBLIC_MAP_STYLE ?? 'https://tiles.openfreemap.org/styles/liberty';

/** Gebze — the KaraHoca plant. Sensible default view before any truck loads. */
const HOME: [number, number] = [29.4318, 40.7989];

const SIGNAL_COLOURS: Record<string, string> = {
  LIVE: '#16a34a',
  DELAYED: '#f59e0b',
  STALE: '#f97316',
  LOST: '#dc2626',
  NO_SIGNAL: '#64748b',
};

interface Props {
  positions: FleetPosition[];
  liveUpdates: Map<string, LivePositionEvent>;
  selectedId: string | null;
  onSelect: (sessionId: string) => void;
}

/**
 * The live fleet map.
 *
 * Rendered with MapLibre GL **symbol layers driven by a GeoJSON source**, not
 * with one DOM Marker per truck. With 40+ vehicles updating every few seconds,
 * DOM markers force a layout pass per update and the tab drops to single-digit
 * frame rates; a GeoJSON source is a single `setData` call and the GPU does the
 * rest. It also gives us data-driven styling (colour by signal state, rotation
 * by bearing) for free.
 */
export default function FleetMap({ positions, liveUpdates, selectedId, onSelect }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<MapLibreMap | null>(null);
  const ready = useRef(false);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  // ---- Init -----------------------------------------------------------------
  useEffect(() => {
    if (map.current || !container.current) return;

    const instance = new maplibregl.Map({
      container: container.current,
      style: MAP_STYLE,
      center: HOME,
      zoom: 6.5,
      attributionControl: { compact: true },
    });

    instance.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    instance.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');

    instance.on('load', () => {
      instance.addSource('trucks', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });

      instance.addSource('destinations', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });

      // Destination pins sit under the trucks so a truck never hides itself.
      instance.addLayer({
        id: 'destination-pins',
        type: 'circle',
        source: 'destinations',
        paint: {
          'circle-radius': 5,
          'circle-color': '#0ea5e9',
          'circle-opacity': 0.45,
          'circle-stroke-width': 2,
          'circle-stroke-color': '#0ea5e9',
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
          'circle-opacity': 0.25,
        },
      });

      instance.addLayer({
        id: 'truck-dot',
        type: 'circle',
        source: 'trucks',
        paint: {
          'circle-radius': ['case', ['get', 'selected'], 9, 7],
          'circle-color': ['get', 'colour'],
          'circle-stroke-width': 2,
          'circle-stroke-color': '#ffffff',
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
          'text-color': '#0f172a',
          'text-halo-color': '#ffffff',
          'text-halo-width': 1.5,
        },
      });

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

      ready.current = true;
    });

    map.current = instance;
    return () => {
      instance.remove();
      map.current = null;
      ready.current = false;
    };
  }, []);

  // ---- Data -----------------------------------------------------------------
  useEffect(() => {
    const instance = map.current;
    if (!instance || !ready.current) return;

    const truckFeatures: GeoJSON.Feature[] = [];
    const destinationFeatures: GeoJSON.Feature[] = [];

    for (const position of positions) {
      // A socket frame is newer than the last HTTP snapshot; prefer it.
      const live = liveUpdates.get(position.sessionId);
      const lat = live?.lat ?? position.lat;
      const lon = live?.lon ?? position.lon;
      if (lat === null || lon === null) continue;

      const secondsSinceFix = live
        ? Math.round((Date.now() - new Date(live.recordedAt).getTime()) / 1000)
        : (position.secondsSinceFix ?? 99999);

      // Recompute freshness client-side so a truck visibly ages between
      // snapshots instead of staying green until the next poll.
      const signal =
        secondsSinceFix < 90 ? 'LIVE'
        : secondsSinceFix < 600 ? 'DELAYED'
        : secondsSinceFix < 7200 ? 'STALE'
        : 'LOST';

      truckFeatures.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [lon, lat] },
        properties: {
          sessionId: position.sessionId,
          label: position.vehiclePlate ?? position.reference,
          colour: SIGNAL_COLOURS[signal],
          selected: position.sessionId === selectedId,
          speedMps: live?.speedMps ?? position.speedMps ?? 0,
          bearingDeg: live?.bearingDeg ?? position.bearingDeg ?? 0,
          accuracyM: live?.accuracyM ?? position.accuracyM ?? 20,
        },
      });

      if (position.destinationLat !== null && position.destinationLon !== null) {
        destinationFeatures.push({
          type: 'Feature',
          geometry: {
            type: 'Point',
            coordinates: [position.destinationLon, position.destinationLat],
          },
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
  }, [positions, liveUpdates, selectedId]);

  // ---- Follow the selection --------------------------------------------------
  useEffect(() => {
    const instance = map.current;
    if (!instance || !ready.current || !selectedId) return;
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

  return <div ref={container} className="h-full w-full" />;
}

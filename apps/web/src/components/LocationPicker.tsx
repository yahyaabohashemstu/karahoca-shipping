'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import maplibregl, { type Map as MapLibreMap, type Marker } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { API_BASE } from '@/lib/api';
import { mapColors, mapStyleFor } from '@/lib/mapStyle';
import { useTheme } from '@/lib/theme';
import { Input } from '@/components/ui/Form';

/* =============================================================================
   Choosing a place, without leaving the application
   =============================================================================
   Production, measured before this was written: 4 orders, 1 with a destination.
   Three shipments in four cannot compute distance remaining, cannot raise an
   ARRIVED alert, and cannot show the consignee the one number they opened the
   page for.

   The old form asked for the coordinate as raw text and warned, in a yellow
   box, exactly what was lost by leaving it blank. The warning was true, it was
   read, and it did not work — because supplying the number meant opening
   another map in another tab, finding a warehouse in Erbil, right-clicking,
   copying two decimals, and coming back. That is a five-step errand per order,
   and a warning does not reduce its cost.

   This reduces the cost instead. Type a name, or click the map. The pin can be
   dragged. The arrival radius is drawn as a circle so its size is a thing you
   see rather than a number you guess.
   ========================================================================== */

export interface PickedLocation {
  lat: number;
  lon: number;
  /** Whatever the place was called when it was chosen. Free text after that. */
  label: string | null;
  radiusM: number;
}

interface Place {
  label: string;
  lat: number;
  lon: number;
  kind: string | null;
}

interface Props {
  value: PickedLocation | null;
  onChange: (value: PickedLocation | null) => void;
  /** Opening view when nothing is chosen yet. Defaults to the Gaziantep plant. */
  home?: [number, number];
  /** Rendered under the map — what is lost by leaving this empty. */
  emptyHint?: string;
}

const PLANT: [number, number] = [37.3825, 37.0662];
const DEFAULT_RADIUS = 300;

/** Metres, matching the CHECK on both the customer and order columns. */
const MIN_RADIUS = 50;
const MAX_RADIUS = 50_000;

export function LocationPicker({ value, onChange, home = PLANT, emptyHint }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<MapLibreMap | null>(null);
  const marker = useRef<Marker | null>(null);
  const [ready, setReady] = useState(false);
  const { resolved, ready: themeReady } = useTheme();

  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Place[]>([]);
  const [searching, setSearching] = useState(false);
  const [radiusText, setRadiusText] = useState(String(value?.radiusM ?? DEFAULT_RADIUS));

  /*
   * The callback the map's own handlers see.
   *
   * The map is built once, so a handler registered inside it closes over the
   * first render's props for ever. Every click would then report against a
   * stale radius, which is invisible until someone changes the radius and then
   * moves the pin and watches the radius revert.
   */
  const latest = useRef({ value, onChange, radiusText });
  latest.current = { value, onChange, radiusText };

  const parsedRadius = (() => {
    const n = Number(radiusText);
    if (!Number.isFinite(n)) return null;
    const rounded = Math.round(n);
    return rounded >= MIN_RADIUS && rounded <= MAX_RADIUS ? rounded : null;
  })();

  /** Place the pin and the radius ring, creating them if needed. */
  const place = useCallback((instance: MapLibreMap, lat: number, lon: number, radiusM: number) => {
    const c = mapColors();

    if (!marker.current) {
      const el = document.createElement('div');
      el.style.cssText =
        'width:18px;height:18px;border-radius:9999px;cursor:grab;' +
        `background:${c.destination};box-shadow:0 0 0 3px rgba(255,255,255,.9),0 1px 4px rgba(0,0,0,.35)`;
      marker.current = new maplibregl.Marker({ element: el, draggable: true })
        .setLngLat([lon, lat])
        .addTo(instance);
      marker.current.on('dragend', () => {
        const p = marker.current!.getLngLat();
        commit(p.lat, p.lng, null);
      });
    } else {
      marker.current.setLngLat([lon, lat]);
    }

    /*
     * The radius as a circle on the ground, not a number in a box.
     *
     * A `circle` layer would be wrong: its radius is in screen pixels, so the
     * ring would stay the same size as the map zoomed and would be a picture of
     * nothing. This is a real polygon in real metres, which means it grows as
     * you zoom in — and a dispatcher can see at a glance that 300 m around a
     * city depot covers three neighbouring yards.
     */
    const ring = circlePolygon(lat, lon, radiusM);
    const source = instance.getSource('picker-radius') as maplibregl.GeoJSONSource | undefined;
    if (source) {
      source.setData(ring);
    } else {
      instance.addSource('picker-radius', { type: 'geojson', data: ring });
      instance.addLayer({
        id: 'picker-radius-fill',
        type: 'fill',
        source: 'picker-radius',
        paint: { 'fill-color': c.destination, 'fill-opacity': 0.14 },
      });
      instance.addLayer({
        id: 'picker-radius-line',
        type: 'line',
        source: 'picker-radius',
        paint: { 'line-color': c.destination, 'line-width': 1.5, 'line-opacity': 0.7 },
      });
    }
  }, []);

  /** One place where a new coordinate becomes state, so nothing can skip a step. */
  const commit = useCallback(async (lat: number, lon: number, label: string | null) => {
    const { radiusText: text, onChange: emit } = latest.current;
    const n = Math.round(Number(text));
    const radiusM = Number.isFinite(n) && n >= MIN_RADIUS && n <= MAX_RADIUS ? n : DEFAULT_RADIUS;
    emit({ lat, lon, label, radiusM });

    // A pin dropped by hand has no name. Ask for one, but never block on it:
    // the coordinate is already correct and the label is a convenience.
    if (label === null) {
      try {
        const res = await fetch(`${API_BASE}/geocode/reverse?lat=${lat}&lon=${lon}`);
        if (!res.ok) return;
        const body = (await res.json()) as { label: string | null };
        if (body.label) {
          const current = latest.current.value;
          // Only if the pin has not moved again while we were asking.
          if (current && current.lat === lat && current.lon === lon) {
            latest.current.onChange({ ...current, label: body.label });
          }
        }
      } catch {
        /* the pin stands on its own */
      }
    }
  }, []);

  // ---- map -----------------------------------------------------------------
  useEffect(() => {
    if (!themeReady || map.current || !container.current) return;

    const instance = new maplibregl.Map({
      container: container.current,
      style: mapStyleFor(resolved),
      center: value ? [value.lon, value.lat] : home,
      zoom: value ? 13 : 5.5,
      attributionControl: false,
      dragRotate: false,
      pitchWithRotate: false,
      maxPitch: 0,
    });
    instance.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    instance.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');

    // Same reason as the fleet map: the OpenFreeMap style references sprites its
    // own sheet does not contain, and each miss is re-reported per tile.
    instance.on('styleimagemissing', (e) => {
      if (!instance.hasImage(e.id)) {
        instance.addImage(e.id, { width: 1, height: 1, data: new Uint8Array(4) });
      }
    });

    instance.on('click', (e) => {
      commit(e.lngLat.lat, e.lngLat.lng, null);
    });
    instance.getCanvas().style.cursor = 'crosshair';

    instance.on('load', () => setReady(true));

    // A dialog animates open, so the container has no height for the first few
    // frames — and MapLibre measures once and never recovers from zero.
    const ro = new ResizeObserver(() => instance.resize());
    ro.observe(container.current);

    map.current = instance;
    return () => {
      ro.disconnect();
      marker.current = null;
      instance.remove();
      map.current = null;
      setReady(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [themeReady]);

  /** Reflect the chosen value onto the map. */
  useEffect(() => {
    const instance = map.current;
    if (!instance || !ready) return;
    if (!value) {
      marker.current?.remove();
      marker.current = null;
      const source = instance.getSource('picker-radius') as maplibregl.GeoJSONSource | undefined;
      source?.setData({ type: 'FeatureCollection', features: [] });
      return;
    }
    place(instance, value.lat, value.lon, value.radiusM);
  }, [value, ready, place]);

  // ---- search --------------------------------------------------------------
  /*
   * Debounced, because Nominatim's usage policy is one request a second and the
   * proxy enforces it with a queue. Firing per keystroke would not break the
   * policy — the queue would hold the line — but it would make every result
   * arrive seconds after the letters that asked for it.
   */
  useEffect(() => {
    const q = query.trim();
    if (q.length < 3) {
      setResults([]);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const timer = window.setTimeout(async () => {
      try {
        const res = await fetch(`${API_BASE}/geocode/search?q=${encodeURIComponent(q)}`);
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as { places: Place[] };
        if (!cancelled) setResults(body.places ?? []);
      } catch {
        if (!cancelled) setResults([]);
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 450);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      setSearching(false);
    };
  }, [query]);

  const choose = (p: Place) => {
    setQuery('');
    setResults([]);
    commit(p.lat, p.lon, p.label);
    map.current?.easeTo({ center: [p.lon, p.lat], zoom: 14, duration: 600 });
  };

  // ---- radius --------------------------------------------------------------
  useEffect(() => {
    if (!value || parsedRadius === null || parsedRadius === value.radiusM) return;
    onChange({ ...value, radiusM: parsedRadius });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parsedRadius]);

  return (
    <div className="space-y-3">
      <div className="relative">
        <Input
          label="Yer ara"
          value={query}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setQuery(e.target.value)}
          placeholder="Erbil sanayi, Habur, Bab al-Hawa…"
          hint="Adı yazın ve seçin, ya da doğrudan haritaya tıklayın."
          autoComplete="off"
        />
        {(results.length > 0 || searching) && (
          <ul className="absolute z-20 mt-1 max-h-56 w-full overflow-auto rounded-md bg-surface shadow-lg ring-1 ring-line">
            {searching && results.length === 0 && (
              <li className="px-3 py-2 text-sm text-ink-2">Aranıyor…</li>
            )}
            {results.map((p) => (
              <li key={`${p.lat},${p.lon}`}>
                <button
                  type="button"
                  onClick={() => choose(p)}
                  className="block w-full px-3 py-2 text-start text-sm text-ink hover:bg-surface-2"
                >
                  {/* The Arabic name first — these are places in Iraq and Syria
                      and the person choosing recognises the Arabic, not the
                      transliteration. `dir=auto` per item so a Turkish result
                      in the same list still reads left to right. */}
                  <span dir="auto" className="line-clamp-2">{p.label}</span>
                  {p.kind && <span className="ms-1 text-2xs text-ink-2">· {p.kind}</span>}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div
        ref={container}
        className="h-64 w-full overflow-hidden rounded-md ring-1 ring-line"
      />

      {value ? (
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-2xs uppercase tracking-wide text-ink-2">Seçilen nokta</p>
            <p dir="auto" className="truncate text-sm text-ink">{value.label ?? 'Haritadan seçildi'}</p>
            <p className="font-mono text-2xs text-ink-2">
              {value.lat.toFixed(5)}, {value.lon.toFixed(5)}
            </p>
          </div>
          <div className="w-32">
            <Input
              label="Varış yarıçapı"
              type="text"
              inputMode="numeric"
              numeric
              value={radiusText}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setRadiusText(e.target.value.replace(/[^\d]/g, ''))}
              error={
                parsedRadius === null && radiusText !== ''
                  ? `${MIN_RADIUS}–${MAX_RADIUS} m`
                  : undefined
              }
            />
          </div>
          <button
            type="button"
            onClick={() => onChange(null)}
            className="h-9 rounded-md px-3 text-sm text-ink-2 ring-1 ring-line transition-colors hover:bg-surface-2 hover:text-ink"
          >
            Kaldır
          </button>
        </div>
      ) : (
        emptyHint && (
          <p className="rounded bg-warn-bg px-3 py-2 text-sm text-warn ring-1 ring-inset ring-delayed-ring/35">
            {emptyHint}
          </p>
        )
      )}
    </div>
  );
}

/**
 * A circle on the earth, as a polygon.
 *
 * 64 segments: at 50 m the chord error is under a centimetre and at 50 km it is
 * a few metres, both far below anything a dispatcher is judging by eye. The
 * longitude term divides by cos(lat) because a degree of longitude is shorter
 * the further from the equator you are — omit it and the ring is an ellipse
 * squashed by 20% at Gaziantep's latitude, which reads as a bug in the map.
 */
function circlePolygon(lat: number, lon: number, radiusM: number): GeoJSON.FeatureCollection {
  const segments = 64;
  const latDelta = radiusM / 111_320;
  const lonDelta = radiusM / (111_320 * Math.cos((lat * Math.PI) / 180));
  const ring: [number, number][] = [];
  for (let i = 0; i <= segments; i++) {
    const angle = (i / segments) * Math.PI * 2;
    ring.push([lon + lonDelta * Math.cos(angle), lat + latDelta * Math.sin(angle)]);
  }
  return {
    type: 'FeatureCollection',
    features: [{ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [ring] } }],
  };
}

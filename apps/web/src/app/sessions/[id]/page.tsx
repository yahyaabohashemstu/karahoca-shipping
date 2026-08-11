'use client';

import { use, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import maplibregl, { type Map as MapLibreMap } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { api } from '@/lib/api';
import { useSessionStream } from '@/lib/useRealtime';

const MAP_STYLE =
  process.env.NEXT_PUBLIC_MAP_STYLE ?? 'https://tiles.openfreemap.org/styles/liberty';

/**
 * Session detail: live position, full route, coverage gaps, and the audit trail.
 *
 * The gap list is the page's most useful feature in practice. When a carrier
 * says "the app stopped working", this shows exactly when telemetry stopped,
 * where the truck was, and how far it moved while dark — which converts an
 * argument into a fact.
 */
export default function SessionDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const queryClient = useQueryClient();
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<MapLibreMap | null>(null);
  const [mapReady, setMapReady] = useState(false);

  const { live, backfills, events, status, connected, needsRefetch } = useSessionStream(id);

  const { data: session } = useQuery({
    queryKey: ['session', id],
    queryFn: () => api.session(id),
    refetchInterval: 30_000,
  });

  const { data: route } = useQuery({
    queryKey: ['route', id, needsRefetch],
    queryFn: () => api.route(id, { toleranceM: 8 }),
  });

  const { data: gaps } = useQuery({
    queryKey: ['gaps', id],
    queryFn: () => api.gaps(id, 120),
  });

  // A server-side state change (completed, expired) invalidates the detail read.
  useEffect(() => {
    if (status) queryClient.invalidateQueries({ queryKey: ['session', id] });
  }, [status, id, queryClient]);

  // ---- Map init -------------------------------------------------------------
  useEffect(() => {
    if (map.current || !container.current) return;
    const instance = new maplibregl.Map({
      container: container.current,
      style: MAP_STYLE,
      center: [29.43, 40.8],
      zoom: 6,
    });
    instance.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    instance.on('load', () => {
      instance.addSource('route', { type: 'geojson', data: emptyCollection() });
      instance.addSource('backfill', { type: 'geojson', data: emptyCollection() });
      instance.addSource('current', { type: 'geojson', data: emptyCollection() });

      instance.addLayer({
        id: 'route-line',
        type: 'line',
        source: 'route',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#2563eb', 'line-width': 4, 'line-opacity': 0.85 },
      });

      // Backfilled geometry is drawn in a distinct colour so a dispatcher can
      // see at a glance which part of the route came in late from a dead zone.
      instance.addLayer({
        id: 'backfill-line',
        type: 'line',
        source: 'backfill',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#f59e0b', 'line-width': 4, 'line-dasharray': [2, 1] },
      });

      instance.addLayer({
        id: 'current-dot',
        type: 'circle',
        source: 'current',
        paint: {
          'circle-radius': 8,
          'circle-color': '#16a34a',
          'circle-stroke-width': 3,
          'circle-stroke-color': '#ffffff',
        },
      });

      setMapReady(true);
    });
    map.current = instance;
    return () => {
      instance.remove();
      map.current = null;
    };
  }, []);

  // ---- Route geometry --------------------------------------------------------
  useEffect(() => {
    if (!mapReady || !route?.features?.length) return;
    const source = map.current?.getSource('route') as maplibregl.GeoJSONSource | undefined;
    source?.setData(route as GeoJSON.FeatureCollection);

    const coordinates = (route.features[0]?.geometry as GeoJSON.LineString)?.coordinates ?? [];
    if (coordinates.length > 1) {
      const bounds = coordinates.reduce(
        (acc, c) => acc.extend(c as [number, number]),
        new maplibregl.LngLatBounds(
          coordinates[0] as [number, number],
          coordinates[0] as [number, number],
        ),
      );
      map.current?.fitBounds(bounds, { padding: 60, duration: 600 });
    }
  }, [mapReady, route]);

  // ---- Late-arriving segments ------------------------------------------------
  useEffect(() => {
    if (!mapReady || backfills.length === 0) return;
    const source = map.current?.getSource('backfill') as maplibregl.GeoJSONSource | undefined;
    source?.setData({
      type: 'FeatureCollection',
      features: backfills
        .filter((b) => b.points.length > 1)
        .map((b) => ({
          type: 'Feature',
          properties: { batchId: b.batchId },
          geometry: {
            type: 'LineString',
            coordinates: b.points.map(([lon, lat]) => [lon, lat]),
          },
        })),
    });
  }, [mapReady, backfills]);

  // ---- Live marker ------------------------------------------------------------
  useEffect(() => {
    if (!mapReady) return;
    const lat = live?.lat ?? session?.lat;
    const lon = live?.lon ?? session?.lon;
    if (lat == null || lon == null) return;
    const source = map.current?.getSource('current') as maplibregl.GeoJSONSource | undefined;
    source?.setData({
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [lon, lat] } },
      ],
    });
  }, [mapReady, live, session]);

  async function act(action: 'pause' | 'resume' | 'complete' | 'cancel') {
    await api.sessionAction(id, action);
    queryClient.invalidateQueries({ queryKey: ['session', id] });
  }

  return (
    <div className="flex h-screen flex-col">
      <header className="flex items-center justify-between border-b border-slate-200 bg-white px-6 py-3">
        <div className="flex items-center gap-4">
          <Link href="/" className="text-sm text-blue-700 hover:underline">
            ← Canlı harita
          </Link>
          <span className="font-semibold">{session?.reference ?? id.slice(0, 8)}</span>
          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs">
            {status ?? session?.status}
          </span>
          <span className={`h-2 w-2 rounded-full ${connected ? 'bg-green-500' : 'bg-slate-300'}`} />
        </div>
        <div className="flex gap-2">
          <button onClick={() => act('pause')} className="rounded border px-3 py-1.5 text-sm hover:bg-slate-50">
            Duraklat
          </button>
          <button onClick={() => act('resume')} className="rounded border px-3 py-1.5 text-sm hover:bg-slate-50">
            Devam
          </button>
          <button
            onClick={() => act('complete')}
            className="rounded bg-green-600 px-3 py-1.5 text-sm text-white hover:bg-green-700"
          >
            Teslim edildi
          </button>
          <a
            href={`${process.env.NEXT_PUBLIC_API_URL}/tracking/sessions/${id}/export.ndjson`}
            className="rounded border px-3 py-1.5 text-sm hover:bg-slate-50"
          >
            Ham veri
          </a>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <div ref={container} className="min-w-0 flex-1" />

        <aside className="kh-scroll w-96 shrink-0 overflow-y-auto border-l border-slate-200 bg-white p-4">
          {session?.handoff && (
            <section className="mb-6 rounded-lg border-2 border-dashed border-blue-300 bg-blue-50 p-4 text-center">
              <p className="text-xs font-medium uppercase tracking-wide text-blue-800">
                Sürücüye verilecek kod
              </p>
              <p className="my-2 font-mono text-3xl font-bold tracking-widest">
                {session.handoff.prettyCode}
              </p>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={session.handoff.qrDataUrl}
                alt="Oturum QR kodu"
                className="mx-auto h-40 w-40"
              />
              <button
                onClick={async () => {
                  await api.regenerateCode(id);
                  queryClient.invalidateQueries({ queryKey: ['session', id] });
                }}
                className="mt-3 text-xs text-blue-700 hover:underline"
              >
                Yeni kod üret (mevcut cihazı iptal eder)
              </button>
            </section>
          )}

          <Section title="Sevkiyat">
            <Row label="Sipariş" value={session?.orderNumber ?? '—'} />
            <Row label="Müşteri" value={session?.customerName ?? '—'} />
            <Row label="Nakliyeci" value={session?.carrierName ?? '—'} />
            <Row label="Araç" value={session?.vehiclePlate ?? '—'} />
            <Row label="Sürücü" value={session?.driverName ?? '—'} />
            <Row label="Telefon" value={session?.driverPhone ?? '—'} />
          </Section>

          <Section title="Telemetri">
            <Row label="Toplam nokta" value={String(session?.pointsTotal ?? 0)} />
            <Row label="Mesafe" value={`${session?.distanceKm ?? 0} km`} />
            <Row
              label="Çevrimdışı senkron"
              value={String(session?.offlineBatches ?? 0)}
            />
            <Row label="Reddedilen nokta" value={String(session?.pointsRejected ?? 0)} />
            <Row
              label="Rota noktası"
              value={
                route
                  ? `${route.renderedPointCount} / ${route.pointCount} (sadeleştirilmiş)`
                  : '—'
              }
            />
            {(session?.mockLocationCount ?? 0) > 0 && (
              <Row
                label="⚠ Sahte konum"
                value={String(session?.mockLocationCount)}
                danger
              />
            )}
          </Section>

          {session?.device && (
            <Section title="Cihaz">
              <Row
                label="Model"
                value={`${session.device.manufacturer ?? ''} ${session.device.model ?? ''}`.trim() || '—'}
              />
              <Row label="Android" value={String(session.device.os_version ?? '—')} />
              <Row
                label="Pil optimizasyonu"
                value={session.device.battery_optimisation_ignored ? 'Muaf ✓' : 'AÇIK ⚠'}
                danger={!session.device.battery_optimisation_ignored}
              />
              <Row
                label="Arka plan konumu"
                value={session.device.has_background_location ? 'Var ✓' : 'YOK ⚠'}
                danger={!session.device.has_background_location}
              />
            </Section>
          )}

          {gaps && gaps.length > 0 && (
            <Section title={`Kapsama boşlukları (${gaps.length})`}>
              {gaps.slice(0, 10).map((gap) => (
                <div key={gap.from} className="mb-2 rounded bg-amber-50 p-2 text-xs">
                  <div className="font-medium">
                    {Math.round(gap.durationSec / 60)} dakika sinyalsiz
                  </div>
                  <div className="text-slate-500">
                    {new Date(gap.from).toLocaleTimeString('tr-TR')} →{' '}
                    {new Date(gap.to).toLocaleTimeString('tr-TR')} ·{' '}
                    {Math.round(gap.straightLineM / 1000)} km yol
                  </div>
                </div>
              ))}
            </Section>
          )}

          <Section title="Olay geçmişi">
            {[...events, ...(session?.events ?? []).map((e) => ({
              type: e.type,
              message: e.message,
              at: e.occurred_at,
            }))]
              .slice(0, 40)
              .map((event, index) => (
                <div key={`${event.at}-${index}`} className="mb-2 text-xs">
                  <span className="font-mono text-slate-400">
                    {new Date(event.at).toLocaleTimeString('tr-TR')}
                  </span>{' '}
                  <span className="font-medium">{event.type}</span>
                  {event.message && <div className="text-slate-500">{event.message}</div>}
                </div>
              ))}
          </Section>
        </aside>
      </div>
    </div>
  );
}

function emptyCollection(): GeoJSON.FeatureCollection {
  return { type: 'FeatureCollection', features: [] };
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-6">
      <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">{title}</h2>
      {children}
    </section>
  );
}

function Row({ label, value, danger }: { label: string; value: string; danger?: boolean }) {
  return (
    <div className="flex justify-between gap-4 py-0.5 text-sm">
      <span className="text-slate-500">{label}</span>
      <span className={`text-right font-medium ${danger ? 'text-red-600' : ''}`}>{value}</span>
    </div>
  );
}

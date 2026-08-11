'use client';

import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, tokens, type FleetPosition } from '@/lib/api';
import { useFleetStream } from '@/lib/useRealtime';

// MapLibre touches `window` at import time — must not be server-rendered.
const FleetMap = dynamic(() => import('@/components/FleetMap'), {
  ssr: false,
  loading: () => <div className="flex h-full items-center justify-center text-slate-400">Harita yükleniyor…</div>,
});

const SIGNAL_LABEL: Record<string, string> = {
  LIVE: 'Canlı',
  DELAYED: 'Gecikmeli',
  STALE: 'Eski',
  LOST: 'Sinyal yok',
  NO_SIGNAL: 'Başlamadı',
};

const SIGNAL_CLASS: Record<string, string> = {
  LIVE: 'bg-green-100 text-green-800',
  DELAYED: 'bg-amber-100 text-amber-800',
  STALE: 'bg-orange-100 text-orange-800',
  LOST: 'bg-red-100 text-red-800',
  NO_SIGNAL: 'bg-slate-100 text-slate-600',
};

export default function LiveDashboard() {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<FleetPosition[]>([]);
  const [authed, setAuthed] = useState<boolean | null>(null);

  useEffect(() => {
    setAuthed(Boolean(tokens.access));
    if (!tokens.access) window.location.href = '/login';
  }, []);

  const onSnapshot = useCallback((positions: FleetPosition[]) => setSnapshot(positions), []);
  const { connected, positions: liveUpdates } = useFleetStream(onSnapshot);

  const { data, isLoading } = useQuery({
    queryKey: ['live-fleet'],
    queryFn: api.liveFleet,
    enabled: authed === true,
  });

  const { data: stats } = useQuery({
    queryKey: ['stats'],
    queryFn: api.stats,
    enabled: authed === true,
    refetchInterval: 60_000,
  });

  // Socket snapshots win when present; the HTTP query is the cold-start path
  // and the fallback if the WebSocket cannot connect at all.
  const fleet = snapshot.length > 0 ? snapshot : (data?.positions ?? []);

  const sorted = useMemo(
    () =>
      [...fleet].sort((a, b) => {
        const rank = { LIVE: 0, DELAYED: 1, STALE: 2, LOST: 3, NO_SIGNAL: 4 } as const;
        return (rank[a.signalState] ?? 5) - (rank[b.signalState] ?? 5);
      }),
    [fleet],
  );

  const silent = fleet.filter((f) => f.signalState === 'LOST' || f.signalState === 'STALE').length;

  if (authed === null) return null;

  return (
    <div className="flex h-screen flex-col">
      <header className="flex items-center justify-between border-b border-slate-200 bg-white px-6 py-3">
        <div className="flex items-baseline gap-4">
          <span className="text-sm font-extrabold tracking-[0.2em] text-blue-700">KARAHOCA</span>
          <span className="text-sm text-slate-500">Sevkiyat Takip Merkezi</span>
        </div>

        <div className="flex items-center gap-6 text-sm">
          <Stat label="Yolda" value={stats?.activeSessions ?? fleet.length} />
          <Stat label="Kod bekliyor" value={stats?.awaitingClaim ?? 0} />
          <Stat label="Sessiz" value={silent} tone={silent > 0 ? 'warn' : 'ok'} />
          <span className="flex items-center gap-2">
            <span
              className={`h-2 w-2 rounded-full ${connected ? 'bg-green-500 kh-pulse' : 'bg-red-500'}`}
            />
            <span className="text-xs text-slate-500">{connected ? 'Bağlı' : 'Bağlantı yok'}</span>
          </span>
          <Link href="/sessions" className="text-blue-700 hover:underline">
            Oturumlar
          </Link>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <aside className="kh-scroll w-96 shrink-0 overflow-y-auto border-r border-slate-200 bg-white">
          {isLoading && sorted.length === 0 && (
            <p className="p-6 text-sm text-slate-400">Yükleniyor…</p>
          )}
          {!isLoading && sorted.length === 0 && (
            <p className="p-6 text-sm text-slate-400">Şu anda yolda araç yok.</p>
          )}
          {sorted.map((session) => {
            const live = liveUpdates.get(session.sessionId);
            const speedKmh = Math.round(((live?.speedMps ?? session.speedMps) ?? 0) * 3.6);
            return (
              <button
                key={session.sessionId}
                onClick={() => setSelectedId(session.sessionId)}
                className={`block w-full border-b border-slate-100 px-4 py-3 text-left transition hover:bg-slate-50 ${
                  selectedId === session.sessionId ? 'bg-blue-50' : ''
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="font-semibold">
                    {session.vehiclePlate ?? session.reference}
                  </span>
                  <span
                    className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
                      SIGNAL_CLASS[session.signalState]
                    }`}
                  >
                    {SIGNAL_LABEL[session.signalState]}
                  </span>
                </div>
                <div className="mt-1 text-xs text-slate-500">
                  {session.orderNumber} · {session.customerName}
                </div>
                <div className="mt-1 flex gap-3 text-xs text-slate-400">
                  <span>{speedKmh} km/s</span>
                  {session.remainingKm !== null && <span>{session.remainingKm} km kaldı</span>}
                  {session.batteryPct !== null && (
                    <span className={session.batteryPct < 20 ? 'text-red-600' : ''}>
                      🔋 {session.batteryPct}%
                    </span>
                  )}
                  {session.mockLocationCount > 0 && (
                    <span className="text-red-600" title="Sahte konum tespit edildi">
                      ⚠ sahte GPS
                    </span>
                  )}
                </div>
              </button>
            );
          })}
        </aside>

        <main className="relative min-w-0 flex-1">
          <FleetMap
            positions={fleet}
            liveUpdates={liveUpdates}
            selectedId={selectedId}
            onSelect={setSelectedId}
          />
          {selectedId && (
            <div className="absolute bottom-4 right-4 w-80 rounded-lg border border-slate-200 bg-white p-4 shadow-lg">
              <SelectedPanel
                session={fleet.find((f) => f.sessionId === selectedId)}
                onClose={() => setSelectedId(null)}
              />
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: 'ok' | 'warn' }) {
  return (
    <span className="flex flex-col items-end leading-tight">
      <span
        className={`text-lg font-semibold ${
          tone === 'warn' ? 'text-amber-600' : 'text-slate-900'
        }`}
      >
        {value}
      </span>
      <span className="text-[11px] uppercase tracking-wide text-slate-400">{label}</span>
    </span>
  );
}

function SelectedPanel({
  session,
  onClose,
}: {
  session: FleetPosition | undefined;
  onClose: () => void;
}) {
  if (!session) return null;
  return (
    <>
      <div className="mb-2 flex items-start justify-between">
        <div>
          <div className="font-semibold">{session.vehiclePlate ?? session.reference}</div>
          <div className="text-xs text-slate-500">{session.carrierName}</div>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-600">
          ✕
        </button>
      </div>
      <dl className="space-y-1 text-sm">
        <Row label="Sipariş" value={session.orderNumber} />
        <Row label="Müşteri" value={session.customerName} />
        <Row label="Sürücü" value={session.driverName ?? '—'} />
        <Row label="Telefon" value={session.driverPhone ?? '—'} />
        <Row label="Kat edilen" value={`${session.distanceKm ?? 0} km`} />
        <Row label="Kalan (kuş uçuşu)" value={session.remainingKm ? `${session.remainingKm} km` : '—'} />
      </dl>
      <Link
        href={`/sessions/${session.sessionId}`}
        className="mt-3 block rounded bg-blue-600 px-3 py-2 text-center text-sm font-medium text-white hover:bg-blue-700"
      >
        Detay ve rota geçmişi
      </Link>
    </>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-slate-500">{label}</dt>
      <dd className="text-right font-medium">{value}</dd>
    </div>
  );
}

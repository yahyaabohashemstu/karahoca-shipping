'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

const STATUS_FILTERS = [
  { value: 'LIVE', label: 'Yolda' },
  { value: 'ASSIGNED', label: 'Kod bekliyor' },
  { value: 'COMPLETED', label: 'Tamamlanan' },
  { value: 'EXPIRED', label: 'Süresi dolan' },
  { value: '', label: 'Tümü' },
];

export default function SessionsPage() {
  const [status, setStatus] = useState('LIVE');
  const [search, setSearch] = useState('');

  const { data, isLoading } = useQuery({
    queryKey: ['sessions', status, search],
    queryFn: () => api.sessions({ status: status || undefined, search: search || undefined, limit: 100 }),
  });

  return (
    <div className="mx-auto max-w-7xl p-6">
      <header className="mb-6 flex items-center justify-between">
        <div>
          <Link href="/" className="text-sm text-blue-700 hover:underline">
            ← Canlı harita
          </Link>
          <h1 className="mt-1 text-2xl font-semibold">Takip Oturumları</h1>
        </div>
        <Link
          href="/sessions/new"
          className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
        >
          + Yeni oturum
        </Link>
      </header>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        {STATUS_FILTERS.map((filter) => (
          <button
            key={filter.value}
            onClick={() => setStatus(filter.value)}
            className={`rounded-full px-3 py-1 text-sm ${
              status === filter.value
                ? 'bg-blue-600 text-white'
                : 'bg-white text-slate-600 hover:bg-slate-100'
            }`}
          >
            {filter.label}
          </button>
        ))}
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Sipariş, plaka, müşteri…"
          className="ml-auto w-64 rounded border border-slate-300 px-3 py-1.5 text-sm"
        />
      </div>

      <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-3">Oturum</th>
              <th className="px-4 py-3">Sipariş</th>
              <th className="px-4 py-3">Müşteri</th>
              <th className="px-4 py-3">Nakliyeci</th>
              <th className="px-4 py-3">Araç</th>
              <th className="px-4 py-3">Durum</th>
              <th className="px-4 py-3 text-right">Mesafe</th>
              <th className="px-4 py-3 text-right">Son sinyal</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {isLoading && (
              <tr>
                <td colSpan={8} className="px-4 py-8 text-center text-slate-400">
                  Yükleniyor…
                </td>
              </tr>
            )}
            {data?.items.map((session) => (
              <tr key={session.sessionId} className="hover:bg-slate-50">
                <td className="px-4 py-3">
                  <Link
                    href={`/sessions/${session.sessionId}`}
                    className="font-medium text-blue-700 hover:underline"
                  >
                    {session.reference}
                  </Link>
                </td>
                <td className="px-4 py-3">{session.orderNumber}</td>
                <td className="px-4 py-3">{session.customerName}</td>
                <td className="px-4 py-3 text-slate-500">{session.carrierName}</td>
                <td className="px-4 py-3">{session.vehiclePlate ?? '—'}</td>
                <td className="px-4 py-3">
                  <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs">
                    {session.status}
                  </span>
                </td>
                <td className="px-4 py-3 text-right">{session.distanceKm ?? 0} km</td>
                <td className="px-4 py-3 text-right text-slate-500">
                  {session.recordedAt
                    ? new Date(session.recordedAt).toLocaleString('tr-TR')
                    : '—'}
                </td>
              </tr>
            ))}
            {data?.items.length === 0 && (
              <tr>
                <td colSpan={8} className="px-4 py-8 text-center text-slate-400">
                  Kayıt bulunamadı.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

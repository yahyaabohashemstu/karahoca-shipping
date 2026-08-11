'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api, type SessionDetail } from '@/lib/api';

/**
 * Create a tracking session and print the hand-off.
 *
 * The screen ends on a big code + QR because that is the physical moment the
 * system lives or dies: a dispatcher reads eight characters to a driver over a
 * bad phone line, or hands them a printed slip at the gate.
 */
export default function NewSessionPage() {
  const [orderId, setOrderId] = useState('');
  const [shippingCompanyId, setShippingCompanyId] = useState('');
  const [driverName, setDriverName] = useState('');
  const [driverPhone, setDriverPhone] = useState('');
  const [vehiclePlate, setVehiclePlate] = useState('');
  const [pingIntervalSec, setPingIntervalSec] = useState(10);
  const [created, setCreated] = useState<SessionDetail | null>(null);

  // Only orders that do not already have a live session — creating a second one
  // is rejected server-side by uq_sessions_one_live_per_order anyway.
  const { data: orders } = useQuery({
    queryKey: ['orders', 'untracked'],
    queryFn: () => api.orders({ untracked: true, limit: 100 }),
  });

  const { data: companies } = useQuery({
    queryKey: ['companies'],
    queryFn: api.companies,
  });

  const mutation = useMutation({
    mutationFn: () =>
      api.createSession({
        orderId,
        shippingCompanyId,
        driverName: driverName || undefined,
        driverPhone: driverPhone || undefined,
        vehiclePlate: vehiclePlate || undefined,
        pingIntervalSec,
      }),
    onSuccess: setCreated,
  });

  if (created?.handoff) {
    return (
      <div className="mx-auto max-w-lg p-8 text-center">
        <p className="text-sm text-slate-500">Oturum oluşturuldu</p>
        <h1 className="mb-6 text-2xl font-semibold">{created.reference}</h1>

        <div className="rounded-xl border-2 border-dashed border-blue-300 bg-blue-50 p-8">
          <p className="text-xs font-medium uppercase tracking-widest text-blue-800">
            Sürücü Oturum Kodu
          </p>
          <p className="my-4 font-mono text-5xl font-bold tracking-[0.2em]">
            {created.handoff.prettyCode}
          </p>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={created.handoff.qrDataUrl} alt="QR" className="mx-auto h-52 w-52" />
          <p className="mt-4 text-xs text-slate-500">
            Sürücü QR kodu okutabilir veya kodu elle girebilir.
          </p>
          {created.handoff.expiresAt && (
            <p className="mt-1 text-xs text-slate-400">
              Geçerlilik: {new Date(created.handoff.expiresAt).toLocaleString('tr-TR')}
            </p>
          )}
        </div>

        <div className="mt-6 flex justify-center gap-3">
          <button
            onClick={() => window.print()}
            className="rounded border px-4 py-2 text-sm hover:bg-slate-50"
          >
            Yazdır
          </button>
          <Link
            href={`/sessions/${created.sessionId}`}
            className="rounded bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700"
          >
            Oturuma git
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-xl p-8">
      <Link href="/sessions" className="text-sm text-blue-700 hover:underline">
        ← Oturumlar
      </Link>
      <h1 className="mb-6 mt-1 text-2xl font-semibold">Yeni Takip Oturumu</h1>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          mutation.mutate();
        }}
        className="space-y-4 rounded-lg border border-slate-200 bg-white p-6"
      >
        <Field label="Sipariş">
          <select
            required
            value={orderId}
            onChange={(e) => setOrderId(e.target.value)}
            className="w-full rounded border border-slate-300 px-3 py-2"
          >
            <option value="">Seçiniz…</option>
            {orders?.items.map((order) => (
              <option key={String(order.id)} value={String(order.id)}>
                {String(order.orderNumber)} — {String(order.customerName)}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Nakliye firması">
          <select
            required
            value={shippingCompanyId}
            onChange={(e) => setShippingCompanyId(e.target.value)}
            className="w-full rounded border border-slate-300 px-3 py-2"
          >
            <option value="">Seçiniz…</option>
            {companies?.map((company) => (
              <option key={String(company.id)} value={String(company.id)}>
                {String(company.name)}
              </option>
            ))}
          </select>
        </Field>

        <div className="grid grid-cols-2 gap-4">
          <Field label="Sürücü adı">
            <input
              value={driverName}
              onChange={(e) => setDriverName(e.target.value)}
              placeholder="Kapıda değişebilir"
              className="w-full rounded border border-slate-300 px-3 py-2"
            />
          </Field>
          <Field label="Sürücü telefonu">
            <input
              value={driverPhone}
              onChange={(e) => setDriverPhone(e.target.value)}
              placeholder="+90…"
              className="w-full rounded border border-slate-300 px-3 py-2"
            />
          </Field>
        </div>

        <Field label="Plaka">
          <input
            value={vehiclePlate}
            onChange={(e) => setVehiclePlate(e.target.value.toUpperCase())}
            placeholder="34 ABC 123"
            className="w-full rounded border border-slate-300 px-3 py-2"
          />
        </Field>

        <Field label={`Konum aralığı: ${pingIntervalSec} saniye`}>
          <input
            type="range"
            min={5}
            max={60}
            step={5}
            value={pingIntervalSec}
            onChange={(e) => setPingIntervalSec(Number(e.target.value))}
            className="w-full"
          />
          <p className="mt-1 text-xs text-slate-500">
            Sık aralık daha detaylı rota, daha fazla pil tüketimi demektir. Araç
            durduğunda uygulama otomatik olarak seyrek moda geçer.
          </p>
        </Field>

        {mutation.isError && (
          <p className="text-sm text-red-600">
            {(mutation.error as Error).message}
          </p>
        )}

        <button
          type="submit"
          disabled={mutation.isPending || !orderId || !shippingCompanyId}
          className="w-full rounded bg-blue-600 py-2.5 font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {mutation.isPending ? 'Oluşturuluyor…' : 'Oturum oluştur ve kod üret'}
        </button>
      </form>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1 block text-sm font-medium text-slate-700">{label}</label>
      {children}
    </div>
  );
}

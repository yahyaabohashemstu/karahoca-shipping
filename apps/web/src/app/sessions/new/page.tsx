'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api, type SessionDetail } from '@/lib/api';
import { AppShell, useRequireAuth } from '@/components/AppShell';
import {
  Button,
  Card,
  EmptyState,
  ErrorState,
  Input,
  PageHeader,
  Select,
  useToast,
} from '@/components/ui';
import {
  CadencePicker,
  DEFAULT_CADENCE,
  cadenceToPolicy,
  validateCadence,
  type Cadence,
} from '@/components/CadencePicker';

/**
 * Create a tracking session and print the hand-off.
 *
 * The screen ends on a big code and a QR because that is the physical moment
 * the system lives or dies: a dispatcher reads eight characters to a driver
 * over a bad phone line, or hands them a printed slip at the gate.
 */
export default function NewSessionPage() {
  const authed = useRequireAuth();
  const toast = useToast();

  const [orderId, setOrderId] = useState('');
  const [shippingCompanyId, setShippingCompanyId] = useState('');
  const [driverName, setDriverName] = useState('');
  const [driverPhone, setDriverPhone] = useState('');
  const [vehiclePlate, setVehiclePlate] = useState('');
  const [cadence, setCadence] = useState<Cadence>(DEFAULT_CADENCE);
  const [created, setCreated] = useState<SessionDetail | null>(null);

  // Only orders that do not already have a live session — creating a second one
  // is rejected server-side by uq_sessions_one_live_per_order anyway.
  const orders = useQuery({
    queryKey: ['orders', 'untracked'],
    queryFn: () => api.orders({ untracked: true, limit: 200 }),
    enabled: authed,
  });

  const companies = useQuery({
    queryKey: ['companies'],
    queryFn: api.companies,
    enabled: authed,
  });

  const mutation = useMutation({
    mutationFn: () =>
      api.createSession({
        orderId,
        shippingCompanyId,
        driverName: driverName.trim() || undefined,
        driverPhone: driverPhone.trim() || undefined,
        vehiclePlate: vehiclePlate.trim() || undefined,
        ...cadenceToPolicy(cadence),
      }),
    onSuccess: (s) => {
      setCreated(s);
      toast.success('Oturum oluşturuldu', s.reference);
    },
    onError: (e) => toast.error('Oturum oluşturulamadı', (e as Error).message),
  });

  if (!authed) return null;

  if (created?.handoff) return <Handoff session={created} />;

  const loadFailed = orders.isError || companies.isError;
  const noOrders = !orders.isLoading && (orders.data?.items.length ?? 0) === 0;
  const noCompanies = !companies.isLoading && (companies.data?.length ?? 0) === 0;

  return (
    <AppShell>
      <PageHeader
        title="Yeni takip oturumu"
        subtitle="Sürücünün telefonuna girecek tek kullanımlık kodu üretir"
        breadcrumb={
          <Link href="/sessions" className="hover:text-ink-2 hover:underline">
            ← Oturumlar
          </Link>
        }
      />

      <div className="mx-auto w-full max-w-xl px-5 py-6">
        {loadFailed && (
          <ErrorState
            className="mb-4"
            title="Sipariş ve nakliyeci listesi alınamadı"
            message={((orders.error ?? companies.error) as Error)?.message}
            onRetry={() => {
              orders.refetch();
              companies.refetch();
            }}
          />
        )}

        {/* The old form rendered two empty dropdowns and a submit button when
            there was nothing to select — a dead end with no explanation. */}
        {!loadFailed && (noOrders || noCompanies) ? (
          <Card>
            <EmptyState
              title={noOrders ? 'Takip edilebilecek sipariş yok' : 'Kayıtlı nakliyeci yok'}
              description={
                noOrders
                  ? 'Takip oturumu açabilmek için önce bir sipariş oluşturmalısınız. Halihazırda canlı oturumu olan siparişler bu listede görünmez.'
                  : 'Sevkiyatı hangi nakliye firmasının taşıdığını kaydedebilmek için önce firmayı tanımlayın.'
              }
              action={
                <Link href={noOrders ? '/orders/new' : '/carriers/new'}>
                  <Button variant="primary" size="sm">
                    {noOrders ? 'Sipariş oluştur' : 'Nakliyeci ekle'}
                  </Button>
                </Link>
              }
            />
          </Card>
        ) : (
          <Card>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                mutation.mutate();
              }}
              className="space-y-4"
            >
              <Select
                label="Sipariş"
                required
                value={orderId}
                onChange={(e) => setOrderId(e.target.value)}
                disabled={orders.isLoading}
              >
                <option value="">{orders.isLoading ? 'Yükleniyor…' : 'Seçiniz…'}</option>
                {orders.data?.items.map((o) => (
                  <option key={String(o.id)} value={String(o.id)}>
                    {String(o.orderNumber)} — {String(o.customerName)}
                    {o.destinationLabel ? ` · ${String(o.destinationLabel)}` : ''}
                  </option>
                ))}
              </Select>

              <Select
                label="Nakliye firması"
                required
                value={shippingCompanyId}
                onChange={(e) => setShippingCompanyId(e.target.value)}
                disabled={companies.isLoading}
              >
                <option value="">{companies.isLoading ? 'Yükleniyor…' : 'Seçiniz…'}</option>
                {companies.data?.map((c) => (
                  <option key={String(c.id)} value={String(c.id)}>
                    {String(c.name)}
                  </option>
                ))}
              </Select>

              <div className="grid grid-cols-2 gap-4">
                <Input
                  label="Sürücü adı"
                  value={driverName}
                  onChange={(e) => setDriverName(e.target.value)}
                  placeholder="Kapıda değişebilir"
                />
                <Input
                  label="Sürücü telefonu"
                  type="tel"
                  inputMode="tel"
                  value={driverPhone}
                  onChange={(e) => setDriverPhone(e.target.value)}
                  placeholder="+90…"
                  hint="Araç sessizleşirse aranacak numara"
                />
              </div>

              <Input
                label="Plaka"
                value={vehiclePlate}
                onChange={(e) => setVehiclePlate(e.target.value.toLocaleUpperCase('tr'))}
                placeholder="34 ABC 123"
                numeric
              />

              <CadencePicker value={cadence} onChange={setCadence} />

              {mutation.isError && (
                <ErrorState
                  compact
                  title="Oturum oluşturulamadı"
                  message={(mutation.error as Error).message}
                />
              )}

              <Button
                type="submit"
                variant="primary"
                size="lg"
                block
                loading={mutation.isPending}
                disabled={!orderId || !shippingCompanyId || validateCadence(cadence) !== null}
              >
                {mutation.isPending ? 'Oluşturuluyor…' : 'Oturum oluştur ve kod üret'}
              </Button>
            </form>
          </Card>
        )}
      </div>
    </AppShell>
  );
}

/* -------------------------------------------------------------------------- */

/**
 * The hand-off slip.
 *
 * This is designed to be printed and physically handed over, so the print
 * stylesheet strips the application chrome and everything but the code and the
 * QR. The code is monospace with wide tracking for the same reason a flight
 * number is: it will be read aloud, character by character, over a bad line
 * from inside a truck cab.
 */
function Handoff({ session }: { session: SessionDetail }) {
  const toast = useToast();
  const handoff = session.handoff!;

  return (
    <AppShell>
      <div className="mx-auto w-full max-w-lg px-5 py-8 print:max-w-none print:py-0">
        <div className="mb-5 text-center print:mb-3">
          <p className="text-sm text-ink-2 print:hidden">Oturum oluşturuldu</p>
          <h1 className="kh-num text-xl font-semibold tracking-tight">{session.reference}</h1>
          <p className="mt-0.5 text-sm text-ink-2">
            <span className="kh-num">{session.orderNumber}</span> · {session.customerName}
          </p>
        </div>

        <div className="rounded-lg border-2 border-dashed border-brand/40 bg-brand-soft/60 p-7 text-center print:border-black print:bg-white">
          <p className="text-2xs font-semibold uppercase tracking-[0.18em] text-brand-text print:text-black">
            Sürücü oturum kodu
          </p>

          <p className="my-4 select-all font-mono text-[2.6rem] font-bold leading-none tracking-[0.18em] text-ink print:text-black">
            {handoff.prettyCode}
          </p>

          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={handoff.qrDataUrl}
            alt={`${session.reference} oturum kodu QR`}
            className="mx-auto h-48 w-48 rounded bg-white p-1.5"
          />

          <p className="mt-4 text-sm text-ink-2 print:text-black">
            Sürücü QR kodu okutabilir veya kodu elle girebilir.
          </p>
          {handoff.expiresAt && (
            <p className="kh-num mt-1 text-sm text-ink-3 print:text-black">
              Geçerlilik: {new Date(handoff.expiresAt).toLocaleString('tr-TR')}
            </p>
          )}
          <p className="mt-3 text-2xs text-ink-3 print:text-black">
            Uygulama yüklü değilse: track.karahoca.com/downloads
          </p>
        </div>

        <div className="mt-6 flex justify-center gap-2 print:hidden">
          <Button
            onClick={() => {
              navigator.clipboard
                ?.writeText(handoff.prettyCode)
                .then(() => toast.success('Kod kopyalandı', handoff.prettyCode))
                .catch(() => toast.error('Kopyalanamadı', 'Kodu elle seçip kopyalayın.'));
            }}
          >
            Kodu kopyala
          </Button>
          <Button onClick={() => window.print()}>Yazdır</Button>
          <Link href={`/sessions/${session.sessionId}`}>
            <Button variant="primary">Oturuma git</Button>
          </Link>
        </div>
      </div>
    </AppShell>
  );
}

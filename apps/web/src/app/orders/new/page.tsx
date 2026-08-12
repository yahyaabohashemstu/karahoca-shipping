'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { AppShell, useRequireAuth } from '@/components/AppShell';
import {
  Button,
  Card,
  CardHeader,
  ErrorState,
  Input,
  PageHeader,
  Select,
  Textarea,
  useToast,
} from '@/components/ui';
import { CustomerDialog } from '@/components/CustomerDialog';

/**
 * Create an order.
 *
 * The destination coordinate is the part worth caring about: without it the
 * system can compute distance travelled but not distance remaining, and it can
 * never fire an arrival event. The form therefore treats it as a first-class
 * field rather than an advanced option, and says plainly what is lost by
 * leaving it blank.
 */
export default function NewOrderPage() {
  const authed = useRequireAuth();
  const router = useRouter();
  const qc = useQueryClient();
  const toast = useToast();

  const [orderNumber, setOrderNumber] = useState('');
  const [customerId, setCustomerId] = useState('');
  const [destinationLabel, setDestinationLabel] = useState('');
  const [destinationAddress, setDestinationAddress] = useState('');
  const [coords, setCoords] = useState('');
  const [radius, setRadius] = useState('300');
  const [weight, setWeight] = useState('');
  const [pallets, setPallets] = useState('');
  const [cargoSummary, setCargoSummary] = useState('');
  const [plannedDeliveryAt, setPlannedDeliveryAt] = useState('');
  const [customerDialog, setCustomerDialog] = useState(false);

  const customers = useQuery({
    queryKey: ['customers'],
    queryFn: () => api.customers(),
    enabled: authed,
  });

  const parsed = parseCoords(coords);
  const coordError = coords.trim() && !parsed ? 'Biçim: enlem, boylam — örn. 38.6191, 27.4289' : null;

  // Mirrors the API's @Min(25) @Max(20000) so a rejected value is explained
  // here rather than coming back as a 400 after the form is submitted.
  const radiusNum = Number(radius);
  const radiusError =
    parsed && (!Number.isFinite(radiusNum) || radiusNum < 25 || radiusNum > 20000)
      ? 'Yarıçap 25–20000 metre arasında olmalı.'
      : null;

  const create = useMutation({
    mutationFn: () =>
      api.createOrder({
        orderNumber: orderNumber.trim(),
        customerId,
        destinationLabel: destinationLabel.trim() || undefined,
        destinationAddress: destinationAddress.trim() || undefined,
        destinationLat: parsed?.lat,
        destinationLon: parsed?.lon,
        destinationRadiusM: parsed ? Number(radius) || 300 : undefined,
        totalWeightKg: weight ? Number(weight) : undefined,
        palletCount: pallets ? Number(pallets) : undefined,
        cargoSummary: cargoSummary.trim() || undefined,
        plannedDeliveryAt: plannedDeliveryAt ? new Date(plannedDeliveryAt).toISOString() : undefined,
      }),
    onSuccess: (order) => {
      qc.invalidateQueries({ queryKey: ['orders'] });
      toast.success('Sipariş oluşturuldu', order.orderNumber);
      router.push('/orders');
    },
    onError: (e) => toast.error('Sipariş oluşturulamadı', (e as Error).message),
  });

  if (!authed) return null;

  const valid = orderNumber.trim().length > 0 && customerId && !coordError && !radiusError;

  return (
    <AppShell>
      <PageHeader
        title="Yeni sipariş"
        breadcrumb={
          <Link href="/orders" className="hover:text-ink-2 hover:underline">
            ← Siparişler
          </Link>
        }
      />

      <div className="mx-auto w-full max-w-2xl space-y-4 px-5 py-6">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (valid) create.mutate();
          }}
          className="space-y-4"
        >
          <Card>
            <CardHeader title="Sevkiyat" subtitle="Hangi yük, kime gidiyor" className="mb-4" />
            <div className="grid gap-4 sm:grid-cols-2">
              <Input
                label="Sipariş numarası"
                required
                value={orderNumber}
                onChange={(e) => setOrderNumber(e.target.value)}
                placeholder="SEV-2026-0001"
                numeric
                hint="Kendi sisteminizdeki numara"
              />
              <div className="flex flex-col gap-1">
                <Select
                  label="Müşteri"
                  required
                  value={customerId}
                  onChange={(e) => setCustomerId(e.target.value)}
                  disabled={customers.isLoading}
                >
                  <option value="">{customers.isLoading ? 'Yükleniyor…' : 'Seçiniz…'}</option>
                  {customers.data?.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                      {c.city ? ` — ${c.city}` : ''}
                    </option>
                  ))}
                </Select>
                {/* Creating the customer inline; otherwise the dispatcher loses
                    a half-filled order to go and create one. */}
                <button
                  type="button"
                  onClick={() => setCustomerDialog(true)}
                  className="self-start text-sm text-brand-text hover:underline"
                >
                  + Yeni müşteri ekle
                </button>
              </div>
            </div>

            <div className="mt-4 grid gap-4 sm:grid-cols-3">
              <Input
                label="Ağırlık (kg)"
                type="number"
                min={0}
                value={weight}
                onChange={(e) => setWeight(e.target.value)}
                numeric
              />
              <Input
                label="Palet sayısı"
                type="number"
                min={0}
                value={pallets}
                onChange={(e) => setPallets(e.target.value)}
                numeric
              />
              <Input
                label="Planlanan teslim"
                type="datetime-local"
                value={plannedDeliveryAt}
                onChange={(e) => setPlannedDeliveryAt(e.target.value)}
              />
            </div>

            <Textarea
              className="mt-4"
              label="Yük açıklaması"
              value={cargoSummary}
              onChange={(e) => setCargoSummary(e.target.value)}
              placeholder="Örn. 24 palet sıvı deterjan"
              rows={2}
            />
          </Card>

          <Card>
            <CardHeader
              title="Varış noktası"
              subtitle="Koordinat girilirse kalan mesafe ve varış tespiti çalışır"
              className="mb-4"
            />
            <div className="grid gap-4 sm:grid-cols-2">
              <Input
                label="Varış adı"
                value={destinationLabel}
                onChange={(e) => setDestinationLabel(e.target.value)}
                placeholder="Manisa Deposu"
              />
              <Input
                label="Koordinat"
                value={coords}
                onChange={(e) => setCoords(e.target.value)}
                placeholder="38.6191, 27.4289"
                error={coordError}
                numeric
                hint="Google Haritalar'da noktaya sağ tıklayıp kopyalayabilirsiniz"
              />
            </div>

            <Textarea
              className="mt-4"
              label="Açık adres"
              value={destinationAddress}
              onChange={(e) => setDestinationAddress(e.target.value)}
              rows={2}
            />

            {parsed && (
              <div className="mt-4 max-w-xs">
                {/* A free field, not a slider. A city depot gate and a quarry
                    weighbridge want radii two orders of magnitude apart, and a
                    slider that stops at 2 km just says "no" to the quarry. */}
                <Input
                  label="Varış yarıçapı"
                  type="text"
                  inputMode="numeric"
                  numeric
                  value={radius}
                  onChange={(e) => setRadius(e.target.value.replace(/[^\d]/g, ''))}
                  error={radiusError}
                  hint="Araç bu yarıçapa girdiğinde sistem varış olayı üretir. Metre."
                />
              </div>
            )}

            {!parsed && (
              <p className="mt-3 rounded bg-warn-bg px-3 py-2 text-sm text-warn ring-1 ring-inset ring-delayed-ring/35">
                Koordinat girilmezse sevkiyat takip edilir, ancak <strong>kalan mesafe
                hesaplanamaz</strong> ve <strong>varış otomatik tespit edilemez</strong>. Sonradan
                eklenebilir.
              </p>
            )}
          </Card>

          {create.isError && (
            <ErrorState title="Sipariş oluşturulamadı" message={(create.error as Error).message} />
          )}

          <div className="flex justify-end gap-2">
            <Link href="/orders">
              <Button>Vazgeç</Button>
            </Link>
            <Button type="submit" variant="primary" loading={create.isPending} disabled={!valid}>
              Siparişi oluştur
            </Button>
          </div>
        </form>
      </div>

      <CustomerDialog
        open={customerDialog}
        onClose={() => setCustomerDialog(false)}
        onCreated={(c) => {
          setCustomerId(c.id);
          setCustomerDialog(false);
        }}
      />
    </AppShell>
  );
}

/**
 * Accepts what people actually paste: "38.6191, 27.4289", with or without the
 * space, comma or semicolon separated, and with a decimal comma from a Turkish
 * locale keyboard.
 */
function parseCoords(input: string): { lat: number; lon: number } | null {
  const s = input.trim();
  if (!s) return null;
  const m = s.match(/^(-?\d{1,3}(?:[.,]\d+)?)\s*[,;]\s*(-?\d{1,3}(?:[.,]\d+)?)$/);
  if (!m) return null;
  const lat = Number(m[1].replace(',', '.'));
  const lon = Number(m[2].replace(',', '.'));
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return { lat, lon };
}

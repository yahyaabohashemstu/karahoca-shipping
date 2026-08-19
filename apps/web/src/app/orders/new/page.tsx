'use client';

import dynamic from 'next/dynamic';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
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
import type { PickedLocation } from '@/components/LocationPicker';
import { useT } from '@/lib/i18n';

/*
 * Loaded on demand, not with the page.
 *
 * MapLibre is ~212 kB and this component is behind a dialog that most visits
 * never open. Imported statically it landed in the first-load bundle of every
 * screen that can add a consignee: measured, /customers went from ~150 kB to
 * 361 kB and /orders/new to 362 kB, against ~150 kB for every other page.
 *
 * This is the same mistake, and the same fix, as SessionMap — see the note at
 * the top of that file, which was written after /sessions/[id] reached 353 kB
 * for exactly this reason.
 */
const LocationPicker = dynamic(
  () => import('@/components/LocationPicker').then((m) => m.LocationPicker),
  {
    ssr: false,
    loading: () => (
      <div className="h-64 w-full animate-pulse rounded-md bg-surface-2 ring-1 ring-line" />
    ),
  },
);


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
  const t = useT();
  const authed = useRequireAuth();
  const router = useRouter();
  const qc = useQueryClient();
  const toast = useToast();

  const [orderNumber, setOrderNumber] = useState('');
  const [customerId, setCustomerId] = useState('');
  const [destinationLabel, setDestinationLabel] = useState('');
  const [destinationAddress, setDestinationAddress] = useState('');
  const [location, setLocation] = useState<PickedLocation | null>(null);
  /*
   * Whether the point on screen came from the consignee's card or from a hand.
   *
   * The distinction is what makes inheritance safe. Adopting the customer's
   * point silently would overwrite a one-off delivery address the moment
   * somebody corrected the consignee dropdown; never adopting it would leave
   * the field empty, which is the state three shipments in four are in today.
   * So it is adopted only while untouched, and the badge says where it came
   * from.
   */
  const [inherited, setInherited] = useState(false);
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


  /*
   * Adopt the consignee's own delivery point.
   *
   * This is the whole reason the customer carries one. A consignee in Erbil
   * receives at the same gate every time, so asking for the coordinate once per
   * customer instead of once per shipment turns a five-step errand into a
   * single setup step — and the errand was being skipped: 3 of 4 orders in
   * production have no destination at all.
   *
   * Only while the field is untouched or already inherited, so a deliberate
   * one-off address survives a correction to the consignee dropdown.
   */
  const selectedCustomer = customers.data?.find((c) => c.id === customerId);
  useEffect(() => {
    if (!selectedCustomer) return;
    if (location !== null && !inherited) return;

    if (selectedCustomer.lat === null || selectedCustomer.lon === null) {
      // The consignee has no point. Clear an inherited one rather than leaving
      // the previous customer's warehouse attached to this order.
      if (inherited) {
        setLocation(null);
        setInherited(false);
      }
      return;
    }

    setLocation({
      lat: selectedCustomer.lat,
      lon: selectedCustomer.lon,
      label: selectedCustomer.addressLine ?? selectedCustomer.name,
      radiusM: selectedCustomer.defaultRadiusM ?? 300,
    });
    setInherited(true);
    // Keyed on the customer, not on `location`: including the value would make
    // every edit re-run this and snap the pin back to the consignee's gate.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customerId, selectedCustomer?.lat, selectedCustomer?.lon]);

  const create = useMutation({
    mutationFn: () =>
      api.createOrder({
        orderNumber: orderNumber.trim(),
        customerId,
        destinationLabel: destinationLabel.trim() || undefined,
        destinationAddress: destinationAddress.trim() || undefined,
        destinationLat: location?.lat,
        destinationLon: location?.lon,
        destinationRadiusM: location?.radiusM,
        totalWeightKg: weight ? Number(weight) : undefined,
        palletCount: pallets ? Number(pallets) : undefined,
        cargoSummary: cargoSummary.trim() || undefined,
        plannedDeliveryAt: plannedDeliveryAt ? new Date(plannedDeliveryAt).toISOString() : undefined,
      }),
    onSuccess: (order) => {
      qc.invalidateQueries({ queryKey: ['orders'] });
      toast.success(t.orderNew.created, order.orderNumber);
      router.push('/orders');
    },
    onError: (e) => toast.error(t.orderNew.createFailed, (e as Error).message),
  });

  if (!authed) return null;

  // The picker cannot produce a malformed coordinate or an out-of-range radius,
  // so there is nothing left here to guard beyond the two required fields.
  const valid = orderNumber.trim().length > 0 && Boolean(customerId);

  return (
    <AppShell>
      <PageHeader
        title={t.orderNew.title}
        breadcrumb={
          <Link href="/orders" className="hover:text-ink-2 hover:underline">
            {t.orderNew.back}
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
            <CardHeader
                title={t.orderNew.sectionShipment}
                subtitle={t.orderNew.sectionShipmentSub}
                className="mb-4"
              />
            <div className="grid gap-4 sm:grid-cols-2">
              <Input
                label={t.orderNew.orderNumber}
                required
                value={orderNumber}
                onChange={(e) => setOrderNumber(e.target.value)}
                placeholder={t.orderNew.orderNumberPlaceholder}
                numeric
                hint="Kendi sisteminizdeki numara"
              />
              <div className="flex flex-col gap-1">
                <Select
                  label={t.orderNew.customer}
                  required
                  value={customerId}
                  onChange={(e) => setCustomerId(e.target.value)}
                  disabled={customers.isLoading}
                >
                  <option value="">{customers.isLoading ? t.common.loading : t.consignment.choose}</option>
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
                  {t.orderNew.newCustomer}
                </button>
              </div>
            </div>

            <div className="mt-4 grid gap-4 sm:grid-cols-3">
              <Input
                label={t.orderNew.weight}
                type="number"
                min={0}
                value={weight}
                onChange={(e) => setWeight(e.target.value)}
                numeric
              />
              <Input
                label={t.orderNew.pallets}
                type="number"
                min={0}
                value={pallets}
                onChange={(e) => setPallets(e.target.value)}
                numeric
              />
              <Input
                label={t.orderNew.planned}
                type="datetime-local"
                value={plannedDeliveryAt}
                onChange={(e) => setPlannedDeliveryAt(e.target.value)}
              />
            </div>

            <Textarea
              className="mt-4"
              label={t.orderNew.cargo}
              value={cargoSummary}
              onChange={(e) => setCargoSummary(e.target.value)}
              placeholder={t.orderNew.cargoPlaceholder}
              rows={2}
            />
          </Card>

          <Card>
            <CardHeader
              title={t.orderNew.sectionDestination}
              subtitle={t.orderNew.sectionDestinationSub}
              className="mb-4"
            />
            <Input
              label={t.orderNew.destinationName}
              value={destinationLabel}
              onChange={(e) => setDestinationLabel(e.target.value)}
              placeholder={t.orderNew.destinationNamePlaceholder}
              hint={t.orderNew.destinationNameHint}
            />

            <Textarea
              className="mt-4"
              label={t.orderNew.address}
              value={destinationAddress}
              onChange={(e) => setDestinationAddress(e.target.value)}
              rows={2}
            />

            <div className="mt-4">
              <div className="mb-2 flex items-center gap-2">
                <p className="text-sm font-medium text-ink">{t.orderNew.deliveryPoint}</p>
                {inherited && (
                  /*
                   * Says where the pin came from.
                   *
                   * Without it an inherited point looks like something the
                   * dispatcher entered and forgot, and the honest reaction to a
                   * coordinate you do not remember typing is to distrust it.
                   */
                  <span className="rounded bg-surface-2 px-1.5 py-0.5 text-2xs text-ink-2 ring-1 ring-line">
                    {t.orderNew.fromCustomer}
                  </span>
                )}
              </div>
              <LocationPicker
                value={location}
                onChange={(next) => {
                  setLocation(next);
                  setInherited(false);
                }}
                emptyHint={
                  selectedCustomer && selectedCustomer.lat === null
                    ? t.orderNew.hintNoCustomerPoint
                    : t.orderNew.hintNoPoint
                }
              />
            </div>

          </Card>

          {create.isError && (
            <ErrorState title="Sipariş oluşturulamadı" message={(create.error as Error).message} />
          )}

          <div className="flex justify-end gap-2">
            <Link href="/orders">
              <Button>{t.common.cancel}</Button>
            </Link>
            <Button type="submit" variant="primary" loading={create.isPending} disabled={!valid}>
              {t.orderNew.submit}
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

'use client';

import dynamic from 'next/dynamic';

import { useEffect, useState } from 'react';
import type { PickedLocation } from '@/components/LocationPicker';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, type Customer } from '@/lib/api';
import { Button } from './ui/Button';
import { Input, Select } from './ui/Form';
import { ErrorState } from './ui/Feedback';
import { Modal } from './ui/Modal';
import { useToast } from './ui/Toast';
import { countryOptions } from '@/lib/countries';
import { useI18n, useT } from '@/lib/i18n';

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
 * Add or correct a consignee, without leaving whatever you were doing.
 *
 * A dialog rather than a page because the moment a dispatcher needs it is
 * halfway through an order form, and sending them to a separate screen means
 * abandoning a half-filled one.
 *
 * It gained an edit mode for a reason worth recording. The default delivery
 * point was built, the PATCH endpoint was built, and neither could ever reach a
 * consignee who already existed — every customer in production predated the
 * picker, so the feature applied to nobody currently shipping.
 *
 * An earlier version of this note added that all three were filed under Turkey
 * and would therefore be sent a Turkish tracking page. That was wrong and is
 * corrected here rather than quietly deleted: the real consignee, altunsa in
 * Kirkuk, is filed under IQ and already receives the Arabic page. The two
 * without a delivery point are a German customer with no orders and a test
 * record.
 */
export function CustomerDialog({
  open,
  onClose,
  onCreated,
  customer,
}: {
  open: boolean;
  onClose: () => void;
  onCreated?: (c: Customer) => void;
  /** Present to edit that consignee; absent to add one. */
  customer?: Customer | null;
}) {
  const { locale } = useI18n();
  const qc = useQueryClient();
  const toast = useToast();
  const editing = Boolean(customer);

  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [city, setCity] = useState('');
  const [countryCode, setCountryCode] = useState('TR');
  const [contactName, setContactName] = useState('');
  const [contactPhone, setContactPhone] = useState('');
  /*
   * A picked place, not a typed coordinate.
   *
   * The text field this replaces was correct, warned honestly about what was
   * lost by leaving it blank, and was left blank on three orders out of four —
   * because filling it in meant leaving the application to find a warehouse on
   * somebody else's map. Three of those four were for a consignee whose own
   * delivery point was already on file and simply never inherited.
   */
  const [location, setLocation] = useState<PickedLocation | null>(null);

  const save = useMutation({
    mutationFn: () => {
      const common = {
        name: name.trim(),
        city: city.trim() || undefined,
        contactName: contactName.trim() || undefined,
        contactPhone: contactPhone.trim() || undefined,
        countryCode,
      };

      if (customer) {
        /*
         * null, not undefined, when the point was removed.
         *
         * The PATCH endpoint treats an absent field as "leave it alone" and an
         * explicit null as "clear it", which is the only way a dispatcher who
         * finds the pin on the wrong warehouse can take it off. Sending
         * undefined would silently keep a confidently wrong arrival radius in
         * place.
         */
        return api.updateCustomer(customer.id, {
          ...common,
          lat: location ? location.lat : null,
          lon: location ? location.lon : null,
          defaultRadiusM: location ? location.radiusM : null,
          addressLine: location?.label ?? undefined,
        });
      }

      return api.createCustomer({
        ...common,
        code: code.trim(),
        lat: location?.lat,
        lon: location?.lon,
        addressLine: location?.label ?? undefined,
        defaultRadiusM: location?.radiusM,
      });
    },
    onSuccess: (c) => {
      qc.invalidateQueries({ queryKey: ['customers'] });
      // The order form inherits a consignee's point, so a corrected customer
      // has to invalidate orders too — otherwise a form already on screen keeps
      // the old one.
      qc.invalidateQueries({ queryKey: ['orders'] });
      toast.success(editing ? 'Müşteri güncellendi' : 'Müşteri eklendi', c.name);
      onClose();
      if (!editing) onCreated?.(c);
    },
    onError: (e) =>
      toast.error(editing ? 'Güncellenemedi' : 'Müşteri eklenemedi', (e as Error).message),
  });

  /*
   * Seeded when the dialog opens, not on every render.
   *
   * Modal keeps its children mounted — it drives a native <dialog> — so this
   * component and its map exist from the moment the page loads. Seeding on
   * `open` is what makes "edit" show the consignee rather than a blank form,
   * and keying on the id as well means opening one customer, closing, and
   * opening another does not show the first one's details.
   */
  useEffect(() => {
    if (!open) return;
    setCode(customer?.code ?? '');
    setName(customer?.name ?? '');
    setCity(customer?.city ?? '');
    setCountryCode(customer?.countryCode ?? 'TR');
    setContactName(customer?.contactName ?? '');
    setContactPhone(customer?.contactPhone ?? '');
    setLocation(
      customer && customer.lat !== null && customer.lon !== null
        ? {
            lat: customer.lat,
            lon: customer.lon,
            label: customer.addressLine ?? customer.name,
            radiusM: customer.defaultRadiusM ?? 300,
          }
        : null,
    );
    save.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, customer?.id]);

  // The picker cannot produce an invalid coordinate — there is no text to
  // mistype — so validity is the two fields that are actually required. In edit
  // mode the code is fixed, so only the name can fail.
  const valid = name.trim().length >= 2 && (editing || code.trim().length >= 2);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={editing ? 'Müşteriyi düzenle' : 'Yeni müşteri'}
      description={
        editing
          ? 'Teslim noktası ve ülke, alıcının takip sayfasını doğrudan etkiler'
          : 'Sevkiyatın teslim edileceği taraf'
      }
      footer={
        <>
          <Button onClick={onClose} disabled={save.isPending}>
            Vazgeç
          </Button>
          <Button
            variant="primary"
            loading={save.isPending}
            disabled={!valid}
            onClick={() => save.mutate()}
          >
            {editing ? 'Kaydet' : 'Ekle'}
          </Button>
        </>
      }
    >
      <div className="space-y-3.5">
        <div className="grid grid-cols-[8rem_1fr] gap-3">
          <Input
            label="Kod"
            required={!editing}
            value={code}
            onChange={(e) => setCode(e.target.value.toLocaleUpperCase('tr'))}
            placeholder="MGZ-01"
            numeric
            /* The ERP key, and what every order is filed under. Changing it
               would not rename a customer, it would create a second one. */
            disabled={editing}
            hint={editing ? 'Kod değiştirilemez' : undefined}
          />
          <Input
            label="Ünvan"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Örnek Market A.Ş."
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          {/* A select, not free text. Typed per shipment, the same firm ends up
              filed under DE, DEU and Almanya and no export report adds up. It
              also decides the language of the consignee's tracking page. */}
          <Select label="Ülke" required value={countryCode} onChange={(e) => setCountryCode(e.target.value)}>
            {countryOptions(locale).map((c) => (
              <option key={c.code} value={c.code}>
                {c.label}
              </option>
            ))}
          </Select>
          <Input label="Şehir" value={city} onChange={(e) => setCity(e.target.value)} placeholder="Manisa" />
        </div>

        {/* Says what the country actually does, where it is chosen. Nobody
            would guess that a dropdown labelled "Ülke" decides whether a
            consignee in Erbil can read the page they are sent. */}
        {(countryCode === 'IQ' || countryCode === 'SY') && (
          <p className="rounded bg-surface-2 px-3 py-2 text-2xs text-ink-2 ring-1 ring-line">
            Bu ülke seçiliyken alıcının takip sayfası <strong>Arapça</strong> açılır.
          </p>
        )}

        <div>
          <p className="mb-2 text-sm font-medium text-ink">Varsayılan teslim noktası</p>
          <LocationPicker
            value={location}
            onChange={setLocation}
            emptyHint={
              'Bu müşterinin siparişleri bu noktayı otomatik devralır. ' +
              'Boş bırakılırsa kalan mesafe hesaplanamaz ve varış otomatik tespit edilemez.'
            }
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Input
            label="Yetkili"
            value={contactName}
            onChange={(e) => setContactName(e.target.value)}
          />
          <Input
            label="Telefon"
            type="tel"
            value={contactPhone}
            onChange={(e) => setContactPhone(e.target.value)}
            placeholder="+90…"
            numeric
          />
        </div>

        {save.isError && (
          <ErrorState
            compact
            title={editing ? 'Kaydedilemedi' : 'Eklenemedi'}
            message={(save.error as Error).message}
          />
        )}
      </div>
    </Modal>
  );
}

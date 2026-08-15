'use client';

import { useState } from 'react';
import { LocationPicker, type PickedLocation } from '@/components/LocationPicker';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, type Customer } from '@/lib/api';
import { Button } from './ui/Button';
import { Input, Select } from './ui/Form';
import { ErrorState } from './ui/Feedback';
import { Modal } from './ui/Modal';
import { useToast } from './ui/Toast';
import { COUNTRY_OPTIONS } from '@/lib/countries';

/**
 * Create a customer without leaving whatever you were doing.
 *
 * This is a dialog rather than a page because the moment a dispatcher needs it
 * is halfway through an order form — and sending them to a separate screen
 * means abandoning a half-filled one.
 */
export function CustomerDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated?: (c: Customer) => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();

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
   * lost by leaving it blank, and was left blank on three consignees out of
   * three — because filling it in meant leaving the application to find a
   * warehouse on somebody else's map.
   */
  const [location, setLocation] = useState<PickedLocation | null>(null);

  function reset() {
    setCode('');
    setName('');
    setCity('');
    setCountryCode('TR');
    setContactName('');
    setContactPhone('');
    setLocation(null);
    create.reset();
  }


  const create = useMutation({
    mutationFn: () =>
      api.createCustomer({
        code: code.trim(),
        name: name.trim(),
        city: city.trim() || undefined,
        contactName: contactName.trim() || undefined,
        contactPhone: contactPhone.trim() || undefined,
        lat: location?.lat,
        lon: location?.lon,
        addressLine: location?.label ?? undefined,
        defaultRadiusM: location?.radiusM,
        countryCode,
      }),
    onSuccess: (c) => {
      qc.invalidateQueries({ queryKey: ['customers'] });
      toast.success('Müşteri eklendi', c.name);
      reset();
      onCreated?.(c);
    },
    onError: (e) => toast.error('Müşteri eklenemedi', (e as Error).message),
  });

  // The picker cannot produce an invalid coordinate — there is no text to
  // mistype — so validity is back to the two fields that are actually required.
  const valid = code.trim().length >= 2 && name.trim().length >= 2;

  return (
    <Modal
      open={open}
      onClose={() => {
        reset();
        onClose();
      }}
      title="Yeni müşteri"
      description="Sevkiyatın teslim edileceği taraf"
      footer={
        <>
          <Button
            onClick={() => {
              reset();
              onClose();
            }}
            disabled={create.isPending}
          >
            Vazgeç
          </Button>
          <Button
            variant="primary"
            loading={create.isPending}
            disabled={!valid}
            onClick={() => create.mutate()}
          >
            Ekle
          </Button>
        </>
      }
    >
      <div className="space-y-3.5">
        <div className="grid grid-cols-[8rem_1fr] gap-3">
          <Input
            label="Kod"
            required
            value={code}
            onChange={(e) => setCode(e.target.value.toLocaleUpperCase('tr'))}
            placeholder="MGZ-01"
            numeric
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
              filed under DE, DEU and Almanya, and no export report ever adds up. */}
          <Select label="Ülke" required value={countryCode} onChange={(e) => setCountryCode(e.target.value)}>
            {COUNTRY_OPTIONS.map((c) => (
              <option key={c.code} value={c.code}>
                {c.label}
              </option>
            ))}
          </Select>
          <Input label="Şehir" value={city} onChange={(e) => setCity(e.target.value)} placeholder="Manisa" />
        </div>
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

        {create.isError && (
          <ErrorState compact title="Eklenemedi" message={(create.error as Error).message} />
        )}
      </div>
    </Modal>
  );
}

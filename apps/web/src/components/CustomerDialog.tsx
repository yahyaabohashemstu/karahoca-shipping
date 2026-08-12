'use client';

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, type Customer } from '@/lib/api';
import { Button } from './ui/Button';
import { Input } from './ui/Form';
import { ErrorState } from './ui/Feedback';
import { Modal } from './ui/Modal';
import { useToast } from './ui/Toast';

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
  const [contactName, setContactName] = useState('');
  const [contactPhone, setContactPhone] = useState('');
  const [coords, setCoords] = useState('');

  function reset() {
    setCode('');
    setName('');
    setCity('');
    setContactName('');
    setContactPhone('');
    setCoords('');
    create.reset();
  }

  const parsed = parseCoords(coords);
  const coordError = coords.trim() && !parsed ? 'Biçim: enlem, boylam' : null;

  const create = useMutation({
    mutationFn: () =>
      api.createCustomer({
        code: code.trim(),
        name: name.trim(),
        city: city.trim() || undefined,
        contactName: contactName.trim() || undefined,
        contactPhone: contactPhone.trim() || undefined,
        lat: parsed?.lat,
        lon: parsed?.lon,
        countryCode: 'TR',
      }),
    onSuccess: (c) => {
      qc.invalidateQueries({ queryKey: ['customers'] });
      toast.success('Müşteri eklendi', c.name);
      reset();
      onCreated?.(c);
    },
    onError: (e) => toast.error('Müşteri eklenemedi', (e as Error).message),
  });

  const valid = code.trim().length >= 2 && name.trim().length >= 2 && !coordError;

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
          <Input label="Şehir" value={city} onChange={(e) => setCity(e.target.value)} placeholder="Manisa" />
          <Input
            label="Koordinat"
            value={coords}
            onChange={(e) => setCoords(e.target.value)}
            placeholder="38.6191, 27.4289"
            error={coordError}
            numeric
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

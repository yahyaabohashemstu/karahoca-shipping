'use client';

import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, type Customer } from '@/lib/api';
import { Badge, Button, IconButton, Input, Select } from './ui';
import { CustomerDialog } from './CustomerDialog';
import { countryLabel, isExport } from '@/lib/countries';
import { useI18n, useT } from '@/lib/i18n';

/* =============================================================================
   Who the load is going to, and what is on the truck
   =============================================================================
   Both of these belong to the ORDER, not to the tracking session. A session
   means "this phone is tracking this order for this carrier"; recording the
   consignee on it would let two sessions for the same order — a re-claim after
   a phone is replaced, say — disagree about who the goods are for.

   They are edited HERE, on the dispatch form, because that is the moment the
   dispatcher knows them, and sending someone to a separate screen and back is
   how a half-filled form gets abandoned. The save goes to PATCH /orders/:id.

   The country is a property of the consignee company, not of the shipment, so
   it is shown from the customer record rather than typed per shipment. Typing
   it per shipment is how the same firm ends up filed under DE, DEU and Almanya.
   ========================================================================== */

export interface ProductLine {
  /** Free text. The API column is called `sku` but a dispatcher types a name. */
  name: string;
  quantity: string;
  unit: string;
}

export const EMPTY_LINE: ProductLine = { name: '', quantity: '', unit: 'PALET' };

const UNITS = ['PALET', 'KOLI', 'ADET', 'KG', 'TON', 'VARIL', 'BIDON'];

export interface Consignment {
  customerId: string;
  lines: ProductLine[];
}

/** Only rows with a name are worth sending; a blank repeater row is not data. */
export function consignmentToItems(lines: ProductLine[]) {
  return lines
    .filter((l) => l.name.trim().length > 0)
    .map((l) => ({
      sku: l.name.trim().slice(0, 64),
      quantity: Number(l.quantity) > 0 ? Number(l.quantity) : 1,
      unit: l.unit || 'PALET',
    }));
}

export function ConsignmentEditor({
  value,
  onChange,
  /** The order's own customer, used as the default consignee. */
  defaultCustomerId,
}: {
  value: Consignment;
  onChange: (c: Consignment) => void;
  defaultCustomerId?: string;
}) {
  const { locale } = useI18n();
  const t = useT();
  const [dialog, setDialog] = useState(false);

  const customers = useQuery({
    queryKey: ['customers'],
    queryFn: () => api.customers(),
  });

  // Adopt the order's customer when one is picked, unless the dispatcher has
  // already chosen a different consignee for this shipment.
  useEffect(() => {
    if (defaultCustomerId && !value.customerId) {
      onChange({ ...value, customerId: defaultCustomerId });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaultCustomerId]);

  const selected: Customer | undefined = useMemo(
    () => customers.data?.find((c) => c.id === value.customerId),
    [customers.data, value.customerId],
  );

  const setLine = (i: number, patch: Partial<ProductLine>) => {
    const lines = value.lines.map((l, n) => (n === i ? { ...l, ...patch } : l));
    onChange({ ...value, lines });
  };

  const addLine = () => onChange({ ...value, lines: [...value.lines, { ...EMPTY_LINE }] });

  const removeLine = (i: number) => {
    const lines = value.lines.filter((_, n) => n !== i);
    // Never leave the repeater with nothing at all — an empty section reads as
    // broken rather than as "no products entered".
    onChange({ ...value, lines: lines.length ? lines : [{ ...EMPTY_LINE }] });
  };

  const filled = value.lines.filter((l) => l.name.trim()).length;

  return (
    <div className="rounded-md bg-surface-2 p-3.5 ring-1 ring-inset ring-line">
      {/* ---------------------------------------------------- consignee -- */}
      <div className="mb-1.5 flex items-baseline justify-between gap-2">
        <span className="text-sm font-medium text-ink-2">{t.consignment.customer}</span>
        <button
          type="button"
          onClick={() => setDialog(true)}
          className="text-sm text-brand-text hover:underline"
        >
          {t.consignment.newCustomer}
        </button>
      </div>

      <div className="flex items-start gap-2">
        <Select
          value={value.customerId}
          onChange={(e) => onChange({ ...value, customerId: e.target.value })}
          disabled={customers.isLoading}
          className="flex-1"
          aria-label={t.consignment.customer}
        >
          <option value="">{customers.isLoading ? t.common.loading : t.consignment.choose}</option>
          {customers.data?.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
              {c.city ? ` — ${c.city}` : ''}
              {c.countryCode ? ` (${c.countryCode})` : ''}
            </option>
          ))}
        </Select>

        {/* The country is shown, not typed. It comes from the company record. */}
        <div className="flex h-8 shrink-0 items-center">
          {selected ? (
            <Badge tone={isExport(selected.countryCode) ? 'brand' : 'neutral'}>
              {countryLabel(selected.countryCode, locale)}
            </Badge>
          ) : (
            <span className="text-sm text-ink-3">{t.consignment.countryDash}</span>
          )}
        </div>
      </div>
      <p className="mt-1 text-sm text-ink-3">
        {t.consignment.countryHint}
      </p>

      {/* ----------------------------------------------------- products -- */}
      <div className="mt-4 border-t border-line pt-3">
        <div className="mb-1.5 flex items-baseline justify-between gap-2">
          <span className="text-sm font-medium text-ink-2">
            {t.consignment.items} <span className="font-normal text-ink-3">{t.consignment.itemsOptional}</span>
          </span>
          {filled > 0 && (
            <span className="kh-num text-sm text-ink-3">{filled} kalem</span>
          )}
        </div>

        <div className="space-y-2">
          {value.lines.map((line, i) => (
            /*
             * Widths live on WRAPPERS, not on the controls.
             *
             * Input and Select both carry `w-full` in their base class string,
             * and Tailwind resolves competing width utilities by stylesheet
             * order, not by the order they appear in the className. `w-20` on a
             * control that also has `w-full` therefore loses — which collapsed
             * the product-name field to a sliver while the quantity box took
             * the whole row, and a dispatcher typed the quantity into what
             * looked like the name field.
             */
            <div key={i} className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <Input
                  value={line.name}
                  onChange={(e) => setLine(i, { name: e.target.value })}
                  placeholder={t.consignment.itemName}
                  aria-label={`Ürün ${i + 1} adı`}
                />
              </div>
              <div className="w-20 shrink-0">
                <Input
                  value={line.quantity}
                  onChange={(e) => setLine(i, { quantity: e.target.value.replace(/[^\d.,]/g, '') })}
                  placeholder={t.consignment.itemQuantity}
                  inputMode="decimal"
                  numeric
                  aria-label={`Ürün ${i + 1} miktarı`}
                />
              </div>
              <div className="w-28 shrink-0">
                <Select
                  value={line.unit}
                  onChange={(e) => setLine(i, { unit: e.target.value })}
                  aria-label={`Ürün ${i + 1} birimi`}
                >
                  {UNITS.map((u) => (
                    <option key={u} value={u}>
                      {u}
                    </option>
                  ))}
                </Select>
              </div>
              <IconButton
                label={`Ürün ${i + 1} satırını sil`}
                size="md"
                onClick={() => removeLine(i)}
                // Disabled rather than hidden on the last row: a control that
                // disappears is harder to understand than one that is greyed.
                disabled={value.lines.length === 1 && !line.name.trim()}
              >
                <svg viewBox="0 0 14 14" className="h-3.5 w-3.5" fill="none" aria-hidden>
                  <path d="M2.5 3.5h9M5.5 3.5V2.5h3v1M3.5 3.5l.6 8h5.8l.6-8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </IconButton>
            </div>
          ))}
        </div>

        <Button type="button" size="sm" onClick={addLine} className="mt-2">
          {t.consignment.addItem}
        </Button>
      </div>

      <CustomerDialog
        open={dialog}
        onClose={() => setDialog(false)}
        onCreated={(c) => {
          onChange({ ...value, customerId: c.id });
          setDialog(false);
        }}
      />
    </div>
  );
}

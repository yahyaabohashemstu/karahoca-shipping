'use client';

import { useState } from 'react';
import { CustomerDialog } from '@/components/CustomerDialog';
import type { Customer } from '@/lib/api';

/**
 * The consignee dialog, in both of its modes, without a login.
 *
 * The thing worth checking here cannot be checked by reading: the dialog's map
 * is constructed while the dialog is closed — Modal drives a native <dialog>
 * and keeps its children mounted — so a saved delivery point arrives long after
 * the camera has settled on the plant. Whether "edit" actually shows the
 * consignee's warehouse, or a map of Gaziantep with the marker off-screen, is a
 * question only a rendered page answers.
 *
 * Unlisted, like the other harnesses, and the customer below is invented.
 */
const ERBIL: Customer = {
  id: '00000000-0000-4000-8000-000000000001',
  code: 'ERB-01',
  name: 'Erbil Ticaret',
  city: 'Erbil',
  region: null,
  countryCode: 'IQ',
  contactName: 'Kamaran',
  contactPhone: '+964 750 000 0000',
  lat: 36.1911744,
  lon: 44.0094145,
  defaultRadiusM: 450,
  addressLine: 'أربيل, إقليم كردستان, العراق',
  isActive: true,
};

export default function CustomerDialogPreviewPage() {
  const [mode, setMode] = useState<'closed' | 'create' | 'edit'>('closed');

  return (
    <div className="space-y-4 p-6">
      <div>
        <h1 className="text-lg font-semibold text-ink">Müşteri diyaloğu</h1>
        <p className="text-sm text-ink-2">
          Düzenleme kipinde harita, kayıtlı noktaya kendi kendine gitmelidir.
        </p>
      </div>

      <div className="flex gap-2">
        <button
          type="button"
          data-testid="open-create"
          onClick={() => setMode('create')}
          className="rounded-md bg-surface px-3 py-1.5 text-sm text-ink ring-1 ring-line"
        >
          Yeni müşteri
        </button>
        <button
          type="button"
          data-testid="open-edit"
          onClick={() => setMode('edit')}
          className="rounded-md bg-surface px-3 py-1.5 text-sm text-ink ring-1 ring-line"
        >
          Erbil Ticaret&apos;i düzenle
        </button>
      </div>

      <CustomerDialog
        open={mode !== 'closed'}
        onClose={() => setMode('closed')}
        customer={mode === 'edit' ? ERBIL : null}
      />
    </div>
  );
}

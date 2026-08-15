'use client';

import { useState } from 'react';
import { LocationPicker, type PickedLocation } from '@/components/LocationPicker';

/**
 * The destination picker, on its own.
 *
 * It normally lives inside the customer dialog and the order form, both behind
 * a login and both wrapped in a modal that animates open — which makes the one
 * thing worth checking, that a map inside a container with no initial height
 * still measures itself, the hardest thing to get at. This renders it bare.
 *
 * Unlisted, like the fleet harness beside it, and it holds no data.
 */
export default function PickerPreviewPage() {
  const [value, setValue] = useState<PickedLocation | null>(null);

  return (
    <div className="mx-auto max-w-xl space-y-4 p-6">
      <div>
        <h1 className="text-lg font-semibold text-ink">Teslim noktası seçici</h1>
        <p className="text-sm text-ink-2">
          Ara, haritaya tıkla, iğneyi sürükle. Yarıçap gerçek metre olarak çizilir.
        </p>
      </div>

      <LocationPicker
        value={value}
        onChange={setValue}
        emptyHint="Nokta seçilmezse kalan mesafe hesaplanamaz ve varış otomatik tespit edilemez."
      />

      <pre
        data-testid="picked"
        className="overflow-x-auto rounded bg-surface-2 p-3 text-2xs text-ink-2"
      >
        {JSON.stringify(value, null, 2) ?? 'null'}
      </pre>
    </div>
  );
}

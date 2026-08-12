'use client';

import { useCallback, useEffect, useRef } from 'react';
import clsx from 'clsx';
import { Button } from './Button';

/* =============================================================================
   Modal
   =============================================================================
   Built on <dialog>, so focus trapping, Escape, inertness of the page behind,
   and the top-layer stacking come from the platform instead of from three
   hundred lines of focus-management code that will be subtly wrong.

   The reason this exists at all: "Teslim edildi" and "İptal et" close a
   shipment irreversibly and used to fire on a single unguarded click, with no
   confirmation, no pending state and no error handling.
   ========================================================================== */

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = 'md',
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: React.ReactNode;
  children?: React.ReactNode;
  footer?: React.ReactNode;
  size?: 'sm' | 'md' | 'lg';
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);

  // `close` fires for Escape too, so this is the single exit path.
  const handleClose = useCallback(() => onClose(), [onClose]);

  const widths = { sm: 'max-w-sm', md: 'max-w-md', lg: 'max-w-2xl' } as const;

  return (
    <dialog
      ref={ref}
      onClose={handleClose}
      // Clicking the backdrop closes. <dialog> reports backdrop clicks as
      // clicks on the dialog element itself, so compare the target.
      onClick={(e) => {
        if (e.target === ref.current) handleClose();
      }}
      aria-labelledby="kh-modal-title"
      className={clsx(
        'w-[calc(100vw-2rem)] rounded-lg bg-surface p-0 text-ink shadow-panel ring-1 ring-line',
        'backdrop:bg-black/45 backdrop:backdrop-blur-[2px]',
        'open:kh-enter',
        widths[size],
      )}
    >
      <div className="border-b border-line px-5 py-3">
        <h2 id="kh-modal-title" className="text-md font-semibold">
          {title}
        </h2>
        {description && <p className="mt-1 text-base text-ink-2">{description}</p>}
      </div>
      {children && <div className="px-5 py-4">{children}</div>}
      <div className="flex justify-end gap-2 border-t border-line bg-surface-2 px-5 py-3">
        {footer ?? (
          <Button variant="secondary" onClick={handleClose}>
            Kapat
          </Button>
        )}
      </div>
    </dialog>
  );
}

/**
 * Confirmation for an action that cannot be undone.
 *
 * `detail` exists so the dialog can name the plate and the order number. "Are
 * you sure?" is not a safeguard; "Complete 34 ABC 123 / TEST-0001?" is.
 */
export function ConfirmDialog({
  open,
  onCancel,
  onConfirm,
  title,
  detail,
  confirmLabel = 'Onayla',
  cancelLabel = 'Vazgeç',
  tone = 'primary',
  loading,
  error,
}: {
  open: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  title: string;
  detail?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: 'primary' | 'danger' | 'success';
  loading?: boolean;
  error?: string | null;
}) {
  return (
    <Modal
      open={open}
      onClose={onCancel}
      title={title}
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={onCancel} disabled={loading}>
            {cancelLabel}
          </Button>
          <Button variant={tone} onClick={onConfirm} loading={loading}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {detail && <div className="text-base text-ink-2">{detail}</div>}
      {error && (
        <p role="alert" className="mt-3 rounded bg-danger-bg px-3 py-2 text-sm text-danger ring-1 ring-inset ring-danger-ring">
          {error}
        </p>
      )}
    </Modal>
  );
}

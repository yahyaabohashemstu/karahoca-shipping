'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import clsx from 'clsx';
import { Button } from './Button';
import { useT } from '@/lib/i18n';

/* =============================================================================
   Modal
   =============================================================================
   Built on <dialog>, so focus trapping, Escape, inertness of the page behind,
   and the top-layer stacking come from the platform instead of from three
   hundred lines of focus-management code that will be subtly wrong.

   The reason this exists at all: "Teslim edildi" and "İptal et" close a
   shipment irreversibly and used to fire on a single unguarded click, with no
   confirmation, no pending state and no error handling.

   RENDERED THROUGH A PORTAL, and that is not cosmetic.

   `showModal()` lifts the dialog into the top layer visually, but it stays
   exactly where it was in the DOM — and if that was inside a <form>, every
   control in the dialog is still one of that form's controls. A `required`
   field in a CLOSED dialog is therefore an empty required field in the form:
   on submit the browser runs constraint validation, finds an invalid control
   it cannot focus (the dialog is display:none), and ABORTS THE SUBMIT SILENTLY.
   No event handler runs. No message appears. The button simply does nothing.

   That is not hypothetical. Putting the consignee editor — which renders the
   new-customer dialog — inside the tracking-session form broke session
   creation completely, with no error anywhere, and it took reading
   `form.querySelectorAll(':invalid')` on the deployed site to see why: two
   required inputs, `offsetParent: null`, inside a dialog with `open: false`.

   Portalling to <body> means a modal can never belong to a form again.
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
  const t = useT();
  const ref = useRef<HTMLDialogElement>(null);
  // createPortal needs a document, which does not exist during the server
  // render. Mounting first keeps this component usable from any page.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open, mounted]);

  // `close` fires for Escape too, so this is the single exit path.
  const handleClose = useCallback(() => onClose(), [onClose]);

  const widths = { sm: 'max-w-sm', md: 'max-w-md', lg: 'max-w-2xl' } as const;

  if (!mounted) return null;

  return createPortal(
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
        'w-[calc(100vw-2rem)] rounded-2xl bg-surface p-0 text-ink shadow-panel ring-1 ring-line',
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
            {t.common.close}
          </Button>
        )}
      </div>
    </dialog>,
    document.body,
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
  confirmLabel,
  cancelLabel,
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
  const t = useT();
  return (
    <Modal
      open={open}
      onClose={onCancel}
      title={title}
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={onCancel} disabled={loading}>
            {cancelLabel ?? t.common.cancel}
          </Button>
          <Button variant={tone} onClick={onConfirm} loading={loading}>
            {confirmLabel ?? t.common.confirm}
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

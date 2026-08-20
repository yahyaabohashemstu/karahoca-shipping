'use client';

import clsx from 'clsx';
import { Button } from './Button';
import { useT } from '@/lib/i18n';

/* =============================================================================
   The three states every data surface must distinguish
   =============================================================================
   The old dashboard collapsed two of them. A failed /tracking/live and an empty
   fleet rendered byte-identical screens: "Şu anda yolda araç yok." A dispatcher
   read that as "every shipment is delivered" and stopped watching — a backend
   blip turned into an operational blind spot nobody investigated.

   In a shipment control room the difference between "nothing is moving" and
   "I cannot see what is moving" is the entire point of the screen. So loading,
   error and empty are three separate components, and every list renders all
   three.
   ========================================================================== */

export function Skeleton({ className }: { className?: string }) {
  return <div className={clsx('kh-skeleton rounded-md', className)} aria-hidden />;
}

/** Placeholder rows that keep the real row height, so nothing jumps on arrival. */
export function SkeletonList({ rows = 6, className }: { rows?: number; className?: string }) {
  return (
    <div className={clsx('divide-y divide-line', className)} aria-busy role="status">
      <span className="sr-only">{useT().common.loading}</span>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 px-3.5 py-3">
          <Skeleton className="h-2 w-2 rounded-full" />
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-3 w-28 rounded-md" />
            <Skeleton className="h-2.5 w-44 rounded-md" />
          </div>
          <Skeleton className="h-4 w-16 rounded-full" />
        </div>
      ))}
    </div>
  );
}

export function SkeletonText({ className = 'h-3 w-24' }: { className?: string }) {
  return <Skeleton className={clsx('inline-block align-middle', className)} />;
}

/* -------------------------------------------------------------------------- */

export function EmptyState({
  title,
  description,
  action,
  icon,
  className,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
  icon?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={clsx('flex flex-col items-center px-6 py-12 text-center', className)}>
      {/*
        The icon gets a tinted well rather than floating loose.
        A 20px grey outline alone in the middle of an empty panel reads as
        something that failed to load, which is the one thing an empty state
        must not say — see the note at the top of this file.
      */}
      {icon && (
        <div className="mb-3 grid h-11 w-11 place-items-center rounded-2xl bg-surface-3/70 text-ink-3">
          {icon}
        </div>
      )}
      <p className="text-md font-medium text-ink">{title}</p>
      {description && (
        <p className="mt-1 max-w-sm text-base leading-relaxed text-ink-2">{description}</p>
      )}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

/**
 * A failure, stated as a failure.
 *
 * `role="alert"` so it is announced; a retry button so the dispatcher is not
 * told to reload the page; and the message from the API, because "bir hata
 * oluştu" tells the person on the phone to support absolutely nothing.
 */
export function ErrorState({
  title,
  message,
  onRetry,
  retrying,
  className,
  compact,
}: {
  title?: string;
  message?: string;
  onRetry?: () => void;
  retrying?: boolean;
  className?: string;
  compact?: boolean;
}) {
  const t = useT();
  return (
    <div
      role="alert"
      className={clsx(
        'flex items-start gap-3 rounded-xl bg-danger-bg ring-1 ring-inset ring-danger-ring',
        compact ? 'px-3 py-2.5' : 'px-4 py-3.5',
        className,
      )}
    >
      <svg viewBox="0 0 16 16" className="mt-0.5 h-4 w-4 shrink-0 text-danger" fill="none" aria-hidden>
        <circle cx="8" cy="8" r="6.75" stroke="currentColor" strokeWidth="1.5" />
        <path d="M8 4.75v3.75" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        <circle cx="8" cy="11.25" r="0.85" fill="currentColor" />
      </svg>
      <div className="min-w-0 flex-1">
        <p className="text-base font-medium text-danger">{title ?? t.common.loadFailed}</p>
        {message && <p className="mt-0.5 break-words text-sm text-danger/90">{message ?? t.common.staleData}</p>}
        {onRetry && (
          <Button
            size="sm"
            variant="secondary"
            loading={retrying}
            onClick={onRetry}
            className="mt-2"
          >
            {t.common.retry}
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * A banner for data that is on screen but no longer trustworthy — the socket
 * dropped, or a refetch failed while a previous result is still rendered.
 * Distinct from ErrorState: there IS data, it is simply old.
 */
export function StaleBanner({
  message,
  onRetry,
  className,
}: {
  message?: string;
  onRetry?: () => void;
  className?: string;
}) {
  const t = useT();
  return (
    <div
      role="status"
      aria-live="polite"
      className={clsx(
        // A floating pill rather than a full-width bar. It is now shown over the
        // map instead of above it, and a bar spanning the viewport would take a
        // band out of the one thing the dispatcher is looking at — to say that
        // the thing they are looking at has stopped updating, which is the worst
        // possible moment to cover it.
        'flex items-center gap-2 rounded-2xl bg-warn-bg px-3.5 py-2 text-sm text-warn shadow-float ring-1 ring-inset ring-delayed-ring/40',
        className,
      )}
    >
      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-current kh-pulse" aria-hidden />
      <span className="flex-1">{message}</span>
      {onRetry && (
        <button onClick={onRetry} className="shrink-0 font-medium underline underline-offset-2">
          {t.common.refresh}
        </button>
      )}
    </div>
  );
}

/**
 * Live connection indicator.
 *
 * Never colour alone: the detail page used to show an unlabelled 8px dot whose
 * only encoding was green versus grey — invisible to a deuteranope and to
 * anyone not looking directly at it, on the one screen where the question "is
 * this feed live or frozen?" matters most.
 */
export function ConnectionPill({ connected, className }: { connected: boolean; className?: string }) {
  const t = useT();
  return (
    <span
      aria-live="polite"
      className={clsx(
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs leading-none ring-1 ring-inset',
        connected
          ? 'bg-live-bg text-live ring-live-ring/40'
          : 'bg-danger-bg text-danger ring-danger-ring font-medium',
        className,
      )}
    >
      {/*
        A pip with a ring expanding out of it once every two seconds, rather
        than the whole dot fading in and out.

        A dispatcher has to be able to tell peripherally that data is still
        flowing without anything moving in the part of the screen they are
        reading, and a dot that pulses to 30% opacity is easy to mistake for one
        that has gone out. An expanding ring reads as a heartbeat and the dot
        underneath never dims.
      */}
      <span className="relative flex h-1.5 w-1.5 shrink-0" aria-hidden>
        {connected && (
          <span className="kh-ping absolute inset-0 rounded-full bg-current" />
        )}
        <span className="relative h-1.5 w-1.5 rounded-full bg-current" />
      </span>
      {connected ? t.common.live : t.common.offline}
    </span>
  );
}

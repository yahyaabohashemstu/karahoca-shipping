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
  return <div className={clsx('kh-skeleton rounded', className)} aria-hidden />;
}

/** Placeholder rows that keep the real row height, so nothing jumps on arrival. */
export function SkeletonList({ rows = 6, className }: { rows?: number; className?: string }) {
  return (
    <div className={clsx('divide-y divide-line', className)} aria-busy role="status">
      <span className="sr-only">{useT().common.loading}</span>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 px-4 py-3">
          <Skeleton className="h-2 w-2 rounded-full" />
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-3 w-28" />
            <Skeleton className="h-2.5 w-44" />
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
      {icon && <div className="mb-3 text-ink-3">{icon}</div>}
      <p className="text-md font-medium text-ink">{title}</p>
      {description && <p className="mt-1 max-w-sm text-base text-ink-2">{description}</p>}
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
        'flex items-start gap-3 rounded-md bg-danger-bg ring-1 ring-inset ring-danger-ring',
        compact ? 'px-3 py-2' : 'px-4 py-3',
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
        'flex items-center gap-2 bg-warn-bg px-3 py-1.5 text-sm text-warn ring-1 ring-inset ring-delayed-ring/40',
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
        'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs leading-none ring-1 ring-inset',
        connected
          ? 'bg-live-bg text-live ring-live-ring/40'
          : 'bg-danger-bg text-danger ring-danger-ring font-medium',
        className,
      )}
    >
      <span
        className={clsx('h-1.5 w-1.5 rounded-full bg-current', connected && 'kh-pulse')}
        aria-hidden
      />
      {connected ? t.common.live : t.common.offline}
    </span>
  );
}

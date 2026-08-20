'use client';

import clsx from 'clsx';

export function Card({
  className,
  children,
  padded = true,
}: {
  className?: string;
  children: React.ReactNode;
  padded?: boolean;
}) {
  return (
    <div
      className={clsx(
        // rounded-xl rather than -md. Cards now sit inside a sheet that is
        // itself rounded-2xl, and a tight radius nested inside a soft one reads
        // as a mistake rather than as a hierarchy.
        'rounded-xl bg-surface ring-1 ring-line shadow-xs',
        padded && 'p-4',
        className,
      )}
    >
      {children}
    </div>
  );
}

export function CardHeader({
  title,
  subtitle,
  actions,
  className,
}: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={clsx('flex items-start justify-between gap-4', className)}>
      <div className="min-w-0">
        <h2 className="truncate text-md font-semibold tracking-tight text-ink">{title}</h2>
        {subtitle && <p className="mt-0.5 truncate text-sm text-ink-2">{subtitle}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

/** A label/value pair. The workhorse of every detail panel. */
export function Row({
  label,
  value,
  loading,
  mono,
  className,
}: {
  label: string;
  value: React.ReactNode;
  loading?: boolean;
  mono?: boolean;
  className?: string;
}) {
  return (
    <div className={clsx('flex items-baseline justify-between gap-4 py-1', className)}>
      <dt className="shrink-0 text-sm text-ink-2">{label}</dt>
      <dd
        className={clsx(
          'min-w-0 truncate text-end text-base font-medium text-ink',
          mono && 'kh-num',
        )}
      >
        {/* A skeleton, not an em-dash. The detail page used to paint a
            convincing panel of "—" and "0 km" before the fetch resolved, which
            is indistinguishable from a driver who never started the app — and
            dispatchers phoned carriers about problems that did not exist. */}
        {loading ? <span className="kh-skeleton inline-block h-3 w-20 rounded-md align-middle" /> : value}
      </dd>
    </div>
  );
}

/** Big number with a caption. Used in the header stat strip. */
export function Stat({
  label,
  value,
  tone = 'neutral',
  loading,
  onClick,
  active,
}: {
  label: string;
  value: React.ReactNode;
  tone?: 'neutral' | 'warn' | 'danger' | 'success';
  loading?: boolean;
  onClick?: () => void;
  active?: boolean;
}) {
  const tones = {
    neutral: 'text-ink',
    warn: 'text-warn',
    danger: 'text-danger',
    success: 'text-success',
  } as const;

  /*
   * Centred, not end-aligned.
   *
   * These used to sit at the far right of a top bar where a ragged-right column
   * of numbers lined up against the edge. They are now tiles in a floating
   * cluster with air on both sides, and an end-aligned number inside a centred
   * tile looks like it has slipped.
   */
  const body = (
    <>
      <span className={clsx('kh-num text-md font-semibold leading-none', tones[tone])}>
        {loading ? <span className="kh-skeleton inline-block h-4 w-6 rounded-md align-middle" /> : value}
      </span>
      <span className="mt-1 whitespace-nowrap text-2xs uppercase tracking-wider text-ink-3">
        {label}
      </span>
    </>
  );

  if (!onClick) {
    return <span className="flex flex-col items-center px-2 py-1 leading-none">{body}</span>;
  }
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={clsx(
        'flex flex-col items-center rounded-xl px-2.5 py-1 leading-none transition-colors',
        active ? 'bg-brand-soft text-brand-text' : 'hover:bg-surface-3/70',
      )}
    >
      {body}
    </button>
  );
}

/** A hairline. Full-bleed by default; callers inset it when a panel already is. */
export function Divider({ className }: { className?: string }) {
  return <div className={clsx('h-px bg-line', className)} role="separator" />;
}

/** Page-level heading block. */
export function PageHeader({
  title,
  subtitle,
  actions,
  breadcrumb,
}: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
  breadcrumb?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3 border-b border-line px-5 py-4">
      <div className="min-w-0">
        {breadcrumb && <div className="mb-1 text-sm text-ink-3">{breadcrumb}</div>}
        <h1 className="truncate text-xl font-semibold tracking-tight text-ink">{title}</h1>
        {subtitle && <p className="mt-0.5 text-sm text-ink-2">{subtitle}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

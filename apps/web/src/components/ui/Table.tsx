'use client';

import clsx from 'clsx';
import { useT } from '@/lib/i18n';

/* =============================================================================
   Data table
   =============================================================================
   Built for scanning forty rows, not for reading prose. Sticky header, tabular
   digits in numeric columns, a whole-row link target, and — the part the old
   table lacked entirely — separate loading, error and empty bodies, so a failed
   query can never render as "Kayıt bulunamadı." A carrier claiming a shipment
   was never tracked is exactly the situation where that lie is most expensive.
   ========================================================================== */

export function Table({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    // The wrapper scrolls, not the page: a wide table on a narrow window must
    // never make the whole document scroll sideways.
    <div className={clsx('kh-scroll overflow-x-auto', className)}>
      <table className="w-full border-collapse text-base">{children}</table>
    </div>
  );
}

export function THead({ children }: { children: React.ReactNode }) {
  return (
    /*
     * The header is the one part of a table that also floats — it stays put
     * while forty rows scroll under it — so it gets the same translucent
     * treatment as the panels that float over the map. Same material, same
     * reason: what sits still while content moves beneath it should look like
     * it is above the content rather than part of it.
     */
    <thead className="sticky top-0 z-10 bg-surface-2/85 backdrop-blur-md supports-[backdrop-filter]:bg-surface-2/75">
      {children}
    </thead>
  );
}

export function TH({
  children,
  numeric,
  className,
  sort,
  onSort,
}: {
  children?: React.ReactNode;
  numeric?: boolean;
  className?: string;
  sort?: 'asc' | 'desc' | null;
  onSort?: () => void;
}) {
  const inner = (
    <span className={clsx('inline-flex items-center gap-1', numeric && 'flex-row-reverse')}>
      {children}
      {onSort && (
        <svg viewBox="0 0 10 12" className="h-2.5 w-2.5 shrink-0" fill="none" aria-hidden>
          <path
            d="M5 1.5 8 5H2z"
            fill="currentColor"
            className={sort === 'asc' ? 'opacity-100' : 'opacity-25'}
          />
          <path
            d="M5 10.5 2 7h6z"
            fill="currentColor"
            className={sort === 'desc' ? 'opacity-100' : 'opacity-25'}
          />
        </svg>
      )}
    </span>
  );

  return (
    <th
      scope="col"
      aria-sort={sort === 'asc' ? 'ascending' : sort === 'desc' ? 'descending' : undefined}
      className={clsx(
        'border-b border-line px-3.5 py-2.5 text-2xs font-semibold uppercase tracking-[0.12em] text-ink-3',
        numeric ? 'text-end' : 'text-start',
        onSort && 'cursor-pointer select-none hover:text-ink-2',
        className,
      )}
      onClick={onSort}
    >
      {inner}
    </th>
  );
}

export function TR({
  children,
  onClick,
  selected,
  className,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  selected?: boolean;
  className?: string;
}) {
  return (
    <tr
      onClick={onClick}
      // A clickable row must be reachable by keyboard. The old table put the
      // only link inside one cell, so tabbing through a hundred rows meant a
      // hundred stops before the pagination control.
      tabIndex={onClick ? 0 : undefined}
      role={onClick ? 'link' : undefined}
      onKeyDown={
        onClick
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onClick();
              }
            }
          : undefined
      }
      className={clsx(
        'border-b border-line/60 transition-colors',
        onClick && 'cursor-pointer hover:bg-surface-2/70 focus-visible:bg-surface-2',
        selected && 'bg-brand-soft hover:bg-brand-soft',
        className,
      )}
    >
      {children}
    </tr>
  );
}

export function TD({
  children,
  numeric,
  muted,
  className,
  colSpan,
}: {
  children?: React.ReactNode;
  numeric?: boolean;
  muted?: boolean;
  className?: string;
  colSpan?: number;
}) {
  return (
    <td
      colSpan={colSpan}
      className={clsx(
        'px-3.5 py-2.5 align-middle',
        numeric && 'kh-num text-end',
        muted && 'text-ink-2',
        className,
      )}
    >
      {children}
    </td>
  );
}

/** Full-width message row — used for the loading, error and empty bodies. */
export function TRMessage({
  colSpan,
  children,
  tone = 'neutral',
}: {
  colSpan: number;
  children: React.ReactNode;
  tone?: 'neutral' | 'danger';
}) {
  return (
    <tr>
      <td
        colSpan={colSpan}
        className={clsx(
          'px-4 py-10 text-center text-base',
          tone === 'danger' ? 'text-danger' : 'text-ink-2',
        )}
      >
        {children}
      </td>
    </tr>
  );
}

export function TableSkeletonRows({ rows = 8, cols }: { rows?: number; cols: number }) {
  return (
    <>
      {Array.from({ length: rows }).map((_, r) => (
        <tr key={r} className="border-b border-line/60">
          {Array.from({ length: cols }).map((_, c) => (
            <td key={c} className="px-3.5 py-2.5">
              <div
                className="kh-skeleton h-3 rounded-md"
                style={{ width: `${[70, 55, 80, 45, 60, 50, 65, 40][c % 8]}%` }}
              />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}

/* -------------------------------------------------------------------------- */

export function Pagination({
  total,
  limit,
  offset,
  onOffset,
}: {
  total: number;
  limit: number;
  offset: number;
  onOffset: (n: number) => void;
}) {
  const t = useT();
  if (total <= limit) return null;
  const from = offset + 1;
  const to = Math.min(offset + limit, total);
  const page = Math.floor(offset / limit) + 1;
  const pages = Math.ceil(total / limit);

  return (
    <div className="flex items-center justify-between gap-4 border-t border-line px-4 py-2 text-sm text-ink-2">
      <span className="kh-num">
        {from}–{to} / {total}
      </span>
      <div className="flex items-center gap-1">
        <button
          type="button"
          disabled={offset === 0}
          onClick={() => onOffset(Math.max(0, offset - limit))}
          className="rounded-lg px-2.5 py-1 transition-colors hover:bg-surface-2 disabled:opacity-40 disabled:hover:bg-transparent"
        >
          ‹ {t.common.previous}
        </button>
        <span className="kh-num px-2 tabular-nums">
          {page} / {pages}
        </span>
        <button
          type="button"
          disabled={to >= total}
          onClick={() => onOffset(offset + limit)}
          className="rounded-lg px-2.5 py-1 transition-colors hover:bg-surface-2 disabled:opacity-40 disabled:hover:bg-transparent"
        >
          {t.common.next} ›
        </button>
      </div>
    </div>
  );
}

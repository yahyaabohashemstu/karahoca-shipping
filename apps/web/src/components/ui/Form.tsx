'use client';

import { forwardRef, useId } from 'react';
import clsx from 'clsx';
import { useT } from '@/lib/i18n';

/* =============================================================================
   Form controls
   =============================================================================
   Every control shares one visual contract and one accessibility contract:
   a real <label> tied by id, an error rendered in text (not colour alone), and
   aria-invalid / aria-describedby wired so a screen reader announces the same
   thing a sighted user sees.
   ========================================================================== */

const CONTROL =
  'w-full rounded bg-surface text-ink placeholder:text-ink-3 ' +
  'ring-1 ring-inset ring-line-strong transition-shadow ' +
  'hover:ring-ink-3/60 ' +
  'focus:outline-none focus:ring-2 focus:ring-brand ' +
  'disabled:cursor-not-allowed disabled:bg-surface-2 disabled:text-ink-3';

const SIZED = 'h-8 px-2.5 text-base';

export function Field({
  label,
  hint,
  error,
  required,
  children,
  className,
  htmlFor,
}: {
  label: string;
  hint?: string;
  error?: string | null;
  required?: boolean;
  children: React.ReactNode;
  className?: string;
  htmlFor?: string;
}) {
  return (
    <div className={clsx('flex flex-col gap-1', className)}>
      <label htmlFor={htmlFor} className="flex items-baseline gap-1 text-sm font-medium text-ink-2">
        {label}
        {required && (
          <span className="text-danger" aria-hidden>
            *
          </span>
        )}
      </label>
      {children}
      {/* Hint disappears once there is an error: two lines of small grey text
          under a red-ringed input is how people miss the actual problem. */}
      {error ? (
        <p className="flex items-start gap-1 text-sm text-danger" role="alert">
          <span aria-hidden>⚠</span>
          {error}
        </p>
      ) : hint ? (
        <p className="text-sm text-ink-3">{hint}</p>
      ) : null}
    </div>
  );
}

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  hint?: string;
  error?: string | null;
  /** Right-aligned tabular digits, for plates, distances and counts. */
  numeric?: boolean;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { label, hint, error, numeric, className, id, required, ...rest },
  ref,
) {
  const auto = useId();
  const inputId = id ?? auto;
  const control = (
    <input
      ref={ref}
      id={inputId}
      required={required}
      aria-invalid={error ? true : undefined}
      aria-describedby={error ? `${inputId}-err` : undefined}
      className={clsx(
        CONTROL,
        SIZED,
        numeric && 'kh-num',
        error && 'ring-2 ring-danger focus:ring-danger',
        className,
      )}
      {...rest}
    />
  );
  if (!label) return control;
  return (
    <Field label={label} hint={hint} error={error} required={required} htmlFor={inputId}>
      {control}
    </Field>
  );
});

export interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  label?: string;
  hint?: string;
  error?: string | null;
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { label, hint, error, className, id, required, children, ...rest },
  ref,
) {
  const auto = useId();
  const selectId = id ?? auto;
  const control = (
    <div className="relative">
      <select
        ref={ref}
        id={selectId}
        required={required}
        aria-invalid={error ? true : undefined}
        className={clsx(
          CONTROL,
          SIZED,
          'cursor-pointer appearance-none pe-8',
          error && 'ring-2 ring-danger focus:ring-danger',
          className,
        )}
        {...rest}
      >
        {children}
      </select>
      {/* The native arrow is a different colour in every browser and does not
          follow the dark theme. */}
      <svg
        className="pointer-events-none absolute end-2 top-1/2 h-3 w-3 -translate-y-1/2 text-ink-3"
        viewBox="0 0 12 12"
        fill="none"
        aria-hidden
      >
        <path d="M3 4.5 6 7.5 9 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    </div>
  );
  if (!label) return control;
  return (
    <Field label={label} hint={hint} error={error} required={required} htmlFor={selectId}>
      {control}
    </Field>
  );
});

export const Textarea = forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement> & {
    label?: string;
    hint?: string;
    error?: string | null;
  }
>(function Textarea({ label, hint, error, className, id, required, rows = 3, ...rest }, ref) {
  const auto = useId();
  const taId = id ?? auto;
  const control = (
    <textarea
      ref={ref}
      id={taId}
      rows={rows}
      required={required}
      aria-invalid={error ? true : undefined}
      className={clsx(CONTROL, 'px-2.5 py-1.5 text-base', error && 'ring-2 ring-danger', className)}
      {...rest}
    />
  );
  if (!label) return control;
  return (
    <Field label={label} hint={hint} error={error} required={required} htmlFor={taId}>
      {control}
    </Field>
  );
});

/** A search box with the magnifier baked in and a clear affordance. */
export function SearchInput({
  value,
  onValueChange,
  placeholder,
  className,
}: {
  value: string;
  onValueChange: (v: string) => void;
  placeholder?: string;
  className?: string;
}) {
  const t = useT();
  return (
    <div className={clsx('relative', className)}>
      <svg
        className="pointer-events-none absolute start-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-3"
        viewBox="0 0 16 16"
        fill="none"
        aria-hidden
      >
        <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.6" />
        <path d="m10.5 10.5 3 3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
      <input
        type="search"
        value={value}
        onChange={(e) => onValueChange(e.target.value)}
        placeholder={placeholder ?? t.common.search}
        className={clsx(CONTROL, 'h-8 ps-8 pe-2.5 text-base', '[&::-webkit-search-cancel-button]:hidden')}
      />
      {value && (
        <button
          type="button"
          onClick={() => onValueChange('')}
          aria-label={t.common.clearSearch}
          className="absolute end-1.5 top-1/2 grid h-5 w-5 -translate-y-1/2 place-items-center rounded text-ink-3 hover:bg-surface-3 hover:text-ink"
        >
          <svg viewBox="0 0 12 12" className="h-3 w-3" fill="none" aria-hidden>
            <path d="m3 3 6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </button>
      )}
    </div>
  );
}

/** Segmented control — for small, mutually exclusive filters. */
export function SegmentedControl<T extends string>({
  value,
  onChange,
  options,
  className,
  label,
}: {
  value: T;
  onChange: (v: T) => void;
  options: Array<{ value: T; label: string }>;
  className?: string;
  label?: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={clsx('inline-flex rounded bg-surface-2 p-0.5 ring-1 ring-inset ring-line', className)}
    >
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(o.value)}
            className={clsx(
              'rounded-sm px-2.5 py-1 text-sm font-medium transition-colors',
              active
                ? 'bg-surface text-ink shadow-xs'
                : 'text-ink-2 hover:text-ink',
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

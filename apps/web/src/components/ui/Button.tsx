'use client';

import { forwardRef } from 'react';
import clsx from 'clsx';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'success';
type Size = 'sm' | 'md' | 'lg';

const BASE =
  'inline-flex items-center justify-center gap-1.5 rounded font-medium whitespace-nowrap ' +
  'transition-colors select-none ' +
  // Every button in the old build was click-only feedback: no active state, no
  // disabled state, no focus ring. A dispatcher double-clicked "Teslim edildi"
  // because nothing acknowledged the first press.
  'focus-visible:outline-2 focus-visible:outline-offset-2 ' +
  'disabled:cursor-not-allowed disabled:opacity-55';

/*
 * `text-ink-inverse`, never `text-white`.
 *
 * The dark theme lifts every accent colour so it reads against a dark surface —
 * brand goes from #1460c8 to #5298ff. White text on that measures 2.88:1, a
 * clear WCAG AA failure on the most-clicked control in the product. Because
 * --kh-text-inverse is white in the light theme and near-black in the dark one,
 * one class gives 5.9:1 on light and 6.7:1 on dark with no per-theme override.
 */
const VARIANTS: Record<Variant, string> = {
  primary:
    'bg-brand text-ink-inverse hover:bg-brand-hover active:bg-brand-hover ' +
    'shadow-xs disabled:hover:bg-brand',
  secondary:
    'bg-surface text-ink ring-1 ring-inset ring-line-strong ' +
    'hover:bg-surface-2 active:bg-surface-3 disabled:hover:bg-surface',
  ghost:
    'bg-transparent text-ink-2 hover:bg-surface-2 hover:text-ink active:bg-surface-3',
  danger:
    'bg-danger text-ink-inverse hover:brightness-110 active:brightness-95 shadow-xs',
  success:
    'bg-success text-ink-inverse hover:brightness-110 active:brightness-95 shadow-xs',
};

const SIZES: Record<Size, string> = {
  sm: 'h-7 px-2.5 text-sm',
  md: 'h-8 px-3 text-base',
  lg: 'h-10 px-4 text-base',
};

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  /** Shows a spinner and blocks further clicks. Use for anything that POSTs. */
  loading?: boolean;
  block?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', loading, block, className, children, disabled, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      // `loading` must disable as well as decorate. The old detail page fired a
      // second POST on the impatient second click.
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={clsx(BASE, VARIANTS[variant], SIZES[size], block && 'w-full', className)}
      {...rest}
    >
      {loading && <Spinner className="h-3.5 w-3.5" />}
      {children}
    </button>
  );
});

export function Spinner({ className }: { className?: string }) {
  return (
    <svg className={clsx('animate-spin', className)} viewBox="0 0 16 16" fill="none" aria-hidden>
      <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2.5" />
      <path
        d="M14.5 8A6.5 6.5 0 0 0 8 1.5"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** A link that looks like a button. Same visual contract, correct semantics. */
export function ButtonLink({
  variant = 'secondary',
  size = 'md',
  block,
  className,
  children,
  ...rest
}: { variant?: Variant; size?: Size; block?: boolean } & React.AnchorHTMLAttributes<HTMLAnchorElement>) {
  return (
    <a
      className={clsx(BASE, VARIANTS[variant], SIZES[size], block && 'w-full', className)}
      {...rest}
    >
      {children}
    </a>
  );
}

/** Square icon-only button. Always needs an aria-label; the type enforces it. */
export function IconButton({
  label,
  variant = 'ghost',
  size = 'md',
  className,
  children,
  ...rest
}: { label: string; variant?: Variant; size?: Size } & Omit<
  React.ButtonHTMLAttributes<HTMLButtonElement>,
  'aria-label'
>) {
  const box = size === 'sm' ? 'h-7 w-7' : size === 'lg' ? 'h-10 w-10' : 'h-8 w-8';
  return (
    <button
      aria-label={label}
      title={label}
      className={clsx(BASE, VARIANTS[variant], box, 'p-0', className)}
      {...rest}
    >
      {children}
    </button>
  );
}

'use client';

import clsx from 'clsx';

/* =============================================================================
   Two ways an interface teaches itself
   =============================================================================
   Both of these exist because this product is used for eight hours a day by
   three people, and an operations console that can only be worked by reading
   labels is a console nobody ever gets fast at.

   `Kbd` names a shortcut beside the thing the shortcut does. `Tip` names an
   icon-only control on hover and on focus. Between them they are the entire
   documentation of the dashboard's keyboard and its dock, delivered at the
   moment somebody is looking at the control rather than in a help screen
   nobody opens.
   ========================================================================== */

/**
 * A keyboard hint.
 *
 * Shown next to the thing the key does rather than hidden in a help screen. It
 * is the only way an interface teaches its own shortcuts to someone who was
 * never going to read documentation, and this product is used for eight hours a
 * day by three people who will learn every one of them in a week.
 */
export function Kbd({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <kbd
      className={clsx(
        'inline-flex h-[1.15rem] min-w-[1.15rem] items-center justify-center rounded border',
        'border-line bg-surface-2 px-1 font-sans text-2xs font-medium text-ink-3',
        className,
      )}
      dir="ltr"
    >
      {children}
    </kbd>
  );
}

/**
 * The label that appears beside an icon-only control.
 *
 * An interface made of icons is unreadable on day one and unbeatable by week
 * two, and this is what carries somebody across the gap. Three properties make
 * it work rather than annoy:
 *
 *   It flies out along the inline axis, away from the edge its control is
 *   docked to, so it never leaves the viewport and in Arabic it appears on the
 *   opposite side without a second implementation.
 *
 *   It is `pointer-events-none`, so it can never intercept the click aimed at
 *   the button it is describing — which is the single most common defect in
 *   hand-rolled tooltips.
 *
 *   It answers focus as well as hover, so it is not invisible to somebody
 *   working the dock from the keyboard.
 *
 * The parent must carry `group` and `relative`.
 */
export function Tip({
  children,
  side = 'end',
}: {
  children: React.ReactNode;
  side?: 'start' | 'end';
}) {
  return (
    <span
      role="tooltip"
      className={clsx(
        'kh-glass pointer-events-none absolute top-1/2 z-popover -translate-y-1/2',
        side === 'end' ? 'start-full ms-2.5' : 'end-full me-2.5',
        'whitespace-nowrap rounded-lg px-2 py-1 text-2xs font-medium text-ink',
        'opacity-0 transition-opacity duration-100',
        'group-hover:opacity-100 group-focus-visible:opacity-100 group-focus-within:opacity-100',
      )}
    >
      {children}
    </span>
  );
}

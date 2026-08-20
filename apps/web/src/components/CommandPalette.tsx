'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { api } from '@/lib/api';
import { searchFold } from '@/lib/search';
import { displayState, useNow } from '@/lib/signal';
import { useT, type Dictionary } from '@/lib/i18n';
import { SignalBadge } from './ui/Badge';
import { Kbd } from './ui/Hint';
import {
  IconCarrier,
  IconChart,
  IconCustomer,
  IconInstall,
  IconMap,
  IconOrder,
  IconPlus,
  IconRoute,
  IconSearch,
} from './shell/Icons';

/* =============================================================================
   The command palette
   =============================================================================
   One keystroke, from any screen, to any lorry — or any page, or the two things
   a dispatcher creates.

   This exists for one scenario in particular. The telephone rings, a customer
   asks about an order, and the dispatcher has ten seconds to say where it is.
   Before this, answering meant reaching the map, finding the search box on it,
   and typing; from the carriers screen it meant navigating first. Now it is
   Ctrl+K and the order number, from wherever they happen to be, including from
   inside another text field.

   Deliberately NOT fuzzy matching. A dispatcher types the first four characters
   of a plate or an order number, and a fuzzy matcher answers that with every
   record containing those letters in that order anywhere — which for "27 AB"
   is most of the fleet. Substring matching over folded text is what makes the
   first result the right one, which is the only result that matters when the
   customer is already talking.
   ========================================================================== */

/** How many lorries to list before anything has been typed. */
const RESTING_VEHICLES = 6;

interface Item {
  id: string;
  label: string;
  /** The second line — what distinguishes two lorries carrying similar loads. */
  detail?: string;
  badge?: React.ReactNode;
  icon: React.ReactNode;
  run: () => void;
  /** Everything matched against, folded once at build time rather than per keystroke. */
  haystack: string;
}

interface Group {
  key: string;
  heading: string;
  items: Item[];
}

export function CommandPalette({
  open,
  onClose,
  modKey,
}: {
  open: boolean;
  onClose: () => void;
  modKey: string;
}) {
  const t = useT();
  const router = useRouter();
  const now = useNow();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  /*
   * Fetched only while the palette is open, and under the same cache key the
   * dashboard uses. On the map that means the palette opens with data already
   * in hand and issues no request at all; anywhere else it costs one small
   * fetch at the moment somebody asked to search.
   */
  const { data, isLoading } = useQuery({
    queryKey: ['live-fleet'],
    queryFn: api.liveFleet,
    enabled: open,
  });

  /*
   * A fresh palette every time, focused immediately.
   *
   * Reopening onto the last query is the behaviour of a search box, not of a
   * command bar — and the last query is nearly always the thing that was just
   * dealt with.
   *
   * The focus call is direct, not wrapped in requestAnimationFrame. An effect
   * already runs after the DOM has been committed, so the input exists by the
   * time this line does; the frame callback bought nothing and cost the one
   * case that matters — a browser that is not producing frames never runs it,
   * and the palette opens with the keyboard pointing at nothing. Caught exactly
   * that way, on a tab that was not compositing.
   */
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActive(0);
    inputRef.current?.focus();
  }, [open]);

  const groups = useMemo<Group[]>(() => {
    const go = (href: string) => () => {
      onClose();
      router.push(href);
    };

    const vehicles: Item[] = (data?.positions ?? []).map((p) => {
      const { state } = displayState(p, now);
      const name = p.vehiclePlate ?? p.reference;
      return {
        id: `v:${p.sessionId}`,
        label: name,
        detail: [p.orderNumber, p.customerName, p.carrierName].filter(Boolean).join(' · '),
        badge: <SignalBadge state={state} />,
        icon: <IconCarrier />,
        /*
         * Navigating to the record rather than selecting the lorry on the map.
         *
         * The palette is reachable from seven screens and only one of them has a
         * map on it, so "select it where you are" would mean something different
         * on every screen. The record is the same answer everywhere, it carries
         * its own map and route history, and it is a URL — which means the
         * dispatcher can send it to somebody.
         */
        run: go(`/sessions/${p.sessionId}`),
        haystack: searchFold(
          [
            name,
            p.reference,
            p.orderNumber,
            p.customerName,
            p.carrierName,
            p.driverName,
            p.driverPhone,
          ]
            .filter(Boolean)
            .join(' '),
        ),
      };
    });

    const pages: Array<[keyof Dictionary['nav'], string, React.ReactNode]> = [
      ['map', '/', <IconMap key="i" />],
      ['sessions', '/sessions', <IconRoute key="i" />],
      ['orders', '/orders', <IconOrder key="i" />],
      ['customers', '/customers', <IconCustomer key="i" />],
      ['carriers', '/carriers', <IconCarrier key="i" />],
      ['performance', '/performance', <IconChart key="i" />],
    ];

    const actions: Item[] = [
      {
        id: 'a:session',
        label: t.palette.newSession,
        icon: <IconPlus />,
        run: go('/sessions/new'),
        haystack: searchFold(`${t.palette.newSession} ${t.nav.sessions}`),
      },
      {
        id: 'a:order',
        label: t.palette.newOrder,
        icon: <IconPlus />,
        run: go('/orders/new'),
        haystack: searchFold(`${t.palette.newOrder} ${t.nav.orders}`),
      },
      {
        id: 'a:app',
        label: t.shell.driverApp,
        // window.open rather than router.push: /app is served by the API and is
        // not a route this router knows about, so a client-side navigation
        // would land on a 404 rendered by Next.
        icon: <IconInstall />,
        run: () => {
          onClose();
          window.open('/app', '_blank', 'noreferrer');
        },
        haystack: searchFold(t.shell.driverApp),
      },
    ];

    const q = searchFold(query.trim());
    const keep = (items: Item[]) => (q ? items.filter((i) => i.haystack.includes(q)) : items);

    const out: Group[] = [];
    const matchedVehicles = keep(vehicles);
    if (matchedVehicles.length > 0) {
      out.push({
        key: 'vehicles',
        heading: t.palette.groupVehicles,
        // With nothing typed this is a shortlist, not the fleet: a palette that
        // opens onto forty rows has buried the two commands underneath them.
        items: q ? matchedVehicles : matchedVehicles.slice(0, RESTING_VEHICLES),
      });
    }

    const matchedPages = keep(
      pages.map(([key, href, icon]) => ({
        id: `p:${href}`,
        label: t.nav[key],
        icon,
        run: go(href),
        haystack: searchFold(t.nav[key]),
      })),
    );
    if (matchedPages.length > 0) {
      out.push({ key: 'pages', heading: t.palette.groupPages, items: matchedPages });
    }

    const matchedActions = keep(actions);
    if (matchedActions.length > 0) {
      out.push({ key: 'actions', heading: t.palette.groupActions, items: matchedActions });
    }
    return out;
  }, [data, now, query, router, onClose, t]);

  // One flat sequence, because the arrow keys walk past headings as though they
  // were not there — which is what a reader expects and what a screen reader's
  // active-descendant model requires.
  const flat = useMemo(() => groups.flatMap((g) => g.items), [groups]);

  // Clamped rather than reset. Typing one more character usually shortens the
  // list, and snapping the highlight back to the top each time makes the whole
  // palette feel like it is fighting the typist.
  useEffect(() => {
    setActive((i) => (flat.length === 0 ? 0 : Math.min(i, flat.length - 1)));
  }, [flat.length]);

  // Keep the highlighted row on screen when the arrow keys walk off the edge.
  useEffect(() => {
    if (!open) return;
    const node = listRef.current?.querySelector<HTMLElement>('[data-active="true"]');
    node?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  if (!open) return null;

  const move = (delta: number) => {
    if (flat.length === 0) return;
    // Wrapping, both ways. Holding ArrowUp from the first row should reach the
    // last, not stall silently against an invisible wall.
    setActive((i) => (i + delta + flat.length) % flat.length);
  };

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      move(1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      move(-1);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      flat[active]?.run();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    }
  }

  let index = -1;

  return (
    <div className="fixed inset-0 z-palette" role="presentation">
      {/*
        The scrim is deliberately light and blurred rather than a heavy black.
        Behind it is a live map that is still tracking; dimming it to near-black
        says the product has stopped, which it has not.
      */}
      <button
        type="button"
        aria-label={t.common.close}
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-scrim/25 backdrop-blur-[2px]"
      />

      <div
        role="dialog"
        aria-modal="true"
        aria-label={t.palette.title}
        onKeyDown={onKeyDown}
        className="kh-glass kh-pop-in absolute inset-x-3 top-[11vh] mx-auto flex max-h-[70vh] w-[min(41rem,calc(100vw-1.5rem))] flex-col overflow-hidden rounded-3xl"
      >
        <div className="flex shrink-0 items-center gap-2.5 border-b border-line px-4">
          <span className="text-ink-3" aria-hidden>
            <IconSearch />
          </span>
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t.palette.placeholder}
            aria-label={t.palette.placeholder}
            // The listbox lives in a sibling; aria-activedescendant is how a
            // screen reader is told which row the arrow keys are on while focus
            // stays in the field where the typing goes.
            aria-activedescendant={flat[active] ? `kh-cmd-${flat[active].id}` : undefined}
            aria-controls="kh-cmd-list"
            role="combobox"
            aria-expanded
            autoComplete="off"
            spellCheck={false}
            className="h-12 min-w-0 flex-1 bg-transparent text-md text-ink outline-none placeholder:text-ink-3"
          />
          <Kbd className="shrink-0">esc</Kbd>
        </div>

        <div
          ref={listRef}
          id="kh-cmd-list"
          role="listbox"
          aria-label={t.palette.title}
          className="kh-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain p-1.5"
        >
          {flat.length === 0 ? (
            <p className="px-3 py-8 text-center text-sm text-ink-3">
              {isLoading ? t.common.loading : t.palette.empty}
            </p>
          ) : (
            groups.map((group) => (
              <div key={group.key} className="mb-1 last:mb-0">
                <p
                  aria-hidden
                  className="px-2.5 pb-1 pt-2 text-2xs font-semibold uppercase tracking-[0.14em] text-ink-3"
                >
                  {group.heading}
                </p>
                {group.items.map((item) => {
                  index += 1;
                  const isActive = index === active;
                  const at = index;
                  return (
                    <button
                      key={item.id}
                      id={`kh-cmd-${item.id}`}
                      role="option"
                      aria-selected={isActive}
                      data-active={isActive}
                      type="button"
                      // Pointer, not mouse: a dispatcher on the warehouse tablet
                      // is using a finger, and mouseenter never fires there.
                      onPointerMove={() => setActive(at)}
                      onClick={item.run}
                      className={clsx(
                        'flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-start transition-colors',
                        isActive ? 'bg-brand-soft text-ink' : 'text-ink-2 hover:bg-surface-3/60',
                      )}
                    >
                      <span className={clsx('shrink-0', isActive ? 'text-brand-text' : 'text-ink-3')}>
                        {item.icon}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="kh-num block truncate font-medium text-ink">
                          {item.label}
                        </span>
                        {item.detail && (
                          <span className="block truncate text-sm text-ink-3">{item.detail}</span>
                        )}
                      </span>
                      {item.badge}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>

        {/* The three keys this dialog responds to, shown rather than assumed. */}
        <div className="flex shrink-0 items-center gap-3 border-t border-line px-4 py-2 text-2xs text-ink-3">
          <span className="flex items-center gap-1">
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd>
            {t.palette.hintMove}
          </span>
          <span className="flex items-center gap-1">
            <Kbd>↵</Kbd>
            {t.palette.hintOpen}
          </span>
          <span className="ms-auto flex items-center gap-1">
            <Kbd>{modKey}K</Kbd>
          </span>
        </div>
      </div>
    </div>
  );
}

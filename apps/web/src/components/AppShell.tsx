'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import clsx from 'clsx';
import { disconnectRealtime } from '@/lib/useRealtime';
import { tokens } from '@/lib/api';
import { LOCALES, LOCALE_NAME, useI18n, useT, type Dictionary } from '@/lib/i18n';
import { useTheme } from '@/lib/theme';
import { IconButton } from './ui/Button';
import { AlertCentre } from './AlertCentre';
import { DiagnosticsLog } from './DiagnosticsLog';

/* =============================================================================
   Application shell
   =============================================================================
   The previous build had no navigation at all — one "Oturumlar" link in the
   corner of the dashboard, and no route to anything else, because nothing else
   existed. Half the API had no UI.

   The chrome is one 44px bar and nothing else. On the live map that bar is the
   only pixel not spent on the map, which is the point: the map is the product,
   the navigation is plumbing.
   ========================================================================== */

/*
 * Routing only. The labels live in the dictionary and are looked up by `key`,
 * because a module-level array is evaluated once at import and cannot see the
 * language — a label written here would be Turkish for every reader, for ever.
 */
const NAV: Array<{ href: string; key: keyof Dictionary['nav']; exact?: boolean }> = [
  { href: '/', key: 'map', exact: true },
  { href: '/sessions', key: 'sessions' },
  { href: '/orders', key: 'orders' },
  { href: '/customers', key: 'customers' },
  { href: '/carriers', key: 'carriers' },
  { href: '/performance', key: 'performance' },
];

export function AppShell({
  children,
  /** The live map manages its own scrolling and must not be inside a scroll box. */
  fill,
  right,
}: {
  children: React.ReactNode;
  fill?: boolean;
  right?: React.ReactNode;
}) {
  return (
    <div className="flex h-screen flex-col bg-bg">
      <TopBar right={right} />
      <div className={clsx('flex min-h-0 flex-1 flex-col', !fill && 'kh-scroll overflow-y-auto')}>
        {children}
      </div>
    </div>
  );
}

function TopBar({ right }: { right?: React.ReactNode }) {
  const pathname = usePathname();
  const t = useT();

  return (
    <header className="flex h-11 shrink-0 items-center gap-1 border-b border-line bg-surface px-3">
      <Link
        href="/"
        className="me-3 flex items-baseline gap-2 rounded px-1 py-0.5"
        aria-label={t.shell.brandAria}
      >
        <span className="text-sm font-bold uppercase tracking-[0.18em] text-brand">KaraHoca</span>
        <span className="hidden text-2xs uppercase tracking-wider text-ink-3 lg:inline">
          {t.shell.brandSub}
        </span>
      </Link>

      <nav className="kh-scroll flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
        {NAV.map((item) => {
          const active = item.exact
            ? pathname === item.href
            : pathname === item.href || pathname.startsWith(`${item.href}/`);
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? 'page' : undefined}
              className={clsx(
                'relative whitespace-nowrap rounded px-2.5 py-1.5 text-base transition-colors',
                active
                  ? 'font-medium text-ink'
                  : 'text-ink-2 hover:bg-surface-2 hover:text-ink',
              )}
            >
              {t.nav[item.key]}
              {/* An underline, not a filled pill: the active item should read as
                  a tab, and a pill competes with the status badges below it. */}
              {active && (
                <span className="absolute inset-x-2 -bottom-[7px] h-0.5 rounded-full bg-brand" />
              )}
            </Link>
          );
        })}
      </nav>

      <div className="flex shrink-0 items-center gap-2 ps-2">
        {right}
        {/*
          The driver app's install page. Reachable from every screen because the
          moment a dispatcher needs it is never predictable — a driver rings
          from a yard with a phone that has no app on it.

          A plain <a>, not next/link: /app is served by the API, not by this
          Next router, so a client-side navigation would 404.
        */}
        <a
          href="/app"
          target="_blank"
          rel="noreferrer"
          title={t.shell.driverAppTitle}
          className="hidden whitespace-nowrap rounded px-2 py-1.5 text-2xs uppercase tracking-wider text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink md:inline"
        >
          {t.shell.driverApp}
        </a>
        {/* The exception desk, on every screen. An alert that only reaches
            the dispatcher who already has that truck's page open reaches
            nobody at 02:00 on the Habur road. */}
        <AlertCentre />
        {/* Renders nothing until a request actually fails. */}
        <DiagnosticsLog />
        <LanguagePicker />
        <ThemeToggle />
        <SignOut />
      </div>
    </header>
  );
}

/**
 * Language, in the languages themselves.
 *
 * A <select> rather than the icon buttons beside it, and for once that is the
 * accessible choice as well as the cheap one: three options do not fit an icon,
 * a native select is reachable by keyboard and screen reader without any of the
 * focus management a custom menu needs, and on a phone the operating system
 * renders it as a proper picker.
 *
 * Each option carries its own lang, so a browser lays "العربية" out
 * right-to-left inside a left-to-right menu instead of mangling it, and a
 * screen reader set to Turkish does not read the Arabic name as nonsense.
 */
function LanguagePicker() {
  const { locale, setLocale } = useI18n();
  const t = useT();

  return (
    <label className="relative">
      <span className="sr-only">{t.shell.language}</span>
      <select
        value={locale}
        onChange={(event) => setLocale(event.target.value as (typeof LOCALES)[number])}
        title={t.shell.language}
        className="h-8 cursor-pointer rounded border border-line bg-surface px-1.5 text-2xs text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand"
      >
        {LOCALES.map((option) => (
          <option key={option} value={option} lang={option}>
            {LOCALE_NAME[option]}
          </option>
        ))}
      </select>
    </label>
  );
}

function ThemeToggle() {
  const { pref, resolved, setPref } = useTheme();
  const t = useT();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // Rendering the icon before mount would make the server's guess visible for
  // one frame and produce a hydration mismatch warning.
  if (!mounted) return <span className="h-8 w-8" />;

  const next = pref === 'system' ? (resolved === 'dark' ? 'light' : 'dark') : pref === 'dark' ? 'light' : 'dark';
  const label =
    pref === 'system'
      ? t.shell.themeSystem(
          resolved === 'dark' ? t.shell.themeResolvedDark : t.shell.themeResolvedLight,
        )
      : pref === 'dark'
        ? t.shell.themeDark
        : t.shell.themeLight;

  return (
    <IconButton
      label={label}
      size="sm"
      onClick={() => setPref(next)}
      onDoubleClick={() => setPref('system')}
    >
      {resolved === 'dark' ? (
        <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" aria-hidden>
          <path
            d="M13.2 9.8A5.6 5.6 0 0 1 6.2 2.8a5.6 5.6 0 1 0 7 7Z"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinejoin="round"
          />
        </svg>
      ) : (
        <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" aria-hidden>
          <circle cx="8" cy="8" r="3.1" stroke="currentColor" strokeWidth="1.4" />
          <path
            d="M8 1v1.6M8 13.4V15M15 8h-1.6M2.6 8H1m11.95-4.95-1.13 1.13M4.18 11.82l-1.13 1.13m9.9 0-1.13-1.13M4.18 4.18 3.05 3.05"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
          />
        </svg>
      )}
    </IconButton>
  );
}

function SignOut() {
  const router = useRouter();
  const t = useT();
  return (
    <IconButton
      label={t.shell.signOut}
      size="sm"
      onClick={() => {
        // Kill the socket before clearing tokens: otherwise it keeps retrying
        // with a dead credential until the page unloads.
        disconnectRealtime();
        tokens.clear();
        router.replace('/login');
      }}
    >
      <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" aria-hidden>
        <path
          d="M6.5 2.5h-3v11h3"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path d="M9.5 11 12.5 8 9.5 5M12.5 8H6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </IconButton>
  );
}

/**
 * Client-side auth gate.
 *
 * The old pages each ran `useEffect(() => { if (!tokens.access) location.href = '/login' })`
 * and rendered their content in the meantime — a flash of the dispatcher
 * dashboard, complete with a failing API call, before the redirect landed.
 * Here nothing renders until the check has run.
 */
export function useRequireAuth(): boolean {
  const router = useRouter();
  const [ok, setOk] = useState<boolean | null>(null);

  useEffect(() => {
    if (tokens.access) {
      setOk(true);
    } else {
      setOk(false);
      router.replace('/login');
    }
  }, [router]);

  return ok === true;
}

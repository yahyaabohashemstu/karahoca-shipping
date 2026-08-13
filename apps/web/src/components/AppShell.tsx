'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import clsx from 'clsx';
import { disconnectRealtime } from '@/lib/useRealtime';
import { tokens } from '@/lib/api';
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

const NAV = [
  { href: '/', label: 'Canlı harita', exact: true },
  { href: '/sessions', label: 'Oturumlar' },
  { href: '/orders', label: 'Siparişler' },
  { href: '/customers', label: 'Müşteriler' },
  { href: '/carriers', label: 'Nakliyeciler' },
  { href: '/performance', label: 'Performans' },
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

  return (
    <header className="flex h-11 shrink-0 items-center gap-1 border-b border-line bg-surface px-3">
      <Link
        href="/"
        className="mr-3 flex items-baseline gap-2 rounded px-1 py-0.5"
        aria-label="KaraHoca Sevkiyat Takip Merkezi"
      >
        <span className="text-sm font-bold uppercase tracking-[0.18em] text-brand">KaraHoca</span>
        <span className="hidden text-2xs uppercase tracking-wider text-ink-3 lg:inline">
          Sevkiyat Takip
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
              {item.label}
              {/* An underline, not a filled pill: the active item should read as
                  a tab, and a pill competes with the status badges below it. */}
              {active && (
                <span className="absolute inset-x-2 -bottom-[7px] h-0.5 rounded-full bg-brand" />
              )}
            </Link>
          );
        })}
      </nav>

      <div className="flex shrink-0 items-center gap-2 pl-2">
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
          title="Sürücü uygulamasının kurulum sayfası — track.karahoca.com/app"
          className="hidden whitespace-nowrap rounded px-2 py-1.5 text-2xs uppercase tracking-wider text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink md:inline"
        >
          Sürücü uygulaması
        </a>
        {/* The exception desk, on every screen. An alert that only reaches
            the dispatcher who already has that truck's page open reaches
            nobody at 02:00 on the Habur road. */}
        <AlertCentre />
        {/* Renders nothing until a request actually fails. */}
        <DiagnosticsLog />
        <ThemeToggle />
        <SignOut />
      </div>
    </header>
  );
}

function ThemeToggle() {
  const { pref, resolved, setPref } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // Rendering the icon before mount would make the server's guess visible for
  // one frame and produce a hydration mismatch warning.
  if (!mounted) return <span className="h-8 w-8" />;

  const next = pref === 'system' ? (resolved === 'dark' ? 'light' : 'dark') : pref === 'dark' ? 'light' : 'dark';
  const label =
    pref === 'system'
      ? `Sistem teması (${resolved === 'dark' ? 'koyu' : 'açık'}) — değiştirmek için tıklayın`
      : pref === 'dark'
        ? 'Koyu tema — açığa geç'
        : 'Açık tema — koyuya geç';

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
  return (
    <IconButton
      label="Oturumu kapat"
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

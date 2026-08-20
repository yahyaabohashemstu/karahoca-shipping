'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import clsx from 'clsx';
import { disconnectRealtime } from '@/lib/useRealtime';
import { tokens } from '@/lib/api';
import { LOCALES, LOCALE_NAME, useI18n, useT, type Dictionary, type Locale } from '@/lib/i18n';
import { useTheme } from '@/lib/theme';
import { AlertCentre } from '../AlertCentre';
import { DiagnosticsLog } from '../DiagnosticsLog';
import {
  IconCarrier,
  IconChart,
  IconCustomer,
  IconInstall,
  IconMap,
  IconMoon,
  IconOrder,
  IconRoute,
  IconSearch,
  IconSignOut,
  IconSun,
} from './Icons';
import { Kbd, Tip } from '../ui/Hint';

/* =============================================================================
   The navigation dock
   =============================================================================
   A vertical column pinned to the inline-start edge, floating clear of all four
   sides, with the map running underneath and around it.

   It replaces a full-width bar across the top, and the reason is the map. A bar
   spanning the viewport takes a horizontal band out of the one thing this
   product is — and it takes it from the top, which on a corridor running
   north-west to south-east is exactly where the lorries are. A column takes a
   3.4rem strip out of the inline-start edge instead, which on this geography is
   the Mediterranean.

   Everything a dispatcher reaches without thinking lives here: the six
   destinations, the exception desk, and the three controls that change how the
   product looks rather than what it shows. Nothing else. The dock is the one
   piece of chrome that is present on every screen, so anything added to it is
   added to every screen.
   ========================================================================== */

/*
 * Routing and iconography only. The labels are looked up by `key` at render,
 * because a module-level array is evaluated once at import and cannot see the
 * language — a label written here would be Turkish for every reader, for ever.
 */
const NAV: Array<{
  href: string;
  key: keyof Dictionary['nav'];
  Icon: (props: { className?: string }) => React.ReactElement;
  exact?: boolean;
}> = [
  { href: '/', key: 'map', Icon: IconMap, exact: true },
  { href: '/sessions', key: 'sessions', Icon: IconRoute },
  { href: '/orders', key: 'orders', Icon: IconOrder },
  { href: '/customers', key: 'customers', Icon: IconCustomer },
  { href: '/carriers', key: 'carriers', Icon: IconCarrier },
  { href: '/performance', key: 'performance', Icon: IconChart },
];

export function NavDock({
  onOpenPalette,
  modKey,
}: {
  onOpenPalette: () => void;
  modKey: string;
}) {
  const pathname = usePathname();
  const t = useT();

  return (
    <nav
      aria-label={t.shell.navigation}
      className="kh-glass kh-rail-in fixed bottom-3 start-3 top-3 z-dock flex w-[3.8rem] flex-col items-center rounded-2xl py-2.5"
    >
      <BrandMark />

      <div className="my-2 h-px w-6 shrink-0 bg-line" aria-hidden />

      <DockButton label={`${t.shell.quickFind}  ${modKey}K`} onClick={onOpenPalette}>
        <IconSearch />
      </DockButton>

      <ul className="mt-1 flex flex-col items-center gap-0.5">
        {NAV.map((item) => {
          const active = item.exact
            ? pathname === item.href
            : pathname === item.href || pathname.startsWith(`${item.href}/`);
          return (
            <li key={item.href}>
              <DockLink href={item.href} label={t.nav[item.key]} active={active}>
                <item.Icon />
              </DockLink>
            </li>
          );
        })}
      </ul>

      {/* Pushes everything below it to the bottom of the column. */}
      <div className="flex-1" aria-hidden />

      <div className="flex flex-col items-center gap-0.5">
        {/*
          The driver app's install page, reachable from every screen.

          A plain <a>, not next/link: /app is served by the API, not by this
          Next router, so a client-side navigation would 404. It opens in a new
          tab because the moment a dispatcher needs it is a telephone call from
          a yard, and losing the screen they were working on to answer it is how
          the call takes twice as long.
        */}
        <a
          href="/app"
          target="_blank"
          rel="noreferrer"
          aria-label={t.shell.driverApp}
          className={clsx(TILE, TILE_IDLE)}
        >
          <IconInstall />
          <Tip>{t.shell.driverAppTitle}</Tip>
        </a>

        {/*
          The exception desk, on every screen. An alert that only reaches the
          dispatcher who already has that lorry's page open reaches nobody at
          02:00 on the Habur road.

          Both of these open sideways rather than downwards: they sit at the
          bottom of a column, and a panel anchored below them would open off the
          bottom of the viewport.
        */}
        <AlertCentre placement="inline-end" />
        {/* Renders nothing at all until a request has actually failed. */}
        <DiagnosticsLog placement="inline-end" />
        <LanguagePicker />
        <ThemeToggle />
        <SignOut />
      </div>
    </nav>
  );
}

/* -------------------------------------------------------------------------- */

/**
 * The monogram.
 *
 * A wordmark does not fit a 3.4rem column, and rotating one to read vertically
 * is a decision made by someone who has never had to read it. Two letters at
 * the size of a favicon is what a dock affords, and it is also the home link,
 * because the first thing anyone tries when lost is the logo.
 */
function BrandMark() {
  const t = useT();
  return (
    <Link
      href="/"
      aria-label={t.shell.brandAria}
      title={t.shell.brandAria}
      className="group relative grid h-9 w-9 shrink-0 place-items-center rounded-xl text-[0.8rem] font-bold tracking-tight text-ink-inverse shadow-glow transition-transform hover:scale-[1.06] active:scale-95"
      style={{
        // A gradient rather than a flat fill: 32 square pixels is too small to
        // read as a considered mark on one colour, and the second stop is the
        // brand's own hover shade, so nothing new enters the palette.
        backgroundImage:
          'linear-gradient(135deg, rgb(var(--kh-brand)) 0%, rgb(var(--kh-brand-hover)) 100%)',
      }}
    >
      KH
      <Tip>{t.shell.brandSub}</Tip>
    </Link>
  );
}

const TILE =
  'group relative grid h-[2.5rem] w-[2.5rem] place-items-center rounded-xl transition-colors ' +
  'focus-visible:outline-2 focus-visible:outline-offset-2';

const TILE_IDLE = 'text-ink-2 hover:bg-surface-3/70 hover:text-ink';

function DockLink({
  href,
  label,
  active,
  children,
}: {
  href: string;
  label: string;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      aria-label={label}
      aria-current={active ? 'page' : undefined}
      className={clsx(
        TILE,
        active
          ? // A filled tile, not a tinted one. Six identical outlines with one
            // faintly warmer background is not a "you are here" a dispatcher
            // can find peripherally while reading the map.
            'bg-brand text-ink-inverse shadow-glow'
          : TILE_IDLE,
      )}
    >
      {children}
      <Tip>{label}</Tip>
    </Link>
  );
}

function DockButton({
  label,
  onClick,
  children,
  active,
  className,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
  active?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-pressed={active}
      className={clsx(TILE, active ? 'bg-brand-soft text-brand-text' : TILE_IDLE, className)}
    >
      {children}
      <Tip>{label}</Tip>
    </button>
  );
}

/* -------------------------------------------------------------------------- */

/**
 * Language.
 *
 * A native <select> made to look like a dock tile: the current language's own
 * two letters, with the real control laid transparently over them. That is not
 * a trick to avoid building a menu — it is the accessible choice and the cheap
 * one at once. Three options do not need a listbox; a native select is reachable
 * by keyboard and screen reader with none of the focus management a custom menu
 * needs; and on a phone the operating system renders it as a proper picker.
 *
 * Each option carries its own lang, so a browser lays "العربية" out
 * right-to-left inside a left-to-right menu instead of mangling it, and a
 * screen reader set to Turkish does not read the Arabic name as nonsense.
 */
const LOCALE_SHORT: Record<Locale, string> = { tr: 'TR', ar: 'ع', ku: 'KU' };

function LanguagePicker() {
  const { locale, setLocale } = useI18n();
  const t = useT();

  return (
    <div className={clsx(TILE, TILE_IDLE)}>
      <span aria-hidden className="text-xs font-bold tracking-wide" lang={locale}>
        {LOCALE_SHORT[locale]}
      </span>
      <select
        value={locale}
        onChange={(event) => setLocale(event.target.value as Locale)}
        aria-label={t.shell.language}
        className="absolute inset-0 cursor-pointer appearance-none opacity-0"
      >
        {LOCALES.map((option) => (
          <option key={option} value={option} lang={option}>
            {LOCALE_NAME[option]}
          </option>
        ))}
      </select>
      <Tip>{t.shell.language}</Tip>
    </div>
  );
}

function ThemeToggle() {
  const { pref, resolved, setPref } = useTheme();
  const t = useT();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // Rendering the icon before mount would make the server's guess visible for
  // one frame and produce a hydration mismatch warning.
  if (!mounted) return <span className="h-10 w-10" />;

  const next =
    pref === 'system' ? (resolved === 'dark' ? 'light' : 'dark') : pref === 'dark' ? 'light' : 'dark';
  const label =
    pref === 'system'
      ? t.shell.themeSystem(
          resolved === 'dark' ? t.shell.themeResolvedDark : t.shell.themeResolvedLight,
        )
      : pref === 'dark'
        ? t.shell.themeDark
        : t.shell.themeLight;

  return (
    <button
      type="button"
      onClick={() => setPref(next)}
      // Double-click hands the choice back to the operating system. Discoverable
      // only from the tooltip, which is the right level of prominence for a
      // setting that three people will use once each.
      onDoubleClick={() => setPref('system')}
      aria-label={label}
      className={clsx(TILE, TILE_IDLE)}
    >
      {resolved === 'dark' ? <IconMoon /> : <IconSun />}
      <Tip>{label}</Tip>
    </button>
  );
}

function SignOut() {
  const router = useRouter();
  const t = useT();
  return (
    <button
      type="button"
      onClick={() => {
        // Kill the socket before clearing tokens: otherwise it keeps retrying
        // with a dead credential until the page unloads.
        disconnectRealtime();
        tokens.clear();
        router.replace('/login');
      }}
      aria-label={t.shell.signOut}
      className={clsx(TILE, 'text-ink-3 hover:bg-danger-bg hover:text-danger')}
    >
      <IconSignOut />
      <Tip>{t.shell.signOut}</Tip>
    </button>
  );
}

'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import clsx from 'clsx';
import { api, tokens } from '@/lib/api';
import { LOCALES, LOCALE_NAME, useI18n, useT } from '@/lib/i18n';
import { useTheme } from '@/lib/theme';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Form';
import { ErrorState } from '@/components/ui/Feedback';
import { IconMoon, IconSun } from '@/components/shell/Icons';

/* =============================================================================
   Sign in
   =============================================================================
   The one screen in the product that is read by somebody who has not yet proved
   who they are, and therefore the one screen with no navigation, no dock and no
   data on it.

   It still carries two controls, and the language picker is not a courtesy.
   Three of the people who use this product read Arabic or Kurdish first, and
   the language is stored against the browser rather than the account — so a new
   employee, or anyone on a machine that has been reset, meets a Turkish form
   and has no way through it. Putting the picker behind the sign-in was a
   circular dependency: to read the interface you must sign in, and to sign in
   you must read the interface.
   ========================================================================== */

export default function LoginPage() {
  const router = useRouter();
  const t = useT();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Someone with a live session who lands here — from a bookmark, or from the
  // old redirect — should not be asked to sign in again.
  useEffect(() => {
    if (tokens.access) router.replace('/');
  }, [router]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await api.login(email.trim(), password);
      tokens.set(result.accessToken, result.refreshToken);
      // A hard navigation, not router.push: it guarantees the socket singleton
      // and every query cache start clean under the new identity.
      window.location.href = '/';
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : t.login.failedBody);
      setBusy(false);
    }
  }

  return (
    <div className="relative grid min-h-screen place-items-center overflow-hidden bg-bg px-4 py-10">
      {/*
        A quiet grid, the kind printed on a logistics planning sheet. It gives
        the page a subject without a stock photograph or a gradient.
      */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-[0.045]"
        style={{
          backgroundImage:
            'linear-gradient(rgb(var(--kh-text)) 1px, transparent 1px), linear-gradient(90deg, rgb(var(--kh-text)) 1px, transparent 1px)',
          backgroundSize: '28px 28px',
        }}
      />
      {/*
        One soft wash of the brand colour behind the card, so the sheet has
        something to sit on rather than floating on flat grey. Very low opacity
        and very large: at this size it reads as light in the room rather than
        as a shape on the page.
      */}
      <div
        aria-hidden
        className="pointer-events-none absolute left-1/2 top-1/2 h-[38rem] w-[38rem] -translate-x-1/2 -translate-y-1/2 rounded-full opacity-[0.07] blur-3xl"
        style={{ background: 'rgb(var(--kh-brand))' }}
      />

      <ScreenControls />

      <form
        onSubmit={submit}
        className="kh-panel-in relative w-full max-w-[23rem] rounded-2xl bg-surface p-7 shadow-panel ring-1 ring-line"
      >
        <div className="mb-6 flex items-center gap-3">
          {/* The same monogram the dock carries, so the first thing anyone sees
              is the thing they will be clicking to get home all day. */}
          <span
            aria-hidden
            className="grid h-10 w-10 shrink-0 place-items-center rounded-xl text-[0.85rem] font-bold tracking-tight text-ink-inverse shadow-glow"
            style={{
              backgroundImage:
                'linear-gradient(135deg, rgb(var(--kh-brand)) 0%, rgb(var(--kh-brand-hover)) 100%)',
            }}
          >
            KH
          </span>
          <div className="min-w-0">
            <div className="text-2xs font-bold uppercase tracking-[0.22em] text-brand">
              KaraHoca
            </div>
            <h1 className="mt-0.5 truncate text-lg font-semibold tracking-tight">
              {t.login.heading}
            </h1>
          </div>
        </div>

        <p className="-mt-3 mb-6 text-sm text-ink-2">{t.login.tagline}</p>

        <div className="space-y-3.5">
          <Input
            label={t.login.email}
            id="email"
            type="email"
            autoComplete="username"
            autoFocus
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            // Tailwind emits .h-10 before .h-9 — its numeric scale sorts as
            // strings, so "10" lands before "9" and the control size baked into
            // Input would win a plain override. This form wants 35px fields, to
            // match the lg button underneath them.
            className="!h-10"
          />
          <Input
            label={t.login.password}
            id="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            className="!h-10"
          />
        </div>

        {error && <ErrorState className="mt-4" title={t.login.failedTitle} message={error} compact />}

        <Button type="submit" variant="primary" size="lg" block loading={busy} className="mt-5">
          {busy ? t.login.submitting : t.login.submit}
        </Button>
      </form>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

/**
 * Language and theme, before there is an account to attach them to.
 *
 * Pinned to the top inline-end corner rather than folded into the card: they
 * are properties of the screen, not fields of the form, and a picker inside the
 * card would be one more thing between somebody and signing in.
 */
function ScreenControls() {
  const { locale, setLocale } = useI18n();
  const { resolved, pref, setPref } = useTheme();
  const t = useT();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  return (
    <div className="absolute end-4 top-4 flex items-center gap-1.5">
      {/*
        Named in their own languages, as full words rather than two-letter
        codes. There is space here, and "العربية" is unambiguous to the person
        who needs it in a way that "AR" is not.
      */}
      <div
        role="group"
        aria-label={t.shell.language}
        className="flex items-center gap-0.5 rounded-xl bg-surface/70 p-1 ring-1 ring-line backdrop-blur"
      >
        {LOCALES.map((option) => (
          <button
            key={option}
            type="button"
            lang={option}
            aria-current={option === locale ? 'true' : undefined}
            onClick={() => setLocale(option)}
            className={clsx(
              'rounded-lg px-2.5 py-1 text-sm font-medium transition-colors',
              option === locale
                ? 'bg-brand text-ink-inverse'
                : 'text-ink-2 hover:bg-surface-3/70 hover:text-ink',
            )}
          >
            {LOCALE_NAME[option]}
          </button>
        ))}
      </div>

      {/* Rendering the icon before mount would make the server's guess visible
          for one frame and produce a hydration mismatch warning. */}
      {mounted ? (
        <button
          type="button"
          onClick={() => setPref(resolved === 'dark' ? 'light' : 'dark')}
          onDoubleClick={() => setPref('system')}
          aria-label={
            pref === 'system'
              ? t.shell.themeSystem(
                  resolved === 'dark' ? t.shell.themeResolvedDark : t.shell.themeResolvedLight,
                )
              : resolved === 'dark'
                ? t.shell.themeDark
                : t.shell.themeLight
          }
          className="grid h-9 w-9 place-items-center rounded-xl bg-surface/70 text-ink-2 ring-1 ring-line backdrop-blur transition-colors hover:text-ink"
        >
          {resolved === 'dark' ? <IconMoon /> : <IconSun />}
        </button>
      ) : (
        <span className="h-9 w-9" />
      )}
    </div>
  );
}

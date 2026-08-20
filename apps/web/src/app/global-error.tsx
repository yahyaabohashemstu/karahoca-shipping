'use client';

import { clientDictionary, clientLocale, dirOf } from '@/lib/i18n';
import { clientTheme } from '@/lib/theme';

/**
 * Last resort: a throw in the root layout itself, above every provider.
 *
 * This component replaces <html> entirely, so it cannot use the theme provider,
 * the fonts, Tailwind's generated classes, or any context — all of them live
 * inside the tree that just failed. Everything here is inline styles on
 * purpose, and it must stay that way.
 *
 * The language comes from the cookie directly rather than from context, for the
 * same reason: I18nProvider is one of the things that just failed. This is also
 * the one screen where the root layout never ran, so lang and dir have to be
 * set here by hand — and it is precisely the screen a reader most needs to be
 * able to read.
 *
 * The palette is read the same way, straight out of localStorage. Not being
 * able to use the theme provider is not a reason to ignore the theme: this
 * page used to paint white unconditionally, which meant a dispatcher who had
 * been on the dark theme for eight hours got a full-screen flash delivered at
 * the exact moment something had already gone wrong.
 */

/* The two ramps, transcribed from globals.css. Duplicated deliberately: the
   custom properties they normally come from are defined in a stylesheet this
   page cannot load. */
const PALETTE = {
  light: {
    bg: '#f7f9f9',
    surface: '#ffffff',
    line: '#dee4e5',
    ink: '#0e171b',
    ink2: '#54646b',
    ink3: '#5c6c73',
    brand: '#1460c8',
    onBrand: '#ffffff',
    shadow: '0 10px 34px -8px rgba(14, 23, 27, 0.16)',
  },
  dark: {
    bg: '#0b1012',
    surface: '#12191c',
    line: '#263237',
    ink: '#e8eff1',
    ink2: '#9eb0b7',
    ink3: '#80929a',
    brand: '#5298ff',
    onBrand: '#0b1012',
    shadow: '0 10px 34px -8px rgba(0, 0, 0, 0.6)',
  },
} as const;

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const locale = clientLocale();
  const t = clientDictionary();
  const c = PALETTE[clientTheme()];

  return (
    <html lang={locale} dir={dirOf(locale)}>
      <body
        style={{
          margin: 0,
          minHeight: '100vh',
          display: 'grid',
          placeItems: 'center',
          background: c.bg,
          color: c.ink,
          // colorScheme so the scrollbar and any form control the browser draws
          // for itself match the page rather than defaulting to light.
          colorScheme: clientTheme(),
          fontFamily: 'system-ui, -apple-system, Segoe UI, sans-serif',
          padding: '1.5rem',
        }}
      >
        <div
          style={{
            maxWidth: 400,
            width: '100%',
            textAlign: 'center',
            background: c.surface,
            border: `1px solid ${c.line}`,
            borderRadius: 16,
            boxShadow: c.shadow,
            padding: '28px 24px',
          }}
        >
          {/* The same monogram the dock carries — the one piece of the product's
              identity that survives having no stylesheet. */}
          <div
            aria-hidden
            style={{
              width: 40,
              height: 40,
              margin: '0 auto 14px',
              display: 'grid',
              placeItems: 'center',
              borderRadius: 12,
              background: c.brand,
              color: c.onBrand,
              fontWeight: 800,
              fontSize: 13,
              letterSpacing: '-0.02em',
            }}
          >
            KH
          </div>
          <p
            style={{
              margin: 0,
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: '0.2em',
              textTransform: 'uppercase',
              color: c.brand,
            }}
          >
            KaraHoca
          </p>
          <h1 style={{ margin: '12px 0 6px', fontSize: 19, letterSpacing: '-0.015em' }}>
            {t.errors.appTitle}
          </h1>
          <p style={{ margin: 0, fontSize: 14, color: c.ink2, lineHeight: 1.55 }}>
            {t.errors.appBody}
          </p>
          {error.digest && (
            <p style={{ marginTop: 14, fontSize: 12, color: c.ink3 }}>
              {t.errors.code}: {error.digest}
            </p>
          )}
          <button
            onClick={reset}
            style={{
              marginTop: 22,
              padding: '10px 18px',
              fontSize: 14,
              fontWeight: 600,
              color: c.onBrand,
              background: c.brand,
              border: 0,
              borderRadius: 10,
              cursor: 'pointer',
            }}
          >
            {t.common.retry}
          </button>
        </div>
      </body>
    </html>
  );
}

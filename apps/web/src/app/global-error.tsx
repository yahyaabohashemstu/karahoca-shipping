'use client';

import { clientDictionary, clientLocale, dirOf } from '@/lib/i18n';

/**
 * Last resort: a throw in the root layout itself, above every provider.
 *
 * This component replaces <html> entirely, so it cannot use the theme, the
 * fonts, Tailwind's generated classes, or any provider — all of them live
 * inside the tree that just failed. Everything here is inline styles on
 * purpose, and it must stay that way.
 *
 * The language comes from the cookie directly rather than from context, for the
 * same reason: I18nProvider is one of the things that just failed. This is also
 * the one screen where the root layout never ran, so lang and dir have to be
 * set here by hand — and it is precisely the screen a reader most needs to be
 * able to read.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const locale = clientLocale();
  const t = clientDictionary();

  return (
    <html lang={locale} dir={dirOf(locale)}>
      <body
        style={{
          margin: 0,
          minHeight: '100vh',
          display: 'grid',
          placeItems: 'center',
          background: '#f7f9f9',
          color: '#0e171b',
          fontFamily: 'system-ui, -apple-system, Segoe UI, sans-serif',
          padding: '1.5rem',
        }}
      >
        <div style={{ maxWidth: 420, textAlign: 'center' }}>
          <p
            style={{
              margin: 0,
              fontSize: 12,
              fontWeight: 700,
              letterSpacing: '0.18em',
              textTransform: 'uppercase',
              color: '#1460c8',
            }}
          >
            KaraHoca
          </p>
          <h1 style={{ margin: '12px 0 6px', fontSize: 18 }}>{t.errors.appTitle}</h1>
          <p style={{ margin: 0, fontSize: 14, color: '#54646b', lineHeight: 1.5 }}>
            {t.errors.appBody}
          </p>
          {error.digest && (
            <p style={{ marginTop: 12, fontSize: 12, color: '#85959c' }}>{t.errors.code}: {error.digest}</p>
          )}
          <button
            onClick={reset}
            style={{
              marginTop: 20,
              padding: '8px 16px',
              fontSize: 14,
              fontWeight: 500,
              color: '#fff',
              background: '#1460c8',
              border: 0,
              borderRadius: 6,
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

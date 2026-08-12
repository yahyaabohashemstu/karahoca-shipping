'use client';

/**
 * Last resort: a throw in the root layout itself, above every provider.
 *
 * This component replaces <html> entirely, so it cannot use the theme, the
 * fonts, Tailwind's generated classes, or any provider — all of them live
 * inside the tree that just failed. Everything here is inline styles on
 * purpose, and it must stay that way.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="tr">
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
          <h1 style={{ margin: '12px 0 6px', fontSize: 18 }}>Uygulama başlatılamadı</h1>
          <p style={{ margin: 0, fontSize: 14, color: '#54646b', lineHeight: 1.5 }}>
            Takip verileri sunucuda güvende. Sayfayı yenilemeyi deneyin; sorun sürerse
            sistem yöneticisine bildirin.
          </p>
          {error.digest && (
            <p style={{ marginTop: 12, fontSize: 12, color: '#85959c' }}>Hata kodu: {error.digest}</p>
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
            Yeniden dene
          </button>
        </div>
      </body>
    </html>
  );
}

'use client';

import { useEffect } from 'react';
import { Button } from '@/components/ui/Button';
import { useT } from '@/lib/i18n';

/**
 * Route-level error boundary.
 *
 * Everything on this dashboard is client-rendered and fed by an untrusted
 * stream. A malformed socket frame, a MapLibre style-load throw, or a route
 * geometry that is not a LineString unmounts the whole React tree — and on an
 * ambient screen that nobody is watching the console of, the failure is
 * discovered when someone asks where a truck is.
 *
 * There was no boundary of any kind before this file existed.
 */
export default function RouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useT();
  useEffect(() => {
    // The console is the only sink available; there is no error reporter on a
    // self-hosted single-box deployment.
    console.error('[kh] route error', error);
  }, [error]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-bg p-6">
      <div className="kh-panel-in w-full max-w-md rounded-2xl bg-surface p-7 text-center shadow-panel ring-1 ring-line">
        <div className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-2xl bg-danger-bg text-danger ring-1 ring-inset ring-danger-ring">
          <svg viewBox="0 0 20 20" className="h-5 w-5" fill="none" aria-hidden>
            <path
              d="M10 2.75 18 17H2z"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinejoin="round"
            />
            <path d="M10 8v3.4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            <circle cx="10" cy="14" r="0.9" fill="currentColor" />
          </svg>
        </div>

        <h1 className="text-lg font-semibold tracking-tight text-ink">{t.errors.routeTitle}</h1>
        <p className="mt-1.5 text-base text-ink-2">{t.errors.routeBody}</p>

        {error.message && (
          <pre className="kh-scroll mt-4 max-h-28 overflow-auto rounded-lg bg-surface-2 px-3 py-2 text-start text-sm text-ink-2">
            {error.message}
            {error.digest ? `\n\n(${error.digest})` : ''}
          </pre>
        )}

        <div className="mt-5 flex justify-center gap-2">
          <Button variant="primary" onClick={reset}>
            {t.common.retry}
          </Button>
          <Button variant="secondary" onClick={() => (window.location.href = '/')}>
            {t.errors.backToMap}
          </Button>
        </div>
      </div>
    </div>
  );
}

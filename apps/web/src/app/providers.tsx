'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { I18nProvider } from '@/lib/i18n';
import type { Locale } from '@/lib/i18n/locale';
import { ThemeProvider } from '@/lib/theme';
import { ToastProvider } from '@/components/ui/Toast';

export function Providers({
  locale,
  children,
}: {
  locale: Locale;
  children: React.ReactNode;
}) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            /*
             * The WebSocket is the freshness mechanism (ADR-006), so there is
             * no refetchInterval — polling on top of it would double the load
             * and make it impossible to tell whether the socket works at all.
             *
             * But `staleTime: 30_000` alone left a hole: a query whose data
             * came from a socket write is never "stale" by time, so a tab left
             * open through a socket outage refetched nothing on focus. The
             * socket now writes into the query cache (see useRealtime), which
             * makes refetchOnWindowFocus the recovery path — a dispatcher
             * returning to the tab always gets a fresh read.
             */
            staleTime: 30_000,
            // 5 minutes: long enough that navigating away and back is instant,
            // short enough that a dashboard left open overnight is not holding
            // yesterday's fleet in memory.
            gcTime: 5 * 60_000,
            retry: (failureCount, error) => {
              // Never retry an auth or validation failure — apiFetch has
              // already tried a token refresh, and a second 400 will be a 400.
              const status = (error as { status?: number })?.status;
              if (status && status >= 400 && status < 500) return false;
              return failureCount < 2;
            },
            retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 8000),
            refetchOnWindowFocus: true,
            refetchOnReconnect: true,
          },
          mutations: {
            retry: false,
          },
        },
      }),
  );

  return (
    <I18nProvider locale={locale}>
      <ThemeProvider>
        <QueryClientProvider client={client}>
          <ToastProvider>{children}</ToastProvider>
        </QueryClientProvider>
      </ThemeProvider>
    </I18nProvider>
  );
}

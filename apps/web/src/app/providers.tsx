'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';

export function Providers({ children }: { children: React.ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            /*
             * staleTime is high and refetchInterval is absent on purpose: the
             * WebSocket is the freshness mechanism (ADR-006). Polling on top of
             * it would double the load for no benefit and make it impossible to
             * tell whether the socket is actually working.
             */
            staleTime: 30_000,
            retry: 1,
            refetchOnWindowFocus: true,
            refetchOnReconnect: true,
          },
        },
      }),
  );

  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

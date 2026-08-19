'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { AppShell, useRequireAuth } from '@/components/AppShell';
import {
  Badge,
  Button,
  EmptyState,
  ErrorState,
  Pagination,
  PageHeader,
  SearchInput,
  SegmentedControl,
  StatusBadge,
  Table,
  TableSkeletonRows,
  TD,
  TH,
  THead,
  TR,
  TRMessage,
} from '@/components/ui';
import { useFormat, useT, type Dictionary } from '@/lib/i18n';

const LIMIT = 50;
const COLS = 7;

/*
 * Values and dictionary keys only. A module-level array is evaluated once at
 * import, so a label written here would be Turkish for every reader for ever.
 */
const FILTERS: Array<{ value: string; key: keyof Dictionary['orders']['filters'] }> = [
  { value: 'untracked', key: 'untracked' },
  { value: 'PENDING', key: 'PENDING' },
  { value: 'IN_TRANSIT', key: 'IN_TRANSIT' },
  { value: 'DELIVERED', key: 'DELIVERED' },
  { value: '', key: 'all' },
];

export default function OrdersPage() {
  const t = useT();
  const fmt = useFormat();
  const authed = useRequireAuth();
  const router = useRouter();

  const [filter, setFilter] = useState('untracked');
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [offset, setOffset] = useState(0);

  useEffect(() => {
    const t = setTimeout(() => {
      setSearch(searchInput);
      setOffset(0);
    }, 250);
    return () => clearTimeout(t);
  }, [searchInput]);

  const { data, isLoading, isError, error, isFetching, refetch } = useQuery({
    queryKey: ['orders', filter, search, offset],
    queryFn: () =>
      api.orders({
        untracked: filter === 'untracked' ? true : undefined,
        status: filter && filter !== 'untracked' ? filter : undefined,
        search: search || undefined,
        limit: LIMIT,
        offset,
      }),
    enabled: authed,
    placeholderData: keepPreviousData,
  });

  const items = useMemo(() => data?.items ?? [], [data]);

  if (!authed) return null;

  return (
    <AppShell>
      <PageHeader
        title={t.orders.title}
        subtitle={t.orders.subtitle}
        actions={
          <Link href="/orders/new">
            <Button variant="primary">{t.orders.create}</Button>
          </Link>
        }
      />

      <div className="flex flex-wrap items-center gap-3 px-5 py-3">
        <SegmentedControl
          label={t.orders.filterLabel}
          value={filter}
          onChange={(v) => {
            setFilter(v);
            setOffset(0);
          }}
          options={FILTERS.map((f) => ({ value: f.value, label: t.orders.filters[f.key] }))}
        />
        <SearchInput
          value={searchInput}
          onValueChange={setSearchInput}
          placeholder={t.orders.searchPlaceholder}
          className="ms-auto w-72"
        />
      </div>

      <div className="min-h-0 flex-1 px-5 pb-5">
        <div className="overflow-hidden rounded-md bg-surface ring-1 ring-line">
          <Table>
            <THead>
              <TR>
                <TH>{t.orders.colOrder}</TH>
                <TH>{t.orders.colCustomer}</TH>
                <TH>{t.orders.colDestination}</TH>
                <TH>{t.orders.colStatus}</TH>
                <TH>{t.orders.colTracking}</TH>
                <TH numeric>{t.orders.colWeight}</TH>
                <TH numeric>{t.orders.colPlanned}</TH>
              </TR>
            </THead>
            <tbody>
              {isLoading ? (
                <TableSkeletonRows rows={10} cols={COLS} />
              ) : isError ? (
                <TRMessage colSpan={COLS} tone="danger">
                  <ErrorState
                    className="mx-auto max-w-md text-start"
                    title={t.orders.loadFailed}
                    message={(error as Error)?.message}
                    onRetry={() => refetch()}
                    retrying={isFetching}
                  />
                </TRMessage>
              ) : items.length === 0 ? (
                <TRMessage colSpan={COLS}>
                  <EmptyState
                    title={search ? t.orders.emptyMatch : t.orders.empty}
                    description={
                      filter === 'untracked'
                        ? t.orders.emptyUntracked
                        : t.orders.emptyAll
                    }
                    action={
                      <Link href="/orders/new">
                        <Button variant="primary" size="sm">
                          {t.orders.createShort}
                        </Button>
                      </Link>
                    }
                  />
                </TRMessage>
              ) : (
                items.map((o) => (
                  <TR
                    key={o.id}
                    onClick={() =>
                      o.activeSessionId
                        ? router.push(`/sessions/${o.activeSessionId}`)
                        : router.push(`/sessions/new`)
                    }
                  >
                    <TD>
                      <span className="kh-num font-medium">{o.orderNumber}</span>
                      {o.cargoSummary && (
                        <div className="truncate text-sm text-ink-3">{o.cargoSummary}</div>
                      )}
                    </TD>
                    <TD>
                      {o.customerName}
                      {o.customerCity && <span className="text-ink-3"> · {o.customerCity}</span>}
                    </TD>
                    <TD muted>{o.destinationLabel ?? '—'}</TD>
                    <TD>
                      <StatusBadge status={o.status} />
                    </TD>
                    <TD>
                      {o.activeSessionId ? (
                        <span className="kh-num text-brand-text">{o.activeSessionRef}</span>
                      ) : (
                        // Not an absence — an action. This is the single most
                        // common thing a dispatcher does on this screen.
                        <Badge tone="neutral">{t.orders.noSession}</Badge>
                      )}
                    </TD>
                    <TD numeric muted>
                      {o.totalWeightKg !== null ? `${fmt.number(o.totalWeightKg)} kg` : '—'}
                    </TD>
                    <TD numeric muted>
                      {fmt.date(o.plannedDeliveryAt, {
                        day: '2-digit',
                        month: '2-digit',
                        year: '2-digit',
                      })}
                    </TD>
                  </TR>
                ))
              )}
            </tbody>
          </Table>

          {!isLoading && !isError && (
            <Pagination total={data?.total ?? 0} limit={LIMIT} offset={offset} onOffset={setOffset} />
          )}
        </div>
      </div>
    </AppShell>
  );
}

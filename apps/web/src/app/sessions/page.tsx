'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { displayState, useNow } from '@/lib/signal';
import { AppShell, useRequireAuth } from '@/components/AppShell';
import {
  Button,
  EmptyState,
  ErrorState,
  Pagination,
  PageHeader,
  SearchInput,
  SegmentedControl,
  SignalBadge,
  StatusBadge,
  Table,
  TableSkeletonRows,
  TD,
  TH,
  THead,
  TR,
  TRMessage,
} from '@/components/ui';
import { useI18n, useT, type Dictionary } from '@/lib/i18n';
import { formatDayTime } from '@/lib/format';
import type { Locale } from '@/lib/i18n/locale';

/*
 * Values and dictionary keys only — a module-level array is evaluated once at
 * import, long before a language has been chosen.
 */
const STATUS_FILTERS: Array<{ value: string; key: keyof Dictionary['sessions']['filters'] }> = [
  { value: 'LIVE', key: 'LIVE' },
  { value: 'ASSIGNED', key: 'ASSIGNED' },
  { value: 'COMPLETED', key: 'COMPLETED' },
  // CANCELLED had no option at all, so a stopped shipment was reachable only by
  // switching to "all" and reading past everything else.
  { value: 'CANCELLED', key: 'CANCELLED' },
  { value: 'EXPIRED', key: 'EXPIRED' },
  { value: '', key: 'all' },
];

const LIMIT = 50;
const COLS = 8;

export default function SessionsPage() {
  const t = useT();
  const { locale } = useI18n();
  const authed = useRequireAuth();
  const router = useRouter();
  const now = useNow(30_000);

  const [status, setStatus] = useState<string>('LIVE');
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [offset, setOffset] = useState(0);

  // Debounced: the old page fired a request on every keystroke, so typing a
  // six-character plate meant six queries and six renders of a table that was
  // already scrolled.
  useEffect(() => {
    const t = setTimeout(() => {
      setSearch(searchInput);
      setOffset(0);
    }, 250);
    return () => clearTimeout(t);
  }, [searchInput]);

  const { data, isLoading, isError, error, isFetching, refetch } = useQuery({
    queryKey: ['sessions', status, search, offset],
    queryFn: () =>
      api.sessions({
        status: status || undefined,
        search: search || undefined,
        limit: LIMIT,
        offset,
      }),
    enabled: authed,
    // Keeps the previous page on screen while the next one loads, instead of
    // collapsing the table to a spinner on every filter change.
    placeholderData: keepPreviousData,
  });

  const items = useMemo(() => data?.items ?? [], [data]);

  if (!authed) return null;

  return (
    <AppShell>
      <PageHeader
        title={t.sessions.title}
        subtitle={t.sessions.subtitle}
        actions={
          <Link href="/sessions/new">
            <Button variant="primary">{t.sessions.create}</Button>
          </Link>
        }
      />

      <div className="flex flex-wrap items-center gap-3 px-5 py-3">
        <SegmentedControl
          label={t.sessions.statusFilter}
          value={status}
          onChange={(v) => {
            setStatus(v);
            setOffset(0);
          }}
          options={STATUS_FILTERS.map((f) => ({ value: f.value, label: t.sessions.filters[f.key] }))}
        />
        <SearchInput
          value={searchInput}
          onValueChange={setSearchInput}
          placeholder={t.sessions.searchPlaceholder}
          className="ml-auto w-72"
        />
      </div>

      <div className="min-h-0 flex-1 px-5 pb-5">
        <div className="overflow-hidden rounded-md bg-surface ring-1 ring-line">
          <Table>
            <THead>
              <TR>
                <TH>{t.sessions.colSession}</TH>
                <TH>{t.sessions.colOrder}</TH>
                <TH>{t.sessions.colCustomer}</TH>
                <TH>{t.sessions.colCarrier}</TH>
                <TH>{t.sessions.colVehicle}</TH>
                <TH>{t.sessions.colStatus}</TH>
                <TH numeric>{t.sessions.colDistance}</TH>
                <TH numeric>{t.sessions.colLastSignal}</TH>
              </TR>
            </THead>
            <tbody>
              {isLoading ? (
                <TableSkeletonRows rows={10} cols={COLS} />
              ) : isError ? (
                /* A 500 used to render as "Kayıt bulunamadı." — which is the
                   exact claim a carrier makes when a shipment goes missing. */
                <TRMessage colSpan={COLS} tone="danger">
                  <ErrorState
                    className="mx-auto max-w-md text-left"
                    title={t.sessions.loadFailed}
                    message={(error as Error)?.message}
                    onRetry={() => refetch()}
                    retrying={isFetching}
                  />
                </TRMessage>
              ) : items.length === 0 ? (
                <TRMessage colSpan={COLS}>
                  <EmptyState
                    title={search || status ? t.sessions.emptyMatch : t.sessions.empty}
                    description={
                      search || status
                        ? t.sessions.emptyMatchBody
                        : t.sessions.emptyBody
                    }
                    action={
                      search || status ? (
                        <Button
                          size="sm"
                          onClick={() => {
                            setSearchInput('');
                            setStatus('');
                          }}
                        >
                          {t.sessions.clearFilters}
                        </Button>
                      ) : (
                        <Link href="/sessions/new">
                          <Button variant="primary" size="sm">
                            {t.sessions.createShort}
                          </Button>
                        </Link>
                      )
                    }
                  />
                </TRMessage>
              ) : (
                items.map((s) => {
                  const f = displayState(s, now);
                  return (
                    <TR key={s.sessionId} onClick={() => router.push(`/sessions/${s.sessionId}`)}>
                      <TD>
                        <span className="kh-num font-medium text-brand-text">{s.reference}</span>
                      </TD>
                      <TD>
                        <span className="kh-num">{s.orderNumber}</span>
                      </TD>
                      <TD>{s.customerName}</TD>
                      <TD muted>{s.carrierName}</TD>
                      <TD>
                        <span className="kh-num">{s.vehiclePlate ?? '—'}</span>
                      </TD>
                      <TD>
                        <div className="flex items-center gap-1.5">
                          <StatusBadge status={s.status} />
                          {(s.status === 'ACTIVE' || s.status === 'PAUSED') && (
                            <SignalBadge state={f.state} compact />
                          )}
                        </div>
                      </TD>
                      <TD numeric>{s.distanceKm ?? 0} km</TD>
                      <TD numeric muted>
                        {s.recordedAt ? formatWhen(s.recordedAt, t, locale) : '—'}
                      </TD>
                    </TR>
                  );
                })
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

/**
 * Absolute timestamps for anything older than today, relative for anything
 * recent. "3 dk" answers the question a dispatcher is actually asking on a live
 * row; "11.08.2026 22:14" is what they need on a row from last week.
 */
function formatWhen(iso: string, t: Dictionary, locale: Locale): string {
  const d = new Date(iso);
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return t.sessions.agoJustNow;
  if (diff < 3600) return t.sessions.agoMinutes(String(Math.floor(diff / 60)));
  if (diff < 86_400) return t.sessions.agoHours(String(Math.floor(diff / 3600)));
  return formatDayTime(locale, d);
}

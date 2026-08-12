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

const LIMIT = 50;
const COLS = 7;

const FILTERS = [
  { value: 'untracked', label: 'Takipsiz' },
  { value: 'PENDING', label: 'Bekleyen' },
  { value: 'IN_TRANSIT', label: 'Yolda' },
  { value: 'DELIVERED', label: 'Teslim edilen' },
  { value: '', label: 'Tümü' },
];

export default function OrdersPage() {
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
        title="Siparişler"
        subtitle="Sevk edilecek yükler ve takip durumları"
        actions={
          <Link href="/orders/new">
            <Button variant="primary">+ Yeni sipariş</Button>
          </Link>
        }
      />

      <div className="flex flex-wrap items-center gap-3 px-5 py-3">
        <SegmentedControl
          label="Sipariş filtresi"
          value={filter}
          onChange={(v) => {
            setFilter(v);
            setOffset(0);
          }}
          options={FILTERS}
        />
        <SearchInput
          value={searchInput}
          onValueChange={setSearchInput}
          placeholder="Sipariş no, müşteri…"
          className="ml-auto w-72"
        />
      </div>

      <div className="min-h-0 flex-1 px-5 pb-5">
        <div className="overflow-hidden rounded-md bg-surface ring-1 ring-line">
          <Table>
            <THead>
              <TR>
                <TH>Sipariş</TH>
                <TH>Müşteri</TH>
                <TH>Varış</TH>
                <TH>Durum</TH>
                <TH>Takip</TH>
                <TH numeric>Ağırlık</TH>
                <TH numeric>Planlanan teslim</TH>
              </TR>
            </THead>
            <tbody>
              {isLoading ? (
                <TableSkeletonRows rows={10} cols={COLS} />
              ) : isError ? (
                <TRMessage colSpan={COLS} tone="danger">
                  <ErrorState
                    className="mx-auto max-w-md text-left"
                    title="Sipariş listesi yüklenemedi"
                    message={(error as Error)?.message}
                    onRetry={() => refetch()}
                    retrying={isFetching}
                  />
                </TRMessage>
              ) : items.length === 0 ? (
                <TRMessage colSpan={COLS}>
                  <EmptyState
                    title={search ? 'Eşleşen sipariş yok' : 'Sipariş yok'}
                    description={
                      filter === 'untracked'
                        ? 'Takip oturumu açılmamış sipariş bulunmuyor. Diğer filtreleri deneyin veya yeni bir sipariş oluşturun.'
                        : 'Sevk edilecek yükleri buraya kaydedin; her sipariş için ayrı bir takip oturumu açılır.'
                    }
                    action={
                      <Link href="/orders/new">
                        <Button variant="primary" size="sm">
                          Sipariş oluştur
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
                        <Badge tone="neutral">Oturum yok</Badge>
                      )}
                    </TD>
                    <TD numeric muted>
                      {o.totalWeightKg !== null ? `${o.totalWeightKg.toLocaleString('tr-TR')} kg` : '—'}
                    </TD>
                    <TD numeric muted>
                      {o.plannedDeliveryAt
                        ? new Date(o.plannedDeliveryAt).toLocaleDateString('tr-TR', {
                            day: '2-digit',
                            month: '2-digit',
                            year: '2-digit',
                          })
                        : '—'}
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

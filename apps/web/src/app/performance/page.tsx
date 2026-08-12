'use client';

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, type CarrierPerformance } from '@/lib/api';
import { AppShell, useRequireAuth } from '@/components/AppShell';
import {
  Badge,
  EmptyState,
  ErrorState,
  PageHeader,
  Table,
  TableSkeletonRows,
  TD,
  TH,
  THead,
  TR,
  TRMessage,
} from '@/components/ui';

const COLS = 8;

/**
 * Carrier performance.
 *
 * This view has existed in the database since the first migration and had no
 * screen. It is the commercial payoff of the whole system: the factory now
 * knows, per carrier, how much of each journey was actually observed and how
 * often the phone went dark — which is the difference between "the carrier says
 * they were on time" and "we have the coverage record".
 */
export default function PerformancePage() {
  const authed = useRequireAuth();

  const { data, isLoading, isError, error, isFetching, refetch } = useQuery({
    queryKey: ['carrier-performance'],
    queryFn: api.carrierPerformance,
    enabled: authed,
    staleTime: 5 * 60_000,
  });

  const rows = useMemo(() => data ?? [], [data]);

  if (!authed) return null;

  return (
    <AppShell>
      <PageHeader
        title="Nakliyeci performansı"
        subtitle="Her firmanın sevkiyat kapsama ve zamanında teslim geçmişi"
      />

      <div className="min-h-0 flex-1 px-5 py-4">
        <div className="overflow-hidden rounded-md bg-surface ring-1 ring-line">
          <Table>
            <THead>
              <TR>
                <TH>Nakliyeci</TH>
                <TH numeric>Sevkiyat</TH>
                <TH numeric>Tamamlanan</TH>
                <TH numeric>Zamanında</TH>
                <TH numeric>Kapsama</TH>
                <TH numeric>En uzun boşluk</TH>
                <TH numeric>Ort. mesafe</TH>
                <TH numeric>Sahte GPS</TH>
              </TR>
            </THead>
            <tbody>
              {isLoading ? (
                <TableSkeletonRows rows={5} cols={COLS} />
              ) : isError ? (
                <TRMessage colSpan={COLS} tone="danger">
                  <ErrorState
                    className="mx-auto max-w-md text-left"
                    title="Performans verisi yüklenemedi"
                    message={(error as Error)?.message}
                    onRetry={() => refetch()}
                    retrying={isFetching}
                  />
                </TRMessage>
              ) : rows.length === 0 ? (
                <TRMessage colSpan={COLS}>
                  <EmptyState
                    title="Henüz performans verisi yok"
                    description="Tamamlanan sevkiyatlar biriktikçe her nakliyeci için kapsama ve zamanında teslim oranları burada oluşur."
                  />
                </TRMessage>
              ) : (
                rows.map((r) => <PerfRow key={r.id} r={r} />)
              )}
            </tbody>
          </Table>
        </div>

        <p className="mt-3 max-w-3xl text-sm text-ink-3">
          <strong className="text-ink-2">Kapsama</strong>, sevkiyat süresinin yüzde kaçında konum
          verisi alındığını gösterir. Düşük kapsama, sürücünün uygulamayı kapattığına veya pil
          optimizasyonunun takibi durdurduğuna işaret eder — rota boşlukları oturum detayında
          dakika dakika görülebilir.
        </p>
      </div>
    </AppShell>
  );
}

function PerfRow({ r }: { r: CarrierPerformance }) {
  const coverage = r.avgCoveragePct;
  const onTimePct = r.completed > 0 ? Math.round((r.onTime / r.completed) * 100) : null;

  return (
    <TR>
      <TD>
        <span className="font-medium">{r.name}</span>
      </TD>
      <TD numeric>{r.sessions}</TD>
      <TD numeric muted>{r.completed}</TD>
      <TD numeric>
        {onTimePct === null ? (
          <span className="text-ink-3">—</span>
        ) : (
          <span className={onTimePct >= 90 ? 'text-success' : onTimePct >= 70 ? 'text-warn' : 'text-danger'}>
            {onTimePct}%
          </span>
        )}
      </TD>
      <TD numeric>
        {coverage === null ? <span className="text-ink-3">—</span> : <CoverageBar pct={coverage} />}
      </TD>
      <TD numeric muted>
        {r.avgLargestGapSec === null ? '—' : formatGap(r.avgLargestGapSec)}
      </TD>
      <TD numeric muted>
        {r.avgDistanceKm === null ? '—' : `${Math.round(r.avgDistanceKm)} km`}
      </TD>
      <TD numeric>
        {r.sessionsWithMockGps > 0 ? (
          <Badge tone="danger">{r.sessionsWithMockGps}</Badge>
        ) : (
          <span className="text-ink-3">0</span>
        )}
      </TD>
    </TR>
  );
}

/**
 * A number and a bar. The bar is what makes a column of percentages scannable —
 * comparing "94" against "71" across eight rows is work; comparing two bar
 * lengths is not.
 */
function CoverageBar({ pct }: { pct: number }) {
  const v = Math.max(0, Math.min(100, Math.round(pct)));
  const tone = v >= 90 ? 'bg-live-ring' : v >= 70 ? 'bg-delayed-ring' : 'bg-lost-bg';
  return (
    <span className="inline-flex items-center justify-end gap-2">
      <span className="h-1.5 w-16 overflow-hidden rounded-full bg-surface-3" aria-hidden>
        <span className={`block h-full rounded-full ${tone}`} style={{ width: `${v}%` }} />
      </span>
      <span className="w-9 text-right">{v}%</span>
    </span>
  );
}

function formatGap(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)} sn`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} dk`;
  return `${(seconds / 3600).toFixed(1)} sa`;
}

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
import { interpolate, useT } from '@/lib/i18n';

const COLS = 8;

/**
 * Carrier performance.
 *
 * This view has existed in the database since the first migration and had no
 * screen. It is the commercial payoff of the whole system: the factory now
 * knows, per carrier, how often deliveries actually landed on time and how
 * much telemetry each journey produced — which is the difference between "the
 * carrier says they were on time" and "we have the record".
 *
 * Both percentages on this page are shown with the population they were
 * computed over. That is not decoration. A scorecard is read in a rate
 * negotiation, and a bare percentage with an invisible denominator is the
 * first thing the other side takes apart — deservedly, since this page was
 * until 0009 dividing on-time deliveries by every completed shipment
 * including the ones nobody had promised a date for.
 */
export default function PerformancePage() {
  const t = useT();
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
        title={t.performance.title}
        subtitle={t.performance.subtitle}
      />

      <div className="min-h-0 flex-1 px-5 py-4">
        <div className="overflow-hidden rounded-xl bg-surface ring-1 ring-line">
          <Table>
            <THead>
              <TR>
                <TH>{t.performance.colCarrier}</TH>
                <TH numeric>{t.performance.colSessions}</TH>
                <TH numeric>{t.performance.colCompleted}</TH>
                <TH numeric>{t.performance.colOnTime}</TH>
                <TH numeric>{t.performance.colSampling}</TH>
                <TH numeric>{t.performance.colLongestGap}</TH>
                <TH numeric>{t.performance.colAvgDistance}</TH>
                <TH numeric>{t.performance.colMockGps}</TH>
              </TR>
            </THead>
            <tbody>
              {isLoading ? (
                <TableSkeletonRows rows={5} cols={COLS} />
              ) : isError ? (
                <TRMessage colSpan={COLS} tone="danger">
                  <ErrorState
                    className="mx-auto max-w-md text-start"
                    title={t.performance.loadFailed}
                    message={(error as Error)?.message}
                    onRetry={() => refetch()}
                    retrying={isFetching}
                  />
                </TRMessage>
              ) : rows.length === 0 ? (
                <TRMessage colSpan={COLS}>
                  <EmptyState
                    title={t.performance.emptyTitle}
                    description={t.performance.emptyBody}
                  />
                </TRMessage>
              ) : (
                rows.map((r) => <PerfRow key={r.id} r={r} />)
              )}
            </tbody>
          </Table>
        </div>

        <div className="mt-3 max-w-3xl space-y-2 text-sm text-ink-3">
          <p>
            {interpolate(t.performance.noteOnTime, [
              <strong key="on-time" className="text-ink-2">
                {t.performance.colOnTime}
              </strong>,
            ])}
          </p>
          <p>
            {interpolate(t.performance.noteSampling, [
              <strong key="sampling" className="text-ink-2">
                {t.performance.colSampling}
              </strong>,
              <strong key="gap" className="text-ink-2">
                {t.performance.colLongestGap}
              </strong>,
            ])}
          </p>
        </div>
      </div>
    </AppShell>
  );
}

function PerfRow({ r }: { r: CarrierPerformance }) {
  const t = useT();
  /*
   * The denominator is onTimeMeasurable, never completed.
   *
   * planned_delivery_at is optional on the order form, and a shipment that was
   * never given a deadline cannot be late. Dividing by every completed session
   * counted those as misses, so a carrier that has never missed a delivery
   * displayed 0% for as long as dispatchers left the field empty — on the page
   * people use to negotiate rates.
   */
  const measurable = r.onTimeMeasurable;
  const onTimePct = measurable > 0 ? Math.round((r.onTime / measurable) * 100) : null;

  return (
    <TR>
      <TD>
        <span className="font-medium">{r.name}</span>
      </TD>
      <TD numeric>{r.sessions}</TD>
      <TD numeric muted>{r.completed}</TD>
      <TD numeric>
        {onTimePct === null ? (
          <span
            className="text-ink-3"
            title={t.performance.noPromise}
          >
            —
          </span>
        ) : (
          <span className="inline-flex flex-col items-end leading-tight">
            <span
              className={
                onTimePct >= 90 ? 'text-success' : onTimePct >= 70 ? 'text-warn' : 'text-danger'
              }
            >
              {onTimePct}%
            </span>
            {/* The base, always visible. "11/12" survives a rate negotiation in
                a way that "92%" does not, and it also shows at a glance when a
                figure rests on three shipments. */}
            <span className="text-2xs text-ink-3">
              {r.onTime}/{measurable}
            </span>
          </span>
        )}
      </TD>
      <TD numeric>
        {r.avgSamplingPct === null ? (
          <span
            className="text-ink-3"
            title={t.performance.noSampling}
          >
            —
          </span>
        ) : (
          <SamplingBar pct={r.avgSamplingPct} />
        )}
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
 *
 * One neutral colour, deliberately. This used to go green above 90 and red
 * below 70, which turned a sampling ratio into a verdict on the driver. It is
 * not one: a truck parked four hours at a customs gate reports on its idle
 * cadence and lands in the red on a perfect trace. The bar stays because
 * length is easier to compare than digits; the accusation goes.
 */
function SamplingBar({ pct }: { pct: number }) {
  const v = Math.max(0, Math.min(100, Math.round(pct)));
  return (
    <span className="inline-flex items-center justify-end gap-2">
      <span className="h-1.5 w-16 overflow-hidden rounded-full bg-surface-3" aria-hidden>
        <span className="block h-full rounded-full bg-brand" style={{ width: `${v}%` }} />
      </span>
      <span className="w-9 text-end">{v}%</span>
    </span>
  );
}

function formatGap(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)} sn`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} dk`;
  return `${(seconds / 3600).toFixed(1)} sa`;
}

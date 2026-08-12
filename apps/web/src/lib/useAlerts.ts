'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type Alert, type AlertSeverity } from './api';
import { getSocket } from './useRealtime';

/* =============================================================================
   The exception desk, as data
   =============================================================================
   Everything the bell needs and nothing it renders. The panel is presentation;
   what is worth reasoning about is here, in one place, because three of these
   decisions are the difference between a badge a dispatcher trusts and a badge
   they learn to ignore.

     1. The socket is the mechanism, the poll is the safety net. An alert that
        arrives four minutes late because a proxy ate the websocket is an alert
        that arrives after the phone call from the customer.

     2. The number and the rows may never disagree. A badge saying 5 over a
        panel showing 3 teaches a dispatcher that the badge is decorative.

     3. Acknowledging must feel instant. It is how someone works down a list of
        twelve at 02:00, and a round trip per row turns that into a stutter.
   ========================================================================== */

/** Everything under this prefix is invalidated together — see the socket effect. */
const ALERTS_KEY = ['alerts'] as const;
const LIST_KEY = ['alerts', 'list'] as const;
const COUNT_KEY = ['alerts', 'count'] as const;

/**
 * Deliberately larger than the API's default page.
 *
 * The panel is a scroll box, not a paginated table: a fleet with 60 exceptions
 * open is a fleet in trouble, and that is exactly the moment the dispatcher
 * must not be paging. `total` still comes back, so anything beyond this is
 * reported honestly rather than silently dropped.
 */
const PANEL_LIMIT = 100;

/** Worst first. Mirrors the ORDER BY the API already applies. */
const SEVERITY_RANK: Record<AlertSeverity, number> = { CRITICAL: 0, WARNING: 1, INFO: 2 };

/**
 * Polling cadence with the socket up — a floor under the live feed, not the
 * feed. Two minutes is short enough that a missed frame is a nuisance rather
 * than an incident, long enough that 40 idle dashboards are not a load source.
 */
const POLL_LIVE_MS = 120_000;
/** …and with the socket down, when the poll IS the feed. */
const POLL_DEGRADED_MS = 20_000;

/**
 * A burst of socket events must produce one refetch.
 *
 * Acknowledging twelve alerts fans out into twelve `fleet:alert-acknowledged`
 * broadcasts, and every dashboard in the room would otherwise refetch the list
 * twelve times — the acknowledge-all button would DDoS the alerts endpoint
 * once per open browser tab.
 */
const COALESCE_MS = 400;

type AlertList = Awaited<ReturnType<typeof api.alerts>>;
type AlertCount = Awaited<ReturnType<typeof api.alertCount>>;

/**
 * Per-call callbacks, passed straight through to React Query.
 *
 * The failure has to be reported by whoever is on screen — a toast belongs to
 * the component tree, and reaching into it from here would make `lib` depend on
 * `components`, which is backwards.
 */
export interface AlertMutationOptions {
  onError?: (error: Error) => void;
  onSuccess?: () => void;
}

export interface AlertsView {
  /** Still wrong, worst first, newest first within a severity. */
  open: Alert[];
  /** Fixed by the world within the API's window. Same ordering. */
  resolved: Alert[];
  /** The badge number: raised and nobody has looked yet, open or not. */
  unacknowledged: number;
  /** The badge colour: how bad things are *now*, which is not the same thing. */
  worstOpen: AlertSeverity | null;
  /** Rows the page size cut off, so the panel can say so instead of lying. */
  truncated: number;
  /** Live feed state, so the panel can admit when it is only polling. */
  connected: boolean;

  isLoading: boolean;
  isError: boolean;
  /** There IS data, the last refresh simply failed. Different from isError. */
  isStale: boolean;
  error: Error | null;
  isFetching: boolean;
  refetch: () => void;

  acknowledge: (id: string, options?: AlertMutationOptions) => void;
  /** The row currently in flight, for a per-row spinner. */
  acknowledgingId: string | null;
  acknowledgeAll: (options?: AlertMutationOptions) => void;
  isAcknowledgingAll: boolean;
  /** False when there is nothing left to acknowledge. */
  canAcknowledgeAll: boolean;
}

export function useAlerts(): AlertsView {
  const qc = useQueryClient();
  const [connected, setConnected] = useState(false);
  const coalesce = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const socket = getSocket();

    const refresh = () => {
      // Trailing edge only: the first event of a burst starts the clock and
      // every event inside the window rides along on the same refetch.
      if (coalesce.current) return;
      coalesce.current = setTimeout(() => {
        coalesce.current = null;
        void qc.invalidateQueries({ queryKey: ALERTS_KEY });
      }, COALESCE_MS);
    };

    const onConnect = () => setConnected(true);
    const onDisconnect = () => setConnected(false);

    /*
     * All three lifecycle events, not just the raise.
     *
     * A resolution has to reach the panel or a dispatcher rings a driver about
     * an outage that ended two minutes ago, and an acknowledgement has to reach
     * it or two dispatchers ring the same driver about the same truck. The
     * badge is shared state across the room.
     *
     * Refetch rather than splicing the frame into the cache: the wire payload
     * is a notification (id, kind, severity, title) while a row is the full
     * join with the plate, the order and the consignee on it. Merging a partial
     * into a list is how one alert ends up rendered two different ways.
     */
    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('fleet:alert', refresh);
    socket.on('fleet:alert-resolved', refresh);
    socket.on('fleet:alert-acknowledged', refresh);

    // No `subscribe:fleet` here, ever. Room membership is per socket and this
    // hook shares the one the live map uses: joining from a component that is
    // mounted on every page would mean the map's own `unsubscribe:fleet` on
    // navigation silently evicts the bell too. The alert events are broadcast
    // to every authenticated dispatcher socket instead — see the API slice.
    setConnected(socket.connected);

    return () => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('fleet:alert', refresh);
      socket.off('fleet:alert-resolved', refresh);
      socket.off('fleet:alert-acknowledged', refresh);
      if (coalesce.current) clearTimeout(coalesce.current);
      coalesce.current = null;
    };
  }, [qc]);

  const list = useQuery({
    queryKey: LIST_KEY,
    queryFn: () => api.alerts({ limit: PANEL_LIMIT }),
    refetchInterval: connected ? POLL_LIVE_MS : POLL_DEGRADED_MS,
  });

  const count = useQuery({
    queryKey: COUNT_KEY,
    queryFn: api.alertCount,
    refetchInterval: connected ? POLL_LIVE_MS : POLL_DEGRADED_MS,
  });

  const items = useMemo(() => list.data?.items ?? [], [list.data]);

  const { open, resolved } = useMemo(() => {
    // The API already orders exactly this way. Sorting again is four lines and
    // it makes the panel's grouping a promise this component keeps on its own,
    // rather than one that quietly breaks the day someone tunes the SQL.
    const worstFirst = (a: Alert, b: Alert) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      Date.parse(b.raisedAt) - Date.parse(a.raisedAt);
    return {
      open: items.filter((a) => a.resolvedAt === null).sort(worstFirst),
      resolved: items.filter((a) => a.resolvedAt !== null).sort(worstFirst),
    };
  }, [items]);

  const unackedIds = useMemo(
    () => items.filter((a) => a.acknowledgedAt === null).map((a) => a.id),
    [items],
  );

  /*
   * Two sources, and which one wins is the point.
   *
   * The count endpoint is authoritative — it is a partial-index scan over every
   * outstanding alert and is never cut off by PANEL_LIMIT — so it owns the
   * number. The list owns the severities, because the count cannot carry them.
   * Before the list lands (first paint, or a list request that failed) the
   * count's `critical` breakdown is enough to colour the badge red, which is
   * the one colour that must never be late.
   */
  const unacknowledged = count.data?.unacknowledged ?? unackedIds.length;
  const worstOpen: AlertSeverity | null = list.data
    ? (open[0]?.severity ?? null)
    : count.data?.critical
      ? 'CRITICAL'
      : null;

  const acknowledge = useMutation({
    mutationFn: (id: string) => api.acknowledgeAlert(id),
    onMutate: async (id) => {
      // Cancel first: an in-flight refetch that resolves after this write would
      // land the pre-acknowledgement row back on the screen and the row would
      // appear to un-tick itself.
      await qc.cancelQueries({ queryKey: ALERTS_KEY });
      const at = new Date().toISOString();
      const previousList = qc.getQueryData<AlertList>(LIST_KEY);
      const previousCount = qc.getQueryData<AlertCount>(COUNT_KEY);

      qc.setQueryData<AlertList>(
        LIST_KEY,
        (old) =>
          old && {
            ...old,
            items: old.items.map((a) =>
              a.id === id && a.acknowledgedAt === null ? { ...a, acknowledgedAt: at } : a,
            ),
          },
      );
      // The badge is a separate query and would otherwise keep its old number
      // until the refetch, which reads as "the click did nothing".
      qc.setQueryData<AlertCount>(
        COUNT_KEY,
        (old) => old && { ...old, unacknowledged: Math.max(0, old.unacknowledged - 1) },
      );

      return { previousList, previousCount };
    },
    onError: (_error, _id, ctx) => {
      if (ctx?.previousList) qc.setQueryData(LIST_KEY, ctx.previousList);
      if (ctx?.previousCount) qc.setQueryData(COUNT_KEY, ctx.previousCount);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ALERTS_KEY }),
  });

  const acknowledgeAll = useMutation({
    /*
     * There is no bulk endpoint, so this is a fan-out.
     *
     * `allSettled`, not `all`: one row that lost the acknowledge race to
     * another dispatcher must not hide the eleven that succeeded, and it must
     * not abort the rest. The failure count is what the caller reports.
     *
     * Not optimistic, unlike the single-row path. A partial failure means an
     * optimistic all-clear would be a lie about which shipments have an owner,
     * and that is the one thing this panel exists to get right.
     */
    mutationFn: async (ids: string[]) => {
      const results = await Promise.allSettled(ids.map((id) => api.acknowledgeAlert(id)));
      const failed = results.filter((r) => r.status === 'rejected').length;
      if (failed > 0) throw new Error(`${failed} uyarı işaretlenemedi.`);
      return results.length;
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ALERTS_KEY }),
  });

  return {
    open,
    resolved,
    unacknowledged,
    worstOpen,
    truncated: Math.max(0, (list.data?.total ?? 0) - items.length),
    connected,

    // The count alone is not enough to claim the desk is healthy: an empty
    // badge next to a failed list means "I could not ask", which the panel
    // renders as an error rather than as an all-clear.
    isLoading: list.isLoading,
    /*
     * Only a hard error when there is nothing to show. React Query keeps
     * `data` on a failed refetch, so a single 502 during a deploy would
     * otherwise blank a list a dispatcher is halfway through working — and
     * replace the badge count with "!" — from rows the app still holds.
     */
    isError: list.isError && list.data === undefined,
    isStale: list.isError && list.data !== undefined,
    error: (list.error as Error) ?? null,
    isFetching: list.isFetching || count.isFetching,
    refetch: () => {
      void list.refetch();
      void count.refetch();
    },

    acknowledge: (id, options) => acknowledge.mutate(id, options),
    acknowledgingId: acknowledge.isPending ? (acknowledge.variables ?? null) : null,
    acknowledgeAll: (options) => acknowledgeAll.mutate(unackedIds, options),
    isAcknowledgingAll: acknowledgeAll.isPending,
    canAcknowledgeAll: unackedIds.length > 0,
  };
}

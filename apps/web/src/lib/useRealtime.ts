'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { io, type Socket } from 'socket.io-client';
import { API_BASE, refreshTokens, tokens, type FleetPosition } from './api';

const SOCKET_URL = (process.env.NEXT_PUBLIC_API_URL ?? API_BASE).replace(/\/api\/v1\/?$/, '');

export interface LivePositionEvent {
  sessionId: string;
  lat: number;
  lon: number;
  speedMps: number | null;
  bearingDeg: number | null;
  accuracyM: number | null;
  batteryPct: number | null;
  isCharging: boolean | null;
  recordedAt: string;
  pointsTotal: number;
  distanceM: number;
}

export interface BackfillEvent {
  sessionId: string;
  batchId: string;
  from: string;
  to: string;
  count: number;
  truncated: boolean;
  points: Array<[number, number, string]>;
  hint?: 'refetch';
}

let shared: Socket | null = null;

function getSocket(): Socket {
  if (shared?.connected || shared?.active) return shared;
  shared = io(SOCKET_URL, {
    path: '/realtime',
    transports: ['websocket', 'polling'],

    /*
     * The FUNCTION form, not an object. This is the whole bug.
     *
     * socket.io-client evaluates `auth` once when it is an object and resends
     * that same frozen payload on every reconnect; only the callback form is
     * re-evaluated per attempt. The socket is a module singleton that outlives
     * every token rotation, so with `auth: { token: tokens.access }` a laptop
     * that slept overnight woke up, reconnected with an expired token, was
     * rejected, and retried forever with the same dead credential. The header
     * showed a red dot and the map never updated again — the dispatcher spent
     * the morning looking at a frozen fleet.
     */
    auth: (cb: (data: Record<string, unknown>) => void) => cb({ token: tokens.access }),

    reconnection: true,
    reconnectionDelay: 500,
    reconnectionDelayMax: 10_000,
    // Unlimited: a dispatcher's laptop sleeping overnight must reconnect in the
    // morning without a page reload.
    reconnectionAttempts: Infinity,
    timeout: 20_000,
  });
  return shared;
}

/**
 * Fleet-wide live positions.
 *
 * The socket is a *patch channel*, not a parallel store. It writes snapshots
 * straight into the React Query cache under ['live-fleet'], so there is exactly
 * one fleet array in the application.
 *
 * The previous version kept a second copy in `useState` and read
 * `snapshot.length > 0 ? snapshot : httpData`, which broke three ways. Once the
 * socket had connected even once the ternary was permanently pinned to the
 * socket copy, so the documented HTTP fallback could never engage and a socket
 * that died left the UI frozen while React Query refetched into a value nobody
 * read. A legitimately empty snapshot fell through to the stale HTTP array and
 * resurrected ghost trucks. And "no trucks" was indistinguishable from "no
 * snapshot yet".
 */
export function useFleetStream() {
  const qc = useQueryClient();
  const [connected, setConnected] = useState(false);
  const [authFailed, setAuthFailed] = useState(false);
  const [positions, setPositions] = useState<Map<string, LivePositionEvent>>(new Map());
  const [lastEventAt, setLastEventAt] = useState(0);

  useEffect(() => {
    const socket = getSocket();

    const writeSnapshot = (list: FleetPosition[] | undefined) => {
      if (!list) return;
      qc.setQueryData(['live-fleet'], (old: { at: string; count: number; positions: FleetPosition[] } | undefined) => ({
        at: new Date().toISOString(),
        count: list.length,
        ...(old ?? {}),
        positions: list,
      }));
      // Mark it fresh so a focus event does not immediately refetch over a
      // snapshot that arrived one second ago.
      qc.setQueryData(['live-fleet-updatedAt'], Date.now());
    };

    const handleConnect = () => {
      setConnected(true);
      setAuthFailed(false);
      socket.emit('subscribe:fleet', {}, (ack: { data?: { positions: FleetPosition[] } }) => {
        writeSnapshot(ack?.data?.positions);
      });
    };

    const handleFleet = (payload: { positions: LivePositionEvent[] }) => {
      setPositions((prev) => {
        const next = new Map(prev);
        for (const p of payload.positions) next.set(p.sessionId, p);
        return next;
      });
      setLastEventAt(Date.now());
    };

    const handleSnapshot = (payload: { positions: FleetPosition[] }) => writeSnapshot(payload.positions);

    const handleDisconnect = () => setConnected(false);

    /*
     * There was no connect_error listener at all, so an authentication
     * rejection was indistinguishable from a network blip and nothing was ever
     * logged. Refresh once and let the reconnect loop pick up the new token;
     * if the refresh itself fails the session is genuinely over and the flag
     * lets the UI say so instead of showing a red dot forever.
     */
    const handleConnectError = async (err: Error) => {
      setConnected(false);
      const msg = String(err?.message ?? '').toLowerCase();
      const looksAuth =
        msg.includes('auth') || msg.includes('unauthor') || msg.includes('token') || msg.includes('jwt');
      if (!looksAuth) return;
      const ok = await refreshTokens();
      setAuthFailed(!ok);
    };

    socket.on('connect', handleConnect);
    socket.on('disconnect', handleDisconnect);
    socket.on('connect_error', handleConnectError);
    socket.on('fleet:positions', handleFleet);
    socket.on('fleet:snapshot', handleSnapshot);

    if (socket.connected) handleConnect();
    else socket.connect();

    return () => {
      socket.off('connect', handleConnect);
      socket.off('disconnect', handleDisconnect);
      socket.off('connect_error', handleConnectError);
      socket.off('fleet:positions', handleFleet);
      socket.off('fleet:snapshot', handleSnapshot);
      socket.emit('unsubscribe:fleet');
    };
  }, [qc]);

  return { connected, authFailed, positions, lastEventAt };
}

/**
 * One session's unthrottled stream.
 *
 * `position:update` and `route:backfill` are handled separately on purpose
 * (ADR-006): a backfill must extend the drawn route without moving the marker,
 * otherwise a truck leaving a dead zone appears to drive backwards for several
 * seconds.
 */
export function useSessionStream(sessionId: string | null) {
  const [connected, setConnected] = useState(false);
  const [live, setLive] = useState<LivePositionEvent | null>(null);
  const [backfills, setBackfills] = useState<BackfillEvent[]>([]);
  const [events, setEvents] = useState<Array<{ type: string; message: string | null; at: string }>>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [needsRefetch, setNeedsRefetch] = useState(0);

  // Backfills accumulate for the lifetime of the page. A truck that spends a
  // day crossing Anatolia with patchy coverage can produce hundreds, and every
  // one of them was retained forever — on a screen that stays open all day
  // that is an unbounded array feeding an unbounded number of map sources.
  const clearBackfills = useCallback(() => setBackfills([]), []);

  useEffect(() => {
    if (!sessionId) return;
    const socket = getSocket();

    // A different session means none of the previous session's state applies.
    setLive(null);
    setBackfills([]);
    setEvents([]);
    setStatus(null);

    const subscribe = () => {
      setConnected(true);
      socket.emit('subscribe:session', { sessionId });
    };

    const onPosition = (payload: LivePositionEvent) => {
      if (payload.sessionId === sessionId) setLive(payload);
    };

    const onBackfill = (payload: BackfillEvent) => {
      if (payload.sessionId !== sessionId) return;
      if (payload.truncated || payload.hint === 'refetch') {
        // Too big to stream — pull the server-simplified route over HTTP.
        setNeedsRefetch((n) => n + 1);
      } else {
        setBackfills((prev) => {
          // Past 60 segments the accumulated geometry is larger than a single
          // simplified refetch, so stop growing and ask for the whole route.
          if (prev.length >= 60) {
            setNeedsRefetch((n) => n + 1);
            return [];
          }
          return [...prev, payload];
        });
      }
    };

    const onEvent = (payload: { type: string; message: string | null; at: string }) =>
      setEvents((prev) => [payload, ...prev].slice(0, 100));

    const onState = (payload: { status: string }) => setStatus(payload.status);
    const onDisconnect = () => setConnected(false);

    socket.on('connect', subscribe);
    socket.on('disconnect', onDisconnect);
    socket.on('position:update', onPosition);
    socket.on('route:backfill', onBackfill);
    socket.on('session:event', onEvent);
    socket.on('session:state', onState);

    if (socket.connected) subscribe();
    else socket.connect();

    return () => {
      socket.emit('unsubscribe:session', { sessionId });
      socket.off('connect', subscribe);
      socket.off('disconnect', onDisconnect);
      socket.off('position:update', onPosition);
      socket.off('route:backfill', onBackfill);
      socket.off('session:event', onEvent);
      socket.off('session:state', onState);
    };
  }, [sessionId]);

  return { connected, live, backfills, events, status, needsRefetch, clearBackfills };
}

export function disconnectRealtime() {
  shared?.disconnect();
  shared = null;
}

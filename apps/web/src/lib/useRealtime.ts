'use client';

import { useEffect, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import { API_BASE, tokens, type FleetPosition } from './api';

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
    auth: { token: tokens.access },
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
 * The socket is a *patch channel*, not the source of truth. On every (re)connect
 * we take a fresh HTTP snapshot and let socket frames apply deltas on top.
 * Trying to replay missed frames after a disconnect is how live maps end up
 * showing trucks in last Tuesday's positions.
 */
export function useFleetStream(onSnapshot?: (positions: FleetPosition[]) => void) {
  const [connected, setConnected] = useState(false);
  const [positions, setPositions] = useState<Map<string, LivePositionEvent>>(new Map());
  const [lastEventAt, setLastEventAt] = useState<number>(0);
  const onSnapshotRef = useRef(onSnapshot);
  onSnapshotRef.current = onSnapshot;

  useEffect(() => {
    const socket = getSocket();

    const handleConnect = () => {
      setConnected(true);
      socket.emit('subscribe:fleet', {}, (ack: { data?: { positions: FleetPosition[] } }) => {
        if (ack?.data?.positions) onSnapshotRef.current?.(ack.data.positions);
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

    socket.on('connect', handleConnect);
    socket.on('disconnect', () => setConnected(false));
    socket.on('fleet:positions', handleFleet);
    socket.on('fleet:snapshot', (payload: { positions: FleetPosition[] }) =>
      onSnapshotRef.current?.(payload.positions),
    );

    if (socket.connected) handleConnect();
    else socket.connect();

    return () => {
      socket.off('connect', handleConnect);
      socket.off('fleet:positions', handleFleet);
      socket.off('fleet:snapshot');
      socket.emit('unsubscribe:fleet');
    };
  }, []);

  return { connected, positions, lastEventAt };
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

  useEffect(() => {
    if (!sessionId) return;
    const socket = getSocket();

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
        setBackfills((prev) => [...prev, payload]);
      }
    };

    const onEvent = (payload: { type: string; message: string | null; at: string }) =>
      setEvents((prev) => [payload, ...prev].slice(0, 100));

    const onState = (payload: { status: string }) => setStatus(payload.status);

    socket.on('connect', subscribe);
    socket.on('disconnect', () => setConnected(false));
    socket.on('position:update', onPosition);
    socket.on('route:backfill', onBackfill);
    socket.on('session:event', onEvent);
    socket.on('session:state', onState);

    if (socket.connected) subscribe();
    else socket.connect();

    return () => {
      socket.emit('unsubscribe:session', { sessionId });
      socket.off('connect', subscribe);
      socket.off('position:update', onPosition);
      socket.off('route:backfill', onBackfill);
      socket.off('session:event', onEvent);
      socket.off('session:state', onState);
    };
  }, [sessionId]);

  return { connected, live, backfills, events, status, needsRefetch };
}

export function disconnectRealtime() {
  shared?.disconnect();
  shared = null;
}

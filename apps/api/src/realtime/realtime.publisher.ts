import { Inject, Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import type { Server } from 'socket.io';
import { CONFIG, type AppConfig } from '../config/configuration';

export interface LivePosition {
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

export interface BackfillSegment {
  sessionId: string;
  batchId: string;
  from: string;
  to: string;
  count: number;
  points: Array<[number, number, string]>; // [lon, lat, isoTime]
}

/**
 * A row of kh.alerts on the wire.
 *
 * Deliberately smaller than the row: this frame exists to raise a toast and
 * bump a badge, and `GET /alerts` is the full record with the order, customer
 * and vehicle context hung off it. Sending the join down every socket would
 * put the fleet map's coalescing work back on the browser it was taken off.
 */
export interface AlertNotification {
  id: string;
  sessionId: string;
  reference: string | null;
  kind: string;
  severity: 'INFO' | 'WARNING' | 'CRITICAL';
  title: string;
  detail: string | null;
  raisedAt: string;
}

export const ROOM_FLEET = 'fleet:live';

/*
 * Alerts cannot ride ROOM_FLEET.
 *
 * That room is joined by an explicit `subscribe:fleet` and left again by the
 * live map's own `unsubscribe:fleet` on navigation — so the bell would be deaf
 * on /orders, /sessions, /customers, /carriers and /performance, and would go
 * deaf on the map itself the moment the page unmounted. It works on the live
 * map, which is the page anyone tests first, so the failure is silent.
 *
 * Every socket that authenticates is a dispatcher and the bell is on every
 * screen, so this room is joined at connection time and left by disconnecting.
 */
export const ROOM_ALERTS = 'alerts';
export const roomSession = (id: string) => `session:${id}`;

/**
 * The only component that writes to sockets.
 *
 * Two responsibilities, both from ADR-006:
 *
 *  1. **Event taxonomy.** `position:update` moves the marker; `route:backfill`
 *     only splices geometry. A truck coming out of a dead zone must never make
 *     its own marker rewind across the map.
 *
 *  2. **Coalescing.** Detail-view subscribers get every event immediately — they
 *     are watching one truck. The fleet overview gets a *coalesced* frame at
 *     most once per `fleetThrottleMs`, last-value-wins per session. With 250
 *     trucks pinging at 5 s that turns ~50 msg/s of individual frames into 1
 *     msg/s carrying an array, which is what keeps a browser tab at 60 fps.
 */
@Injectable()
export class RealtimePublisher implements OnApplicationShutdown {
  private readonly logger = new Logger(RealtimePublisher.name);
  private server: Server | null = null;

  private readonly pending = new Map<string, LivePosition>();
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(@Inject(CONFIG) private readonly config: AppConfig) {}

  attach(server: Server): void {
    this.server = server;
    if (!this.flushTimer) {
      this.flushTimer = setInterval(
        () => this.flushFleet(),
        this.config.realtime.fleetThrottleMs,
      );
      // Never keep the process alive purely for the throttle timer.
      this.flushTimer.unref?.();
    }
    this.logger.log('Realtime publisher attached to Socket.IO server');
  }

  onApplicationShutdown(): void {
    if (this.flushTimer) clearInterval(this.flushTimer);
  }

  /** A point newer than anything we have seen: move the truck. */
  position(position: LivePosition): void {
    if (!this.server) return;
    // Detail subscribers: immediate, unthrottled.
    this.server.to(roomSession(position.sessionId)).emit('position:update', position);
    // Fleet overview: coalesce.
    this.pending.set(position.sessionId, position);
  }

  /**
   * Points that arrived late. The dashboard splices these into the polyline and
   * leaves the marker where it is.
   *
   * Capped: dumping a 10,000-point backlog down a WebSocket is how you freeze a
   * dispatcher's browser. Past the cap we send a summary and the client refetches
   * the (server-simplified) route over HTTP instead.
   */
  backfill(segment: BackfillSegment): void {
    if (!this.server) return;
    const cap = this.config.realtime.maxBackfillBroadcastPoints;

    if (segment.count > cap) {
      this.server.to(roomSession(segment.sessionId)).emit('route:backfill', {
        sessionId: segment.sessionId,
        batchId: segment.batchId,
        from: segment.from,
        to: segment.to,
        count: segment.count,
        truncated: true,
        points: [],
        hint: 'refetch',
      });
    } else {
      this.server.to(roomSession(segment.sessionId)).emit('route:backfill', {
        ...segment,
        truncated: false,
      });
    }

    this.server.to(ROOM_FLEET).emit('fleet:backfill', {
      sessionId: segment.sessionId,
      count: segment.count,
      from: segment.from,
      to: segment.to,
    });
  }

  sessionState(sessionId: string, status: string, extra: Record<string, unknown> = {}): void {
    if (!this.server) return;
    const payload = { sessionId, status, at: new Date().toISOString(), ...extra };
    this.server.to(roomSession(sessionId)).emit('session:state', payload);
    this.server.to(ROOM_FLEET).emit('fleet:session-state', payload);
  }

  /**
   * A timeline event on one session.
   *
   * The fleet copy is not symmetry for its own sake. `sessionState` above has
   * always emitted to both rooms while this method emitted to `roomSession()`
   * alone, and that asymmetry is the whole reason 74 GPS_LOST events reached
   * nobody: the silence job — the one whose own comment calls it "the alert
   * that actually saves shipments" — announced every one of them into
   * `session:<id>`, a room that is empty unless a dispatcher already has that
   * exact truck's detail page open. Nobody has that page open at 02:00.
   *
   * The fleet copy carries its own event name, matching `fleet:session-state`,
   * so the overview can bind to it directly. Reusing `session:event` for both
   * rooms would force every dashboard to receive the chatter of all 250 trucks
   * and throw away the 249 it is not showing.
   */
  sessionEvent(sessionId: string, type: string, message: string | null): void {
    if (!this.server) return;
    const payload = { sessionId, type, message, at: new Date().toISOString() };
    this.server.to(roomSession(sessionId)).emit('session:event', payload);
    this.server.to(ROOM_FLEET).emit('fleet:session-event', payload);
  }

  /**
   * A newly opened kh.alerts row.
   *
   * Separate from `sessionEvent` because an alert is a different object from a
   * timeline entry: it has an id to acknowledge against, a severity that drives
   * the badge colour, and a lifecycle. A dashboard binding to `fleet:alert`
   * gets exactly the things a human must act on, with no filtering.
   *
   * Callers must only reach here when `kh.raise_alert()` returned an id. It
   * returns NULL when an alert of that kind is already open, and re-announcing
   * a six-hour signal loss every five minutes is how a badge becomes wallpaper.
   */
  alertRaised(alert: AlertNotification): void {
    if (!this.server) return;
    this.server.to(roomSession(alert.sessionId)).emit('session:alert', alert);
    this.server.to(ROOM_ALERTS).emit('fleet:alert', alert);
  }

  /**
   * The world fixed it: the signal came back, the truck moved, the phone went
   * on charge. Broadcast so an open dashboard can strike the row through
   * without waiting for its next poll — a dispatcher chasing a truck that
   * recovered two minutes ago is the same wasted phone call as one who never
   * heard about the outage.
   */
  alertResolved(sessionId: string, alertId: string, kind: string): void {
    if (!this.server) return;
    const payload = { id: alertId, sessionId, kind, at: new Date().toISOString() };
    this.server.to(roomSession(sessionId)).emit('session:alert-resolved', payload);
    this.server.to(ROOM_ALERTS).emit('fleet:alert-resolved', payload);
  }

  /**
   * A person looked. Broadcast because the badge is shared state: without this
   * every other dispatcher's counter keeps the alert until their next refetch,
   * and two people ring the same driver about the same truck.
   */
  alertAcknowledged(sessionId: string, alertId: string, byUserId: string): void {
    if (!this.server) return;
    const payload = { id: alertId, sessionId, by: byUserId, at: new Date().toISOString() };
    this.server.to(roomSession(sessionId)).emit('session:alert-acknowledged', payload);
    this.server.to(ROOM_ALERTS).emit('fleet:alert-acknowledged', payload);
  }

  /** Per-batch ingest telemetry, useful on the session detail page. */
  ingestStats(
    sessionId: string,
    stats: { accepted: number; duplicates: number; rejected: number; offline: boolean; lagSec: number | null },
  ): void {
    if (!this.server) return;
    this.server.to(roomSession(sessionId)).emit('ingest:stats', { sessionId, ...stats });
  }

  private flushFleet(): void {
    if (!this.server || this.pending.size === 0) return;
    const batch = [...this.pending.values()];
    this.pending.clear();
    this.server.to(ROOM_FLEET).emit('fleet:positions', {
      at: new Date().toISOString(),
      positions: batch,
    });
  }
}

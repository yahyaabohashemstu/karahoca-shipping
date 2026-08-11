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

export const ROOM_FLEET = 'fleet:live';
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

  sessionEvent(sessionId: string, type: string, message: string | null): void {
    if (!this.server) return;
    this.server.to(roomSession(sessionId)).emit('session:event', {
      sessionId,
      type,
      message,
      at: new Date().toISOString(),
    });
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

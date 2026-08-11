import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DatabaseService } from '../database/database.service';
import { RedisService } from '../redis/redis.service';
import { RealtimePublisher } from '../realtime/realtime.publisher';

/**
 * Scheduled housekeeping.
 *
 * Every job is wrapped in a Redis leader lock so that scaling the API to N
 * replicas does not expire the same session N times. The lock TTL is shorter
 * than the interval, so a crashed leader is replaced on the next tick without
 * any coordination protocol.
 */
@Injectable()
export class MaintenanceService {
  private readonly logger = new Logger(MaintenanceService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly redis: RedisService,
    private readonly publisher: RealtimePublisher,
  ) {}

  private async withLeaderLock(name: string, ttlSec: number, fn: () => Promise<void>) {
    const acquired = await this.redis.client.set(`lock:${name}`, process.pid, 'EX', ttlSec, 'NX');
    if (acquired !== 'OK') return;
    try {
      await fn();
    } catch (err) {
      this.logger.error(`Job "${name}" failed: ${(err as Error).message}`);
    }
  }

  /** Claim codes that were never used, and sessions past their hard lifetime. */
  @Cron(CronExpression.EVERY_MINUTE)
  async expireSessions(): Promise<void> {
    await this.withLeaderLock('expire-sessions', 55, async () => {
      const rows = await this.db.query<{ expired_id: string; previous_status: string }>(
        `SELECT * FROM kh.expire_stale_sessions()`,
      );
      for (const row of rows) {
        await this.redis.invalidateSessionAuth(row.expired_id);
        this.publisher.sessionState(row.expired_id, 'EXPIRED', { from: row.previous_status });
      }
      if (rows.length) this.logger.log(`Expired ${rows.length} session(s)`);
    });
  }

  /** Destination geofence entry → arrival event on the dispatcher's timeline. */
  @Cron('*/30 * * * * *')
  async detectArrivals(): Promise<void> {
    await this.withLeaderLock('detect-arrivals', 25, async () => {
      const rows = await this.db.query<{ session_id: string; distance_m: number }>(
        `SELECT * FROM kh.detect_arrivals()`,
      );
      for (const row of rows) {
        this.publisher.sessionEvent(
          row.session_id,
          'GEOFENCE_ENTER',
          `Vehicle reached the destination (${Math.round(row.distance_m)} m from the drop point)`,
        );
        this.logger.log(`Arrival detected for session ${row.session_id}`);
      }
    });
  }

  /**
   * Silence detection.
   *
   * An ACTIVE session with no fix for 15 minutes means one of: dead zone, dead
   * battery, killed service, or a driver who closed the app. We cannot tell
   * which from the server, so we surface it rather than guess — the dispatcher
   * phones the driver. This is the alert that actually saves shipments.
   */
  @Cron(CronExpression.EVERY_5_MINUTES)
  async detectSilence(): Promise<void> {
    await this.withLeaderLock('detect-silence', 250, async () => {
      const rows = await this.db.query<{
        id: string;
        reference: string;
        minutes_silent: number;
        last_battery_pct: number | null;
      }>(
        `WITH silent AS (
           SELECT s.id, s.reference, s.last_battery_pct,
                  extract(epoch FROM (now() - s.last_point_at)) / 60 AS minutes_silent
           FROM kh.tracking_sessions s
           WHERE s.status = 'ACTIVE'
             AND s.last_point_at IS NOT NULL
             AND s.last_point_at < now() - interval '15 minutes'
             AND NOT EXISTS (
               SELECT 1 FROM kh.session_events e
               WHERE e.session_id = s.id
                 AND e.type = 'GPS_LOST'
                 AND e.occurred_at > now() - interval '30 minutes'
             )
         ),
         logged AS (
           INSERT INTO kh.session_events (session_id, type, actor, payload, message)
           SELECT id, 'GPS_LOST', 'system',
                  jsonb_build_object('minutesSilent', round(minutes_silent)),
                  format('No position for %s minutes', round(minutes_silent))
           FROM silent
           RETURNING session_id
         )
         SELECT * FROM silent`,
      );

      for (const row of rows) {
        this.publisher.sessionEvent(
          row.id,
          'GPS_LOST',
          `No position received for ${Math.round(row.minutes_silent)} minutes` +
            (row.last_battery_pct !== null ? ` (battery was ${row.last_battery_pct}%)` : ''),
        );
        this.logger.warn(
          `Session ${row.reference} silent for ${Math.round(row.minutes_silent)} min`,
        );
      }
    });
  }

  /** Housekeeping on the auth tables. Cheap, but unbounded growth is a bug. */
  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async pruneTokens(): Promise<void> {
    await this.withLeaderLock('prune-tokens', 3600, async () => {
      const rows = await this.db.query<{ deleted: number }>(
        `WITH gone AS (
           DELETE FROM kh.refresh_tokens
           WHERE expires_at < now() - interval '30 days'
              OR (revoked_at IS NOT NULL AND revoked_at < now() - interval '30 days')
           RETURNING 1
         ) SELECT count(*)::int AS deleted FROM gone`,
      );
      this.logger.log(`Pruned ${rows[0]?.deleted ?? 0} expired refresh token(s)`);
    });
  }
}

import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { Public } from '../auth/decorators';
import { DatabaseService } from '../database/database.service';
import { RedisService } from '../redis/redis.service';

@Controller('health')
export class HealthController {
  private readonly startedAt = Date.now();

  constructor(
    private readonly db: DatabaseService,
    private readonly redis: RedisService,
  ) {}

  /** Liveness: is the process up? Must never touch a dependency. */
  @Public()
  @Get()
  liveness() {
    return {
      status: 'ok',
      uptimeSec: Math.round((Date.now() - this.startedAt) / 1000),
      version: process.env.APP_VERSION ?? 'dev',
      time: new Date().toISOString(),
    };
  }

  /**
   * Readiness: can we serve traffic? Checks dependencies.
   *
   * Coolify/Docker gate the container on this, so a database blip briefly pulls
   * the instance from rotation instead of returning 500s to trucks.
   */
  @Public()
  @Get('ready')
  async readiness(@Res() reply: FastifyReply) {
    const [database, redis] = await Promise.allSettled([
      this.db.healthCheck(),
      this.redis.healthCheck(),
    ]);

    const ok = database.status === 'fulfilled' && redis.status === 'fulfilled';
    return reply.status(ok ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE).send({
      status: ok ? 'ready' : 'degraded',
      database: database.status === 'fulfilled' ? database.value : { ok: false, error: String(database.reason) },
      redis: redis.status === 'fulfilled' ? redis.value : { ok: false, error: String(redis.reason) },
      time: new Date().toISOString(),
    });
  }

  /** Operational counters for a dashboard tile or an uptime probe. */
  @Public()
  @Get('stats')
  async stats() {
    const [row] = await this.db.query<Record<string, number>>(
      `SELECT
         (SELECT count(*)::int FROM kh.tracking_sessions WHERE status = 'ACTIVE')     AS "activeSessions",
         (SELECT count(*)::int FROM kh.tracking_sessions WHERE status = 'ASSIGNED')   AS "awaitingClaim",
         (SELECT count(*)::int FROM kh.tracking_sessions
           WHERE status = 'ACTIVE' AND last_point_at < now() - interval '15 minutes') AS "silentSessions",
         (SELECT count(*)::int FROM kh.ingest_batches WHERE received_at > now() - interval '1 hour')
                                                                                       AS "batchesLastHour",
         (SELECT coalesce(sum(accepted_count), 0)::int FROM kh.ingest_batches
           WHERE received_at > now() - interval '1 hour')                              AS "pointsLastHour",
         (SELECT count(*)::int FROM kh.ingest_batches
           WHERE received_at > now() - interval '1 hour' AND is_offline_sync)          AS "offlineSyncsLastHour"`,
    );
    return row;
  }
}

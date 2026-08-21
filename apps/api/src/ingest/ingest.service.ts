import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { CONFIG, type AppConfig } from '../config/configuration';
import { DatabaseService } from '../database/database.service';
import { RedisService } from '../redis/redis.service';
import { RealtimePublisher } from '../realtime/realtime.publisher';
import { ReleaseService } from '../release/release.service';
import type { DriverContext } from '../auth/auth.types';

/** Shape accepted by `kh.ingest_points` via jsonb_to_recordset. */
interface NormalisedPoint {
  client_point_id: string;
  recorded_at: string;
  lat: number;
  lon: number;
  accuracy_m: number | null;
  altitude_m: number | null;
  vertical_accuracy_m: number | null;
  speed_mps: number | null;
  speed_accuracy_mps: number | null;
  bearing_deg: number | null;
  elapsed_realtime_ns: number | null;
  battery_pct: number | null;
  is_charging: boolean;
  is_mock: boolean;
  satellites: number | null;
  provider: string;
  network_type: string | null;
  device_seq: number | null;
}

interface IngestResult {
  accepted: number;
  duplicates: number;
  rejected: number;
  batchId: string;
  serverTime: string;
  advanced: boolean;
  sessionStatus: string;
  sessionId: string;
  pointsTotal: number;
  distanceM: number;
  oldestPointAt: string | null;
  newestPointAt: string | null;
  live: {
    lat: number;
    lon: number;
    speedMps: number | null;
    bearingDeg: number | null;
    accuracyM: number | null;
    batteryPct: number | null;
    isCharging: boolean | null;
    recordedAt: string;
  } | null;
  policy: { pingIntervalSec: number; idleIntervalSec: number; minDistanceM: number };
}

@Injectable()
export class IngestService {
  private readonly logger = new Logger(IngestService.name);

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly db: DatabaseService,
    private readonly redis: RedisService,
    private readonly publisher: RealtimePublisher,
    private readonly releases: ReleaseService,
  ) {}

  /**
   * The write path. One database round trip for the common case.
   *
   * Everything expensive — deduplication, validation, distance accumulation,
   * session-state advancement, batch bookkeeping — happens inside
   * `kh.ingest_points` (ADR-005), so a 5,000-point offline dump never blocks
   * Node's event loop looping over JavaScript objects.
   */
  async ingest(
    driver: DriverContext,
    payload: {
      batchId?: string;
      offline?: boolean;
      bufferRemaining?: number;
      points: unknown[];
    },
    meta: { ip?: string; bodyBytes: number },
  ) {
    const started = Date.now();
    const batchId = this.validBatchId(payload.batchId);

    if (payload.points.length > this.config.ingest.maxBatchPoints) {
      // Tell the device the ceiling so it re-chunks rather than retrying forever.
      throw new HttpException(
        {
          code: 'BATCH_TOO_LARGE',
          message: `Batch of ${payload.points.length} exceeds the limit`,
          maxBatchPoints: this.config.ingest.maxBatchPoints,
        },
        HttpStatus.PAYLOAD_TOO_LARGE,
      );
    }

    const { points, malformed } = this.normalisePoints(payload.points);
    if (points.length === 0) {
      throw new BadRequestException({
        code: 'NO_VALID_POINTS',
        message: `All ${payload.points.length} point(s) were malformed`,
        malformed,
      });
    }

    // Point-volume rate limit, distinct from the request-count limit in the
    // guard: 120 requests/min of 5,000 points each would still be 600k points.
    const quota = await this.redis.consume(
      `ingest:pts:${driver.sessionId}`,
      this.config.ingest.rateLimitPointsPerMin,
      60,
      points.length,
    );
    if (!quota.allowed) {
      throw new HttpException(
        {
          code: 'POINT_QUOTA_EXCEEDED',
          message: 'Point quota for this session exceeded',
          retryAfterSec: quota.resetSec,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const [row] = await this.db.query<{ ingest_points: IngestResult }>(
      `SELECT kh.ingest_points($1::uuid, $2::uuid, $3::text, $4::jsonb, $5::boolean, $6::inet, $7::int, $8::int)
              AS ingest_points`,
      [
        driver.sessionId,
        batchId,
        driver.deviceId,
        JSON.stringify(points),
        payload.offline ?? false,
        meta.ip ?? null,
        meta.bodyBytes,
        Date.now() - started,
      ],
    );

    const result = row.ingest_points;

    // Fan out asynchronously: a slow socket must never slow the truck's upload.
    void this.broadcast(result, batchId, payload.offline ?? false).catch((err) =>
      this.logger.error(`Realtime fan-out failed for ${driver.sessionId}: ${err.message}`),
    );

    if (payload.offline && result.accepted > 0) {
      this.logger.log(
        `Recovered ${result.accepted} buffered point(s) for session ${driver.sessionId} ` +
          `(${result.oldestPointAt} → ${result.newestPointAt}, ${payload.bufferRemaining ?? '?'} left in buffer)`,
      );
    }

    return {
      accepted: result.accepted,
      duplicates: result.duplicates,
      rejected: result.rejected + malformed,
      batchId,
      // The device stores (serverTime − localTime) and signs subsequent requests
      // with the corrected clock. This is what makes HMAC survive a wrong phone
      // clock (ADR-011).
      serverTime: Math.floor(new Date(result.serverTime).getTime() / 1000),
      sessionStatus: result.sessionStatus,
      pointsTotal: result.pointsTotal,
      distanceM: result.distanceM,
      policy: result.policy,
      // Explicit instruction rather than an inference the client has to make.
      nextAction: result.sessionStatus === 'PAUSED' ? 'PAUSE' : 'CONTINUE',
      /*
       * The released build, on the one response a phone is guaranteed to read.
       *
       * A tracking phone posts here every ten seconds and reads the manifest
       * twice a day, so a release could sit unnoticed for hours on exactly the
       * handsets that are out on the road. This is the only channel this
       * architecture has that resembles a push: no FCM, no socket from the app,
       * and a phone that is not tracking sends nothing at all.
       *
       * Just the number. The client already knows how to fetch and verify a
       * manifest; being told "there is something newer than you" is enough to
       * make it look, and keeps this out of the business of describing
       * releases.
       */
      releasedAppBuild: this.releases.liveVersionCode(),
    };
  }

  // ---------------------------------------------------------------------------

  private async broadcast(result: IngestResult, batchId: string, offline: boolean) {
    if (result.accepted === 0) return;

    if (result.live) {
      this.publisher.position({
        sessionId: result.sessionId,
        lat: result.live.lat,
        lon: result.live.lon,
        speedMps: result.live.speedMps,
        bearingDeg: result.live.bearingDeg,
        accuracyM: result.live.accuracyM,
        batteryPct: result.live.batteryPct,
        isCharging: result.live.isCharging,
        recordedAt: result.live.recordedAt,
        pointsTotal: result.pointsTotal,
        distanceM: result.distanceM,
      });
    }

    // A batch is "geometry to splice" whenever it carries more than the single
    // head point — either an offline flush or a catch-up burst. One indexed read
    // on ix_lp_batch; the single-ping hot path never reaches here.
    const isSegment = result.accepted > 1 || !result.advanced;
    if (isSegment) {
      const cap = this.config.realtime.maxBackfillBroadcastPoints;
      const points =
        result.accepted <= cap
          ? await this.db.query<{ lon: number; lat: number; t: string }>(
              `SELECT lon, lat, recorded_at AS t
               FROM kh.location_points
               WHERE session_id = $1 AND batch_id = $2
               ORDER BY recorded_at`,
              [result.sessionId, batchId],
            )
          : [];

      this.publisher.backfill({
        sessionId: result.sessionId,
        batchId,
        from: result.oldestPointAt ?? '',
        to: result.newestPointAt ?? '',
        count: result.accepted,
        points: points.map((p) => [p.lon, p.lat, p.t] as [number, number, string]),
      });
    }

    this.publisher.ingestStats(result.sessionId, {
      accepted: result.accepted,
      duplicates: result.duplicates,
      rejected: result.rejected,
      offline,
      lagSec: result.newestPointAt
        ? Math.round((Date.now() - new Date(result.newestPointAt).getTime()) / 1000)
        : null,
    });

    if (result.sessionStatus === 'ACTIVE') {
      this.publisher.sessionState(result.sessionId, 'ACTIVE', { via: 'ingest' });
    }
  }

  private validBatchId(candidate?: string): string {
    if (!candidate) return randomUUID();
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      candidate,
    )
      ? candidate.toLowerCase()
      : randomUUID();
  }

  /**
   * Fast structural pass over the raw array.
   *
   * Purpose is narrow but essential: guarantee every value is *castable* by
   * `jsonb_to_recordset`, because a single `"lat": "abc"` would abort the whole
   * batch with a Postgres cast error and cost the driver 5,000 points.
   * Semantic validation (bounds, timestamp windows, Null Island) stays in SQL
   * where it can run set-based.
   *
   * O(n) with no reflection: ~4 ms for 5,000 points.
   */
  private normalisePoints(raw: unknown[]): { points: NormalisedPoint[]; malformed: number } {
    const points: NormalisedPoint[] = [];
    let malformed = 0;

    for (const item of raw) {
      if (!item || typeof item !== 'object') {
        malformed += 1;
        continue;
      }
      const p = item as Record<string, unknown>;

      const id = typeof p.id === 'string' ? p.id : null;
      const lat = num(p.lat);
      const lon = num(p.lon);
      const recordedAt = toIso(p.recordedAt);

      if (!id || lat === null || lon === null || !recordedAt) {
        malformed += 1;
        continue;
      }

      points.push({
        client_point_id: id.slice(0, 64),
        recorded_at: recordedAt,
        lat,
        lon,
        accuracy_m: num(p.accuracy),
        altitude_m: num(p.altitude),
        vertical_accuracy_m: num(p.verticalAccuracy),
        speed_mps: num(p.speed),
        speed_accuracy_mps: num(p.speedAccuracy),
        bearing_deg: num(p.bearing),
        elapsed_realtime_ns: num(p.elapsedRealtimeNs),
        battery_pct: intOrNull(p.batteryPct, 0, 100),
        is_charging: p.isCharging === true,
        is_mock: p.isMock === true,
        satellites: intOrNull(p.satellites, 0, 64),
        provider: typeof p.provider === 'string' ? p.provider.slice(0, 24) : 'fused',
        network_type: typeof p.networkType === 'string' ? p.networkType.slice(0, 24) : null,
        device_seq: num(p.seq),
      });
    }

    return { points, malformed };
  }
}

function num(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function intOrNull(v: unknown, min: number, max: number): number | null {
  const n = num(v);
  if (n === null) return null;
  const i = Math.round(n);
  return i >= min && i <= max ? i : null;
}

/**
 * Accepts ISO-8601 or epoch milliseconds. Android sends epoch millis from
 * `Location.getTime()`; a human curling the API sends ISO. Both work.
 */
function toIso(v: unknown): string | null {
  if (typeof v === 'number' && Number.isFinite(v)) {
    // Anything before 2001 is a seconds-vs-millis mistake, not a real fix.
    const ms = v < 1e11 ? v * 1000 : v;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (typeof v === 'string' && v.length >= 8) {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  return null;
}

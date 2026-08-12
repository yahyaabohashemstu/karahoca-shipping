import { Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { FLEET_COLUMNS } from '../common/fleet-projection';

export interface RouteQuery {
  toleranceM?: number;
  from?: string;
  to?: string;
  raw?: boolean;
}

@Injectable()
export class TrackingService {
  constructor(private readonly db: DatabaseService) {}

  /** Fleet snapshot for the live map's initial paint and for reconnects. */
  async liveFleet() {
    const positions = await this.db.query(
      `SELECT ${FLEET_COLUMNS}
       FROM kh.v_live_fleet f
       WHERE f.status IN ('CLAIMED','ACTIVE','PAUSED')
       ORDER BY f.last_point_at DESC NULLS LAST`,
    );
    return { at: new Date().toISOString(), count: positions.length, positions };
  }

  /**
   * Route geometry as GeoJSON.
   *
   * Simplification runs in Postgres via ST_SimplifyPreserveTopology (see
   * kh.session_route): a 10-hour delivery is ~7,000 raw points ≈ 600 KB of JSON
   * that renders pixel-identically to ~400 simplified points ≈ 35 KB.
   * `raw=true` bypasses simplification for exports and dispute evidence.
   */
  async route(sessionId: string, query: RouteQuery) {
    await this.assertSession(sessionId);
    const [row] = await this.db.query<{ session_route: unknown }>(
      `SELECT kh.session_route($1::uuid, $2::double precision, $3::timestamptz, $4::timestamptz)
              AS session_route`,
      [sessionId, query.raw ? 0 : (query.toleranceM ?? 8), query.from ?? null, query.to ?? null],
    );
    return row.session_route;
  }

  /**
   * Timestamped points for the replay scrubber.
   *
   * Returned as positional tuples [lon, lat, epochMs, speed, bearing] rather
   * than objects: for 7,000 points that is ~40% less JSON and parses faster in
   * the browser than 7,000 object literals with repeated key strings.
   */
  async playback(sessionId: string, query: RouteQuery & { maxPoints?: number }) {
    await this.assertSession(sessionId);
    const maxPoints = Math.min(query.maxPoints ?? 4000, 20000);

    const [{ total }] = await this.db.query<{ total: number }>(
      `SELECT count(*)::int AS total FROM kh.location_points
       WHERE session_id = $1
         AND ($2::timestamptz IS NULL OR recorded_at >= $2)
         AND ($3::timestamptz IS NULL OR recorded_at <= $3)`,
      [sessionId, query.from ?? null, query.to ?? null],
    );

    // Even decimation via row_number keeps the temporal shape of the route
    // (stops still look like stops), which naive LIMIT would destroy.
    const stride = Math.max(1, Math.ceil(total / maxPoints));

    const rows = await this.db.query<{
      lon: number; lat: number; t: Date; s: number | null; b: number | null; a: number | null;
    }>(
      `SELECT lon, lat, recorded_at AS t, speed_mps AS s, bearing_deg AS b, accuracy_m AS a
       FROM (
         SELECT lon, lat, recorded_at, speed_mps, bearing_deg, accuracy_m,
                row_number() OVER (ORDER BY recorded_at) AS rn
         FROM kh.location_points
         WHERE session_id = $1
           AND ($2::timestamptz IS NULL OR recorded_at >= $2)
           AND ($3::timestamptz IS NULL OR recorded_at <= $3)
       ) x
       WHERE rn % $4 = 0 OR rn = 1
       ORDER BY recorded_at`,
      [sessionId, query.from ?? null, query.to ?? null, stride],
    );

    return {
      sessionId,
      total,
      stride,
      returned: rows.length,
      /** [lon, lat, epochMs, speedMps|null, bearingDeg|null, accuracyM|null] */
      points: rows.map((r) => [
        r.lon,
        r.lat,
        r.t.getTime(),
        r.s,
        r.b,
        r.a,
      ]),
    };
  }

  /**
   * Gaps in coverage — the single most useful diagnostic when a carrier claims
   * the app "was running the whole time".
   */
  async gaps(sessionId: string, minGapSec = 120) {
    await this.assertSession(sessionId);
    return this.db.query(
      `WITH seq AS (
         SELECT recorded_at,
                lag(recorded_at) OVER (ORDER BY recorded_at) AS prev_at,
                lon, lat,
                lag(lon) OVER (ORDER BY recorded_at) AS prev_lon,
                lag(lat) OVER (ORDER BY recorded_at) AS prev_lat
         FROM kh.location_points
         WHERE session_id = $1
       )
       SELECT prev_at AS "from", recorded_at AS "to",
              extract(epoch FROM (recorded_at - prev_at))::int AS "durationSec",
              prev_lon AS "fromLon", prev_lat AS "fromLat",
              lon AS "toLon", lat AS "toLat",
              round(ST_Distance(
                ST_SetSRID(ST_MakePoint(prev_lon, prev_lat), 4326)::geography,
                ST_SetSRID(ST_MakePoint(lon, lat), 4326)::geography
              )::numeric, 0) AS "straightLineM"
       FROM seq
       WHERE prev_at IS NOT NULL
         AND recorded_at - prev_at > make_interval(secs => $2::int)
       ORDER BY prev_at`,
      [sessionId, minGapSec],
    );
  }

  /** Per-minute rollup from the continuous aggregate — cheap for long hauls. */
  async speedProfile(sessionId: string) {
    await this.assertSession(sessionId);
    return this.db.query(
      `SELECT bucket, point_count AS "pointCount",
              round(avg_speed_mps::numeric * 3.6, 1) AS "avgKmh",
              round(max_speed_mps::numeric * 3.6, 1) AS "maxKmh",
              min_battery_pct AS "minBatteryPct",
              had_backfill AS "hadBackfill", had_mock AS "hadMock"
       FROM kh.location_points_1min
       WHERE session_id = $1
       ORDER BY bucket`,
      [sessionId],
    );
  }

  /**
   * `SELECT *` off the view leaked the database's snake_case straight to the
   * browser — sessions_with_mock_gps, avg_distance_km — while every other
   * endpoint returns camelCase. The dashboard then had to know which
   * convention each endpoint happened to use, which is exactly how the fleet
   * list once rendered a column of blanks.
   *
   * Columns are named explicitly here so a change to the view cannot silently
   * alter the wire contract either.
   */
  async carrierPerformance() {
    return this.db.query(
      `SELECT id,
              name,
              sessions,
              completed,
              sessions_with_mock_gps AS "sessionsWithMockGps",
              avg_distance_km        AS "avgDistanceKm",
              avg_duration_h         AS "avgDurationH",
              avg_largest_gap_sec    AS "avgLargestGapSec",
              avg_coverage_pct       AS "avgCoveragePct",
              on_time                AS "onTime"
         FROM kh.v_carrier_performance
        ORDER BY sessions DESC`,
    );
  }

  /** Raw export for disputes. Streamed as NDJSON by the controller. */
  async *exportPoints(sessionId: string, chunkSize = 5000): AsyncGenerator<string> {
    let cursor: string | null = null;
    for (;;) {
      const rows: Array<Record<string, unknown>> = await this.db.query(
        `SELECT client_point_id AS "id", recorded_at AS "recordedAt",
                received_at AS "receivedAt", lat, lon, accuracy_m AS "accuracyM",
                speed_mps AS "speedMps", bearing_deg AS "bearingDeg",
                altitude_m AS "altitudeM", battery_pct AS "batteryPct",
                is_mock AS "isMock", is_backfill AS "isBackfill",
                provider, satellites, batch_id AS "batchId"
         FROM kh.location_points
         WHERE session_id = $1
           AND ($2::timestamptz IS NULL OR recorded_at > $2)
         ORDER BY recorded_at
         LIMIT $3`,
        [sessionId, cursor, chunkSize],
      );
      if (rows.length === 0) return;
      for (const row of rows) yield `${JSON.stringify(row)}\n`;
      cursor = (rows[rows.length - 1].recordedAt as Date).toISOString();
      if (rows.length < chunkSize) return;
    }
  }

  private async assertSession(sessionId: string): Promise<void> {
    const found = await this.db.maybeOne(
      `SELECT 1 FROM kh.tracking_sessions WHERE id = $1`,
      [sessionId],
    );
    if (!found) throw new NotFoundException({ code: 'SESSION_NOT_FOUND', message: 'Unknown session' });
  }
}

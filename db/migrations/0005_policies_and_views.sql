-- migrate:no-transaction
-- =============================================================================
-- 0005 — Timescale storage policies, continuous aggregates, reporting views,
--        and the scheduled maintenance functions.
--
-- NOTE: continuous aggregates cannot be created inside a transaction block, so
--       this file is executed statement-by-statement in autocommit mode by
--       db/migrate.mjs (see the `migrate:no-transaction` directive above).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Columnar compression.
--
-- GPS telemetry is the ideal compression target: session_id repeats thousands of
-- times, timestamps are near-uniformly spaced (delta-of-delta), and lat/lon of a
-- moving truck change in tiny increments (Gorilla/XOR). Expect 10–20×.
--
-- segmentby = session_id  → a route query decompresses only that truck's data.
-- orderby   = recorded_at DESC → matches ix_lp_session_time; ordered scans stay
--                                ordered after compression.
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    EXECUTE $ddl$
      ALTER TABLE kh.location_points SET (
        timescaledb.compress,
        timescaledb.compress_segmentby = 'session_id',
        timescaledb.compress_orderby   = 'recorded_at DESC'
      )
    $ddl$;
  EXCEPTION WHEN OTHERS THEN
    -- TimescaleDB ≥ 2.18 renamed these to the columnstore options.
    RAISE NOTICE 'classic compress options rejected (%), trying columnstore syntax', SQLERRM;
    EXECUTE $ddl$
      ALTER TABLE kh.location_points SET (
        timescaledb.enable_columnstore = true,
        timescaledb.segmentby = 'session_id',
        timescaledb.orderby   = 'recorded_at DESC'
      )
    $ddl$;
  END;
END $$;

-- Compress chunks older than 14 days. Two weeks keeps every in-flight and
-- recently-disputed delivery in the fast row store.
DO $$
BEGIN
  BEGIN
    PERFORM add_compression_policy('kh.location_points', INTERVAL '14 days', if_not_exists => TRUE);
  EXCEPTION WHEN undefined_function THEN
    PERFORM add_columnstore_policy('kh.location_points', after => INTERVAL '14 days', if_not_exists => TRUE);
  END;
END $$;

-- Retention: two years. Turkish commercial bookkeeping obligations run to 10
-- years for the *documents*; the raw second-by-second GPS trail is operational
-- data, and the per-minute aggregate below is what survives long term.
DO $$
BEGIN
  PERFORM add_retention_policy('kh.location_points', INTERVAL '2 years', if_not_exists => TRUE);
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'retention policy not installed: %', SQLERRM;
END $$;

-- -----------------------------------------------------------------------------
-- Continuous aggregate: one row per session per minute.
--
-- Powers (a) long-route replay without touching raw chunks, (b) speed/idle
-- analytics, (c) permanent history after raw retention expires.
-- -----------------------------------------------------------------------------
CREATE MATERIALIZED VIEW IF NOT EXISTS kh.location_points_1min
WITH (timescaledb.continuous) AS
SELECT
  session_id,
  time_bucket(INTERVAL '1 minute', recorded_at) AS bucket,
  count(*)                                       AS point_count,
  avg(speed_mps)                                 AS avg_speed_mps,
  max(speed_mps)                                 AS max_speed_mps,
  avg(accuracy_m)                                AS avg_accuracy_m,
  min(battery_pct)                               AS min_battery_pct,
  bool_or(is_mock)                               AS had_mock,
  bool_or(is_backfill)                           AS had_backfill,
  first(lat, recorded_at)                        AS first_lat,
  first(lon, recorded_at)                        AS first_lon,
  last(lat,  recorded_at)                        AS last_lat,
  last(lon,  recorded_at)                        AS last_lon,
  last(bearing_deg, recorded_at)                 AS last_bearing_deg
FROM kh.location_points
GROUP BY session_id, bucket
WITH NO DATA;

DO $$
BEGIN
  PERFORM add_continuous_aggregate_policy(
    'kh.location_points_1min',
    start_offset      => INTERVAL '3 hours',
    end_offset        => INTERVAL '2 minutes',
    schedule_interval => INTERVAL '2 minutes',
    if_not_exists     => TRUE
  );
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'continuous aggregate policy not installed: %', SQLERRM;
END $$;

CREATE INDEX IF NOT EXISTS ix_lp1min_session
  ON kh.location_points_1min (session_id, bucket DESC);

-- =============================================================================
-- Reporting views
-- =============================================================================

-- The fleet map's snapshot query. One index scan on tracking_sessions, small
-- joins to master data. No contact with the hypertable at all.
CREATE OR REPLACE VIEW kh.v_live_fleet AS
SELECT
  s.id                       AS session_id,
  s.reference,
  s.status,
  s.last_lat,
  s.last_lon,
  s.last_speed_mps,
  s.last_bearing_deg,
  s.last_accuracy_m,
  s.last_battery_pct,
  s.last_is_charging,
  s.last_point_at,
  s.last_seen_at,
  s.points_total,
  round(s.distance_m::numeric / 1000, 2) AS distance_km,
  s.started_at,
  s.mock_location_count,
  s.largest_gap_sec,
  -- Freshness classification consumed directly by the dashboard badge.
  CASE
    WHEN s.last_point_at IS NULL                       THEN 'NO_SIGNAL'
    WHEN s.last_point_at > now() - interval '90 seconds' THEN 'LIVE'
    WHEN s.last_point_at > now() - interval '10 minutes' THEN 'DELAYED'
    WHEN s.last_point_at > now() - interval '2 hours'    THEN 'STALE'
    ELSE                                                      'LOST'
  END AS signal_state,
  extract(epoch FROM (now() - s.last_point_at))::int AS seconds_since_fix,

  o.id            AS order_id,
  o.order_number,
  o.status        AS order_status,
  o.destination_label,
  ST_Y(o.destination::geometry) AS destination_lat,
  ST_X(o.destination::geometry) AS destination_lon,
  o.planned_delivery_at,
  -- Straight-line remaining distance. Not road distance — deliberately cheap and
  -- honest; the dashboard labels it "as the crow flies".
  CASE WHEN o.destination IS NOT NULL AND s.last_position IS NOT NULL
       THEN round((ST_Distance(s.last_position, o.destination) / 1000)::numeric, 2)
  END AS remaining_km,

  c.id            AS customer_id,
  c.name          AS customer_name,
  c.city          AS customer_city,

  sc.id           AS shipping_company_id,
  sc.name         AS shipping_company_name,

  coalesce(d.full_name,  s.driver_name_snapshot)   AS driver_name,
  coalesce(d.phone,      s.driver_phone_snapshot)  AS driver_phone,
  coalesce(v.plate::text, s.vehicle_plate_snapshot) AS vehicle_plate
FROM kh.tracking_sessions s
JOIN kh.orders             o  ON o.id  = s.order_id
JOIN kh.customers          c  ON c.id  = o.customer_id
JOIN kh.shipping_companies sc ON sc.id = s.shipping_company_id
LEFT JOIN kh.drivers       d  ON d.id  = s.driver_id
LEFT JOIN kh.vehicles      v  ON v.id  = s.vehicle_id;

COMMENT ON VIEW kh.v_live_fleet IS
  'Fleet overview snapshot. Filter by status IN (ACTIVE,PAUSED,CLAIMED) for the live map.';

-- Carrier scorecard: how reliable is each third-party company, by the data.
CREATE OR REPLACE VIEW kh.v_carrier_performance AS
SELECT
  sc.id,
  sc.name,
  count(s.id)                                          AS sessions,
  count(*) FILTER (WHERE s.status = 'COMPLETED')       AS completed,
  count(*) FILTER (WHERE s.mock_location_count > 0)    AS sessions_with_mock_gps,
  round(avg(s.distance_m) FILTER (WHERE s.status = 'COMPLETED')::numeric / 1000, 1)
                                                       AS avg_distance_km,
  round(avg(extract(epoch FROM (s.ended_at - s.started_at)))
        FILTER (WHERE s.status = 'COMPLETED')::numeric / 3600, 2)
                                                       AS avg_duration_h,
  round(avg(s.largest_gap_sec)::numeric)               AS avg_largest_gap_sec,
  -- Coverage = fraction of the trip we actually have telemetry for. The single
  -- best number for judging whether a carrier's drivers keep the app running.
  round(avg(
    CASE WHEN s.started_at IS NOT NULL AND s.ended_at > s.started_at
         THEN least(1.0, (s.points_total * s.ping_interval_sec)::numeric
                         / nullif(extract(epoch FROM (s.ended_at - s.started_at)), 0))
    END
  ) * 100, 1)                                          AS avg_coverage_pct,
  count(*) FILTER (
    WHERE s.status = 'COMPLETED'
      AND o.planned_delivery_at IS NOT NULL
      AND s.ended_at <= o.planned_delivery_at
  )                                                    AS on_time
FROM kh.shipping_companies sc
LEFT JOIN kh.tracking_sessions s ON s.shipping_company_id = sc.id
LEFT JOIN kh.orders            o ON o.id = s.order_id
GROUP BY sc.id, sc.name;

-- =============================================================================
-- Scheduled maintenance
-- =============================================================================

-- Expire abandoned hand-offs and runaway sessions. Called every minute by the
-- BullMQ maintenance queue; also safe to wire to pg_cron.
CREATE OR REPLACE FUNCTION kh.expire_stale_sessions()
RETURNS TABLE (expired_id uuid, previous_status kh.session_status)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  WITH victims AS (
    SELECT s.id, s.status
    FROM kh.tracking_sessions s
    WHERE s.status IN ('ASSIGNED', 'CLAIMED', 'ACTIVE', 'PAUSED')
      AND (
            -- claim code never used
            (s.status = 'ASSIGNED' AND s.claim_code_expires_at < now())
            -- hard lifetime cap
         OR (s.expires_at < now())
      )
    FOR UPDATE SKIP LOCKED
  ),
  updated AS (
    UPDATE kh.tracking_sessions s
    SET status      = 'EXPIRED',
        ended_at    = coalesce(s.ended_at, now()),
        end_reason  = coalesce(s.end_reason, 'auto-expired'),
        claim_code  = NULL,
        token_version = s.token_version + 1
    FROM victims v
    WHERE s.id = v.id
    RETURNING s.id, v.status
  ),
  logged AS (
    INSERT INTO kh.session_events (session_id, type, actor, message)
    SELECT u.id, 'EXPIRED', 'system', 'Session auto-expired by maintenance job'
    FROM updated u
    RETURNING 1
  )
  SELECT u.id, u.status FROM updated u;
END;
$$;

-- Close a session properly: exact distance, order status, audit event.
CREATE OR REPLACE FUNCTION kh.finalize_session(
  p_session_id uuid,
  p_reason     text DEFAULT 'completed',
  p_actor      text DEFAULT 'system',
  p_status     kh.session_status DEFAULT 'COMPLETED'
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_distance double precision;
  v_session  kh.tracking_sessions%ROWTYPE;
BEGIN
  SELECT * INTO v_session FROM kh.tracking_sessions WHERE id = p_session_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'finalize_session: unknown session %', p_session_id
      USING ERRCODE = 'no_data_found';
  END IF;

  v_distance := kh.recompute_session_distance(p_session_id);

  UPDATE kh.tracking_sessions
  SET status        = p_status,
      ended_at      = coalesce(ended_at, now()),
      end_reason    = p_reason,
      claim_code    = NULL,
      token_version = token_version + 1,
      distance_m    = v_distance
  WHERE id = p_session_id
  RETURNING * INTO v_session;

  UPDATE kh.session_devices
  SET revoked_at = coalesce(revoked_at, now())
  WHERE session_id = p_session_id AND revoked_at IS NULL;

  IF p_status = 'COMPLETED' THEN
    UPDATE kh.orders
    SET status       = 'DELIVERED',
        delivered_at = coalesce(delivered_at, now())
    WHERE id = v_session.order_id;
  END IF;

  INSERT INTO kh.session_events (session_id, type, actor, position, payload, message)
  VALUES (
    p_session_id,
    CASE p_status WHEN 'CANCELLED' THEN 'CANCELLED'::kh.session_event_type
                  ELSE 'COMPLETED'::kh.session_event_type END,
    p_actor,
    v_session.last_position,
    jsonb_build_object('distanceM', v_distance, 'points', v_session.points_total),
    p_reason
  );

  RETURN jsonb_build_object(
    'sessionId',  p_session_id,
    'status',     v_session.status,
    'distanceM',  round(v_distance::numeric, 1),
    'points',     v_session.points_total,
    'startedAt',  v_session.started_at,
    'endedAt',    v_session.ended_at
  );
END;
$$;

-- Geofence arrival detection. Run every 30 s for ACTIVE sessions; cheap because
-- it only touches the denormalised last_position on tracking_sessions.
CREATE OR REPLACE FUNCTION kh.detect_arrivals()
RETURNS TABLE (session_id uuid, order_id uuid, distance_m double precision)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  WITH arrived AS (
    SELECT s.id AS sid, o.id AS oid,
           ST_Distance(s.last_position, o.destination) AS dist
    FROM kh.tracking_sessions s
    JOIN kh.orders o ON o.id = s.order_id
    WHERE s.status = 'ACTIVE'
      AND s.last_position IS NOT NULL
      AND o.destination   IS NOT NULL
      AND s.last_point_at > now() - interval '15 minutes'
      AND ST_DWithin(s.last_position, o.destination, o.destination_radius_m)
      AND NOT EXISTS (
        SELECT 1 FROM kh.session_events e
        WHERE e.session_id = s.id
          AND e.type = 'GEOFENCE_ENTER'
          AND e.occurred_at > now() - interval '6 hours'
      )
  ),
  logged AS (
    INSERT INTO kh.session_events (session_id, type, actor, payload, message)
    SELECT a.sid, 'GEOFENCE_ENTER', 'system',
           jsonb_build_object('distanceM', round(a.dist::numeric, 1)),
           'Vehicle entered the destination geofence'
    FROM arrived a
    -- RETURNING 1, not RETURNING session_id: this function's OUT parameter is
    -- also called session_id, and an unqualified reference is ambiguous. The
    -- CTE exists only to force the INSERT (PostgreSQL runs every
    -- data-modifying CTE whether or not it is referenced).
    RETURNING 1
  )
  SELECT a.sid, a.oid, a.dist FROM arrived a;
END;
$$;

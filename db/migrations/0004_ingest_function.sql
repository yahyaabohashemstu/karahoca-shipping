-- =============================================================================
-- 0004 — kh.ingest_points : the whole write path in one round trip (ADR-005)
-- =============================================================================
-- The API calls this exactly once per upload, whether the upload is a single
-- realtime ping or a 10,000-point backlog from a truck that just left a dead
-- zone. Everything below happens in one transaction:
--
--   1. per-session advisory lock  (serialises the session, never the fleet)
--   2. set-based validation       (no row-by-row loop, no JS loop)
--   3. one INSERT … ON CONFLICT   (idempotency from the PK)
--   4. windowed distance chain    (with GPS-teleport rejection)
--   5. monotonic session update   (backfill never rewinds the live marker)
--   6. batch receipt + anomaly events
--
-- Returns a jsonb envelope the API relays straight back to the device.
-- =============================================================================

CREATE OR REPLACE FUNCTION kh.ingest_points(
  p_session_id  uuid,
  p_batch_id    uuid,
  p_device_id   text,
  p_points      jsonb,
  p_is_offline  boolean DEFAULT false,
  p_client_ip   inet    DEFAULT NULL,
  p_body_bytes  integer DEFAULT NULL,
  p_duration_ms integer DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
AS $$
DECLARE
  v_session          kh.tracking_sessions%ROWTYPE;
  v_anchor_at        timestamptz;
  v_anchor_pos       geography(Point, 4326);
  v_now              timestamptz := clock_timestamp();
  v_future_limit     timestamptz;
  v_past_limit       timestamptz;

  v_total            int := 0;
  v_candidates       int := 0;   -- valid points offered, before PK collisions
  v_accepted         int := 0;
  v_duplicates       int := 0;
  v_rejected         int := 0;
  v_mock_new         int := 0;

  v_new_min_at       timestamptz;
  v_new_max_at       timestamptz;
  v_new_last_lat     double precision;
  v_new_last_lon     double precision;
  v_new_last_speed   real;
  v_new_last_bearing real;
  v_new_last_acc     real;
  v_new_last_batt    smallint;
  v_new_last_charge  boolean;
  v_new_max_speed    real := 0;
  v_added_distance   double precision := 0;
  v_max_gap_sec      int := 0;
  v_advanced         boolean := false;
BEGIN
  ---------------------------------------------------------------------------
  -- 0. Guard rails
  ---------------------------------------------------------------------------
  IF p_points IS NULL OR jsonb_typeof(p_points) <> 'array' THEN
    RAISE EXCEPTION 'ingest_points: p_points must be a JSON array'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  v_total := jsonb_array_length(p_points);

  IF v_total > 20000 THEN
    RAISE EXCEPTION 'ingest_points: batch of % exceeds the 20000 point limit', v_total
      USING ERRCODE = 'program_limit_exceeded';
  END IF;

  ---------------------------------------------------------------------------
  -- 1. Lock the session row. Contention is per-session (one device writes to
  --    one session), so this never becomes a global bottleneck.
  ---------------------------------------------------------------------------
  SELECT * INTO v_session
  FROM kh.tracking_sessions
  WHERE id = p_session_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ingest_points: unknown session %', p_session_id
      USING ERRCODE = 'no_data_found';
  END IF;

  IF v_session.status NOT IN ('CLAIMED', 'ACTIVE', 'PAUSED') THEN
    RAISE EXCEPTION 'ingest_points: session % is % and cannot accept points',
                    p_session_id, v_session.status
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  ---------------------------------------------------------------------------
  -- Empty batch: a device flushing an empty buffer. A no-op, but only AFTER
  -- the session has been validated — short-circuiting earlier would let an
  -- unknown or already-closed session receive a success response, and the
  -- device would keep believing it still had somewhere to send.
  ---------------------------------------------------------------------------
  IF v_total = 0 THEN
    RETURN jsonb_build_object(
      'accepted', 0, 'duplicates', 0, 'rejected', 0,
      'batchId', p_batch_id,
      'serverTime', v_now,
      'advanced', false,
      'sessionStatus', v_session.status,
      'sessionId', p_session_id,
      'pointsTotal', v_session.points_total,
      'distanceM', round(v_session.distance_m::numeric, 1),
      'live', NULL,
      'policy', jsonb_build_object(
        'pingIntervalSec', v_session.ping_interval_sec,
        'idleIntervalSec', v_session.idle_interval_sec,
        'minDistanceM',    v_session.min_distance_m
      )
    );
  END IF;

  v_anchor_at   := v_session.last_point_at;
  v_anchor_pos  := v_session.last_position;

  -- Accept fixes up to 5 minutes ahead of server time (clock skew) and no older
  -- than 24 h before the session was created (a genuinely long dead zone plus a
  -- margin; anything older is a corrupt buffer, not a delivery).
  v_future_limit := v_now + interval '5 minutes';
  v_past_limit   := LEAST(v_session.created_at, v_now) - interval '24 hours';

  ---------------------------------------------------------------------------
  -- 2 + 3. Validate and insert — one statement, entirely set-based.
  --
  -- Deliberately CTEs rather than a temporary table. A TEMP TABLE created
  -- inside a PL/pgSQL function is recreated with a fresh OID on every
  -- transaction, while PL/pgSQL caches the plans that reference it — which
  -- produces the classic intermittent "relation with OID ... does not exist"
  -- failure on the second call in a session. CTEs sidestep the plan cache
  -- entirely and let the planner see the whole pipeline at once.
  --
  -- `validated` is referenced twice, so PostgreSQL materialises it and
  -- jsonb_to_recordset runs exactly once.
  ---------------------------------------------------------------------------
  WITH validated AS (
    SELECT
      p.client_point_id,
      p.recorded_at,
      p.lat,
      p.lon,
      p.accuracy_m,
      p.altitude_m,
      p.vertical_accuracy_m,
      p.speed_mps,
      p.speed_accuracy_mps,
      p.bearing_deg,
      p.elapsed_realtime_ns,
      p.battery_pct,
      coalesce(p.is_charging, false) AS is_charging,
      coalesce(p.is_mock, false)     AS is_mock,
      p.satellites,
      coalesce(p.provider, 'fused')  AS provider,
      p.network_type,
      p.device_seq,
      -- Validity predicate. Anything false is counted as rejected and dropped;
      -- we never silently coerce a bad coordinate into a plausible one.
      (
        p.client_point_id IS NOT NULL
        AND length(p.client_point_id) BETWEEN 8 AND 64
        AND p.recorded_at IS NOT NULL
        AND p.recorded_at <= v_future_limit
        AND p.recorded_at >= v_past_limit
        AND p.lat IS NOT NULL AND p.lat BETWEEN -90  AND 90
        AND p.lon IS NOT NULL AND p.lon BETWEEN -180 AND 180
        AND NOT (p.lat = 0 AND p.lon = 0)                     -- Null Island = bad fix
        AND (p.accuracy_m IS NULL OR p.accuracy_m <= 5000)
        AND (p.speed_mps  IS NULL OR p.speed_mps BETWEEN 0 AND 200)
      ) AS valid
    FROM jsonb_to_recordset(p_points) AS p(
      client_point_id     text,
      recorded_at         timestamptz,
      lat                 double precision,
      lon                 double precision,
      accuracy_m          real,
      altitude_m          real,
      vertical_accuracy_m real,
      speed_mps           real,
      speed_accuracy_mps  real,
      bearing_deg         real,
      elapsed_realtime_ns bigint,
      battery_pct         smallint,
      is_charging         boolean,
      is_mock             boolean,
      satellites          smallint,
      provider            text,
      network_type        text,
      device_seq          bigint
    )
  ),
  counts AS (
    SELECT
      count(*) FILTER (WHERE NOT valid)::int AS rejected,
      count(*) FILTER (WHERE valid)::int     AS accepted_candidates
    FROM validated
  ),
  -- De-duplicate *within* the batch first (a device retrying a partial chunk
  -- can legitimately resend an id), then let the PK absorb cross-batch
  -- duplicates. Ties break toward the more accurate fix.
  deduped AS (
    SELECT DISTINCT ON (client_point_id, recorded_at) *
    FROM validated
    WHERE valid
    ORDER BY client_point_id, recorded_at, accuracy_m NULLS LAST
  ),
  ins AS (
    INSERT INTO kh.location_points (
      session_id, recorded_at, received_at, client_point_id,
      lat, lon, position,
      accuracy_m, altitude_m, vertical_accuracy_m,
      speed_mps, speed_accuracy_mps, bearing_deg,
      elapsed_realtime_ns, battery_pct, is_charging, is_mock,
      is_backfill, satellites, provider, network_type, batch_id, device_seq
    )
    SELECT
      p_session_id,
      d.recorded_at,
      v_now,
      d.client_point_id,
      d.lat,
      d.lon,
      ST_SetSRID(ST_MakePoint(d.lon, d.lat), 4326)::geography,
      d.accuracy_m, d.altitude_m, d.vertical_accuracy_m,
      d.speed_mps, d.speed_accuracy_mps, d.bearing_deg,
      d.elapsed_realtime_ns, d.battery_pct, d.is_charging, d.is_mock,
      (v_anchor_at IS NOT NULL AND d.recorded_at < v_anchor_at),
      d.satellites, d.provider, d.network_type, p_batch_id, d.device_seq
    FROM deduped d
    ON CONFLICT ON CONSTRAINT pk_location_points DO NOTHING
    RETURNING recorded_at, speed_mps, is_mock
  )
  SELECT
    (SELECT rejected            FROM counts),
    (SELECT accepted_candidates FROM counts),
    count(*)::int,
    min(recorded_at),
    max(recorded_at),
    coalesce(max(speed_mps), 0)::real,
    count(*) FILTER (WHERE is_mock)::int
  INTO v_rejected, v_candidates, v_accepted,
       v_new_min_at, v_new_max_at, v_new_max_speed, v_mock_new
  FROM ins;

  -- Anything valid that did not insert collided with an existing primary key,
  -- i.e. the device re-sent a batch whose acknowledgement it never received.
  v_duplicates := GREATEST(v_candidates - v_accepted, 0);

  ---------------------------------------------------------------------------
  -- 4. Distance + gap analysis over the freshly accepted chain.
  --
  -- The chain is anchored to the session's previous last position when that
  -- position precedes the new points (the normal and the sequential-offline
  -- case). Segments are discarded when the geometry is untrustworthy:
  --   • either endpoint has accuracy worse than 150 m
  --   • implied speed exceeds 60 m/s (216 km/h) → GPS teleport
  -- `kh.recompute_session_distance` gives the exact figure at session close.
  ---------------------------------------------------------------------------
  IF v_accepted > 0 THEN
    WITH chain AS (
      SELECT recorded_at, position, accuracy_m
      FROM kh.location_points
      WHERE session_id = p_session_id
        AND batch_id   = p_batch_id
      UNION ALL
      SELECT v_anchor_at, v_anchor_pos, v_session.last_accuracy_m
      WHERE v_anchor_at IS NOT NULL
        AND v_new_min_at IS NOT NULL
        AND v_anchor_at < v_new_min_at
    ),
    seg AS (
      SELECT
        recorded_at,
        accuracy_m,
        lag(position)    OVER w AS prev_pos,
        lag(recorded_at) OVER w AS prev_at,
        lag(accuracy_m)  OVER w AS prev_acc,
        position
      FROM chain
      WINDOW w AS (ORDER BY recorded_at)
    ),
    scored AS (
      SELECT
        CASE
          WHEN prev_pos IS NULL THEN NULL
          WHEN coalesce(accuracy_m, 0) > 150 OR coalesce(prev_acc, 0) > 150 THEN NULL
          WHEN extract(epoch FROM (recorded_at - prev_at)) <= 0 THEN NULL
          WHEN ST_Distance(position, prev_pos)
               / NULLIF(extract(epoch FROM (recorded_at - prev_at)), 0) > 60 THEN NULL
          ELSE ST_Distance(position, prev_pos)
        END AS dist_m,
        CASE
          WHEN prev_at IS NULL THEN 0
          ELSE extract(epoch FROM (recorded_at - prev_at))::int
        END AS gap_sec
      FROM seg
    )
    SELECT coalesce(sum(dist_m), 0), coalesce(max(gap_sec), 0)
    INTO v_added_distance, v_max_gap_sec
    FROM scored;

    -- Latest attributes for the live marker.
    SELECT lp.lat, lp.lon, lp.speed_mps, lp.bearing_deg,
           lp.accuracy_m, lp.battery_pct, lp.is_charging
    INTO v_new_last_lat, v_new_last_lon, v_new_last_speed, v_new_last_bearing,
         v_new_last_acc, v_new_last_batt, v_new_last_charge
    FROM kh.location_points lp
    WHERE lp.session_id = p_session_id
      AND lp.batch_id   = p_batch_id
    ORDER BY lp.recorded_at DESC
    LIMIT 1;
  END IF;

  ---------------------------------------------------------------------------
  -- 5. Advance session state. The live marker moves ONLY forward in time.
  ---------------------------------------------------------------------------
  v_advanced := v_new_max_at IS NOT NULL
                AND (v_anchor_at IS NULL OR v_new_max_at > v_anchor_at);

  UPDATE kh.tracking_sessions s
  SET
    -- Monotonic live state
    last_point_at   = CASE WHEN v_advanced THEN v_new_max_at        ELSE s.last_point_at   END,
    last_position   = CASE WHEN v_advanced
                           THEN ST_SetSRID(ST_MakePoint(v_new_last_lon, v_new_last_lat), 4326)::geography
                           ELSE s.last_position END,
    last_lat        = CASE WHEN v_advanced THEN v_new_last_lat      ELSE s.last_lat        END,
    last_lon        = CASE WHEN v_advanced THEN v_new_last_lon      ELSE s.last_lon        END,
    last_speed_mps  = CASE WHEN v_advanced THEN v_new_last_speed    ELSE s.last_speed_mps  END,
    last_bearing_deg= CASE WHEN v_advanced THEN v_new_last_bearing  ELSE s.last_bearing_deg END,
    last_accuracy_m = CASE WHEN v_advanced THEN v_new_last_acc      ELSE s.last_accuracy_m END,
    last_battery_pct= CASE WHEN v_advanced THEN v_new_last_batt     ELSE s.last_battery_pct END,
    last_is_charging= CASE WHEN v_advanced THEN v_new_last_charge   ELSE s.last_is_charging END,

    -- Always-advancing counters
    last_seen_at    = v_now,
    first_point_at  = LEAST(coalesce(s.first_point_at, v_new_min_at), v_new_min_at),
    points_total    = s.points_total    + v_accepted,
    points_rejected = s.points_rejected + v_rejected,
    distance_m      = s.distance_m      + coalesce(v_added_distance, 0),
    max_speed_mps   = GREATEST(s.max_speed_mps, coalesce(v_new_max_speed, 0)),
    mock_location_count = s.mock_location_count + v_mock_new,
    largest_gap_sec = GREATEST(s.largest_gap_sec, coalesce(v_max_gap_sec, 0)),
    offline_batches = s.offline_batches + CASE WHEN p_is_offline THEN 1 ELSE 0 END,

    -- CLAIMED → ACTIVE on the first accepted point
    status          = CASE WHEN s.status = 'CLAIMED' AND v_accepted > 0
                           THEN 'ACTIVE'::kh.session_status ELSE s.status END,
    started_at      = CASE WHEN s.started_at IS NULL AND v_accepted > 0
                           THEN coalesce(v_new_min_at, v_now) ELSE s.started_at END
  WHERE s.id = p_session_id
  RETURNING * INTO v_session;

  ---------------------------------------------------------------------------
  -- 6. Batch receipt + anomaly events
  ---------------------------------------------------------------------------
  INSERT INTO kh.ingest_batches (
    id, session_id, device_id, received_at, point_count,
    accepted_count, duplicate_count, rejected_count,
    oldest_point_at, newest_point_at, lag_sec,
    is_offline_sync, body_bytes, duration_ms, client_ip
  )
  VALUES (
    p_batch_id, p_session_id, p_device_id, v_now, v_total,
    v_accepted, v_duplicates, v_rejected,
    v_new_min_at, v_new_max_at,
    CASE WHEN v_new_max_at IS NULL THEN NULL
         ELSE extract(epoch FROM (v_now - v_new_max_at))::int END,
    p_is_offline, p_body_bytes, p_duration_ms, p_client_ip
  )
  ON CONFLICT (id) DO NOTHING;

  IF v_mock_new > 0 THEN
    INSERT INTO kh.session_events (session_id, type, actor, position, payload, message)
    VALUES (
      p_session_id, 'MOCK_LOCATION_DETECTED', 'device',
      v_session.last_position,
      jsonb_build_object('count', v_mock_new, 'batchId', p_batch_id),
      format('%s point(s) in this batch were flagged as mock locations', v_mock_new)
    );
  END IF;

  IF p_is_offline AND v_accepted > 0 THEN
    INSERT INTO kh.session_events (session_id, type, actor, payload, message)
    VALUES (
      p_session_id, 'OFFLINE_BATCH_SYNCED', 'device',
      jsonb_build_object(
        'accepted',  v_accepted,
        'batchId',   p_batch_id,
        'oldestAt',  v_new_min_at,
        'newestAt',  v_new_max_at,
        'gapSec',    v_max_gap_sec
      ),
      format('Recovered %s buffered point(s) covering %s',
             v_accepted,
             coalesce((v_new_max_at - v_new_min_at)::text, '0'))
    );
  END IF;

  ---------------------------------------------------------------------------
  -- 7. Envelope for the device and for the realtime publisher.
  ---------------------------------------------------------------------------
  RETURN jsonb_build_object(
    'accepted',       v_accepted,
    'duplicates',     v_duplicates,
    'rejected',       v_rejected,
    'batchId',        p_batch_id,
    'serverTime',     v_now,
    'advanced',       v_advanced,
    'sessionStatus',  v_session.status,
    'sessionId',      p_session_id,
    'pointsTotal',    v_session.points_total,
    'distanceM',      round(v_session.distance_m::numeric, 1),
    'oldestPointAt',  v_new_min_at,
    'newestPointAt',  v_new_max_at,
    'live', CASE WHEN v_advanced THEN jsonb_build_object(
      'lat',        v_new_last_lat,
      'lon',        v_new_last_lon,
      'speedMps',   v_new_last_speed,
      'bearingDeg', v_new_last_bearing,
      'accuracyM',  v_new_last_acc,
      'batteryPct', v_new_last_batt,
      'isCharging', v_new_last_charge,
      'recordedAt', v_new_max_at
    ) ELSE NULL END,
    -- Policy echo: the device applies these without needing a separate call, so
    -- a dispatcher can retune ping frequency mid-shift.
    'policy', jsonb_build_object(
      'pingIntervalSec', v_session.ping_interval_sec,
      'idleIntervalSec', v_session.idle_interval_sec,
      'minDistanceM',    v_session.min_distance_m
    )
  );
END;
$$;

COMMENT ON FUNCTION kh.ingest_points IS
  'Atomic, idempotent, set-based ingest for one upload batch. See ADR-005.';

-- =============================================================================
-- kh.recompute_session_distance — exact figure, run at session finalisation
-- =============================================================================
CREATE OR REPLACE FUNCTION kh.recompute_session_distance(p_session_id uuid)
RETURNS double precision
LANGUAGE plpgsql
AS $$
DECLARE
  v_distance double precision;
BEGIN
  WITH seg AS (
    SELECT
      position,
      accuracy_m,
      recorded_at,
      lag(position)    OVER w AS prev_pos,
      lag(recorded_at) OVER w AS prev_at,
      lag(accuracy_m)  OVER w AS prev_acc
    FROM kh.location_points
    WHERE session_id = p_session_id
    WINDOW w AS (ORDER BY recorded_at)
  )
  SELECT coalesce(sum(
    CASE
      WHEN prev_pos IS NULL THEN 0
      WHEN coalesce(accuracy_m, 0) > 150 OR coalesce(prev_acc, 0) > 150 THEN 0
      WHEN extract(epoch FROM (recorded_at - prev_at)) <= 0 THEN 0
      WHEN ST_Distance(position, prev_pos)
           / NULLIF(extract(epoch FROM (recorded_at - prev_at)), 0) > 60 THEN 0
      ELSE ST_Distance(position, prev_pos)
    END), 0)
  INTO v_distance
  FROM seg;

  UPDATE kh.tracking_sessions
  SET distance_m = v_distance
  WHERE id = p_session_id;

  RETURN v_distance;
END;
$$;

-- =============================================================================
-- kh.session_route — server-side route simplification
-- =============================================================================
-- Returning 7,000 raw points to a browser for a completed 10-hour delivery is
-- 600 KB of JSON that renders identically to 400 simplified points.
-- ST_SimplifyPreserveTopology does Douglas–Peucker in C, inside the database.
--
-- p_tolerance_m = 0 disables simplification (export / legal evidence use case).
-- =============================================================================
CREATE OR REPLACE FUNCTION kh.session_route(
  p_session_id  uuid,
  p_tolerance_m double precision DEFAULT 8,
  p_from        timestamptz DEFAULT NULL,
  p_to          timestamptz DEFAULT NULL,
  p_max_points  int DEFAULT 5000
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_count    bigint;
  v_line     geometry;
  v_result   jsonb;
BEGIN
  SELECT count(*) INTO v_count
  FROM kh.location_points
  WHERE session_id = p_session_id
    AND (p_from IS NULL OR recorded_at >= p_from)
    AND (p_to   IS NULL OR recorded_at <= p_to);

  IF v_count < 2 THEN
    RETURN jsonb_build_object(
      'type', 'FeatureCollection', 'features', '[]'::jsonb,
      'pointCount', v_count, 'simplified', false
    );
  END IF;

  -- Build the line in planar 4326, simplify in degrees converted from metres at
  -- this latitude, then hand back WGS84 coordinates.
  WITH pts AS (
    SELECT position::geometry AS g, recorded_at
    FROM kh.location_points
    WHERE session_id = p_session_id
      AND (p_from IS NULL OR recorded_at >= p_from)
      AND (p_to   IS NULL OR recorded_at <= p_to)
    ORDER BY recorded_at
  )
  SELECT ST_MakeLine(g ORDER BY recorded_at) INTO v_line FROM pts;

  IF p_tolerance_m > 0 AND v_count > p_max_points THEN
    -- 1 degree of latitude ≈ 111,320 m. Good enough for a display tolerance.
    v_line := ST_SimplifyPreserveTopology(v_line, p_tolerance_m / 111320.0);
  END IF;

  SELECT jsonb_build_object(
    'type', 'FeatureCollection',
    'pointCount', v_count,
    'renderedPointCount', ST_NPoints(v_line),
    'simplified', ST_NPoints(v_line) < v_count,
    'toleranceM', p_tolerance_m,
    'features', jsonb_build_array(
      jsonb_build_object(
        'type', 'Feature',
        'geometry', ST_AsGeoJSON(v_line)::jsonb,
        'properties', jsonb_build_object('sessionId', p_session_id)
      )
    )
  ) INTO v_result;

  RETURN v_result;
END;
$$;

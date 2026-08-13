-- =============================================================================
-- 0011 — Keep the route after the telemetry is gone
-- =============================================================================
--
-- Nothing in this application deletes a shipment. There is no DELETE against
-- kh.tracking_sessions, kh.session_events or kh.location_points anywhere in the
-- API; a completed or cancelled session keeps every row it ever had, and the
-- dashboard can already filter to it.
--
-- One thing does delete, and it is invisible because the database does it on
-- its own: the TimescaleDB retention policy on kh.location_points, currently
-- `drop_after: 2 years`. On its own schedule it drops whole chunks of raw
-- fixes. The session row survives, the audit trail survives, the distance
-- survives — and the map goes blank. An archive that cannot show the road the
-- lorry took is not an archive of a shipment, it is a receipt.
--
-- Removing the retention policy is the wrong fix. One truck at a ten-second
-- cadence writes ~8,600 rows a day; a fleet of twenty over five years is on the
-- order of 300 million rows on a shared 4 GB box, to serve a line on a map that
-- nobody will ever zoom into at ten-metre resolution.
--
-- So: keep the raw trace for two years for forensics, and BEFORE it can be
-- dropped, fold each closed session's path into one simplified LineString that
-- is kept forever. A 500 km route at 10 m tolerance is a few hundred vertices,
-- a handful of kilobytes, and visually identical at every zoom a person will
-- ever use it at.
-- =============================================================================

CREATE TABLE IF NOT EXISTS kh.session_route_archive (
  session_id    uuid PRIMARY KEY REFERENCES kh.tracking_sessions(id) ON DELETE CASCADE,

  -- geography, not geometry: matches kh.location_points.position, so distance
  -- comes out in metres on the spheroid without anyone remembering to cast.
  path          geography(LineString, 4326),

  /*
   * The provenance of the line, so a dispatcher looking at an eight-year-old
   * shipment knows what they are looking at. `source_points` is how many raw
   * fixes it was folded from — the difference between a 6,000-point trace and
   * a 40-point one is the difference between evidence and a sketch, and once
   * the raw rows are gone that context is unrecoverable.
   */
  source_points integer NOT NULL,
  tolerance_m   integer NOT NULL,
  /*
   * The length of the STORED line, which after simplification is shorter than
   * the distance the lorry actually covered. Kept for provenance only — never
   * show it as the trip distance. kh.tracking_sessions.distance_m is the real
   * one, accumulated from every raw fix as it arrived, and kh.v_archived_sessions
   * exposes that.
   */
  path_length_m double precision,
  first_at      timestamptz,
  last_at       timestamptz,
  archived_at   timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE kh.session_route_archive IS
  'One simplified LineString per finished session, kept forever. The raw fixes '
  'in kh.location_points are dropped by the retention policy after two years; '
  'this is what the archive draws once they are.';

-- -----------------------------------------------------------------------------
-- Build the line for one session
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION kh.archive_session_route(
  p_session_id  uuid,
  p_tolerance_m integer DEFAULT 10
) RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
  v_count   int;
  v_line    geometry;
  v_first   timestamptz;
  v_last    timestamptz;
  v_applied int;
  /*
   * Below this, keep every vertex.
   *
   * 10 m of tolerance is invisible on a 500 km haul and cuts a 6,000-point
   * trace to a few hundred. On a short trace it is destructive: a 234-fix yard
   * manoeuvre spanning 40 m simplifies to its two endpoints, and the archive
   * then shows a straight line where there was a loop. 500 vertices is roughly
   * 10 kB stored — free — so anything at or under it is kept whole and lossless.
   */
  c_keep_whole constant int := 500;
BEGIN
  /*
   * ORDER BY recorded_at, and recorded_at is the DEVICE clock.
   *
   * received_at would be wrong: a truck emerging from a dead zone uploads
   * twelve hours of buffered fixes at once, so ordering by arrival time draws
   * the road in the order the network recovered rather than the order it was
   * driven. The ingest function already rejects implausible device timestamps,
   * which is what makes this safe to trust here.
   */
  SELECT count(*) INTO v_count FROM kh.location_points WHERE session_id = p_session_id;
  v_applied := CASE WHEN v_count <= c_keep_whole THEN 0 ELSE p_tolerance_m END;

  SELECT min(recorded_at), max(recorded_at),
         CASE
           WHEN v_applied = 0
             THEN ST_MakeLine(p.position::geometry ORDER BY p.recorded_at)
           ELSE ST_SimplifyPreserveTopology(
                  ST_MakeLine(p.position::geometry ORDER BY p.recorded_at),
                  -- ST_Simplify works in the geometry's own units, and 4326 is
                  -- degrees. 1e-5 deg is ~1.1 m of latitude, so metres / 111320
                  -- is the honest conversion; longitude shrinks with latitude,
                  -- which at this tolerance is far below anything visible.
                  -- PreserveTopology, so a route that doubles back on itself
                  -- cannot be simplified into a self-intersecting line.
                  v_applied::double precision / 111320.0
                )
         END
    INTO v_first, v_last, v_line
  FROM kh.location_points p
  WHERE p.session_id = p_session_id;

  -- One point is not a line. ST_MakeLine returns a POINT for a single vertex
  -- and NULL for none, and either would violate the LineString column type.
  IF v_count IS NULL OR v_count < 2 OR v_line IS NULL
     OR GeometryType(v_line) <> 'LINESTRING' THEN
    RETURN false;
  END IF;

  INSERT INTO kh.session_route_archive AS a
    (session_id, path, source_points, tolerance_m, path_length_m, first_at, last_at)
  VALUES (
    p_session_id, v_line::geography, v_count, v_applied,
    ST_Length(v_line::geography), v_first, v_last
  )
  /*
   * Re-archiving is allowed, but only ever upward. A session that closed, got
   * archived, and then received a late backfill batch out of a dead zone must
   * be allowed to improve its line — but a re-run against a database whose raw
   * chunks have since been dropped would otherwise overwrite a good 6,000-point
   * archive with a 3-point one built from whatever survived.
   */
  ON CONFLICT (session_id) DO UPDATE
    SET path          = EXCLUDED.path,
        source_points = EXCLUDED.source_points,
        tolerance_m   = EXCLUDED.tolerance_m,
        path_length_m = EXCLUDED.path_length_m,
        first_at      = EXCLUDED.first_at,
        last_at       = EXCLUDED.last_at,
        archived_at   = now()
    WHERE EXCLUDED.source_points > a.source_points;

  RETURN true;
END;
$$;

COMMENT ON FUNCTION kh.archive_session_route IS
  'Folds a session''s raw fixes into one simplified LineString. Idempotent, and '
  'only ever replaces an existing archive with a denser one.';

-- -----------------------------------------------------------------------------
-- Sweep: archive every finished session that has no line yet
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION kh.archive_finished_routes(p_limit integer DEFAULT 50)
RETURNS TABLE (session_id uuid, archived boolean)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  WITH due AS (
    SELECT s.id
    FROM kh.tracking_sessions s
    LEFT JOIN kh.session_route_archive a ON a.session_id = s.id
    WHERE s.status IN ('COMPLETED', 'CANCELLED', 'EXPIRED')
      AND a.session_id IS NULL
      -- A grace window, not paranoia: a phone that lost signal near the end
      -- keeps uploading after a dispatcher has closed the session, and
      -- archiving the instant the status flips would freeze the line before
      -- the last leg of the road arrived.
      AND coalesce(s.ended_at, s.updated_at) < now() - interval '6 hours'
    ORDER BY coalesce(s.ended_at, s.updated_at)
    LIMIT p_limit
  )
  SELECT d.id, kh.archive_session_route(d.id) FROM due d;
END;
$$;

-- -----------------------------------------------------------------------------
-- Backfill what is already closed, now, while every raw fix still exists
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  r record;
  n int := 0;
BEGIN
  FOR r IN
    SELECT s.id
    FROM kh.tracking_sessions s
    LEFT JOIN kh.session_route_archive a ON a.session_id = s.id
    WHERE s.status IN ('COMPLETED', 'CANCELLED', 'EXPIRED')
      AND a.session_id IS NULL
  LOOP
    IF kh.archive_session_route(r.id) THEN n := n + 1; END IF;
  END LOOP;
  RAISE NOTICE 'archived % finished session route(s)', n;
END $$;

-- -----------------------------------------------------------------------------
-- The archive list, as one view the dashboard can page through
-- -----------------------------------------------------------------------------
CREATE OR REPLACE VIEW kh.v_archived_sessions AS
SELECT
  s.id                    AS session_id,
  s.reference,
  s.status::text          AS status,
  s.started_at,
  s.ended_at,
  s.end_reason,
  s.distance_m,
  s.points_total,
  s.driver_name_snapshot  AS driver_name,
  s.vehicle_plate_snapshot AS vehicle_plate,
  o.id                    AS order_id,
  o.order_number::text    AS order_number,
  o.status::text          AS order_status,
  o.destination_label,
  o.planned_delivery_at,
  c.name                  AS customer_name,
  c.country_code::text    AS customer_country,
  sc.name                 AS carrier_name,
  -- Whether the road itself is still recoverable, and from where. The dashboard
  -- needs this to say "route unavailable" honestly rather than drawing nothing
  -- and letting the reader assume the truck never moved.
  (ar.session_id IS NOT NULL) AS has_archived_route,
  ar.source_points        AS route_points,
  ar.archived_at
FROM kh.tracking_sessions s
JOIN kh.orders             o  ON o.id = s.order_id
JOIN kh.customers          c  ON c.id = o.customer_id
LEFT JOIN kh.shipping_companies sc ON sc.id = s.shipping_company_id
LEFT JOIN kh.session_route_archive ar ON ar.session_id = s.id
WHERE s.status IN ('COMPLETED', 'CANCELLED', 'EXPIRED');

COMMENT ON VIEW kh.v_archived_sessions IS
  'Finished shipments — delivered, cancelled or expired — with enough context to '
  'find one years later and a flag for whether its route survives.';

CREATE INDEX IF NOT EXISTS ix_sessions_closed_ended
  ON kh.tracking_sessions (ended_at DESC NULLS LAST)
  WHERE status IN ('COMPLETED', 'CANCELLED', 'EXPIRED');

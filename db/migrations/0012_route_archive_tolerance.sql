-- =============================================================================
-- 0012 — Scale the archive tolerance to the route, not to the point count
-- =============================================================================
--
-- 0011 skipped simplification for traces of 500 vertices or fewer. That fixed
-- the case it was written against and left the real bug in place, which
-- production showed within the hour:
--
--   KH-94B120BC   510 raw fixes  ->  2 vertices
--
-- 510 is just over the floor, so a flat 10 m tolerance engaged — and the whole
-- trace spanned a few tens of metres, because the phone sat in a yard. Every
-- vertex was inside the tolerance, so Douglas-Peucker correctly reduced it to
-- the two endpoints and the archive recorded a straight line where there had
-- been a manoeuvre.
--
-- The point count was never the right quantity. What matters is the tolerance
-- RELATIVE TO THE ROUTE'S OWN EXTENT: 10 m is nothing across 500 km and
-- everything across 40 m. So derive it — one thousandth of the path's own
-- length, capped at 10 m:
--
--   500 km haul   ->  min(10, 500)     = 10 m     (6,000 pts -> a few hundred)
--   40 m yard move ->  min(10, 0.04)   = 0.04 m   (effectively lossless)
--
-- One number, no threshold to sit just the wrong side of, and it degrades
-- smoothly across every route length in between.
-- =============================================================================

CREATE OR REPLACE FUNCTION kh.archive_session_route(
  p_session_id  uuid,
  -- Now a CEILING rather than the tolerance itself. Kept as a parameter so a
  -- caller repairing an archive can force a finer one.
  p_tolerance_m integer DEFAULT 10
) RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
  v_count   int;
  v_raw     geometry;
  v_line    geometry;
  v_first   timestamptz;
  v_last    timestamptz;
  v_len_m   double precision;
  v_applied double precision;
BEGIN
  -- Build the full line first. Ordered by recorded_at, the DEVICE clock:
  -- received_at would draw the road in the order the network recovered rather
  -- than the order it was driven, which is exactly wrong for a fleet whose
  -- phones backfill out of dead zones.
  SELECT count(*), min(p.recorded_at), max(p.recorded_at),
         ST_MakeLine(p.position::geometry ORDER BY p.recorded_at)
    INTO v_count, v_first, v_last, v_raw
  FROM kh.location_points p
  WHERE p.session_id = p_session_id;

  IF v_count IS NULL OR v_count < 2 OR v_raw IS NULL
     OR GeometryType(v_raw) <> 'LINESTRING' THEN
    RETURN false;
  END IF;

  v_len_m := ST_Length(v_raw::geography);

  /*
   * A thousandth of the route, capped. The cap keeps a long haul cheap; the
   * ratio keeps a short one intact. greatest(...,0) guards the degenerate case
   * of a zero-length path, where any positive tolerance would collapse it.
   */
  v_applied := greatest(least(p_tolerance_m::double precision, v_len_m / 1000.0), 0);

  IF v_applied <= 0 THEN
    v_line := v_raw;
  ELSE
    -- Degrees, because the geometry is 4326. 1e-5 deg is ~1.1 m of latitude.
    -- PreserveTopology so a route that doubles back cannot be simplified into
    -- a self-intersecting line.
    v_line := ST_SimplifyPreserveTopology(v_raw, v_applied / 111320.0);
  END IF;

  INSERT INTO kh.session_route_archive AS a
    (session_id, path, source_points, tolerance_m, path_length_m, first_at, last_at)
  VALUES (
    p_session_id, v_line::geography, v_count, ceil(v_applied)::int,
    ST_Length(v_line::geography), v_first, v_last
  )
  /*
   * 0011 accepted a replacement only when it came from MORE raw fixes, so a
   * denser trace could improve a line and a depleted one could not damage it.
   * That guard also blocks this repair, which rebuilds from the same fixes.
   *
   * So: accept when the source is denser (the original intent) OR when the new
   * line keeps more vertices from the same source (a finer tolerance). A
   * re-run against a trace the retention policy has emptied still cannot win,
   * because it has neither more fixes nor more vertices.
   */
  ON CONFLICT (session_id) DO UPDATE
    SET path          = EXCLUDED.path,
        source_points = EXCLUDED.source_points,
        tolerance_m   = EXCLUDED.tolerance_m,
        path_length_m = EXCLUDED.path_length_m,
        first_at      = EXCLUDED.first_at,
        last_at       = EXCLUDED.last_at,
        archived_at   = now()
    WHERE EXCLUDED.source_points > a.source_points
       OR ST_NPoints(EXCLUDED.path::geometry) > ST_NPoints(a.path::geometry);

  RETURN true;
END;
$$;

-- -----------------------------------------------------------------------------
-- Repair every route 0011 over-simplified, while the raw fixes still exist
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  r record;
  n int := 0;
BEGIN
  FOR r IN
    SELECT a.session_id
    FROM kh.session_route_archive a
    WHERE a.tolerance_m > 0
      -- Only where the raw trace is still there to rebuild from. Once
      -- retention has taken it, an over-simplified line is all there is and
      -- rebuilding would make it worse, not better.
      AND EXISTS (SELECT 1 FROM kh.location_points p WHERE p.session_id = a.session_id)
  LOOP
    IF kh.archive_session_route(r.session_id) THEN n := n + 1; END IF;
  END LOOP;
  RAISE NOTICE 'rebuilt % over-simplified route(s)', n;
END $$;

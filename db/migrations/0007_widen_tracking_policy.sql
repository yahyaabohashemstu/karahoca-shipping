-- =============================================================================
-- 0007 — let the dispatcher choose the cadence, including distance-triggered
-- =============================================================================
-- Two changes, both driven by how the system is actually used.
--
-- 1. WIDER INTERVAL BOUNDS.
--    ck_session_intervals capped ping_interval_sec at 600 (10 min) and
--    idle_interval_sec at 1800 (30 min). Those were guesses made before anyone
--    had run a real shipment. A long-haul run to eastern Anatolia does not need
--    a fix every ten minutes to be useful, and forcing one costs battery on a
--    driver's personal phone for a route that is a straight line for four hours.
--
--    New bounds: ping 2 s – 1 h, idle 5 s – 4 h. Still bounded, because an
--    unbounded interval is indistinguishable from "not tracking" and would let
--    a typo silently produce a session that reports once a week.
--
-- 2. DISTANCE-TRIGGERED TRACKING.
--    min_distance_m already existed, was already echoed to the device in every
--    ingest acknowledgement, and was ignored by the app — the LocationRequest
--    hard-coded a zero displacement filter. It is now honoured, which turns the
--    column into a real mode selector: zero means time-triggered, non-zero means
--    "store a fix every N metres".
--
--    smallint capped it at 32767 m, which is plenty, but the DTO capped it at
--    5000. Both are widened to 20 km — long enough for a motorway leg where one
--    point every 20 km is a perfectly reasonable trace, short enough that a
--    fat-fingered 200000 is rejected rather than producing a silent truck.
--
--    No mode column. Distance mode IS min_distance_m > 0; deriving it keeps the
--    wire format unchanged, keeps every already-issued session valid, and
--    removes a second source of truth that could disagree with the first.
-- =============================================================================

ALTER TABLE kh.tracking_sessions
  DROP CONSTRAINT IF EXISTS ck_session_intervals;

-- ADD CONSTRAINT validates existing rows and aborts the whole migration if one
-- fails. The new `idle >= ping` rule is not implied by the old bounds — a
-- session created with ping=300 and the default idle=60 was legal before and is
-- not now — so any such row is repaired first rather than blocking the deploy.
UPDATE kh.tracking_sessions
   SET idle_interval_sec = ping_interval_sec
 WHERE idle_interval_sec < ping_interval_sec;

ALTER TABLE kh.tracking_sessions
  ADD CONSTRAINT ck_session_intervals CHECK (
    ping_interval_sec BETWEEN 2 AND 3600
    AND idle_interval_sec BETWEEN 5 AND 14400
    AND min_distance_m BETWEEN 0 AND 20000
    -- The idle cadence is the floor on how long a truck may stay silent before
    -- the dashboard calls it STALE. It must never be tighter than the moving
    -- cadence, or a parked truck would be sampled more often than a driving one.
    AND idle_interval_sec >= ping_interval_sec
  );

COMMENT ON COLUMN kh.tracking_sessions.min_distance_m IS
  'Distance trigger in metres. 0 = time-triggered (ping_interval_sec governs). '
  'Non-zero = store a fix every N metres travelled, with ping_interval_sec as '
  'the sampling floor and idle_interval_sec as a heartbeat so a parked truck '
  'still proves it is parked rather than going silent.';

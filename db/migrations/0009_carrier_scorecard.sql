-- =============================================================================
-- 0009 — the carrier scorecard stops making two claims it cannot support
-- =============================================================================
--
-- kh.v_carrier_performance feeds exactly one screen, /performance, and that
-- screen gets printed and put on the table when a haulage rate is being
-- argued about. Two of its numbers were wrong, and both were wrong in the same
-- direction: against the carrier.
--
-- 1. THE ON-TIME PERCENTAGE HAD THE WRONG DENOMINATOR.
--
--    `on_time` counts completed sessions whose ORDER carries a
--    planned_delivery_at and which ended before it. planned_delivery_at is
--    optional on the order form and is routinely left empty. The dashboard
--    divided that count by `completed` — every completed session, dated or
--    not — so every shipment dispatched without a promised time was silently
--    scored as a miss. A carrier that has never once been late shows 0% for as
--    long as nobody types the dates.
--
--    A shipment with no promised delivery time is not a late shipment, it is
--    an unmeasurable one. `on_time_measurable` is the count that belongs under
--    that percentage, and it is exported so the screen can print the fraction
--    instead of a bare number. A percentage whose base is not on screen is the
--    first thing the other side of the table pulls apart.
--
-- 2. "COVERAGE" WAS NOT COVERAGE, AND IT WAS BEING READ AS A DRIVER SCORE.
--
--    avg_coverage_pct was
--
--        points_total * ping_interval_sec / (ended_at - started_at)
--
--    presented as "the share of the journey we have telemetry for" and
--    captioned, in Turkish, as evidence that the driver had closed the app.
--
--    It is neither. ping_interval_sec is the cadence WHILE MOVING;
--    idle_interval_sec governs a stationary truck and defaults to six times
--    slower. A truck that legitimately waits four hours at a customs gate
--    therefore produces a sixth of the fixes this formula expects of those
--    four hours, and a flawless trace scores about 58%. Worse, when
--    min_distance_m > 0 the device stores a fix every N metres (0007), so the
--    expected number of fixes has no relationship to elapsed time at all and
--    the ratio is not inaccurate, it is meaningless.
--
--    Can it be made honest here? No — not from these columns.
--
--    Telling "the app was off" apart from "the truck was parked" requires the
--    split between moving time and idle time, and nothing on
--    kh.tracking_sessions records it. The nearest honest denominator,
--    duration / idle_interval_sec, is the heartbeat floor every running device
--    must clear in either mode — but because idle is typically several times
--    ping, a device reporting normally banks so much credit against that floor
--    that it still reads 100% after going dark for half the trip. A metric
--    that cannot detect the failure it exists to detect is worse than none.
--
--    So the number is relabelled rather than dressed up. avg_sampling_pct says
--    what the arithmetic actually computes: recorded fixes as a share of the
--    most the MOVING cadence could have produced across the whole session. A
--    low value is a reason to look, not a verdict — and the column that does
--    answer "did this driver's phone stop reporting" is avg_largest_gap_sec,
--    which was already sitting next to it.
--
--    Two real corrections travel with the rename:
--      * distance-triggered sessions (min_distance_m > 0) are excluded from
--        the average instead of dragging it down, because for them the ratio
--        is a category error rather than a small one;
--      * only COMPLETED sessions count, matching avg_distance_km and
--        avg_duration_h. An EXPIRED session ends at the 72-hour lifetime cap,
--        so its "duration" is the cap and not the shipment — which pulled the
--        average down for a reason no driver had anything to do with.
--
--    The honest coverage figure needs a silent_sec counter on
--    kh.tracking_sessions, maintained by kh.ingest_points alongside
--    largest_gap_sec, which that function is already positioned to compute.
--    That is a change to the ingest path, not to a view, and it is
--    deliberately not smuggled in here.
-- =============================================================================

-- CREATE OR REPLACE VIEW may only append columns: it cannot rename one and it
-- cannot insert one in the middle. So the rename happens first and in place,
-- and the new counter goes on the end.
DO $$
BEGIN
  ALTER VIEW kh.v_carrier_performance RENAME COLUMN avg_coverage_pct TO avg_sampling_pct;
EXCEPTION WHEN undefined_column THEN
  NULL;   -- already renamed; this migration is being replayed
END $$;

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

  -- Recorded fixes as a share of what the moving cadence could have produced
  -- over the whole session. A density statistic, not a coverage figure and not
  -- a driver score — see the header.
  round(avg(
    CASE
      -- Distance-triggered: one fix every N metres, so elapsed time predicts
      -- nothing. These sessions leave the average rather than distort it.
      WHEN s.min_distance_m > 0 THEN NULL
      WHEN s.status = 'COMPLETED'
       AND s.started_at IS NOT NULL
       AND s.ended_at > s.started_at
      THEN least(1.0, (s.points_total * s.ping_interval_sec)::numeric
                      / nullif(extract(epoch FROM (s.ended_at - s.started_at)), 0))
    END
  ) * 100, 1)                                          AS avg_sampling_pct,

  -- Numerator and denominator, both exported, because neither means anything
  -- alone. The ended_at guard is not decoration: a COMPLETED row with a NULL
  -- ended_at would compare NULL against the deadline, land in the denominator
  -- and never in the numerator, and quietly understate the carrier.
  count(*) FILTER (
    WHERE s.status = 'COMPLETED'
      AND s.ended_at IS NOT NULL
      AND o.planned_delivery_at IS NOT NULL
      AND s.ended_at <= o.planned_delivery_at
  )                                                    AS on_time,
  count(*) FILTER (
    WHERE s.status = 'COMPLETED'
      AND s.ended_at IS NOT NULL
      AND o.planned_delivery_at IS NOT NULL
  )                                                    AS on_time_measurable
FROM kh.shipping_companies sc
LEFT JOIN kh.tracking_sessions s ON s.shipping_company_id = sc.id
LEFT JOIN kh.orders            o ON o.id = s.order_id
GROUP BY sc.id, sc.name;

COMMENT ON VIEW kh.v_carrier_performance IS
  'Carrier scorecard. Every ratio here must be rendered with its denominator: '
  'on_time is only meaningful over on_time_measurable, and avg_sampling_pct is '
  'a telemetry density figure rather than a measure of journey coverage.';

COMMENT ON COLUMN kh.v_carrier_performance.on_time_measurable IS
  'Completed sessions whose order carries a planned_delivery_at — the only '
  'legitimate denominator for on_time. planned_delivery_at is optional, so '
  'dividing by `completed` scores every undated shipment as late.';

COMMENT ON COLUMN kh.v_carrier_performance.avg_sampling_pct IS
  'Recorded fixes as a share of the most ping_interval_sec could produce over '
  'the whole session, averaged across completed time-triggered sessions. Falls '
  'legitimately whenever a truck stands still; use avg_largest_gap_sec to tell '
  'a parked truck from a phone that stopped reporting.';

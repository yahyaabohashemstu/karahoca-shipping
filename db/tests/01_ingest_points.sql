-- =============================================================================
-- kh.ingest_points — the write path
-- =============================================================================
-- Every claim made in ADR-005 and ADR-010 is asserted here against a real
-- hypertable. If a change breaks idempotency, the monotonic live-state guard,
-- or GPS-teleport rejection, this file fails.
-- =============================================================================

DO $$
DECLARE
  S CONSTANT text := 'ingest';
  v_sid  uuid;
  v_r    jsonb;
  v_r2   jsonb;
  v_t0   timestamptz := date_trunc('second', now()) - interval '10 minutes';
  -- 0.001 degree of latitude at 40.77N is ~111 m.
  v_lat  double precision := 40.76540;
  v_lon  double precision := 29.91870;
  v_row  record;
  v_int  int;
  v_bool boolean;
  v_ts   timestamptz;
  v_num  double precision;
BEGIN

-- ---------------------------------------------------------------------------
-- 1. Happy path
-- ---------------------------------------------------------------------------
v_sid := kh_test.new_session('happy');
v_r := kh_test.ingest(v_sid, jsonb_build_array(
  kh_test.pt('P1', v_t0,                       v_lat,         v_lon),
  kh_test.pt('P2', v_t0 + interval '10 second', v_lat + 0.001, v_lon),
  kh_test.pt('P3', v_t0 + interval '20 second', v_lat + 0.002, v_lon)
));

PERFORM kh_test.eq(S, 'accepts a clean batch',        (v_r->>'accepted')::int,   3);
PERFORM kh_test.eq(S, 'no duplicates on first send',  (v_r->>'duplicates')::int, 0);
PERFORM kh_test.eq(S, 'no rejects on clean batch',    (v_r->>'rejected')::int,   0);
PERFORM kh_test.eq(S, 'advanced flag set',            (v_r->>'advanced')::boolean, true);
PERFORM kh_test.eq(S, 'CLAIMED becomes ACTIVE',       v_r->>'sessionStatus',     'ACTIVE');
PERFORM kh_test.eq(S, 'pointsTotal accumulates',      (v_r->>'pointsTotal')::int, 3);
PERFORM kh_test.ok(S, 'serverTime returned',          (v_r->>'serverTime') IS NOT NULL);
PERFORM kh_test.eq(S, 'policy echoed to device',      (v_r#>>'{policy,pingIntervalSec}')::int, 10);
PERFORM kh_test.ok(S, 'live block present',           v_r->'live' IS NOT NULL AND v_r->'live' <> 'null'::jsonb);

-- Two 111 m hops.
PERFORM kh_test.between(S, 'distance ~222 m for two 0.001 deg hops',
                        (v_r->>'distanceM')::double precision, 210, 235);

SELECT started_at INTO v_ts FROM kh.tracking_sessions WHERE id = v_sid;
PERFORM kh_test.eq(S, 'started_at set from first fix', v_ts, v_t0);

-- ---------------------------------------------------------------------------
-- 2. Idempotency — the property the whole offline design rests on
-- ---------------------------------------------------------------------------
v_r2 := kh_test.ingest(v_sid, jsonb_build_array(
  kh_test.pt('P1', v_t0,                       v_lat,         v_lon),
  kh_test.pt('P2', v_t0 + interval '10 second', v_lat + 0.001, v_lon),
  kh_test.pt('P3', v_t0 + interval '20 second', v_lat + 0.002, v_lon)
));
PERFORM kh_test.eq(S, 'replayed batch accepts nothing',   (v_r2->>'accepted')::int,   0);
PERFORM kh_test.eq(S, 'replayed batch reports duplicates', (v_r2->>'duplicates')::int, 3);

SELECT count(*)::int INTO v_int FROM kh.location_points WHERE session_id = v_sid;
PERFORM kh_test.eq(S, 'replay creates no extra rows', v_int, 3);

SELECT points_total::int, round(distance_m::numeric,1)::double precision
INTO v_int, v_num FROM kh.tracking_sessions WHERE id = v_sid;
PERFORM kh_test.eq(S, 'replay does not inflate points_total', v_int, 3);
PERFORM kh_test.between(S, 'replay does not inflate distance', v_num, 210, 235);

-- ---------------------------------------------------------------------------
-- 3. In-batch duplicate ids collapse
-- ---------------------------------------------------------------------------
v_sid := kh_test.new_session('dedup');
v_r := kh_test.ingest(v_sid, jsonb_build_array(
  kh_test.pt('D1', v_t0, v_lat, v_lon),
  kh_test.pt('D1', v_t0, v_lat, v_lon),          -- exact duplicate
  kh_test.pt('D2', v_t0 + interval '5 second', v_lat + 0.001, v_lon)
));
PERFORM kh_test.eq(S, 'in-batch duplicates collapse', (v_r->>'accepted')::int, 2);

-- ---------------------------------------------------------------------------
-- 4. Validation — rejected, never silently coerced
-- ---------------------------------------------------------------------------
v_sid := kh_test.new_session('validation');
v_r := kh_test.ingest(v_sid, jsonb_build_array(
  kh_test.pt('V-ok',      v_t0,                        v_lat, v_lon),
  kh_test.pt('V-null-is', v_t0 + interval '1 second',  0, 0),                    -- Null Island
  kh_test.pt('V-future',  now() + interval '30 minutes', v_lat, v_lon),          -- beyond +5 min
  kh_test.pt('V-ancient', now() - interval '40 hours',   v_lat, v_lon),          -- beyond -24 h
  kh_test.pt('V-lat',     v_t0 + interval '2 second',  91.0, v_lon),             -- out of range
  kh_test.pt('V-lon',     v_t0 + interval '3 second',  v_lat, 181.0),            -- out of range
  kh_test.pt('V-acc',     v_t0 + interval '4 second',  v_lat, v_lon, 9000.0),    -- accuracy > 5000
  kh_test.pt('V-speed',   v_t0 + interval '5 second',  v_lat, v_lon, 6.0, 250.0),-- speed > 200
  kh_test.pt_raw('sh',    v_t0 + interval '6 second',  v_lat, v_lon)             -- id shorter than 8
));
PERFORM kh_test.eq(S, 'only the valid point is accepted', (v_r->>'accepted')::int, 1);
PERFORM kh_test.eq(S, 'eight invalid points rejected',    (v_r->>'rejected')::int, 8);

-- ---------------------------------------------------------------------------
-- 5. Monotonic live state — a late upload must NOT rewind the marker
-- ---------------------------------------------------------------------------
v_sid := kh_test.new_session('backfill');
PERFORM kh_test.ingest(v_sid, jsonb_build_array(
  kh_test.pt('B1', v_t0,                       v_lat,         v_lon),
  kh_test.pt('B2', v_t0 + interval '60 second', v_lat + 0.010, v_lon)
));
SELECT last_point_at, last_lat INTO v_ts, v_num
FROM kh.tracking_sessions WHERE id = v_sid;

-- Now deliver points recorded BEFORE the current head (the dead-zone case).
v_r := kh_test.ingest(v_sid, jsonb_build_array(
  kh_test.pt('B0a', v_t0 - interval '30 second', v_lat - 0.005, v_lon),
  kh_test.pt('B0b', v_t0 - interval '20 second', v_lat - 0.004, v_lon)
), true);

PERFORM kh_test.eq(S, 'backfill accepted',              (v_r->>'accepted')::int, 2);
PERFORM kh_test.eq(S, 'backfill does not set advanced', (v_r->>'advanced')::boolean, false);
PERFORM kh_test.ok(S, 'backfill returns no live block', v_r->'live' = 'null'::jsonb OR v_r->'live' IS NULL);

SELECT last_point_at, last_lat INTO v_row FROM kh.tracking_sessions WHERE id = v_sid;
PERFORM kh_test.eq(S, 'live marker time unchanged by backfill', v_row.last_point_at, v_ts);
PERFORM kh_test.eq(S, 'live marker position unchanged by backfill', v_row.last_lat, v_num);

SELECT count(*)::int INTO v_int
FROM kh.location_points WHERE session_id = v_sid AND is_backfill;
PERFORM kh_test.eq(S, 'backfilled rows flagged is_backfill', v_int, 2);

SELECT count(*)::int INTO v_int
FROM kh.session_events WHERE session_id = v_sid AND type = 'OFFLINE_BATCH_SYNCED';
PERFORM kh_test.eq(S, 'offline sync logs an event', v_int, 1);

-- ---------------------------------------------------------------------------
-- 6. Distance hygiene
-- ---------------------------------------------------------------------------

-- 6a. GPS teleport: 1 second apart, ~85 km away -> implied speed far over 60 m/s
v_sid := kh_test.new_session('teleport');
PERFORM kh_test.ingest(v_sid, jsonb_build_array(kh_test.pt('T1', v_t0, v_lat, v_lon)));
v_r := kh_test.ingest(v_sid, jsonb_build_array(
  kh_test.pt('T2', v_t0 + interval '1 second', v_lat + 0.8, v_lon)
));
SELECT distance_m INTO v_num FROM kh.tracking_sessions WHERE id = v_sid;
PERFORM kh_test.between(S, 'GPS teleport excluded from distance', v_num, 0, 1);

-- 6b. Untrustworthy accuracy excludes the segment
v_sid := kh_test.new_session('accuracy');
PERFORM kh_test.ingest(v_sid, jsonb_build_array(kh_test.pt('A1', v_t0, v_lat, v_lon, 6.0)));
PERFORM kh_test.ingest(v_sid, jsonb_build_array(
  kh_test.pt('A2', v_t0 + interval '10 second', v_lat + 0.001, v_lon, 400.0)   -- 400 m accuracy
));
SELECT distance_m INTO v_num FROM kh.tracking_sessions WHERE id = v_sid;
PERFORM kh_test.between(S, 'low-accuracy segment excluded from distance', v_num, 0, 1);

-- 6c. Sequential chunks chain across calls (the offline-flush pattern)
v_sid := kh_test.new_session('chained');
PERFORM kh_test.ingest(v_sid, jsonb_build_array(kh_test.pt('C1', v_t0, v_lat, v_lon)));
PERFORM kh_test.ingest(v_sid, jsonb_build_array(
  kh_test.pt('C2', v_t0 + interval '10 second', v_lat + 0.001, v_lon)));
PERFORM kh_test.ingest(v_sid, jsonb_build_array(
  kh_test.pt('C3', v_t0 + interval '20 second', v_lat + 0.002, v_lon)));
SELECT distance_m INTO v_num FROM kh.tracking_sessions WHERE id = v_sid;
PERFORM kh_test.between(S, 'distance chains across separate calls', v_num, 210, 235);

-- ---------------------------------------------------------------------------
-- 7. Anomaly accounting
-- ---------------------------------------------------------------------------
v_sid := kh_test.new_session('anomaly');
v_r := kh_test.ingest(v_sid, jsonb_build_array(
  kh_test.pt('M1', v_t0,                       v_lat,         v_lon, 6.0, 15.0, false),
  kh_test.pt('M2', v_t0 + interval '10 second', v_lat + 0.001, v_lon, 6.0, 33.0, true),
  kh_test.pt('M3', v_t0 + interval '20 second', v_lat + 0.002, v_lon, 6.0, 21.0, true)
));
SELECT mock_location_count::int, max_speed_mps::double precision
INTO v_int, v_num FROM kh.tracking_sessions WHERE id = v_sid;
PERFORM kh_test.eq(S, 'mock locations counted, not dropped', v_int, 2);
PERFORM kh_test.between(S, 'max speed tracked', v_num, 32.9, 33.1);

SELECT count(*)::int INTO v_int
FROM kh.session_events WHERE session_id = v_sid AND type = 'MOCK_LOCATION_DETECTED';
PERFORM kh_test.eq(S, 'mock location raises an event', v_int, 1);

SELECT count(*)::int INTO v_int
FROM kh.location_points WHERE session_id = v_sid AND is_mock;
PERFORM kh_test.eq(S, 'mock points retained as evidence', v_int, 2);

-- Largest gap
v_sid := kh_test.new_session('gap');
PERFORM kh_test.ingest(v_sid, jsonb_build_array(
  kh_test.pt('G1', v_t0,                        v_lat,         v_lon),
  kh_test.pt('G2', v_t0 + interval '400 second', v_lat + 0.001, v_lon)
));
SELECT largest_gap_sec INTO v_int FROM kh.tracking_sessions WHERE id = v_sid;
PERFORM kh_test.eq(S, 'largest_gap_sec recorded', v_int, 400);

-- ---------------------------------------------------------------------------
-- 8. Batch receipts
-- ---------------------------------------------------------------------------
v_sid := kh_test.new_session('receipt');
PERFORM kh.ingest_points(
  v_sid, '11111111-2222-3333-4444-555555555555'::uuid, 'dev-x',
  jsonb_build_array(kh_test.pt('R1', v_t0, v_lat, v_lon)),
  true, '10.0.0.7'::inet, 1234, 7
);
SELECT point_count, accepted_count, is_offline_sync, body_bytes, device_id
INTO v_row
FROM kh.ingest_batches WHERE id = '11111111-2222-3333-4444-555555555555';
PERFORM kh_test.eq(S, 'batch receipt point_count',  v_row.point_count, 1);
PERFORM kh_test.eq(S, 'batch receipt accepted',     v_row.accepted_count, 1);
PERFORM kh_test.eq(S, 'batch receipt offline flag', v_row.is_offline_sync, true);
PERFORM kh_test.eq(S, 'batch receipt body_bytes',   v_row.body_bytes, 1234);
PERFORM kh_test.eq(S, 'batch receipt device_id',    v_row.device_id, 'dev-x'::text);

-- Re-sending the same batch id must not error (ON CONFLICT DO NOTHING).
PERFORM kh.ingest_points(
  v_sid, '11111111-2222-3333-4444-555555555555'::uuid, 'dev-x',
  jsonb_build_array(kh_test.pt('R1', v_t0, v_lat, v_lon)),
  true, '10.0.0.7'::inet, 1234, 7
);
SELECT count(*)::int INTO v_int
FROM kh.ingest_batches WHERE id = '11111111-2222-3333-4444-555555555555';
PERFORM kh_test.eq(S, 'duplicate batch id is idempotent', v_int, 1);

-- ---------------------------------------------------------------------------
-- 9. Guard rails
-- ---------------------------------------------------------------------------
v_sid := kh_test.new_session('guards');

PERFORM kh_test.raises(S, 'unknown session raises',
  format('SELECT kh.ingest_points(%L::uuid, gen_random_uuid(), %L, %L::jsonb)',
         '00000000-0000-4000-8000-000000000000', 'd', '[]'),
  'P0002');

PERFORM kh_test.raises(S, 'non-array payload raises',
  format('SELECT kh.ingest_points(%L::uuid, gen_random_uuid(), %L, %L::jsonb)',
         v_sid, 'd', '{"not":"an array"}'),
  '22023');

PERFORM kh_test.raises(S, 'oversized batch raises',
  format($q$SELECT kh.ingest_points(%L::uuid, gen_random_uuid(), 'd',
              (SELECT jsonb_agg(kh_test.pt('X'||g, now() - (g||' seconds')::interval, 40.0, 29.0))
               FROM generate_series(1, 20001) g))$q$, v_sid),
  '54000');

-- Empty array is a no-op, not an error: a device may flush an empty buffer.
v_r := kh_test.ingest(v_sid, '[]'::jsonb);
PERFORM kh_test.eq(S, 'empty batch is a no-op', (v_r->>'accepted')::int, 0);

-- A closed session must refuse data.
PERFORM kh.finalize_session(v_sid, 'test close', 'test', 'COMPLETED');
PERFORM kh_test.raises(S, 'closed session refuses points',
  format('SELECT kh.ingest_points(%L::uuid, gen_random_uuid(), %L, %L::jsonb)',
         v_sid, 'd', jsonb_build_array(kh_test.pt('Z1', v_t0, 40.0, 29.0))::text),
  '55000');

END $$;

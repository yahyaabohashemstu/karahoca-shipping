-- =============================================================================
-- Route geometry, lifecycle functions, views and schema constraints
-- =============================================================================

DO $$
DECLARE
  S CONSTANT text := 'functions';
  v_sid    uuid;
  v_oid    uuid;
  v_t0     timestamptz := date_trunc('second', now()) - interval '20 minutes';
  v_lat    double precision := 40.76540;
  v_lon    double precision := 29.91870;
  v_route  jsonb;
  v_int    int;
  v_num    double precision;
  v_txt    text;
  v_bool   boolean;
  v_row    record;
  v_pts    jsonb;
BEGIN

-- ---------------------------------------------------------------------------
-- 1. kh.session_route
-- ---------------------------------------------------------------------------
v_sid := kh_test.new_session('route');

-- 10 collinear points. Douglas–Peucker must reduce a straight line to its ends.
SELECT jsonb_agg(kh_test.pt('RT' || g, v_t0 + (g || ' seconds')::interval,
                            v_lat + g * 0.0005, v_lon))
INTO v_pts FROM generate_series(1, 10) g;
PERFORM kh_test.ingest(v_sid, v_pts);

v_route := kh.session_route(v_sid, 0);                 -- tolerance 0 = raw
PERFORM kh_test.eq(S, 'route reports all raw points', (v_route->>'pointCount')::int, 10);
PERFORM kh_test.eq(S, 'raw route is not simplified',  (v_route->>'simplified')::boolean, false);
PERFORM kh_test.eq(S, 'route geometry is a LineString',
                   v_route#>>'{features,0,geometry,type}', 'LineString');

v_route := kh.session_route(v_sid, 8, NULL, NULL, 3);  -- force simplification
PERFORM kh_test.eq(S, 'simplification kicks in past max_points',
                   (v_route->>'simplified')::boolean, true);
PERFORM kh_test.eq(S, 'collinear route collapses to 2 points',
                   (v_route->>'renderedPointCount')::int, 2);
PERFORM kh_test.eq(S, 'original point count still reported',
                   (v_route->>'pointCount')::int, 10);

-- Time window filter
v_route := kh.session_route(v_sid, 0, v_t0 + interval '5 seconds', v_t0 + interval '8 seconds');
PERFORM kh_test.eq(S, 'route honours the time window', (v_route->>'pointCount')::int, 4);

-- Fewer than 2 points cannot form a line
v_sid := kh_test.new_session('route-single');
PERFORM kh_test.ingest(v_sid, jsonb_build_array(kh_test.pt('S1', v_t0, v_lat, v_lon)));
v_route := kh.session_route(v_sid, 0);
PERFORM kh_test.eq(S, 'single point yields empty FeatureCollection',
                   jsonb_array_length(v_route->'features'), 0);

-- ---------------------------------------------------------------------------
-- 2. kh.recompute_session_distance
-- ---------------------------------------------------------------------------
v_sid := kh_test.new_session('recompute');
PERFORM kh_test.ingest(v_sid, jsonb_build_array(
  kh_test.pt('RC1', v_t0,                       v_lat,         v_lon),
  kh_test.pt('RC2', v_t0 + interval '10 second', v_lat + 0.001, v_lon),
  kh_test.pt('RC3', v_t0 + interval '20 second', v_lat + 0.002, v_lon)
));
-- Corrupt the denormalised value, then prove the recompute repairs it.
UPDATE kh.tracking_sessions SET distance_m = 999999 WHERE id = v_sid;
v_num := kh.recompute_session_distance(v_sid);
PERFORM kh_test.between(S, 'recompute returns the true distance', v_num, 210, 235);
SELECT distance_m INTO v_num FROM kh.tracking_sessions WHERE id = v_sid;
PERFORM kh_test.between(S, 'recompute writes back to the session', v_num, 210, 235);

-- ---------------------------------------------------------------------------
-- 3. kh.finalize_session
-- ---------------------------------------------------------------------------
v_sid := kh_test.new_session('finalize');
SELECT order_id INTO v_oid FROM kh.tracking_sessions WHERE id = v_sid;
PERFORM kh_test.ingest(v_sid, jsonb_build_array(
  kh_test.pt('F1', v_t0,                       v_lat,         v_lon),
  kh_test.pt('F2', v_t0 + interval '10 second', v_lat + 0.001, v_lon)
));
PERFORM kh.finalize_session(v_sid, 'delivered on time', 'dispatcher-1', 'COMPLETED');

SELECT status::text, ended_at IS NOT NULL AS ended, end_reason, claim_code IS NULL AS code_cleared
INTO v_row FROM kh.tracking_sessions WHERE id = v_sid;
PERFORM kh_test.eq(S, 'finalize sets COMPLETED',   v_row.status, 'COMPLETED');
PERFORM kh_test.eq(S, 'finalize stamps ended_at',  v_row.ended, true);
PERFORM kh_test.eq(S, 'finalize records a reason', v_row.end_reason, 'delivered on time');
PERFORM kh_test.eq(S, 'finalize clears claim code', v_row.code_cleared, true);

SELECT status::text INTO v_txt FROM kh.orders WHERE id = v_oid;
PERFORM kh_test.eq(S, 'finalize marks the order DELIVERED', v_txt, 'DELIVERED');

SELECT count(*)::int INTO v_int
FROM kh.session_devices WHERE session_id = v_sid AND revoked_at IS NOT NULL;
PERFORM kh_test.eq(S, 'finalize revokes the bound device', v_int, 1);

SELECT count(*)::int INTO v_int
FROM kh.session_events WHERE session_id = v_sid AND type = 'COMPLETED';
PERFORM kh_test.eq(S, 'finalize logs a COMPLETED event', v_int, 1);

-- Cancelling must NOT mark the order delivered.
v_sid := kh_test.new_session('cancel');
SELECT order_id INTO v_oid FROM kh.tracking_sessions WHERE id = v_sid;
PERFORM kh.finalize_session(v_sid, 'carrier no-show', 'dispatcher-1', 'CANCELLED');
SELECT status::text INTO v_txt FROM kh.orders WHERE id = v_oid;
PERFORM kh_test.ok(S, 'cancel does not mark the order delivered', v_txt <> 'DELIVERED', v_txt);

-- ---------------------------------------------------------------------------
-- 4. kh.expire_stale_sessions
-- ---------------------------------------------------------------------------
v_sid := kh_test.new_session('expire');
UPDATE kh.tracking_sessions
SET status = 'ASSIGNED', claim_code = kh.generate_claim_code(8),
    claim_code_expires_at = now() - interval '1 hour'
WHERE id = v_sid;

SELECT count(*)::int INTO v_int FROM kh.expire_stale_sessions() WHERE expired_id = v_sid;
PERFORM kh_test.eq(S, 'stale claim code expires the session', v_int, 1);

SELECT status::text          AS status,
       claim_code IS NULL    AS code_cleared,
       token_version         AS token_version
INTO v_row FROM kh.tracking_sessions WHERE id = v_sid;
PERFORM kh_test.eq(S, 'expired session status', v_row.status, 'EXPIRED');
PERFORM kh_test.eq(S, 'expiry clears the claim code', v_row.code_cleared, true);
PERFORM kh_test.ok(S, 'expiry bumps token_version (revocation)', v_row.token_version > 1,
                   v_row.token_version::text);

-- A healthy session must survive the sweep.
v_sid := kh_test.new_session('healthy');
PERFORM kh.expire_stale_sessions();
SELECT status::text INTO v_txt FROM kh.tracking_sessions WHERE id = v_sid;
PERFORM kh_test.eq(S, 'healthy session survives the sweep', v_txt, 'CLAIMED');

-- ---------------------------------------------------------------------------
-- 5. kh.detect_arrivals
-- ---------------------------------------------------------------------------
v_sid := kh_test.new_session('arrival', v_lat, v_lon, 300);
PERFORM kh_test.ingest(v_sid, jsonb_build_array(
  kh_test.pt('AR1', now() - interval '2 minutes', v_lat, v_lon)      -- at the destination
));
SELECT count(*)::int INTO v_int FROM kh.detect_arrivals() WHERE session_id = v_sid;
PERFORM kh_test.eq(S, 'arrival detected inside the geofence', v_int, 1);

SELECT count(*)::int INTO v_int
FROM kh.session_events WHERE session_id = v_sid AND type = 'GEOFENCE_ENTER';
PERFORM kh_test.eq(S, 'arrival logs GEOFENCE_ENTER', v_int, 1);

-- Second sweep must not double-fire.
PERFORM kh.detect_arrivals();
SELECT count(*)::int INTO v_int
FROM kh.session_events WHERE session_id = v_sid AND type = 'GEOFENCE_ENTER';
PERFORM kh_test.eq(S, 'arrival does not re-fire', v_int, 1);

-- A truck 5 km away must not trigger.
v_sid := kh_test.new_session('far', v_lat, v_lon, 300);
PERFORM kh_test.ingest(v_sid, jsonb_build_array(
  kh_test.pt('AR2', now() - interval '2 minutes', v_lat + 0.05, v_lon)
));
SELECT count(*)::int INTO v_int FROM kh.detect_arrivals() WHERE session_id = v_sid;
PERFORM kh_test.eq(S, 'distant vehicle does not trigger arrival', v_int, 0);

-- ---------------------------------------------------------------------------
-- 6. kh.v_live_fleet signal classification
-- ---------------------------------------------------------------------------
v_sid := kh_test.new_session('signal', v_lat + 0.2, v_lon);
PERFORM kh_test.ingest(v_sid, jsonb_build_array(
  kh_test.pt('SG1', now() - interval '5 seconds', v_lat, v_lon)));

SELECT signal_state, remaining_km INTO v_row FROM kh.v_live_fleet WHERE session_id = v_sid;
PERFORM kh_test.eq(S, 'fresh fix classifies as LIVE', v_row.signal_state, 'LIVE');
PERFORM kh_test.between(S, 'remaining_km computed from destination',
                        v_row.remaining_km::double precision, 20, 25);

UPDATE kh.tracking_sessions SET last_point_at = now() - interval '5 minutes' WHERE id = v_sid;
SELECT signal_state INTO v_txt FROM kh.v_live_fleet WHERE session_id = v_sid;
PERFORM kh_test.eq(S, '5-minute-old fix classifies as DELAYED', v_txt, 'DELAYED');

UPDATE kh.tracking_sessions SET last_point_at = now() - interval '45 minutes' WHERE id = v_sid;
SELECT signal_state INTO v_txt FROM kh.v_live_fleet WHERE session_id = v_sid;
PERFORM kh_test.eq(S, '45-minute-old fix classifies as STALE', v_txt, 'STALE');

UPDATE kh.tracking_sessions SET last_point_at = now() - interval '5 hours' WHERE id = v_sid;
SELECT signal_state INTO v_txt FROM kh.v_live_fleet WHERE session_id = v_sid;
PERFORM kh_test.eq(S, '5-hour-old fix classifies as LOST', v_txt, 'LOST');

-- ---------------------------------------------------------------------------
-- 7. Schema constraints
-- ---------------------------------------------------------------------------
v_sid := kh_test.new_session('constraint');
SELECT order_id INTO v_oid FROM kh.tracking_sessions WHERE id = v_sid;

PERFORM kh_test.raises(S, 'only one live session per order',
  format($q$INSERT INTO kh.tracking_sessions (order_id, shipping_company_id, status)
            SELECT %L::uuid, shipping_company_id, 'ASSIGNED' FROM kh.tracking_sessions WHERE id = %L$q$,
         v_oid, v_sid),
  '23505');

-- Once the first session closes, a replacement is allowed (carrier swap).
PERFORM kh.finalize_session(v_sid, 'reassigned', 'test', 'CANCELLED');
BEGIN
  INSERT INTO kh.tracking_sessions (order_id, shipping_company_id, status)
  SELECT v_oid, shipping_company_id, 'ASSIGNED' FROM kh.tracking_sessions WHERE id = v_sid;
  PERFORM kh_test.ok(S, 'replacement session allowed after close', true);
EXCEPTION WHEN OTHERS THEN
  PERFORM kh_test.ok(S, 'replacement session allowed after close', false, SQLERRM);
END;

-- Two active devices on one session must be impossible.
v_sid := kh_test.new_session('device');
PERFORM kh_test.raises(S, 'only one active device per session',
  format($q$INSERT INTO kh.session_devices (session_id, device_id, ingest_key_enc,
                                            refresh_token_hash, refresh_expires_at)
            VALUES (%L::uuid, 'second-device', '\x00'::bytea, '\x01'::bytea, now() + interval '1 day')$q$,
         v_sid),
  '23505');

-- ---------------------------------------------------------------------------
-- 8. Claim codes
-- ---------------------------------------------------------------------------
SELECT count(DISTINCT kh.generate_claim_code(8))::int INTO v_int
FROM generate_series(1, 500);
PERFORM kh_test.ok(S, 'claim codes are effectively unique (500 draws)', v_int >= 498, v_int::text);

SELECT bool_and(kh.generate_claim_code(8) ~ '^[0-9A-HJKMNP-TV-Z]{8}$') INTO v_bool
FROM generate_series(1, 200);
PERFORM kh_test.ok(S, 'claim codes exclude I, L, O and U', v_bool);

-- Parity with the TypeScript normaliser in apps/api/src/common/crypto.util.ts
PERFORM kh_test.eq(S, 'normalise strips separators and upcases',
                   kh.normalize_claim_code('k7h2-9qx4'), 'K7H29QX4');
PERFORM kh_test.eq(S, 'normalise maps I/L to 1, O to 0, U to 1',
                   kh.normalize_claim_code('KILOU'), 'K1101');
PERFORM kh_test.eq(S, 'normalise handles spaces and empty input',
                   kh.normalize_claim_code('  a b  '), 'AB');
PERFORM kh_test.eq(S, 'normalise tolerates null', kh.normalize_claim_code(NULL::text), ''::text);

END $$;

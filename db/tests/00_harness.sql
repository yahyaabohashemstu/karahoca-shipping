-- =============================================================================
-- Test harness
-- =============================================================================
-- Deliberately plain SQL with no external framework: the same argument as the
-- migration runner. Anyone who can read SQL can run and extend these at 2 a.m.
--
-- Tests write real rows into a real hypertable — that is the point. A mocked
-- ingest test would prove nothing about ON CONFLICT behaviour, window-function
-- distance maths, or Timescale chunk routing.
-- =============================================================================

CREATE SCHEMA IF NOT EXISTS kh_test;

DROP TABLE IF EXISTS kh_test.results;
CREATE TABLE kh_test.results (
  id       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  suite    text NOT NULL,
  name     text NOT NULL,
  ok       boolean NOT NULL,
  expected text,
  actual   text,
  ran_at   timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- -----------------------------------------------------------------------------
-- Assertions
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION kh_test.eq(
  p_suite text, p_name text, p_actual anyelement, p_expected anyelement
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO kh_test.results (suite, name, ok, expected, actual)
  VALUES (
    p_suite, p_name,
    p_actual IS NOT DISTINCT FROM p_expected,
    coalesce(p_expected::text, '<null>'),
    coalesce(p_actual::text, '<null>')
  );
END;
$$;

CREATE OR REPLACE FUNCTION kh_test.ok(
  p_suite text, p_name text, p_condition boolean, p_detail text DEFAULT NULL
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO kh_test.results (suite, name, ok, expected, actual)
  VALUES (p_suite, p_name, coalesce(p_condition, false), 'true', coalesce(p_detail, p_condition::text));
END;
$$;

/** Assert a numeric value falls inside an inclusive range (for float maths). */
CREATE OR REPLACE FUNCTION kh_test.between(
  p_suite text, p_name text, p_actual double precision,
  p_low double precision, p_high double precision
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO kh_test.results (suite, name, ok, expected, actual)
  VALUES (
    p_suite, p_name,
    p_actual IS NOT NULL AND p_actual BETWEEN p_low AND p_high,
    format('[%s .. %s]', p_low, p_high),
    coalesce(round(p_actual::numeric, 3)::text, '<null>')
  );
END;
$$;

/** Assert that a statement raises. Pass the SQL as text. */
CREATE OR REPLACE FUNCTION kh_test.raises(
  p_suite text, p_name text, p_sql text, p_expect_sqlstate text DEFAULT NULL
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_state text := NULL;
BEGIN
  BEGIN
    EXECUTE p_sql;
  EXCEPTION WHEN OTHERS THEN
    v_state := SQLSTATE;
  END;

  INSERT INTO kh_test.results (suite, name, ok, expected, actual)
  VALUES (
    p_suite, p_name,
    v_state IS NOT NULL AND (p_expect_sqlstate IS NULL OR v_state = p_expect_sqlstate),
    coalesce('raises ' || p_expect_sqlstate, 'raises'),
    coalesce('raised ' || v_state, 'no exception')
  );
END;
$$;

-- -----------------------------------------------------------------------------
-- Fixtures
-- -----------------------------------------------------------------------------

/**
 * Build one point in the exact shape kh.ingest_points' jsonb_to_recordset
 * expects, passing `p_id` through verbatim. Use this when the id itself is
 * under test.
 */
CREATE OR REPLACE FUNCTION kh_test.pt_raw(
  p_id     text,
  p_at     timestamptz,
  p_lat    double precision,
  p_lon    double precision,
  p_acc    real    DEFAULT 6.0,
  p_speed  real    DEFAULT 15.0,
  p_mock   boolean DEFAULT false,
  p_batt   smallint DEFAULT 80
) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_build_object(
    'client_point_id', p_id,
    'recorded_at',     to_jsonb(p_at),
    'lat',             p_lat,
    'lon',             p_lon,
    'accuracy_m',      p_acc,
    'speed_mps',       p_speed,
    'bearing_deg',     90.0,
    'battery_pct',     p_batt,
    'is_charging',     true,
    'is_mock',         p_mock,
    'provider',        'fused',
    'network_type',    'cellular'
  );
$$;

/**
 * Same, but expands the short readable handle into a realistic 26-character
 * ULID-shaped id.
 *
 * This matters: kh.ingest_points rejects ids shorter than 8 characters, so
 * tests written with handles like 'P1' would be silently rejected and every
 * assertion would pass for the wrong reason. md5 keeps the mapping
 * deterministic and collision-free while the test source stays readable.
 */
CREATE OR REPLACE FUNCTION kh_test.pt(
  p_id     text,
  p_at     timestamptz,
  p_lat    double precision,
  p_lon    double precision,
  p_acc    real    DEFAULT 6.0,
  p_speed  real    DEFAULT 15.0,
  p_mock   boolean DEFAULT false,
  p_batt   smallint DEFAULT 80
) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT kh_test.pt_raw(
    '01JT' || upper(substr(md5(p_id), 1, 22)),
    p_at, p_lat, p_lon, p_acc, p_speed, p_mock, p_batt
  );
$$;

/** Fresh customer + order + CLAIMED session with a bound device. Returns session id. */
CREATE OR REPLACE FUNCTION kh_test.new_session(
  p_label text DEFAULT 'T',
  p_dest_lat double precision DEFAULT NULL,
  p_dest_lon double precision DEFAULT NULL,
  p_radius int DEFAULT 300
) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  v_suffix   text := replace(gen_random_uuid()::text, '-', '');
  v_customer uuid;
  v_carrier  uuid;
  v_order    uuid;
  v_session  uuid;
BEGIN
  INSERT INTO kh.customers (code, name, city)
  VALUES ('TC-' || left(v_suffix, 12), p_label || ' Customer', 'Test')
  RETURNING id INTO v_customer;

  SELECT id INTO v_carrier FROM kh.shipping_companies ORDER BY created_at LIMIT 1;
  IF v_carrier IS NULL THEN
    INSERT INTO kh.shipping_companies (code, name)
    VALUES ('TCAR-' || left(v_suffix, 10), 'Test Carrier')
    RETURNING id INTO v_carrier;
  END IF;

  INSERT INTO kh.orders (order_number, customer_id, destination, destination_radius_m, status)
  VALUES (
    'TO-' || left(v_suffix, 14), v_customer,
    CASE WHEN p_dest_lat IS NULL THEN NULL
         ELSE ST_SetSRID(ST_MakePoint(p_dest_lon, p_dest_lat), 4326)::geography END,
    p_radius, 'DISPATCHED'
  )
  RETURNING id INTO v_order;

  INSERT INTO kh.tracking_sessions (order_id, shipping_company_id, status, claimed_at)
  VALUES (v_order, v_carrier, 'CLAIMED', now())
  RETURNING id INTO v_session;

  INSERT INTO kh.session_devices (
    session_id, device_id, ingest_key_enc, refresh_token_hash, refresh_expires_at
  ) VALUES (
    v_session, 'test-device-' || left(v_suffix, 8),
    '\x00'::bytea, '\x00'::bytea, now() + interval '7 days'
  );

  RETURN v_session;
END;
$$;

/** Convenience wrapper so tests read as one line. */
CREATE OR REPLACE FUNCTION kh_test.ingest(
  p_session uuid, p_points jsonb, p_offline boolean DEFAULT false
) RETURNS jsonb LANGUAGE sql AS $$
  SELECT kh.ingest_points(p_session, gen_random_uuid(), 'test-device', p_points, p_offline, NULL, 0, 0);
$$;

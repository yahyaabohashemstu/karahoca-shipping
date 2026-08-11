-- =============================================================================
-- 0001 — Extensions, schema, shared helpers
-- =============================================================================
-- Runs first. Everything KaraHoca owns lives in the `kh` schema so that PostGIS
-- and TimescaleDB internals stay out of our namespace and `pg_dump --schema=kh`
-- gives a clean application-only export.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS postgis;        -- geography(Point,4326), ST_Distance, geofences
CREATE EXTENSION IF NOT EXISTS timescaledb;    -- hypertable, compression, continuous aggregates
CREATE EXTENSION IF NOT EXISTS pgcrypto;       -- gen_random_uuid(), digest()
CREATE EXTENSION IF NOT EXISTS btree_gist;     -- exclusion constraints mixing uuid + tstzrange
CREATE EXTENSION IF NOT EXISTS citext;         -- case-insensitive e-mail / order numbers

CREATE SCHEMA IF NOT EXISTS kh;

COMMENT ON SCHEMA kh IS
  'KaraHoca shipping domain. Application objects only; extensions live in public.';

-- -----------------------------------------------------------------------------
-- Shared trigger: maintain updated_at
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION kh.touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- -----------------------------------------------------------------------------
-- Crockford Base32 claim codes.
--
-- Excludes I, L, O, U so a driver reading a code over a bad phone line cannot
-- confuse 1/I/L, 0/O, or produce accidental profanity. 8 chars from a 32-symbol
-- alphabet = 2^40 ≈ 1.1e12 combinations; combined with a short TTL and
-- rate-limited claim attempts this is comfortably unguessable.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION kh.generate_claim_code(p_len int DEFAULT 8)
RETURNS text
LANGUAGE plpgsql
VOLATILE
AS $$
DECLARE
  alphabet CONSTANT text := '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  result   text := '';
  i        int;
BEGIN
  FOR i IN 1..p_len LOOP
    -- gen_random_bytes gives us CSPRNG material; random() would not be safe here.
    result := result || substr(
      alphabet,
      (get_byte(gen_random_bytes(1), 0) % 32) + 1,
      1
    );
  END LOOP;
  RETURN result;
END;
$$;

COMMENT ON FUNCTION kh.generate_claim_code IS
  'CSPRNG Crockford Base32 code (no I/L/O/U) for driver session hand-off.';

-- -----------------------------------------------------------------------------
-- Normalise a code typed by a driver: strip separators, uppercase, and map the
-- ambiguous characters onto their Crockford equivalents.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION kh.normalize_claim_code(p_input text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT translate(
           upper(regexp_replace(coalesce(p_input, ''), '[^0-9A-Za-z]', '', 'g')),
           'ILOU',
           '1101'
         );
$$;

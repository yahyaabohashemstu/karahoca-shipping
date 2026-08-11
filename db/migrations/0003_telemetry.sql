-- =============================================================================
-- 0003 — Tracking sessions, device binding, events, and the location hypertable
-- =============================================================================

-- -----------------------------------------------------------------------------
-- tracking_sessions
--
-- The security principal (ADR-009) *and* the join point between an order and a
-- carrier *and* the denormalised live state the fleet map reads. Three roles in
-- one table is deliberate: the fleet overview must be a single index scan over
-- this table with no joins to the 450M-row hypertable.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS kh.tracking_sessions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference             text GENERATED ALWAYS AS
                          ('KH-' || upper(substr(replace(id::text, '-', ''), 1, 8))) STORED,

  order_id              uuid NOT NULL REFERENCES kh.orders(id)             ON DELETE RESTRICT,
  shipping_company_id   uuid NOT NULL REFERENCES kh.shipping_companies(id) ON DELETE RESTRICT,
  driver_id             uuid          REFERENCES kh.drivers(id)            ON DELETE SET NULL,
  vehicle_id            uuid          REFERENCES kh.vehicles(id)           ON DELETE SET NULL,

  -- Free-text fallbacks: carriers frequently swap the driver at the gate and we
  -- must not block dispatch on master-data entry.
  driver_name_snapshot  text,
  driver_phone_snapshot text,
  vehicle_plate_snapshot text,

  status                kh.session_status NOT NULL DEFAULT 'DRAFT',

  -- ---- Hand-off credentials -------------------------------------------------
  claim_code            text,                          -- NULL once claimed
  claim_code_expires_at timestamptz,
  claim_attempts        smallint NOT NULL DEFAULT 0,
  claimed_at            timestamptz,
  token_version         integer NOT NULL DEFAULT 1,    -- bump ⇒ instant revocation

  -- ---- Tracking policy pushed down to the device ----------------------------
  ping_interval_sec     smallint NOT NULL DEFAULT 10,  -- while moving
  idle_interval_sec     smallint NOT NULL DEFAULT 60,  -- while stationary
  min_distance_m        smallint NOT NULL DEFAULT 0,
  max_lifetime_hours    smallint NOT NULL DEFAULT 72,  -- hard expiry safety net

  -- ---- Lifecycle ------------------------------------------------------------
  started_at            timestamptz,
  ended_at              timestamptz,
  end_reason            text,
  expires_at            timestamptz NOT NULL DEFAULT (now() + interval '72 hours'),

  -- ---- Denormalised live state (advanced only by kh.ingest_points) ----------
  first_point_at        timestamptz,
  last_point_at         timestamptz,
  last_position         geography(Point, 4326),
  last_lat              double precision,
  last_lon              double precision,
  last_speed_mps        real,
  last_bearing_deg      real,
  last_accuracy_m       real,
  last_battery_pct      smallint,
  last_is_charging      boolean,
  last_seen_at          timestamptz,          -- last successful HTTP contact (≠ last fix)
  points_total          bigint  NOT NULL DEFAULT 0,
  points_rejected       bigint  NOT NULL DEFAULT 0,
  distance_m            double precision NOT NULL DEFAULT 0,
  max_speed_mps         real    NOT NULL DEFAULT 0,
  mock_location_count   integer NOT NULL DEFAULT 0,
  offline_batches       integer NOT NULL DEFAULT 0,
  largest_gap_sec       integer NOT NULL DEFAULT 0,

  notes                 text,
  created_by            uuid REFERENCES kh.users(id) ON DELETE SET NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ck_session_intervals CHECK (
    ping_interval_sec BETWEEN 2 AND 600 AND idle_interval_sec BETWEEN 5 AND 1800
  )
);

-- A claim code must be globally unique *while it is live*. Partial unique index
-- keeps the index tiny (only unclaimed sessions) and lets us reuse codes safely
-- after they expire.
CREATE UNIQUE INDEX IF NOT EXISTS uq_sessions_claim_code
  ON kh.tracking_sessions (claim_code)
  WHERE claim_code IS NOT NULL;

-- The fleet overview query: "everything currently moving".
CREATE INDEX IF NOT EXISTS ix_sessions_live
  ON kh.tracking_sessions (last_point_at DESC)
  WHERE status IN ('ACTIVE', 'PAUSED');

CREATE INDEX IF NOT EXISTS ix_sessions_order    ON kh.tracking_sessions (order_id);
CREATE INDEX IF NOT EXISTS ix_sessions_company  ON kh.tracking_sessions (shipping_company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_sessions_status   ON kh.tracking_sessions (status, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_sessions_expiry   ON kh.tracking_sessions (expires_at)
  WHERE status IN ('ASSIGNED', 'CLAIMED', 'ACTIVE', 'PAUSED');
CREATE INDEX IF NOT EXISTS ix_sessions_last_pos ON kh.tracking_sessions USING gist (last_position);

-- One live tracking session per order. Historical/cancelled ones may pile up.
CREATE UNIQUE INDEX IF NOT EXISTS uq_sessions_one_live_per_order
  ON kh.tracking_sessions (order_id)
  WHERE status IN ('ASSIGNED', 'CLAIMED', 'ACTIVE', 'PAUSED');

-- -----------------------------------------------------------------------------
-- session_devices — the single device bound to a session.
--
-- `ingest_key_enc` is AES-256-GCM encrypted at rest by the API (envelope key in
-- INGEST_KEY_SECRET) because HMAC verification needs the plaintext back; a hash
-- would not work. Losing the DB alone therefore does not yield forgeable keys.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS kh.session_devices (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id         uuid NOT NULL REFERENCES kh.tracking_sessions(id) ON DELETE CASCADE,
  device_id          text NOT NULL,               -- app-generated, persisted in DataStore
  device_fingerprint text,                        -- manufacturer/model/androidId digest
  manufacturer       text,
  model              text,
  os_version         text,
  sdk_int            smallint,
  app_version        text,
  app_build          integer,

  ingest_key_enc     bytea NOT NULL,              -- AES-256-GCM(nonce‖ct‖tag)
  refresh_token_hash bytea NOT NULL,
  refresh_expires_at timestamptz NOT NULL,

  battery_optimisation_ignored boolean,
  has_background_location      boolean,
  has_exact_alarm              boolean,

  bound_at           timestamptz NOT NULL DEFAULT now(),
  revoked_at         timestamptz,
  last_seen_at       timestamptz,
  last_ip            inet,

  CONSTRAINT uq_session_device UNIQUE (session_id, device_id)
);

-- Exactly one *active* device per session.
CREATE UNIQUE INDEX IF NOT EXISTS uq_session_active_device
  ON kh.session_devices (session_id)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS ix_session_devices_device ON kh.session_devices (device_id);

-- -----------------------------------------------------------------------------
-- session_events — the audit trail. This is what you show a customer who claims
-- the truck never arrived, and what you show a carrier who claims your app
-- "just stopped working".
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS kh.session_events (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id  uuid NOT NULL REFERENCES kh.tracking_sessions(id) ON DELETE CASCADE,
  type        kh.session_event_type NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),   -- device-reported when available
  recorded_at timestamptz NOT NULL DEFAULT now(),   -- server receipt
  actor       text,                                 -- 'device', 'system', user id
  position    geography(Point, 4326),
  payload     jsonb NOT NULL DEFAULT '{}'::jsonb,
  message     text
);
CREATE INDEX IF NOT EXISTS ix_session_events_session ON kh.session_events (session_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS ix_session_events_type    ON kh.session_events (type, occurred_at DESC);

-- =============================================================================
-- location_points — the hypertable
-- =============================================================================
-- Column order is deliberate: fixed-width, non-null columns first to minimise
-- per-row alignment padding. At 450M rows a wasted 8 bytes is 3.6 GB.
--
-- PRIMARY KEY (session_id, client_point_id, recorded_at)
--   • client_point_id is a device-generated ULID → the idempotency key.
--   • recorded_at must appear in every unique index on a hypertable, so it is
--     the trailing member. Retried batches collapse to ON CONFLICT DO NOTHING.
-- =============================================================================
CREATE TABLE IF NOT EXISTS kh.location_points (
  session_id           uuid        NOT NULL,
  recorded_at          timestamptz NOT NULL,          -- GPS-derived UTC (ADR-011)
  received_at          timestamptz NOT NULL DEFAULT now(),
  client_point_id      text        NOT NULL,          -- ULID, 26 chars
  lat                  double precision NOT NULL,
  lon                  double precision NOT NULL,
  position             geography(Point, 4326) NOT NULL,
  accuracy_m           real,
  altitude_m           real,
  vertical_accuracy_m  real,
  speed_mps            real,
  speed_accuracy_mps   real,
  bearing_deg          real,
  elapsed_realtime_ns  bigint,                        -- monotonic, survives clock changes
  battery_pct          smallint,
  is_charging          boolean,
  is_mock              boolean     NOT NULL DEFAULT false,
  is_backfill          boolean     NOT NULL DEFAULT false,  -- arrived after a newer point
  satellites           smallint,
  provider             text,                          -- 'fused' | 'gps' | 'network'
  network_type         text,                          -- device-side at capture time
  batch_id             uuid,                          -- upload batch, for forensics
  device_seq           bigint,                        -- monotonic per-device counter

  CONSTRAINT pk_location_points PRIMARY KEY (session_id, client_point_id, recorded_at),
  CONSTRAINT ck_lp_lat   CHECK (lat BETWEEN  -90 AND  90),
  CONSTRAINT ck_lp_lon   CHECK (lon BETWEEN -180 AND 180),
  CONSTRAINT ck_lp_speed CHECK (speed_mps IS NULL OR speed_mps BETWEEN 0 AND 200)
);

-- 7-day chunks: at peak (450M rows/yr) that is ~8.6M rows/chunk, comfortably
-- inside the "chunk should fit in 25% of RAM" guideline on a 16 GB box, and it
-- makes "show me last week" a single-chunk scan.
SELECT create_hypertable(
  'kh.location_points',
  'recorded_at',
  chunk_time_interval => INTERVAL '7 days',
  if_not_exists       => TRUE,
  migrate_data        => TRUE
);

-- The route query: "all points of session X in chronological order".
CREATE INDEX IF NOT EXISTS ix_lp_session_time
  ON kh.location_points (session_id, recorded_at DESC);

-- Forensics: "what did batch B contain".
CREATE INDEX IF NOT EXISTS ix_lp_batch
  ON kh.location_points (batch_id, recorded_at DESC)
  WHERE batch_id IS NOT NULL;

-- Fraud review: mock locations are recorded, never dropped.
CREATE INDEX IF NOT EXISTS ix_lp_mock
  ON kh.location_points (session_id, recorded_at DESC)
  WHERE is_mock;

-- Spatial index only over recent data would be ideal, but partial GiST on a
-- hypertable is per-chunk anyway — Timescale prunes chunks by time first, so a
-- plain GiST is effectively "recent only" for any time-bounded query.
CREATE INDEX IF NOT EXISTS ix_lp_position
  ON kh.location_points USING gist (position);

COMMENT ON TABLE kh.location_points IS
  'Append-only GPS telemetry. Never UPDATEd. Idempotent on (session_id, client_point_id, recorded_at).';

-- -----------------------------------------------------------------------------
-- ingest_batches — one row per accepted upload. Lets us answer "the driver says
-- he had signal at 14:00, did we receive anything?" without scanning telemetry.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS kh.ingest_batches (
  id              uuid PRIMARY KEY,
  session_id      uuid NOT NULL REFERENCES kh.tracking_sessions(id) ON DELETE CASCADE,
  device_id       text,
  received_at     timestamptz NOT NULL DEFAULT now(),
  point_count     integer NOT NULL,
  accepted_count  integer NOT NULL,
  duplicate_count integer NOT NULL,
  rejected_count  integer NOT NULL,
  oldest_point_at timestamptz,
  newest_point_at timestamptz,
  lag_sec         integer,          -- received_at − newest_point_at
  is_offline_sync boolean NOT NULL DEFAULT false,
  body_bytes      integer,
  duration_ms     integer,
  client_ip       inet
);
CREATE INDEX IF NOT EXISTS ix_ingest_batches_session ON kh.ingest_batches (session_id, received_at DESC);

-- -----------------------------------------------------------------------------
-- updated_at trigger
-- -----------------------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_tracking_sessions_touch ON kh.tracking_sessions;
CREATE TRIGGER trg_tracking_sessions_touch
  BEFORE UPDATE ON kh.tracking_sessions
  FOR EACH ROW EXECUTE FUNCTION kh.touch_updated_at();

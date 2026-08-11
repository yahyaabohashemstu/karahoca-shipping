-- =============================================================================
-- 0002 — Core business entities
--   users → customers → shipping_companies → drivers/vehicles → orders
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Enumerations
-- -----------------------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE kh.user_role AS ENUM ('ADMIN', 'DISPATCHER', 'VIEWER');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE kh.order_status AS ENUM (
    'PENDING',      -- created in ERP, not yet handed to a carrier
    'DISPATCHED',   -- loaded, carrier assigned
    'IN_TRANSIT',   -- tracking session active
    'DELIVERED',
    'CANCELLED'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE kh.session_status AS ENUM (
    'DRAFT',      -- dispatcher is still filling it in
    'ASSIGNED',   -- claim code issued, waiting for a driver
    'CLAIMED',    -- a device has bound itself; tracking not started
    'ACTIVE',     -- driver pressed Start; points are flowing
    'PAUSED',     -- driver paused (break, overnight stop)
    'COMPLETED',  -- delivered / closed by dispatcher or geofence
    'CANCELLED',  -- aborted
    'EXPIRED'     -- claim code TTL elapsed, or session exceeded max lifetime
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE kh.session_event_type AS ENUM (
    'CREATED', 'CLAIMED', 'STARTED', 'PAUSED', 'RESUMED', 'COMPLETED',
    'CANCELLED', 'EXPIRED', 'REVOKED',
    'GPS_LOST', 'GPS_RECOVERED',
    'NETWORK_LOST', 'NETWORK_RECOVERED', 'OFFLINE_BATCH_SYNCED',
    'BUFFER_OVERFLOW', 'MOCK_LOCATION_DETECTED', 'PERMISSION_REVOKED',
    'BATTERY_LOW', 'SERVICE_KILLED', 'SERVICE_RESTORED',
    'GEOFENCE_ENTER', 'GEOFENCE_EXIT',
    'DEVICE_REBOUND', 'NOTE'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE kh.geofence_kind AS ENUM ('FACTORY', 'DESTINATION', 'DEPOT', 'RESTRICTED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- -----------------------------------------------------------------------------
-- users — KaraHoca staff only. Drivers never get an account (see ADR-009).
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS kh.users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email          citext NOT NULL UNIQUE,
  full_name      text   NOT NULL,
  password_hash  text   NOT NULL,             -- Argon2id
  role           kh.user_role NOT NULL DEFAULT 'DISPATCHER',
  totp_secret    text,                        -- NULL = 2FA disabled
  is_active      boolean NOT NULL DEFAULT true,
  last_login_at  timestamptz,
  failed_logins  smallint NOT NULL DEFAULT 0,
  locked_until   timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS kh.refresh_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES kh.users(id) ON DELETE CASCADE,
  token_hash  bytea NOT NULL UNIQUE,          -- sha256 of the opaque token
  family_id   uuid NOT NULL,                  -- rotation family; reuse ⇒ revoke family
  user_agent  text,
  ip          inet,
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_refresh_tokens_user   ON kh.refresh_tokens (user_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_refresh_tokens_family ON kh.refresh_tokens (family_id);

-- -----------------------------------------------------------------------------
-- customers — who receives the detergent
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS kh.customers (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code           citext NOT NULL UNIQUE,       -- ERP customer code
  name           text   NOT NULL,
  contact_name   text,
  contact_phone  text,
  contact_email  citext,
  address_line   text,
  city           text,
  region         text,
  country_code   char(2) NOT NULL DEFAULT 'TR',
  location       geography(Point, 4326),       -- default delivery point
  notes          text,
  is_active      boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_customers_location ON kh.customers USING gist (location);
CREATE INDEX IF NOT EXISTS ix_customers_name_trgm ON kh.customers (lower(name));

-- -----------------------------------------------------------------------------
-- shipping_companies — the third-party carriers
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS kh.shipping_companies (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code              citext NOT NULL UNIQUE,
  name              text   NOT NULL,
  tax_number        text,
  contact_name      text,
  contact_phone     text,
  contact_email     citext,
  -- Operational contract terms we score carriers against
  sla_hours         numeric(6,2),
  is_active         boolean NOT NULL DEFAULT true,
  -- Rolling performance counters, refreshed by the metrics job
  total_shipments   integer NOT NULL DEFAULT 0,
  on_time_shipments integer NOT NULL DEFAULT 0,
  notes             text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- -----------------------------------------------------------------------------
-- vehicles / drivers — thin records owned by the carrier, not by us.
-- We keep the minimum needed to identify a truck on the map and phone a driver.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS kh.vehicles (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shipping_company_id uuid NOT NULL REFERENCES kh.shipping_companies(id) ON DELETE CASCADE,
  plate               citext NOT NULL,
  make_model          text,
  capacity_kg         integer,
  is_active           boolean NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_vehicle_plate_per_company UNIQUE (shipping_company_id, plate)
);

CREATE TABLE IF NOT EXISTS kh.drivers (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shipping_company_id uuid NOT NULL REFERENCES kh.shipping_companies(id) ON DELETE CASCADE,
  full_name           text NOT NULL,
  phone               text NOT NULL,
  national_id_last4   char(4),          -- deliberately partial: identification, not PII hoarding
  is_active           boolean NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_driver_phone_per_company UNIQUE (shipping_company_id, phone)
);

-- -----------------------------------------------------------------------------
-- orders — the shipment of detergent being tracked
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS kh.orders (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_number          citext NOT NULL UNIQUE,        -- ERP document number
  customer_id           uuid NOT NULL REFERENCES kh.customers(id) ON DELETE RESTRICT,
  status                kh.order_status NOT NULL DEFAULT 'PENDING',

  -- Where it is going (snapshotted from the customer at dispatch time so a later
  -- customer address change never rewrites the history of a completed delivery)
  destination_label     text,
  destination_address   text,
  destination           geography(Point, 4326),
  destination_radius_m  integer NOT NULL DEFAULT 300,  -- arrival geofence radius

  -- Cargo
  total_weight_kg       numeric(10,2),
  pallet_count          integer,
  cargo_summary         text,                          -- e.g. "12 pal. KaraFresh 5 L"

  planned_dispatch_at   timestamptz,
  planned_delivery_at   timestamptz,
  dispatched_at         timestamptz,
  delivered_at          timestamptz,

  external_ref          jsonb NOT NULL DEFAULT '{}'::jsonb,  -- ERP passthrough
  created_by            uuid REFERENCES kh.users(id) ON DELETE SET NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ck_orders_radius CHECK (destination_radius_m BETWEEN 25 AND 20000)
);
CREATE INDEX IF NOT EXISTS ix_orders_customer     ON kh.orders (customer_id);
CREATE INDEX IF NOT EXISTS ix_orders_status       ON kh.orders (status) WHERE status <> 'DELIVERED';
CREATE INDEX IF NOT EXISTS ix_orders_destination  ON kh.orders USING gist (destination);
CREATE INDEX IF NOT EXISTS ix_orders_created      ON kh.orders (created_at DESC);

CREATE TABLE IF NOT EXISTS kh.order_items (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id     uuid NOT NULL REFERENCES kh.orders(id) ON DELETE CASCADE,
  sku          citext NOT NULL,
  description  text,
  quantity     numeric(12,3) NOT NULL,
  unit         text NOT NULL DEFAULT 'PCS',
  weight_kg    numeric(10,3)
);
CREATE INDEX IF NOT EXISTS ix_order_items_order ON kh.order_items (order_id);

-- -----------------------------------------------------------------------------
-- geofences — factory gates, customer yards, restricted zones.
-- Polygons, not just radii, because a customer yard is rarely a circle.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS kh.geofences (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL,
  kind         kh.geofence_kind NOT NULL DEFAULT 'DESTINATION',
  customer_id  uuid REFERENCES kh.customers(id) ON DELETE CASCADE,
  area         geography(Polygon, 4326) NOT NULL,
  dwell_sec    integer NOT NULL DEFAULT 120,   -- must stay this long to count as "arrived"
  is_active    boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_geofences_area ON kh.geofences USING gist (area);

-- -----------------------------------------------------------------------------
-- updated_at triggers
-- -----------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'users', 'customers', 'shipping_companies', 'vehicles',
    'drivers', 'orders', 'geofences'
  ] LOOP
    EXECUTE format(
      'DROP TRIGGER IF EXISTS trg_%1$s_touch ON kh.%1$s;
       CREATE TRIGGER trg_%1$s_touch BEFORE UPDATE ON kh.%1$s
       FOR EACH ROW EXECUTE FUNCTION kh.touch_updated_at();', t);
  END LOOP;
END $$;

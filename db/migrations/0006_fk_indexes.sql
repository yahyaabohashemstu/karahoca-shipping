-- =============================================================================
-- 0006 — index the five foreign keys that had no supporting index
-- =============================================================================
-- Found by querying pg_constraint against pg_index on the live database rather
-- than by reading the schema: five FK columns had no index whose leading column
-- matched them.
--
--   kh.orders.created_by                -> kh.users(id)
--   kh.geofences.customer_id            -> kh.customers(id)
--   kh.tracking_sessions.driver_id      -> kh.drivers(id)
--   kh.tracking_sessions.vehicle_id     -> kh.vehicles(id)
--   kh.tracking_sessions.created_by     -> kh.users(id)
--
-- The three on tracking_sessions are the ones that matter. It is the busiest
-- table in the schema and the parent of every telemetry row, so a scan of it
-- while holding a lock is the worst version of this problem.
--
-- PostgreSQL indexes the *referenced* side automatically (it must, to enforce
-- the constraint) but never the referencing side. Without an index there,
-- every DELETE or key UPDATE on the parent has to sequentially scan the child
-- to find rows to cascade or null out — while holding a lock that blocks
-- concurrent writes to it.
--
-- Today both child tables are tiny and the scan is free. That is exactly why
-- this is worth fixing now: the cost of the index is a few kilobytes, and the
-- alternative is discovering it the first time someone deactivates a dispatcher
-- account on a table with a year of orders in it.
--
-- Deliberately NOT added: anything else. Index usage statistics on this
-- database are uniformly zero because it holds one session and no telemetry,
-- so any further index would be a guess dressed up as an optimisation. Revisit
-- with pg_stat_user_indexes after a month of real shipments.
-- =============================================================================

CREATE INDEX IF NOT EXISTS ix_orders_created_by
  ON kh.orders (created_by)
  WHERE created_by IS NOT NULL;

CREATE INDEX IF NOT EXISTS ix_geofences_customer
  ON kh.geofences (customer_id)
  WHERE customer_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS ix_sessions_driver
  ON kh.tracking_sessions (driver_id)
  WHERE driver_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS ix_sessions_vehicle
  ON kh.tracking_sessions (vehicle_id)
  WHERE vehicle_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS ix_sessions_created_by
  ON kh.tracking_sessions (created_by)
  WHERE created_by IS NOT NULL;

-- Every one is partial. All five columns are nullable and frequently null: a
-- session created before the driver is known at the gate has no driver_id, an
-- order imported from the ERP has no created_by, and a geofence attached to no
-- customer is a factory gate. Excluding those rows keeps each index to the
-- entries a cascade would actually have to visit — and a partial index on a
-- mostly-null column is a fraction of the size of the full one.
--
-- These also serve reads the dashboard is about to start making: "which
-- sessions has this vehicle run" and "which sessions has this driver run" are
-- the natural next screens once carriers have vehicles and drivers on file.

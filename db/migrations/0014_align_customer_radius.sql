-- =============================================================================
-- 0014 — one radius range, not two
-- =============================================================================
-- 0013 gave kh.customers.default_radius_m a CHECK of 50..50000, chosen on its
-- own merits. kh.orders.destination_radius_m has carried 25..20000 since 0002.
--
-- The two are not independent: the order form inherits the consignee's default
-- the moment a customer is chosen. So a perfectly valid customer radius of
-- 30 km produces an order the database refuses, and the dispatcher sees the
-- failure on a screen that has nothing to do with the number they set.
--
-- The order column is the consumer and the narrower of the two, so it wins.
-- =============================================================================

ALTER TABLE kh.customers DROP CONSTRAINT IF EXISTS ck_customers_default_radius;

-- Nothing to migrate: measured before writing this, no customer has a radius at
-- all. Written as a clamp rather than a bare ALTER anyway, because the column
-- may hold values by the time this reaches another environment.
UPDATE kh.customers SET default_radius_m = 20000 WHERE default_radius_m > 20000;
UPDATE kh.customers SET default_radius_m = 25    WHERE default_radius_m < 25;

ALTER TABLE kh.customers
  ADD CONSTRAINT ck_customers_default_radius
  CHECK (default_radius_m IS NULL OR default_radius_m BETWEEN 25 AND 20000);

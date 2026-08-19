-- =============================================================================
-- 0013 — the customer's own delivery point, made usable
-- =============================================================================
-- kh.customers.location has existed since 0002, commented "default delivery
-- point", and nothing has ever read it.
--
-- CORRECTION, added after the fact. This header first claimed "3 customers, 0
-- with a location", stated as a measurement. It was not one — the query that
-- would have produced it errored on an enum cast and the figure was assumed
-- from the absence of any UI. Read properly afterwards, production holds:
--
--     IRQ        altunsa, Kirkuk    IQ   delivery point SET   3 orders
--     DE-HAM-01  Hamburg Handels    DE   none                 0 orders
--     TEST-001   Saha Denemesi      TR   none                 1 order
--
-- So the only real consignee already had a delivery point, set at creation on
-- 12 August. The argument for this migration is not weakened by that, it is
-- sharpened: altunsa's point existed and three of their four orders were still
-- created with no destination, because nothing inherited it. 4 orders, 1 with a
-- destination — that half was measured and is accurate.
--
-- That single empty column is what gates the most valuable half of this product.
-- Without a destination there is no distance remaining, no arrival radius, so
-- kh.alerts can never raise ARRIVED, the consignee's page cannot show the one
-- number they opened it for, and an ETA is not arithmetic that exists. Three
-- shipments in four are in that state.
--
-- The cause is not that anyone disagrees the field matters — the order form
-- already warns, in a yellow box, exactly what is lost by leaving it blank. The
-- cause is that supplying it means leaving the application, finding a warehouse
-- in Erbil on someone else's map, copying two decimal numbers, and coming back.
-- Nobody does that four times a day, and the warning does not change the cost.
--
-- So the point moves to where it is stable. A consignee receives at the same
-- gate every time; the coordinate belongs to the customer, not to the order,
-- and asking for it once per customer instead of once per shipment turns a
-- recurring chore into a single setup step.
--
-- This migration adds the one thing the customers table was missing to serve
-- that role — the radius — because a point without one cannot answer "has it
-- arrived", and a city depot gate and a quarry weighbridge are two orders of
-- magnitude apart.
-- =============================================================================

ALTER TABLE kh.customers
  ADD COLUMN IF NOT EXISTS default_radius_m integer;

-- The same bounds kh.orders.destination_radius_m carries, for the same reason:
-- a radius of 5 m never fires and a radius of 100 km fires in Adana.
DO $$ BEGIN
  ALTER TABLE kh.customers
    ADD CONSTRAINT ck_customers_default_radius
    CHECK (default_radius_m IS NULL OR default_radius_m BETWEEN 50 AND 50000);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

COMMENT ON COLUMN kh.customers.location IS
  'Default delivery point. Inherited by new orders for this customer, and '
  'overridable per order — a one-off delivery to a different site is a normal '
  'thing to want and must not require editing the customer.';

COMMENT ON COLUMN kh.customers.default_radius_m IS
  'Arrival radius in metres for the default delivery point. NULL means the '
  'order-level default (300 m) applies.';

-- Partial, because the interesting query is "which consignees can we actually
-- detect an arrival for", and the answer is a small subset that will stay small.
CREATE INDEX IF NOT EXISTS ix_customers_with_location
  ON kh.customers (id) WHERE location IS NOT NULL;

-- =============================================================================
-- 0008 — The exception desk, and letting the consignee see their own shipment
-- =============================================================================
--
-- Two tables that close the two structural holes in this system.
--
-- 1. NOTHING THE SYSTEM DETECTS EVER REACHES A HUMAN WHO IS NOT ALREADY
--    LOOKING AT IT.
--
--    The detectors work. `kh.detect_arrivals` and the silence job have between
--    them written 74 GPS_LOST rows into kh.session_events — 74 times a truck
--    went quiet for a quarter of an hour. Every one of them was published to
--    the Socket.IO room `session:<id>` and nowhere else, so it reached only a
--    dispatcher who already had that exact truck's detail page open. Nobody
--    has that page open at 02:00 on the Habur road.
--
--    kh.session_events is an append-only audit log and is the wrong shape for
--    this: it has no severity, no open/closed state, no acknowledgement, and
--    no way to ask "what is wrong right now". Alerts are a different thing
--    from history. They have a lifecycle — raised, resolved by the world,
--    acknowledged by a person — and exactly one of each kind may be open per
--    session at a time.
--
-- 2. THE CONSIGNEE HAS NO WAY TO SEE ANYTHING, SO THEY PHONE.
--
--    There is no customer-facing surface and no credential that could grant
--    one. The only unauthenticated page in the system is the driver's claim
--    page, and handing that to a customer hands them the claim code. A share
--    link is a capability: one opaque token, one session, an expiry, and a
--    revoke — stored hashed, exactly like kh.refresh_tokens, so a database
--    leak does not hand out live tracking links.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Alerts
-- -----------------------------------------------------------------------------

DO $$ BEGIN
  CREATE TYPE kh.alert_kind AS ENUM (
    'SIGNAL_LOST',        -- no fix for longer than the session's own tolerance
    'ARRIVED',            -- inside the destination radius
    'BATTERY_LOW',        -- the phone will die before the shipment lands
    'MOCK_LOCATION',      -- the position stream is being faked
    'NOT_STARTED',        -- code handed over, tracking never began
    'STOPPED_TOO_LONG'    -- stationary far from the destination
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  -- CRITICAL is reserved for "this shipment is in trouble now". If everything
  -- is critical the badge stops being read, which is the failure mode of every
  -- alerting system that has ever been switched off.
  CREATE TYPE kh.alert_severity AS ENUM ('INFO', 'WARNING', 'CRITICAL');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS kh.alerts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id      uuid NOT NULL REFERENCES kh.tracking_sessions(id) ON DELETE CASCADE,
  order_id        uuid REFERENCES kh.orders(id) ON DELETE SET NULL,

  kind            kh.alert_kind     NOT NULL,
  severity        kh.alert_severity NOT NULL DEFAULT 'WARNING',

  -- Written by the detector in Turkish, ready to display. Formatting an alert
  -- at read time means every consumer — dashboard, e-mail, a future webhook —
  -- reimplements the same sentence and they drift apart.
  title           text NOT NULL,
  detail          text,
  payload         jsonb NOT NULL DEFAULT '{}'::jsonb,

  raised_at       timestamptz NOT NULL DEFAULT now(),

  -- Resolved BY THE WORLD: the signal came back, the truck arrived. Distinct
  -- from acknowledged, which means a person looked. An alert that resolves
  -- itself unacknowledged is still worth showing in the day's history — that
  -- is how you find the truck that went dark six times on one run.
  resolved_at     timestamptz,
  acknowledged_at timestamptz,
  acknowledged_by uuid REFERENCES kh.users(id) ON DELETE SET NULL,

  CONSTRAINT ck_alerts_ack_pair CHECK (
    (acknowledged_at IS NULL) = (acknowledged_by IS NULL)
  )
);

-- At most one OPEN alert of a kind per session. This is what stops a detector
-- on a five-minute cron from writing 288 identical rows a day: it upserts
-- against this index, so a truck that is silent for six hours is one alert
-- that stays open, not a wall of them.
CREATE UNIQUE INDEX IF NOT EXISTS ux_alerts_open_per_kind
  ON kh.alerts (session_id, kind) WHERE resolved_at IS NULL;

-- The dashboard's only hot query: what is wrong right now, worst first.
CREATE INDEX IF NOT EXISTS ix_alerts_open
  ON kh.alerts (severity DESC, raised_at DESC) WHERE resolved_at IS NULL;

-- The badge count, and the "needs a human" filter.
CREATE INDEX IF NOT EXISTS ix_alerts_unacknowledged
  ON kh.alerts (raised_at DESC) WHERE acknowledged_at IS NULL;

CREATE INDEX IF NOT EXISTS ix_alerts_session ON kh.alerts (session_id, raised_at DESC);

COMMENT ON TABLE kh.alerts IS
  'Operational exceptions with a lifecycle. kh.session_events is the audit log '
  'and answers "what happened"; this answers "what is wrong now, and has '
  'anyone looked". One open row per (session, kind) is enforced by index.';

-- -----------------------------------------------------------------------------
-- Raise / resolve, as functions so every detector behaves identically
-- -----------------------------------------------------------------------------

-- Returns the alert id when a NEW alert was opened, NULL when one was already
-- open. Callers use that to decide whether to publish a notification — the
-- distinction between "this just happened" and "this is still happening" is
-- the whole difference between an alert system and a nuisance.
CREATE OR REPLACE FUNCTION kh.raise_alert(
  p_session_id uuid,
  p_kind       kh.alert_kind,
  p_severity   kh.alert_severity,
  p_title      text,
  p_detail     text DEFAULT NULL,
  p_payload    jsonb DEFAULT '{}'::jsonb
) RETURNS uuid
LANGUAGE plpgsql
AS $$
DECLARE
  v_id       uuid;
  v_order_id uuid;
BEGIN
  SELECT order_id INTO v_order_id FROM kh.tracking_sessions WHERE id = p_session_id;

  INSERT INTO kh.alerts (session_id, order_id, kind, severity, title, detail, payload)
  VALUES (p_session_id, v_order_id, p_kind, p_severity, p_title, p_detail, p_payload)
  ON CONFLICT (session_id, kind) WHERE resolved_at IS NULL
  DO NOTHING
  RETURNING id INTO v_id;

  RETURN v_id;   -- NULL when an identical alert was already open
END;
$$;

CREATE OR REPLACE FUNCTION kh.resolve_alert(
  p_session_id uuid,
  p_kind       kh.alert_kind
) RETURNS uuid
LANGUAGE sql
AS $$
  UPDATE kh.alerts
     SET resolved_at = now()
   WHERE session_id = p_session_id
     AND kind = p_kind
     AND resolved_at IS NULL
  RETURNING id;
$$;

-- -----------------------------------------------------------------------------
-- Consignee share links
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS kh.share_links (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id     uuid NOT NULL REFERENCES kh.tracking_sessions(id) ON DELETE CASCADE,

  -- sha256 of the opaque token, never the token. Same rule as
  -- kh.refresh_tokens: a dump of this table must not yield working links to a
  -- customer's shipment positions.
  token_hash     bytea NOT NULL UNIQUE,

  -- What the holder is allowed to see. Deliberately coarse and deliberately
  -- default-off for the route: a consignee is entitled to know where their
  -- goods are, not to a minute-by-minute movement log of a third party's
  -- driver, which in several jurisdictions is personal data.
  show_route     boolean NOT NULL DEFAULT false,
  show_driver    boolean NOT NULL DEFAULT false,

  label          text,
  created_by     uuid REFERENCES kh.users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,
  revoked_at     timestamptz,

  -- So a dispatcher can tell whether the customer ever opened it, which is the
  -- difference between "they know" and "they are about to phone".
  last_viewed_at timestamptz,
  view_count     integer NOT NULL DEFAULT 0,

  CONSTRAINT ck_share_expiry CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS ix_share_links_session
  ON kh.share_links (session_id, created_at DESC);

-- The public lookup path: hash, then this index, then the expiry and revoke
-- checks. Partial so revoked links fall out of the index entirely.
CREATE INDEX IF NOT EXISTS ix_share_links_live
  ON kh.share_links (token_hash) WHERE revoked_at IS NULL;

COMMENT ON TABLE kh.share_links IS
  'Capability tokens handing one tracking session to a consignee. Hashed at '
  'rest, always expiring, revocable, and scoped so the default view shows '
  'position and status without the driver identity or the full route trace.';

-- -----------------------------------------------------------------------------
-- IN_TRANSIT: an order status that existed in the enum and in the dashboard's
-- filter dropdown, and was never once assigned by any code — so "Yolda" has
-- always returned an empty list.
--
-- The session already knows. This makes the order follow it.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION kh.sync_order_status_from_session()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.order_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Only ever forward, and only out of a pre-transit state. A dispatcher who
  -- has already marked the order DELIVERED or CANCELLED outranks anything a
  -- phone reports, and an order that is already IN_TRANSIT must not be
  -- re-stamped by a second session on the same load.
  --
  -- Deliberately does NOT set DELIVERED on session completion: a session ends
  -- when the driver stops tracking, which is not the same event as the goods
  -- being accepted. That stays a human decision until there is a proof of
  -- delivery to hang it on.
  IF NEW.status = 'ACTIVE' AND (OLD.status IS DISTINCT FROM 'ACTIVE') THEN
    UPDATE kh.orders
       SET status = 'IN_TRANSIT', updated_at = now()
     WHERE id = NEW.order_id
       AND status IN ('PENDING', 'DISPATCHED');
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_session_syncs_order_status ON kh.tracking_sessions;
CREATE TRIGGER trg_session_syncs_order_status
  AFTER UPDATE OF status ON kh.tracking_sessions
  FOR EACH ROW
  EXECUTE FUNCTION kh.sync_order_status_from_session();

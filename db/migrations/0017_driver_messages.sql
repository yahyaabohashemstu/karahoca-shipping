-- =============================================================================
-- 0017 — a message from the desk to the driver of one shipment
-- =============================================================================
-- Until now the only way to tell a driver anything was to telephone them, and
-- the number on the session is whatever the carrier wrote down at the gate. A
-- driver on a mountain road does not pick up, and "unload at gate 3, not 1" is
-- not something anybody wants to say twice down a bad line.
--
-- One row per message, addressed to a SESSION rather than to a phone or a
-- person. A session is the order plus whichever device is carrying it, which is
-- exactly the recipient a dispatcher means: "the lorry taking SO-2026-0418".
-- If the claim code is regenerated and a second phone takes over, messages not
-- yet delivered go to the phone that holds the session now, which is what the
-- dispatcher would want; ones already delivered stay delivered.
--
-- Three timestamps, because "did they get it?" has three different answers:
--
--   sent_at       the dispatcher pressed Send
--   delivered_at  the phone fetched it and said so — the notification is up
--   read_at       the driver pressed "read" on it, in the app or on the
--                 notification itself
--
-- The phone fetches on a hint carried by the ingest response, so a tracking
-- phone hears about a message within one upload cycle; a phone that is not
-- tracking hears about it from its fifteen-minute sync worker, or when the
-- driver opens the app.
--
-- read_at may be supplied by the device: a driver can read a message in a
-- tunnel and the receipt then arrives an hour later, and the hour is the
-- dispatcher's question. The API clamps it between sent_at and now().
-- =============================================================================

CREATE TABLE IF NOT EXISTS kh.driver_messages (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id    uuid NOT NULL REFERENCES kh.tracking_sessions(id) ON DELETE CASCADE,
  body          text NOT NULL,
  sent_by       uuid REFERENCES kh.users(id) ON DELETE SET NULL,
  sent_at       timestamptz NOT NULL DEFAULT now(),
  delivered_at  timestamptz,
  -- Which phone confirmed it. A session can change device mid-run, and "it
  -- was delivered" is only useful if you can tell which handset it reached.
  delivered_to  text,
  read_at       timestamptz,

  -- 500 characters is two screens of a notification shade. Anything longer is
  -- a document, and a driver reading it at a fuel stop deserves a phone call.
  CONSTRAINT ck_driver_messages_body
    CHECK (char_length(btrim(body)) BETWEEN 1 AND 500),
  -- A read receipt without a delivery would mean the driver read something
  -- their phone never received. The API sets both together; this makes sure.
  CONSTRAINT ck_driver_messages_read_after_delivery
    CHECK (read_at IS NULL OR delivered_at IS NOT NULL)
);

-- The dashboard's thread and the phone's fetch: newest first, per session.
CREATE INDEX IF NOT EXISTS ix_driver_messages_session
  ON kh.driver_messages (session_id, sent_at DESC);

-- The ingest hint counts these. Partial, because once delivered a row is never
-- counted again, and this keeps the index to the handful that are in flight.
CREATE INDEX IF NOT EXISTS ix_driver_messages_undelivered
  ON kh.driver_messages (session_id)
  WHERE delivered_at IS NULL;

-- The foreign key to users, indexed for the reason 0006 gives: deactivating a
-- dispatcher must not sequentially scan a year of messages under a lock.
CREATE INDEX IF NOT EXISTS ix_driver_messages_sent_by
  ON kh.driver_messages (sent_by)
  WHERE sent_by IS NOT NULL;

COMMENT ON TABLE kh.driver_messages IS
  'Dispatcher-to-driver messages, one row per message, addressed to a tracking '
  'session. Delivered and read receipts come back from the phone.';

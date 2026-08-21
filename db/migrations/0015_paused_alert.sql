-- migrate:no-transaction
-- ============================================================================
-- 0015 — an alert for a shipment the driver stopped and nobody noticed
-- ============================================================================
-- SIGNAL_LOST is raised only for sessions in status ACTIVE. A driver who taps
-- "Durdur" — in the app, or on the ongoing notification, which is reachable
-- from the lock screen without unlocking — moves the session to PAUSED, and a
-- PAUSED session was watched by nothing at all.
--
-- So the most likely way to lose a truck was also the only one that raised
-- nothing: one stray tap and the shipment went dark in silence, leaving a
-- status chip on a dashboard that somebody had to happen to look at.
--
-- no-transaction because ALTER TYPE ... ADD VALUE cannot be used by a statement
-- in the same transaction that added it. Nothing here uses the value, so this
-- is belt and braces — but the next migration that does reference it would fail
-- confusingly, and the directive costs nothing.
-- ============================================================================

ALTER TYPE kh.alert_kind ADD VALUE IF NOT EXISTS 'PAUSED_TOO_LONG';

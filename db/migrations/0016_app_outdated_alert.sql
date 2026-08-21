-- migrate:no-transaction
-- ============================================================================
-- 0016 — an alert for a lorry running a build we have already replaced
-- ============================================================================
-- Nothing watched this. A shipment could run a whole shift on a version with a
-- known crash in it — the reboot crash fixed in 1.4.0 is the obvious example,
-- where a phone that restarted mid-run came back tracking nothing — and the
-- dispatcher had no way to know except by opening the session and reading a
-- version string that the dashboard did not render either.
--
-- Deliberately not CRITICAL when raised. The truck is being tracked; it is
-- being tracked by software we would rather it were not. That is a fleet
-- hygiene problem a dispatcher can act on between calls, not an emergency, and
-- CRITICAL only keeps its meaning while it is reserved.
--
-- no-transaction for the same reason as 0015: ALTER TYPE ... ADD VALUE cannot
-- be used by a statement inside the transaction that added it.
-- ============================================================================

ALTER TYPE kh.alert_kind ADD VALUE IF NOT EXISTS 'APP_OUTDATED';

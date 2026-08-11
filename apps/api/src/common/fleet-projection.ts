/**
 * The single camelCase projection of `kh.v_live_fleet`.
 *
 * The view exposes snake_case columns, but every JSON consumer — the dashboard,
 * the driver app, the e2e suite — expects camelCase. Two endpoints used to
 * alias these independently: `/tracking/live` spelled them out, while
 * `/sessions` did `SELECT f.*`. The result was that the Sessions page rendered
 * blank columns and linked to `/sessions/undefined`, because `session.sessionId`
 * did not exist on a row that only had `session_id`.
 *
 * Defining the projection once means the two can no longer drift.
 */
export const FLEET_COLUMNS = `
  f.session_id            AS "sessionId",
  f.reference,
  f.status::text          AS status,
  f.last_lat              AS lat,
  f.last_lon              AS lon,
  f.last_speed_mps        AS "speedMps",
  f.last_bearing_deg      AS "bearingDeg",
  f.last_accuracy_m       AS "accuracyM",
  f.last_battery_pct      AS "batteryPct",
  f.last_is_charging      AS "isCharging",
  f.last_point_at         AS "recordedAt",
  f.last_seen_at          AS "lastSeenAt",
  f.points_total          AS "pointsTotal",
  f.distance_km           AS "distanceKm",
  f.started_at            AS "startedAt",
  f.mock_location_count   AS "mockLocationCount",
  f.largest_gap_sec       AS "largestGapSec",
  f.signal_state          AS "signalState",
  f.seconds_since_fix     AS "secondsSinceFix",
  f.order_id              AS "orderId",
  f.order_number::text    AS "orderNumber",
  f.order_status::text    AS "orderStatus",
  f.destination_label     AS "destinationLabel",
  f.destination_lat       AS "destinationLat",
  f.destination_lon       AS "destinationLon",
  f.planned_delivery_at   AS "plannedDeliveryAt",
  f.remaining_km          AS "remainingKm",
  f.customer_id           AS "customerId",
  f.customer_name         AS "customerName",
  f.customer_city         AS "customerCity",
  f.shipping_company_id   AS "shippingCompanyId",
  f.shipping_company_name AS "carrierName",
  f.driver_name           AS "driverName",
  f.driver_phone          AS "driverPhone",
  f.vehicle_plate         AS "vehiclePlate"
`;

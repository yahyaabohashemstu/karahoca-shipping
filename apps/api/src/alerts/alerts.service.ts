import { Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { RealtimePublisher } from '../realtime/realtime.publisher';
import type { AlertCountQueryDto, ListAlertsQueryDto } from './dto';

/**
 * Everything the exception desk renders for one row, in one projection.
 *
 * The session context is joined in rather than left to the client because the
 * alert on its own is unactionable: "Sinyal kesildi" without a plate, a driver's
 * phone number and an order number is a row you have to click before you can do
 * anything about it. A dispatcher working a list of twelve exceptions at 02:00
 * must not need twelve follow-up requests to know who to ring.
 *
 * Defined once, as FLEET_COLUMNS is, so the list and the single-row read after
 * an acknowledgement can never drift into returning different shapes.
 */
const ALERT_COLUMNS = `
  a.id,
  a.kind::text            AS kind,
  a.severity::text        AS severity,
  a.title,
  a.detail,
  a.payload,
  a.raised_at             AS "raisedAt",
  a.resolved_at           AS "resolvedAt",
  a.acknowledged_at       AS "acknowledgedAt",
  a.acknowledged_by       AS "acknowledgedBy",
  u.full_name             AS "acknowledgedByName",

  a.session_id            AS "sessionId",
  f.reference             AS "sessionReference",
  f.status::text          AS "sessionStatus",
  f.last_lat              AS lat,
  f.last_lon              AS lon,
  f.last_point_at         AS "lastPointAt",
  f.signal_state          AS "signalState",
  f.seconds_since_fix     AS "secondsSinceFix",
  f.last_battery_pct      AS "batteryPct",
  f.last_is_charging      AS "isCharging",

  a.order_id              AS "orderId",
  f.order_number::text    AS "orderNumber",
  f.order_status::text    AS "orderStatus",
  f.destination_label     AS "destinationLabel",
  f.remaining_km          AS "remainingKm",
  f.planned_delivery_at   AS "plannedDeliveryAt",

  f.customer_name         AS "customerName",
  f.customer_city         AS "customerCity",
  f.shipping_company_name AS "carrierName",
  f.driver_name           AS "driverName",
  f.driver_phone          AS "driverPhone",
  f.vehicle_plate         AS "vehiclePlate"
`;

/*
 * An inner join, not a left join: kh.alerts.session_id is NOT NULL and
 * kh.v_live_fleet's own joins run through NOT NULL columns with ON DELETE
 * RESTRICT behind them, so every alert has exactly one row here. If that ever
 * stops being true we want the count to change visibly rather than to serve
 * alerts with an empty truck attached.
 */
const ALERT_SOURCE = `
  FROM kh.alerts a
  JOIN kh.v_live_fleet f ON f.session_id = a.session_id
  LEFT JOIN kh.users u   ON u.id = a.acknowledged_by
`;

/** Recently-resolved window applied when the caller does not choose one. */
const DEFAULT_RESOLVED_WINDOW_HOURS = 24;

@Injectable()
export class AlertsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly publisher: RealtimePublisher,
  ) {}

  async list(query: ListAlertsQueryDto) {
    const limit = Math.min(query.limit ?? 50, 200);
    const offset = query.offset ?? 0;
    const windowHours = query.resolvedWithinHours ?? DEFAULT_RESOLVED_WINDOW_HOURS;

    // make_interval() rather than ($n || ' hours')::interval: with a bare
    // parameter Postgres cannot infer a type for the || operand and the query
    // fails with "could not determine data type".
    const params: unknown[] = [windowHours];
    const filters: string[] = [
      `(a.resolved_at IS NULL OR a.resolved_at > now() - make_interval(hours => $1::int))`,
    ];
    const push = (clause: string, value: unknown) => {
      params.push(value);
      filters.push(clause.replace('$?', `$${params.length}`));
    };

    if (query.unacknowledgedOnly) filters.push(`a.acknowledged_at IS NULL`);
    if (query.kind) push(`a.kind = $?::kh.alert_kind`, query.kind);
    if (query.severity) push(`a.severity = $?::kh.alert_severity`, query.severity);
    if (query.sessionId) push(`a.session_id = $?`, query.sessionId);

    params.push(limit, offset);

    const rows = await this.db.query(
      `SELECT ${ALERT_COLUMNS}, count(*) OVER () AS total_count
       ${ALERT_SOURCE}
       WHERE ${filters.join(' AND ')}
       -- Worst first, newest first, and everything still open above everything
       -- already over. The severity enum is declared INFO < WARNING < CRITICAL,
       -- so DESC puts the shipments in trouble at the top without a CASE.
       ORDER BY (a.resolved_at IS NULL) DESC, a.severity DESC, a.raised_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );

    return {
      items: rows.map(({ total_count: _ignored, ...rest }) => rest),
      total: rows.length > 0 ? Number(rows[0].total_count) : 0,
      limit,
      offset,
    };
  }

  /**
   * The badge.
   *
   * Bounded by the recency window, not by an index: ix_alerts_unacknowledged is
   * partial on `acknowledged_at IS NULL`, a set that never shrinks for alerts
   * that resolved themselves and nobody ever clicked, so leaning on it would
   * have meant a scan that grows without bound
   * rather than by the size of kh.alerts. The breakdown is computed in the same
   * pass; the dashboard polls this on a timer and a badge is not worth three
   * queries.
   */
  async count(query: AlertCountQueryDto) {
    const windowHours = query.resolvedWithinHours ?? DEFAULT_RESOLVED_WINDOW_HOURS;

    const row = await this.db.one<{
      unacknowledged: number;
      critical: number;
      open: number;
    }>(
      /*
       * Every predicate lives in its own FILTER, not in the WHERE.
       *
       * With `acknowledged_at IS NULL` in the WHERE clause all three numbers
       * silently meant "... and nobody has clicked it": `open` under-reported
       * how many shipments are in trouble, and `critical` counted a signal
       * loss that ended twenty hours ago as long as no one had acknowledged
       * it — so the bell went red on first paint for a truck that was fine.
       */
      `SELECT count(*) FILTER (WHERE a.acknowledged_at IS NULL)::int   AS unacknowledged,
              count(*) FILTER (WHERE a.resolved_at IS NULL
                                 AND a.severity = 'CRITICAL')::int     AS critical,
              count(*) FILTER (WHERE a.resolved_at IS NULL)::int       AS "open"
       FROM kh.alerts a
       WHERE a.resolved_at IS NULL
          OR a.resolved_at > now() - make_interval(hours => $1::int)`,
      [windowHours],
    );

    return { ...row, windowHours };
  }

  /**
   * Stamp who looked, and when.
   *
   * Two statements rather than one UPDATE ... RETURNING with the joins, because
   * a statement cannot see its own write: a CTE that updates the row and then
   * selects it in the same query reads the pre-update snapshot and would hand
   * back acknowledgedAt: null.
   */
  async acknowledge(id: string, userId: string) {
    const claimed = await this.db.maybeOne<{ session_id: string }>(
      `UPDATE kh.alerts
          SET acknowledged_at = now(), acknowledged_by = $2
        WHERE id = $1
          -- First writer wins. Two dispatchers hitting the button on the same
          -- row is the normal case for a shared board, and the second one must
          -- not overwrite the record of who actually picked it up.
          AND acknowledged_at IS NULL
        RETURNING session_id`,
      [id, userId],
    );

    const alert = await this.db.maybeOne(
      `SELECT ${ALERT_COLUMNS} ${ALERT_SOURCE} WHERE a.id = $1`,
      [id],
    );
    if (!alert) {
      throw new NotFoundException({ code: 'ALERT_NOT_FOUND', message: 'Unknown alert' });
    }

    // Only on a real transition. Re-announcing an acknowledgement every time
    // someone clicks an already-handled row would make the badge flicker on
    // every other dispatcher's screen for no state change at all.
    if (claimed) this.publisher.alertAcknowledged(claimed.session_id, id, userId);

    return alert;
  }
}

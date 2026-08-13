import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DatabaseService } from '../database/database.service';
import { RedisService } from '../redis/redis.service';
import { RealtimePublisher } from '../realtime/realtime.publisher';

type AlertKind =
  | 'SIGNAL_LOST'
  | 'ARRIVED'
  | 'BATTERY_LOW'
  | 'MOCK_LOCATION'
  | 'NOT_STARTED'
  | 'STOPPED_TOO_LONG';

type AlertSeverity = 'INFO' | 'WARNING' | 'CRITICAL';

/**
 * Silence tolerance, in minutes.
 *
 * Unchanged from the original detector on purpose: the 74 GPS_LOST rows already
 * in kh.session_events were written against 15 minutes, and moving the line here
 * would silently redefine every comparison anyone makes against that history.
 */
const SILENCE_MINUTES = 15;

/**
 * How long a hand-off may sit unstarted before it is an exception.
 *
 * Ninety minutes. Loading a trailer and clearing the gate paperwork routinely
 * eats an hour, so anything shorter fires during normal operations and teaches
 * dispatchers to ignore the badge. Past ninety minutes there is no innocent
 * explanation left: the driver never installed the app, mistyped the code and
 * gave up, or drove off without starting it. Either way the load is standing in
 * the yard while the order says DISPATCHED and everyone believes it is moving.
 */
const NOT_STARTED_MINUTES = 90;

/**
 * Battery thresholds, with deliberate hysteresis.
 *
 * Raise at 15%, clear at 25%. A phone sitting on the threshold crosses it back
 * and forth all afternoon as the screen wakes and the cab charger cuts in and
 * out; with a single number that is an alert raised and resolved every five
 * minutes for the rest of the run, which is worse than no alert at all.
 */
const BATTERY_LOW_PCT = 15;
const BATTERY_RECOVERED_PCT = 25;

/**
 * Scheduled housekeeping, and the exception detectors.
 *
 * Every job is wrapped in a Redis leader lock so that scaling the API to N
 * replicas does not expire the same session N times. The lock TTL is shorter
 * than the interval, so a crashed leader is replaced on the next tick without
 * any coordination protocol.
 *
 * The detectors write two places, and the split is the point:
 *
 *  - kh.session_events is the append-only audit log. It answers "what happened
 *    on this truck", it is what you show a carrier who says the app stopped
 *    working, and nothing here ever rewrites it.
 *  - kh.alerts is the exception desk. It answers "what is wrong right now and
 *    has anyone looked", it carries severity and a lifecycle, and it is capped
 *    at one open row per (session, kind) by index — which is what lets a
 *    five-minute cron watch a six-hour outage without writing 72 rows about it.
 */
@Injectable()
export class MaintenanceService {
  private readonly logger = new Logger(MaintenanceService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly redis: RedisService,
    private readonly publisher: RealtimePublisher,
  ) {}

  private async withLeaderLock(name: string, ttlSec: number, fn: () => Promise<void>) {
    const acquired = await this.redis.client.set(`lock:${name}`, process.pid, 'EX', ttlSec, 'NX');
    if (acquired !== 'OK') return;
    try {
      await fn();
    } catch (err) {
      this.logger.error(`Job "${name}" failed: ${(err as Error).message}`);
    }
  }

  /** Claim codes that were never used, and sessions past their hard lifetime. */
  @Cron(CronExpression.EVERY_MINUTE)
  async expireSessions(): Promise<void> {
    await this.withLeaderLock('expire-sessions', 55, async () => {
      const rows = await this.db.query<{ expired_id: string; previous_status: string }>(
        `SELECT * FROM kh.expire_stale_sessions()`,
      );
      for (const row of rows) {
        await this.redis.invalidateSessionAuth(row.expired_id);
        this.publisher.sessionState(row.expired_id, 'EXPIRED', { from: row.previous_status });
      }
      if (rows.length) this.logger.log(`Expired ${rows.length} session(s)`);
    });
  }

  /** Destination geofence entry → arrival event on the dispatcher's timeline. */
  @Cron('*/30 * * * * *')
  async detectArrivals(): Promise<void> {
    await this.withLeaderLock('detect-arrivals', 25, async () => {
      // kh.detect_arrivals() is a set-returning function, so it joins like a
      // table. The join buys the human-readable reference for the socket frame
      // without a second round trip per arrival.
      const rows = await this.db.query<{
        session_id: string;
        distance_m: number;
        reference: string;
      }>(
        `SELECT a.session_id, a.distance_m, s.reference
         FROM kh.detect_arrivals() a
         JOIN kh.tracking_sessions s ON s.id = a.session_id`,
      );

      for (const row of rows) {
        const metres = Math.round(row.distance_m);
        this.publisher.sessionEvent(
          row.session_id,
          'GEOFENCE_ENTER',
          `Vehicle reached the destination (${metres} m from the drop point)`,
        );
        // INFO, not WARNING: an arrival is good news that still needs a human to
        // close the paperwork. Severity is what decides whether the badge turns
        // red, and a red badge that means "the truck got there" trains people to
        // stop reading red badges.
        await this.raiseAlert(
          row.session_id,
          row.reference,
          'ARRIVED',
          'INFO',
          'Araç varış noktasına ulaştı',
          `Teslimat noktasına ${metres} metre mesafede.`,
          { distanceM: metres },
        );
        this.logger.log(`Arrival detected for session ${row.reference}`);
      }
    });
  }

  /**
   * Silence detection and recovery.
   *
   * An ACTIVE session with no fix for 15 minutes means one of: dead zone, dead
   * battery, killed service, or a driver who closed the app. We cannot tell
   * which from the server, so we surface it rather than guess — the dispatcher
   * phones the driver. This is the alert that actually saves shipments.
   *
   * Recovery shares the tick and the lock because the pair has to stay
   * consistent: an alert raised by one job and cleared by another on a different
   * schedule spends the gap between them lying to the dispatcher.
   */
  @Cron(CronExpression.EVERY_5_MINUTES)
  async detectSilence(): Promise<void> {
    await this.withLeaderLock('detect-silence', 250, async () => {
      await this.raiseSilenceAlerts();
      await this.clearRecoveredSignals();
    });
  }

  private async raiseSilenceAlerts(): Promise<void> {
    /*
     * The 30-minute "did we already log this" guard now sits on the audit
     * INSERT rather than on the selection.
     *
     * It used to gate both, which meant a truck that went silent, recovered,
     * and went silent again inside half an hour produced no second alert at
     * all — the row was filtered out before anything downstream could see it.
     * Deduplication of the *alert* is the unique partial index's job
     * (ux_alerts_open_per_kind) and kh.raise_alert() reports the outcome, so
     * the guard here is left doing only what it was good at: keeping the audit
     * log from growing a GPS_LOST row every five minutes.
     */
    const rows = await this.db.query<{
      id: string;
      reference: string;
      minutes_silent: number;
      last_battery_pct: number | null;
    }>(
      `WITH silent AS (
         SELECT s.id, s.reference, s.last_battery_pct,
                round(extract(epoch FROM (now() - s.last_point_at)) / 60) AS minutes_silent
         FROM kh.tracking_sessions s
         WHERE s.status = 'ACTIVE'
           AND s.last_point_at IS NOT NULL
           AND s.last_point_at < now() - make_interval(mins => $1::int)
       ),
       logged AS (
         INSERT INTO kh.session_events (session_id, type, actor, payload, message)
         SELECT sl.id, 'GPS_LOST', 'system',
                jsonb_build_object('minutesSilent', sl.minutes_silent),
                format('No position for %s minutes', sl.minutes_silent)
         FROM silent sl
         WHERE NOT EXISTS (
           SELECT 1 FROM kh.session_events e
           WHERE e.session_id = sl.id
             AND e.type = 'GPS_LOST'
             AND e.occurred_at > now() - interval '30 minutes'
         )
         RETURNING 1
       )
       /*
        * kh.raise_alert() is still the authority on whether an alert is new —
        * it has the unique index behind it and this pre-filter races with
        * nothing else. The filter is here so that fifty trucks silent overnight
        * do not cost fifty round trips every five minutes to be told "already
        * open" fifty times.
        */
       SELECT sl.* FROM silent sl
       WHERE NOT EXISTS (
         SELECT 1 FROM kh.alerts al
         WHERE al.session_id = sl.id
           AND al.kind = 'SIGNAL_LOST'
           AND al.resolved_at IS NULL
       )`,
      [SILENCE_MINUTES],
    );

    for (const row of rows) {
      const minutes = Math.round(row.minutes_silent);
      const battery = row.last_battery_pct;

      const opened = await this.raiseAlert(
        row.id,
        row.reference,
        'SIGNAL_LOST',
        // CRITICAL is the one case that earns it: a shipment nobody can see is
        // a shipment in trouble now, which is exactly what the severity is
        // reserved for.
        'CRITICAL',
        'Sinyal kesildi',
        `Araçtan ${minutes} dakikadır konum alınamıyor.` +
          (battery !== null ? ` Son bilinen pil %${battery}.` : ''),
        { minutesSilent: minutes, lastBatteryPct: battery },
      );

      // Everything below announces "this just started". The audit INSERT above
      // still runs on its own half-hourly cadence, so the detail page's timeline
      // keeps its periodic markers; what must not repeat is the notification.
      if (!opened) continue;

      this.publisher.sessionEvent(
        row.id,
        'GPS_LOST',
        `No position received for ${minutes} minutes` +
          (battery !== null ? ` (battery was ${battery}%)` : ''),
      );
      this.logger.warn(`Session ${row.reference} silent for ${minutes} min`);
    }
  }

  /**
   * The truck came back.
   *
   * Driven off kh.alerts rather than off the session table because the open
   * alert *is* the question being asked — "which trucks are we currently
   * worried about" — and there is no cheaper way to ask it.
   */
  private async clearRecoveredSignals(): Promise<void> {
    const rows = await this.db.query<{
      session_id: string;
      reference: string;
      minutes_down: number;
    }>(
      `SELECT s.id AS session_id, s.reference,
              round(extract(epoch FROM (now() - a.raised_at)) / 60) AS minutes_down
       FROM kh.alerts a
       JOIN kh.tracking_sessions s ON s.id = a.session_id
       WHERE a.kind = 'SIGNAL_LOST'
         AND a.resolved_at IS NULL
         -- Same window as the raise. Any other number leaves a band in which a
         -- session is neither silent enough to alert nor fresh enough to clear,
         -- and an alert that lands in it never closes.
         AND s.last_point_at > now() - make_interval(mins => $1::int)`,
      [SILENCE_MINUTES],
    );

    for (const row of rows) {
      const resolved = await this.clearAlert(row.session_id, 'SIGNAL_LOST');
      if (!resolved) continue;

      const minutes = Math.round(row.minutes_down);
      await this.db.query(
        `INSERT INTO kh.session_events (session_id, type, actor, payload, message)
         VALUES ($1, 'GPS_RECOVERED', 'system',
                 jsonb_build_object('minutesSilent', $2::int),
                 format('Position stream resumed after %s minutes', $2::int))`,
        [row.session_id, minutes],
      );
      this.publisher.sessionEvent(
        row.session_id,
        'GPS_RECOVERED',
        `Position stream resumed after ${minutes} minutes`,
      );
      this.logger.log(`Session ${row.reference} recovered after ${minutes} min silent`);
    }
  }

  /**
   * The load that never left.
   *
   * Nothing else in the system notices this. The order is DISPATCHED, the
   * dashboard shows "Kod bekliyor", and no detector looks at a session that is
   * not ACTIVE — so a hand-off that failed at the gate is invisible until the
   * customer phones to ask where their delivery is.
   */
  @Cron(CronExpression.EVERY_10_MINUTES)
  async detectNotStarted(): Promise<void> {
    await this.withLeaderLock('detect-not-started', 550, async () => {
      const rows = await this.db.query<{
        id: string;
        reference: string;
        status: string;
        minutes_waiting: number;
      }>(
        /*
         * created_at is when the claim code was minted — kh.tracking_sessions
         * has no separate issue timestamp, and the code is written by the same
         * INSERT that creates the row. Re-issuing a code does not move it, and
         * that is the behaviour we want: the load has been standing in the yard
         * since the first hand-off, not since the dispatcher's latest attempt
         * to rescue it.
         */
        `SELECT s.id, s.reference, s.status::text AS status,
                round(extract(epoch FROM (now() - s.created_at)) / 60) AS minutes_waiting
         FROM kh.tracking_sessions s
         WHERE s.status IN ('ASSIGNED', 'CLAIMED')
           AND s.started_at IS NULL
           AND s.created_at < now() - make_interval(mins => $1::int)
           -- Already-open alerts are skipped here rather than round-tripped to
           -- kh.raise_alert() only to be refused; see raiseSilenceAlerts().
           AND NOT EXISTS (
             SELECT 1 FROM kh.alerts al
             WHERE al.session_id = s.id
               AND al.kind = 'NOT_STARTED'
               AND al.resolved_at IS NULL
           )`,
        [NOT_STARTED_MINUTES],
      );

      for (const row of rows) {
        const minutes = Math.round(row.minutes_waiting);
        // WARNING, not CRITICAL: the goods are not at risk, they are merely not
        // where the paperwork says. That distinction is the only thing keeping
        // CRITICAL meaningful on the badge.
        await this.raiseAlert(
          row.id,
          row.reference,
          'NOT_STARTED',
          'WARNING',
          'Takip başlatılmadı',
          row.status === 'CLAIMED'
            ? `Sürücünün cihazı bağlandı ama takip ${minutes} dakikadır başlatılmadı.`
            : `Sürücü kodu ${minutes} dakika önce verildi, hâlâ kullanılmadı.`,
          { minutesWaiting: minutes, sessionStatus: row.status },
        );
      }

      await this.clearStartedSessions();
    });
  }

  /** The driver eventually pressed Start. The exception is over. */
  private async clearStartedSessions(): Promise<void> {
    const rows = await this.db.query<{ session_id: string }>(
      `SELECT a.session_id
       FROM kh.alerts a
       JOIN kh.tracking_sessions s ON s.id = a.session_id
       WHERE a.kind = 'NOT_STARTED'
         AND a.resolved_at IS NULL
         AND s.started_at IS NOT NULL`,
    );
    for (const row of rows) {
      await this.clearAlert(row.session_id, 'NOT_STARTED');
    }
  }

  /**
   * The phone that will not last the trip.
   *
   * A dying phone is the one silence cause a dispatcher can still do something
   * about while the truck is still visible — ring the driver and tell him to
   * plug it in. Ten minutes after the battery alert is a phone call; fifteen
   * minutes after it dies is a SIGNAL_LOST and a truck nobody can find.
   */
  @Cron(CronExpression.EVERY_10_MINUTES)
  async detectLowBattery(): Promise<void> {
    await this.withLeaderLock('detect-low-battery', 550, async () => {
      const rows = await this.db.query<{
        id: string;
        reference: string;
        last_battery_pct: number;
      }>(
        `SELECT s.id, s.reference, s.last_battery_pct
         FROM kh.tracking_sessions s
         WHERE s.status = 'ACTIVE'
           AND s.last_battery_pct IS NOT NULL
           AND s.last_battery_pct <= $1::int
           -- IS NOT TRUE, not = false: a build that never reports charging state
           -- leaves this NULL, and for a battery warning the pessimistic reading
           -- is the safe one.
           AND s.last_is_charging IS NOT TRUE
           -- A battery figure is only as fresh as the fix it arrived with. Once
           -- the session is silent, SIGNAL_LOST owns the truck and a second
           -- alert about a three-hour-old percentage adds nothing.
           AND s.last_point_at > now() - make_interval(mins => $2::int)
           -- See raiseSilenceAlerts(): skip what is already open rather than
           -- asking the database to refuse it.
           AND NOT EXISTS (
             SELECT 1 FROM kh.alerts al
             WHERE al.session_id = s.id
               AND al.kind = 'BATTERY_LOW'
               AND al.resolved_at IS NULL
           )`,
        [BATTERY_LOW_PCT, SILENCE_MINUTES],
      );

      for (const row of rows) {
        await this.raiseAlert(
          row.id,
          row.reference,
          'BATTERY_LOW',
          'WARNING',
          'Telefon pili kritik',
          `Pil %${row.last_battery_pct} ve şarjda değil — telefon teslimattan önce kapanabilir.`,
          { batteryPct: row.last_battery_pct },
        );
      }

      await this.clearChargedBatteries();
    });
  }

  private async clearChargedBatteries(): Promise<void> {
    const rows = await this.db.query<{ session_id: string }>(
      `SELECT a.session_id
       FROM kh.alerts a
       JOIN kh.tracking_sessions s ON s.id = a.session_id
       WHERE a.kind = 'BATTERY_LOW'
         AND a.resolved_at IS NULL
         AND (s.last_is_charging IS TRUE OR s.last_battery_pct >= $1::int)`,
      [BATTERY_RECOVERED_PCT],
    );
    for (const row of rows) {
      await this.clearAlert(row.session_id, 'BATTERY_LOW');
    }
  }

  /**
   * Close every open alert on a session that has finished.
   *
   * An alert claims a condition is true *now*, and every detector that could
   * ever clear one looks only at live sessions. So a truck that went dark and
   * was then completed, cancelled or expired keeps a CRITICAL row in "what is
   * wrong right now" forever, describing a shipment that ended days ago.
   *
   * This resolves them, which is the honest lifecycle event — the world moved
   * on. It deliberately does not touch acknowledgement: whether a human ever
   * looked is a separate fact and one worth keeping.
   */
  @Cron(CronExpression.EVERY_10_MINUTES)
  async closeAlertsOnFinishedSessions(): Promise<void> {
    await this.withLeaderLock('close-finished-alerts', 550, async () => {
      const rows = await this.db.query<{ session_id: string; kind: AlertKind }>(
        `SELECT a.session_id, a.kind::text AS kind
         FROM kh.alerts a
         JOIN kh.tracking_sessions s ON s.id = a.session_id
         WHERE a.resolved_at IS NULL
           AND s.status IN ('COMPLETED', 'CANCELLED', 'EXPIRED')`,
      );
      for (const row of rows) {
        await this.clearAlert(row.session_id, row.kind);
      }
      if (rows.length) this.logger.log(`Closed ${rows.length} alert(s) on finished sessions`);
    });
  }

  /**
   * Fold finished shipments' routes into the permanent archive.
   *
   * The retention policy on kh.location_points drops raw fixes after two years,
   * on its own schedule, with no application involvement. Everything else about
   * a closed shipment survives forever — the session, the events, the distance —
   * so the only thing that silently disappears is the one thing an archive is
   * for: the road the lorry actually took.
   *
   * Hourly and bounded to 50 at a time. There is no urgency — the deadline is
   * two years away — and a batch cap keeps the ST_MakeLine work off the same
   * two vCPUs the live ingest is using.
   */
  @Cron(CronExpression.EVERY_HOUR)
  async archiveRoutes(): Promise<void> {
    await this.withLeaderLock('archive-routes', 3500, async () => {
      const rows = await this.db.query<{ session_id: string; archived: boolean }>(
        `SELECT * FROM kh.archive_finished_routes(50)`,
      );
      const done = rows.filter((r) => r.archived).length;
      // Sessions that produced no line are logged too: a closed shipment with
      // fewer than two fixes is a phone that never really reported, and that is
      // worth being able to see in the log rather than silently skipping.
      if (rows.length) {
        this.logger.log(`Archived ${done}/${rows.length} finished route(s)`);
      }
    });
  }

  /** Housekeeping on the auth tables. Cheap, but unbounded growth is a bug. */
  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async pruneTokens(): Promise<void> {
    await this.withLeaderLock('prune-tokens', 3600, async () => {
      const rows = await this.db.query<{ deleted: number }>(
        `WITH gone AS (
           DELETE FROM kh.refresh_tokens
           WHERE expires_at < now() - interval '30 days'
              OR (revoked_at IS NOT NULL AND revoked_at < now() - interval '30 days')
           RETURNING 1
         ) SELECT count(*)::int AS deleted FROM gone`,
      );
      this.logger.log(`Pruned ${rows[0]?.deleted ?? 0} expired refresh token(s)`);
    });
  }

  // ===========================================================================
  // Alert plumbing
  //
  // Every detector goes through these two so that "raised" and "resolved" mean
  // the same thing everywhere: one database function call, one broadcast, and
  // no broadcast at all when nothing actually changed.
  // ===========================================================================

  /** @returns true when a NEW alert was opened (and announced). */
  private async raiseAlert(
    sessionId: string,
    reference: string,
    kind: AlertKind,
    severity: AlertSeverity,
    title: string,
    detail: string | null,
    payload: Record<string, unknown>,
  ): Promise<boolean> {
    const row = await this.db.one<{ alert_id: string | null }>(
      // The enum casts are explicit because the parameters arrive untyped and
      // an unknown-typed literal cannot be resolved against an enum argument.
      `SELECT kh.raise_alert($1, $2::kh.alert_kind, $3::kh.alert_severity, $4, $5, $6::jsonb)
              AS alert_id`,
      [sessionId, kind, severity, title, detail, JSON.stringify(payload)],
    );

    // NULL means one of this kind is already open on this session. Returning
    // here is the whole reason a five-minute cron is not a five-minute
    // nuisance: the condition is old news, so nobody is told about it again.
    if (!row.alert_id) return false;

    this.publisher.alertRaised({
      id: row.alert_id,
      sessionId,
      reference,
      kind,
      severity,
      title,
      detail,
      raisedAt: new Date().toISOString(),
    });
    return true;
  }

  /** @returns the resolved alert id, or null when there was nothing open. */
  private async clearAlert(sessionId: string, kind: AlertKind): Promise<string | null> {
    const row = await this.db.one<{ alert_id: string | null }>(
      `SELECT kh.resolve_alert($1, $2::kh.alert_kind) AS alert_id`,
      [sessionId, kind],
    );
    if (!row.alert_id) return null;
    this.publisher.alertResolved(sessionId, row.alert_id, kind);
    return row.alert_id;
  }
}

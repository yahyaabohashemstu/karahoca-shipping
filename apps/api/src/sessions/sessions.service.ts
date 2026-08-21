import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { randomBytes, randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import QRCode from 'qrcode';
import { CONFIG, type AppConfig } from '../config/configuration';
import { ShareService } from '../share/share.service';
import { DatabaseService } from '../database/database.service';
import { RedisService } from '../redis/redis.service';
import { RealtimePublisher } from '../realtime/realtime.publisher';
import { FLEET_COLUMNS } from '../common/fleet-projection';
import {
  encryptSecret,
  normalizeClaimCode,
  randomToken,
  sha256,
} from '../common/crypto.util';
import type {
  ClaimSessionDto,
  CreateSessionDto,
  DriverEventDto,
  DriverRefreshDto,
  ListSessionsQueryDto,
  UpdateSessionPolicyDto,
} from './dto';

const OPEN_STATUSES = ['ASSIGNED', 'CLAIMED', 'ACTIVE', 'PAUSED'] as const;

export interface DriverCredentials {
  sessionId: string;
  reference: string;
  accessToken: string;
  refreshToken: string;
  /** base64 — the HMAC key the app signs every request with. */
  ingestKey: string;
  expiresIn: number;
  serverTime: number;
  policy: { pingIntervalSec: number; idleIntervalSec: number; minDistanceM: number };
  shipment: {
    orderNumber: string;
    customerName: string;
    destinationLabel: string | null;
    destinationAddress: string | null;
    destinationLat: number | null;
    destinationLon: number | null;
    /*
     * The arrival radius, sent so the phone and the server can agree on what
     * "arrived" means.
     *
     * Without it the app would have to pick its own number, and a driver told
     * "you have arrived" at 300 m while kh.alerts raises ARRIVED at 800 m gives
     * the dispatcher and the driver two different truths about the same moment
     * — which is worse than the app saying nothing.
     */
    destinationRadiusM: number | null;
    cargoSummary: string | null;
    plannedDeliveryAt: string | null;
  };
}

@Injectable()
export class SessionsService {
  private readonly logger = new Logger(SessionsService.name);

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly db: DatabaseService,
    private readonly redis: RedisService,
    private readonly publisher: RealtimePublisher,
    private readonly share: ShareService,
  ) {}

  // ===========================================================================
  // Dispatcher surface
  // ===========================================================================

  async create(dto: CreateSessionDto, userId: string) {
    const order = await this.db.maybeOne<{ id: string; status: string }>(
      `SELECT id, status::text FROM kh.orders WHERE id = $1`,
      [dto.orderId],
    );
    if (!order) throw new NotFoundException({ code: 'ORDER_NOT_FOUND', message: 'Order does not exist' });
    if (order.status === 'CANCELLED') {
      throw new ConflictException({ code: 'ORDER_CANCELLED', message: 'Cannot track a cancelled order' });
    }

    const existing = await this.db.maybeOne<{ id: string; reference: string; status: string }>(
      `SELECT id, reference, status::text FROM kh.tracking_sessions
       WHERE order_id = $1 AND status = ANY($2::kh.session_status[])`,
      [dto.orderId, OPEN_STATUSES],
    );
    if (existing) {
      throw new ConflictException({
        code: 'SESSION_ALREADY_OPEN',
        message: `Order already has an open session (${existing.reference}, ${existing.status})`,
        sessionId: existing.id,
      });
    }

    const claimTtl = dto.claimTtlMinutes ?? this.config.session.defaultClaimTtlMin;
    const lifetime = dto.maxLifetimeHours ?? this.config.session.defaultMaxLifetimeHours;

    /*
     * The idle cadence must never be tighter than the moving one — a parked
     * truck sampled more often than a driving one is backwards, and migration
     * 0007 enforces it at the database.
     *
     * The dashboard only asks for the moving interval, so the default idle of
     * 60 s silently violated that as soon as a dispatcher chose anything slower
     * than a minute. Deriving it here means the constraint is satisfied by
     * construction rather than surfacing as a 500 on a form the dispatcher
     * filled in correctly.
     */
    const ping = dto.pingIntervalSec ?? 10;
    const idle = Math.max(dto.idleIntervalSec ?? 60, ping);

    // Retry on the astronomically unlikely code collision rather than pretending
    // it cannot happen.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        const row = await this.db.one<{ id: string; reference: string; claim_code: string }>(
          `INSERT INTO kh.tracking_sessions (
             order_id, shipping_company_id, driver_id, vehicle_id,
             driver_name_snapshot, driver_phone_snapshot, vehicle_plate_snapshot,
             status, claim_code, claim_code_expires_at,
             ping_interval_sec, idle_interval_sec, min_distance_m,
             max_lifetime_hours, expires_at, notes, created_by
           )
           VALUES (
             $1, $2, $3, $4,
             coalesce($5, (SELECT full_name FROM kh.drivers WHERE id = $3)),
             coalesce($6, (SELECT phone     FROM kh.drivers WHERE id = $3)),
             coalesce($7, (SELECT plate::text FROM kh.vehicles WHERE id = $4)),
             -- make_interval() rather than ($n || ' minutes')::interval: with a
             -- bare parameter Postgres cannot infer a type for the || operand
             -- and the query fails with "could not determine data type".
             'ASSIGNED', kh.generate_claim_code(8), now() + make_interval(mins => $8::int),
             $9, $10, $11,
             $12::int, now() + make_interval(hours => $12::int), $13, $14
           )
           RETURNING id, reference, claim_code`,
          [
            dto.orderId,
            dto.shippingCompanyId,
            dto.driverId ?? null,
            dto.vehicleId ?? null,
            dto.driverName ?? null,
            dto.driverPhone ?? null,
            dto.vehiclePlate ?? null,
            claimTtl,
            ping,
            idle,
            dto.minDistanceM ?? 0,
            lifetime,
            dto.notes ?? null,
            userId,
          ],
        );

        await this.db.query(
          `INSERT INTO kh.session_events (session_id, type, actor, message)
           VALUES ($1, 'CREATED', $2, 'Tracking session created and claim code issued')`,
          [row.id, userId],
        );
        await this.db.query(
          `UPDATE kh.orders SET status = 'DISPATCHED', dispatched_at = coalesce(dispatched_at, now())
           WHERE id = $1 AND status = 'PENDING'`,
          [dto.orderId],
        );

        await this.publisher.sessionState(row.id, 'ASSIGNED');

        /*
         * Mint the consignee link here, not behind a button.
         *
         * The moment a dispatcher needs it is the moment they create the
         * session and message the agent — a link that depends on remembering
         * to press something does not get sent. This is also the only point at
         * which the raw token can be handed back, because only its sha256 is
         * stored; ask again later and a fresh link has to be minted. That is
         * the right trade: the token is a live credential, and a database dump
         * must not yield working tracking links.
         *
         * Non-fatal. A session without a share link is a shipment you can
         * still track from the desk; a session that failed to be created is a
         * truck that leaves untracked.
         */
        const detail = await this.getDetail(row.id);
        const shareUrl = await this.share
          .mint(row.id, {}, userId)
          .then((link) => link.url)
          .catch((err: Error) => {
            this.logger.warn(
              `Session ${row.id} created, consignee link was not: ${err.message}`,
            );
            return null;
          });

        return detail.handoff
          ? { ...detail, handoff: { ...detail.handoff, shareUrl } }
          : detail;
      } catch (err) {
        const code = (err as { code?: string; constraint?: string }).code;
        const constraint = (err as { constraint?: string }).constraint;
        if (code === '23505' && constraint === 'uq_sessions_claim_code') continue;
        if (code === '23505' && constraint === 'uq_sessions_one_live_per_order') {
          throw new ConflictException({
            code: 'SESSION_ALREADY_OPEN',
            message: 'Another dispatcher just opened a session for this order',
          });
        }
        throw err;
      }
    }
    throw new ConflictException({ code: 'CODE_COLLISION', message: 'Could not allocate a claim code' });
  }

  async list(query: ListSessionsQueryDto) {
    const limit = Math.min(query.limit ?? 50, 200);
    const offset = query.offset ?? 0;

    const filters: string[] = [];
    const params: unknown[] = [];
    const push = (clause: string, value: unknown) => {
      params.push(value);
      filters.push(clause.replace('$?', `$${params.length}`));
    };

    if (query.status === 'LIVE') {
      filters.push(`f.status IN ('CLAIMED','ACTIVE','PAUSED')`);
    } else if (query.status) {
      push(`f.status = $?::kh.session_status`, query.status);
    }
    if (query.shippingCompanyId) push(`f.shipping_company_id = $?`, query.shippingCompanyId);
    if (query.customerId) push(`f.customer_id = $?`, query.customerId);
    if (query.from) push(`f.started_at >= $?::timestamptz`, query.from);
    if (query.to) push(`f.started_at <= $?::timestamptz`, query.to);
    if (query.search) {
      params.push(`%${query.search}%`);
      filters.push(
        `(f.order_number ILIKE $${params.length} OR f.customer_name ILIKE $${params.length}
          OR f.reference ILIKE $${params.length} OR f.vehicle_plate ILIKE $${params.length}
          OR f.driver_name ILIKE $${params.length})`,
      );
    }

    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    params.push(limit, offset);

    const rows = await this.db.query(
      `SELECT ${FLEET_COLUMNS}, count(*) OVER () AS total_count
       FROM kh.v_live_fleet f
       ${where}
       ORDER BY (f.status IN ('ACTIVE','CLAIMED','PAUSED')) DESC,
                coalesce(f.last_point_at, f.started_at) DESC NULLS LAST
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );

    const total = rows.length > 0 ? Number(rows[0].total_count) : 0;
    return {
      items: rows.map(({ total_count: _ignored, ...rest }) => rest),
      total,
      limit,
      offset,
    };
  }

  async getDetail(sessionId: string) {
    const session = await this.db.maybeOne(
      `SELECT ${FLEET_COLUMNS} FROM kh.v_live_fleet f WHERE f.session_id = $1`,
      [sessionId],
    );
    if (!session) throw new NotFoundException({ code: 'SESSION_NOT_FOUND', message: 'Unknown session' });

    const [raw, device, events] = await Promise.all([
      this.db.one<{
        claim_code: string | null;
        claim_code_expires_at: Date | null;
        ping_interval_sec: number;
        idle_interval_sec: number;
        min_distance_m: number;
        expires_at: Date;
        notes: string | null;
        ended_at: Date | null;
        end_reason: string | null;
        points_rejected: number;
        offline_batches: number;
      }>(
        `SELECT claim_code, claim_code_expires_at, ping_interval_sec, idle_interval_sec,
                min_distance_m, expires_at, notes, ended_at, end_reason,
                points_rejected, offline_batches
         FROM kh.tracking_sessions WHERE id = $1`,
        [sessionId],
      ),
      this.db.maybeOne(
        `SELECT device_id, manufacturer, model, os_version, sdk_int, app_version,
                battery_optimisation_ignored, has_background_location, has_exact_alarm,
                bound_at, last_seen_at
         FROM kh.session_devices
         WHERE session_id = $1 AND revoked_at IS NULL`,
        [sessionId],
      ),
      this.db.query(
        `SELECT type::text, occurred_at, actor, message, payload
         FROM kh.session_events WHERE session_id = $1
         ORDER BY occurred_at DESC LIMIT 100`,
        [sessionId],
      ),
    ]);

    const handoff = raw.claim_code
      ? await this.buildHandoff(raw.claim_code, raw.claim_code_expires_at)
      : null;

    return {
      ...session,
      policy: {
        pingIntervalSec: raw.ping_interval_sec,
        idleIntervalSec: raw.idle_interval_sec,
        minDistanceM: raw.min_distance_m,
      },
      expiresAt: raw.expires_at,
      endedAt: raw.ended_at,
      endReason: raw.end_reason,
      pointsRejected: raw.points_rejected,
      offlineBatches: raw.offline_batches,
      notes: raw.notes,
      handoff,
      device,
      events,
    };
  }

  /** Everything the dispatcher needs to hand the session to a driver. */
  private async buildHandoff(code: string, expiresAt: Date | null) {
    const pretty = `${code.slice(0, 4)}-${code.slice(4)}`;
    const deepLink = `${this.config.session.deepLinkScheme}://track?c=${code}`;
    const webLink = `${this.config.publicApiUrl}/t/${code}`;
    return {
      code,
      prettyCode: pretty,
      expiresAt,
      deepLink,
      webLink,
      /*
       * The QR encodes the https link, NOT the karahoca:// deep link.
       *
       * A custom scheme in a QR is a dead end on Android: the stock camera,
       * Samsung's camera and Google Lens all decline to launch an unknown
       * scheme, so the driver saw raw text and typed the code by hand — which
       * is exactly the step this QR exists to remove.
       *
       * The https URL is claimed by the app as a verified App Link (see
       * assetlinks.json below), so scanning it opens the app directly. Where
       * verification has not happened — no network at install time, or the app
       * is not installed at all — it opens the landing page instead, which
       * fires the intent:// and falls back to the APK download.
       */
      qrDataUrl: await QRCode.toDataURL(webLink, {
        errorCorrectionLevel: 'M',
        margin: 1,
        width: 320,
      }),
    };
  }

  async regenerateClaimCode(sessionId: string, actor: string) {
    const session = await this.db.maybeOne<{ status: string }>(
      `SELECT status::text FROM kh.tracking_sessions WHERE id = $1`,
      [sessionId],
    );
    if (!session) throw new NotFoundException({ code: 'SESSION_NOT_FOUND', message: 'Unknown session' });
    if (['COMPLETED', 'CANCELLED', 'EXPIRED'].includes(session.status)) {
      throw new ConflictException({ code: 'SESSION_CLOSED', message: 'Session is closed' });
    }

    // Reassigning revokes the old device *and* every token it holds.
    const row = await this.db.one<{ claim_code: string; claim_code_expires_at: Date }>(
      `UPDATE kh.tracking_sessions
       SET claim_code            = kh.generate_claim_code(8),
           claim_code_expires_at = now() + make_interval(mins => $2::int),
           status                = 'ASSIGNED',
           token_version         = token_version + 1,
           claim_attempts        = 0
       WHERE id = $1
       RETURNING claim_code, claim_code_expires_at`,
      [sessionId, this.config.session.defaultClaimTtlMin],
    );
    await this.db.query(
      `UPDATE kh.session_devices SET revoked_at = now()
       WHERE session_id = $1 AND revoked_at IS NULL`,
      [sessionId],
    );
    await this.db.query(
      `INSERT INTO kh.session_events (session_id, type, actor, message)
       VALUES ($1, 'REVOKED', $2, 'Claim code regenerated; previous device revoked')`,
      [sessionId, actor],
    );
    await this.redis.invalidateSessionAuth(sessionId);
    await this.publisher.sessionState(sessionId, 'ASSIGNED');

    return this.buildHandoff(row.claim_code, row.claim_code_expires_at);
  }

  async updatePolicy(sessionId: string, dto: UpdateSessionPolicyDto, actor: string) {
    const row = await this.db.maybeOne(
      `UPDATE kh.tracking_sessions
       SET ping_interval_sec = coalesce($2, ping_interval_sec),
           idle_interval_sec = coalesce($3, idle_interval_sec),
           min_distance_m    = coalesce($4, min_distance_m),
           notes             = coalesce($5, notes)
       WHERE id = $1
       RETURNING ping_interval_sec, idle_interval_sec, min_distance_m`,
      [
        sessionId,
        dto.pingIntervalSec ?? null,
        dto.idleIntervalSec ?? null,
        dto.minDistanceM ?? null,
        dto.notes ?? null,
      ],
    );
    if (!row) throw new NotFoundException({ code: 'SESSION_NOT_FOUND', message: 'Unknown session' });

    // The device picks the new policy up from the `policy` block returned on its
    // next ingest response — no push channel to the phone is required.
    await this.redis.invalidateSessionAuth(sessionId);
    await this.db.query(
      `INSERT INTO kh.session_events (session_id, type, actor, payload, message)
       VALUES ($1, 'NOTE', $2, $3::jsonb, 'Tracking policy updated')`,
      [sessionId, actor, JSON.stringify(row)],
    );
    return row;
  }

  async transition(
    sessionId: string,
    action: 'pause' | 'resume' | 'complete' | 'cancel',
    actor: string,
    reason?: string,
  ) {
    if (action === 'complete' || action === 'cancel') {
      const result = await this.db.one<{ finalize_session: Record<string, unknown> }>(
        `SELECT kh.finalize_session($1, $2, $3, $4::kh.session_status) AS finalize_session`,
        [
          sessionId,
          reason ?? (action === 'cancel' ? 'cancelled by dispatcher' : 'completed by dispatcher'),
          actor,
          action === 'cancel' ? 'CANCELLED' : 'COMPLETED',
        ],
      );
      await this.redis.invalidateSessionAuth(sessionId);
      await this.publisher.sessionState(sessionId, action === 'cancel' ? 'CANCELLED' : 'COMPLETED');
      return result.finalize_session;
    }

    const target = action === 'pause' ? 'PAUSED' : 'ACTIVE';
    const from = action === 'pause' ? ['ACTIVE'] : ['PAUSED'];
    const row = await this.db.maybeOne<{ status: string }>(
      `UPDATE kh.tracking_sessions
       SET status = $2::kh.session_status
       WHERE id = $1 AND status = ANY($3::kh.session_status[])
       RETURNING status::text`,
      [sessionId, target, from],
    );
    if (!row) {
      throw new ConflictException({
        code: 'INVALID_TRANSITION',
        message: `Session cannot be ${action}d from its current state`,
      });
    }
    await this.db.query(
      `INSERT INTO kh.session_events (session_id, type, actor, message)
       VALUES ($1, $2::kh.session_event_type, $3, $4)`,
      [sessionId, action === 'pause' ? 'PAUSED' : 'RESUMED', actor, reason ?? null],
    );
    await this.redis.invalidateSessionAuth(sessionId);
    await this.publisher.sessionState(sessionId, row.status);
    return row;
  }

  // ===========================================================================
  // Driver surface
  // ===========================================================================

  async claim(dto: ClaimSessionDto, ip: string | undefined): Promise<DriverCredentials> {
    // 2^40 codes make brute force pointless, but a per-IP limit turns "pointless"
    // into "impossible" and keeps the logs clean.
    const rate = await this.redis.consume(`claim:${ip ?? 'unknown'}`, 20, 300);
    if (!rate.allowed) {
      throw new ForbiddenException({
        code: 'TOO_MANY_ATTEMPTS',
        message: 'Too many claim attempts. Wait a few minutes and try again.',
      });
    }

    const code = normalizeClaimCode(dto.code);
    if (code.length < 6) {
      throw new BadRequestException({ code: 'BAD_CODE', message: 'Session code looks incomplete' });
    }

    const ingestKey = randomBytes(32);
    const refreshToken = randomToken(48);

    const result = await this.db.transaction(async (tx) => {
      const { rows } = await tx.query<{
        id: string;
        reference: string;
        token_version: number;
        ping_interval_sec: number;
        idle_interval_sec: number;
        min_distance_m: number;
      }>(
        `SELECT id, reference, token_version, ping_interval_sec, idle_interval_sec, min_distance_m
         FROM kh.tracking_sessions
         WHERE claim_code = $1
           AND status = 'ASSIGNED'
           AND (claim_code_expires_at IS NULL OR claim_code_expires_at > now())
           AND expires_at > now()
         FOR UPDATE`,
        [code],
      );

      if (rows.length === 0) {
        throw new NotFoundException({
          code: 'CODE_INVALID',
          message: 'That session code is not valid, has expired, or was already used.',
        });
      }
      const session = rows[0];

      // Any device previously bound to this session loses access.
      await tx.query(
        `UPDATE kh.session_devices SET revoked_at = now()
         WHERE session_id = $1 AND revoked_at IS NULL`,
        [session.id],
      );

      await tx.query(
        `INSERT INTO kh.session_devices (
           session_id, device_id, device_fingerprint, manufacturer, model,
           os_version, sdk_int, app_version, app_build,
           ingest_key_enc, refresh_token_hash, refresh_expires_at,
           battery_optimisation_ignored, has_background_location, has_exact_alarm, last_ip
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
           now() + make_interval(secs => $12::int), $13, $14, $15, $16
         )
         ON CONFLICT (session_id, device_id) DO UPDATE SET
           revoked_at         = NULL,
           ingest_key_enc     = EXCLUDED.ingest_key_enc,
           refresh_token_hash = EXCLUDED.refresh_token_hash,
           refresh_expires_at = EXCLUDED.refresh_expires_at,
           bound_at           = now(),
           app_version        = EXCLUDED.app_version,
           app_build          = EXCLUDED.app_build,
           battery_optimisation_ignored = EXCLUDED.battery_optimisation_ignored,
           has_background_location      = EXCLUDED.has_background_location,
           has_exact_alarm              = EXCLUDED.has_exact_alarm`,
        [
          session.id,
          dto.device.deviceId,
          dto.device.fingerprint ?? null,
          dto.device.manufacturer ?? null,
          dto.device.model ?? null,
          dto.device.osVersion ?? null,
          dto.device.sdkInt ?? null,
          dto.device.appVersion ?? null,
          dto.device.appBuild ?? null,
          encryptSecret(ingestKey, this.config.auth.ingestKeyEncryptionKey),
          sha256(refreshToken),
          this.config.auth.driverRefreshTtlSec,
          dto.device.batteryOptimisationIgnored ?? null,
          dto.device.hasBackgroundLocation ?? null,
          dto.device.hasExactAlarm ?? null,
          ip ?? null,
        ],
      );

      const { rows: updated } = await tx.query<{ token_version: number }>(
        `UPDATE kh.tracking_sessions
         SET status        = 'CLAIMED',
             claimed_at    = now(),
             claim_code    = NULL,
             token_version = token_version + 1
         WHERE id = $1
         RETURNING token_version`,
        [session.id],
      );

      await tx.query(
        `INSERT INTO kh.session_events (session_id, type, actor, payload, message)
         VALUES ($1, 'CLAIMED', 'device', $2::jsonb, $3)`,
        [
          session.id,
          JSON.stringify({
            deviceId: dto.device.deviceId,
            model: dto.device.model,
            osVersion: dto.device.osVersion,
            batteryOptimisationIgnored: dto.device.batteryOptimisationIgnored,
            hasBackgroundLocation: dto.device.hasBackgroundLocation,
          }),
          `Session claimed by ${dto.device.manufacturer ?? '?'} ${dto.device.model ?? 'device'}`,
        ],
      );

      const { rows: shipmentRows } = await tx.query<Record<string, never>>(
        `SELECT o.order_number::text        AS "orderNumber",
                c.name                      AS "customerName",
                o.destination_label         AS "destinationLabel",
                o.destination_address       AS "destinationAddress",
                ST_Y(o.destination::geometry) AS "destinationLat",
                ST_X(o.destination::geometry) AS "destinationLon",
                o.destination_radius_m      AS "destinationRadiusM",
                o.cargo_summary             AS "cargoSummary",
                o.planned_delivery_at       AS "plannedDeliveryAt"
         FROM kh.tracking_sessions s
         JOIN kh.orders    o ON o.id = s.order_id
         JOIN kh.customers c ON c.id = o.customer_id
         WHERE s.id = $1`,
        [session.id],
      );

      return {
        session,
        tokenVersion: updated[0].token_version,
        shipment: shipmentRows[0] as unknown as DriverCredentials['shipment'],
      };
    });

    await this.redis.invalidateSessionAuth(result.session.id);
    await this.publisher.sessionState(result.session.id, 'CLAIMED');
    this.logger.log(
      `Session ${result.session.reference} claimed by device ${dto.device.deviceId}`,
    );

    return {
      sessionId: result.session.id,
      reference: result.session.reference,
      accessToken: this.signDriverToken(
        result.session.id,
        dto.device.deviceId,
        result.tokenVersion,
      ),
      refreshToken,
      ingestKey: ingestKey.toString('base64'),
      expiresIn: this.config.auth.driverAccessTtlSec,
      serverTime: Math.floor(Date.now() / 1000),
      policy: {
        pingIntervalSec: result.session.ping_interval_sec,
        idleIntervalSec: result.session.idle_interval_sec,
        minDistanceM: result.session.min_distance_m,
      },
      shipment: result.shipment,
    };
  }

  /**
   * Silent re-authentication for a device whose 24 h access token expired.
   *
   * Note that the ingest key is NOT rotated here: the app may be holding
   * buffered points signed against nothing yet, and rotating mid-shift would
   * force a re-claim if the response were lost. The key dies with the session.
   */
  async refreshDriverToken(dto: DriverRefreshDto) {
    const row = await this.db.maybeOne<{
      session_id: string;
      reference: string;
      status: string;
      token_version: number;
      refresh_expires_at: Date;
      ping_interval_sec: number;
      idle_interval_sec: number;
      min_distance_m: number;
    }>(
      `SELECT d.session_id, s.reference, s.status::text, s.token_version,
              d.refresh_expires_at, s.ping_interval_sec, s.idle_interval_sec, s.min_distance_m
       FROM kh.session_devices d
       JOIN kh.tracking_sessions s ON s.id = d.session_id
       WHERE d.refresh_token_hash = $1
         AND d.device_id = $2
         AND d.revoked_at IS NULL`,
      [sha256(dto.refreshToken), dto.deviceId],
    );

    if (!row) {
      throw new UnauthorizedException({
        code: 'REFRESH_INVALID',
        message: 'Device is no longer authorised for this session',
      });
    }
    if (row.refresh_expires_at <= new Date()) {
      throw new UnauthorizedException({ code: 'REFRESH_EXPIRED', message: 'Re-scan the session code' });
    }
    if (!['CLAIMED', 'ACTIVE', 'PAUSED'].includes(row.status)) {
      throw new ForbiddenException({
        code: 'SESSION_CLOSED',
        message: `Session is ${row.status}`,
        status: row.status,
      });
    }

    /*
     * COALESCE, not assignment.
     *
     * Every build before 1.8.0 refreshes without these fields, and this row is
     * the only record of which version a phone is running. Overwriting with
     * null would mean one refresh from an old app erasing what a new one had
     * reported, and the outdated-app detector would go blind exactly where it
     * is meant to see.
     */
    await this.db.query(
      `UPDATE kh.session_devices
          SET last_seen_at = now(),
              app_version  = COALESCE($3, app_version),
              app_build    = COALESCE($4, app_build)
        WHERE session_id = $1 AND device_id = $2`,
      [row.session_id, dto.deviceId, dto.appVersion ?? null, dto.appBuild ?? null],
    );

    return {
      sessionId: row.session_id,
      reference: row.reference,
      accessToken: this.signDriverToken(row.session_id, dto.deviceId, row.token_version),
      expiresIn: this.config.auth.driverAccessTtlSec,
      serverTime: Math.floor(Date.now() / 1000),
      policy: {
        pingIntervalSec: row.ping_interval_sec,
        idleIntervalSec: row.idle_interval_sec,
        minDistanceM: row.min_distance_m,
      },
    };
  }

  /** Driver-reported lifecycle and diagnostic events. */
  async recordDriverEvent(sessionId: string, dto: DriverEventDto) {
    await this.db.query(
      `INSERT INTO kh.session_events (session_id, type, occurred_at, actor, payload, message)
       VALUES ($1, $2::kh.session_event_type, coalesce($3::timestamptz, now()), 'device', $4::jsonb, $5)`,
      [
        sessionId,
        dto.type,
        dto.occurredAt ?? null,
        JSON.stringify(dto.payload ?? {}),
        dto.message ?? null,
      ],
    );

    if (dto.type === 'STARTED') {
      await this.db.query(
        `UPDATE kh.tracking_sessions
         SET status     = CASE WHEN status = 'CLAIMED' THEN 'ACTIVE'::kh.session_status ELSE status END,
             started_at = coalesce(started_at, now())
         WHERE id = $1`,
        [sessionId],
      );
      await this.redis.invalidateSessionAuth(sessionId);
      await this.publisher.sessionState(sessionId, 'ACTIVE');
    }

    await this.publisher.sessionEvent(sessionId, dto.type, dto.message ?? null);
    return { ok: true, serverTime: Math.floor(Date.now() / 1000) };
  }

  private signDriverToken(sessionId: string, deviceId: string, tokenVersion: number): string {
    return jwt.sign(
      {
        sub: `device:${deviceId}`,
        sid: sessionId,
        did: deviceId,
        tv: tokenVersion,
        typ: 'driver-access',
        jti: randomUUID(),
      },
      this.config.auth.driverJwtSecret,
      {
        algorithm: 'HS256',
        expiresIn: this.config.auth.driverAccessTtlSec,
        issuer: 'karahoca-api',
        audience: 'driver-ingest',
      },
    );
  }
}

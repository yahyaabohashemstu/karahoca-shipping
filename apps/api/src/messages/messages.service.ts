import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { RedisService } from '../redis/redis.service';
import { RealtimePublisher } from '../realtime/realtime.publisher';
import type { DriverContext } from '../auth/auth.types';
import { MAX_MESSAGE_LENGTH, type AckMessagesDto } from './dto';

/** A session a message can still reach. Closed ones have no phone listening. */
const OPEN_STATUSES = ['ASSIGNED', 'CLAIMED', 'ACTIVE', 'PAUSED'] as const;

/** What the dashboard's thread shows. */
export interface MessageRow {
  id: string;
  body: string;
  sentAt: string;
  sentByName: string | null;
  deliveredAt: string | null;
  readAt: string | null;
}

/** What the phone is handed. Less than the dashboard sees, on purpose. */
interface DeviceMessageRow {
  id: string;
  body: string;
  sentAt: string;
  readAt: string | null;
}

/**
 * Messages from the desk to the driver of one shipment.
 *
 * The phone has no push channel — no FCM, nothing listening on a socket — so a
 * message is stored here and the phone comes to fetch it. What makes that fast
 * enough is the hint on every ingest response (`pendingMessages`): a tracking
 * phone uploads every ten to fifteen seconds and so hears about a new message
 * on its next batch. A phone that is not tracking finds out from its fifteen-
 * minute sync worker, or the moment the driver opens the app.
 */
@Injectable()
export class MessagesService {
  private readonly logger = new Logger(MessagesService.name);

  /*
   * How long an ingest may trust the cached undelivered count.
   *
   * Sending and acknowledging both delete the key, so in the ordinary case the
   * next ingest recomputes from Postgres and the hint is exact. The TTL bounds
   * the one race that is left: an ingest that read the old count from the
   * database just before a send, and writes it back just after the send
   * deleted the key. That stale zero then lives for at most this long — one
   * minute's delay on one message — instead of indefinitely.
   */
  private static readonly PENDING_TTL_SEC = 60;

  constructor(
    private readonly db: DatabaseService,
    private readonly redis: RedisService,
    private readonly publisher: RealtimePublisher,
  ) {}

  // ===========================================================================
  // Dispatcher surface
  // ===========================================================================

  async list(sessionId: string): Promise<MessageRow[]> {
    await this.requireSession(sessionId);
    return this.db.query<MessageRow & Record<string, unknown>>(
      `SELECT m.id,
              m.body,
              m.sent_at      AS "sentAt",
              u.full_name    AS "sentByName",
              m.delivered_at AS "deliveredAt",
              m.read_at      AS "readAt"
       FROM kh.driver_messages m
       LEFT JOIN kh.users u ON u.id = m.sent_by
       WHERE m.session_id = $1
       ORDER BY m.sent_at DESC
       LIMIT 100`,
      [sessionId],
    );
  }

  async send(sessionId: string, rawBody: string, userId: string): Promise<MessageRow> {
    const body = normaliseBody(rawBody);
    if (body.length === 0) {
      throw new BadRequestException({ code: 'EMPTY_MESSAGE', message: 'The message is empty' });
    }
    // Code points, not UTF-16 units, so the limit is the one Postgres applies:
    // an emoji is one character to char_length and two to String.length.
    if (Array.from(body).length > MAX_MESSAGE_LENGTH) {
      throw new BadRequestException({
        code: 'MESSAGE_TOO_LONG',
        message: `A message can be at most ${MAX_MESSAGE_LENGTH} characters`,
        maxLength: MAX_MESSAGE_LENGTH,
      });
    }

    /*
     * The status test is inside the INSERT rather than in a read before it, so
     * a dispatcher pressing Send at the moment a colleague completes the
     * delivery cannot write a message to a session nobody will ever fetch it
     * from.
     */
    const row = await this.db.maybeOne<MessageRow & Record<string, unknown>>(
      `WITH ins AS (
         INSERT INTO kh.driver_messages (session_id, body, sent_by)
         SELECT s.id, $2, $3
         FROM kh.tracking_sessions s
         WHERE s.id = $1 AND s.status = ANY($4::kh.session_status[])
         RETURNING *
       )
       SELECT ins.id,
              ins.body,
              ins.sent_at      AS "sentAt",
              u.full_name      AS "sentByName",
              ins.delivered_at AS "deliveredAt",
              ins.read_at      AS "readAt"
       FROM ins
       LEFT JOIN kh.users u ON u.id = ins.sent_by`,
      [sessionId, body, userId, OPEN_STATUSES],
    );

    if (!row) {
      const status = await this.requireSession(sessionId);
      throw new ConflictException({
        code: 'SESSION_CLOSED',
        message: `The shipment is ${status}; there is no phone left to deliver to`,
        status,
      });
    }

    await this.forgetPending(sessionId);
    this.publisher.driverMessage({
      sessionId,
      id: row.id,
      state: 'SENT',
      at: new Date(row.sentAt).toISOString(),
    });
    return row;
  }

  // ===========================================================================
  // Device surface
  // ===========================================================================

  /** The phone's copy: the last fifty, newest first. */
  async forDevice(sessionId: string) {
    const messages = await this.db.query<DeviceMessageRow & Record<string, unknown>>(
      `SELECT id, body, sent_at AS "sentAt", read_at AS "readAt"
       FROM kh.driver_messages
       WHERE session_id = $1
       ORDER BY sent_at DESC
       LIMIT 50`,
      [sessionId],
    );
    return { messages, serverTime: Math.floor(Date.now() / 1000) };
  }

  /**
   * Delivery and read receipts from the phone.
   *
   * Idempotent: a receipt for a message already marked changes nothing, so
   * the phone can resend a batch whose response it never saw. Ids belonging to
   * another session are ignored rather than rejected, which keeps one stale
   * id from costing the driver every other receipt in the request.
   */
  async acknowledge(driver: DriverContext, dto: AckMessagesDto) {
    const reads = new Map<string, string | null>();
    for (const receipt of dto.read ?? []) {
      reads.set(receipt.id.toLowerCase(), receipt.at ? new Date(receipt.at).toISOString() : null);
    }
    const delivered = [
      ...new Set((dto.delivered ?? []).map((id) => id.toLowerCase())),
    ].filter((id) => !reads.has(id));

    /*
     * Reads first, so a message that is delivered and read in one request —
     * the receipt for the delivery failed earlier, or the phone fetched it in
     * a tunnel — takes the device's time for both, rather than "delivered
     * now, read an hour ago".
     *
     * read_at is the device's moment, clamped between sent_at and now(), and
     * never earlier than the delivery already on record: a phone clock a few
     * seconds behind ours must not produce a message read before it arrived.
     */
    const readRows = reads.size
      ? await this.db.query<{ id: string; read_at: Date; delivered_at: Date }>(
          `UPDATE kh.driver_messages m
              SET read_at      = greatest(r.t, coalesce(m.delivered_at, r.t)),
                  delivered_at = coalesce(m.delivered_at, r.t),
                  delivered_to = coalesce(m.delivered_to, $4)
             FROM (
               SELECT u.id, least(now(), greatest(mm.sent_at, coalesce(u.at, now()))) AS t
               FROM unnest($2::uuid[], $3::timestamptz[]) AS u(id, at)
               JOIN kh.driver_messages mm ON mm.id = u.id
             ) r
            WHERE m.id = r.id
              AND m.session_id = $1
              AND m.read_at IS NULL
           RETURNING m.id, m.read_at, m.delivered_at`,
          [driver.sessionId, [...reads.keys()], [...reads.values()], driver.deviceId],
        )
      : [];

    const deliveredRows = delivered.length
      ? await this.db.query<{ id: string; delivered_at: Date }>(
          `UPDATE kh.driver_messages
              SET delivered_at = now(),
                  delivered_to = $3
            WHERE session_id = $1
              AND id = ANY($2::uuid[])
              AND delivered_at IS NULL
           RETURNING id, delivered_at`,
          [driver.sessionId, delivered, driver.deviceId],
        )
      : [];

    if (readRows.length || deliveredRows.length) await this.forgetPending(driver.sessionId);

    for (const row of deliveredRows) {
      this.publisher.driverMessage({
        sessionId: driver.sessionId,
        id: row.id,
        state: 'DELIVERED',
        at: row.delivered_at.toISOString(),
      });
    }
    for (const row of readRows) {
      this.publisher.driverMessage({
        sessionId: driver.sessionId,
        id: row.id,
        state: 'READ',
        at: row.read_at.toISOString(),
      });
    }

    return {
      ok: true,
      delivered: deliveredRows.length,
      read: readRows.length,
      serverTime: Math.floor(Date.now() / 1000),
    };
  }

  /**
   * How many messages are waiting for this session's phone. The ingest hint.
   *
   * Called on every ingest, so it costs one Redis GET in the steady state and
   * one indexed count per minute per session otherwise — the write path stays
   * at one database round trip for the common case.
   */
  async pendingCount(sessionId: string): Promise<number> {
    const key = this.pendingKey(sessionId);
    const cached = await this.redis.client.get(key);
    if (cached !== null) return Number(cached) || 0;

    const row = await this.db.one<{ n: number }>(
      `SELECT count(*)::int AS n
       FROM kh.driver_messages
       WHERE session_id = $1 AND delivered_at IS NULL`,
      [sessionId],
    );
    await this.redis.client.set(key, String(row.n), 'EX', MessagesService.PENDING_TTL_SEC);
    return row.n;
  }

  // ---------------------------------------------------------------------------

  private pendingKey(sessionId: string): string {
    return `drvmsg:pending:${sessionId}`;
  }

  /** Never fatal: the TTL repairs a missed delete within a minute. */
  private async forgetPending(sessionId: string): Promise<void> {
    await this.redis.client.del(this.pendingKey(sessionId)).catch((err: Error) =>
      this.logger.warn(`Could not clear the message hint for ${sessionId}: ${err.message}`),
    );
  }

  private async requireSession(sessionId: string): Promise<string> {
    const session = await this.db.maybeOne<{ status: string }>(
      `SELECT status::text FROM kh.tracking_sessions WHERE id = $1`,
      [sessionId],
    );
    if (!session) {
      throw new NotFoundException({ code: 'SESSION_NOT_FOUND', message: 'Unknown session' });
    }
    return session.status;
  }
}

/**
 * Trim the ends, and make Windows line endings into the one kind a phone
 * draws. Interior blank lines are the dispatcher's own formatting and stay.
 */
function normaliseBody(raw: string): string {
  return raw.replace(/\r\n?/g, '\n').trim();
}

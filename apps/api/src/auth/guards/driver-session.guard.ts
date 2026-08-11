import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import jwt from 'jsonwebtoken';
import { CONFIG, type AppConfig } from '../../config/configuration';
import { DatabaseService } from '../../database/database.service';
import { RedisService } from '../../redis/redis.service';
import { decryptSecret, ingestSignature, safeEqualHex } from '../../common/crypto.util';
import type {
  CachedSessionAuth,
  DriverContext,
  DriverTokenPayload,
  KhRequest,
} from '../auth.types';

/**
 * The gate every location point passes through (ADR-009).
 *
 * Order of checks is deliberate — cheapest and most likely to reject first:
 *
 *   1. JWT signature + expiry            (CPU only, no I/O)
 *   2. Session auth state                (Redis GET, Postgres only on miss)
 *   3. Token version / device binding    (in-memory comparison)
 *   4. Request rate limit                (one Redis EVAL)
 *   5. HMAC timestamp window             (CPU only)
 *   6. Nonce claim                       (one Redis SET NX)
 *   7. HMAC signature                    (CPU only, constant-time compare)
 *
 * A forged or stale token therefore costs us one signature verification, not a
 * database round trip.
 */
@Injectable()
export class DriverSessionGuard implements CanActivate {
  private readonly logger = new Logger(DriverSessionGuard.name);

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly db: DatabaseService,
    private readonly redis: RedisService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<KhRequest>();

    // ---- 1. Bearer token ----------------------------------------------------
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedException({
        code: 'MISSING_TOKEN',
        message: 'Authorization: Bearer <driver token> is required',
      });
    }

    let claims: DriverTokenPayload;
    try {
      claims = jwt.verify(header.slice(7), this.config.auth.driverJwtSecret, {
        algorithms: ['HS256'],
        audience: 'driver-ingest',
        issuer: 'karahoca-api',
      }) as DriverTokenPayload;
    } catch (err) {
      const expired = err instanceof jwt.TokenExpiredError;
      throw new UnauthorizedException({
        // The app keys off this code to decide between "refresh" and "re-claim".
        code: expired ? 'TOKEN_EXPIRED' : 'INVALID_TOKEN',
        message: expired ? 'Driver token expired' : 'Driver token is not valid',
      });
    }

    if (claims.typ !== 'driver-access' || !claims.sid || !claims.did) {
      throw new UnauthorizedException({ code: 'INVALID_TOKEN', message: 'Malformed driver token' });
    }

    // ---- 2. Session auth state ---------------------------------------------
    const auth = await this.resolveSessionAuth(claims.sid);
    if (!auth) {
      throw new UnauthorizedException({
        code: 'SESSION_NOT_FOUND',
        message: 'Tracking session no longer exists',
      });
    }

    // ---- 3. Lifecycle, then revocation, then device binding -----------------
    //
    // ORDER MATTERS for diagnosability. Closing a session revokes its device
    // AND bumps token_version, so a completed delivery would otherwise surface
    // as TOKEN_REVOKED ("you were reassigned") or SESSION_NOT_FOUND, when the
    // truthful and actionable answer is "this delivery is finished". Checking
    // the lifecycle first makes the most specific explanation win.
    if (!['CLAIMED', 'ACTIVE', 'PAUSED'].includes(auth.status)) {
      throw new ForbiddenException({
        // The app stops tracking permanently on this code rather than retrying,
        // but keeps its buffer.
        code: 'SESSION_CLOSED',
        message: `Tracking session is ${auth.status} and no longer accepts data`,
        status: auth.status,
      });
    }

    if (auth.tokenVersion !== claims.tv) {
      throw new UnauthorizedException({
        code: 'TOKEN_REVOKED',
        message: 'This tracking session was revoked or reassigned',
      });
    }

    if (!auth.deviceId || !auth.ingestKeyB64) {
      // Session is open but holds no active device: the dispatcher regenerated
      // the claim code and is waiting for a different phone.
      throw new UnauthorizedException({
        code: 'TOKEN_REVOKED',
        message: 'This device is no longer bound to the session',
      });
    }

    if (auth.deviceId !== claims.did) {
      // Two phones on one session means someone cloned the code.
      this.logger.warn(
        `Device mismatch on session ${claims.sid}: token=${claims.did} bound=${auth.deviceId}`,
      );
      throw new ForbiddenException({
        code: 'DEVICE_MISMATCH',
        message: 'This session is bound to a different device',
      });
    }

    // ---- 4. Rate limit ------------------------------------------------------
    const rate = await this.redis.consume(
      `ingest:req:${claims.sid}`,
      this.config.ingest.rateLimitRequestsPerMin,
      60,
    );
    if (!rate.allowed) {
      throw new HttpException(
        {
          code: 'RATE_LIMITED',
          message: 'Too many requests for this session',
          retryAfterSec: rate.resetSec,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const ingestKey = Buffer.from(auth.ingestKeyB64, 'base64');

    // ---- 5–7. HMAC ----------------------------------------------------------
    if (this.config.ingest.requireHmac && req.method !== 'GET') {
      await this.verifyHmac(req, claims.sid, ingestKey);
    }

    const context: DriverContext = {
      sessionId: claims.sid,
      deviceId: claims.did,
      status: auth.status,
      ingestKey,
      policy: {
        pingIntervalSec: auth.pingIntervalSec,
        idleIntervalSec: auth.idleIntervalSec,
        minDistanceM: auth.minDistanceM,
      },
    };
    req.driver = context;
    return true;
  }

  // ---------------------------------------------------------------------------

  private async verifyHmac(req: KhRequest, sessionId: string, ingestKey: Buffer): Promise<void> {
    const timestamp = req.headers['x-kh-timestamp'] as string | undefined;
    const nonce = req.headers['x-kh-nonce'] as string | undefined;
    const signature = req.headers['x-kh-signature'] as string | undefined;

    if (!timestamp || !nonce || !signature) {
      throw new UnauthorizedException({
        code: 'MISSING_SIGNATURE',
        message: 'X-KH-Timestamp, X-KH-Nonce and X-KH-Signature are required',
      });
    }

    const ts = Number.parseInt(timestamp, 10);
    if (!Number.isFinite(ts)) {
      throw new UnauthorizedException({ code: 'BAD_TIMESTAMP', message: 'X-KH-Timestamp must be epoch seconds' });
    }

    const skew = Math.abs(Math.floor(Date.now() / 1000) - ts);
    if (skew > this.config.auth.hmacSkewSec) {
      // The device corrects itself from the `serverTime` we return on every
      // response, so this should only fire for genuine replays.
      throw new UnauthorizedException({
        code: 'CLOCK_SKEW',
        message: `Request timestamp is ${skew}s off server time (limit ${this.config.auth.hmacSkewSec}s)`,
        serverTime: Math.floor(Date.now() / 1000),
      });
    }

    if (nonce.length < 8 || nonce.length > 64) {
      throw new UnauthorizedException({ code: 'BAD_NONCE', message: 'Nonce must be 8–64 characters' });
    }

    // Nonce lifetime = 2× the skew window, so a nonce cannot expire from the
    // replay cache while its timestamp is still considered fresh.
    const fresh = await this.redis.claimNonce(sessionId, nonce, this.config.auth.hmacSkewSec * 2);
    if (!fresh) {
      throw new UnauthorizedException({ code: 'REPLAY_DETECTED', message: 'Nonce has already been used' });
    }

    const rawBody = req.rawBody ?? Buffer.alloc(0);
    const expected = ingestSignature(ingestKey, timestamp, nonce, rawBody);
    if (!safeEqualHex(expected, signature)) {
      this.logger.warn(`HMAC mismatch on session ${sessionId} (${rawBody.length} body bytes)`);
      throw new UnauthorizedException({
        code: 'BAD_SIGNATURE',
        message: 'Request signature does not match the body',
      });
    }
  }

  /**
   * Redis-first read of the fields the guard needs.
   *
   * The cache TTL is short (5 min) and every mutation path calls
   * `invalidateSessionAuth`, so revocation is effectively immediate while the
   * steady-state cost of a ping stays at one Redis GET.
   */
  private async resolveSessionAuth(sessionId: string): Promise<CachedSessionAuth | null> {
    const cached = await this.redis.getSessionAuth<CachedSessionAuth>(sessionId);
    if (cached) return cached;

    const row = await this.db.maybeOne<{
      status: string;
      token_version: number;
      ping_interval_sec: number;
      idle_interval_sec: number;
      min_distance_m: number;
      device_id: string | null;
      ingest_key_enc: Buffer | null;
    }>(
      `SELECT s.status::text,
              s.token_version,
              s.ping_interval_sec,
              s.idle_interval_sec,
              s.min_distance_m,
              d.device_id,
              d.ingest_key_enc
       FROM kh.tracking_sessions s
       LEFT JOIN kh.session_devices d
              ON d.session_id = s.id AND d.revoked_at IS NULL
       WHERE s.id = $1`,
      [sessionId],
    );

    // Only a genuinely missing session resolves to null. A session with no
    // active device still resolves, so the caller can report *why* — completed,
    // cancelled, or reassigned — instead of pretending it never existed.
    if (!row) return null;

    const ingestKey =
      row.ingest_key_enc && row.device_id
        ? decryptSecret(row.ingest_key_enc, this.config.auth.ingestKeyEncryptionKey)
        : null;

    const payload: CachedSessionAuth = {
      status: row.status,
      tokenVersion: row.token_version,
      deviceId: row.device_id,
      ingestKeyB64: ingestKey ? ingestKey.toString('base64') : null,
      pingIntervalSec: row.ping_interval_sec,
      idleIntervalSec: row.idle_interval_sec,
      minDistanceM: row.min_distance_m,
    };
    await this.redis.cacheSessionAuth(sessionId, payload, 300);
    return payload;
  }
}

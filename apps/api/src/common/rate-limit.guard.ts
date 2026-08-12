import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RedisService } from '../redis/redis.service';

/* =============================================================================
   Rate limiting for the unauthenticated endpoints
   =============================================================================
   /driver/claim, /driver/token/refresh and /auth/login are @Public — the caller
   has no credential yet, by definition. Until now none of them was rate
   limited, which was verified against the deployed system: fifteen consecutive
   claims with random wrong codes all returned 404 and nothing was ever blocked.

   Guessing a code is not the real risk. The alphabet excludes I, L, O and U to
   avoid misreads over a phone line, leaving 32 characters over 8 positions —
   about 1.1 × 10^12 combinations against a handful of codes live at any moment.
   Nobody is brute-forcing that.

   The real risk is cheaper: these are unauthenticated endpoints that each do
   real database work, on a 2-vCPU box that also serves the company's public
   website. Anyone who finds them can hold the connection pool open with a loop
   and a wordlist. A limit turns that from an outage into a log line.

   Two windows per route, deliberately:
     - per IP, which catches the loop
     - per credential (the claim code, the email), which catches a distributed
       attempt against one target and cannot be evaded by rotating source
       addresses

   Fails OPEN. If Redis is unreachable the guard allows the request rather than
   locking every driver out of every session — a rate limiter that becomes an
   outage of its own is worse than the abuse it prevents.
   ========================================================================== */

export interface RateLimitSpec {
  /** Requests allowed per window, per IP. */
  perIp: number;
  /** Requests allowed per window, keyed on a field from the body. */
  perSubject?: number;
  /** Body field to key the subject window on, e.g. 'code' or 'email'. */
  subjectField?: string;
  windowSec: number;
  /** Bucket name, so two routes cannot share a counter by accident. */
  bucket: string;
}

export const RATE_LIMIT = 'kh:rateLimit';
export const RateLimit = (spec: RateLimitSpec) => SetMetadata(RATE_LIMIT, spec);

@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly log = new Logger(RateLimitGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly redis: RedisService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const spec = this.reflector.getAllAndOverride<RateLimitSpec | undefined>(RATE_LIMIT, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!spec) return true;

    const req = context.switchToHttp().getRequest();
    const ip = normaliseIp(req.ip ?? req.socket?.remoteAddress ?? 'unknown');

    const checks: Array<{ key: string; limit: number }> = [
      { key: `${spec.bucket}:ip:${ip}`, limit: spec.perIp },
    ];

    if (spec.perSubject && spec.subjectField) {
      const raw = req.body?.[spec.subjectField];
      if (typeof raw === 'string' && raw.length > 0) {
        // Normalised and truncated: a claim code is case- and separator-
        // insensitive, so "abc-defg" and "ABCDEFG" must share a counter or the
        // limit is trivially bypassed by changing the punctuation.
        const subject = raw.toLowerCase().replace(/[^a-z0-9@.]/g, '').slice(0, 64);
        checks.push({ key: `${spec.bucket}:sub:${subject}`, limit: spec.perSubject });
      }
    }

    try {
      for (const check of checks) {
        const result = await this.redis.consume(check.key, check.limit, spec.windowSec);
        if (!result.allowed) {
          this.log.warn(`rate limit hit: ${check.key} (${spec.bucket}) from ${ip}`);
          /*
           * FLAT, not wrapped in { error: … }.
           *
           * AllExceptionsFilter builds the envelope itself and reads `code` and
           * `message` off the top level of whatever an HttpException carries.
           * A nested { error: … } means it finds neither, falls back to the
           * generic "Request could not be processed", and drops the payload —
           * which is exactly what the deployed system returned on the first
           * attempt at this. Everything not named code/message/statusCode/error
           * is passed through as `details`, which is where the Android client's
           * backoff already looks for retryAfterSec (ADR-011).
           */
          throw new HttpException(
            {
              code: 'RATE_LIMITED',
              message: `Too many attempts. Retry in ${result.resetSec}s.`,
              retryAfterSec: result.resetSec,
            },
            HttpStatus.TOO_MANY_REQUESTS,
          );
        }
      }
    } catch (err) {
      if (err instanceof HttpException) throw err;
      // Redis is down. Let the request through — see the header comment.
      this.log.error(`rate limiter unavailable, failing open: ${(err as Error).message}`);
    }

    return true;
  }
}

/**
 * IPv6 addresses are allocated to end users a /64 at a time, so counting them
 * individually gives an attacker 18 quintillion free buckets. Collapse to the
 * prefix. IPv4-mapped forms (::ffff:1.2.3.4) are unwrapped first.
 */
function normaliseIp(ip: string): string {
  const v4Mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (v4Mapped) return v4Mapped[1];
  if (!ip.includes(':')) return ip;
  return ip.split(':').slice(0, 4).join(':') + '::/64';
}

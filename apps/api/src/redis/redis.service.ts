import {
  Inject,
  Injectable,
  Logger,
  OnApplicationShutdown,
} from '@nestjs/common';
import Redis, { type RedisOptions } from 'ioredis';
import { CONFIG, type AppConfig } from '../config/configuration';

/**
 * Redis holds only derived state (ADR-004). Every value here can be rebuilt
 * from Postgres, so a full flush is a performance event, not a data-loss event.
 */
@Injectable()
export class RedisService implements OnApplicationShutdown {
  private readonly logger = new Logger(RedisService.name);

  /** Command connection. */
  readonly client: Redis;
  /** Dedicated pub connection — a subscriber connection cannot issue commands. */
  readonly publisher: Redis;
  readonly subscriber: Redis;

  constructor(@Inject(CONFIG) config: AppConfig) {
    const options: RedisOptions = {
      keyPrefix: config.redis.keyPrefix,
      maxRetriesPerRequest: null, // required by BullMQ, and correct for us anyway
      enableReadyCheck: true,
      retryStrategy: (times) => Math.min(times * 200, 5_000),
      reconnectOnError: (err) => err.message.includes('READONLY'),
    };

    this.client = new Redis(config.redis.url, options);
    this.publisher = new Redis(config.redis.url, options);
    // The Socket.IO adapter needs prefix-free connections; it manages its own.
    this.subscriber = new Redis(config.redis.url, { ...options, keyPrefix: undefined });

    for (const [name, conn] of Object.entries({
      client: this.client,
      publisher: this.publisher,
      subscriber: this.subscriber,
    })) {
      conn.on('error', (err) => this.logger.error(`Redis ${name} error: ${err.message}`));
      conn.on('ready', () => this.logger.log(`Redis ${name} ready`));
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await Promise.allSettled([
      this.client.quit(),
      this.publisher.quit(),
      this.subscriber.quit(),
    ]);
  }

  // ---------------------------------------------------------------------------
  // Session auth cache — read on every single ingest request.
  // ---------------------------------------------------------------------------

  private authKey(sessionId: string): string {
    return `sess:auth:${sessionId}`;
  }

  /**
   * Generic in the payload so the cache stays agnostic of auth semantics — the
   * shape is owned by CachedSessionAuth in the auth module, not here.
   */
  async cacheSessionAuth<T>(
    sessionId: string,
    payload: T,
    ttlSec = 300,
  ): Promise<void> {
    await this.client.set(this.authKey(sessionId), JSON.stringify(payload), 'EX', ttlSec);
  }

  async getSessionAuth<T>(sessionId: string): Promise<T | null> {
    const raw = await this.client.get(this.authKey(sessionId));
    return raw ? (JSON.parse(raw) as T) : null;
  }

  /** Called on revoke / status change so the next request re-reads Postgres. */
  async invalidateSessionAuth(sessionId: string): Promise<void> {
    await this.client.del(this.authKey(sessionId));
  }

  // ---------------------------------------------------------------------------
  // HMAC replay protection
  // ---------------------------------------------------------------------------

  /**
   * Returns true if the nonce is fresh (and claims it). SET NX EX is atomic, so
   * two concurrent replays cannot both succeed.
   */
  async claimNonce(sessionId: string, nonce: string, ttlSec: number): Promise<boolean> {
    const result = await this.client.set(
      `nonce:${sessionId}:${nonce}`,
      '1',
      'EX',
      ttlSec,
      'NX',
    );
    return result === 'OK';
  }

  // ---------------------------------------------------------------------------
  // Sliding-window rate limiting
  // ---------------------------------------------------------------------------

  /**
   * Fixed-window counter with a cost, evaluated atomically.
   *
   * A fixed window can allow up to 2× the limit across a boundary; for abuse
   * protection on an internal fleet app that is entirely acceptable, and it
   * costs one round trip instead of the five a sliding log would.
   */
  async consume(
    key: string,
    limit: number,
    windowSec: number,
    cost = 1,
  ): Promise<{ allowed: boolean; remaining: number; resetSec: number }> {
    const script = `
      local current = redis.call('INCRBY', KEYS[1], ARGV[1])
      if current == tonumber(ARGV[1]) then
        redis.call('EXPIRE', KEYS[1], ARGV[2])
      end
      local ttl = redis.call('TTL', KEYS[1])
      return { current, ttl }
    `;
    const [current, ttl] = (await this.client.eval(
      script,
      1,
      `rl:${key}`,
      String(cost),
      String(windowSec),
    )) as [number, number];

    return {
      allowed: current <= limit,
      remaining: Math.max(0, limit - current),
      resetSec: ttl < 0 ? windowSec : ttl,
    };
  }

  async healthCheck(): Promise<{ ok: boolean; latencyMs: number }> {
    const started = Date.now();
    await this.client.ping();
    return { ok: true, latencyMs: Date.now() - started };
  }
}

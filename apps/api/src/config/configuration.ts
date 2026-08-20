import { randomBytes } from 'node:crypto';
import { Logger } from '@nestjs/common';

const logger = new Logger('Configuration');

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new Error(
      `Missing required environment variable ${name}. ` +
        `Copy .env.example to .env and fill it in.`,
    );
  }
  return value.trim();
}

function optional(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value.trim() === '' ? fallback : value.trim();
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n)) throw new Error(`Environment variable ${name} must be an integer, got "${raw}"`);
  return n;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

/**
 * A comma-separated list of SHA-256 certificate fingerprints, normalised to the
 * `AA:BB:…` form Google's Digital Asset Links validator insists on.
 *
 * Accepts whatever shape the operator pasted — `apksigner` prints unseparated
 * lowercase hex, `keytool` prints colon-separated uppercase — because a
 * fingerprint typed in the wrong case does not fail loudly. Android just
 * silently declines to verify the App Link, the QR opens Chrome instead of the
 * app, and nobody connects that to an environment variable.
 */
function fingerprints(name: string, fallback: string): string[] {
  return optional(name, fallback)
    .split(',')
    .map((entry) => entry.replace(/[^0-9a-fA-F]/g, '').toUpperCase())
    .filter((hex) => {
      if (hex.length === 64) return true;
      if (hex.length > 0) logger.warn(`${name}: ignoring malformed fingerprint (${hex.length} hex chars, expected 64)`);
      return false;
    })
    .map((hex) => hex.match(/../g)!.join(':'));
}

/**
 * Secrets must be at least 32 bytes of entropy. In production we refuse to
 * start without them; in development we generate an ephemeral one and shout
 * about it, because a dev environment that silently uses a weak fixed key is
 * how weak fixed keys reach production.
 */
function secret(name: string, isProd: boolean, byteLength = 32): Buffer {
  const raw = process.env[name];
  if (!raw || raw.trim() === '') {
    if (isProd) {
      throw new Error(
        `${name} is required in production. Generate one with: openssl rand -base64 48`,
      );
    }
    const generated = randomBytes(byteLength);
    logger.warn(
      `${name} is unset — generated an ephemeral development key. ` +
        `All tokens/keys become invalid on restart.`,
    );
    return generated;
  }
  const buf = /^[A-Za-z0-9+/=]+$/.test(raw) && raw.length >= 40
    ? Buffer.from(raw, 'base64')
    : Buffer.from(raw, 'utf8');
  if (buf.length < byteLength) {
    throw new Error(`${name} must decode to at least ${byteLength} bytes (got ${buf.length}).`);
  }
  return buf.subarray(0, byteLength);
}

export interface AppConfig {
  env: 'development' | 'production' | 'test';
  isProd: boolean;
  port: number;
  host: string;
  globalPrefix: string;
  publicApiUrl: string;
  corsOrigins: string[];
  trustProxy: boolean;

  database: {
    url: string;
    poolMax: number;
    poolMin: number;
    statementTimeoutMs: number;
    idleTimeoutMs: number;
    connectionTimeoutMs: number;
  };

  redis: { url: string; keyPrefix: string };

  auth: {
    userJwtSecret: Buffer;
    driverJwtSecret: Buffer;
    ingestKeyEncryptionKey: Buffer;
    userAccessTtlSec: number;
    userRefreshTtlSec: number;
    driverAccessTtlSec: number;
    driverRefreshTtlSec: number;
    hmacSkewSec: number;
    argon: { memoryCost: number; timeCost: number; parallelism: number };
  };

  ingest: {
    maxBatchPoints: number;
    maxBodyBytes: number;
    rateLimitPointsPerMin: number;
    rateLimitRequestsPerMin: number;
    requireHmac: boolean;
  };

  realtime: {
    fleetThrottleMs: number;
    maxBackfillBroadcastPoints: number;
  };

  session: {
    defaultClaimTtlMin: number;
    defaultMaxLifetimeHours: number;
    deepLinkScheme: string;
    deepLinkPackage: string;
    apkDownloadUrl: string | null;
    androidCertFingerprints: string[];
    appleAppId: string | null;
  };

  bootstrap: { adminEmail: string | null; adminPassword: string | null; adminName: string };
}

export function loadConfig(): AppConfig {
  const env = optional('NODE_ENV', 'development') as AppConfig['env'];
  const isProd = env === 'production';

  return {
    env,
    isProd,
    port: int('PORT', 4000),
    host: optional('HOST', '0.0.0.0'),
    globalPrefix: optional('API_PREFIX', 'api/v1'),
    publicApiUrl: optional('PUBLIC_API_URL', 'http://localhost:4000'),
    corsOrigins: optional('CORS_ORIGINS', 'http://localhost:3000')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    trustProxy: bool('TRUST_PROXY', isProd),

    database: {
      url: required('DATABASE_URL'),
      poolMax: int('DB_POOL_MAX', 20),
      poolMin: int('DB_POOL_MIN', 2),
      // A single ingest of 20k points must fit; anything longer is a bug.
      statementTimeoutMs: int('DB_STATEMENT_TIMEOUT_MS', 30_000),
      idleTimeoutMs: int('DB_IDLE_TIMEOUT_MS', 30_000),
      connectionTimeoutMs: int('DB_CONNECTION_TIMEOUT_MS', 10_000),
    },

    redis: {
      url: optional('REDIS_URL', 'redis://localhost:6379'),
      keyPrefix: optional('REDIS_PREFIX', 'kh:'),
    },

    auth: {
      userJwtSecret: secret('JWT_USER_SECRET', isProd),
      driverJwtSecret: secret('JWT_DRIVER_SECRET', isProd),
      ingestKeyEncryptionKey: secret('INGEST_KEY_SECRET', isProd),
      userAccessTtlSec: int('USER_ACCESS_TTL_SEC', 15 * 60),
      userRefreshTtlSec: int('USER_REFRESH_TTL_SEC', 30 * 24 * 3600),
      // 24 h: long enough that a driver on a two-day haul in a dead zone never
      // needs connectivity to keep buffering, short enough to bound exposure.
      driverAccessTtlSec: int('DRIVER_ACCESS_TTL_SEC', 24 * 3600),
      driverRefreshTtlSec: int('DRIVER_REFRESH_TTL_SEC', 14 * 24 * 3600),
      hmacSkewSec: int('HMAC_SKEW_SEC', 600),
      argon: {
        memoryCost: int('ARGON_MEMORY_KIB', 19_456), // OWASP 2024 baseline
        timeCost: int('ARGON_TIME_COST', 2),
        parallelism: int('ARGON_PARALLELISM', 1),
      },
    },

    ingest: {
      maxBatchPoints: int('INGEST_MAX_BATCH_POINTS', 5_000),
      maxBodyBytes: int('INGEST_MAX_BODY_BYTES', 8 * 1024 * 1024),
      // 250 trucks × 6 pts/min ≈ 1500/min fleet-wide; per session this is a
      // generous ceiling that still stops a runaway client.
      rateLimitPointsPerMin: int('INGEST_RATE_POINTS_PER_MIN', 20_000),
      rateLimitRequestsPerMin: int('INGEST_RATE_REQUESTS_PER_MIN', 120),
      requireHmac: bool('INGEST_REQUIRE_HMAC', true),
    },

    realtime: {
      fleetThrottleMs: int('REALTIME_FLEET_THROTTLE_MS', 1_000),
      maxBackfillBroadcastPoints: int('REALTIME_MAX_BACKFILL_POINTS', 2_000),
    },

    session: {
      defaultClaimTtlMin: int('SESSION_CLAIM_TTL_MIN', 720),
      defaultMaxLifetimeHours: int('SESSION_MAX_LIFETIME_HOURS', 72),
      deepLinkScheme: optional('DEEP_LINK_SCHEME', 'karahoca'),
      // The intent:// fallback on the QR landing page names an exact package.
      // Debug builds install as com.karahoca.tracker.debug because of
      // applicationIdSuffix, so a hardcoded release package makes the QR
      // silently fail to open the app during field testing.
      deepLinkPackage: optional('DEEP_LINK_PACKAGE', 'com.karahoca.tracker'),
      apkDownloadUrl: process.env.APK_DOWNLOAD_URL?.trim() || null,
      /*
       * Signing certificates allowed to claim https://<host>/t/* as an Android
       * App Link. Published at /.well-known/assetlinks.json; Android verifies
       * it at install time and only then will a camera app open the QR code
       * straight into the driver app instead of into Chrome.
       *
       * The default is the fingerprint of the current release keystore. It is a
       * *list* because re-keying is a two-step operation: publish the new
       * fingerprint alongside the old one, then ship the re-signed APK. Drop
       * the old entry only once no phone still runs the old build.
       */
      androidCertFingerprints: fingerprints(
        'ANDROID_CERT_SHA256',
        '1A:2B:12:86:9E:96:9C:E6:07:AE:59:78:73:A8:83:C2:4A:D9:3E:C0:DF:C3:D8:24:3F:C0:07:C7:E8:3E:30:79',
      ),
      /*
       * The iOS half of the same idea — `<TeamID>.<BundleID>`, for example
       * `ABCDE12345.com.karahoca.tracker`.
       *
       * No default, deliberately. The Team ID is issued by Apple to this
       * company and cannot be guessed, and publishing a placeholder would be
       * worse than publishing nothing: Apple's CDN caches what it fetches, so a
       * wrong appID has to age out before a corrected one is believed. Left
       * unset the endpoint 404s, which is what a site with no iOS app should
       * return.
       */
      appleAppId: process.env.APPLE_APP_ID?.trim() || null,
    },

    bootstrap: {
      adminEmail: process.env.ADMIN_EMAIL?.trim() || null,
      adminPassword: process.env.ADMIN_PASSWORD?.trim() || null,
      adminName: optional('ADMIN_NAME', 'KaraHoca Admin'),
    },
  };
}

export const CONFIG = Symbol('KH_CONFIG');

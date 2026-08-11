import type { FastifyRequest } from 'fastify';

export type UserRole = 'ADMIN' | 'DISPATCHER' | 'VIEWER';

/** Claims in a dispatcher access token. */
export interface UserTokenPayload {
  sub: string; // user id
  email: string;
  role: UserRole;
  typ: 'access';
  iat: number;
  exp: number;
}

/**
 * Claims in a driver access token.
 *
 * There is no user identity here on purpose (ADR-009): the token is a
 * capability scoped to exactly one tracking session on exactly one device.
 */
export interface DriverTokenPayload {
  sub: string; // `device:${deviceId}`
  sid: string; // tracking session id
  did: string; // device id
  tv: number; // session token_version — bump to revoke
  typ: 'driver-access';
  aud: 'driver-ingest';
  iat: number;
  exp: number;
}

export interface AuthenticatedUser {
  id: string;
  email: string;
  role: UserRole;
}

/** Resolved, verified driver context attached to the request by the guard. */
export interface DriverContext {
  sessionId: string;
  deviceId: string;
  status: string;
  ingestKey: Buffer;
  policy: {
    pingIntervalSec: number;
    idleIntervalSec: number;
    minDistanceM: number;
  };
}

/**
 * Shape cached in Redis; never contains anything Postgres cannot rebuild.
 *
 * `deviceId` / `ingestKeyB64` are nullable because a session can legitimately
 * exist with no active device — it was completed, cancelled, or reassigned.
 * Resolving those sessions anyway is what lets the guard answer "this delivery
 * is finished" instead of the misleading "no such session".
 */
export interface CachedSessionAuth {
  status: string;
  tokenVersion: number;
  deviceId: string | null;
  ingestKeyB64: string | null;
  pingIntervalSec: number;
  idleIntervalSec: number;
  minDistanceM: number;
}

export interface KhRequest extends FastifyRequest {
  /** Raw request bytes, preserved by the JSON parser for HMAC verification. */
  rawBody?: Buffer;
  user?: AuthenticatedUser;
  driver?: DriverContext;
}

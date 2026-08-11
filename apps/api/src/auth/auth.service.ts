import {
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Algorithm, hash as argonHash, verify as argonVerify } from '@node-rs/argon2';
import jwt from 'jsonwebtoken';
import { CONFIG, type AppConfig } from '../config/configuration';
import { DatabaseService } from '../database/database.service';
import { randomToken, sha256 } from '../common/crypto.util';
import type { AuthenticatedUser, UserRole } from './auth.types';

interface UserRow {
  id: string;
  email: string;
  full_name: string;
  password_hash: string;
  role: UserRole;
  is_active: boolean;
  failed_logins: number;
  locked_until: Date | null;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  user: AuthenticatedUser & { fullName: string };
}

const MAX_FAILED_LOGINS = 8;
const LOCKOUT_MINUTES = 15;

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly db: DatabaseService,
  ) {}

  async hashPassword(plain: string): Promise<string> {
    return argonHash(plain, {
      algorithm: Algorithm.Argon2id,
      memoryCost: this.config.auth.argon.memoryCost,
      timeCost: this.config.auth.argon.timeCost,
      parallelism: this.config.auth.argon.parallelism,
    });
  }

  async login(
    email: string,
    password: string,
    meta: { ip?: string; userAgent?: string },
  ): Promise<TokenPair> {
    const user = await this.db.maybeOne<UserRow>(
      `SELECT id, email::text, full_name, password_hash, role::text AS role,
              is_active, failed_logins, locked_until
       FROM kh.users WHERE email = $1`,
      [email],
    );

    // Always spend the cost of one verification, even for an unknown e-mail, so
    // response time cannot be used to enumerate accounts.
    const storedHash =
      user?.password_hash ??
      '$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHRzYWx0$0000000000000000000000000000000000000000000';

    let passwordOk = false;
    try {
      passwordOk = await argonVerify(storedHash, password);
    } catch {
      passwordOk = false;
    }

    if (!user || !user.is_active) {
      throw new UnauthorizedException({ code: 'INVALID_CREDENTIALS', message: 'Invalid e-mail or password' });
    }

    if (user.locked_until && user.locked_until > new Date()) {
      throw new ForbiddenException({
        code: 'ACCOUNT_LOCKED',
        message: `Too many failed attempts. Try again after ${user.locked_until.toISOString()}`,
      });
    }

    if (!passwordOk) {
      const failed = user.failed_logins + 1;
      await this.db.query(
        `UPDATE kh.users
         SET failed_logins = $2::int,
             locked_until  = CASE WHEN $2::int >= $3::int
                                  THEN now() + make_interval(mins => $4::int)
                                  ELSE NULL END
         WHERE id = $1`,
        [user.id, failed, MAX_FAILED_LOGINS, LOCKOUT_MINUTES],
      );
      this.logger.warn(`Failed login for ${email} (attempt ${failed})`);
      throw new UnauthorizedException({ code: 'INVALID_CREDENTIALS', message: 'Invalid e-mail or password' });
    }

    await this.db.query(
      `UPDATE kh.users SET failed_logins = 0, locked_until = NULL, last_login_at = now() WHERE id = $1`,
      [user.id],
    );

    return this.issueTokens(user, randomUUID(), meta);
  }

  /**
   * Refresh-token rotation with reuse detection.
   *
   * Every refresh mints a new token in the same *family*. Presenting a token
   * that has already been rotated means it was stolen and replayed, so the
   * entire family is revoked and the human has to sign in again.
   */
  async refresh(token: string, meta: { ip?: string; userAgent?: string }): Promise<TokenPair> {
    const tokenHash = sha256(token);

    const row = await this.db.maybeOne<{
      id: string;
      user_id: string;
      family_id: string;
      revoked_at: Date | null;
      expires_at: Date;
    }>(
      `SELECT id, user_id, family_id, revoked_at, expires_at
       FROM kh.refresh_tokens WHERE token_hash = $1`,
      [tokenHash],
    );

    if (!row) {
      throw new UnauthorizedException({ code: 'INVALID_REFRESH', message: 'Unknown refresh token' });
    }

    if (row.revoked_at) {
      await this.db.query(
        `UPDATE kh.refresh_tokens SET revoked_at = now()
         WHERE family_id = $1 AND revoked_at IS NULL`,
        [row.family_id],
      );
      this.logger.error(
        `Refresh token reuse detected for user ${row.user_id}; family ${row.family_id} revoked`,
      );
      throw new UnauthorizedException({
        code: 'REFRESH_REUSED',
        message: 'Session security violation — please sign in again',
      });
    }

    if (row.expires_at <= new Date()) {
      throw new UnauthorizedException({ code: 'REFRESH_EXPIRED', message: 'Session expired' });
    }

    const user = await this.db.maybeOne<UserRow>(
      `SELECT id, email::text, full_name, password_hash, role::text AS role,
              is_active, failed_logins, locked_until
       FROM kh.users WHERE id = $1`,
      [row.user_id],
    );
    if (!user || !user.is_active) {
      throw new UnauthorizedException({ code: 'USER_DISABLED', message: 'Account is disabled' });
    }

    await this.db.query(`UPDATE kh.refresh_tokens SET revoked_at = now() WHERE id = $1`, [row.id]);
    return this.issueTokens(user, row.family_id, meta);
  }

  async logout(token: string): Promise<void> {
    const row = await this.db.maybeOne<{ family_id: string }>(
      `SELECT family_id FROM kh.refresh_tokens WHERE token_hash = $1`,
      [sha256(token)],
    );
    if (row) {
      await this.db.query(
        `UPDATE kh.refresh_tokens SET revoked_at = now()
         WHERE family_id = $1 AND revoked_at IS NULL`,
        [row.family_id],
      );
    }
  }

  private async issueTokens(
    user: UserRow,
    familyId: string,
    meta: { ip?: string; userAgent?: string },
  ): Promise<TokenPair> {
    const accessToken = jwt.sign(
      { sub: user.id, email: user.email, role: user.role, typ: 'access' },
      this.config.auth.userJwtSecret,
      {
        algorithm: 'HS256',
        expiresIn: this.config.auth.userAccessTtlSec,
        issuer: 'karahoca-api',
        audience: 'karahoca-admin',
      },
    );

    const refreshToken = randomToken(48);
    const expiresAt = new Date(Date.now() + this.config.auth.userRefreshTtlSec * 1000);

    await this.db.query(
      `INSERT INTO kh.refresh_tokens (user_id, token_hash, family_id, user_agent, ip, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        user.id,
        sha256(refreshToken),
        familyId,
        meta.userAgent?.slice(0, 400) ?? null,
        meta.ip ?? null,
        expiresAt,
      ],
    );

    return {
      accessToken,
      refreshToken,
      expiresIn: this.config.auth.userAccessTtlSec,
      user: { id: user.id, email: user.email, role: user.role, fullName: user.full_name },
    };
  }
}

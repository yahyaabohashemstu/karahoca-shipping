import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import jwt from 'jsonwebtoken';
import { CONFIG, type AppConfig } from '../../config/configuration';
import { IS_PUBLIC_KEY, ROLES_KEY } from '../decorators';
import type { KhRequest, UserRole, UserTokenPayload } from '../auth.types';

/**
 * Global guard for the dispatcher-facing API.
 *
 * Registered with APP_GUARD, so every route is protected by default and must
 * opt out with @Public(). Fail-closed beats fail-open: forgetting a decorator
 * yields a 401, not an open endpoint.
 */
@Injectable()
export class UserAuthGuard implements CanActivate {
  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly reflector: Reflector,
  ) {}

  canActivate(ctx: ExecutionContext): boolean {
    if (ctx.getType() !== 'http') return true;

    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (isPublic) return true;

    const req = ctx.switchToHttp().getRequest<KhRequest>();
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedException({ code: 'MISSING_TOKEN', message: 'Authentication required' });
    }

    let claims: UserTokenPayload;
    try {
      claims = jwt.verify(header.slice(7), this.config.auth.userJwtSecret, {
        algorithms: ['HS256'],
        issuer: 'karahoca-api',
        audience: 'karahoca-admin',
      }) as UserTokenPayload;
    } catch (err) {
      throw new UnauthorizedException({
        code: err instanceof jwt.TokenExpiredError ? 'TOKEN_EXPIRED' : 'INVALID_TOKEN',
        message: 'Session expired, please sign in again',
      });
    }

    if (claims.typ !== 'access') {
      throw new UnauthorizedException({ code: 'INVALID_TOKEN', message: 'Refresh tokens cannot access the API' });
    }

    req.user = { id: claims.sub, email: claims.email, role: claims.role };

    const required = this.reflector.getAllAndOverride<UserRole[]>(ROLES_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (required?.length && !required.includes(claims.role)) {
      throw new ForbiddenException({
        code: 'INSUFFICIENT_ROLE',
        message: `Requires one of: ${required.join(', ')}`,
      });
    }

    return true;
  }
}

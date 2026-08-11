import { SetMetadata, createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { AuthenticatedUser, DriverContext, KhRequest, UserRole } from './auth.types';

export const IS_PUBLIC_KEY = 'kh:isPublic';
export const ROLES_KEY = 'kh:roles';

/** Opt a route out of the global dispatcher auth guard. */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

/** Restrict a route to specific dispatcher roles. */
export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES_KEY, roles);

export const CurrentUser = createParamDecorator(
  (field: keyof AuthenticatedUser | undefined, ctx: ExecutionContext) => {
    const req = ctx.switchToHttp().getRequest<KhRequest>();
    const user = req.user;
    if (!user) return undefined;
    return field ? user[field] : user;
  },
);

export const Driver = createParamDecorator(
  (field: keyof DriverContext | undefined, ctx: ExecutionContext) => {
    const req = ctx.switchToHttp().getRequest<KhRequest>();
    const driver = req.driver;
    if (!driver) return undefined;
    return field ? driver[field] : driver;
  },
);

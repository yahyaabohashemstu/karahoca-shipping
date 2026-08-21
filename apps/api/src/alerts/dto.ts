import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsUUID,
  Max,
  Min,
} from 'class-validator';

/** Mirrors kh.alert_kind. Kept in sync by hand; the enum is not generated. */
export const ALERT_KINDS = [
  'SIGNAL_LOST',
  'ARRIVED',
  'BATTERY_LOW',
  'MOCK_LOCATION',
  'NOT_STARTED',
  'STOPPED_TOO_LONG',
  'PAUSED_TOO_LONG',
] as const;

export const ALERT_SEVERITIES = ['INFO', 'WARNING', 'CRITICAL'] as const;

/**
 * Query-string booleans, parsed rather than coerced.
 *
 * The rest of the codebase writes `@Type(() => Boolean)`, which runs
 * `Boolean('false') === true`. That is harmless on a flag a client only ever
 * sends when it means "on", but this one hangs off a checkbox: a dispatcher
 * un-ticking "sadece onaylanmamışlar" sends `?unacknowledgedOnly=false`, and
 * with the coercing form that would switch the filter ON.
 */
const parseFlag = ({ value }: { value: unknown }) =>
  value === undefined ? undefined : value === true || value === 'true' || value === '1';

export class ListAlertsQueryDto {
  @IsOptional() @IsIn(ALERT_KINDS)
  kind?: string;

  @IsOptional() @IsIn(ALERT_SEVERITIES)
  severity?: string;

  @IsOptional() @IsUUID()
  sessionId?: string;

  /** The "needs a human" filter behind the badge. */
  @IsOptional() @Transform(parseFlag) @IsBoolean()
  unacknowledgedOnly?: boolean;

  /**
   * How far back to include alerts the world already resolved. 0 means open
   * ones only.
   *
   * Recently-resolved rows are in the default view on purpose: a truck that
   * went dark six times on one run looks fine at every single moment you check
   * it, and only the history shows the pattern.
   */
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(720)
  resolvedWithinHours?: number;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200)
  limit?: number;

  @IsOptional() @Type(() => Number) @IsInt() @Min(0)
  offset?: number;
}

export class AlertCountQueryDto {
  /**
   * Same window as the list, and defaulted the same way, because a badge that
   * counts something the list does not show sends a dispatcher hunting for an
   * alert that is not there.
   */
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(720)
  resolvedWithinHours?: number;
}

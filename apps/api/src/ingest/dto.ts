import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDefined,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/**
 * Wire shape of one GPS fix. **Documentation and Swagger only** — deliberately
 * not used as a validation target by either ingest endpoint.
 *
 * Running class-validator over every element costs ~150 ms of reflection per
 * 5,000-point request, to perform validation the database already does
 * set-based inside `kh.ingest_points`. The service runs a fast structural
 * normaliser instead (`IngestService.normalisePoints`), whose only job is to
 * guarantee every value handed to `jsonb_to_recordset` is castable — a single
 * `"lat": "abc"` would otherwise abort the whole batch with a Postgres cast
 * error and cost the driver 5,000 points.
 *
 * Keeping one validation regime for both `/ingest/ping` and `/ingest/batch`
 * matters more than the decorators: a ping is a batch of one and must not take
 * a different code path.
 */
export class LocationPointDto {
  /** Device-generated ULID. The idempotency key — retries are free. */
  @IsString() @MaxLength(64)
  id!: string;

  /** GPS-derived UTC, ISO-8601 or epoch millis. */
  recordedAt!: string | number;

  @IsNumber() @Min(-90) @Max(90)
  lat!: number;

  @IsNumber() @Min(-180) @Max(180)
  lon!: number;

  @IsOptional() @IsNumber() @Min(0)
  accuracy?: number;

  @IsOptional() @IsNumber()
  altitude?: number;

  @IsOptional() @IsNumber() @Min(0)
  verticalAccuracy?: number;

  @IsOptional() @IsNumber() @Min(0) @Max(200)
  speed?: number;

  @IsOptional() @IsNumber() @Min(0)
  speedAccuracy?: number;

  @IsOptional() @IsNumber() @Min(0) @Max(360)
  bearing?: number;

  /** SystemClock.elapsedRealtimeNanos — monotonic, survives clock changes. */
  @IsOptional() @IsNumber()
  elapsedRealtimeNs?: number;

  @IsOptional() @IsInt() @Min(0) @Max(100)
  batteryPct?: number;

  @IsOptional() @IsBoolean()
  isCharging?: boolean;

  @IsOptional() @IsBoolean()
  isMock?: boolean;

  @IsOptional() @IsInt() @Min(0) @Max(64)
  satellites?: number;

  @IsOptional() @IsString() @MaxLength(24)
  provider?: string;

  @IsOptional() @IsString() @MaxLength(24)
  networkType?: string;

  @IsOptional() @IsInt()
  seq?: number;
}

export class IngestBatchDto {
  /**
   * Client-generated UUID for this upload. Sending the same batchId twice is
   * safe — the points collapse on their own primary key and the batch receipt
   * is ON CONFLICT DO NOTHING.
   */
  @IsOptional() @IsUUID()
  batchId?: string;

  /** True when this is buffered data being flushed, not a live ping. */
  @IsOptional() @IsBoolean()
  offline?: boolean;

  /** How many points remain in the device buffer after this batch. */
  @IsOptional() @IsInt() @Min(0)
  bufferRemaining?: number;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20000)
  points!: unknown[];
}

export class IngestPingDto {
  @IsOptional() @IsUUID()
  batchId?: string;

  /**
   * Intentionally an unvalidated object, exactly like `points` above.
   *
   * Two reasons. First, `whitelist: true` strips any property without a
   * *validation* decorator, so a bare `@Type(() => LocationPointDto)` would
   * silently delete this field and the handler would throw. Second — and more
   * importantly — a ping must go down the identical code path as a batch of
   * one: `normalisePoints` then `kh.ingest_points`. Validating it differently
   * here would create two divergent validation regimes for the same data.
   */
  @IsDefined()
  @IsObject()
  point!: Record<string, unknown>;
}

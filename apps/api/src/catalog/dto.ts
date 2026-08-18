import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEmail,
  IsISO8601,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

export class ListQueryDto {
  @IsOptional() @IsString() @MaxLength(40)
  status?: string;

  @IsOptional() @IsString() @MaxLength(120)
  search?: string;

  @IsOptional() @Type(() => Boolean) @IsBoolean()
  untracked?: boolean;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200)
  limit?: number;

  @IsOptional() @Type(() => Number) @IsInt() @Min(0)
  offset?: number;
}

export class OrderItemDto {
  @IsString() @Length(1, 64)
  sku!: string;

  @IsOptional() @IsString() @MaxLength(240)
  description?: string;

  @IsNumber() @Min(0)
  quantity!: number;

  @IsOptional() @IsString() @MaxLength(16)
  unit?: string;

  @IsOptional() @IsNumber() @Min(0)
  weightKg?: number;
}

export class CreateOrderDto {
  @IsString() @Length(1, 64)
  orderNumber!: string;

  @IsUUID()
  customerId!: string;

  @IsOptional() @IsString() @MaxLength(240)
  destinationLabel?: string;

  @IsOptional() @IsString() @MaxLength(1000)
  destinationAddress?: string;

  @IsOptional() @IsNumber() @Min(-90) @Max(90)
  destinationLat?: number;

  @IsOptional() @IsNumber() @Min(-180) @Max(180)
  destinationLon?: number;

  @IsOptional() @IsInt() @Min(25) @Max(20000)
  destinationRadiusM?: number;

  @IsOptional() @IsNumber() @Min(0)
  totalWeightKg?: number;

  @IsOptional() @IsInt() @Min(0)
  palletCount?: number;

  @IsOptional() @IsString() @MaxLength(500)
  cargoSummary?: string;

  @IsOptional() @IsISO8601()
  plannedDispatchAt?: string;

  @IsOptional() @IsISO8601()
  plannedDeliveryAt?: string;

  @IsOptional() @IsObject()
  externalRef?: Record<string, unknown>;

  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => OrderItemDto)
  items?: OrderItemDto[];
}

/**
 * What a dispatcher edits at dispatch time: who the load is going to, and what
 * is actually on the truck.
 *
 * Everything is optional and `undefined` means "leave it alone" — except
 * `items`, where an empty array explicitly clears the list. That distinction
 * matters: a form that omits items must not silently delete them.
 */
export class UpdateOrderDto {
  @IsOptional() @IsUUID()
  customerId?: string;

  @IsOptional() @IsString() @MaxLength(500)
  cargoSummary?: string;

  @IsOptional() @IsNumber() @Min(0)
  totalWeightKg?: number;

  @IsOptional() @IsInt() @Min(0)
  palletCount?: number;

  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => OrderItemDto)
  items?: OrderItemDto[];
}

export class CreateShippingCompanyDto {
  @IsString() @Length(2, 32)
  code!: string;

  @IsString() @Length(2, 200)
  name!: string;

  @IsOptional() @IsString() @MaxLength(32)
  taxNumber?: string;

  @IsOptional() @IsString() @MaxLength(120)
  contactName?: string;

  @IsOptional() @IsString() @MaxLength(40)
  contactPhone?: string;

  @IsOptional() @IsEmail()
  contactEmail?: string;

  @IsOptional() @IsNumber() @Min(0)
  slaHours?: number;

  @IsOptional() @IsString() @MaxLength(2000)
  notes?: string;

}

/**
 * Edit a consignee.
 *
 * Exists because of a gap that made the whole default-destination idea
 * unreachable: customers could be created with a location and never given one
 * afterwards. Every consignee in production predates the picker, so without an
 * update path the feature would only ever apply to customers created from
 * today onward — which is nobody who is currently shipping.
 *
 * Every field optional, and `null` distinguished from absent where clearing is
 * a real intent: omitting `lat` leaves the point alone, sending null removes
 * it. A dispatcher who learns the pin is wrong needs to be able to take it off
 * rather than leave a confidently wrong arrival radius in place.
 */
export class UpdateCustomerDto {
  @IsOptional() @IsString() @Length(2, 200)
  name?: string;

  @IsOptional() @IsString() @MaxLength(120)
  contactName?: string;

  @IsOptional() @IsString() @MaxLength(40)
  contactPhone?: string;

  @IsOptional() @IsEmail()
  contactEmail?: string;

  @IsOptional() @IsString() @MaxLength(500)
  addressLine?: string;

  @IsOptional() @IsString() @MaxLength(120)
  city?: string;

  @IsOptional() @IsString() @MaxLength(120)
  region?: string;

  @IsOptional() @IsString() @Length(2, 2)
  countryCode?: string;

  @IsOptional() @ValidateIf((_, v) => v !== null) @IsNumber() @Min(-90) @Max(90)
  lat?: number | null;

  @IsOptional() @ValidateIf((_, v) => v !== null) @IsNumber() @Min(-180) @Max(180)
  lon?: number | null;

  @IsOptional() @ValidateIf((_, v) => v !== null) @IsInt() @Min(25) @Max(20_000)
  defaultRadiusM?: number | null;

  @IsOptional() @IsString() @MaxLength(2000)
  notes?: string;

  @IsOptional() @IsBoolean()
  isActive?: boolean;
}

export class CreateVehicleDto {
  @IsUUID()
  shippingCompanyId!: string;

  @IsString() @Length(2, 24)
  plate!: string;

  @IsOptional() @IsString() @MaxLength(120)
  makeModel?: string;

  @IsOptional() @IsInt() @Min(0)
  capacityKg?: number;
}

export class CreateDriverDto {
  @IsUUID()
  shippingCompanyId!: string;

  @IsString() @Length(2, 120)
  fullName!: string;

  @IsString() @Length(5, 40)
  phone!: string;

  @IsOptional() @IsString() @Length(4, 4)
  nationalIdLast4?: string;
}

export class CreateCustomerDto {
  @IsString() @Length(2, 32)
  code!: string;

  @IsString() @Length(2, 200)
  name!: string;

  @IsOptional() @IsString() @MaxLength(120)
  contactName?: string;

  @IsOptional() @IsString() @MaxLength(40)
  contactPhone?: string;

  @IsOptional() @IsEmail()
  contactEmail?: string;

  @IsOptional() @IsString() @MaxLength(500)
  addressLine?: string;

  @IsOptional() @IsString() @MaxLength(120)
  city?: string;

  @IsOptional() @IsString() @MaxLength(120)
  region?: string;

  @IsOptional() @IsString() @Length(2, 2)
  countryCode?: string;

  @IsOptional() @IsNumber() @Min(-90) @Max(90)
  lat?: number;

  @IsOptional() @IsNumber() @Min(-180) @Max(180)
  lon?: number;

  @IsOptional() @IsString() @MaxLength(2000)
  notes?: string;

  /**
   * Arrival radius for this consignee's own gate, in metres.
   *
   * Bounded here as well as by the column's CHECK, because a 400 naming the
   * field is a usable answer and a 500 from a constraint violation is not.
   */
  @IsOptional() @IsInt() @Min(25) @Max(20_000)
  defaultRadiusM?: number;
}

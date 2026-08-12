import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEmail,
  IsInt,
  IsISO8601,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  MaxLength,
  Min,
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
}

import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

/** Longest message, after trimming. Mirrors ck_driver_messages_body. */
export const MAX_MESSAGE_LENGTH = 500;

export class SendMessageDto {
  /*
   * Bounded loosely here and exactly in the service.
   *
   * The rule is on the TRIMMED text — a message pasted with a trailing newline
   * at 501 characters is a 500-character message — and class-validator sees
   * the raw string. The cap here only stops a megabyte reaching the trim.
   */
  @IsString() @MaxLength(4 * MAX_MESSAGE_LENGTH)
  body!: string;
}

/** One read receipt. `at` is the moment the driver pressed the button. */
export class ReadReceiptDto {
  @IsUUID()
  id!: string;

  /*
   * Epoch milliseconds on the phone's server-corrected clock.
   *
   * Optional because the receipt is still true without it — it just gets the
   * time it arrived instead of the time it happened. The service clamps it
   * between sent_at and now(), so a phone with a clock in 2031 cannot read a
   * message before it was written.
   */
  @IsOptional() @IsInt() @Min(0)
  at?: number;
}

export class AckMessagesDto {
  @IsOptional() @IsArray() @ArrayMaxSize(100) @IsUUID(undefined, { each: true })
  delivered?: string[];

  /*
   * @ValidateNested + @Type, not @Type alone: the global ValidationPipe runs
   * with whitelist: true, and a property carrying only a class-transformer
   * decorator is stripped as though it were unknown. See ClaimSessionDto.
   */
  @IsOptional() @IsArray() @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => ReadReceiptDto)
  read?: ReadReceiptDto[];
}

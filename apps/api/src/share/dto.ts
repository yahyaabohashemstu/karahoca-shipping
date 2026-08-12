import { IsBoolean, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export class CreateShareLinkDto {
  /**
   * The full route trace, off unless asked for.
   *
   * A consignee is entitled to know where their goods are. The minute-by-minute
   * path a third party's driver took to get there is a different thing — it
   * shows the stops, the detours and the overnight, and in several
   * jurisdictions it is that driver's personal data. Whoever mints the link has
   * to make that decision deliberately, which is what a default of false means.
   */
  @IsOptional() @IsBoolean()
  showRoute?: boolean;

  /** Driver name, phone and plate. Off for the same reason as showRoute. */
  @IsOptional() @IsBoolean()
  showDriver?: boolean;

  /**
   * Who this link was given to — "Alıcı firma", "Gümrük müşaviri".
   *
   * A session can carry several links and revocation is per link, so without a
   * label the dispatcher revoking one of four has no way to tell which is which
   * and will either revoke the wrong one or revoke them all.
   */
  @IsOptional() @IsString() @MaxLength(120)
  label?: string;

  /**
   * Override the derived expiry. Capped at 90 days: a capability token handed
   * to an outside party with a longer life than the commercial relationship is
   * a credential nobody is tracking any more.
   */
  @IsOptional() @IsInt() @Min(1) @Max(2160)
  expiresInHours?: number;
}

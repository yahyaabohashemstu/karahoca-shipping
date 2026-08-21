import { Controller, Get, Header, HttpCode, Post } from '@nestjs/common';
import { CurrentUser, Public, Roles } from '../auth/decorators';
import { ReleaseService } from './release.service';

/**
 * The two ends of a release: what phones read, and the button that fills it.
 *
 * Both live here rather than in HandoffController because they are one
 * decision seen from two sides — the dispatcher presses, and every phone in the
 * fleet reads the result — and splitting them across files is how the ordering
 * guarantees in ReleaseService.announce get lost.
 */
@Controller()
export class ReleaseController {
  constructor(private readonly releases: ReleaseService) {}

  /**
   * What the driver app checks, six-hourly.
   *
   * Served by the API rather than by the nginx sidecar that owns the rest of
   * /downloads, because whether a build has been *released* is a decision the
   * API holds. Traefik routes this one path here; everything else under
   * /downloads, the APK included, still comes straight off disk.
   *
   * Public: the phone reading it has a session token, but the manifest is the
   * same for everybody and requiring auth would mean a driver whose token has
   * expired can never learn about the release that fixes it.
   *
   * no-store, not the ten minutes the install page uses. This file is the
   * mechanism by which a release reaches the fleet, and a cache between us and
   * a phone is a cache that can hold a fix back.
   */
  @Public()
  @Get('downloads/latest.json')
  @Header('Content-Type', 'application/json; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  manifest() {
    return this.releases.manifestForDevices();
  }

  /**
   * What the button needs to know: what the fleet has, and what is waiting.
   *
   * ADMIN only, like the release itself.
   */
  @Roles('ADMIN')
  @Get('app/release')
  async status() {
    const [live, staged] = await Promise.all([this.releases.live(), this.releases.staged()]);
    return {
      live,
      staged,
      // Computed here so the page does not have to reimplement the comparison
      // and get it subtly different.
      canAnnounce: !!staged && (!live || staged.versionCode > live.versionCode),
    };
  }

  /**
   * "نزل النسخة الجديدة" — put the staged build in front of the drivers.
   *
   * ADMIN rather than ADMIN+DISPATCHER, which is how every other write in this
   * API is scoped. This one is not about a shipment; it puts a notification on
   * every phone in the fleet at once and starts a 24 MB download on each one
   * that accepts it.
   *
   * Phones already carrying the released build are not told anything: the app
   * only raises the banner when the manifest's versionCode is above its own.
   */
  @Roles('ADMIN')
  @Post('app/release/announce')
  @HttpCode(200)
  announce(@CurrentUser('email') email: string | undefined) {
    return this.releases.announce(email ?? null);
  }
}

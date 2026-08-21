import { NotFoundException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { HandoffController } from './handoff.controller';
import type { AppConfig } from '../config/configuration';
import type { ReleaseService } from '../release/release.service';

/*
 * The two association documents, which are the only reason a QR code opens the
 * app instead of a browser.
 *
 * Both are easy to get subtly wrong and impossible to notice: a malformed or
 * absent document does not error, it just means every scanned code lands in
 * Chrome or Safari and the driver types the session code by hand. Nothing in
 * the product reports that as a failure.
 */

function controllerWith(appleAppId: string | null): HandoffController {
  const config = {
    session: {
      deepLinkPackage: 'com.karahoca.tracker',
      androidCertFingerprints: ['1A:2B:12:86'],
      appleAppId,
    },
  } as unknown as AppConfig;
  // These two documents never touch the release state; the stub only exists to
  // satisfy the constructor.
  const releases = { live: async () => null } as unknown as ReleaseService;
  return new HandoffController(config, releases);
}

describe('apple-app-site-association', () => {
  it('404s while no Team ID is configured', () => {
    /*
     * The correct answer for a host with no iOS app. A placeholder would be
     * worse than nothing — Apple's CDN caches what it fetches, so a wrong appID
     * has to age out before a corrected one is believed.
     */
    expect(() => controllerWith(null).appleAppSiteAssociation()).toThrow(NotFoundException);
  });

  it('claims the driver hand-off path and nothing else once configured', () => {
    const doc = controllerWith('ABCDE12345.com.karahoca.tracker').appleAppSiteAssociation();
    const details = doc.applinks.details;
    expect(details).toHaveLength(1);
    expect(details[0].appIDs).toEqual(['ABCDE12345.com.karahoca.tracker']);

    const paths = details[0].components.map((c) => c['/']);
    expect(paths).toContain('/t/*');
    /*
     * The consignee's links must NOT be claimed. Those are opened by customers
     * who do not have the driver app; claiming /s/* would route them into an
     * app they have never installed, or on a phone that does have it, into a
     * driver screen they have no business seeing.
     */
    expect(paths.some((p) => p.startsWith('/s'))).toBe(false);
  });
});

describe('assetlinks.json', () => {
  it('names the package and the release fingerprint', () => {
    const links = controllerWith(null).assetLinks();
    expect(links).toHaveLength(1);
    expect(links[0].relation).toEqual(['delegate_permission/common.handle_all_urls']);
    expect(links[0].target.namespace).toBe('android_app');
    expect(links[0].target.package_name).toBe('com.karahoca.tracker');
    expect(links[0].target.sha256_cert_fingerprints).toEqual(['1A:2B:12:86']);
  });
});

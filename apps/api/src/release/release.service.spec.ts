import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppConfig } from '../config/configuration';
import { ReleaseService, type ReleaseManifest } from './release.service';

/*
 * Releasing a build is the one action in this product that reaches every phone
 * in the fleet at once, and the failure it can cause is specific: a manifest
 * whose sha256 does not match the APK behind the URL it names. Every driver who
 * checks during that window downloads 24 MB and is told the file arrived
 * corrupt.
 *
 * So these tests are mostly about ordering and about what is visible when.
 */

const STAGED: ReleaseManifest = {
  versionCode: 20,
  versionName: '1.5.1',
  url: 'https://track.karahoca.com/downloads/karahoca-takip.apk',
  sha256: 'bbbb',
  sizeBytes: 24_000_000,
  notes: { tr: 'Yenilik', ar: 'الجديد', ku: 'Nûtî' },
};

const LIVE: ReleaseManifest = {
  versionCode: 19,
  versionName: '1.5.0',
  url: 'https://track.karahoca.com/downloads/karahoca-takip.apk',
  sha256: 'aaaa',
  sizeBytes: 23_000_000,
};

describe('releasing a build to the fleet', () => {
  let dir: string;
  let service: ReleaseService;

  const write = (name: string, body: unknown) =>
    writeFile(join(dir, name), typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
  const read = (name: string) => readFile(join(dir, name), 'utf8');
  const exists = (name: string) =>
    read(name).then(
      () => true,
      () => false,
    );

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'kh-release-'));
    service = new ReleaseService({ session: { apkDir: dir } } as unknown as AppConfig);
  });

  afterEach(() => rm(dir, { recursive: true, force: true }));

  it('tells devices nothing at all before the first release', async () => {
    await expect(service.manifestForDevices()).rejects.toThrow();
  });

  /**
   * A staged build is invisible to phones. This is the entire point of the
   * split: uploading is not releasing.
   */
  it('does not serve a staged build to devices', async () => {
    await write('latest.staged.json', STAGED);
    await write('karahoca-takip-20.apk', 'new-bytes');

    await expect(service.manifestForDevices()).rejects.toThrow();
    expect((await service.staged())?.versionCode).toBe(20);
    expect(await service.live()).toBeNull();
  });

  it('keeps serving the released build while a newer one waits', async () => {
    await write('latest.json', LIVE);
    await write('latest.staged.json', STAGED);
    await write('karahoca-takip.apk', 'old-bytes');
    await write('karahoca-takip-20.apk', 'new-bytes');

    expect((await service.manifestForDevices()).versionCode).toBe(19);
  });

  it('puts the bytes and the manifest in place together', async () => {
    await write('latest.json', LIVE);
    await write('latest.staged.json', STAGED);
    await write('karahoca-takip.apk', 'old-bytes');
    await write('karahoca-takip-20.apk', 'new-bytes');

    const released = await service.announce('ops@karahoca.com');

    expect(released.versionCode).toBe(20);
    // The canonical URL now serves the build the manifest describes. Getting
    // this pair wrong is the whole reason announce() does its renames in the
    // order it does.
    expect(await read('karahoca-takip.apk')).toBe('new-bytes');
    expect((await service.manifestForDevices()).sha256).toBe('bbbb');
    // Nothing is left staged, or the next press would release it again.
    expect(await exists('latest.staged.json')).toBe(false);
    expect(await service.staged()).toBeNull();
  });

  it('records who released it, beside the artefact', async () => {
    await write('latest.staged.json', STAGED);
    await write('karahoca-takip-20.apk', 'new-bytes');

    await service.announce('ops@karahoca.com');
    const live = await service.live();

    expect(live?.announcedBy).toBe('ops@karahoca.com');
    expect(live?.announcedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // The publish stamp is not overwritten by the release stamp: they answer
    // different questions and a release can come days after a build.
    expect(live?.notes?.ar).toBe('الجديد');
  });

  it('refuses when there is nothing staged', async () => {
    await write('latest.json', LIVE);
    await expect(service.announce('ops@karahoca.com')).rejects.toThrow();
    // And the fleet is untouched by the attempt.
    expect((await service.manifestForDevices()).versionCode).toBe(19);
  });

  /**
   * A truncated or hand-edited file must read as "nothing there".
   *
   * The alternative is a manifest with an undefined versionCode reaching a
   * phone, where it compares as NaN and the update banner never appears again.
   */
  it('treats an unreadable manifest as absent', async () => {
    await write('latest.json', '{ this is not json');
    expect(await service.live()).toBeNull();

    await write('latest.json', { versionName: '9.9.9' });
    expect(await service.live()).toBeNull();
  });
});

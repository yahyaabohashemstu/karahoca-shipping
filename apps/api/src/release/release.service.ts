import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { CONFIG, type AppConfig } from '../config/configuration';

/**
 * What a phone reads to learn it is out of date.
 *
 * Mirrors UpdateManifest in the Android app. `notes` is keyed by language tag
 * and rendered in the driver's own language on the update banner.
 */
export interface ReleaseManifest {
  versionCode: number;
  versionName: string;
  url: string;
  sha256: string;
  sizeBytes: number;
  publishedAt?: string;
  announcedAt?: string;
  announcedBy?: string;
  notes?: Record<string, string>;
}

/** One phone asking what the current release is. */
export interface ReleaseCheckIn {
  at: string;
  /** From X-KH-App-Build. Absent on 1.6.0 and earlier, which do not send it. */
  build: number | null;
  userAgent: string | null;
}

/**
 * Publishing a build and releasing it to drivers are two different decisions.
 *
 * They used to be one: `infra/publish-apk.sh` wrote the manifest next to the
 * APK and every phone in the fleet was told within six hours, whether or not
 * anybody was ready for that. A release goes out mid-shift to drivers on a road
 * in northern Iraq, and the person who decides when that happens is a
 * dispatcher at a desk, not whoever ran a build.
 *
 * So the script now stages: it uploads `karahoca-takip-<code>.apk` and
 * `latest.staged.json`, and touches neither of the two names the fleet reads.
 * Pressing the button in the app-download page is what promotes them.
 *
 * Everything lives as files in the directory nginx already serves, rather than
 * in Postgres, for one reason: the APK and the manifest that describes it must
 * never disagree. Keeping the state anywhere other than beside the artefact is
 * how you end up advertising a version the download does not contain, and every
 * phone in the fleet downloads 24 MB to install the build it already has.
 */
@Injectable()
export class ReleaseService {
  private readonly log = new Logger(ReleaseService.name);

  /** The names the fleet reads. Fixed: printed dispatch notes point at them. */
  private static readonly LIVE_MANIFEST = 'latest.json';
  private static readonly LIVE_APK = 'karahoca-takip.apk';
  private static readonly STAGED_MANIFEST = 'latest.staged.json';

  /*
   * The last few check-ins, in memory.
   *
   * Added the day a release went out and the answer to "did any phone hear it?"
   * turned out to be unobtainable: the API logs nothing per request, Traefik
   * logs nothing, and the manifest is the one file under /downloads the nginx
   * sidecar no longer serves — so the only component that could have seen the
   * request was the only one keeping no record of it. An hour went into proving
   * that a question with a one-line answer could not be answered at all.
   *
   * In memory rather than a table, and labelled as such on the panel: this
   * answers "is anything asking, right now", which is what a dispatcher needs
   * in the minute after pressing the button. Losing it on redeploy is fine.
   * Uptake over weeks is a different question and would want different
   * machinery.
   */
  private static readonly CHECK_IN_HISTORY = 50;
  private readonly checkIns: ReleaseCheckIn[] = [];

  /*
   * The released versionCode, cached, for the ingest hot path.
   *
   * Every tracking phone posts a batch every ten seconds; a stat() and a JSON
   * parse per batch to answer a question whose answer changes twice a month
   * would be absurd. This service is the only writer of the live manifest, so
   * the cache can only go stale if somebody edits the file by hand on the box —
   * hence a TTL rather than trusting it forever.
   */
  private static readonly VERSION_CACHE_MS = 60_000;
  private cachedVersionCode: number | null = null;
  private cachedAt = 0;

  constructor(@Inject(CONFIG) private readonly config: AppConfig) {}

  recordCheckIn(build: number | null, userAgent: string | null): void {
    this.checkIns.unshift({ at: new Date().toISOString(), build, userAgent });
    if (this.checkIns.length > ReleaseService.CHECK_IN_HISTORY) this.checkIns.pop();
  }

  /** What the release panel shows under the button. */
  recentCheckIns(): { total: number; lastAt: string | null; builds: Record<string, number> } {
    const builds: Record<string, number> = {};
    for (const c of this.checkIns) {
      const key = c.build === null ? 'unknown' : String(c.build);
      builds[key] = (builds[key] ?? 0) + 1;
    }
    return { total: this.checkIns.length, lastAt: this.checkIns[0]?.at ?? null, builds };
  }

  /**
   * The released build, or null if we have not read it yet.
   *
   * Deliberately synchronous and deliberately allowed to answer null: it is
   * consumed as an optional hint on the ingest response, and a phone that does
   * not get the hint simply falls back to its own manifest check. Blocking a
   * telemetry batch on a disk read to deliver a hint would be the wrong trade
   * in every direction.
   */
  liveVersionCode(): number | null {
    if (Date.now() - this.cachedAt > ReleaseService.VERSION_CACHE_MS) {
      this.cachedAt = Date.now();
      // Fire and forget: this call returns the previous value and the next one
      // gets the fresh answer. Nothing here is worth awaiting in an ingest.
      void this.live().then((m) => {
        this.cachedVersionCode = m?.versionCode ?? null;
      });
    }
    return this.cachedVersionCode;
  }

  private path(name: string): string {
    return join(this.config.session.apkDir, name);
  }

  private async read(name: string): Promise<ReleaseManifest | null> {
    try {
      const text = await readFile(this.path(name), 'utf8');
      const parsed = JSON.parse(text) as ReleaseManifest;
      // A half-written or hand-edited file must read as "nothing there" rather
      // than reach a phone as a manifest with no versionCode.
      if (typeof parsed?.versionCode !== 'number' || !parsed.sha256) return null;
      return parsed;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code !== 'ENOENT') this.log.warn(`Cannot read ${name}: ${String(error)}`);
      return null;
    }
  }

  /** What the fleet is currently being told. Null before the first release. */
  live(): Promise<ReleaseManifest | null> {
    return this.read(ReleaseService.LIVE_MANIFEST);
  }

  /** A build that has been uploaded but not yet released to anybody. */
  staged(): Promise<ReleaseManifest | null> {
    return this.read(ReleaseService.STAGED_MANIFEST);
  }

  /**
   * What the driver app fetches, six-hourly.
   *
   * 404 rather than an empty body when nothing has been released: the app's
   * check treats a failed fetch as "nothing to do" and stays quiet, which is
   * exactly right, whereas a 200 with a malformed body is a parse error it
   * would log every six hours forever.
   */
  async manifestForDevices(): Promise<ReleaseManifest> {
    const live = await this.live();
    if (!live) throw new NotFoundException('No release has been published yet');
    return live;
  }

  /**
   * Release the staged build to the fleet.
   *
   * Three steps, in this order, and the order is the whole point:
   *
   *   1. remove the live manifest — for the moment that follows, phones are
   *      told nothing, which they handle silently;
   *   2. move the staged APK onto the canonical filename, so the bytes behind
   *      that URL are the ones the new manifest describes;
   *   3. move the staged manifest into place.
   *
   * Do it the other way round and there is a window where the manifest promises
   * a sha256 the download does not have — a driver checking during that window
   * downloads 24 MB and is told the file arrived corrupt. Renames within one
   * filesystem are atomic, so each step is all-or-nothing.
   */
  async announce(by: string | null): Promise<ReleaseManifest> {
    const staged = await this.staged();
    if (!staged) throw new NotFoundException('There is no staged build to release');

    const stagedApk = this.path(`karahoca-takip-${staged.versionCode}.apk`);
    const liveApk = this.path(ReleaseService.LIVE_APK);
    const liveManifest = this.path(ReleaseService.LIVE_MANIFEST);
    const stagedManifest = this.path(ReleaseService.STAGED_MANIFEST);

    const stamped: ReleaseManifest = {
      ...staged,
      announcedAt: new Date().toISOString(),
      // Who released it, kept with the artefact rather than in a table. This
      // file is what a later "who put 1.6.0 on the fleet, and when?" is
      // answered from, and it survives beside the APK it describes.
      ...(by ? { announcedBy: by } : {}),
    };

    await unlink(liveManifest).catch((error: NodeJS.ErrnoException) => {
      if (error?.code !== 'ENOENT') throw error;
    });
    await rename(stagedApk, liveApk);
    await this.writeAtomic(liveManifest, stamped);
    await unlink(stagedManifest).catch(() => undefined);

    // The one moment the cache is certainly wrong, and the one moment it
    // matters most: every tracking phone should get the hint on its next batch.
    this.cachedVersionCode = stamped.versionCode;
    this.cachedAt = Date.now();

    this.log.warn(
      `Released ${stamped.versionName} (${stamped.versionCode}) to the fleet` +
        (by ? ` — by ${by}` : ''),
    );
    return stamped;
  }

  /**
   * Write through a temporary name in the same directory.
   *
   * nginx is serving this path while we write it, and a phone that reads a
   * half-written manifest gets a parse error. A rename is atomic; a truncate
   * and rewrite is not.
   */
  private async writeAtomic(target: string, body: ReleaseManifest): Promise<void> {
    const { writeFile } = await import('node:fs/promises');
    const temp = `${target}.tmp`;
    await writeFile(temp, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
    await rename(temp, target);
  }
}

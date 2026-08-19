import {
  Controller,
  Get,
  Logger,
  NotFoundException,
  Param,
  Res,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { Public } from '../auth/decorators';
import { RateLimit } from '../common/rate-limit.guard';

/* =============================================================================
   Elevation tiles
   =============================================================================
   A passthrough to the AWS Open Data terrarium tiles, existing for exactly one
   reason: they are served without an Access-Control-Allow-Origin header.

   That is not a guess. `curl -I -H 'Origin: https://track.karahoca.com'
   https://s3.amazonaws.com/elevation-tiles-prod/terrarium/10/613/406.png`
   returns 200 with 117 kB of PNG and no CORS header at all. MapLibre builds a
   height map by reading the pixels of that PNG, a browser refuses to let it
   read pixels from a cross-origin image without CORS, and the failure is
   silent: the tile loads, the canvas taints, every sample comes back zero, and
   the mountains between Cizre and Zaho render as a billiard table.

   The alternatives were weighed. MapTiler and Mapbox both serve terrain-RGB
   with CORS and both want an API key in the client bundle plus a metered bill.
   MapLibre's demotiles server is a demo server and says so. Generating DEM
   tiles from SRTM ourselves is a week of work and 40 GB. Sixty lines of proxy
   is the proportionate answer.

   The dataset is SRTM/ASTER/NED via the AWS Open Data registry, public domain
   or equivalent, and attributed on the map.
   ========================================================================== */

const UPSTREAM = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium';

/**
 * Above this the source has no more detail and merely upsamples.
 *
 * SRTM is 1 arc-second — about 30 m — which runs out at roughly z13. Serving
 * z15 and beyond would quadruple the request count per zoom step to redeliver
 * the same heights, so the client is configured to stop at 14 and this rejects
 * anything past it rather than trusting it to.
 */
const MAX_ZOOM = 14;

/**
 * Hot-tile cache, in bytes.
 *
 * Small on purpose. This box is 2 vCPU and shares its memory with Postgres and
 * Redis, and the cache that actually carries the load is the browser's: tiles
 * are immutable, so a dispatcher who leaves the dashboard open all day fetches
 * each one once. 48 MB is roughly 400 tiles, which is several viewports' worth
 * at the zooms the terrain is visible at, and it is what stops twelve people
 * opening the same consignee link from turning into twelve trips to S3.
 */
const CACHE_LIMIT_BYTES = 48 * 1024 * 1024;

/** Upstream is not on the critical path; a slow tile is worse than no tile. */
const UPSTREAM_TIMEOUT_MS = 6_000;

@Controller('terrain')
export class TerrainController {
  private readonly log = new Logger(TerrainController.name);

  /**
   * Insertion-ordered, which is what makes the eviction below a genuine LRU:
   * a hit deletes and re-sets the key, moving it to the end, so the first key
   * Map iteration yields is always the least recently used.
   */
  private readonly cache = new Map<string, Buffer>();
  private cacheBytes = 0;

  /**
   * In-flight requests, keyed the same way.
   *
   * A map opening at a new zoom asks for thirty tiles at once and several
   * viewers may ask for the same one in the same second. Without this each
   * becomes its own upstream fetch; with it, the first caller fetches and the
   * rest await the same promise.
   */
  private readonly inflight = new Map<string, Promise<Buffer | null>>();

  /**
   * Numbers only, and validated as such.
   *
   * The upstream URL is assembled from these three values, so this is the one
   * place an SSRF could enter. Nest's ParseIntPipe would throw a 400 with a
   * JSON body that a tile loader cannot read; the explicit check returns a 404,
   * which MapLibre already knows how to treat as "no data here".
   */
  /*
   * The headers are set on the reply, NOT with @Header decorators, and that is
   * a bug fix rather than a style choice.
   *
   * A decorator pins the response content type for the whole route, including
   * the paths that do not return an image. So when this threw NotFoundException
   * — for a malformed coordinate, for an ocean tile the upstream genuinely does
   * not have, or for a timeout — the exception filter tried to send a JSON body
   * into a response already declared as image/png, Fastify refused with
   * "Attempted to send payload of invalid type 'object'", and the client got a
   * 500. Measured on production: every invalid tile returned 500, and each one
   * logged an ERROR with a stack.
   *
   * That is not cosmetic. MapLibre treats 404 as "no data here" and stops
   * asking; a 500 is a failure it may retry, and the log fills with errors
   * about a map panning over water.
   */
  @Public()
  @RateLimit({ bucket: 'terrain', perIp: 600, windowSec: 60 })
  @Get(':z/:x/:y.png')
  async tile(
    @Param('z') rawZ: string,
    @Param('x') rawX: string,
    @Param('y') rawY: string,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const z = Number(rawZ);
    const x = Number(rawX);
    const y = Number(rawY);

    const span = 2 ** z;
    const valid =
      Number.isInteger(z) && z >= 0 && z <= MAX_ZOOM &&
      Number.isInteger(x) && x >= 0 && x < span &&
      Number.isInteger(y) && y >= 0 && y < span;
    if (!valid) throw new NotFoundException();

    const key = `${z}/${x}/${y}`;

    const cached = this.cache.get(key);
    if (cached) {
      // Re-insert to move it to the young end of the LRU.
      this.cache.delete(key);
      this.cache.set(key, cached);
      this.imageHeaders(reply).header('X-KH-Tile-Cache', 'hit').send(cached);
      return;
    }

    const tile = await this.fetchOnce(key);
    if (!tile) throw new NotFoundException();
    this.imageHeaders(reply).header('X-KH-Tile-Cache', 'miss').send(tile);
  }

  /** Everything a successful tile response needs, and only on success. */
  private imageHeaders(reply: FastifyReply): FastifyReply {
    return reply
      .header('Content-Type', 'image/png')
      // Terrain does not change. A month of browser cache is the whole reason
      // this proxy is affordable, and `immutable` stops the revalidation round
      // trip that would otherwise happen on every reload.
      .header('Cache-Control', 'public, max-age=2592000, immutable')
      // The header this entire file exists to add.
      .header('Access-Control-Allow-Origin', '*')
      .header('Cross-Origin-Resource-Policy', 'cross-origin');
  }

  private fetchOnce(key: string): Promise<Buffer | null> {
    const existing = this.inflight.get(key);
    if (existing) return existing;

    const work = this.fetchUpstream(key).finally(() => this.inflight.delete(key));
    this.inflight.set(key, work);
    return work;
  }

  private async fetchUpstream(key: string): Promise<Buffer | null> {
    try {
      const res = await fetch(`${UPSTREAM}/${key}.png`, {
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
        headers: { Accept: 'image/png' },
      });

      // Ocean tiles genuinely do not exist upstream and 404. That is data, not
      // an error, and logging it would fill the journal every time a map pans
      // over the Mediterranean.
      if (res.status === 404) return null;
      if (!res.ok) {
        this.log.warn(`terrain upstream ${res.status} for ${key}`);
        return null;
      }

      const body = Buffer.from(await res.arrayBuffer());
      this.remember(key, body);
      return body;
    } catch (err) {
      // A timeout or a DNS failure. The map draws flat and carries on; there is
      // nothing here worth failing a dispatcher's page load over.
      this.log.warn(`terrain upstream failed for ${key}: ${(err as Error).message}`);
      return null;
    }
  }

  private remember(key: string, body: Buffer) {
    // A single tile larger than the whole budget would evict everything and
    // then not fit. Has not been observed, but the arithmetic below assumes it
    // cannot happen.
    if (body.byteLength > CACHE_LIMIT_BYTES) return;

    this.cache.set(key, body);
    this.cacheBytes += body.byteLength;

    while (this.cacheBytes > CACHE_LIMIT_BYTES) {
      const oldest = this.cache.keys().next();
      if (oldest.done) break;
      const evicted = this.cache.get(oldest.value);
      this.cache.delete(oldest.value);
      this.cacheBytes -= evicted?.byteLength ?? 0;
    }
  }
}

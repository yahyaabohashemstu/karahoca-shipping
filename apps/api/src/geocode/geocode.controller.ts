import { Controller, Get, Logger, Query } from '@nestjs/common';
import { RateLimit } from '../common/rate-limit.guard';

/* =============================================================================
   Turning a place name into a coordinate
   =============================================================================
   A proxy to Nominatim, existing for two reasons rather than one.

   The technical reason is the same as the terrain tiles: checked with curl
   today, Nominatim answers 200 with results and sends no
   Access-Control-Allow-Origin, so a browser cannot read the response.

   The other reason is policy, and it is the one that actually decides the
   design. Nominatim's usage policy requires a User-Agent that identifies the
   application and a way to contact whoever runs it. A browser sends its own
   user agent, which identifies Chrome and nobody. Calling from the server is
   the only way to be a good citizen of a service that is free, run on
   donations, and entirely within its rights to block us.

   The same policy caps requests at one a second. This is a dispatcher typing a
   warehouse name a handful of times a day, so that is not a constraint — but
   the queue below enforces it anyway, because "we only make a few requests"
   is a promise about behaviour that a rendering bug can break in a loop.
   ========================================================================== */

const UPSTREAM = 'https://nominatim.openstreetmap.org';

/**
 * Identifies this application and a person, per the usage policy.
 *
 * Hard-coded rather than read from config: an operator who changes it to
 * something anonymous would silently violate the terms this endpoint depends
 * on, and there is no deployment where a different value is correct.
 */
const USER_AGENT = 'KaraHocaShipping/1.0 (+https://track.karahoca.com)';

/** The corridor this company actually ships to. */
const COUNTRIES = 'tr,iq,sy';

const CACHE_LIMIT = 500;
const UPSTREAM_TIMEOUT_MS = 8_000;
const MIN_INTERVAL_MS = 1_100;

interface Place {
  label: string;
  lat: number;
  lon: number;
  /** Nominatim's own type, e.g. 'industrial', 'city'. Shown as a hint. */
  kind: string | null;
}

@Controller('geocode')
export class GeocodeController {
  private readonly log = new Logger(GeocodeController.name);
  private readonly cache = new Map<string, Place[]>();

  /**
   * Serialises upstream calls at no more than one a second.
   *
   * A promise chain rather than a token bucket, because the requirement is a
   * minimum *gap* between calls, not an average rate — a bucket lets three
   * saved-up requests leave together, which is precisely what the policy
   * forbids.
   */
  private gate: Promise<void> = Promise.resolve();
  private lastCallAt = 0;

  @Get('search')
  @RateLimit({ bucket: 'geocode', perIp: 60, windowSec: 60 })
  async search(@Query('q') raw?: string): Promise<{ places: Place[] }> {
    const q = (raw ?? '').trim();
    // Two characters cannot identify a place and would return the whole
    // country. Not an error — the caller is mid-typing.
    if (q.length < 3) return { places: [] };

    const key = `s:${q.toLowerCase()}`;
    const hit = this.cache.get(key);
    if (hit) return { places: hit };

    const url =
      `${UPSTREAM}/search?format=jsonv2&limit=6&addressdetails=0` +
      `&countrycodes=${COUNTRIES}` +
      // Arabic first: the destinations are in Iraq and Syria and the labels
      // are read by someone who will recognise the Arabic name and not the
      // transliteration. Turkish and English follow for the domestic leg.
      `&accept-language=ar,tr,en&q=${encodeURIComponent(q)}`;

    const places = await this.fetchPlaces(url);
    this.remember(key, places);
    return { places };
  }

  /**
   * A coordinate back to a name.
   *
   * Used after a dispatcher drops a pin: the point is already correct, and this
   * only supplies a label so the saved destination reads as somewhere rather
   * than as two numbers. A failure here is therefore not an error — the pin
   * stands on its own.
   */
  @Get('reverse')
  @RateLimit({ bucket: 'geocode', perIp: 60, windowSec: 60 })
  async reverse(
    @Query('lat') rawLat?: string,
    @Query('lon') rawLon?: string,
  ): Promise<{ label: string | null }> {
    const lat = Number(rawLat);
    const lon = Number(rawLon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return { label: null };
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return { label: null };

    const key = `r:${lat.toFixed(4)},${lon.toFixed(4)}`;
    const hit = this.cache.get(key);
    if (hit) return { label: hit[0]?.label ?? null };

    const url =
      `${UPSTREAM}/reverse?format=jsonv2&zoom=16&addressdetails=0` +
      `&accept-language=ar,tr,en&lat=${lat}&lon=${lon}`;

    const places = await this.fetchPlaces(url, true);
    this.remember(key, places);
    return { label: places[0]?.label ?? null };
  }

  // ---- plumbing ------------------------------------------------------------

  private async fetchPlaces(url: string, single = false): Promise<Place[]> {
    try {
      const body = await this.throttled(async () => {
        const res = await fetch(url, {
          signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
          headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
        });
        if (!res.ok) {
          this.log.warn(`nominatim ${res.status}`);
          return null;
        }
        return (await res.json()) as unknown;
      });

      if (!body) return [];
      const rows = single ? [body] : Array.isArray(body) ? body : [];
      return rows
        .map((row) => toPlace(row))
        .filter((p): p is Place => p !== null);
    } catch (err) {
      // A dispatcher can still drop a pin by hand; search being down degrades
      // the feature rather than blocking the order.
      this.log.warn(`geocode failed: ${(err as Error).message}`);
      return [];
    }
  }

  private throttled<T>(work: () => Promise<T>): Promise<T> {
    const run = this.gate.then(async () => {
      const wait = MIN_INTERVAL_MS - (Date.now() - this.lastCallAt);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.lastCallAt = Date.now();
      return work();
    });
    // The gate must not inherit a rejection, or one failed lookup would poison
    // every request after it for the life of the process.
    this.gate = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private remember(key: string, places: Place[]) {
    this.cache.set(key, places);
    while (this.cache.size > CACHE_LIMIT) {
      const oldest = this.cache.keys().next();
      if (oldest.done) break;
      this.cache.delete(oldest.value);
    }
  }
}

function toPlace(row: unknown): Place | null {
  if (typeof row !== 'object' || row === null) return null;
  const r = row as Record<string, unknown>;
  const lat = Number(r.lat);
  const lon = Number(r.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const label = typeof r.display_name === 'string' ? r.display_name : null;
  if (!label) return null;
  return {
    label,
    lat,
    lon,
    kind: typeof r.type === 'string' ? r.type : null,
  };
}

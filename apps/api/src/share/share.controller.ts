import {
  Body,
  Controller,
  Delete,
  Get,
  Logger,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { CurrentUser, Public, Roles } from '../auth/decorators';
import { RateLimit } from '../common/rate-limit.guard';
import { ShareService, type ConsigneeView, type ShareResolution } from './share.service';
import { CreateShareLinkDto } from './dto';

/** Dispatcher-facing management of consignee links. Behind the global UserAuthGuard. */
@Controller()
export class ShareController {
  constructor(private readonly share: ShareService) {}

  @Roles('ADMIN', 'DISPATCHER')
  @Post('sessions/:id/share')
  create(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateShareLinkDto,
    @CurrentUser('id') userId: string,
  ) {
    return this.share.mint(id, dto, userId);
  }

  @Get('sessions/:id/share')
  list(@Param('id', ParseUUIDPipe) id: string) {
    return this.share.list(id);
  }

  /**
   * Not scoped under the session on purpose. Revocation is the one operation a
   * dispatcher reaches for in a hurry — the wrong customer got the link, a
   * carrier relationship ended — and requiring them to first find which session
   * a link belongs to is friction on exactly the path that must not have any.
   */
  @Roles('ADMIN', 'DISPATCHER')
  @Delete('share/:id')
  revoke(@Param('id', ParseUUIDPipe) id: string) {
    return this.share.revoke(id);
  }
}

/**
 * The consignee's page — `track.karahoca.com/s/<token>`.
 *
 * The company in Erbil or Aleppo waiting on a load has no account, no
 * credential and, until now, no way to see anything at all; they phoned the
 * dispatcher instead. This is the entire customer-facing surface of the
 * product, and it is one URL, unauthenticated, holding one capability token.
 *
 * Like the driver hand-off pages it is a single self-contained HTML string. It
 * has to render on a cheap Android phone on a hotel wifi in Basra with one
 * request to us, and it must never become a reason to deploy a second web
 * service or to put the dashboard's 143 kB of React in front of a customer.
 *
 * `@Res()` without passthrough, deliberately: the HTTP status is part of the
 * answer here (200 / 404 / 410) and each one carries an HTML body, whereas
 * AllExceptionsFilter would turn any thrown status into the JSON error envelope
 * the Android client expects. A customer must never be shown `{"error":…}`, and
 * must certainly never be shown a stack trace.
 */
@Controller()
export class PublicShareController {
  private readonly logger = new Logger(PublicShareController.name);

  constructor(private readonly share: ShareService) {}

  /**
   * 60 page loads per minute per IP.
   *
   * Guessing a 256-bit token is not the risk; the risk named in the rate
   * limiter's own header comment is: an unauthenticated endpoint doing real
   * database work on a 2-vCPU box, and here it also does a *write* (the view
   * counter). A loop and a wordlist could otherwise hold the pool open.
   *
   * Only the per-IP window applies — @RateLimit keys its subject window off a
   * body field and a GET has none. That costs nothing: a per-token counter is
   * useless against an attacker whose every request carries a different token,
   * and a real consignee reloading a page is exactly what the IP window bounds.
   */
  @Public()
  @RateLimit({ bucket: 'share', perIp: 60, windowSec: 60 })
  @Get('s/:token')
  async page(@Param('token') token: string, @Res() reply: FastifyReply): Promise<void> {
    let rendered: { status: number; html: string };

    try {
      rendered = render(await this.share.resolve(token));
    } catch (err) {
      /*
       * Anything unexpected — the pool exhausted, a statement timeout on a long
       * route — would otherwise reach AllExceptionsFilter and put
       * `{"error":{"code":"INTERNAL_ERROR"}}` on a customer's screen. Logged at
       * error level here because catching it takes it out of the filter's
       * hands, and the operator still needs the stack the customer must not
       * see. Never the token: it is a live credential and logs get shipped.
       */
      this.logger.error(`share page failed: ${(err as Error).message}`, (err as Error).stack);
      rendered = {
        status: 503,
        html: noticePage(
          'Sayfa şu anda açılamıyor',
          'Geçici bir sorun nedeniyle sevkiyat bilgileri getirilemedi. Lütfen birkaç dakika sonra tekrar deneyin.',
        ),
      };
    }

    reply
      .status(rendered.status)
      .headers({
        'Content-Type': 'text/html; charset=utf-8',
        // Never cached anywhere. The position changes minute to minute, and a
        // shared proxy holding one customer's page would serve it to the next.
        'Cache-Control': 'no-store, private',
        /*
         * Load-bearing, not boilerplate.
         *
         * The token is in the URL, and this page pulls a script from a CDN and
         * map tiles from OpenFreeMap. Without this the browser puts
         * `Referer: https://track.karahoca.com/s/<token>` on every one of those
         * requests and hands a live tracking credential to two third parties
         * and their logs. @fastify/helmet sets the same value globally today;
         * pinning it here means a future change to that config cannot quietly
         * start leaking tokens.
         */
        'Referrer-Policy': 'no-referrer',
        // These links get pasted into e-mail and WhatsApp. Anything that
        // follows one must not put a customer's shipment in a search index.
        'X-Robots-Tag': 'noindex, nofollow, noarchive',
      })
      .send(rendered.html);
  }
}

// =============================================================================
// Rendering
// =============================================================================

function render(resolved: ShareResolution): { status: number; html: string } {
  switch (resolved.kind) {
    case 'ok':
      return { status: 200, html: shipmentPage(resolved.view) };
    /*
     * 410 for expired, 404 for everything else — and "everything else" is
     * unknown and revoked together, in one branch, worded identically. A
     * revoked link that said "revoked" would confirm to its holder that the
     * token is real and the shipment exists, which is precisely what revoking
     * it was meant to stop, and would turn the endpoint into a guess oracle.
     *
     * Expired may differ safely: only someone who was given a genuine token can
     * ever reach it, so it reveals nothing a guesser could use — and telling a
     * waiting customer "ask for a new link" instead of "invalid" is the
     * difference between a page that helps and a page that generates the phone
     * call this whole feature exists to prevent.
     */
    case 'expired':
      return {
        status: 410,
        html: noticePage(
          'Bağlantının süresi doldu',
          'Bu takip bağlantısı artık geçerli değil. Sevkiyat sorumlunuzdan yeni bir bağlantı isteyebilirsiniz.',
        ),
      };
    case 'unknown':
    default:
      return {
        status: 404,
        html: noticePage(
          'Bağlantı geçerli değil',
          'Bu takip bağlantısı açılamıyor. Bağlantıyı eksiksiz kopyaladığınızdan emin olun; sorun sürerse sevkiyat sorumlunuzla iletişime geçin.',
        ),
      };
  }
}

/**
 * The dark basemap, not positron.
 *
 * apps/web/src/lib/mapStyle.ts carries both and explains why either beats the
 * colourful `liberty` default: they are desaturated, so the only saturated
 * pixels on the screen are the vehicle and its route. This page is dark like
 * the rest of the public surface (`/t/:code`, `/app`), and dropping a white map
 * slab into it would be the same mistake in the other direction.
 */
const MAP_STYLE = 'https://tiles.openfreemap.org/styles/dark';

/**
 * Pinned to the exact version the dashboard bundles, so a consignee and a
 * dispatcher are looking at the same renderer. A floating `@latest` would let a
 * third party change this page without a deploy.
 */
const MAPLIBRE_VERSION = '4.7.1';

/**
 * Türkiye, Iraq and Syria all sit permanently at UTC+3, and every reader of
 * this page is in one of the three. A single fixed zone is therefore correct
 * for all of them — and correct beats formatting against the phone's own clock,
 * which is the same reason every driver response carries `serverTime`.
 */
const TR_DATETIME = new Intl.DateTimeFormat('tr-TR', {
  timeZone: 'Europe/Istanbul',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

type StatusTone = 'live' | 'wait' | 'done' | 'stop';

type FactGroup = 'now' | 'shipment' | 'cargo' | 'carrier';

interface Fact {
  label: string;
  /** Already-escaped HTML. */
  value: string;
  group: FactGroup;
}

/*
 * Ordered by what the reader wants first.
 *
 * "Where is it and when does it land" is the question; everything else is
 * reconciliation they do afterwards. The headings exist so the eye can skip
 * two thirds of the page rather than reading eleven identical rows to find
 * one.
 */
const GROUP_LABELS: Array<[FactGroup, string]> = [
  ['now', 'Durum'],
  ['shipment', 'Sevkiyat'],
  ['cargo', 'Yük'],
  ['carrier', 'Taşıma'],
];

function renderGroups(facts: Fact[]): string {
  return GROUP_LABELS.map(([key, heading]) => {
    const rows = facts.filter((f) => f.group === key);
    if (!rows.length) return '';
    return `<section class="group">
      <p class="group__label">${heading}</p>
      <dl class="facts">
        ${rows
          .map((f) => `<div class="fact"><dt>${esc(f.label)}</dt><dd>${f.value}</dd></div>`)
          .join('\n        ')}
      </dl>
    </section>`;
  }).join('\n    ');
}

function shipmentPage(view: ConsigneeView): string {
  const state = describeStatus(view);
  const hasPosition = view.lat !== null && view.lon !== null;

  const facts: Fact[] = [
    { label: 'Sipariş No', value: esc(view.orderNumber), group: 'shipment' },
    { label: 'Alıcı', value: esc(view.customerName), group: 'shipment' },
  ];

  if (view.destinationLabel) {
    facts.push({ label: 'Varış', value: esc(view.destinationLabel), group: 'shipment' });
  }

  const remaining = formatKm(view.remainingKm);
  if (remaining) {
    // "kuş uçuşu" is not a hedge, it is the truth: kh.v_live_fleet computes a
    // straight-line distance, not a road distance. A consignee planning a
    // forklift crew around a number that is 20% short would rightly be annoyed.
    facts.push({
      label: 'Kalan mesafe',
      group: 'now',
      value: `${esc(remaining)} <span class="sub">kuş uçuşu</span>`,
    });
  }

  if (view.plannedDeliveryAt) {
    facts.push({ label: 'Planlanan teslimat', value: esc(TR_DATETIME.format(view.plannedDeliveryAt)), group: 'now' });
  }

  /*
   * What is on the lorry.
   *
   * "Where is it" is the first question an agent asks and the only one this
   * page used to answer. The second is "is this the consignment I ordered" —
   * they are reconciling against their own purchase order — and leaving it out
   * meant the page saved them one phone call and cost them another.
   *
   * Weight and pallet count are what a receiving yard plans around: whether a
   * forklift is needed, how many hands, how long the bay is blocked.
   */
  if (view.cargoSummary) {
    facts.push({ label: 'Yük', value: esc(view.cargoSummary), group: 'cargo' });
  }
  if (view.itemList) {
    facts.push({ label: 'Ürünler', value: esc(view.itemList), group: 'cargo' });
  }

  const load: string[] = [];
  if (view.palletCount) load.push(`${view.palletCount} palet`);
  if (view.totalWeightKg) {
    // Tonnes above 1000 kg: a receiving clerk reads "12,4 ton" instantly and
    // has to stop and count digits on "12400 kg".
    load.push(
      view.totalWeightKg >= 1000
        ? `${(view.totalWeightKg / 1000).toLocaleString('tr-TR', { maximumFractionDigits: 1 })} ton`
        : `${view.totalWeightKg} kg`,
    );
  }
  if (load.length) {
    facts.push({ label: 'Miktar', value: esc(load.join(' · ')), group: 'cargo' });
  }

  if (view.carrierName) {
    facts.push({ label: 'Nakliyeci', value: esc(view.carrierName), group: 'carrier' });
  }

  facts.push({
    label: 'Son konum güncellemesi',
    group: 'now',
    value: view.recordedAt
      ? `<span id="ago" data-at="${view.recordedAt.getTime()}">—</span>` +
        `<span class="sub">${esc(TR_DATETIME.format(view.recordedAt))}</span>`
      : 'Henüz konum alınmadı',
  });

  // Only reachable when the link was minted with show_driver; the service does
  // not even select these columns otherwise.
  if (view.driverName) {
    facts.push({ label: 'Sürücü', value: esc(view.driverName), group: 'carrier' });
  }
  if (view.driverPhone) {
    const dialable = view.driverPhone.replace(/[^\d+]/g, '');
    facts.push({
      label: 'Sürücü telefonu',
      group: 'carrier',
      value: `<a href="tel:${esc(dialable)}">${esc(view.driverPhone)}</a>`,
    });
  }
  if (view.vehiclePlate) {
    facts.push({ label: 'Plaka', value: esc(view.vehiclePlate), group: 'carrier' });
  }

  const mapData = {
    lat: view.lat,
    lon: view.lon,
    dest:
      view.destinationLat !== null && view.destinationLon !== null
        ? [view.destinationLon, view.destinationLat]
        : null,
    route: view.route ?? null,
  };

  return page(
    `Sevkiyat Takibi — ${esc(view.orderNumber)}`,
    `
    <header class="head">
      <div class="logo">KARAHOCA</div>
      <button class="refresh" type="button" onclick="location.reload()">Yenile</button>
    </header>

    <section class="status status--${state.tone}">
      <p class="status__ref">${esc(view.orderNumber)}</p>
      <h1 class="status__title"><span class="status__dot" aria-hidden="true"></span>${esc(state.title)}</h1>
      <p class="status__detail">${esc(state.detail)}</p>
    </section>

    ${
      hasPosition
        ? `<div class="map" id="map"><span class="map__note">Harita yükleniyor…</span></div>`
        : `<div class="map map--empty"><span class="map__note">Araç henüz konum bildirmedi.</span></div>`
    }

    ${renderGroups(facts)}

    <p class="fine">
      Bu sayfa yalnızca bu sevkiyat için oluşturulmuş özel bir bağlantıdır ve süresi dolduğunda
      kapanır. Lütfen bağlantıyı üçüncü kişilerle paylaşmayın.
    </p>
    <p class="fine">Sorularınız için sevkiyat sorumlunuzla iletişime geçin.</p>
  `,
    hasPosition ? mapScripts(mapData) : agoScript(),
  );
}

function noticePage(title: string, message: string): string {
  return page(
    `${esc(title)} — KaraHoca`,
    `
    <header class="head"><div class="logo">KARAHOCA</div></header>
    <h1>${esc(title)}</h1>
    <div class="status status--stop">
      <p class="status__detail">${esc(message)}</p>
    </div>
  `,
    '',
  );
}

/**
 * The shared shell. One stylesheet, inline, no webfont, no framework.
 *
 * `title`, `body` and `tail` are interpolated raw — every caller is responsible
 * for having run its own values through esc() already. Escaping again here
 * would double-encode the markup the callers legitimately build.
 */
function page(title: string, body: string, tail: string): string {
  return `<!doctype html>
<html lang="tr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex,nofollow">
<title>${title}</title>
<style>
  /*
   * Dark, and not by default.
   *
   * The scene: an agent at a yard gate in Erbil, or in a warehouse office, on
   * a cheap Android phone, checking whether the lorry is close. More than half
   * this page is a dark basemap. Light chrome wrapped around a dark map is two
   * designs arguing, and the map cannot go light without losing the contrast
   * the vehicle marker depends on. The map decides; everything else follows.
   */
  :root {
    color-scheme: dark;
    --bg:        #0a1018;
    --surface:   #111a28;
    --line:      #1d2b3f;
    --ink:       #eef3fa;
    --ink-2:     #9fb0c6;
    --ink-3:     #6a7f99;
    --brand:     #6cc6f5;

    /* Semantic, and deliberately not the dispatcher's palette.
     *
     * On the fleet map green means "the GPS is reporting". Here it has to mean
     * "your goods arrived" — the only outcome this reader is waiting for, and
     * the colour every parcel tracker they have used says it in. Delivery was
     * rendering in the same sky blue as the logo, so the best possible news
     * looked like a footnote while *waiting* got amber. In transit is blue:
     * progressing, not finished. */
    --done:      #34d399;
    --live:      #60b8f8;
    --wait:      #f2b23c;
    --stop:      #f87171;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100dvh;
    font: 16px/1.5 -apple-system, "Segoe UI", Roboto, system-ui, sans-serif;
    -webkit-font-smoothing: antialiased;
    background: var(--bg); color: var(--ink); padding: 18px 16px 40px;
  }
  .wrap { width: 100%; max-width: 520px; margin: 0 auto; }
  .head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  .logo { font-weight: 800; letter-spacing: .16em; font-size: 12px; color: var(--brand); }
  .refresh {
    font: inherit; font-size: 13px; padding: 7px 13px; border-radius: 9px; cursor: pointer;
    background: transparent; color: var(--ink-2); border: 1px solid var(--line);
    transition: color .18s cubic-bezier(.22,1,.36,1), border-color .18s cubic-bezier(.22,1,.36,1);
  }
  .refresh:hover { color: var(--ink); border-color: var(--ink-3); }
  .refresh:focus-visible { outline: 2px solid var(--brand); outline-offset: 2px; }

  /*
   * The status IS the page.
   *
   * It used to sit inside a bordered card underneath an <h1> reading "Sevkiyat
   * Takibi" — so the loudest element on screen told the reader something they
   * already knew, having just clicked a tracking link, while the one fact they
   * came for was quieter than the heading above it. No card here: a card fences
   * the answer off as one item among several. Colour and scale carry it.
   */
  .status { margin: 22px 0 4px; }
  .status__ref {
    font-size: 12px; letter-spacing: .14em; text-transform: uppercase;
    color: var(--ink-3); margin: 0 0 8px;
  }
  .status__title {
    font-size: clamp(28px, 8vw, 36px); font-weight: 700; line-height: 1.1;
    letter-spacing: -0.02em; margin: 0; text-wrap: balance;
  }
  .status__detail { margin: 8px 0 0; color: var(--ink-2); font-size: 15px; text-wrap: pretty; }
  .status__dot {
    display: inline-block; width: 11px; height: 11px; border-radius: 50%;
    margin-right: 11px; vertical-align: middle; position: relative; top: -3px;
  }
  .status--done .status__title { color: var(--done); }
  .status--done .status__dot   { background: var(--done); }
  .status--live .status__title { color: var(--live); }
  .status--live .status__dot   { background: var(--live); animation: pulse 2.4s ease-out infinite; }
  .status--wait .status__title { color: var(--wait); }
  .status--wait .status__dot   { background: var(--wait); }
  .status--stop .status__title { color: var(--stop); }
  .status--stop .status__dot   { background: var(--stop); }

  /* Only the live state pulses, because only it is still changing. */
  @keyframes pulse {
    0%   { box-shadow: 0 0 0 0 rgba(96,184,248,.5); }
    70%  { box-shadow: 0 0 0 9px rgba(96,184,248,0); }
    100% { box-shadow: 0 0 0 0 rgba(96,184,248,0); }
  }
  @media (prefers-reduced-motion: reduce) {
    .status--live .status__dot { animation: none; }
    .refresh { transition: none; }
  }

  .map {
    margin-top: 18px; height: 46vh; min-height: 250px; border-radius: 12px; overflow: hidden;
    border: 1px solid var(--line); background: var(--surface); display: grid; place-items: center;
  }
  .map--empty { height: 92px; min-height: 0; }
  .map__note { color: var(--ink-3); font-size: 13.5px; padding: 0 16px; text-align: center; }
  /* MapLibre paints into a child canvas; the placeholder grid must not centre it. */
  .map.is-ready { display: block; }

  /*
   * Grouped, not one flat run of rows.
   *
   * Six rows of identical weight make the reader scan all six to find the one
   * they want. They answer three different questions — which shipment, what is
   * on it, who is carrying it — and labelling the groups lets the eye skip two
   * thirds of the page.
   */
  .group { margin: 22px 0 0; }
  .group__label {
    font-size: 11.5px; letter-spacing: .12em; text-transform: uppercase;
    color: var(--ink-3); margin: 0 0 2px; font-weight: 600;
  }
  .facts { margin: 0; padding: 0; }
  .fact {
    display: flex; justify-content: space-between; align-items: baseline; gap: 18px;
    padding: 11px 0; border-bottom: 1px solid var(--line);
  }
  .group:last-of-type .fact:last-child { border-bottom: 0; }
  dt { color: var(--ink-2); font-size: 14px; flex: 0 0 auto; }
  dd {
    margin: 0; text-align: right; font-weight: 600; min-width: 0;
    /* Plates, distances, dates and quantities are all columns of digits;
     * proportional figures make them jitter from row to row. */
    font-variant-numeric: tabular-nums;
  }
  dd a { color: var(--brand); text-underline-offset: 3px; }
  .sub { display: block; font-weight: 400; font-size: 12.5px; color: var(--ink-3); margin-top: 2px; }
  .fine { color: var(--ink-3); font-size: 12.5px; margin: 22px 0 0; text-wrap: pretty; }

  /*
   * MapLibre ships a white attribution bar and white zoom buttons. On a dark
   * basemap they are the brightest thing on the page — brighter than the
   * status — and the credit block spanned two lines across the bottom third of
   * the map. Restyled to sit in the map rather than on top of it. The credit
   * stays legible and clickable: it is a licence term, not decoration.
   */
  .maplibregl-ctrl-attrib.maplibregl-compact {
    background: rgba(10,16,24,.82) !important;
    backdrop-filter: blur(2px);
    border-radius: 8px;
  }
  .maplibregl-ctrl-attrib, .maplibregl-ctrl-attrib a {
    color: var(--ink-3) !important; font-size: 10.5px !important;
  }
  .maplibregl-ctrl-attrib a { text-decoration: none; }
  .maplibregl-ctrl-attrib-button { filter: invert(1) opacity(.55); }
  .maplibregl-ctrl-group {
    background: rgba(17,26,40,.9) !important;
    border: 1px solid var(--line) !important; box-shadow: none !important;
  }
  .maplibregl-ctrl-group button + button { border-top-color: var(--line) !important; }
  .maplibregl-ctrl-group button span { filter: invert(1) opacity(.7); }
</style>
</head>
<body>
  <main class="wrap">
${body}
  </main>
${tail}
</body>
</html>`;
}

/**
 * The relative clock.
 *
 * Rendered client-side and ticking, because the honest headline on this page is
 * not "the truck is here" but "this is how old our newest fix is" — and that
 * number keeps growing while the page sits open on a customer's desk. The
 * absolute server-formatted timestamp is printed underneath it precisely
 * because the device's own clock cannot be trusted to compute the difference
 * correctly; clamping at zero keeps a fast phone from reading "-3 dakika önce".
 */
function agoScript(): string {
  return `<script>
(function () {
  var el = document.getElementById('ago');
  if (!el) return;
  var at = Number(el.getAttribute('data-at'));
  function tick() {
    var s = Math.max(0, Math.round((Date.now() - at) / 1000));
    el.textContent =
      s < 60    ? 'az önce' :
      s < 3600  ? Math.floor(s / 60) + ' dakika önce' :
      s < 86400 ? Math.floor(s / 3600) + ' saat önce' :
                  Math.floor(s / 86400) + ' gün önce';
  }
  tick();
  setInterval(tick, 30000);
})();
</script>`;
}

function mapScripts(data: { lat: number | null; lon: number | null; dest: number[] | null; route: unknown }): string {
  const base = `https://unpkg.com/maplibre-gl@${MAPLIBRE_VERSION}/dist/maplibre-gl`;

  /*
   * Everything the map needs is emitted at the END of the body, in order.
   *
   * `defer` cannot do this job: an inline script ignores the attribute, so the
   * initialiser below would run before the library it needs had arrived. Two
   * parser-blocking tags in sequence give the ordering for free, and because
   * they are last, the status, the distance and the last-update time — the
   * things the customer actually came for — are painted and readable before
   * 200 kB of map library is even requested. On a 2G link from Basra that is
   * the difference between a useful page and a blank one.
   *
   * The stylesheet goes here too, for the same reason: WHATWG permits
   * `<link rel=stylesheet>` in the body, and in the head it would block the
   * first paint of text that does not depend on it.
   */
  return `<link rel="stylesheet" href="${base}.css">
${agoScript()}
<script src="${base}.js"></script>
<script>
(function () {
  var el = document.getElementById('map');
  if (!el) return;
  if (!window.maplibregl) {
    // The CDN is unreachable or blocked — on this route that is a real case,
    // not a theoretical one, since the reader may be behind a national filter.
    // Everything above still tells the customer where their load is, so say so
    // rather than leaving "Harita yükleniyor…" spinning forever.
    var note = el.querySelector('.map__note');
    if (note) note.textContent = 'Harita yüklenemedi. Yukarıdaki bilgiler günceldir.';
    return;
  }

  var d = ${jsonForScript(data)};
  el.textContent = '';
  el.className = 'map is-ready';

  var map = new maplibregl.Map({
    container: el,
    style: ${jsonForScript(MAP_STYLE)},
    center: [d.lon, d.lat],
    zoom: 8,
    // A consignee wants to know where the load is, not to fly around it. No
    // rotation means no way to end up staring at a tilted map with no compass.
    dragRotate: false,
    pitchWithRotate: false
    // attributionControl is left at its default on purpose. The OpenFreeMap /
    // OpenMapTiles / OpenStreetMap credit is a licence term, and the dashboard
    // already learned this the expensive way: \`compact: true\` measurably did
    // not take effect, while unset lets MapLibre show the credit in full above
    // 640 px of map width and collapse it to an i below. Nothing on this page
    // overlays the bottom-right corner, so it stays visible either way.
  });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');

  // The OpenFreeMap style asks for sprite images its own sheet does not carry
  // (\`circle-11\`, \`wood-pattern\`). A transparent 1x1 resolves each name once
  // instead of letting MapLibre re-warn on every tile. Same fix as the
  // dashboard's FleetMap; nothing visible changes.
  map.on('styleimagemissing', function (e) {
    if (map.hasImage(e.id)) return;
    map.addImage(e.id, { width: 1, height: 1, data: new Uint8Array(4) });
  });

  map.on('load', function () {
    var bounds = new maplibregl.LngLatBounds([d.lon, d.lat], [d.lon, d.lat]);
    var extended = false;

    if (d.route && d.route.features && d.route.features.length) {
      var geom = d.route.features[0].geometry;
      // Asserting LineString here is what blanked the dashboard once: a session
      // with a single fix yields a Point, and reading .coordinates off it threw.
      if (geom && geom.type === 'LineString' && geom.coordinates.length > 1) {
        map.addSource('route', { type: 'geojson', data: d.route });
        map.addLayer({
          id: 'route-line', type: 'line', source: 'route',
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': '#38bdf8', 'line-width': 4, 'line-opacity': 0.85 }
        });
        geom.coordinates.forEach(function (c) { bounds.extend(c); extended = true; });
      }
    }

    if (d.dest) {
      map.addSource('dest', {
        type: 'geojson',
        data: { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: d.dest } }
      });
      map.addLayer({
        id: 'dest-dot', type: 'circle', source: 'dest',
        paint: {
          'circle-radius': 7, 'circle-color': '#0b1220',
          'circle-stroke-width': 3, 'circle-stroke-color': '#7dd3fc'
        }
      });
      bounds.extend(d.dest);
      extended = true;
    }

    map.addSource('truck', {
      type: 'geojson',
      data: { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [d.lon, d.lat] } }
    });
    map.addLayer({
      id: 'truck-dot', type: 'circle', source: 'truck',
      paint: {
        'circle-radius': 9, 'circle-color': '#22c55e',
        'circle-stroke-width': 3, 'circle-stroke-color': '#0b1220'
      }
    });

    // Only fit when there is a second thing to fit to. fitBounds on a single
    // point is a degenerate box and MapLibre answers it with maximum zoom — a
    // customer staring at rooftops with no idea which country they are in.
    if (extended) map.fitBounds(bounds, { padding: 44, maxZoom: 11, duration: 0 });
  });
})();
</script>`;
}

// -----------------------------------------------------------------------------
// Copy
// -----------------------------------------------------------------------------

function describeStatus(view: ConsigneeView): { title: string; detail: string; tone: StatusTone } {
  /*
   * The order's status outranks the session's.
   *
   * DELIVERED is a human confirming the thing the consignee actually wants to
   * know. A session only ever knows that a phone stopped reporting, which is
   * why migration 0008's trigger deliberately refuses to infer delivery from
   * it — and why this page must not either.
   */
  if (view.orderStatus === 'DELIVERED') {
    return { title: 'Teslim edildi', detail: 'Sevkiyat teslim edildi.', tone: 'done' };
  }
  if (view.orderStatus === 'CANCELLED' || view.status === 'CANCELLED') {
    return {
      title: 'İptal edildi',
      detail: 'Bu sevkiyat iptal edildi. Ayrıntı için sevkiyat sorumlunuzla görüşün.',
      tone: 'stop',
    };
  }

  switch (view.status) {
    case 'DRAFT':
    case 'ASSIGNED':
      return {
        title: 'Hazırlanıyor',
        detail: 'Sevkiyat planlandı, araç henüz yola çıkmadı.',
        tone: 'wait',
      };
    case 'CLAIMED':
      return {
        title: 'Yola çıkıyor',
        detail: 'Sürücü hazır, takip birazdan başlayacak.',
        tone: 'wait',
      };
    case 'ACTIVE':
      return {
        title: 'Yolda',
        detail: signalDetail(view.signalState),
        // A truck whose last fix is hours old is not "live", however green the
        // session status is. Saying otherwise on a customer's page is how a
        // dispatcher ends up explaining a map that was lying.
        tone: view.signalState === 'LIVE' || view.signalState === 'DELAYED' ? 'live' : 'wait',
      };
    case 'PAUSED':
      return { title: 'Molada', detail: 'Araç şu anda duruyor. Takip sürüyor.', tone: 'wait' };
    case 'COMPLETED':
      return {
        title: 'Takip tamamlandı',
        detail: 'Aracın takibi sona erdi. Teslimat onayı için sevkiyat sorumlunuzla görüşün.',
        tone: 'done',
      };
    case 'EXPIRED':
    default:
      return {
        title: 'Takip sona erdi',
        detail: 'Bu sevkiyatın takip süresi doldu. Güncel bilgi için bizimle iletişime geçin.',
        tone: 'done',
      };
  }
}

function signalDetail(signalState: string): string {
  switch (signalState) {
    case 'LIVE':
      return 'Araç yolda, konum canlı olarak güncelleniyor.';
    case 'DELAYED':
      return 'Araç yolda. Konum birkaç dakikadır güncellenmedi.';
    case 'STALE':
      return 'Araç yolda. Konum bir süredir alınamıyor, araç kapsama alanı dışında olabilir.';
    default:
      return 'Araç yolda. Konum şu anda alınamıyor, araç kapsama alanı dışında olabilir.';
  }
}

// -----------------------------------------------------------------------------
// Formatting and escaping
// -----------------------------------------------------------------------------

function formatKm(km: number | null): string | null {
  if (km === null || km === undefined) return null;
  // One decimal only under 10 km. "342,4 km" implies a precision a straight-line
  // distance between two GPS fixes does not have; "8,3 km" is the range where
  // the extra digit tells the receiving warehouse something they can act on.
  const digits = km < 10 ? 1 : 0;
  return `${new Intl.NumberFormat('tr-TR', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(km)} km`;
}

/**
 * Every value interpolated into this page comes out of the database and lands
 * in a document served to an unauthenticated stranger. Consignee names, order
 * references, destination labels and driver names are all dispatcher-entered
 * free text: without this, a customer recorded as `<script>…</script>` is
 * stored XSS on the one page we deliberately hand to third parties.
 */
function esc(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * JSON destined for a `<script>` block needs more than JSON.stringify.
 *
 * The string `</script>` inside a perfectly valid JSON string still closes the
 * element — the HTML parser never sees the JSON, only the bytes — so `<` is
 * escaped at source. U+2028 and U+2029 are legal in JSON strings and illegal as
 * raw line terminators in JavaScript source, which is a syntax error that only
 * ever shows up on the one shipment whose notes were pasted out of Word.
 */
function jsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

import {
  Body,
  Controller,
  Delete,
  Get,
  Logger,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { CurrentUser, Public, Roles } from '../auth/decorators';
import { RateLimit } from '../common/rate-limit.guard';
import type { FastifyRequest } from 'fastify';
import {
  formatDateTime,
  formatNumber,
  isRtl,
  LOCALE_NAME,
  otherLocales,
  resolveLocale,
  strings,
  type ShareLocale,
  type ShareStrings,
} from './share.i18n';
import { ShareService, type ConsigneeView, type ShareResolution } from './share.service';
import { CreateShareLinkDto } from './dto';
import { pageHead, pageStyle } from '../common/page-chrome';

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
  async page(
    @Param('token') token: string,
    @Query('lang') lang: string | undefined,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    let rendered: { status: number; html: string };
    /*
     * Chosen before the lookup, so an expired or unknown link is still refused
     * in a language the reader can read. Getting that wrong would mean the one
     * page a consignee sees when something is wrong is the one page they
     * cannot understand.
     *
     * The country of the consignee is the strongest signal and it only exists
     * once the token resolves, so the notice pages fall back to the header and
     * the query while the shipment page gets the better answer below.
     */
    const headerLocale = resolveLocale({
      query: lang,
      acceptLanguage: request.headers['accept-language'] ?? null,
    });

    try {
      rendered = render(await this.share.resolve(token), {
        query: lang,
        acceptLanguage: request.headers['accept-language'] ?? null,
        fallback: headerLocale,
      });
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
          strings(headerLocale).noticeErrorTitle,
          strings(headerLocale).noticeErrorBody,
          headerLocale,
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

function render(
  resolved: ShareResolution,
  locale: { query?: string | null; acceptLanguage?: string | null; fallback: ShareLocale },
): { status: number; html: string } {
  switch (resolved.kind) {
    case 'ok': {
      // Now that the consignee is known, their own country outranks the header:
      // these links are forwarded, and the reader is not always the browser
      // that was configured.
      const chosen = resolveLocale({
        query: locale.query,
        countryCode: resolved.view.customerCountryCode,
        acceptLanguage: locale.acceptLanguage,
      });
      return { status: 200, html: shipmentPage(resolved.view, chosen) };
    }
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
    case 'expired': {
      const t = strings(locale.fallback);
      return {
        status: 410,
        html: noticePage(t.noticeExpiredTitle, t.noticeExpiredBody, locale.fallback),
      };
    }
    case 'unknown':
    default: {
      const t = strings(locale.fallback);
      return {
        status: 404,
        html: noticePage(t.noticeInvalidTitle, t.noticeUnknownBody, locale.fallback),
      };
    }
  }
}

/**
 * Positron — the light basemap.
 *
 * Both it and `dark` beat the colourful `liberty` default for the same reason
 * (see apps/web/src/lib/mapStyle.ts): they are desaturated, so the only
 * saturated pixels on screen are the vehicle and its route.
 *
 * Light wins here on the one thing that actually decides it: where the page is
 * read. An agent checks it standing in a yard in Erbil or Karkuk — outdoors,
 * on a cheap phone, at whatever brightness the battery has left. A dark map in
 * direct sun is a grey rectangle.
 *
 * Everything painted ON the map has to move with it. The route line and both
 * markers were picked against a dark ground, and MapLibre's own controls go
 * back to their defaults, which were built for exactly this background.
 */
const MAP_STYLE = 'https://tiles.openfreemap.org/styles/positron';

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
function groupLabels(t: ShareStrings): Array<[FactGroup, string]> {
  return [
    ['now', t.groupNow],
    ['shipment', t.groupShipment],
    ['cargo', t.groupCargo],
    ['carrier', t.groupCarrier],
  ];
}

function renderGroups(facts: Fact[], t: ShareStrings): string {
  return groupLabels(t).map(([key, heading]) => {
    const rows = facts.filter((f) => f.group === key);
    if (!rows.length) return '';
    return `<section class="group">
      <p class="group__label">${heading}</p>
      <dl class="facts">
        ${rows
          /*
           * <bdi> around every value, and it is not decoration.
           *
           * On the Arabic page the document direction is RTL, and the browser's
           * bidirectional algorithm reorders any run of neutral characters —
           * digits, spaces, punctuation — against the surrounding direction.
           * Seen on the live page: a plate stored as "77 ADF 5824" rendered as
           * "ADF 5824 77", "520 km" rendered as "km 520", and "500 palet ·
           * 27 ton" came out as "palet · 27 ton 500". The data was correct in
           * every case; the display was not.
           *
           * A wrong plate number is the serious one. It is the field a
           * consignee reads to identify the lorry at their gate.
           *
           * <bdi> isolates the value from the paragraph direction and resolves
           * its own from its first strong character — so a Latin plate stays
           * left-to-right inside an RTL page, and an Arabic destination name
           * still reads right-to-left. dir="auto" on a <dd> would do the same
           * thing, but <bdi> carries the isolation even where a value is
           * concatenated with markup, which several of these are.
           */
          .map((f) => `<div class="fact"><dt>${esc(f.label)}</dt><dd><bdi>${f.value}</bdi></dd></div>`)
          .join('\n        ')}
      </dl>
    </section>`;
  }).join('\n    ');
}

function shipmentPage(view: ConsigneeView, locale: ShareLocale): string {
  const t = strings(locale);
  const state = describeStatus(view, t);
  const hasPosition = view.lat !== null && view.lon !== null;

  const facts: Fact[] = [
    { label: t.orderNumber, value: esc(view.orderNumber), group: 'shipment' },
    { label: t.consignee, value: esc(view.customerName), group: 'shipment' },
  ];

  if (view.destinationLabel) {
    facts.push({ label: t.destination, value: esc(view.destinationLabel), group: 'shipment' });
  }

  const remaining = formatKm(view.remainingKm, locale);
  if (remaining) {
    // "kuş uçuşu" is not a hedge, it is the truth: kh.v_live_fleet computes a
    // straight-line distance, not a road distance. A consignee planning a
    // forklift crew around a number that is 20% short would rightly be annoyed.
    facts.push({
      label: t.remaining,
      group: 'now',
      value: `${esc(remaining)} <span class="sub">${esc(t.asTheCrowFlies)}</span>`,
    });
  }

  if (view.plannedDeliveryAt) {
    facts.push({ label: t.plannedDelivery, value: esc(formatDateTime(locale, view.plannedDeliveryAt)), group: 'now' });
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
    facts.push({ label: t.groupCargo, value: esc(view.cargoSummary), group: 'cargo' });
  }
  if (view.itemList) {
    facts.push({ label: t.items, value: esc(view.itemList), group: 'cargo' });
  }

  const load: string[] = [];
  if (view.palletCount) load.push(`${formatNumber(locale, view.palletCount)} ${t.unitPallets}`);
  if (view.totalWeightKg) {
    /*
     * Tonnes above 1000 kg: a receiving clerk reads "12,4 ton" instantly and
     * has to stop and count digits on "12400 kg".
     *
     * Through formatNumber, not toLocaleString('tr-TR'). Pinned to Turkish this
     * put "18,4 ton" on the Arabic page, where the comma is a thousands
     * separator — the same misreading formatKm was already fixed for, missed
     * here because the weight is built inline rather than through a helper.
     */
    load.push(
      view.totalWeightKg >= 1000
        ? `${formatNumber(locale, view.totalWeightKg / 1000, 1)} ${t.unitTonnes}`
        : `${formatNumber(locale, view.totalWeightKg)} ${t.unitKg}`,
    );
  }
  if (load.length) {
    facts.push({ label: t.quantity, value: esc(load.join(' · ')), group: 'cargo' });
  }

  if (view.carrierName) {
    facts.push({ label: t.carrier, value: esc(view.carrierName), group: 'carrier' });
  }

  facts.push({
    label: t.lastFix,
    group: 'now',
    value: view.recordedAt
      ? `<span id="ago" data-at="${view.recordedAt.getTime()}">—</span>` +
        `<span class="sub">${esc(formatDateTime(locale, view.recordedAt))}</span>`
      : t.noFixYet,
  });

  // Only reachable when the link was minted with show_driver; the service does
  // not even select these columns otherwise.
  if (view.driverName) {
    facts.push({ label: t.driver, value: esc(view.driverName), group: 'carrier' });
  }
  if (view.driverPhone) {
    const dialable = view.driverPhone.replace(/[^\d+]/g, '');
    facts.push({
      label: t.driverPhone,
      group: 'carrier',
      value: `<a href="tel:${esc(dialable)}">${esc(view.driverPhone)}</a>`,
    });
  }
  if (view.vehiclePlate) {
    facts.push({ label: t.plate, value: esc(view.vehiclePlate), group: 'carrier' });
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
    t.pageTitle(esc(view.orderNumber)),
    `
    <header class="head">
      <div class="brandline">
        <span class="mark" aria-hidden="true">KH</span>
        <span class="logo">${esc(t.brand)}</span>
      </div>
      <button class="refresh" type="button" onclick="location.reload()">${esc(t.refresh)}</button>
    </header>

    <section class="status status--${state.tone}">
      <p class="status__ref"><bdi>${esc(view.orderNumber)}</bdi></p>
      <h1 class="status__title"><span class="status__dot" aria-hidden="true"></span>${esc(state.title)}</h1>
      <p class="status__detail">${esc(state.detail)}</p>
    </section>

    ${
      hasPosition
        ? `<div class="map" id="map"><span class="map__note">${esc(t.mapLoading)}</span></div>`
        : `<div class="map map--empty"><span class="map__note">${esc(t.mapNoPosition)}</span></div>`
    }

    ${renderGroups(facts, t)}

    <p class="fine">${esc(t.footerPrivate)}</p>
    <p class="fine">${esc(t.footerContact)}</p>
    ${languagePicker(locale, t)}
  `,
    hasPosition ? mapScripts(mapData, t) : agoScript(t),
    locale,
  );
}

/*
 * The language switcher.
 *
 * A nav rather than a bare link, because there is more than one destination
 * now, and a screen reader landing on two unlabelled language names in a footer
 * has no way to know what they are for — hence the aria-label, which is the one
 * string here that is itself translated.
 *
 * Each option carries its own lang and dir. Without them a browser hands
 * "العربية" to a layout engine that has been told the page is Turkish, which is
 * how a right-to-left word ends up with its punctuation on the wrong side, and
 * a screen reader set to Turkish pronounces the Arabic and Kurdish names as
 * gibberish.
 *
 * The language being read is deliberately not listed. This is a footer on a
 * page read on a phone, the reader can already see which language they are
 * looking at, and a disabled third entry is one more thing to skip past.
 */
function languagePicker(locale: ShareLocale, t: ShareStrings): string {
  const options = otherLocales(locale)
    .map(
      (other) =>
        `<a class="lang" href="?lang=${other}" hreflang="${other}"
            lang="${other}" dir="${isRtl(other) ? 'rtl' : 'ltr'}"
            >${esc(LOCALE_NAME[other])}</a>`,
    )
    .join('<span class="lang__sep" aria-hidden="true">·</span>');
  return `<nav class="fine langs" aria-label="${esc(t.languageLabel)}">${options}</nav>`;
}

function noticePage(title: string, message: string, locale: ShareLocale): string {
  const t = strings(locale);
  return page(
    `${esc(title)} — ${esc(t.brand)}`,
    `
    <header class="head"><div class="logo">${esc(t.brand)}</div></header>
    <h1>${esc(title)}</h1>
    <div class="status status--stop">
      <p class="status__detail">${esc(message)}</p>
    </div>
    ${
      /*
       * The switcher belongs here more than on the shipment page.
       *
       * Language is normally chosen from the consignee's country, and on this
       * page there is no consignee — an expired or unknown token resolves to
       * nobody, so the choice falls back to Accept-Language and then to
       * Turkish. That is precisely the situation where a reader in Erbil is
       * handed a page in a language they cannot read, telling them something
       * has gone wrong, with no way to change it.
       */
      languagePicker(locale, t)
    }
  `,
    '',
    locale,
  );
}

/**
 * The shared shell. One stylesheet, inline, no webfont, no framework.
 *
 * `title`, `body` and `tail` are interpolated raw — every caller is responsible
 * for having run its own values through esc() already. Escaping again here
 * would double-encode the markup the callers legitimately build.
 */
function page(title: string, body: string, tail: string, locale: ShareLocale): string {
  return `<!doctype html>
<html lang="${locale}" dir="${isRtl(locale) ? 'rtl' : 'ltr'}">
${pageHead(title, pageStyle(SHARE_CSS))}
<body>
  <main class="wrap">
${body}
  </main>
${tail}
</body>
</html>`;
}

/* =============================================================================
   The consignee page's own styling
   =============================================================================
   The palette, the sheet, the button, the focus ring, the language switcher and
   the motion curve all come from ../common/page-chrome.ts, which is the same
   set of values the dispatcher's dashboard is built from and the same set the
   two driver pages use. Everything below is what this page does not share with
   either of them.

   Dark is decided there rather than here, and for this page's reason: more than
   half of it is a light basemap, and light chrome wrapped around a map is two
   designs arguing. The map cannot go dark without losing the contrast the
   vehicle marker depends on, so the map decides and everything else follows.
   ========================================================================== */
const SHARE_CSS = `
  /*
   * Layout geometry. The map's bleed is derived from these three numbers rather
   * than hard-coded, so changing the gutter or the column cannot silently leave
   * the map off-centre.
   */
  :root {
    --gutter:  16px;   /* body side padding */
    --wrap:    520px;  /* reading column */
    --map-max: 760px;  /* how wide the map is allowed to grow */
  }

  body { padding: 18px var(--gutter) 40px; }
  .wrap { width: 100%; max-width: var(--wrap); margin: 0 auto; }

  .head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  .brandline { display: flex; align-items: center; gap: 9px; min-width: 0; }
  /* The same monogram the dashboard's dock and the driver pages carry. This is
     the only KaraHoca surface a customer ever sees, so it is also the only
     place the company gets to look like one. */
  .mark {
    width: 30px; height: 30px; flex: 0 0 auto;
    display: grid; place-items: center;
    border-radius: var(--r-chip);
    background: linear-gradient(135deg, var(--brand) 0%, var(--brand-hover) 100%);
    color: #06101f; font-weight: 800; font-size: 11px; letter-spacing: -.02em;
  }
  .logo { font-weight: 800; letter-spacing: .16em; font-size: 12px; color: var(--brand); }
  .refresh {
    font: inherit; font-size: 13px; padding: 8px 14px; border-radius: var(--r-control);
    cursor: pointer; background: transparent; color: var(--ink-2);
    border: 1px solid var(--line-strong);
    transition: color .18s var(--ease), border-color .18s var(--ease);
  }
  .refresh:hover { color: var(--ink); border-color: var(--ink-3); }

  /*
   * The status IS the page.
   *
   * It used to sit inside a bordered card underneath an <h1> reading "Sevkiyat
   * Takibi" — so the loudest element on screen told the reader something they
   * already knew, having just clicked a tracking link, while the one fact they
   * came for was quieter than the heading above it. No card here: a card fences
   * the answer off as one item among several. Colour and scale carry it.
   */
  .status { margin: 24px 0 4px; }
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
    margin-inline-end: 11px; vertical-align: middle; position: relative; top: -3px;
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
    0%   { box-shadow: 0 0 0 0 rgba(82, 152, 255, .5); }
    70%  { box-shadow: 0 0 0 9px rgba(82, 152, 255, 0); }
    100% { box-shadow: 0 0 0 0 rgba(82, 152, 255, 0); }
  }
  @media (prefers-reduced-motion: reduce) {
    .status--live .status__dot { animation: none; }
    .refresh { transition: none; }
  }

  /*
   * The map is wider than the column it sits in, and the amount is derived,
   * not guessed.
   *
   * PHONE — edge to edge. 100% + gutter*2 with -gutter side margins cancels
   * exactly the body padding, so the map spans the full viewport and nothing
   * else moves. Deliberately not 100vw: on a desktop window with a classic
   * scrollbar, 100vw is wider than the client area and would add a horizontal
   * scrollbar to the whole page. Rounded corners and side borders come off,
   * because a rounded rectangle touching the screen edge reads as broken.
   *
   * The gain is 32px of map on a 412px phone — about 8% more ground, all of it
   * along the axis a road actually runs.
   */
  .map {
    margin-top: 20px; height: 46vh; min-height: 250px; overflow: hidden;
    width: calc(100% + var(--gutter) * 2);
    margin-inline: calc(var(--gutter) * -1);
    border-block: 1px solid var(--line);
    background: #e8eaed;
    box-shadow: inset 0 0 0 1px rgba(10, 16, 24, .35);
    display: grid; place-items: center;
  }

  /*
   * 792px is not a round number: it is --map-max + both gutters, the narrowest
   * viewport at which the wide map fits without touching the edge. Below it the
   * phone rule still applies, so there is no width at which the map overflows.
   *
   * The side margins are (wrap - map-max) / 2 = -120px, which centres a 760px
   * map on a 520px column exactly.
   */
  @media (min-width: 792px) {
    .map {
      width: var(--map-max);
      margin-inline: calc((var(--wrap) - var(--map-max)) / 2);
      border: 1px solid var(--line);
      border-radius: var(--r-panel);
    }
  }
  .map--empty { height: 92px; min-height: 0; }
  /* Sits on the light placeholder now, not on the dark panel. */
  .map__note { color: #5b6875; font-size: 13.5px; padding: 0 16px; text-align: center; }
  /* The "no position yet" box never loads tiles, so it keeps the dark panel. */
  .map--empty { background: var(--surface); box-shadow: none; }
  .map--empty .map__note { color: var(--ink-3); }
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
  .group { margin: 24px 0 0; }
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
    margin: 0; text-align: end; font-weight: 600; min-width: 0;
    /* Plates, distances, dates and quantities are all columns of digits;
     * proportional figures make them jitter from row to row. */
    font-variant-numeric: tabular-nums;
  }
  dd a { color: var(--brand); text-underline-offset: 3px; }
  .sub { display: block; font-weight: 400; font-size: 12.5px; color: var(--ink-3); margin-top: 2px; }
  .fine { color: var(--ink-3); font-size: 12.5px; margin: 22px 0 0; text-wrap: pretty; }

  /*
   * MapLibre's own control styling is built for a light basemap, so on positron
   * it is left almost alone — the inverted dark treatment this page carried
   * while the map was dark would now paint dark icons on dark buttons against
   * white tiles, i.e. invisible.
   *
   * Only two things change: the attribution shrinks (it was spanning two lines
   * across the bottom of the map) and the controls pick up this page's corner
   * radius so they read as part of the panel. The credit stays legible and
   * clickable; it is a licence term, not decoration.
   */
  .maplibregl-ctrl-attrib, .maplibregl-ctrl-attrib a { font-size: 10.5px !important; }
  .maplibregl-ctrl-attrib.maplibregl-compact { border-radius: var(--r-chip); }
  .maplibregl-ctrl-group { border-radius: var(--r-chip) !important; }
`

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
function agoScript(t: ShareStrings): string {
  return `<script>
(function () {
  var el = document.getElementById('ago');
  if (!el) return;
  var at = Number(el.getAttribute('data-at'));
  function tick() {
    var s = Math.max(0, Math.round((Date.now() - at) / 1000));
    el.textContent =
      s < 60    ? ${JSON.stringify(t.agoJustNow)} :
      s < 3600  ? Math.floor(s / 60) + ' ' + ${JSON.stringify(t.agoMinutes)} :
      s < 86400 ? Math.floor(s / 3600) + ' ' + ${JSON.stringify(t.agoHours)} :
                  Math.floor(s / 86400) + ' ' + ${JSON.stringify(t.agoDays)};
  }
  tick();
  setInterval(tick, 30000);
})();
</script>`;
}

function mapScripts(
  data: { lat: number | null; lon: number | null; dest: number[] | null; route: unknown },
  t: ShareStrings,
): string {
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
${agoScript(t)}
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
    if (note) note.textContent = ${JSON.stringify(t.mapFailed)};
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

  /*
   * MapLibre measures its container once, at construction, and never notices it
   * changed. The map is now edge-to-edge and its width follows the viewport, so
   * a phone turned sideways — which is exactly what someone does to look at a
   * map — left the canvas at portrait width with grey down one side.
   *
   * ResizeObserver rather than a window resize listener: it also catches the
   * browser URL bar collapsing on scroll, which changes the 46vh height without
   * ever firing a resize event.
   */
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(function () { map.resize(); }).observe(el);
  } else {
    window.addEventListener('resize', function () { map.resize(); });
  }

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
          paint: { 'line-color': '#0b6fa4', 'line-width': 4, 'line-opacity': 0.9 }
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
          'circle-radius': 7, 'circle-color': '#ffffff',
          'circle-stroke-width': 3, 'circle-stroke-color': '#0b6fa4'
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
        'circle-radius': 9, 'circle-color': '#15803d',
        'circle-stroke-width': 3, 'circle-stroke-color': '#ffffff'
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

function describeStatus(view: ConsigneeView, t: ShareStrings): { title: string; detail: string; tone: StatusTone } {
  /*
   * The order's status outranks the session's.
   *
   * DELIVERED is a human confirming the thing the consignee actually wants to
   * know. A session only ever knows that a phone stopped reporting, which is
   * why migration 0008's trigger deliberately refuses to infer delivery from
   * it — and why this page must not either.
   */
  if (view.orderStatus === 'DELIVERED') {
    return { title: t.statusDeliveredTitle, detail: t.statusDeliveredDetail, tone: 'done' };
  }
  if (view.orderStatus === 'CANCELLED' || view.status === 'CANCELLED') {
    return {
      title: t.statusCancelledTitle,
      detail: t.statusCancelledDetail,
      tone: 'stop',
    };
  }

  switch (view.status) {
    case 'DRAFT':
    case 'ASSIGNED':
      return {
        title: t.statusPreparing,
        detail: t.statusPlannedNotStarted,
        tone: 'wait',
      };
    case 'CLAIMED':
      return {
        title: t.statusDepartingTitle,
        detail: t.statusDriverReady,
        tone: 'wait',
      };
    case 'ACTIVE':
      return {
        title: t.statusOnTheRoadTitle,
        detail: signalDetail(view.signalState, t),
        // A truck whose last fix is hours old is not "live", however green the
        // session status is. Saying otherwise on a customer's page is how a
        // dispatcher ends up explaining a map that was lying.
        tone: view.signalState === 'LIVE' || view.signalState === 'DELAYED' ? 'live' : 'wait',
      };
    case 'PAUSED':
      return { title: t.statusOnBreakTitle, detail: t.statusStoppedDetail, tone: 'wait' };
    case 'COMPLETED':
      return {
        title: t.statusFinishedTitle,
        detail: t.statusFinishedDetail,
        tone: 'done',
      };
    case 'EXPIRED':
    default:
      return {
        title: t.noticeExpiredTitle,
        detail: t.noticeExpiredBody,
        tone: 'done',
      };
  }
}

function signalDetail(signalState: string, t: ShareStrings): string {
  switch (signalState) {
    case 'LIVE':
      return t.signalLive;
    case 'DELAYED':
      return t.signalDelayed;
    case 'STALE':
      return t.signalStale;
    case 'LOST':
      return t.signalLost;
    default:
      return t.signalNone;
  }
}

// -----------------------------------------------------------------------------
// Formatting and escaping
// -----------------------------------------------------------------------------

function formatKm(km: number | null, locale: ShareLocale): string | null {
  if (km === null || km === undefined) return null;
  // One decimal only under 10 km. "342,4 km" implies a precision a straight-line
  // distance between two GPS fixes does not have; "8,3 km" is the range where
  // the extra digit tells the receiving warehouse something they can act on.
  const digits = km < 10 ? 1 : 0;
  /*
   * The reader's own separators, not Turkish ones.
   *
   * Hard-coded to tr-TR this produced "1.100 km" on the Arabic page, which a
   * consignee reads as 1.1 km — the truck a thousand kilometres away looks like
   * it is at the gate. Gaziantep to Baghdad is over a thousand kilometres, so
   * that is the ordinary case on this corridor.
   */
  return `${formatNumber(locale, km, digits)} km`;
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

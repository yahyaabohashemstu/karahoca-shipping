import {
  Controller,
  Get,
  Header,
  Headers,
  Inject,
  NotFoundException,
  Param,
  Query,
} from '@nestjs/common';
import { CONFIG, type AppConfig } from '../config/configuration';
import { Public } from '../auth/decorators';
import { normalizeClaimCode } from '../common/crypto.util';
import { pageHead, pageStyle } from '../common/page-chrome';
import {
  driverStrings,
  isRtl,
  languageSwitcher,
  resolveDriverLocale,
  type DriverStrings,
} from './driver.i18n';

/**
 * The QR hand-off: both halves of it.
 *
 * Most Android QR scanners refuse to follow a bare `karahoca://` custom scheme,
 * so the printed QR encodes an https URL instead. Two things can then happen,
 * and this controller owns both:
 *
 *   1. The app is installed and the App Link is verified — Android opens
 *      MainActivity directly and the driver never sees a browser. That path
 *      depends on `/.well-known/assetlinks.json`, served below.
 *   2. Anything else — the landing page renders, fires an `intent://` URL that
 *      Chrome resolves to the installed app, and falls through to
 *      `S.browser_fallback_url` (the APK download) when there is no app.
 *
 * The landing page is deliberately a single self-contained HTML string: it must
 * render on a cheap driver phone with no network beyond this one request, and
 * it must never become a reason to deploy a second web service.
 */
@Controller()
export class HandoffController {
  constructor(@Inject(CONFIG) private readonly config: AppConfig) {}

  /**
   * Digital Asset Links — the file that turns `/t/<code>` into an App Link.
   *
   * Android fetches this once, at install time, over HTTPS. If the package name
   * and one of the signing fingerprints match, every `https://<host>/t/…` URL
   * on the device is routed straight to MainActivity — no browser, no chooser,
   * no "open with" dialog. That is the whole mechanism behind "scan the QR and
   * the app opens with the code already filled in".
   *
   * Three things break it silently, so all three are pinned here rather than
   * left to a static-file server: it must be served over HTTPS, it must return
   * `application/json`, and it must not redirect.
   *
   * The short max-age matters after a re-key. Android re-checks periodically
   * and on app update; a day-long CDN cache would keep handing out the old
   * fingerprint long after the new APK shipped.
   */
  @Public()
  @Get('.well-known/assetlinks.json')
  @Header('Content-Type', 'application/json; charset=utf-8')
  @Header('Cache-Control', 'public, max-age=300')
  assetLinks() {
    return [
      {
        relation: ['delegate_permission/common.handle_all_urls'],
        target: {
          namespace: 'android_app',
          package_name: this.config.session.deepLinkPackage,
          sha256_cert_fingerprints: this.config.session.androidCertFingerprints,
        },
      },
    ];
  }

  /**
   * The iOS counterpart — `/.well-known/apple-app-site-association`.
   *
   * Same job as assetlinks.json and the same three silent failure modes: HTTPS
   * only, `application/json`, and no redirect. Apple adds a fourth — the path
   * has no file extension, which is why it is a route rather than a static file
   * and why it is excluded from the global /api/v1 prefix in main.ts.
   *
   * Returns 404 until APPLE_APP_ID is set, and that is the correct answer
   * rather than a gap. The value is `<TeamID>.<BundleID>`, the Team ID is
   * issued by Apple to this company, and a placeholder would be actively worse
   * than nothing: Apple's CDN caches what it fetches, so a wrong appID has to
   * age out before a corrected one is believed. The day the Team ID exists,
   * setting one environment variable turns this on with no code change.
   *
   * The component pattern matches the Android intent filter — `/t/*`, the QR
   * hand-off link, and nothing else. The consignee's `/s/<token>` links are
   * deliberately excluded: those are opened by customers who do not have the
   * app and must stay in a browser.
   */
  @Public()
  @Get('.well-known/apple-app-site-association')
  @Header('Content-Type', 'application/json; charset=utf-8')
  @Header('Cache-Control', 'public, max-age=300')
  appleAppSiteAssociation() {
    const appId = this.config.session.appleAppId;
    if (!appId) {
      throw new NotFoundException('No iOS application is associated with this host.');
    }
    return {
      applinks: {
        details: [
          {
            appIDs: [appId],
            components: [
              {
                '/': '/t/*',
                comment: 'Driver hand-off links open the tracker app directly.',
              },
            ],
          },
        ],
      },
    };
  }

  /**
   * The install page — `track.karahoca.com/app`.
   *
   * There was no way to get the app onto a phone. The dashboard mentioned
   * `track.karahoca.com/downloads` as plain text, which is a directory: nginx
   * has autoindex off, so following it returned 403. The APK itself was only
   * reachable by knowing the exact filename.
   *
   * It has to live outside the dashboard because drivers have no dashboard
   * account — a link behind the login screen is no link at all. Short enough to
   * read down a phone line, which is how a stranded driver will receive it.
   */
  @Public()
  @Get('app')
  @Header('Content-Type', 'text/html; charset=utf-8')
  // Short, not long: the page names no version, but the day it does — or the
  // day the install steps change — a driver on a cached copy is a driver
  // following the wrong instructions.
  @Header('Cache-Control', 'public, max-age=600')
  landingApp(
    @Query('lang') lang: string | undefined,
    @Headers('accept-language') acceptLanguage: string | undefined,
  ): string {
    const apkUrl = this.apkUrl();
    const locale = resolveDriverLocale(lang, acceptLanguage);
    const t = driverStrings(locale);

    /*
     * The steps are numbered by the browser, from a real <ol>, rather than
     * carrying "1." in the string. A driver reading this in Arabic gets the
     * numerals their locale uses and the marker on the correct side of the
     * line, and neither needed a second translation.
     */
    const steps = t.steps.map((s) => `          <li>${s}</li>`).join('\n');

    return `<!doctype html>
<html lang="${locale}" dir="${isRtl(locale) ? 'rtl' : 'ltr'}">
${pageHead(t.installTitle, pageStyle(INSTALL_CSS))}
<body>
  <main class="card rise">
    <header class="hero">
      <div class="mark" aria-hidden="true">KH</div>
      <div class="logo">KARAHOCA</div>
      <h1>${t.installHeading}</h1>
      <p class="lead">${t.installLead}</p>
    </header>

    <a class="btn btn--primary btn--icon" href="${apkUrl}">
      <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" class="btn__icon">
        <path d="M10 3v9.4M6.2 9l3.8 3.8L13.8 9" stroke="currentColor" stroke-width="1.7"
              stroke-linecap="round" stroke-linejoin="round"/>
        <path d="M3.6 15.4h12.8" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>
      </svg>
      ${t.download}
    </a>
    <p class="meta">${t.fileKind}<span class="meta__sep" aria-hidden="true">·</span>${t.requirement}</p>

    <section class="glass panel">
      <h2 class="panel__title">${t.stepsTitle}</h2>
      <ol class="steps">
${steps}
      </ol>
    </section>

    <aside class="note sheet">
      <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" class="note__icon">
        <circle cx="10" cy="10" r="7.4" stroke="currentColor" stroke-width="1.5"/>
        <path d="M10 9.2v4.4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
        <circle cx="10" cy="6.4" r="0.95" fill="currentColor"/>
      </svg>
      <p>${t.installNote}</p>
    </aside>

    <footer class="foot">${languageSwitcher(locale, t)}</footer>
  </main>
</body>
</html>`;
  }

  /**
   * karahoca-takip.apk, not -tracker.apk. The default was wrong and the
   * download button returned 404 in production: the filename the nginx sidecar
   * serves is fixed by the publishing convention in docker-compose
   * (`scp … /opt/karahoca/downloads/karahoca-takip.apk`).
   */
  private apkUrl(): string {
    return (
      this.config.session.apkDownloadUrl ??
      `${this.config.publicApiUrl}/downloads/karahoca-takip.apk`
    );
  }

  @Public()
  @Get('t/:code')
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  landing(
    @Param('code') rawCode: string,
    @Query('lang') lang: string | undefined,
    @Headers('accept-language') acceptLanguage: string | undefined,
  ): string {
    const code = normalizeClaimCode(rawCode).slice(0, 16);
    const pretty = code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
    const scheme = this.config.session.deepLinkScheme;
    const pkg = this.config.session.deepLinkPackage;
    const apkUrl = this.apkUrl();
    const intentUrl =
      `intent://track?c=${code}#Intent;scheme=${scheme};` +
      `package=${pkg};S.browser_fallback_url=${encodeURIComponent(apkUrl)};end`;

    const locale = resolveDriverLocale(lang, acceptLanguage);
    const t = driverStrings(locale);

    return `<!doctype html>
<html lang="${locale}" dir="${isRtl(locale) ? 'rtl' : 'ltr'}">
${pageHead(t.handoffTitle, pageStyle(HANDOFF_CSS))}
<body>
  <main class="card rise">
    <div class="mark" aria-hidden="true">KH</div>
    <div class="logo">KARAHOCA</div>
    <h1>${t.handoffHeading}</h1>
    <p class="lead">${t.handoffLead}</p>

    <p class="code__label">${t.codeLabel}</p>
    <!--
      dir="ltr" on the code, always.

      It is eight Latin characters with a hyphen in the middle, and in a
      right-to-left document a bidirectional algorithm will happily reorder the
      two halves around that hyphen. A driver reading 4821-9930 as 9930-4821
      types a code that will never claim anything, and nothing on either screen
      would explain why.
    -->
    <p class="code num sheet" dir="ltr">${pretty}</p>

    <a class="btn btn--primary" href="${intentUrl}" id="open">${t.openInApp}</a>
    <a class="btn btn--quiet" href="${apkUrl}">${t.downloadApk}</a>

    <p class="hint">${t.hint}</p>

    <footer class="foot">${languageSwitcher(locale, t)}</footer>
  </main>
<script>
  // One automatic attempt, then leave it to the button — auto-redirect loops on
  // devices where the app is not installed are worse than one extra tap.
  setTimeout(function () {
    if (document.visibilityState === 'visible') {
      window.location.href = document.getElementById('open').href;
    }
  }, 400);
</script>
</body>
</html>`;
  }
}

/* =============================================================================
   Page-specific styling
   =============================================================================
   Everything shared — the palette, the sheet, the button, the focus ring, the
   language switcher — lives in ../common/page-chrome.ts and is emitted by
   pageStyle(). What is left here is only what these two pages do not have in
   common with the consignee's tracking page.
   ========================================================================== */

/** Shared by both driver pages: the centred column, the mark, the headings. */
const DRIVER_CSS = `
  body { display: grid; place-items: center; padding: 28px 20px 36px; }
  .card { width: 100%; max-width: 26rem; }

  /*
   * The same monogram the dashboard's dock carries.
   *
   * A driver never sees the dashboard, so this is not continuity for them — it
   * is continuity for the dispatcher standing beside them at the loading dock
   * with the same mark on their own screen, and for the printed sheet the code
   * was scanned off.
   */
  .mark {
    width: 46px; height: 46px; margin: 0 auto 14px;
    display: grid; place-items: center;
    border-radius: var(--r-control);
    background: linear-gradient(135deg, var(--brand) 0%, var(--brand-hover) 100%);
    color: #06101f; font-weight: 800; font-size: 15px; letter-spacing: -.02em;
    box-shadow: 0 2px 14px -2px rgba(82, 152, 255, .55);
  }
  .logo {
    font-weight: 800; letter-spacing: .18em; font-size: 11px;
    color: var(--brand); text-align: center;
  }
  h1 {
    font-size: clamp(20px, 6vw, 24px); font-weight: 650; line-height: 1.2;
    letter-spacing: -.015em; margin: 12px 0 6px; text-align: center;
    text-wrap: balance;
  }
  .lead { color: var(--ink-2); font-size: 15px; text-align: center; margin: 0 0 26px; }

  .foot { margin-top: 30px; display: flex; justify-content: center; font-size: 13px; }
`;

const INSTALL_CSS = `
${DRIVER_CSS}
  /*
   * The install page had the tokens and none of the structure.
   *
   * A mark, a heading, a button and five loose paragraphs on a flat background
   * is what every other page in the product stopped looking like, and next to
   * the consignee's tracking page — which has a hero, a map and three labelled
   * groups — it read as an unfinished draft of the same design. What it was
   * missing was not colour. It was containers: something for the sequence to
   * live in, and something quieter for the aside that is not part of it.
   */
  .hero { text-align: center; margin-bottom: 24px; }

  .btn--icon { display: flex; align-items: center; justify-content: center; gap: 10px; }
  .btn__icon { width: 20px; height: 20px; flex: 0 0 auto; }

  /*
   * What the file is, and what it needs.
   *
   * A driver on mobile data at a loading dock should find out that their
   * five-year-old handset is too old here, in one line under the button, rather
   * than after twenty megabytes and a failed install.
   */
  .meta {
    margin: 12px 0 0; text-align: center;
    font-size: 12.5px; color: var(--ink-3);
  }
  .meta__sep { padding: 0 7px; opacity: .55; }

  .panel { margin-top: 26px; padding: 18px 18px 6px; }
  .panel__title {
    margin: 0 0 16px;
    font-size: 11.5px; font-weight: 600; letter-spacing: .12em; text-transform: uppercase;
    color: var(--ink-3);
  }

  /*
   * Counters drawn by hand, because the default marker cannot be styled and a
   * grey "1." beside a five-line instruction is invisible at arm's length in a
   * lorry cab. These are the one place a filled brand-tinted shape appears on
   * these pages, and that is deliberate: the numbers are the only thing on the
   * screen that has to be followed in order.
   */
  .steps { counter-reset: step; list-style: none; margin: 0; padding: 0; }
  .steps li {
    counter-increment: step;
    position: relative;
    padding-inline-start: 38px;
    padding-bottom: 20px;
    color: var(--ink-2);
    font-size: 14.5px;
    line-height: 1.55;
    text-wrap: pretty;
  }
  .steps li:last-child { padding-bottom: 12px; }
  .steps li::before {
    content: counter(step);
    position: absolute;
    inset-inline-start: 0;
    top: -1px;
    width: 26px; height: 26px;
    display: grid; place-items: center;
    border-radius: 50%;
    background: var(--brand-soft);
    color: var(--brand-hover);
    font-size: 13px; font-weight: 700;
    font-variant-numeric: tabular-nums;
  }

  /*
   * The spine between the numbers.
   *
   * Five circles in a column are five separate things; five circles joined by a
   * line are one sequence, and this is a sequence — step four cannot be done
   * before step three. It fades downward so the last segment does not stop
   * abruptly against nothing.
   */
  .steps li:not(:last-child)::after {
    content: '';
    position: absolute;
    inset-inline-start: 12px;
    /*
     * From just under one circle to just above the next, and both numbers are
     * measured rather than chosen.
     *
     * The circle is 26px tall at top:-1px, so its lower edge is at 25px; four
     * pixels of air puts the line at 29. A zero bottom is the item's
     * padding-box edge, which is one pixel above the next circle's top — so the
     * connector reaches both ends instead of floating between them. It was 4px,
     * which on a one-line step left 6px of line: too short to read as a
     * connector and just long enough to look like a rendering fault.
     */
    top: 29px;
    bottom: 0;
    width: 2px;
    border-radius: 1px;
    background: linear-gradient(to bottom, var(--line-strong), var(--line));
  }

  /*
   * The aside, quieter than the steps on purpose.
   *
   * It is the one block on the page that most readers should skip: it is for
   * the driver who already has the app, and for the one who is stuck. Giving it
   * the same weight as an instruction would put it in the sequence, which is
   * exactly where it does not belong.
   */
  .note {
    display: flex; align-items: flex-start; gap: 11px;
    margin: 16px 0 0;
    padding: 14px 16px;
    border-radius: var(--r-panel);
    color: var(--ink-3);
    font-size: 13.5px;
    line-height: 1.55;
    text-wrap: pretty;
  }
  .note p { margin: 0; }
  .note__icon { width: 18px; height: 18px; flex: 0 0 auto; margin-top: 1px; opacity: .8; }
`;

const HANDOFF_CSS = `
${DRIVER_CSS}
  .card { text-align: center; }

  .code__label {
    font-size: 11.5px; letter-spacing: .14em; text-transform: uppercase;
    color: var(--ink-3); margin: 0 0 8px; font-weight: 600;
  }

  /*
   * The code is the page.
   *
   * It is read aloud down a telephone line and typed into a phone by somebody
   * who has one hand free. Monospace so 0 and O cannot be confused, letter-spaced
   * so the eight characters do not run together, and a select-all rule so one
   * tap takes the whole thing rather than one group of four.
   */
  .code {
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    font-size: clamp(30px, 10vw, 38px); font-weight: 700; letter-spacing: .16em;
    border-radius: var(--r-panel);
    padding: 22px 12px; margin: 0 0 26px;
    user-select: all; -webkit-user-select: all;
  }

  .btn + .btn { margin-top: 10px; }
  .hint { font-size: 13px; color: var(--ink-3); margin: 22px 0 0; text-wrap: pretty; }
`;

/* `DriverStrings` is re-exported nowhere; this keeps the import honest. */
export type { DriverStrings };

import { Controller, Get, Header, Inject, Param } from '@nestjs/common';
import { CONFIG, type AppConfig } from '../config/configuration';
import { Public } from '../auth/decorators';
import { normalizeClaimCode } from '../common/crypto.util';

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
  landingApp(): string {
    const apkUrl = this.apkUrl();

    return `<!doctype html>
<html lang="tr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>KaraHoca Sürücü Uygulaması</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100dvh; display: grid; place-items: center;
    font: 16px/1.55 -apple-system, "Segoe UI", Roboto, system-ui, sans-serif;
    background: #0b1220; color: #e8eef9; padding: 24px;
  }
  .card { width: 100%; max-width: 420px; }
  .logo { font-weight: 800; letter-spacing: .14em; font-size: 13px; color: #7dd3fc; text-align: center; }
  h1 { font-size: 21px; font-weight: 600; margin: 22px 0 6px; text-align: center; }
  p.lead { color: #94a3b8; margin: 0 0 26px; font-size: 15px; text-align: center; }
  a.btn {
    display: block; padding: 17px; border-radius: 12px; font-weight: 700;
    text-decoration: none; text-align: center; background: #2563eb; color: #fff;
  }
  ol { margin: 26px 0 0; padding-left: 20px; color: #cbd5e1; font-size: 14.5px; }
  li { margin-bottom: 10px; }
  .note {
    margin-top: 24px; padding: 13px 15px; border-radius: 10px;
    background: #111c33; border: 1px solid #1e3a5f; color: #94a3b8; font-size: 13.5px;
  }
</style>
</head>
<body>
  <div class="card">
    <div class="logo">KARAHOCA</div>
    <h1>Sürücü Takip Uygulaması</h1>
    <p class="lead">Android telefonlar için.</p>

    <a class="btn" href="${apkUrl}">UYGULAMAYI İNDİR</a>

    <ol>
      <li>İndirme bitince dosyaya dokunun.</li>
      <li>Telefon <b>&ldquo;bilinmeyen kaynak&rdquo;</b> uyarısı verirse izin verin — uygulama Play Store'da değildir.</li>
      <li>Kurulumdan sonra uygulamayı açın.</li>
      <li>Sevkiyat sorumlunuzun gönderdiği <b>karekodu okutun</b>; kod otomatik yazılır. Karekod yoksa 8 haneli kodu elle girin.</li>
      <li>Listedeki tüm izinleri verin, sonra <b>TAKİBİ BAŞLAT</b>.</li>
    </ol>

    <div class="note">
      Uygulama zaten yüklüyse tekrar indirmeniz gerekmez; doğrudan karekodu okutun.
      Sorun yaşarsanız sevkiyat sorumlunuzu arayın.
    </div>
  </div>
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
  landing(@Param('code') rawCode: string): string {
    const code = normalizeClaimCode(rawCode).slice(0, 16);
    const pretty = code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
    const scheme = this.config.session.deepLinkScheme;
    const pkg = this.config.session.deepLinkPackage;
    const apkUrl = this.apkUrl();
    const intentUrl =
      `intent://track?c=${code}#Intent;scheme=${scheme};` +
      `package=${pkg};S.browser_fallback_url=${encodeURIComponent(apkUrl)};end`;

    return `<!doctype html>
<html lang="tr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>KaraHoca Sevkiyat Takibi</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100dvh; display: grid; place-items: center;
    font: 16px/1.5 -apple-system, "Segoe UI", Roboto, system-ui, sans-serif;
    background: #0b1220; color: #e8eef9; padding: 24px;
  }
  .card { width: 100%; max-width: 420px; text-align: center; }
  .logo { font-weight: 800; letter-spacing: .14em; font-size: 13px; color: #7dd3fc; margin-bottom: 28px; }
  h1 { font-size: 20px; font-weight: 600; margin: 0 0 8px; }
  p  { color: #94a3b8; margin: 0 0 28px; font-size: 15px; }
  .code {
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    font-size: 34px; font-weight: 700; letter-spacing: .16em;
    background: #111c33; border: 1px solid #1e3a5f; border-radius: 14px;
    padding: 22px 12px; margin-bottom: 28px; user-select: all;
  }
  a.btn {
    display: block; padding: 16px; border-radius: 12px; font-weight: 600;
    text-decoration: none; margin-bottom: 12px;
  }
  .primary   { background: #2563eb; color: #fff; }
  .secondary { background: transparent; color: #94a3b8; border: 1px solid #1e3a5f; }
  .hint { font-size: 13px; color: #64748b; margin-top: 24px; }
</style>
</head>
<body>
  <div class="card">
    <div class="logo">KARAHOCA</div>
    <h1>Sevkiyat Takip Oturumu</h1>
    <p>Uygulamayı açın ve bu kodu girin.</p>
    <div class="code">${pretty}</div>
    <a class="btn primary" href="${intentUrl}" id="open">Uygulamada Aç</a>
    <a class="btn secondary" href="${apkUrl}">Uygulamayı İndir (APK)</a>
    <div class="hint">Sorun yaşarsanız sevkiyat sorumlunuzu arayın.</div>
  </div>
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

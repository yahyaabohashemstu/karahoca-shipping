import { Controller, Get, Header, Inject, Param } from '@nestjs/common';
import { CONFIG, type AppConfig } from '../config/configuration';
import { Public } from '../auth/decorators';
import { normalizeClaimCode } from '../common/crypto.util';

/**
 * The QR-code landing page.
 *
 * Most Android QR scanners refuse to follow a bare `karahoca://` custom scheme,
 * so the printed QR encodes an https URL that lands here. This page then fires
 * an `intent://` URL, which Chrome resolves to the installed app and — if the
 * app is missing — falls through to `S.browser_fallback_url`, the APK download.
 *
 * Deliberately a single self-contained HTML string: it must render on a cheap
 * driver phone with no network beyond this one request, and it must never
 * become a reason to deploy a second web service.
 */
@Controller()
export class HandoffController {
  constructor(@Inject(CONFIG) private readonly config: AppConfig) {}

  @Public()
  @Get('t/:code')
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  landing(@Param('code') rawCode: string): string {
    const code = normalizeClaimCode(rawCode).slice(0, 16);
    const pretty = code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
    const scheme = this.config.session.deepLinkScheme;
    const pkg = this.config.session.deepLinkPackage;
    const apkUrl =
      this.config.session.apkDownloadUrl ??
      `${this.config.publicApiUrl}/downloads/karahoca-tracker.apk`;
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

import QRCode from 'qrcode';
import { describe, expect, it } from 'vitest';
import { HandoffController } from './handoff.controller';
import { DRIVER_LOCALES, driverStrings, resolveDriverLocale, type DriverLocale } from './driver.i18n';
import type { AppConfig } from '../config/configuration';

/*
 * The two pages a driver sees.
 *
 * Neither had a test, and both were Turkish-only until now — which is the kind
 * of gap that survives review precisely because the people reviewing read
 * Turkish. These assertions are the guard: they fail if a language is added to
 * the dictionary and not to the switcher, if a page stops flipping direction,
 * or if the claim code ever loses the one attribute that keeps its two halves
 * in the order they were printed.
 */

function controller(): HandoffController {
  const config = {
    publicApiUrl: 'https://track.karahoca.com',
    session: {
      deepLinkScheme: 'karahoca',
      deepLinkPackage: 'com.karahoca.tracker',
      androidCertFingerprints: ['1A:2B:12:86'],
      appleAppId: null,
      apkDownloadUrl: null,
    },
  } as unknown as AppConfig;
  return new HandoffController(config);
}

describe('the driver hand-off page', () => {
  it('renders in each language when asked for it', () => {
    const expected: Record<DriverLocale, RegExp> = {
      tr: /Sevkiyat Takip Oturumu/,
      ar: /جلسة تتبّع الشحنة/,
      ku: /Danişîna Şopandina Barê/,
    };
    for (const locale of DRIVER_LOCALES) {
      const html = controller().landing('48219930', locale, undefined);
      expect(html, locale).toMatch(expected[locale]);
    }
  });

  it('sets lang and dir on the document to match', () => {
    expect(controller().landing('48219930', 'tr', undefined)).toContain('<html lang="tr" dir="ltr">');
    expect(controller().landing('48219930', 'ar', undefined)).toContain('<html lang="ar" dir="rtl">');
    // Kurmanji is written in Latin script, so it reads left to right — the one
    // place this surface differs from the consignee page, whose Kurdish is
    // Sorani in Arabic script and therefore right-to-left.
    expect(controller().landing('48219930', 'ku', undefined)).toContain('<html lang="ku" dir="ltr">');
  });

  it('offers both other languages from every language', () => {
    for (const locale of DRIVER_LOCALES) {
      const html = controller().landing('48219930', locale, undefined);
      for (const other of DRIVER_LOCALES) {
        const link = `href="?lang=${other}"`;
        if (other === locale) {
          expect(html, `${locale} must not link to itself`).not.toContain(link);
        } else {
          expect(html, `${locale} must link to ${other}`).toContain(link);
        }
      }
    }
  });

  it('pins the claim code to left-to-right in every language', () => {
    /*
     * The regression this exists for. A hyphenated eight-character code inside a
     * right-to-left document is reordered around the hyphen by the bidirectional
     * algorithm: 4821-9930 is displayed as 9930-4821. A driver types what they
     * read, the code claims nothing, and neither screen can explain why.
     */
    for (const locale of DRIVER_LOCALES) {
      const html = controller().landing('48219930', locale, undefined);
      expect(html, locale).toMatch(/class="code num sheet" dir="ltr">4821-9930</);
    }
  });

  it('still carries the intent URL and the APK fallback', () => {
    const html = controller().landing('48219930', 'tr', undefined);
    expect(html).toContain('intent://track?c=48219930#Intent;scheme=karahoca;');
    expect(html).toContain('package=com.karahoca.tracker;');
    // The fallback is what a phone with no app installed follows.
    expect(html).toContain(encodeURIComponent('https://track.karahoca.com/downloads/karahoca-takip.apk'));
  });
});

describe('the driver install page', () => {
  it('renders every step in the reader’s language', async () => {
    for (const locale of DRIVER_LOCALES) {
      const html = await controller().landingApp(locale, undefined);
      const t = driverStrings(locale);
      for (const step of t.steps) {
        expect(html, `${locale}: ${step.slice(0, 24)}`).toContain(step);
      }
      expect(html).toContain(t.download);
      expect(html).toContain(t.installNote);
    }
  });

  it('numbers the steps with a real list rather than in the strings', async () => {
    // A translated "1." is a translated number in the wrong numeral system and
    // on the wrong side of the line. The browser can do both correctly.
    const html = await controller().landingApp('ar', undefined);
    expect(html).toContain('<ol class="steps">');
    for (const step of driverStrings('ar').steps) {
      expect(html).not.toContain(`1. ${step}`);
    }
  });

  it('gives the sequence somewhere to live', async () => {
    /*
     * Structure, asserted, because this page has already been shipped twice
     * with the design system's colours and none of its containers — a mark, a
     * heading, a button and five loose paragraphs on a flat background, next to
     * a consignee page with a hero, a map and three labelled groups.
     *
     * Also a cheap syntax canary. All of this CSS lives in a template literal,
     * and a stray backtick in one of its comments terminates the string — which
     * has happened three times in this file's history and takes the whole
     * module down with it. If that recurs, this spec cannot even load.
     */
    const html = await controller().landingApp('tr', undefined);
    expect(html).toContain('class="glass panel"');
    expect(html).toContain('class="panel__title"');
    expect(html).toContain('<ol class="steps">');
    // The connector between the numbers, and the aside that is not one of them.
    expect(html).toContain('.steps li:not(:last-child)::after');
    expect(html).toContain('class="note sheet"');
    // What the file is and what it needs, under the button.
    const t = driverStrings('tr');
    expect(html).toContain(t.fileKind);
    expect(html).toContain(t.requirement);
  });

  /**
   * A QR encoding the wrong URL looks exactly like a QR encoding the right one.
   *
   * So this does not eyeball the markup: it re-encodes the APK URL with the
   * same library and asserts the page carries those bytes. Encode anything else
   * — the install page instead of the file, a stale filename, the API base —
   * and the matrix differs and this fails.
   */
  it('carries a QR of the APK URL itself, not of this page', async () => {
    const html = await controller().landingApp('tr', undefined);
    const expected = await QRCode.toString(
      'https://track.karahoca.com/downloads/karahoca-takip.apk',
      { type: 'svg', errorCorrectionLevel: 'M', margin: 0, width: 220 },
    );
    expect(html).toContain('class="qr__code"');
    expect(html).toContain(expected);
  });

  it('captions the QR in every language', async () => {
    for (const locale of DRIVER_LOCALES) {
      const html = await controller().landingApp(locale, undefined);
      expect(html, locale).toContain(driverStrings(locale).qrHeading);
      expect(html, locale).toContain(driverStrings(locale).qrHint);
    }
  });

  it('points at the APK the nginx sidecar actually serves', async () => {
    // karahoca-takip.apk, not -tracker.apk: the filename is fixed by the
    // publishing convention and the download 404'd in production once already.
    expect(await controller().landingApp('tr', undefined)).toContain(
      'https://track.karahoca.com/downloads/karahoca-takip.apk',
    );
  });
});

describe('choosing the driver’s language', () => {
  it('takes an explicit request over everything else', () => {
    expect(resolveDriverLocale('ku', 'ar,tr;q=0.9')).toBe('ku');
  });

  it('falls back to the phone’s own setting', () => {
    expect(resolveDriverLocale(undefined, 'ar-IQ,ar;q=0.9,en;q=0.5')).toBe('ar');
    expect(resolveDriverLocale(undefined, 'tr-TR,tr;q=0.9')).toBe('tr');
  });

  it('answers any Kurdish tag with the only Kurdish this surface has', () => {
    // A phone set to Sorani belongs to somebody who reads Kurdish. Kurmanji in
    // Latin script is not their first choice, and it is a great deal closer
    // than Turkish.
    for (const tag of ['ku', 'kmr', 'ckb-IQ']) {
      expect(resolveDriverLocale(undefined, tag), tag).toBe('ku');
    }
  });

  it('honours q-values rather than header order', () => {
    expect(resolveDriverLocale(undefined, 'en;q=1.0,ar;q=0.9,tr;q=0.2')).toBe('ar');
  });

  it('lands on Turkish when nothing is known', () => {
    expect(resolveDriverLocale(undefined, undefined)).toBe('tr');
    expect(resolveDriverLocale('de', 'en-GB,en')).toBe('tr');
  });
});

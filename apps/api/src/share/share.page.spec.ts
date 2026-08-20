import { describe, expect, it } from 'vitest';
import { PublicShareController } from './share.controller';
import { SHARE_LOCALES, LOCALE_NAME, type ShareLocale } from './share.i18n';
import type { ConsigneeView, ShareResolution, ShareService } from './share.service';

/*
 * The rendered page, not just the dictionary behind it.
 *
 * share.i18n.spec.ts proves the strings are present and in the right language.
 * That is not the same as proving they reach the page: the switcher used to be
 * a two-way toggle built on an `otherLocale()` helper, and a third language
 * added to the dictionary alone would have left it rendering exactly one link
 * and no way to reach Kurdish at all.
 *
 * Driving the controller with a stubbed service is enough for that. No database
 * is involved, the render path is entirely pure below `resolve()`, and the HTML
 * that comes out is the HTML a consignee gets.
 */

const VIEW: ConsigneeView = {
  linkId: 'a3f1c0de-0000-4000-8000-000000000001',
  showRoute: false,
  showDriver: true,
  status: 'ACTIVE',
  signalState: 'LIVE',
  orderNumber: 'SIP-2026-0481',
  orderStatus: 'IN_TRANSIT',
  customerName: 'Altunsa Ticaret',
  customerCountryCode: 'IQ',
  destinationLabel: 'Kerkük Sanayi Bölgesi',
  destinationLat: 35.4681,
  destinationLon: 44.3922,
  plannedDeliveryAt: new Date('2026-08-20T14:30:00Z'),
  lat: 36.9081,
  lon: 42.3441,
  recordedAt: new Date('2026-08-19T14:30:00Z'),
  remainingKm: 1100,
  driverName: 'Mehmet Yılmaz',
  driverPhone: '+90 532 000 00 00',
  vehiclePlate: '27 AB 100',
  carrierName: 'Güneydoğu Nakliyat',
  totalWeightKg: 18400,
  palletCount: 22,
  cargoSummary: 'Deterjan',
  itemList: 'KH-500 x12 koli, KH-750 x4 koli',
  route: null,
};

/** Captures what the controller writes, in place of a Fastify reply. */
function capture() {
  const sent: { status?: number; html?: string; headers: Record<string, string> } = { headers: {} };
  const reply = {
    status(code: number) {
      sent.status = code;
      return this;
    },
    header(name: string, value: string) {
      sent.headers[name.toLowerCase()] = value;
      return this;
    },
    headers(map: Record<string, string>) {
      for (const [name, value] of Object.entries(map)) sent.headers[name.toLowerCase()] = value;
      return this;
    },
    type(value: string) {
      sent.headers['content-type'] = value;
      return this;
    },
    send(body: string) {
      sent.html = body;
      return this;
    },
  };
  return { sent, reply };
}

async function render(options: {
  lang?: string;
  acceptLanguage?: string;
  resolution?: ShareResolution;
}): Promise<string> {
  const service = {
    resolve: async () => options.resolution ?? ({ kind: 'ok', view: VIEW } as ShareResolution),
  } as unknown as ShareService;

  const controller = new PublicShareController(service);
  const { sent, reply } = capture();
  const request = { headers: { 'accept-language': options.acceptLanguage ?? '' } };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await controller.page('tok', options.lang, request as any, reply as any);
  return sent.html ?? '';
}

describe('the consignee page', () => {
  it('renders in each language when asked for it', async () => {
    const expected: Record<ShareLocale, RegExp> = {
      tr: /Sevkiyat Takibi/,
      ar: /تتبّع الشحنة/,
      ckb: /شوێنپێهەڵگرتنی بار/,
    };
    for (const locale of SHARE_LOCALES) {
      const html = await render({ lang: locale });
      expect(html, locale).toMatch(expected[locale]);
    }
  });

  it('sets lang and dir on the document to match', async () => {
    expect(await render({ lang: 'tr' })).toContain('<html lang="tr" dir="ltr">');
    expect(await render({ lang: 'ar' })).toContain('<html lang="ar" dir="rtl">');
    expect(await render({ lang: 'ckb' })).toContain('<html lang="ckb" dir="rtl">');
  });

  it('offers both other languages from every language', async () => {
    /*
     * The regression this exists for: with a two-way toggle, adding Sorani to
     * the dictionary would have left the Turkish page linking only to Arabic,
     * and Kurdish reachable solely by hand-editing the query string.
     */
    for (const locale of SHARE_LOCALES) {
      const html = await render({ lang: locale });
      for (const other of SHARE_LOCALES) {
        const link = `href="?lang=${other}"`;
        if (other === locale) {
          expect(html, `${locale} must not link to itself`).not.toContain(link);
        } else {
          expect(html, `${locale} must link to ${other}`).toContain(link);
          expect(html).toContain(LOCALE_NAME[other]);
        }
      }
    }
  });

  it('marks each switcher option with its own language and direction', async () => {
    // Without these a browser lays "العربية" out as if it were Turkish, and a
    // screen reader set to Turkish pronounces it as nonsense.
    const html = await render({ lang: 'tr' });
    expect(html).toMatch(/hreflang="ar"[\s\S]{0,80}dir="rtl"/);
    expect(html).toMatch(/hreflang="ckb"[\s\S]{0,80}dir="rtl"/);
  });

  it('refuses an expired link in the reader’s own language', async () => {
    // The one page a consignee sees when something is wrong is the page they
    // most need to be able to read.
    const html = await render({ lang: 'ckb', resolution: { kind: 'expired' } });
    expect(html).toContain('<html lang="ckb" dir="rtl">');
    expect(html).toContain('کاتی بەستەرەکە بەسەرچووە');
  });

  it('offers the switcher on the notice pages too', async () => {
    /*
     * These are the pages with no consignee behind them: an expired or unknown
     * token resolves to nobody, so the country signal is unavailable and the
     * language falls back to Accept-Language and then Turkish. A reader who
     * lands here in a language they cannot read is being told something has
     * gone wrong and needs a way out of it.
     */
    for (const kind of ['expired', 'unknown'] as const) {
      const html = await render({ lang: 'tr', resolution: { kind } });
      expect(html, `${kind} must link to ar`).toContain('href="?lang=ar"');
      expect(html, `${kind} must link to ckb`).toContain('href="?lang=ckb"');
      expect(html, `${kind} must not link to itself`).not.toContain('href="?lang=tr"');
    }
  });

  it('shows the distance and the plate without changing digit script', async () => {
    const html = await render({ lang: 'ckb' });
    expect(html).toContain('1,100 km');
    expect(html).toContain('27 AB 100');
    expect(html).not.toMatch(/[٠-٩۰-۹]/);
  });

  it('writes the load in the reader’s units and separators', async () => {
    /*
     * This line was built inline from Turkish literals and toLocaleString('tr-TR'),
     * so every non-Turkish reader got "22 palet · 18,4 ton": two untranslated
     * words, and a decimal comma that is a thousands separator in both
     * right-to-left languages. formatKm had already been fixed for exactly this
     * and this line was missed because it never went through the helper.
     */
    expect(await render({ lang: 'tr' })).toContain('22 palet · 18,4 ton');
    expect(await render({ lang: 'ar' })).toContain('22 منصّة · 18.4 طن');
    expect(await render({ lang: 'ckb' })).toContain('22 پالێت · 18.4 تەن');
  });

  it('gives an Iraqi consignee Arabic when no language is asked for', async () => {
    // Country beats Accept-Language: these links are forwarded, so the browser
    // that opens one is often not the consignee's.
    const html = await render({ acceptLanguage: 'tr-TR,tr;q=0.9' });
    expect(html).toContain('<html lang="ar" dir="rtl">');
  });

  it('gives a Sorani-configured browser Sorani even for an Iraqi consignee', async () => {
    const html = await render({ acceptLanguage: 'ckb,ar;q=0.8' });
    expect(html).toContain('<html lang="ckb" dir="rtl">');
  });
});

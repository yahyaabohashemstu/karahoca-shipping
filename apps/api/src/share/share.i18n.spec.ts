import { describe, expect, it } from 'vitest';
import {
  LOCALE_NAME,
  SHARE_LOCALES,
  SHARE_STRINGS,
  formatDateTime,
  formatNumber,
  isRtl,
  otherLocales,
  resolveLocale,
  strings,
  type ShareLocale,
} from './share.i18n';

/*
 * What these tests are for, and what they deliberately are not.
 *
 * Completeness needs no test. Every dictionary is typed `ShareStrings`, so a
 * missing key is a compile error rather than a silent fallback — a stronger
 * guarantee than any assertion here could make, and the reason this file does
 * not check for one.
 *
 * What types cannot see is whether the text in a dictionary is actually in that
 * dictionary's language, and whether the formatters still say what they were
 * written to say. Both have already gone wrong here: a distance pinned to tr-TR
 * rendered 1100 km as "1.100 km" on the Arabic page, which reads as 1.1 km, and
 * both right-to-left locales quietly defaulted to a 12-hour clock that the
 * Turkish page beside them does not use.
 */

const ARABIC_INDIC = /[٠-٩۰-۹]/;
const ARABIC_SCRIPT = /[؀-ۿ]/;

describe('locales', () => {
  it('lists every locale it can render', () => {
    const declared = [...SHARE_LOCALES].sort();
    const implemented = (Object.keys(SHARE_STRINGS) as ShareLocale[]).sort();
    expect(declared).toEqual(implemented);
    expect(declared).toEqual(['ar', 'ckb', 'tr']);
  });

  it('names each language in that language, not in Turkish', () => {
    // A picker offering "Arapça" is no use to somebody who cannot read Turkish,
    // which is exactly who it is for.
    expect(LOCALE_NAME.tr).toBe('Türkçe');
    expect(LOCALE_NAME.ar).toMatch(ARABIC_SCRIPT);
    expect(LOCALE_NAME.ckb).toMatch(ARABIC_SCRIPT);
  });

  it('knows which direction each language reads', () => {
    expect(isRtl('tr')).toBe(false);
    expect(isRtl('ar')).toBe(true);
    expect(isRtl('ckb')).toBe(true);
  });

  it('offers every other language in the switcher and never the current one', () => {
    for (const locale of SHARE_LOCALES) {
      const others = otherLocales(locale);
      expect(others).not.toContain(locale);
      expect(others).toHaveLength(SHARE_LOCALES.length - 1);
    }
  });
});

describe('choosing a language', () => {
  it('lets an explicit choice beat everything else', () => {
    expect(resolveLocale({ query: 'ckb', countryCode: 'TR', acceptLanguage: 'tr' })).toBe('ckb');
    expect(resolveLocale({ query: 'tr', countryCode: 'IQ', acceptLanguage: 'ar' })).toBe('tr');
  });

  it('reads the consignee country before the browser', () => {
    expect(resolveLocale({ countryCode: 'IQ', acceptLanguage: 'tr' })).toBe('ar');
    expect(resolveLocale({ countryCode: 'SY' })).toBe('ar');
    expect(resolveLocale({ countryCode: 'TR', acceptLanguage: 'ar' })).toBe('tr');
    // A German consignee gets Turkish and something machine-translatable, not
    // Arabic guessed at from the shape of the corridor.
    expect(resolveLocale({ countryCode: 'DE' })).toBe('tr');
  });

  it('lets an explicitly Sorani browser break Iraq’s tie, and only Iraq’s', () => {
    /*
     * IQ covers both Arabic-reading Baghdad and Sorani-reading Erbil, so the
     * country code alone cannot answer. A device set to Sorani is a deliberate
     * act and settles it; a device merely reporting Turkish is the default a
     * forwarded link arrives on and settles nothing.
     */
    expect(resolveLocale({ countryCode: 'IQ', acceptLanguage: 'ckb,ar;q=0.8' })).toBe('ckb');
    expect(resolveLocale({ countryCode: 'IQ', acceptLanguage: 'tr-TR,en;q=0.9' })).toBe('ar');
    // Syria has no such ambiguity, so the country still wins outright there.
    expect(resolveLocale({ countryCode: 'SY', acceptLanguage: 'ckb' })).toBe('ar');
    expect(resolveLocale({ countryCode: 'TR', acceptLanguage: 'ckb' })).toBe('tr');
  });

  it('accepts the tags a browser actually sends for Sorani', () => {
    expect(resolveLocale({ acceptLanguage: 'ckb' })).toBe('ckb');
    expect(resolveLocale({ acceptLanguage: 'ckb-IQ,ar;q=0.8' })).toBe('ckb');
    expect(resolveLocale({ acceptLanguage: 'ku-Arab-IQ' })).toBe('ckb');
  });

  it('does NOT answer Kurmanji with Sorani', () => {
    /*
     * 'ku' is Kurmanji: Latin script, read in Turkey. This page has no
     * Kurmanji, and Sorani is a script that reader cannot read — so falling
     * through to Turkish, which they can, is the correct answer and not a gap.
     */
    expect(resolveLocale({ acceptLanguage: 'ku' })).toBe('tr');
    expect(resolveLocale({ acceptLanguage: 'ku-TR' })).toBe('tr');
  });

  it('falls back to Turkish when nothing is known', () => {
    expect(resolveLocale({})).toBe('tr');
    expect(resolveLocale({ query: 'klingon', acceptLanguage: 'xx' })).toBe('tr');
  });
});

describe('formatting', () => {
  const evening = new Date('2026-08-19T14:30:00Z'); // 17:30 in Istanbul

  it('uses a 24-hour clock in every language', () => {
    /*
     * Arabic and Sorani both default to 12-hour with a one- or two-character
     * suffix (م, د.ن). Planned delivery is the field a warehouse rosters staff
     * around, and a reader who misses that suffix books the morning for a lorry
     * that arrives twelve hours later.
     */
    for (const locale of SHARE_LOCALES) {
      expect(formatDateTime(locale, evening), locale).toContain('17:30');
    }
  });

  it('never renders a digit in a script the plate number is not in', () => {
    for (const locale of SHARE_LOCALES) {
      expect(formatDateTime(locale, evening), locale).not.toMatch(ARABIC_INDIC);
      expect(formatNumber(locale, 1100), locale).not.toMatch(ARABIC_INDIC);
      expect(formatNumber(locale, 8.3, 1), locale).not.toMatch(ARABIC_INDIC);
    }
  });

  it('groups and points the way each reader expects', () => {
    // The failure this encodes: 1100 km shown Turkish-style as "1.100" reads to
    // an Arabic or Kurdish eye as 1.1 — a lorry a thousand kilometres away
    // looking like it is at the gate.
    expect(formatNumber('tr', 1100)).toBe('1.100');
    expect(formatNumber('ar', 1100)).toBe('1,100');
    expect(formatNumber('ckb', 1100)).toBe('1,100');

    expect(formatNumber('tr', 8.3, 1)).toBe('8,3');
    expect(formatNumber('ar', 8.3, 1)).toBe('8.3');
    expect(formatNumber('ckb', 8.3, 1)).toBe('8.3');
  });

  it('uses the Gregorian calendar, whatever the language prefers', () => {
    // 2 Safar 1448 is not a date anyone can check against a purchase order.
    for (const locale of SHARE_LOCALES) {
      expect(formatDateTime(locale, evening), locale).toContain('2026');
    }
  });

  it('returns null rather than "Invalid Date" for missing or broken input', () => {
    expect(formatDateTime('ckb', null)).toBeNull();
    expect(formatDateTime('ckb', 'not a date')).toBeNull();
  });
});

describe('the text itself', () => {
  type Key = keyof typeof SHARE_STRINGS.tr;
  const KEYS = Object.keys(SHARE_STRINGS.tr) as Key[];

  const text = (locale: ShareLocale, key: Key): string => {
    const value = strings(locale)[key];
    return typeof value === 'function' ? value('ORD-1') : value;
  };

  it('says something different in every language', () => {
    /*
     * The cheapest way to ship an untranslated string is to copy a dictionary
     * and forget a line. Nothing here is legitimately identical across two
     * languages: the brand is transliterated into both scripts, and every
     * remaining entry is a word or a sentence rather than a symbol.
     */
    const shared = KEYS.filter(
      (key) => new Set(SHARE_LOCALES.map((l) => text(l, key))).size !== SHARE_LOCALES.length,
    ).map(String);
    expect(shared).toEqual([]);
  });

  it('writes Arabic and Sorani in Arabic script, and Turkish in Latin', () => {
    for (const key of KEYS) {
      expect(text('ar', key), `ar.${String(key)}`).toMatch(ARABIC_SCRIPT);
      expect(text('ckb', key), `ckb.${String(key)}`).toMatch(ARABIC_SCRIPT);
      expect(text('tr', key), `tr.${String(key)}`).not.toMatch(ARABIC_SCRIPT);
    }
  });

  it('uses letters Sorani has and Arabic does not', () => {
    /*
     * Both are written in Arabic script, so "is this Arabic script" cannot tell
     * them apart — a dictionary copied wholesale from AR would pass that check
     * and ship an Arabic page labelled Kurdish. Sorani adds پ چ ژ ڕ ڤ گ ڵ ۆ ێ
     * to the alphabet, and real Sorani prose is full of them.
     */
    const soraniOnly = /[پچژڕڤگڵۆێ]/;
    const everything = KEYS.map((k) => text('ckb', k)).join(' ');
    expect(everything).toMatch(soraniOnly);

    // Not every short label needs one, but most of the dictionary should.
    const withSoraniLetters = KEYS.filter((k) => soraniOnly.test(text('ckb', k)));
    expect(withSoraniLetters.length).toBeGreaterThan(KEYS.length / 2);
  });
});

import { DEFAULT_LOCALE, type Locale } from './i18n/locale';

/**
 * ISO 3166-1 alpha-2 codes for the countries a Turkish detergent manufacturer
 * actually ships to.
 *
 * Its own module rather than living beside the component that first needed it:
 * both the consignee editor and the customer dialog use it, and the dialog is
 * rendered *by* the editor, so importing it from there is a cycle.
 *
 * A fixed list rather than free text is the whole point. Typed per shipment,
 * the same firm ends up filed under DE, DEU, Almanya and Germany, and no export
 * report ever adds up again. An unlisted destination still round-trips — the
 * raw two-letter code is stored and displayed unchanged.
 *
 * The names are no longer here. This used to be a hand-written table of Turkish
 * labels, which for three languages would have meant a hundred and fifty
 * hand-written labels and a hundred and fifty chances to get one wrong.
 * Intl.DisplayNames answers the same question from CLDR, in every locale this
 * dashboard offers — including Kurmanji, which it has data for.
 *
 * One label changes as a result: AE used to read "BAE" and now reads the full
 * "Birleşik Arap Emirlikleri". CLDR has no abbreviations, the full form is
 * unambiguous, and it is what the other two languages would have said anyway.
 */
export const COUNTRY_CODES = [
  'TR', 'DE', 'NL', 'FR', 'IT', 'GB', 'BG', 'RO', 'GR', 'RS',
  'UA', 'RU', 'GE', 'AZ', 'IQ', 'SY', 'SA', 'AE', 'QA', 'KW',
  'OM', 'BH', 'LY', 'EG', 'MA', 'DZ', 'TN', 'SD', 'IR', 'KZ',
  'UZ', 'TM', 'KG', 'PL', 'AT', 'BE', 'ES', 'SE', 'CH', 'CZ',
  'HU', 'CY', 'IL', 'JO', 'LB', 'AL', 'MK', 'XK', 'BA', 'MD',
];

/*
 * Turkish is the second entry in every chain, not English.
 *
 * Intl resolves to the first locale it has data for, and if a browser ships
 * without Kurmanji region data the alternative to naming this fallback is
 * English — which is the one language nobody in this office was hired for.
 * Turkish is at least the language the dashboard used to be in.
 */
const FALLBACK_CHAIN: Record<Locale, string[]> = {
  tr: ['tr'],
  ar: ['ar', 'tr'],
  ku: ['ku', 'tr'],
};

const DISPLAY_NAMES = new Map<Locale, Intl.DisplayNames | null>();

function displayNames(locale: Locale): Intl.DisplayNames | null {
  if (!DISPLAY_NAMES.has(locale)) {
    let instance: Intl.DisplayNames | null = null;
    try {
      instance = new Intl.DisplayNames(FALLBACK_CHAIN[locale] ?? [locale], { type: 'region' });
    } catch {
      // A browser without Intl.DisplayNames at all. The raw code still means
      // something to a dispatcher, and nothing here should throw over a label.
      instance = null;
    }
    DISPLAY_NAMES.set(locale, instance);
  }
  return DISPLAY_NAMES.get(locale) ?? null;
}

export function countryLabel(
  code: string | null | undefined,
  locale: Locale = DEFAULT_LOCALE,
): string {
  if (!code) return '—';
  const upper = code.toUpperCase();
  try {
    return displayNames(locale)?.of(upper) ?? upper;
  } catch {
    // `of` throws on anything that is not a well-formed region code, and this
    // value comes out of a database column a dispatcher can type into.
    return upper;
  }
}

const COLLATORS = new Map<Locale, Intl.Collator>();

function collator(locale: Locale): Intl.Collator {
  let existing = COLLATORS.get(locale);
  if (!existing) {
    existing = new Intl.Collator(locale);
    COLLATORS.set(locale, existing);
  }
  return existing;
}

/**
 * Domestic first — it is most shipments — then alphabetical in the reader's own
 * language.
 *
 * Sorting by the localised name rather than by the Turkish one is the point of
 * doing this per locale at all: a list of Arabic country names ordered by their
 * Turkish spellings is, to the person reading it, in no order whatsoever.
 */
export function countryOptions(locale: Locale = DEFAULT_LOCALE): Array<{
  code: string;
  label: string;
}> {
  const compare = collator(locale);
  return COUNTRY_CODES.map((code) => ({ code, label: countryLabel(code, locale) })).sort((a, b) =>
    a.code === 'TR' ? -1 : b.code === 'TR' ? 1 : compare.compare(a.label, b.label),
  );
}

/** True when a shipment leaves Turkey — the case that needs customs paperwork. */
export function isExport(code: string | null | undefined): boolean {
  return Boolean(code) && code!.toUpperCase() !== 'TR';
}

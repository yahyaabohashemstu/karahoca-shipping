import { DEFAULT_LOCALE, type Locale } from './i18n/locale';

/* =============================================================================
   Numbers and dates, in the reader's own conventions
   =============================================================================
   Sixteen call sites across this dashboard used to be pinned to 'tr-TR'. That
   was correct while the interface was Turkish and became a misreading the
   moment it was not — the same misreading the consignee page was already fixed
   for, and worth restating because it is not cosmetic:

       18400 kg     tr-TR "18.400"     ar "18,400"
       8.3          tr-TR "8,3"        ar "8.3"

   An Arabic reader shown the Turkish "18.400" reads eighteen point four. On a
   weight, a distance or a pallet count that is a decision made on the wrong
   number.

   Two extensions are load-bearing on Arabic, both for the same reason they are
   on the consignee page:

     nu-latn, or dates and quantities come back as ٢٠٢٦/٠٨/١٩ and ١٨٬٤٠٠ beside
     a Latin plate number and a Latin order reference.

     ca-gregory, or an Arabic locale may resolve to the Islamic calendar, and a
     delivery date given as 2 Safar 1448 cannot be checked against a purchase
     order.

   Kurmanji needs neither: CLDR gives it Latin digits, dot grouping and a comma
   decimal — the Turkish conventions its readers already use.
   ========================================================================== */

/**
 * hour12: false everywhere, deliberately.
 *
 * Arabic defaults to a 12-hour clock with a one-character suffix, so 17:30
 * renders as "05:30 م" while the Turkish screen beside it says "17:30". A
 * dispatcher comparing a planned delivery against a driver's last fix should
 * not have to notice a suffix to know which is which.
 */
const BASE: Intl.DateTimeFormatOptions = { timeZone: 'Europe/Istanbul', hour12: false };

const INTL_TAG: Record<Locale, string> = {
  tr: 'tr-TR',
  ar: 'ar-u-nu-latn-ca-gregory',
  ku: 'ku',
};

const NUMBER_TAG: Record<Locale, string> = {
  tr: 'tr-TR',
  ar: 'ar-u-nu-latn',
  ku: 'ku',
};

/*
 * Cached by locale and option shape. Constructing an Intl formatter is
 * expensive and a table of sixty sessions formats a date per row per render.
 */
const DATES = new Map<string, Intl.DateTimeFormat>();
const NUMBERS = new Map<string, Intl.NumberFormat>();

function dateFormatter(locale: Locale, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${locale}:${JSON.stringify(options)}`;
  let existing = DATES.get(key);
  if (!existing) {
    existing = new Intl.DateTimeFormat(INTL_TAG[locale] ?? INTL_TAG.tr, { ...BASE, ...options });
    DATES.set(key, existing);
  }
  return existing;
}

function numberFormatter(locale: Locale, options: Intl.NumberFormatOptions): Intl.NumberFormat {
  const key = `${locale}:${JSON.stringify(options)}`;
  let existing = NUMBERS.get(key);
  if (!existing) {
    existing = new Intl.NumberFormat(NUMBER_TAG[locale] ?? NUMBER_TAG.tr, options);
    NUMBERS.set(key, existing);
  }
  return existing;
}

/** An em dash for absent values, matching what the tables already print. */
export const ABSENT = '—';

export function formatNumber(
  locale: Locale,
  value: number | null | undefined,
  options: Intl.NumberFormatOptions = {},
): string {
  if (value === null || value === undefined || Number.isNaN(value)) return ABSENT;
  return numberFormatter(locale, options).format(value);
}

function toDate(value: Date | string | number | null | undefined): Date | null {
  if (value === null || value === undefined || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatDateTime(locale: Locale, value: Date | string | null | undefined): string {
  const date = toDate(value);
  if (!date) return ABSENT;
  return dateFormatter(locale, {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

/** Day, month and time — for tables where the year is implied by "this week". */
export function formatDayTime(locale: Locale, value: Date | string | null | undefined): string {
  const date = toDate(value);
  if (!date) return ABSENT;
  return dateFormatter(locale, {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

export function formatTime(locale: Locale, value: Date | string | null | undefined): string {
  const date = toDate(value);
  if (!date) return ABSENT;
  return dateFormatter(locale, { hour: '2-digit', minute: '2-digit' }).format(date);
}

export function formatDate(
  locale: Locale,
  value: Date | string | null | undefined,
  options: Intl.DateTimeFormatOptions = { day: '2-digit', month: '2-digit', year: 'numeric' },
): string {
  const date = toDate(value);
  if (!date) return ABSENT;
  return dateFormatter(locale, options).format(date);
}

/**
 * Everything bound to the current language, for use inside a component.
 *
 * The standalone functions above take a locale so that module-level helpers —
 * the ones that are not components and cannot call a hook — can still format
 * correctly.
 */
export function makeFormatters(locale: Locale = DEFAULT_LOCALE) {
  return {
    number: (value: number | null | undefined, options?: Intl.NumberFormatOptions) =>
      formatNumber(locale, value, options),
    dateTime: (value: Date | string | null | undefined) => formatDateTime(locale, value),
    dayTime: (value: Date | string | null | undefined) => formatDayTime(locale, value),
    time: (value: Date | string | null | undefined) => formatTime(locale, value),
    date: (value: Date | string | null | undefined, options?: Intl.DateTimeFormatOptions) =>
      formatDate(locale, value, options),
  };
}

export type Formatters = ReturnType<typeof makeFormatters>;

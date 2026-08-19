/* =============================================================================
   Which language the dashboard is in
   =============================================================================
   Shared by the server (the root layout, which must emit lang and dir before
   the first byte) and the client (the picker, which writes the choice back).
   Nothing here imports React or next/headers, so both sides can use it.

   The consignee page at apps/api/src/share has its own, separate, deliberately
   duplicated version of this idea. The two are not shared and should not be:
   that page offers Turkish, Arabic and *Sorani* because it is read in Erbil,
   and this one offers Turkish, Arabic and *Kurmanji* because it is read by
   staff in Gaziantep. Same three slots, two different Kurdish languages in two
   different scripts. A shared module would have to be parameterised by which
   Kurdish it means, which is more coupling than either side is worth.
   ========================================================================== */

export const LOCALES = ['tr', 'ar', 'ku'] as const;
export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = 'tr';

/**
 * What the picker calls each language, in that language.
 *
 * A menu offering "Arapça" is no use to somebody who cannot read Turkish, which
 * is exactly who it is for.
 */
export const LOCALE_NAME: Record<Locale, string> = {
  tr: 'Türkçe',
  ar: 'العربية',
  /*
   * Kurmanji, in Latin script — not the Sorani the consignee page offers.
   *
   * The readers here are KaraHoca's own staff and the carriers they deal with,
   * hired out of Gaziantep, Şanlıurfa, Mardin and Şırnak, where Kurmanji in
   * Latin letters is what people read and write. Sorani in Arabic script is
   * what Erbil reads, and Erbil is the consignee, who has their own page.
   */
  ku: 'Kurdî',
};

export function isRtl(locale: Locale): boolean {
  return locale === 'ar';
}

export function dirOf(locale: Locale): 'rtl' | 'ltr' {
  return isRtl(locale) ? 'rtl' : 'ltr';
}

/**
 * The cookie, not localStorage.
 *
 * Direction is the reason. A theme can be applied by a blocking script that
 * flips one attribute before first paint, which is what lib/theme.tsx does and
 * why it can live in localStorage. Language cannot: it changes the text itself,
 * which only React can re-render, and it changes `dir`, which reflows the whole
 * page. Reading localStorage would mean serving a Turkish left-to-right
 * document and then visibly rebuilding it as Arabic right-to-left on every
 * single page load.
 *
 * A cookie is on the request, so the server already knows, and the first byte
 * is correct.
 */
export const LOCALE_COOKIE = 'kh_lang';

/** A year. The choice is a property of the person, not of the session. */
export const LOCALE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}

/** Whatever the cookie held, narrowed to something renderable. */
export function parseLocale(value: string | undefined | null): Locale {
  return isLocale(value) ? value : DEFAULT_LOCALE;
}

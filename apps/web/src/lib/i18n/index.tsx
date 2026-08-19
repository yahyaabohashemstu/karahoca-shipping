'use client';

import { Fragment, createContext, useCallback, useContext, useMemo } from 'react';
import { makeFormatters, type Formatters } from '../format';
import { ar } from './ar';
import { ku } from './ku';
import { tr, type Dictionary } from './tr';
import {
  DEFAULT_LOCALE,
  LOCALE_COOKIE,
  LOCALE_COOKIE_MAX_AGE,
  isRtl,
  parseLocale,
  type Locale,
} from './locale';

export * from './locale';
export type { Dictionary } from './tr';

const DICTIONARIES: Record<Locale, Dictionary> = { tr, ar, ku };

interface I18nValue {
  locale: Locale;
  t: Dictionary;
  rtl: boolean;
  setLocale: (next: Locale) => void;
}

/*
 * The default is Turkish rather than null, so a component rendered outside the
 * provider shows text instead of throwing. Every route is wrapped, but a Modal
 * portalled somewhere unusual is exactly the sort of thing that finds the one
 * subtree that is not, and a dispatcher would rather see the wrong language
 * than a blank screen with a stack trace behind it.
 */
const I18nContext = createContext<I18nValue>({
  locale: DEFAULT_LOCALE,
  t: tr,
  rtl: false,
  setLocale: () => {},
});

export function I18nProvider({
  locale,
  children,
}: {
  locale: Locale;
  children: React.ReactNode;
}) {
  /*
   * Changing the language reloads the page, and that is a decision rather than
   * laziness.
   *
   * The alternative is to swap the dictionary in context and set lang and dir
   * on <html> by hand. It looks cheaper and is not: the direction flip reflows
   * every layout on the screen, and MapLibre in particular does not survive
   * having the writing direction changed underneath a live canvas — the live
   * map, the session map and the destination picker would each need tearing
   * down and rebuilding, which is the same cost as a reload with far more ways
   * to go wrong.
   *
   * A full load also guarantees the server re-renders <html lang dir> from the
   * cookie, so what the reader ends up looking at is exactly what they would
   * get if they opened the dashboard fresh. Switching language is a thing a
   * person does once.
   */
  const setLocale = useCallback((next: Locale) => {
    document.cookie = `${LOCALE_COOKIE}=${next}; path=/; max-age=${LOCALE_COOKIE_MAX_AGE}; samesite=lax`;
    window.location.reload();
  }, []);

  const value = useMemo<I18nValue>(
    () => ({ locale, t: DICTIONARIES[locale] ?? tr, rtl: isRtl(locale), setLocale }),
    [locale, setLocale],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

/** Everything about the current language. */
export function useI18n(): I18nValue {
  return useContext(I18nContext);
}

/**
 * Number and date formatters bound to the current language.
 *
 * Memoised on the locale, so a table of sixty rows shares one Intl instance
 * rather than constructing one per cell.
 */
export function useFormat(): Formatters {
  const { locale } = useI18n();
  return useMemo(() => makeFormatters(locale), [locale]);
}

/**
 * Substitute React nodes into a translated sentence.
 *
 * For the case where part of a sentence is styled — an emphasised number, a
 * link — and the rest is prose. The alternative is to split the sentence into
 * a lead and a tail in the dictionary, which silently fixes Turkish word order
 * for every language that does not share it. A placeholder leaves the whole
 * sentence, and the position of the value inside it, to the translator.
 *
 *     interpolate(t.cadence.estimateTime, [<Est>{rows}</Est>])
 */
export function interpolate(template: string, values: React.ReactNode[]): React.ReactNode[] {
  // split with a capture group alternates literal, index, literal, index, …
  return template.split(/\{(\d+)\}/).map((part, i) =>
    i % 2 === 0 ? part : <Fragment key={i}>{values[Number(part)]}</Fragment>,
  );
}

/** Just the strings — by far the common case. */
export function useT(): Dictionary {
  return useContext(I18nContext).t;
}

/**
 * The dictionary, outside React.
 *
 * A handful of user-facing strings are produced by plain modules that no
 * component owns — lib/download.ts throws an ApiError whose message a
 * dispatcher reads in a toast. Those cannot call a hook.
 *
 * Reading the cookie on each call rather than caching a reference set by the
 * provider: it is stateless, it cannot go stale, it cannot be wrong during the
 * first render, and these are error paths called once in a blue moon, so the
 * cost of parsing a short string does not matter. On the server there is no
 * document, and Turkish is the right answer there anyway.
 */
export function clientLocale(): Locale {
  if (typeof document === 'undefined') return DEFAULT_LOCALE;
  const match = document.cookie.match(new RegExp(`(?:^|; )${LOCALE_COOKIE}=([^;]*)`));
  return parseLocale(match?.[1]);
}

export function clientDictionary(): Dictionary {
  return DICTIONARIES[clientLocale()] ?? tr;
}

import { cookies } from 'next/headers';
import type { Metadata } from 'next';
import { ar } from './ar';
import { ku } from './ku';
import { tr, type Dictionary } from './tr';
import { LOCALE_COOKIE, parseLocale, type Locale } from './locale';

/* =============================================================================
   The dictionary, on the server
   =============================================================================
   Route layouts are server components and cannot call useT(), but they own the
   one string a reader sees before anything else renders: the browser tab.

   Imports come from './tr', './ar', './ku' directly and never from './index',
   which carries a 'use client' directive — pulling it in here would drag the
   whole provider into the server bundle and fail the build.
   ========================================================================== */

const DICTIONARIES: Record<Locale, Dictionary> = { tr, ar, ku };

export async function serverLocale(): Promise<{ locale: Locale; t: Dictionary }> {
  const locale = parseLocale((await cookies()).get(LOCALE_COOKIE)?.value);
  return { locale, t: DICTIONARIES[locale] ?? tr };
}

/**
 * A route's tab title, in the reader's language.
 *
 * Used as `export const generateMetadata = pageTitle((t) => t.nav.orders)`,
 * which reads at the call site as the static `metadata` object it replaces.
 *
 * It has to be generateMetadata rather than a plain export: `metadata` is
 * evaluated once when the module is first loaded, so a title resolved there
 * would be whichever language happened to load the route first and would then
 * stay that way for every reader until the server restarted.
 */
export function pageTitle(pick: (t: Dictionary) => string): () => Promise<Metadata> {
  return async () => ({ title: pick((await serverLocale()).t) });
}

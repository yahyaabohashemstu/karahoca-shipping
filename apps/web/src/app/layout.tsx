import type { Metadata, Viewport } from 'next';
import { cookies } from 'next/headers';
import { Inter, JetBrains_Mono, Noto_Sans_Arabic } from 'next/font/google';
import './globals.css';
import { Providers } from './providers';
import { THEME_SCRIPT } from '@/lib/theme';
import { LOCALE_COOKIE, dirOf, parseLocale } from '@/lib/i18n/locale';
import { serverLocale } from '@/lib/i18n/server';

/*
 * next/font downloads these at BUILD time and serves them from our own origin.
 * Nothing is fetched from Google at runtime — no third-party request from a
 * factory office, no render-blocking round trip, and no layout shift, because
 * Next also generates a metric-matched fallback.
 *
 * `latin-ext` is not optional here. The base `latin` subset has no ş, ğ, ı or
 * İ, nor the ê, î and û of Kurmanji — every one of which would otherwise fall
 * back to a different font mid-word.
 */
const inter = Inter({
  subsets: ['latin', 'latin-ext'],
  display: 'swap',
  variable: '--font-inter',
});

/*
 * Monospace is reserved for one thing: the claim code a dispatcher reads aloud
 * down a phone line to a driver. Proportional digits and an ambiguous 0/O are
 * how a truck ends up unable to start tracking.
 */
const mono = JetBrains_Mono({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-mono',
  weight: ['500', '700'],
});

/*
 * Inter has no Arabic glyphs at all, so without this the Arabic dashboard falls
 * through to whatever the operating system happens to supply — which on the
 * Windows machines in the office is a face that does not match Inter's weight
 * or metrics, and on a Linux box may be nothing at all.
 *
 * preload: false is deliberate. next/font preloads by default, which would make
 * every Turkish and Kurdish reader download an Arabic face they will never
 * render a glyph from. Left unpreloaded the browser fetches it only when text
 * actually resolves to it, which is precisely when the interface is Arabic.
 */
const arabic = Noto_Sans_Arabic({
  subsets: ['arabic'],
  display: 'swap',
  preload: false,
  variable: '--font-arabic',
});

export const generateMetadata = async (): Promise<Metadata> => {
  const { t } = await serverLocale();
  return {
    /*
     * A template, so each route can name itself.
     *
     * Every screen used to render the same <title>. A dispatcher with the live
     * map, a session and an order open in three tabs saw three identical tabs,
     * and browser history was a wall of one repeated line. Every page component
     * is 'use client' and so cannot export metadata itself, which is why each
     * route carries a tiny server layout beside it.
     *
     * generateMetadata rather than a static object, because a static one is
     * evaluated once per process: the first reader to load the dashboard would
     * fix the language of every other reader's tab until the server restarted.
     *
     * KaraHoca stays untransliterated in the suffix. It is the company's name,
     * and a tab is scanned rather than read.
     */
    title: { default: t.titles.appDefault, template: '%s — KaraHoca' },
    description: t.titles.appDescription,
    robots: { index: false, follow: false },
  };
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f7f9f9' },
    { media: '(prefers-color-scheme: dark)', color: '#0b1012' },
  ],
};

/*
 * Reading the cookie makes this route dynamic, which it already was — every
 * page under it is 'use client' and fetches through the API client, so nothing
 * here was ever statically rendered.
 *
 * The language has to be resolved on the server, not in an effect. It sets
 * `dir`, and a page that renders left-to-right and then flips would reflow
 * itself in front of the reader on every single load. The theme can afford a
 * blocking script and localStorage precisely because it does not.
 */
export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = parseLocale((await cookies()).get(LOCALE_COOKIE)?.value);

  return (
    <html
      lang={locale}
      dir={dirOf(locale)}
      className={`h-full ${inter.variable} ${mono.variable} ${arabic.variable}`}
      suppressHydrationWarning
    >
      <head>
        {/* Blocking, before first paint. See the comment on THEME_SCRIPT. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="h-full bg-bg font-sans text-base text-ink antialiased">
        <Providers locale={locale}>{children}</Providers>
      </body>
    </html>
  );
}

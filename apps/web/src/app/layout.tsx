import type { Metadata, Viewport } from 'next';
import { Inter, JetBrains_Mono } from 'next/font/google';
import './globals.css';
import { Providers } from './providers';
import { THEME_SCRIPT } from '@/lib/theme';

/*
 * next/font downloads these at BUILD time and serves them from our own origin.
 * Nothing is fetched from Google at runtime — no third-party request from a
 * factory office, no render-blocking round trip, and no layout shift, because
 * Next also generates a metric-matched fallback.
 *
 * `latin-ext` is not optional here. The entire interface is Turkish, and the
 * base `latin` subset has no ş, ğ, ı or İ — every one of which would fall back
 * to a different font mid-word.
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

export const metadata: Metadata = {
  title: 'KaraHoca — Sevkiyat Takip Merkezi',
  description: 'Üçüncü taraf nakliye araçları için canlı takip ve rota geçmişi',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f7f9f9' },
    { media: '(prefers-color-scheme: dark)', color: '#0b1012' },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="tr" className={`h-full ${inter.variable} ${mono.variable}`} suppressHydrationWarning>
      <head>
        {/* Blocking, before first paint. See the comment on THEME_SCRIPT. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="h-full bg-bg font-sans text-base text-ink antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}

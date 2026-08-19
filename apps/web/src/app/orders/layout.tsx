import type { Metadata } from 'next';
import { serverLocale } from '@/lib/i18n/server';

/*
 * default carries no suffix; template does.
 *
 * A nested `default` is itself passed through the PARENT's template, so
 * spelling out "Siparişler — KaraHoca" here produced "Siparişler — KaraHoca —
 * KaraHoca". The template is still needed, though: a bare `title: '…'`
 * string replaces the parent's template for the whole subtree and left
 * /orders/new with no suffix at all.
 */
export const generateMetadata = async (): Promise<Metadata> => ({
  title: { default: (await serverLocale()).t.nav.orders, template: '%s — KaraHoca' },
});

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}

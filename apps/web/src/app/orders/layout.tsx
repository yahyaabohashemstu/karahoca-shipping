import type { Metadata } from 'next';

/*
 * default carries no suffix; template does.
 *
 * A nested `default` is itself passed through the PARENT's template, so
 * spelling out "Siparişler — KaraHoca" here produced "Siparişler — KaraHoca —
 * KaraHoca". The template is still needed, though: a bare `title: '…'`
 * string replaces the parent's template for the whole subtree and left
 * /orders/new with no suffix at all.
 */
export const metadata: Metadata = {
  title: { default: 'Siparişler', template: '%s — KaraHoca' },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}

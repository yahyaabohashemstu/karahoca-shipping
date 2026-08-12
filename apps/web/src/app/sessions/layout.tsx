import type { Metadata } from 'next';

/*
 * default carries no suffix; template does.
 *
 * A nested `default` is itself passed through the PARENT's template, so
 * spelling out "Oturumlar — KaraHoca" here produced "Oturumlar — KaraHoca —
 * KaraHoca". The template is still needed, though: a bare `title: '…'`
 * string replaces the parent's template for the whole subtree and left
 * /sessions/new with no suffix at all.
 */
export const metadata: Metadata = {
  title: { default: 'Oturumlar', template: '%s — KaraHoca' },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}

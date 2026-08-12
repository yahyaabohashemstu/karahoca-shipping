import type { Metadata } from 'next';

/*
 * The template is repeated here, not just inherited.
 *
 * A plain `title: '…'` string in a layout replaces the parent's template for
 * everything below it, so /sessions/new rendered as a bare page name with no
 * "— KaraHoca" suffix. Declaring default + template keeps the suffix for the
 * children while still naming this route.
 */
export const metadata: Metadata = {
  title: { default: 'Oturumlar — KaraHoca', template: '%s — KaraHoca' },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}

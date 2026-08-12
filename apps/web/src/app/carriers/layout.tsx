import type { Metadata } from 'next';

// The page beside this is a client component and cannot export metadata.
export const metadata: Metadata = { title: 'Nakliyeciler' };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}

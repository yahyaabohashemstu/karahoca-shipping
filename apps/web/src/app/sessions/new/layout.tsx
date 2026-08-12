import type { Metadata } from 'next';

// The page beside this is a client component and cannot export metadata.
export const metadata: Metadata = { title: 'Yeni takip oturumu' };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}

import { pageTitle } from '@/lib/i18n/server';

// The page beside this is a client component and cannot export metadata.
export const generateMetadata = pageTitle((t) => t.titles.orderNew);

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}

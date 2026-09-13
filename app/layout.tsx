import type { Metadata } from 'next';
import { SiteNav } from '@/components/nav/site-nav';
import './globals.css';

export const metadata: Metadata = {
  title: 'Trading Desk',
  description: 'Stock analysis, Polymarket paper trading, and crypto momentum tools',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen bg-neutral-950 text-neutral-100 antialiased">
        <SiteNav />
        <main className="mx-auto w-full max-w-[100rem] px-4 py-6">{children}</main>
      </body>
    </html>
  );
}

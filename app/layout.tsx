import type { Metadata } from 'next';
import { TopNav } from '@/components/paper/top-nav';
import './globals.css';

export const metadata: Metadata = {
  title: 'Polymarket Paper Trading',
  description: 'Live paper-trading dashboard for Polymarket BTC 5m strategies',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen bg-neutral-950 text-neutral-100 antialiased">
        <TopNav />
        <main className="mx-auto max-w-7xl px-4 py-6">{children}</main>
      </body>
    </html>
  );
}

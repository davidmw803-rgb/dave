'use client';

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';

const tabs = [
  { href: '/', label: 'Home' },
  { href: '/trades', label: 'Trades' },
  { href: '/paper', label: 'Paper' },
  { href: '/halts', label: 'Halts' },
];

export function PageHeader({
  title,
  generatedAt,
  onRefresh,
  refreshing,
  showDryToggle,
  dryRun,
}: {
  title: string;
  generatedAt: string | null;
  onRefresh: () => void;
  refreshing: boolean;
  showDryToggle?: boolean;
  dryRun?: boolean;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const params = useSearchParams();

  const toggleDry = () => {
    const sp = new URLSearchParams(params.toString());
    const next = dryRun ? 'live' : 'dry';
    sp.set('mode', next);
    router.replace(`${pathname}?${sp.toString()}`);
  };

  return (
    <header className="sticky top-0 z-10 border-b border-neutral-800 bg-neutral-950/95 backdrop-blur">
      <div className="flex items-center justify-between px-4 py-3">
        <h1 className="text-base font-semibold">{title}</h1>
        <div className="flex items-center gap-2">
          {showDryToggle ? (
            <button
              onClick={toggleDry}
              className={`rounded border px-2 py-1 text-xs font-medium ${
                dryRun
                  ? 'border-amber-500/40 bg-amber-500/15 text-amber-300'
                  : 'border-emerald-500/40 bg-emerald-500/15 text-emerald-300'
              }`}
            >
              {dryRun ? 'DRY' : 'LIVE'}
            </button>
          ) : null}
          <button
            onClick={onRefresh}
            disabled={refreshing}
            className="rounded border border-neutral-700 bg-neutral-900 px-3 py-1 text-xs font-medium text-neutral-200 disabled:opacity-50"
          >
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </div>
      <nav className="flex gap-1 px-2 pb-2">
        {tabs.map((t) => {
          const active = pathname === t.href;
          return (
            <Link
              key={t.href}
              href={t.href}
              className={`rounded px-3 py-1.5 text-xs font-medium ${
                active ? 'bg-neutral-800 text-neutral-100' : 'text-neutral-400 hover:text-neutral-200'
              }`}
            >
              {t.label}
            </Link>
          );
        })}
      </nav>
      <div className="px-4 pb-2 text-[11px] text-neutral-500">
        {generatedAt ? `Updated ${new Date(generatedAt).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}` : 'No data'}
        {refreshing ? ' · refreshing…' : ''}
      </div>
    </header>
  );
}

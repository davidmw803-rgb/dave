'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';
import {
  NAV_SECTIONS,
  isItemActive,
  sectionForPath,
  sectionHref,
} from '@/lib/nav';

export function SiteNav() {
  const pathname = usePathname();
  const active = sectionForPath(pathname);

  return (
    <header className="sticky top-0 z-30 border-b border-neutral-800 bg-neutral-950/90 backdrop-blur">
      {/* Row 1 — product mark + top-level sections */}
      <div className="mx-auto flex w-full max-w-[100rem] items-center gap-6 px-4">
        <Link
          href="/"
          className="shrink-0 py-3 font-mono text-sm font-semibold tracking-tight text-emerald-400"
        >
          dave<span className="text-neutral-600">·</span>desk
        </Link>
        <nav className="flex items-stretch gap-1 overflow-x-auto">
          {NAV_SECTIONS.map((s) => {
            const isActive = s.id === active.id;
            return (
              <Link
                key={s.id}
                href={sectionHref(s)}
                className={cn(
                  'relative whitespace-nowrap px-3 py-3 text-sm font-medium transition-colors',
                  isActive
                    ? 'text-neutral-50'
                    : 'text-neutral-500 hover:text-neutral-200'
                )}
              >
                {s.label}
                {isActive ? (
                  <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-emerald-500" />
                ) : null}
              </Link>
            );
          })}
        </nav>
      </div>

      {/* Row 2 — sub-tabs for the active section */}
      <div className="border-t border-neutral-900 bg-neutral-900/40">
        <div className="mx-auto flex w-full max-w-[100rem] items-center gap-1 overflow-x-auto px-4 py-2">
          {active.items.map((item) =>
            item.disabled ? (
              <span
                key={item.href}
                className="flex items-center gap-1.5 whitespace-nowrap rounded px-2.5 py-1 text-xs text-neutral-600"
                title={item.note}
              >
                {item.label}
                {item.note ? (
                  <span className="text-[10px] uppercase tracking-wide text-neutral-700">
                    {item.note}
                  </span>
                ) : null}
              </span>
            ) : (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  'whitespace-nowrap rounded px-2.5 py-1 text-xs font-medium transition-colors',
                  isItemActive(item.href, pathname)
                    ? 'bg-neutral-800 text-neutral-100'
                    : 'text-neutral-400 hover:bg-neutral-800/50 hover:text-neutral-200'
                )}
              >
                {item.label}
              </Link>
            )
          )}
        </div>
      </div>
    </header>
  );
}

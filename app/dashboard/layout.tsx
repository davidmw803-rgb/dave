import Link from 'next/link';
import { logout } from '@/app/login/actions';

const NAV = [
  { href: '/dashboard/analysts', label: 'Analysts' },
  { href: '/dashboard/events', label: 'Events', disabled: true, note: 'Session 2' },
  { href: '/dashboard/strategies', label: 'Strategies', disabled: true, note: 'Session 5' },
  { href: '/dashboard/predictions', label: 'Predictions', disabled: true, note: 'Session 8' },
];

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen">
      <aside className="flex w-56 flex-col border-r border-neutral-800 bg-neutral-900 p-4">
        <div className="mb-8">
          <h1 className="text-lg font-semibold tracking-tight">Analyst Tracker</h1>
          <p className="text-xs text-neutral-500">v0.1 · Session 1</p>
        </div>
        <nav className="flex-1 space-y-1">
          {NAV.map((item) =>
            item.disabled ? (
              <div
                key={item.href}
                className="flex items-center justify-between rounded px-3 py-2 text-sm text-neutral-600"
              >
                <span>{item.label}</span>
                <span className="text-[10px] uppercase tracking-wide text-neutral-700">
                  {item.note}
                </span>
              </div>
            ) : (
              <Link
                key={item.href}
                href={item.href}
                className="block rounded px-3 py-2 text-sm text-neutral-300 hover:bg-neutral-800 hover:text-white"
              >
                {item.label}
              </Link>
            )
          )}
        </nav>
        <form action={logout} className="mt-4 border-t border-neutral-800 pt-4">
          <button
            type="submit"
            className="w-full rounded px-3 py-2 text-left text-sm text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200"
          >
            Sign out
          </button>
        </form>
      </aside>
      <main className="flex-1 p-8">{children}</main>
    </div>
  );
}

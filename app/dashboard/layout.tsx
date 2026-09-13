/**
 * The dashboard routes are reached through the global section nav in
 * `components/nav/site-nav.tsx`, so this layout is just the page container.
 */
export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return <div className="space-y-6">{children}</div>;
}

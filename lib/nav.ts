export interface NavItem {
  href: string;
  label: string;
  /** Shown greyed-out with a note instead of being linked. */
  disabled?: boolean;
  note?: string;
}

export interface NavSection {
  id: string;
  label: string;
  /** Where the section tab itself points — defaults to its first enabled item. */
  href?: string;
  /** Extra path prefixes that belong to this section (detail routes, APIs). */
  extraPaths?: string[];
  items: NavItem[];
}

export const NAV_SECTIONS: NavSection[] = [
  {
    id: 'stocks',
    label: 'Stock Analysis',
    href: '/stocks/analysis',
    extraPaths: ['/stocks'],
    items: [
      { href: '/stocks/analysis', label: 'UW × TipRanks' },
      { href: '/dashboard/analysts', label: 'Trusted Analysts' },
      { href: '/dashboard/events', label: 'Rating Events', disabled: true, note: 'soon' },
    ],
  },
  {
    id: 'polymarket',
    label: 'Polymarket',
    href: '/',
    extraPaths: ['/markets'],
    items: [
      { href: '/', label: 'Overview' },
      { href: '/trades', label: 'Trade Log' },
      { href: '/live-trades', label: 'Live' },
      { href: '/strategy', label: 'Strategy' },
      { href: '/dashboard/swings', label: 'Swing Scanner' },
    ],
  },
  {
    id: 'crypto',
    label: 'Crypto',
    href: '/dashboard/momentum',
    items: [{ href: '/dashboard/momentum', label: 'Momentum' }],
  },
];

export function isItemActive(href: string, pathname: string): boolean {
  if (href === '/') return pathname === '/';
  return pathname === href || pathname.startsWith(href + '/');
}

/**
 * The section that owns `pathname` — the one with the longest matching path,
 * so `/dashboard/swings` lands on Polymarket rather than the first section
 * that happens to contain a `/dashboard/*` route. Null for routes that sit
 * outside the sections entirely (/settings, /login).
 */
export function sectionForPath(pathname: string): NavSection | null {
  let best: { section: NavSection; len: number } | null = null;

  for (const section of NAV_SECTIONS) {
    const paths = [...section.items.map((i) => i.href), ...(section.extraPaths ?? [])];
    for (const p of paths) {
      if (!isItemActive(p, pathname)) continue;
      if (!best || p.length > best.len) best = { section, len: p.length };
    }
  }

  return best?.section ?? null;
}

export function sectionHref(section: NavSection): string {
  return section.href ?? section.items.find((i) => !i.disabled)?.href ?? '/';
}

// Slug format: "{asset}-updown-{5m|15m}-<unix_close_ts>"
export function parseCloseTs(slug: string | null | undefined): number | null {
  if (!slug) return null;
  const parts = slug.split('-');
  if (parts.length < 4) return null;
  const ts = Number(parts[parts.length - 1]);
  return Number.isFinite(ts) ? ts : null;
}

export function secondsToClose(slug: string | null | undefined, now: number = Date.now()): number | null {
  const close = parseCloseTs(slug);
  if (close === null) return null;
  return Math.max(0, Math.floor(close - now / 1000));
}

export function parseAsset(slug: string | null | undefined): string | null {
  if (!slug) return null;
  const parts = slug.split('-');
  return parts[0] ?? null;
}

export function parseWindow(slug: string | null | undefined): string | null {
  if (!slug) return null;
  const parts = slug.split('-');
  return parts[2] ?? null;
}

export function fmtUsd(n: number | null | undefined, digits = 2): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n).toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
  return `${sign}$${abs}`;
}

export function fmtCents(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return `${(n * 100).toFixed(2)}¢`;
}

export function fmtPrice(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return n.toFixed(3);
}

export function fmtPct(n: number | null | undefined, digits = 1): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return `${n.toFixed(digits)}%`;
}

export function fmtSeconds(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  if (n < 60) return `${n}s`;
  const m = Math.floor(n / 60);
  const s = n % 60;
  return `${m}m ${s}s`;
}

export function pnlColor(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return 'text-neutral-400';
  if (n > 0) return 'text-emerald-400';
  if (n < 0) return 'text-red-400';
  return 'text-neutral-300';
}

export function exitBadgeVariant(
  reason: 'TP' | 'STOP' | 'CLOSE' | null | undefined
): 'success' | 'danger' | 'neutral' {
  if (reason === 'TP') return 'success';
  if (reason === 'STOP') return 'danger';
  return 'neutral';
}

export const MIN_N = 30;
export const STRATEGY_MIN_N = 200;

export function formatCents(price: number | null | undefined): string {
  if (price === null || price === undefined || Number.isNaN(price)) return '—';
  return `${(price * 100).toFixed(1)}¢`;
}

export function formatUsd(
  v: number | null | undefined,
  { signed = false }: { signed?: boolean } = {}
): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  const sign = signed && v > 0 ? '+' : v < 0 ? '-' : signed ? '+' : '';
  const abs = Math.abs(v);
  return `${sign}$${abs.toFixed(2)}`;
}

export function formatPct(v: number | null | undefined, digits = 1): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  return `${(v * 100).toFixed(digits)}%`;
}

export function formatRelativeTime(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '—';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '—';
  const seconds = Math.round((now - then) / 1000);
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

export function formatFullTimestamp(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, 'Z');
}

import { createAdminClient } from '@/lib/supabase/admin';
import { TradesClient, type TradesSearchParams } from '@/components/paper/trades-client';
import type { PaperTrade } from '@/lib/paper/types';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const PAGE_SIZE = 50;

function parseReasons(raw: string | undefined): ('TP' | 'STOP' | 'CLOSE')[] | null {
  if (!raw) return null;
  const out = raw
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter((s) => s === 'TP' || s === 'STOP' || s === 'CLOSE') as (
    | 'TP'
    | 'STOP'
    | 'CLOSE'
  )[];
  return out.length === 0 ? null : out;
}

type SortKey = 'entry_ts' | 'exit_ts' | 'pnl_per_share';
type SortDir = 'asc' | 'desc';

function parseSort(raw: string | undefined): { key: SortKey; dir: SortDir } {
  const allowed: SortKey[] = ['entry_ts', 'exit_ts', 'pnl_per_share'];
  if (!raw) return { key: 'entry_ts', dir: 'desc' };
  const [k, d] = raw.split(':');
  const key = (allowed.includes(k as SortKey) ? k : 'entry_ts') as SortKey;
  const dir = (d === 'asc' ? 'asc' : 'desc') as SortDir;
  return { key, dir };
}

export default async function TradesPage({
  searchParams,
}: {
  searchParams: TradesSearchParams;
}) {
  const supabase = createAdminClient();

  const page = Math.max(1, Number(searchParams.page ?? '1') || 1);
  const strategy = searchParams.strategy ?? '';
  const reasons = parseReasons(searchParams.reasons);
  const slugSearch = (searchParams.slug ?? '').trim();
  const from = searchParams.from ?? '';
  const to = searchParams.to ?? '';
  const sort = parseSort(searchParams.sort);

  let q = supabase
    .from('btc5m_paper_trades')
    .select('*', { count: 'exact' })
    .eq('status', 'CLOSED');

  if (strategy) q = q.eq('strategy', strategy);
  if (reasons) q = q.in('exit_reason', reasons);
  if (slugSearch) q = q.ilike('slug', `%${slugSearch}%`);
  if (from) q = q.gte('entry_ts', new Date(from).toISOString());
  if (to) {
    const toDate = new Date(to);
    toDate.setHours(23, 59, 59, 999);
    q = q.lte('entry_ts', toDate.toISOString());
  }

  q = q
    .order(sort.key, { ascending: sort.dir === 'asc', nullsFirst: false })
    .range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1);

  const { data, count, error } = await q;

  const strategiesRes = await supabase
    .from('btc5m_paper_summary')
    .select('strategy')
    .order('strategy', { ascending: true });
  const strategies = (strategiesRes.data ?? [])
    .map((r) => r.strategy as string)
    .filter(Boolean);

  return (
    <TradesClient
      trades={(data ?? []) as PaperTrade[]}
      total={count ?? 0}
      pageSize={PAGE_SIZE}
      page={page}
      strategies={strategies}
      filters={{
        strategy,
        reasons: reasons ?? [],
        slug: slugSearch,
        from,
        to,
        sort,
      }}
      error={error?.message ?? null}
    />
  );
}

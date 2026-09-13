import { createAdminClient } from '@/lib/supabase/admin';
import { UwTipranksTable } from '@/components/stocks/uw-tipranks-table';
import { SAMPLE_ROWS } from '@/lib/stocks/sample';
import type { UwTipranksRow } from '@/lib/stocks/types';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const MAX_ROWS = 500;

/**
 * Latest snapshot per ticker. Prefers the `uw_tipranks_latest` view; falls back
 * to the base table if the view isn't there yet, and to the built-in sample
 * rows if neither is (fresh clone / migration not applied / no Supabase env).
 */
async function loadRows(): Promise<{
  rows: UwTipranksRow[];
  isSample: boolean;
  error: string | null;
}> {
  let supabase;
  try {
    supabase = createAdminClient();
  } catch (e) {
    return {
      rows: SAMPLE_ROWS,
      isSample: true,
      error: e instanceof Error ? e.message : 'Supabase client unavailable',
    };
  }

  const view = await supabase
    .from('uw_tipranks_latest')
    .select('*')
    .order('composite_score', { ascending: false, nullsFirst: false })
    .limit(MAX_ROWS);

  let data = view.data;
  let error = view.error;

  if (error) {
    const base = await supabase
      .from('uw_tipranks_analysis')
      .select('*')
      .order('as_of', { ascending: false })
      .limit(MAX_ROWS);
    data = base.data;
    error = base.error;
  }

  if (error || !data || data.length === 0) {
    return {
      rows: SAMPLE_ROWS,
      isSample: true,
      error: error?.message ?? null,
    };
  }

  return { rows: data as UwTipranksRow[], isSample: false, error: null };
}

export default async function StockAnalysisPage() {
  const { rows, isSample, error } = await loadRows();
  return <UwTipranksTable rows={rows} isSample={isSample} error={error} />;
}

import { ResearchClient } from '@/components/stocks/research-client';
import { createAdminClient } from '@/lib/supabase/admin';
import { isUwConfigured } from '@/lib/uw/client';
import type { ResearchRow } from '@/lib/research/types';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

async function loadRecent(): Promise<{ rows: ResearchRow[]; error: string | null }> {
  try {
    const supabase = createAdminClient();
    const { data, error } = await supabase
      .from('uw_research_rows')
      .select('*')
      .order('rated_at', { ascending: false })
      .limit(500);
    if (error) return { rows: [], error: error.message };
    return { rows: (data ?? []) as ResearchRow[], error: null };
  } catch (e) {
    return { rows: [], error: e instanceof Error ? e.message : 'Supabase unavailable' };
  }
}

export default async function ResearchPage() {
  const [{ rows, error }, uwReady] = await Promise.all([loadRecent(), isUwConfigured()]);
  return <ResearchClient initialRows={rows} loadError={error} uwConfigured={uwReady} />;
}

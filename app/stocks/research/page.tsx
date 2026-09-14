import { ResearchClient } from '@/components/stocks/research-client';
import { createAdminClient } from '@/lib/supabase/admin';
import { isUwConfigured } from '@/lib/uw/client';
import type { ResearchRow } from '@/lib/research/types';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * This database also carries a multi-terabyte tick table whose vacuums and
 * ingest can starve IO for seconds at a time, and a statement timeout there is
 * transient rather than a real failure. Retry once, and if it still fails say
 * what it means instead of surfacing raw Postgres text.
 */
async function loadRecent(): Promise<{ rows: ResearchRow[]; error: string | null }> {
  let lastError = 'Supabase unavailable';

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const supabase = createAdminClient();
      const { data, error } = await supabase
        .from('uw_research_rows')
        .select('*')
        .order('rated_at', { ascending: false })
        .limit(500);

      if (!error) return { rows: (data ?? []) as ResearchRow[], error: null };
      lastError = error.message;
    } catch (e) {
      lastError = e instanceof Error ? e.message : 'Supabase unavailable';
    }
    if (attempt === 0) await new Promise((r) => setTimeout(r, 750));
  }

  const timedOut = /statement timeout|canceling statement/i.test(lastError);
  return {
    rows: [],
    error: timedOut
      ? 'The database was too busy to return the table (statement timeout). This is usually the Polymarket tick ingest saturating disk IO — reload in a moment; the data is fine.'
      : lastError,
  };
}

export default async function ResearchPage() {
  const [{ rows, error }, uwReady] = await Promise.all([loadRecent(), isUwConfigured()]);
  return <ResearchClient initialRows={rows} loadError={error} uwConfigured={uwReady} />;
}

import { serverClient } from '@/lib/supabase';
import { getTradesData } from '@/lib/queries';
import { TradesView } from '@/components/trades-view';
import { ErrorState } from '@/components/error-state';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default async function TradesPage({
  searchParams,
}: {
  searchParams: { source?: string; strategy?: string; mode?: string };
}) {
  const source = searchParams.source === 'paper' ? 'paper' : 'live';
  const strategy = searchParams.strategy || null;
  const dryRun = searchParams.mode === 'dry';
  try {
    const initial = await getTradesData(serverClient(), { source, strategy, dryRun });
    return (
      <TradesView
        initial={initial}
        initialSource={source}
        initialStrategy={strategy}
        initialDryRun={dryRun}
      />
    );
  } catch (e) {
    return <ErrorState message={e instanceof Error ? e.message : 'Unknown error'} />;
  }
}

import { serverClient } from '@/lib/supabase';
import { getHomeData } from '@/lib/queries';
import { HomeView } from '@/components/home-view';
import { ErrorState } from '@/components/error-state';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default async function HomePage({
  searchParams,
}: {
  searchParams: { mode?: string };
}) {
  const dryRun = searchParams.mode === 'dry';
  try {
    const initial = await getHomeData(serverClient(), dryRun);
    return <HomeView initial={initial} />;
  } catch (e) {
    return <ErrorState message={e instanceof Error ? e.message : 'Unknown error'} />;
  }
}

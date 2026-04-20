import { serverClient } from '@/lib/supabase';
import { getHaltsData } from '@/lib/queries';
import { HaltsView } from '@/components/halts-view';
import { ErrorState } from '@/components/error-state';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default async function HaltsPage() {
  try {
    const initial = await getHaltsData(serverClient());
    return <HaltsView initial={initial} />;
  } catch (e) {
    return <ErrorState message={e instanceof Error ? e.message : 'Unknown error'} />;
  }
}

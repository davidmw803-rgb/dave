import { serverClient } from '@/lib/supabase';
import { getPaperData } from '@/lib/queries';
import { PaperView } from '@/components/paper-view';
import { ErrorState } from '@/components/error-state';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default async function PaperPage() {
  try {
    const initial = await getPaperData(serverClient());
    return <PaperView initial={initial} />;
  } catch (e) {
    return <ErrorState message={e instanceof Error ? e.message : 'Unknown error'} />;
  }
}

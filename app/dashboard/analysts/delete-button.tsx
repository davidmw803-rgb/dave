'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';

export function DeleteButton({ id }: { id: string }) {
  const router = useRouter();
  const supabase = createClient();
  const [pending, setPending] = useState(false);

  async function handleDelete() {
    if (!confirm('Remove this analyst? Their historical events will be preserved.'))
      return;
    setPending(true);
    // Soft delete: set active=false rather than hard delete
    await supabase.from('trusted_analysts').update({ active: false }).eq('id', id);
    setPending(false);
    router.refresh();
  }

  return (
    <button
      onClick={handleDelete}
      disabled={pending}
      className="text-xs text-neutral-500 hover:text-red-400 disabled:opacity-50"
    >
      {pending ? '...' : 'Deactivate'}
    </button>
  );
}

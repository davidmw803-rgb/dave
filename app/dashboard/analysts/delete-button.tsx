'use client';

import { useTransition } from 'react';
import { deactivateAnalyst, reactivateAnalyst } from './actions';

export function DeleteButton({ id, active }: { id: string; active: boolean }) {
  const [pending, startTransition] = useTransition();

  function handleClick() {
    if (active) {
      if (
        !confirm(
          'Deactivate this analyst? Their historical events will be preserved.'
        )
      )
        return;
      startTransition(async () => {
        await deactivateAnalyst(id);
      });
    } else {
      startTransition(async () => {
        await reactivateAnalyst(id);
      });
    }
  }

  return (
    <button
      onClick={handleClick}
      disabled={pending}
      className={
        active
          ? 'text-xs text-neutral-500 hover:text-red-400 disabled:opacity-50'
          : 'text-xs text-neutral-500 hover:text-emerald-400 disabled:opacity-50'
      }
    >
      {pending ? '...' : active ? 'Deactivate' : 'Reactivate'}
    </button>
  );
}

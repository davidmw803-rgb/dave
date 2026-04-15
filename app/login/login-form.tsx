'use client';

import { useFormState, useFormStatus } from 'react-dom';
import { login, type LoginState } from './actions';

const initialState: LoginState = {};

export function LoginForm({ from }: { from?: string }) {
  const [state, formAction] = useFormState(login, initialState);

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="from" value={from ?? '/dashboard/analysts'} />
      <label className="block">
        <span className="mb-1 block text-xs uppercase tracking-wide text-neutral-500">
          Password
        </span>
        <input
          type="password"
          name="password"
          autoFocus
          autoComplete="current-password"
          required
          className="w-full rounded border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 placeholder-neutral-600 focus:border-emerald-600 focus:outline-none"
        />
      </label>
      {state.error && (
        <p className="text-xs text-red-400" role="alert">
          {state.error}
        </p>
      )}
      <SubmitButton />
    </form>
  );
}

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="w-full rounded bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
    >
      {pending ? 'Signing in...' : 'Sign in'}
    </button>
  );
}

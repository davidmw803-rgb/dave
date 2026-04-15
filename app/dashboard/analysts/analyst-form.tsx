'use client';

import { useEffect, useRef } from 'react';
import { useFormState, useFormStatus } from 'react-dom';
import { createAnalyst, type CreateAnalystState } from './actions';

const initialState: CreateAnalystState = {};

export function AnalystForm() {
  const [state, formAction] = useFormState(createAnalyst, initialState);
  const formRef = useRef<HTMLFormElement>(null);

  // Reset the form on successful submit (no error set and no fieldErrors set).
  useEffect(() => {
    if (!state.error && !state.fieldErrors) {
      formRef.current?.reset();
    }
  }, [state]);

  return (
    <form
      ref={formRef}
      action={formAction}
      className="grid grid-cols-2 gap-4 lg:grid-cols-4"
    >
      <Field
        label="Name"
        name="name"
        placeholder="Mike Mayo"
        required
        error={state.fieldErrors?.name?.[0]}
      />
      <Field
        label="Firm"
        name="firm"
        placeholder="Wells Fargo"
        required
        error={state.fieldErrors?.firm?.[0]}
      />
      <Field
        label="UW Analyst ID"
        name="uw_analyst_id"
        placeholder="uw_12345"
        required
        error={state.fieldErrors?.uw_analyst_id?.[0]}
      />
      <Field
        label="Sectors (comma-sep)"
        name="sectors"
        placeholder="financials, banks"
      />
      <SelectField
        label="Tier"
        name="tier"
        options={['1', '2', '3']}
        defaultValue="2"
      />
      <SelectField
        label="Confidence (1-10)"
        name="confidence_score"
        options={['1', '2', '3', '4', '5', '6', '7', '8', '9', '10']}
        defaultValue="7"
      />
      <Field
        label="Notes"
        name="notes"
        placeholder="Why you trust them"
        className="col-span-2"
      />
      <div className="col-span-full flex items-center gap-3">
        <SubmitButton />
        {state.error && !state.fieldErrors && (
          <span className="text-sm text-red-400">{state.error}</span>
        )}
      </div>
    </form>
  );
}

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
    >
      {pending ? 'Adding...' : 'Add analyst'}
    </button>
  );
}

function Field({
  label,
  className = '',
  error,
  ...props
}: React.InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  error?: string;
}) {
  return (
    <label className={`block ${className}`}>
      <span className="mb-1 block text-xs uppercase tracking-wide text-neutral-500">
        {label}
      </span>
      <input
        {...props}
        className="w-full rounded border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 placeholder-neutral-600 focus:border-emerald-600 focus:outline-none"
      />
      {error && <span className="mt-1 block text-xs text-red-400">{error}</span>}
    </label>
  );
}

function SelectField({
  label,
  options,
  ...props
}: React.SelectHTMLAttributes<HTMLSelectElement> & {
  label: string;
  options: string[];
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs uppercase tracking-wide text-neutral-500">
        {label}
      </span>
      <select
        {...props}
        className="w-full rounded border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 focus:border-emerald-600 focus:outline-none"
      >
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </label>
  );
}

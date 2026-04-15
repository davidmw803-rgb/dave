'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';

export function AnalystForm() {
  const router = useRouter();
  const supabase = createClient();
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSubmitting(true);
    setErr(null);
    const fd = new FormData(e.currentTarget);
    const payload = {
      uw_analyst_id: String(fd.get('uw_analyst_id') || '').trim(),
      name: String(fd.get('name') || '').trim(),
      firm: String(fd.get('firm') || '').trim(),
      tier: Number(fd.get('tier')),
      confidence_score: Number(fd.get('confidence_score')),
      sectors: String(fd.get('sectors') || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      notes: String(fd.get('notes') || '').trim() || null,
      active: true,
    };

    const { error } = await supabase.from('trusted_analysts').insert(payload);
    setSubmitting(false);
    if (error) {
      setErr(error.message);
      return;
    }
    (e.target as HTMLFormElement).reset();
    router.refresh();
  }

  return (
    <form onSubmit={handleSubmit} className="grid grid-cols-2 gap-4 lg:grid-cols-4">
      <Field label="Name" name="name" placeholder="Mike Mayo" required />
      <Field label="Firm" name="firm" placeholder="Wells Fargo" required />
      <Field
        label="UW Analyst ID"
        name="uw_analyst_id"
        placeholder="uw_12345"
        required
      />
      <Field label="Sectors (comma-sep)" name="sectors" placeholder="financials, banks" />
      <SelectField label="Tier" name="tier" options={['1', '2', '3']} defaultValue="2" />
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
        <button
          type="submit"
          disabled={submitting}
          className="rounded bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
        >
          {submitting ? 'Adding...' : 'Add analyst'}
        </button>
        {err && <span className="text-sm text-red-400">{err}</span>}
      </div>
    </form>
  );
}

function Field({
  label,
  className = '',
  ...props
}: React.InputHTMLAttributes<HTMLInputElement> & { label: string }) {
  return (
    <label className={`block ${className}`}>
      <span className="mb-1 block text-xs uppercase tracking-wide text-neutral-500">
        {label}
      </span>
      <input
        {...props}
        className="w-full rounded border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 placeholder-neutral-600 focus:border-emerald-600 focus:outline-none"
      />
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

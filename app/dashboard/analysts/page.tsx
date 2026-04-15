import { createAdminClient } from '@/lib/supabase/admin';
import { AnalystForm } from './analyst-form';
import { DeleteButton } from './delete-button';

export const dynamic = 'force-dynamic';

export default async function AnalystsPage() {
  const supabase = createAdminClient();
  const { data: analysts, error } = await supabase
    .from('trusted_analysts')
    .select('*')
    .order('tier', { ascending: true })
    .order('confidence_score', { ascending: false });

  return (
    <div className="space-y-8">
      <header className="flex items-end justify-between">
        <div>
          <h2 className="text-2xl font-semibold">Trusted Analysts</h2>
          <p className="text-sm text-neutral-500">
            Curated list. Only events from these analysts will be ingested.
          </p>
        </div>
        <div className="text-sm text-neutral-500">
          {analysts?.length ?? 0} total · {analysts?.filter((a) => a.active).length ?? 0} active
        </div>
      </header>

      {error && (
        <div className="rounded border border-red-900 bg-red-950/40 p-4 text-sm text-red-200">
          <p className="font-semibold">Database error</p>
          <p className="mt-1 text-red-300/80">{error.message}</p>
          <p className="mt-2 text-xs text-red-400/60">
            Did you run the migrations? Try: <code>npx supabase db push</code>
          </p>
        </div>
      )}

      <section className="rounded-lg border border-neutral-800 bg-neutral-900 p-6">
        <h3 className="mb-4 text-sm font-semibold uppercase tracking-wide text-neutral-400">
          Add analyst
        </h3>
        <AnalystForm />
      </section>

      <section>
        <div className="overflow-hidden rounded-lg border border-neutral-800">
          <table className="w-full text-sm">
            <thead className="bg-neutral-900 text-left text-xs uppercase tracking-wide text-neutral-500">
              <tr>
                <th className="px-4 py-3">Name</th>
                <th className="px-4 py-3">Firm</th>
                <th className="px-4 py-3">Tier</th>
                <th className="px-4 py-3">Confidence</th>
                <th className="px-4 py-3">Sectors</th>
                <th className="px-4 py-3">Active</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-800 bg-neutral-950">
              {analysts?.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-neutral-500">
                    No analysts yet. Add your first one above.
                  </td>
                </tr>
              )}
              {analysts?.map((a) => (
                <tr key={a.id} className="hover:bg-neutral-900/60">
                  <td className="px-4 py-3 font-medium">{a.name}</td>
                  <td className="px-4 py-3 text-neutral-400">{a.firm}</td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-block rounded px-2 py-0.5 text-xs ${
                        a.tier === 1
                          ? 'bg-emerald-900/40 text-emerald-300'
                          : a.tier === 2
                          ? 'bg-amber-900/40 text-amber-300'
                          : 'bg-neutral-800 text-neutral-400'
                      }`}
                    >
                      T{a.tier}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-neutral-300">{a.confidence_score}/10</td>
                  <td className="px-4 py-3 text-xs text-neutral-400">
                    {a.sectors?.join(', ') || '—'}
                  </td>
                  <td className="px-4 py-3">
                    {a.active ? (
                      <span className="text-emerald-400">●</span>
                    ) : (
                      <span className="text-neutral-600">○</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <DeleteButton id={a.id} active={a.active} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

export function ErrorState({ message }: { message: string }) {
  return (
    <div className="m-4 rounded border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-200">
      <div className="font-medium">Couldn&apos;t load the dashboard.</div>
      <div className="mt-1 font-mono text-xs text-red-300 break-words">{message}</div>
      <div className="mt-2 text-xs text-red-300/80">
        Supabase may be down or your env vars are misconfigured. See README &gt; Debugging.
      </div>
    </div>
  );
}

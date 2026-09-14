'use client';

/**
 * A render failure here used to blank the whole page with nothing but
 * "Application error". Show what broke and offer a way back instead.
 */
export default function ResearchError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="mx-auto max-w-2xl space-y-3 py-10">
      <h1 className="text-lg font-semibold">The research table hit an error</h1>
      <p className="text-xs text-neutral-500">
        The data is safe — this is a display failure. Retry, and if it repeats send this
        message along.
      </p>
      <pre className="overflow-x-auto rounded border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-300">
        {error.message}
        {error.digest ? `\n\ndigest: ${error.digest}` : ''}
      </pre>
      <button
        onClick={reset}
        className="rounded-md bg-emerald-500 px-3 py-1.5 text-sm font-medium text-neutral-950 hover:bg-emerald-400"
      >
        Try again
      </button>
    </div>
  );
}

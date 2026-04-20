export const dynamic = 'force-dynamic';

export default function LoginPage({
  searchParams,
}: {
  searchParams: { token?: string };
}) {
  const badToken = typeof searchParams.token === 'string' && searchParams.token.length > 0;
  return (
    <main className="mx-auto max-w-md px-4 py-10">
      <h1 className="text-xl font-semibold">Poly UI</h1>
      <p className="mt-4 text-sm text-neutral-400">
        This dashboard is private. Open it with the personal link that contains
        your one-use token:
      </p>
      <pre className="mt-3 overflow-x-auto rounded bg-neutral-900 p-3 text-xs text-neutral-300">
        https://{'<host>'}/login?token={'<your token>'}
      </pre>
      {badToken ? (
        <p className="mt-4 rounded border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-300">
          That token did not match. Check the link or rotate the token.
        </p>
      ) : null}
      <p className="mt-6 text-xs text-neutral-500">
        The token is hashed into an HTTP-only cookie (30 days). The raw token is
        never stored in your browser.
      </p>
    </main>
  );
}

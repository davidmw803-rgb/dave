import { LoginForm } from './login-form';

export const dynamic = 'force-dynamic';

export default function LoginPage({
  searchParams,
}: {
  searchParams: { from?: string };
}) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-neutral-950 p-4">
      <div className="w-full max-w-sm space-y-6 rounded-lg border border-neutral-800 bg-neutral-900 p-8">
        <div>
          <h1 className="text-lg font-semibold tracking-tight text-neutral-100">
            Analyst Tracker
          </h1>
          <p className="mt-1 text-xs text-neutral-500">
            Enter your access password to continue.
          </p>
        </div>
        <LoginForm from={searchParams.from} />
      </div>
    </main>
  );
}

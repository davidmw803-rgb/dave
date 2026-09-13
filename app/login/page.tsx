import { LoginForm } from '@/components/auth/login-form';
import { passwordSource } from '@/lib/auth/password';
import { sessionKeyMaterial } from '@/lib/auth/session';

export const dynamic = 'force-dynamic';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: { next?: string };
}) {
  const source = await passwordSource();
  const canSignSessions = sessionKeyMaterial() !== null;
  const next =
    typeof searchParams.next === 'string' && searchParams.next.startsWith('/')
      ? searchParams.next
      : '/';

  return (
    <div className="mx-auto flex min-h-[70vh] max-w-sm flex-col justify-center">
      <div className="mb-6">
        <div className="font-mono text-sm font-semibold tracking-tight text-emerald-400">
          dave<span className="text-neutral-600">·</span>desk
        </div>
        <h1 className="mt-2 text-xl font-semibold">
          {source === 'none' ? 'Choose a password' : 'Private dashboard'}
        </h1>
        <p className="mt-1 text-xs text-neutral-500">
          {source === 'none'
            ? 'No password is set yet. The one you enter here becomes the password for this dashboard.'
            : 'Enter the shared password to reach the data.'}
        </p>
      </div>

      {canSignSessions ? (
        <LoginForm next={next} firstRun={source === 'none'} />
      ) : (
        <div className="rounded border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-300">
          This deployment has no secret to sign sessions with. Set{' '}
          <code>SUPABASE_SERVICE_ROLE_KEY</code> (or <code>APP_SESSION_SECRET</code>) in the
          project&apos;s environment variables and redeploy.
        </div>
      )}
    </div>
  );
}

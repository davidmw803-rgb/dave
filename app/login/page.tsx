import { LoginForm } from '@/components/auth/login-form';
import { appPassword } from '@/lib/auth/session';

export const dynamic = 'force-dynamic';

export default function LoginPage({
  searchParams,
}: {
  searchParams: { next?: string };
}) {
  const configured = appPassword() !== null;
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
        <h1 className="mt-2 text-xl font-semibold">Private dashboard</h1>
        <p className="mt-1 text-xs text-neutral-500">
          Enter the shared password to reach the data.
        </p>
      </div>

      {configured ? (
        <LoginForm next={next} />
      ) : (
        <div className="rounded border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-300">
          <code>APP_PASSWORD</code> is not set on this deployment. Add it in the Vercel
          project&apos;s environment variables (or <code>.env.local</code> locally) and
          redeploy.
        </div>
      )}
    </div>
  );
}

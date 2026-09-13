'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

export function LoginForm({ next }: { next: string }) {
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setPending(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body?.error ?? 'Login failed.');
        setPending(false);
        return;
      }
      router.replace(next);
      router.refresh();
    } catch {
      setError('Network error. Try again.');
      setPending(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-3">
      <Input
        type="password"
        autoFocus
        autoComplete="current-password"
        placeholder="Password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />
      {error ? (
        <div className="rounded border border-red-500/30 bg-red-500/10 p-2 text-xs text-red-300">
          {error}
        </div>
      ) : null}
      <Button type="submit" disabled={pending || password.length === 0} className="w-full">
        {pending ? 'Checking…' : 'Unlock'}
      </Button>
      <p className="text-[11px] text-neutral-600">
        The password is hashed into an HTTP-only cookie for 30 days. It is never stored in
        the browser.
      </p>
    </form>
  );
}

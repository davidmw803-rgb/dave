'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import type { PasswordSource } from '@/lib/auth/password';

const SOURCE_COPY: Record<PasswordSource, { label: string; variant: 'success' | 'warning' | 'neutral' }> = {
  database: { label: 'Set here', variant: 'success' },
  env: { label: 'From APP_PASSWORD', variant: 'warning' },
  none: { label: 'Not set', variant: 'neutral' },
};

export function PasswordCard({ initialSource }: { initialSource: PasswordSource }) {
  const [source, setSource] = useState<PasswordSource>(initialSource);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, setPending] = useState(false);

  const save = async () => {
    setPending(true);
    setError(null);
    setSaved(false);
    try {
      const res = await fetch('/api/settings/password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword: current, newPassword: next }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body?.error ?? 'Could not save the password.');
      } else {
        setSource(body.source ?? 'database');
        setCurrent('');
        setNext('');
        setSaved(true);
      }
    } catch {
      setError('Network error.');
    } finally {
      setPending(false);
    }
  };

  const copy = SOURCE_COPY[source];

  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <div className="text-sm font-medium text-neutral-100">Dashboard password</div>
            <div className="text-xs text-neutral-500">
              The shared password for every page. Stored as a scrypt hash.
            </div>
          </div>
          <Badge variant={copy.variant}>{copy.label}</Badge>
        </div>

        {error ? (
          <div className="rounded border border-red-500/30 bg-red-500/10 p-2 text-xs text-red-300">
            {error}
          </div>
        ) : null}
        {saved ? (
          <div className="rounded border border-emerald-500/30 bg-emerald-500/10 p-2 text-xs text-emerald-300">
            Password updated. Sessions already signed in stay valid until they expire.
          </div>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          <Input
            type="password"
            autoComplete="current-password"
            placeholder="Current password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            className="min-w-[14rem] flex-1"
          />
          <Input
            type="password"
            autoComplete="new-password"
            placeholder="New password (min 8)"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            className="min-w-[14rem] flex-1"
          />
          <Button size="sm" disabled={pending || next.length < 8} onClick={save}>
            {pending ? 'Saving…' : 'Change'}
          </Button>
        </div>

        {source === 'env' ? (
          <p className="text-[11px] text-neutral-600">
            An <code>APP_PASSWORD</code> environment variable is currently in force. Saving
            here stores a password in the database, which takes precedence from then on.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

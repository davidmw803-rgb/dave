'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import type { SettingDefinition, SettingStatus } from '@/lib/settings/store';

interface Props {
  defs: SettingDefinition[];
  initialStatuses: SettingStatus[];
  loadError: string | null;
}

const SOURCE_COPY: Record<SettingStatus['source'], { label: string; variant: 'success' | 'warning' | 'neutral' }> = {
  database: { label: 'Saved here', variant: 'success' },
  env: { label: 'From env var', variant: 'warning' },
  unset: { label: 'Not set', variant: 'neutral' },
};

export function SettingsClient({ defs, initialStatuses, loadError }: Props) {
  const [statuses, setStatuses] = useState(initialStatuses);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const statusFor = (key: string) =>
    statuses.find((s) => s.key === key) ?? {
      key,
      source: 'unset' as const,
      display: null,
      updatedAt: null,
    };

  const save = async (key: string) => {
    const value = drafts[key] ?? '';
    if (!value.trim()) return;
    setPending(key);
    setError(null);
    setSaved(null);
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, value }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body?.error ?? 'Could not save.');
      } else {
        setStatuses(body.statuses);
        setDrafts((d) => ({ ...d, [key]: '' }));
        setSaved(key);
      }
    } catch {
      setError('Network error.');
    } finally {
      setPending(null);
    }
  };

  const clear = async (key: string) => {
    setPending(key);
    setError(null);
    setSaved(null);
    try {
      const res = await fetch(`/api/settings?key=${encodeURIComponent(key)}`, {
        method: 'DELETE',
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) setError(body?.error ?? 'Could not clear.');
      else setStatuses(body.statuses);
    } catch {
      setError('Network error.');
    } finally {
      setPending(null);
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">API credentials</h1>
        <p className="text-xs text-neutral-500">
          Keys for the data feeds. Secrets are encrypted before they are stored and are
          never sent back to the browser — only the last four characters.
        </p>
      </div>

      {loadError ? (
        <div className="rounded border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-300">
          {loadError} — values below fall back to environment variables until the
          <code className="mx-1">app_settings</code> table is reachable.
        </div>
      ) : null}

      {error ? (
        <div className="rounded border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-300">
          {error}
        </div>
      ) : null}

      {defs.map((def) => {
        const status = statusFor(def.key);
        const source = SOURCE_COPY[status.source];
        const busy = pending === def.key;
        return (
          <Card key={def.key}>
            <CardContent className="space-y-3 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <div className="text-sm font-medium text-neutral-100">{def.label}</div>
                  <div className="text-xs text-neutral-500">{def.description}</div>
                </div>
                <Badge variant={source.variant}>{source.label}</Badge>
              </div>

              <div className="flex flex-wrap items-center gap-2 text-xs text-neutral-400">
                <span className="text-neutral-500">Current:</span>
                <code className="rounded bg-neutral-950 px-1.5 py-0.5 font-mono text-neutral-300">
                  {status.display ?? '—'}
                </code>
                {status.updatedAt ? (
                  <span className="text-neutral-600">
                    updated {new Date(status.updatedAt).toLocaleString()}
                  </span>
                ) : null}
                {saved === def.key ? (
                  <span className="text-emerald-400">saved</span>
                ) : null}
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <Input
                  type={def.secret ? 'password' : 'text'}
                  autoComplete="off"
                  placeholder={def.placeholder}
                  value={drafts[def.key] ?? ''}
                  onChange={(e) =>
                    setDrafts((d) => ({ ...d, [def.key]: e.target.value }))
                  }
                  className="min-w-[18rem] flex-1"
                />
                <Button
                  size="sm"
                  disabled={busy || !(drafts[def.key] ?? '').trim()}
                  onClick={() => save(def.key)}
                >
                  {busy ? 'Saving…' : 'Save'}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy || status.source !== 'database'}
                  onClick={() => clear(def.key)}
                >
                  Clear
                </Button>
              </div>
            </CardContent>
          </Card>
        );
      })}

      <p className="text-[11px] leading-relaxed text-neutral-600">
        Precedence: a value saved here wins over the matching environment variable, which
        wins over the built-in default. Encryption uses <code>SETTINGS_SECRET</code> when
        set, otherwise a key derived from <code>SUPABASE_SERVICE_ROLE_KEY</code> — if you
        rotate that key, re-enter the secrets here.
      </p>
    </div>
  );
}

'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/client';
import type { PaperTrade, LiveMid } from '@/lib/paper/types';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  fmtCents,
  fmtPrice,
  fmtSeconds,
  fmtUsd,
  pnlColor,
  secondsToClose,
} from '@/lib/paper/format';
import { unrealizedDollars, combinedUnrealized } from '@/lib/paper/unrealized';
import { Badge } from '@/components/ui/badge';

interface Props {
  initialOpen: PaperTrade[];
  onOpenChange?: (trades: PaperTrade[]) => void;
  onUnrealizedChange?: (total: number) => void;
}

export function OpenPositionsTable({ initialOpen, onOpenChange, onUnrealizedChange }: Props) {
  const [open, setOpen] = useState<PaperTrade[]>(initialOpen);
  const [mids, setMids] = useState<Record<string, LiveMid>>({});
  const [, setTick] = useState(0);
  const lastAssetIds = useRef<string>('');

  useEffect(() => {
    onOpenChange?.(open);
  }, [open, onOpenChange]);

  // Realtime subscription
  useEffect(() => {
    const supabase = createClient();
    const channel = supabase
      .channel('paper-trades-open')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'btc5m_paper_trades' },
        (payload) => {
          if (payload.eventType === 'INSERT') {
            const t = payload.new as PaperTrade;
            if (t.status === 'OPEN') {
              setOpen((prev) => [t, ...prev.filter((p) => p.id !== t.id)]);
            }
          } else if (payload.eventType === 'UPDATE') {
            const t = payload.new as PaperTrade;
            setOpen((prev) => {
              const without = prev.filter((p) => p.id !== t.id);
              return t.status === 'OPEN' ? [t, ...without] : without;
            });
          } else if (payload.eventType === 'DELETE') {
            const t = payload.old as PaperTrade;
            setOpen((prev) => prev.filter((p) => p.id !== t.id));
          }
        }
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  // Poll /api/live-mids every 2s when positions exist
  const assetIds = useMemo(() => open.map((t) => t.asset_id).filter(Boolean), [open]);
  const idsKey = assetIds.join(',');

  useEffect(() => {
    if (idsKey.length === 0) {
      setMids({});
      return;
    }
    lastAssetIds.current = idsKey;
    let cancelled = false;
    const fetchMids = async () => {
      try {
        const res = await fetch(`/api/live-mids?ids=${encodeURIComponent(idsKey)}`, {
          cache: 'no-store',
        });
        if (!res.ok) return;
        const json = (await res.json()) as { mids: LiveMid[] };
        if (cancelled) return;
        const map: Record<string, LiveMid> = {};
        for (const m of json.mids) map[m.asset_id] = m;
        setMids(map);
      } catch {
        // silent — transient network errors are fine
      }
    };
    fetchMids();
    const interval = setInterval(fetchMids, 2000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [idsKey]);

  // Tick every second so seconds-to-close updates without re-fetching.
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  // Propagate combined unrealized upward whenever mids or open change.
  useEffect(() => {
    onUnrealizedChange?.(combinedUnrealized(open, mids));
  }, [open, mids, onUnrealizedChange]);

  if (open.length === 0) {
    return (
      <div className="flex h-24 items-center justify-center text-xs text-neutral-500">
        No open positions.
      </div>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Market</TableHead>
          <TableHead>Side</TableHead>
          <TableHead className="text-right">Entry</TableHead>
          <TableHead className="text-right">Mid</TableHead>
          <TableHead className="text-right">Stop</TableHead>
          <TableHead className="text-right">Target</TableHead>
          <TableHead className="text-right">STC</TableHead>
          <TableHead className="text-right">Unreal. P&L</TableHead>
          <TableHead className="text-right">Opened</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {open.map((t) => {
          const mid = mids[t.asset_id]?.mid_before ?? mids[t.asset_id]?.price ?? null;
          const unreal = unrealizedDollars(t, mid);
          const stc = secondsToClose(t.slug);
          return (
            <TableRow key={t.id}>
              <TableCell>
                <Link
                  href={`/markets/${encodeURIComponent(t.slug)}`}
                  className="font-mono text-xs text-emerald-400 hover:underline"
                >
                  {t.slug}
                </Link>
              </TableCell>
              <TableCell>
                <Badge variant={t.side_token === 'YES' ? 'success' : 'danger'}>
                  {t.side_token}
                </Badge>
              </TableCell>
              <TableCell className="text-right font-mono tabular-nums">
                {fmtPrice(t.entry_price)}
              </TableCell>
              <TableCell className="text-right font-mono tabular-nums">
                {fmtPrice(mid)}
              </TableCell>
              <TableCell className="text-right font-mono tabular-nums text-neutral-400">
                {fmtPrice(t.stop_price)}
              </TableCell>
              <TableCell className="text-right font-mono tabular-nums text-neutral-400">
                {fmtPrice(t.target_price)}
              </TableCell>
              <TableCell className="text-right font-mono tabular-nums text-neutral-400">
                {fmtSeconds(stc)}
              </TableCell>
              <TableCell className={`text-right font-mono tabular-nums ${pnlColor(unreal)}`}>
                {fmtUsd(unreal)}
              </TableCell>
              <TableCell className="text-right font-mono text-xs text-neutral-400">
                {new Date(t.entry_ts).toLocaleTimeString()}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

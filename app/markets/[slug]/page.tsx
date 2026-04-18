import Link from 'next/link';
import { notFound } from 'next/navigation';
import { createAdminClient } from '@/lib/supabase/admin';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { MarketChart } from '@/components/paper/market-chart';
import type { PaperTrade, TradeDetailed } from '@/lib/paper/types';
import {
  exitBadgeVariant,
  fmtPrice,
  fmtSeconds,
  fmtUsd,
  parseAsset,
  parseCloseTs,
  parseWindow,
  pnlColor,
} from '@/lib/paper/format';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default async function MarketPage({ params }: { params: { slug: string } }) {
  const slug = decodeURIComponent(params.slug);
  if (!slug) notFound();

  const supabase = createAdminClient();

  const [tradesRes, detailedRes] = await Promise.all([
    supabase
      .from('btc5m_paper_trades')
      .select('*')
      .eq('slug', slug)
      .order('entry_ts', { ascending: false }),
    supabase
      .from('btc5m_trades_detailed')
      .select('mid_before, price, event_ts, seconds_to_close')
      .eq('slug', slug)
      .order('event_ts', { ascending: true })
      .limit(5000),
  ]);

  const trades = (tradesRes.data ?? []) as PaperTrade[];
  const detailed = (detailedRes.data ?? []) as TradeDetailed[];

  const points = detailed
    .filter((r) => r.mid_before !== null && r.event_ts)
    .map((r) => ({ t: new Date(r.event_ts).getTime(), mid: r.mid_before as number }));

  const asset = parseAsset(slug);
  const window = parseWindow(slug);
  const closeTs = parseCloseTs(slug);
  const closeDate = closeTs ? new Date(closeTs * 1000) : null;

  return (
    <div className="space-y-4">
      <div>
        <Link href="/trades" className="text-xs text-neutral-500 hover:text-neutral-300">
          ← back to trades
        </Link>
        <h1 className="mt-2 font-mono text-lg text-neutral-100">{slug}</h1>
        <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-neutral-500">
          {asset ? <Badge variant="neutral">{asset.toUpperCase()}</Badge> : null}
          {window ? <Badge variant="neutral">{window}</Badge> : null}
          {closeDate ? <span>closes {closeDate.toLocaleString()}</span> : null}
          <span>· {trades.length} paper trade{trades.length === 1 ? '' : 's'}</span>
          <span>· {points.length} mid samples</span>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Mid price with paper-trade markers</CardTitle>
        </CardHeader>
        <CardContent>
          <MarketChart points={points} trades={trades} />
          <div className="mt-2 flex gap-4 text-[10px] text-neutral-500">
            <span>
              <span className="inline-block translate-y-[1px] text-emerald-400">▲</span> entry
            </span>
            <span>
              <span className="inline-block translate-y-[1px] text-emerald-400">▼</span> profitable exit
            </span>
            <span>
              <span className="inline-block translate-y-[1px] text-red-400">▼</span> losing exit
            </span>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Paper trades on this market</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Entry time</TableHead>
                <TableHead>Strategy</TableHead>
                <TableHead>Side</TableHead>
                <TableHead className="text-right">Entry</TableHead>
                <TableHead className="text-right">Exit</TableHead>
                <TableHead>Reason</TableHead>
                <TableHead className="text-right">P&L/share</TableHead>
                <TableHead className="text-right">P&L $</TableHead>
                <TableHead className="text-right">Duration</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {trades.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={10} className="py-6 text-center text-xs text-neutral-500">
                    No paper trades on this market.
                  </TableCell>
                </TableRow>
              ) : (
                trades.map((t) => {
                  const pnlDollars =
                    t.pnl_per_share !== null ? t.pnl_per_share * t.size_shares : null;
                  const dur =
                    t.entry_ts && t.exit_ts
                      ? Math.max(
                          0,
                          Math.floor(
                            (new Date(t.exit_ts).getTime() - new Date(t.entry_ts).getTime()) / 1000
                          )
                        )
                      : null;
                  return (
                    <TableRow key={t.id}>
                      <TableCell className="font-mono text-xs text-neutral-400">
                        {new Date(t.entry_ts).toLocaleString()}
                      </TableCell>
                      <TableCell className="font-mono text-xs">{t.strategy}</TableCell>
                      <TableCell>
                        <Badge variant={t.side_token === 'YES' ? 'success' : 'danger'}>
                          {t.side_token}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right font-mono tabular-nums">
                        {fmtPrice(t.entry_price)}
                      </TableCell>
                      <TableCell className="text-right font-mono tabular-nums">
                        {fmtPrice(t.exit_price)}
                      </TableCell>
                      <TableCell>
                        {t.exit_reason ? (
                          <Badge variant={exitBadgeVariant(t.exit_reason)}>{t.exit_reason}</Badge>
                        ) : (
                          <span className="text-xs text-neutral-500">—</span>
                        )}
                      </TableCell>
                      <TableCell
                        className={`text-right font-mono tabular-nums ${pnlColor(t.pnl_per_share)}`}
                      >
                        {t.pnl_per_share !== null ? t.pnl_per_share.toFixed(3) : '—'}
                      </TableCell>
                      <TableCell
                        className={`text-right font-mono tabular-nums ${pnlColor(pnlDollars)}`}
                      >
                        {fmtUsd(pnlDollars)}
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs text-neutral-400">
                        {fmtSeconds(dur)}
                      </TableCell>
                      <TableCell>
                        <Badge variant={t.status === 'OPEN' ? 'warning' : 'neutral'}>
                          {t.status}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

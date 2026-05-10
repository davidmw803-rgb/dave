import { LiveTradesDashboard } from '@/components/live/live-trades-dashboard';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Live Trades · Polymarket',
};

export default function LiveTradesPage() {
  return <LiveTradesDashboard />;
}

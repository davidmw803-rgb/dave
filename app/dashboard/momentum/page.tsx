import { MomentumClient } from './momentum-client';

export const dynamic = 'force-dynamic';

export default function MomentumPage() {
  return (
    <div className="space-y-8">
      <header>
        <h2 className="text-2xl font-semibold">Momentum Persistence</h2>
        <p className="text-sm text-neutral-500">
          Does the next candle follow the previous candle&apos;s direction? Port of the{' '}
          <code className="text-neutral-400">btc</code> Python tool.
        </p>
      </header>
      <MomentumClient />
    </div>
  );
}

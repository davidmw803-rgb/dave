# poly-logger

A 24/7 Node daemon that subscribes to Polymarket's WebSocket and logs every
trade and book event for recurring BTC/ETH 5m and 15m Up/Down markets to
Supabase.

Since these markets spawn every 5 or 15 minutes (new market, new asset IDs,
same concept), the logger also polls the Gamma API every 30 seconds to
discover new markets as they open and dynamically subscribes to them.

## Setup

```bash
cd poly-logger
npm install
cp .env.example .env
# edit .env with your Supabase credentials
```

Then run the schema in the Supabase SQL editor: paste the contents of
`schema.sql` and hit run. Creates 4 tables (markets, trades, book snapshots,
price changes) and a helpful `poly_late_window_trades` view.

## Run

Development (hot reload):
```bash
npm run dev
```

Production:
```bash
npm run build
npm start
```

## Keeping it alive 24/7

A few options, in order of increasing robustness:

**Easiest: `screen` or `tmux`**
```bash
tmux new -s poly-logger
npm run dev
# detach with Ctrl+B then D
# reattach later: tmux attach -t poly-logger
```

**Better: `pm2`**
```bash
npm install -g pm2
pm2 start dist/index.js --name poly-logger
pm2 save
pm2 startup  # follow the instructions it prints
```

**Best: systemd service** (Linux VPS)
```
[Unit]
Description=Polymarket Logger
After=network.target

[Service]
Type=simple
User=YOUR_USER
WorkingDirectory=/path/to/poly-logger
EnvironmentFile=/path/to/poly-logger/.env
ExecStart=/usr/bin/node /path/to/poly-logger/dist/index.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

## What gets logged

For each of the 4 target market types (BTC-5m, BTC-15m, ETH-5m, ETH-15m):

- **`poly_markets`** — one row per discovered market, with slug, token IDs,
  window start/end timestamps, asset, and timeframe
- **`poly_trades`** — every `last_trade_price` event (price, size, side, hash)
- **`poly_book_snapshots`** — every `book` event with full depth, plus
  `best_bid_ask` events (lightweight)
- **`poly_price_changes`** — individual level updates (higher frequency)

All tables include `received_at` (our clock) and `source_timestamp`
(Polymarket's clock when available) for latency analysis.

## Data volume expectations

During an active 5-min window, expect roughly:
- 10-200 trades per market (depends on volatility + liquidity)
- 50-500 book updates per market
- 4 concurrent markets (BTC-5m, BTC-15m, ETH-5m, ETH-15m) × 2 sides (YES/NO)
  = 8 streams

Translates to roughly 1-5 MB/day of trade data and 5-30 MB/day of book data.
Supabase free tier (500 MB) is enough for ~30-100 days. Scale up or archive
older data as needed.

## Analysis queries to try

**Trades in the final 10 seconds of each 5m BTC market:**
```sql
select slug, price, size, side, seconds_to_close
from poly_late_window_trades
where asset = 'BTC' and timeframe = '5m' and seconds_to_close <= 10
order by received_at desc
limit 200;
```

**Does late-window action predict resolution?**
```sql
-- Compare the price in the last 10s to the price 1 minute before close
-- per market, then correlate with resolution outcome.
-- (Resolution would need to be pulled separately from Gamma or an oracle.)
```

**Price volatility by second-of-window:**
```sql
select
  extract(epoch from (m.window_end_ts - t.received_at))::int as sec_to_close,
  stddev(t.price) as price_stddev,
  avg(t.size) as avg_size,
  count(*) as n
from poly_trades t
join poly_markets m on m.condition_id = t.condition_id
where t.side_token = 'YES'
  and m.asset = 'BTC' and m.timeframe = '5m'
  and t.received_at between m.window_end_ts - interval '5 minutes' and m.window_end_ts
group by 1
order by 1 desc;
```

## Known limits

- **Market discovery lag:** new markets are detected within 30s of appearing
  in Gamma. First few seconds of a market may be missed. Reduce
  `MARKET_DISCOVERY_INTERVAL_MS` if you care about that edge, at the cost of
  more Gamma API calls.
- **Write batching:** trades are flushed to Supabase every 500ms. If the
  logger crashes between flushes you lose up to 500ms of data. For bulletproof
  logging, swap Supabase for local SQLite and sync to Supabase on a schedule.
- **Reconnect gaps:** if the WS drops for more than a few seconds, you miss
  trades during that gap. The `received_at` timestamps will make gaps
  obvious in post-hoc analysis.
- **Resolution data not logged:** the logger captures trading activity but
  not the final oracle resolution. Add a separate script or extend the
  discovery polling to capture `market_resolved` events.

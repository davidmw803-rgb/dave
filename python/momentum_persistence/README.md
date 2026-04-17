# momentum-persistence

Does the next candle follow the previous candle's direction? This tool quantifies
candle-to-candle momentum persistence across any OHLC series, with optional
Supabase storage for tracking results over time.

## What it measures

For every pair of adjacent candles:

- **P(up | prev up)** — follow-through rate on green candles
- **P(down | prev down)** — follow-through rate on red candles
- **Hit rate** for the "bet same direction as last candle" strategy
- **Expectancy** — avg P&L per bet, which is what actually matters. A 55% hit
  rate loses money if your losers are bigger than your winners.
- Longest up/down runs and full transition matrix (UU / UD / DU / DD)

## Data sources

Pick one per run:

1. **CSV** — any file with `open`, `close` columns (case-insensitive)
2. **yfinance** — stocks, ETFs, crypto, futures by ticker
3. **Supabase** — read from any table with `open`, `close` columns; useful for
   Polymarket price series or any custom OHLC you're storing

## Setup

```bash
git clone <your-repo-url>
cd momentum-persistence
pip install -r requirements.txt

# Optional: for Supabase integration
cp .env.example .env
# edit .env with your SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY
```

If you'll use `--save`, run `schema.sql` in the Supabase SQL editor once to
create the `momentum_analysis_runs` table.

## Usage

```bash
# CSV
python momentum_persistence.py data.csv

# yfinance
python momentum_persistence.py --ticker SPY --days 365 --interval 1d
python momentum_persistence.py --ticker BTC-USD --days 90 --interval 1h

# Supabase (read OHLC from a table)
python momentum_persistence.py --supabase-table ohlc_candles --symbol SPY

# Save the run results back to Supabase
python momentum_persistence.py --ticker SPY --days 365 --save
```

### Flags

| Flag | Purpose |
|------|---------|
| `--ticker`, `--days`, `--interval` | yfinance source |
| `--supabase-table` | Read OHLC from this Supabase table |
| `--symbol`, `--symbol-column` | Filter Supabase rows by symbol/market id |
| `--limit` | Cap rows pulled from Supabase |
| `--save` | Persist results to `momentum_analysis_runs` |
| `--keep-dojis` | Include zero-body candles (excluded by default) |

## Example output

```
============================================================
MOMENTUM PERSISTENCE REPORT  SPY (1d, 365d)
============================================================
Candles analyzed:        250
Transitions:             249
Base rate up / down:     54.0% / 46.0%

P(up   | prev up)    =   56.3%
P(down | prev down)  =   51.3%
Hit rate (follow prev):  54.0%

Transitions UU/UD/DU/DD: 76/59/58/56
Longest up / down run:   8 / 5

STRATEGY: bet same direction as previous candle, exit at close
  Win rate:              54.0%
  Avg win:               +0.8421
  Avg loss:              -0.7102
  Avg P&L per bet:       +0.1283
  Expectancy:            +0.1283

Edge vs coinflip:        +4.0%
Expectancy verdict:      POSITIVE
```

## Caveats

- **Sample size matters.** A single day of intraday candles is ~80 transitions.
  Any "edge" you see there is noise. Run across months or years.
- **No transaction costs modeled.** Spread, fees, and slippage eat edges
  smaller than ~0.2% per trade on most instruments.
- **Regime non-stationarity.** Momentum edges shift. Split your sample into
  halves and compare — if the edge only exists in one half, it's not real.
- **Dojis.** Zero-body candles are dropped by default (they have no direction).
  Pass `--keep-dojis` to include them.

## Dashboard (Streamlit UI)

Same `analyze()` function, browser UI:

```bash
streamlit run dashboard.py
```

Three tabs:

- **Run Analysis** — pick yfinance / CSV / Supabase, set params, hit go. Shows
  KPIs, transition matrix, conditional probabilities, and a color-strip
  visualization of the candle direction sequence. Save runs to Supabase with
  one click.
- **History** — browse past runs with filters (source, label search, verdict).
  Click any row to inspect full metrics.
- **Charts** — track how hit rate, expectancy, or conditional probabilities
  evolve over time across multiple tickers. Latest-run-per-label leaderboard
  sorted by expectancy.

## Files

- `momentum_persistence.py` — analysis logic + CLI
- `dashboard.py` — Streamlit UI
- `.env.example` — template for credentials
- `requirements.txt` — Python dependencies

(Supabase table definition lives in `supabase/migrations/003_momentum_analysis_runs.sql` at the repo root.)

## License

MIT

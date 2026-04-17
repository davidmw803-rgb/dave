"""
Momentum persistence analysis: does the next candle follow the previous candle's direction?

Data sources:
  - CSV file
  - yfinance (traditional tickers)
  - Supabase (OHLC table, for Polymarket series or anything else)

Output:
  - Pretty-printed report to stdout
  - Optional: persist results to Supabase `momentum_analysis_runs` table
"""

import argparse
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd

# Supabase is optional — only needed if --supabase-* flags are used.
try:
    from supabase import create_client, Client
    SUPABASE_AVAILABLE = True
except ImportError:
    SUPABASE_AVAILABLE = False

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass  # .env loading is a convenience, not required


# ---------------------------------------------------------------------------
# Data loaders
# ---------------------------------------------------------------------------

def load_csv(path: str) -> pd.DataFrame:
    df = pd.read_csv(path)
    df.columns = [c.lower().strip() for c in df.columns]
    if not {"open", "close"}.issubset(df.columns):
        raise ValueError(f"CSV must have open, close columns. Got: {list(df.columns)}")
    return df


def load_yfinance(ticker: str, days: int, interval: str = "1d") -> pd.DataFrame:
    try:
        import yfinance as yf
    except ImportError:
        print("yfinance not installed. Run: pip install yfinance", file=sys.stderr)
        sys.exit(1)

    period = f"{days}d" if days <= 730 else "max"
    df = yf.download(ticker, period=period, interval=interval, progress=False, auto_adjust=False)
    if df.empty:
        raise ValueError(f"No data returned for {ticker}")
    if isinstance(df.columns, pd.MultiIndex):
        df.columns = df.columns.get_level_values(0)
    df.columns = [c.lower().strip() for c in df.columns]
    return df.reset_index()


def get_supabase_client() -> "Client":
    if not SUPABASE_AVAILABLE:
        print("supabase-py not installed. Run: pip install supabase", file=sys.stderr)
        sys.exit(1)

    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY") or os.environ.get("SUPABASE_KEY")
    if not url or not key:
        print("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in environment.", file=sys.stderr)
        print("Copy .env.example to .env and fill in your values.", file=sys.stderr)
        sys.exit(1)
    return create_client(url, key)


def load_supabase(
    table: str,
    symbol: str | None = None,
    symbol_column: str = "symbol",
    timestamp_column: str = "timestamp",
    limit: int | None = None,
) -> pd.DataFrame:
    """
    Load OHLC data from a Supabase table.

    Expected columns in the table: open, close (high, low optional).
    Use symbol_column/symbol to filter by ticker or market id.
    """
    client = get_supabase_client()
    query = client.table(table).select("*")
    if symbol is not None:
        query = query.eq(symbol_column, symbol)
    query = query.order(timestamp_column, desc=False)
    if limit is not None:
        query = query.limit(limit)

    response = query.execute()
    data = response.data or []
    if not data:
        raise ValueError(f"No rows returned from Supabase table '{table}'"
                         + (f" for {symbol_column}={symbol!r}" if symbol else ""))

    df = pd.DataFrame(data)
    df.columns = [c.lower().strip() for c in df.columns]
    if not {"open", "close"}.issubset(df.columns):
        raise ValueError(f"Supabase table must have open, close columns. Got: {list(df.columns)}")
    return df


# ---------------------------------------------------------------------------
# Analysis
# ---------------------------------------------------------------------------

def classify_candles(df: pd.DataFrame) -> pd.Series:
    """Return series of +1 (up), -1 (down), 0 (doji)."""
    return np.sign(df["close"] - df["open"]).astype(int)


def analyze(df: pd.DataFrame, drop_dojis: bool = True) -> dict:
    direction = classify_candles(df)

    if drop_dojis:
        mask = direction != 0
        direction = direction[mask].reset_index(drop=True)
        df = df.loc[mask.values].reset_index(drop=True)

    n = len(direction)
    if n < 2:
        raise ValueError("Need at least 2 candles to analyze transitions.")

    prev = direction.iloc[:-1].values
    nxt = direction.iloc[1:].values

    up_up = int(np.sum((prev == 1) & (nxt == 1)))
    up_dn = int(np.sum((prev == 1) & (nxt == -1)))
    dn_up = int(np.sum((prev == -1) & (nxt == 1)))
    dn_dn = int(np.sum((prev == -1) & (nxt == -1)))

    total_prev_up = up_up + up_dn
    total_prev_dn = dn_up + dn_dn
    total = total_prev_up + total_prev_dn

    p_up_given_up = up_up / total_prev_up if total_prev_up else float("nan")
    p_dn_given_dn = dn_dn / total_prev_dn if total_prev_dn else float("nan")
    hit_rate = (up_up + dn_dn) / total

    base_up = int(np.sum(direction == 1)) / n
    base_dn = int(np.sum(direction == -1)) / n

    # Longest runs
    runs = []
    cur_val, cur_len = direction.iloc[0], 1
    for v in direction.iloc[1:]:
        if v == cur_val:
            cur_len += 1
        else:
            runs.append((cur_val, cur_len))
            cur_val, cur_len = v, 1
    runs.append((cur_val, cur_len))
    longest_up = max((length for val, length in runs if val == 1), default=0)
    longest_dn = max((length for val, length in runs if val == -1), default=0)

    # Strategy expectancy: bet same direction as previous candle, exit at close.
    bodies = (df["close"] - df["open"]).values
    pnl = np.where(prev == 1, bodies[1:], -bodies[1:])
    avg_pnl = float(np.mean(pnl))
    win_rate = float(np.mean(pnl > 0))
    avg_win = float(np.mean(pnl[pnl > 0])) if np.any(pnl > 0) else 0.0
    avg_loss = float(np.mean(pnl[pnl < 0])) if np.any(pnl < 0) else 0.0
    expectancy = win_rate * avg_win + (1 - win_rate) * avg_loss

    return {
        "n_candles": n,
        "n_transitions": total,
        "base_rate_up": base_up,
        "base_rate_down": base_dn,
        "p_up_given_prev_up": p_up_given_up,
        "p_down_given_prev_down": p_dn_given_dn,
        "hit_rate_follow_prev": hit_rate,
        "uu": up_up, "ud": up_dn, "du": dn_up, "dd": dn_dn,
        "longest_up_run": longest_up,
        "longest_down_run": longest_dn,
        "strategy_avg_pnl_per_bet": avg_pnl,
        "strategy_win_rate": win_rate,
        "strategy_avg_win": avg_win,
        "strategy_avg_loss": avg_loss,
        "strategy_expectancy": expectancy,
    }


# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------

def print_report(r: dict, label: str = "") -> None:
    print(f"\n{'='*60}")
    print(f"MOMENTUM PERSISTENCE REPORT  {label}")
    print(f"{'='*60}")
    print(f"Candles analyzed:        {r['n_candles']}")
    print(f"Transitions:             {r['n_transitions']}")
    print(f"Base rate up / down:     {r['base_rate_up']:.1%} / {r['base_rate_down']:.1%}")
    print()
    print(f"P(up   | prev up)    =   {r['p_up_given_prev_up']:.1%}")
    print(f"P(down | prev down)  =   {r['p_down_given_prev_down']:.1%}")
    print(f"Hit rate (follow prev):  {r['hit_rate_follow_prev']:.1%}")
    print()
    print(f"Transitions UU/UD/DU/DD: {r['uu']}/{r['ud']}/{r['du']}/{r['dd']}")
    print(f"Longest up / down run:   {r['longest_up_run']} / {r['longest_down_run']}")
    print()
    print("STRATEGY: bet same direction as previous candle, exit at close")
    print(f"  Win rate:              {r['strategy_win_rate']:.1%}")
    print(f"  Avg win:               {r['strategy_avg_win']:+.4f}")
    print(f"  Avg loss:              {r['strategy_avg_loss']:+.4f}")
    print(f"  Avg P&L per bet:       {r['strategy_avg_pnl_per_bet']:+.4f}")
    print(f"  Expectancy:            {r['strategy_expectancy']:+.4f}")
    print()
    edge = r["hit_rate_follow_prev"] - 0.5
    print(f"Edge vs coinflip:        {edge:+.1%}")
    verdict = "POSITIVE" if r["strategy_expectancy"] > 0 else "NEGATIVE"
    print(f"Expectancy verdict:      {verdict}")


def save_run_to_supabase(r: dict, source: str, label: str, table: str = "momentum_analysis_runs") -> None:
    client = get_supabase_client()
    row = {
        "run_at": datetime.now(timezone.utc).isoformat(),
        "source": source,
        "label": label,
        **r,
    }
    response = client.table(table).insert(row).execute()
    if response.data:
        print(f"\nSaved run to Supabase table '{table}' (id={response.data[0].get('id')})")
    else:
        print(f"\nSaved run to Supabase table '{table}'")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description="Analyze candle-to-candle momentum persistence.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  %(prog)s data.csv
  %(prog)s --ticker SPY --days 365 --interval 1d
  %(prog)s --supabase-table polymarket_candles --symbol 0xabc... --save
""",
    )
    # Data source (pick one)
    parser.add_argument("csv", nargs="?", help="Path to OHLC CSV file")
    parser.add_argument("--ticker", help="Ticker symbol (uses yfinance)")
    parser.add_argument("--days", type=int, default=365)
    parser.add_argument("--interval", default="1d")
    parser.add_argument("--supabase-table", help="Read OHLC from this Supabase table")
    parser.add_argument("--symbol", help="Filter Supabase rows by symbol/market id")
    parser.add_argument("--symbol-column", default="symbol")
    parser.add_argument("--timestamp-column", default="timestamp")
    parser.add_argument("--limit", type=int, default=None, help="Limit rows from Supabase")

    # Output
    parser.add_argument("--save", action="store_true", help="Save run results to Supabase")
    parser.add_argument("--results-table", default="momentum_analysis_runs")
    parser.add_argument("--keep-dojis", action="store_true")

    args = parser.parse_args()

    # Pick one data source
    sources_specified = sum(bool(x) for x in [args.csv, args.ticker, args.supabase_table])
    if sources_specified == 0:
        parser.print_help()
        sys.exit(1)
    if sources_specified > 1:
        print("Error: specify only one data source (CSV, --ticker, or --supabase-table).", file=sys.stderr)
        sys.exit(1)

    if args.csv:
        df = load_csv(args.csv)
        source, label = "csv", Path(args.csv).name
    elif args.ticker:
        df = load_yfinance(args.ticker, args.days, args.interval)
        source, label = "yfinance", f"{args.ticker} ({args.interval}, {args.days}d)"
    else:
        df = load_supabase(
            args.supabase_table,
            symbol=args.symbol,
            symbol_column=args.symbol_column,
            timestamp_column=args.timestamp_column,
            limit=args.limit,
        )
        source = "supabase"
        label = f"{args.supabase_table}" + (f" [{args.symbol}]" if args.symbol else "")

    r = analyze(df, drop_dojis=not args.keep_dojis)
    print_report(r, label=label)

    if args.save:
        save_run_to_supabase(r, source=source, label=label, table=args.results_table)


if __name__ == "__main__":
    main()

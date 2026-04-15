# Strategy definitions

Three parallel virtual trades are computed for every event. These definitions are locked — changing them invalidates all historical scorecards, so version-bump if you change them.

## Immediate

Hypothesis: the analyst's call carries information that the market continues to absorb in the first 30 minutes.

- **Entry:** `t+1m` price (first clean bar after publication; skip `t+0` because of timestamp jitter)
- **Exit:** `t+30m` price
- **Direction:** long for buy/upgrade/PT-raise actions; short for sell/downgrade/PT-cut actions
- **Risk:** stop is conceptual — the strategy is a fixed-window holding period

## Fade

Hypothesis: retail piles in during minutes 2-15, overshoots, and the price mean-reverts by the 30-minute mark.

- **Entry:** `t+2m` price, opposite direction to the rating action
- **Exit:** `t+30m` price
- **Direction:** short on buy/upgrade (fade the pop); long on sell/downgrade (fade the dip)
- **Cost note:** shorts must include realistic borrow cost. Small caps are often unborrowable — flag those trades as `failed` with `failure_reason = 'unborrowable'` rather than pretending the trade happened.

## Drift

Hypothesis: post-event drift continues for days as institutional positioning catches up, especially on under-covered names.

- **Entry:** `t+30m` price (after the noise settles)
- **Exit:** `t+5d` close
- **Direction:** long for buy/upgrade/PT-raise; short for sell/downgrade/PT-cut
- **Holding period:** 5 trading days, skipping weekends/holidays

## Returns computed for every trade

For each strategy:
- `raw_return` = (exit - entry) / entry, signed by direction
- `market_adj_return` = raw_return - SPY's return over the same window
- `sector_adj_return` = raw_return - sector ETF's return over the same window
- `cost_adjusted_return` = market_adj_return - estimated_slippage_bps/10000 - estimated_borrow_cost_bps/10000

The `cost_adjusted_return` is the column the scorecards roll up. If it's not positive after costs, the strategy doesn't work.

## Slippage assumptions (defaults, override per ticker class)

| Liquidity bucket | Slippage bps | Borrow bps (annualized) |
|---|---|---|
| Mega cap (> $200B mcap) | 1 | 25 |
| Large cap ($10B–$200B) | 2 | 50 |
| Mid cap ($2B–$10B) | 5 | 150 |
| Small cap ($300M–$2B) | 15 | 400 |
| Micro cap (< $300M) | 30 | unborrowable / flag |

Borrow cost only applies to shorts. For the drift strategy held 5 days, that's `(borrow_bps / 365) * 5 / 10000`.

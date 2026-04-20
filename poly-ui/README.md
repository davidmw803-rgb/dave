# poly-ui

Phone-first, read-only dashboard for the Polymarket trading bots. Reads
directly from the existing Supabase project ("Dave",
`shwylcfhxmrunwjbunnf`). No new backend, no trading actions, no config
changes from the UI.

## Screens

- **`/`** — today / 7d / all-time net P&L, per-strategy table, open positions
  (tap to open the Polymarket market), losing-streak banner, DRY/LIVE toggle.
- **`/trades`** — last 100 trades, filterable by strategy and live/paper.
- **`/paper`** — 7-day paper comparison rollup (trades, WR, total + avg pnl/share).
- **`/halts`** — failed live trades in the last 7 days with error messages.

All pages auto-refresh every 30s and expose a manual `Refresh` button.

## Run locally

```bash
cd poly-ui
cp .env.local.example .env.local
# fill in the three vars
npm install
npm run dev
```

Required env vars:

| Var | Where |
|-----|-------|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase dashboard → Settings → API |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase dashboard → Settings → API (server only) |
| `DASHBOARD_TOKEN` | Generate with `openssl rand -hex 16` |

Open `http://localhost:3000/login?token=<DASHBOARD_TOKEN>`. The middleware
SHA-256-hashes the token and stamps it into an `hp_session` HTTP-only cookie
(30-day expiry). You won't see the raw token in the browser.

## Deploy (Vercel)

1. Push the repo (or just the `poly-ui/` subdirectory) to GitHub.
2. Vercel → New Project → pick the repo. If you kept `poly-ui/` as a subfolder
   of a larger repo, set **Root Directory** to `poly-ui` in the Vercel project
   settings.
3. Set env vars in Vercel (same three as above — mark `SUPABASE_SERVICE_ROLE_KEY`
   and `DASHBOARD_TOKEN` as encrypted).
4. Deploy. The first page you load must be
   `https://<app>.vercel.app/login?token=<your token>` — everything else 401s
   or redirects until the cookie is set.

## Phone setup

```
https://<app>.vercel.app/login?token=<DASHBOARD_TOKEN>
```

Open that once in Safari / Chrome on your phone. You'll be redirected to `/`
with the cookie set. Add to Home Screen for a one-tap launcher.

## Rotating the token

1. Generate a new one: `openssl rand -hex 16`.
2. Update `DASHBOARD_TOKEN` in Vercel's Environment Variables and redeploy.
   (Every existing session cookie hashes to the old token and is now rejected.)
3. Open the new login URL on your phone:
   `https://<app>.vercel.app/login?token=<NEW_TOKEN>`.

If you only need to force-logout (without changing the secret), redeploy with
the same token — cookies persist until they're compared against the current
env, so logout via rotation is effectively the same flow.

## Debugging

If the dashboard is blank / erroring, the fastest check is this one query —
paste it into the Supabase SQL editor:

```sql
SELECT count(*) FROM btc5m_live_trades WHERE dry_run = false;
```

- If that returns a number: Supabase is fine. The issue is env vars or the
  middleware. Check the Vercel deployment logs for `Missing NEXT_PUBLIC_SUPABASE_URL`
  / `Missing SUPABASE_SERVICE_ROLE_KEY`.
- If that errors: Supabase or the `btc5m_live_trades` table is the problem.
  Everything on the dashboard depends on that table; fix it first.

The UI falls back to a plain error state (`ErrorState` component) on any query
failure, so you won't see a React crash screen in prod.

## Project layout

```
poly-ui/
  app/
    api/refresh/{home,trades,paper,halts}/route.ts   JSON endpoints for polling
    login/page.tsx                                   Login UX (middleware handles the token)
    page.tsx                                         Home (live P&L)
    trades/page.tsx
    paper/page.tsx
    halts/page.tsx
    globals.css
    layout.tsx
  components/
    home-view.tsx, trades-view.tsx, paper-view.tsx, halts-view.tsx
    page-header.tsx                                   Tabs + refresh + DRY/LIVE
    use-poll.ts                                       30s polling hook
    error-state.tsx
  lib/
    supabase.ts                                       service-role client (server only)
    queries.ts                                        every SQL-ish query
    auth.ts                                           SHA-256, constant-time eq
    types.ts, format.ts
  middleware.ts                                       Auth gate
```

## What this UI does NOT do

- No trading. No parameter tuning. No writes of any kind.
- No charts. Numbers only in v1.
- No Realtime subscription. Plain 30s poll + manual button.
- No accounts. Single shared-secret token, one human user.
- No per-market drill-down. Tapping a slug opens Polymarket in a new tab.

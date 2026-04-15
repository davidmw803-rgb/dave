# Session 1 — Foundation: Schema, Analyst CRUD, Price Provider Interface

**Paste this entire prompt into Claude Code from the repo root after running `npm install` and `npx supabase init`.**

---

## Context

You are building Session 1 of the Trusted Analyst Rating Reaction & Prediction Engine. Read `README.md` in the repo root before starting. This session lays the foundation for all subsequent sessions, so correctness matters more than speed.

**Stack:** Next.js 14 App Router, TypeScript (strict), Tailwind, shadcn/ui, Supabase (Postgres), pnpm or npm.

**Goal of this session:**
1. Apply the full database schema (all tables, including ones used in later sessions, so we don't migrate them in piecemeal)
2. Build a `/dashboard/analysts` admin page where I can manually CRUD my trusted analyst list
3. Stub out the `PriceProvider` interface and a `MockPriceProvider` implementation so future sessions can develop against deterministic data
4. Generate shared TypeScript types from the Supabase schema
5. Set up the Anthropic SDK client (we'll use it in later sessions for narratives + reports)

Do NOT build ingestion, price capture, strategies, charts, or models in this session. Those are sessions 2-8.

---

## Step 1 — Verify environment

Confirm these files exist and are populated. If any are missing, stop and tell me:
- `.env.local` with `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `ANTHROPIC_API_KEY`
- `package.json` with the dependencies listed in the seed repo
- `supabase/migrations/001_initial_schema.sql` and `002_predictions_models.sql` (already in the repo)

Run `npx supabase start` to ensure local DB is up. Run `npx supabase db reset` to apply both migrations. Verify tables exist with `npx supabase db dump --schema public`.

## Step 2 — Generate TypeScript types from schema

Run `npx supabase gen types typescript --local > types/database.types.ts`. Commit the result. From this point forward, every DB query in the codebase must use these generated types — never raw `any`.

## Step 3 — Supabase client setup

Create `lib/supabase/server.ts` (server-side client using service role for admin ops) and `lib/supabase/browser.ts` (anon client for client components). Use the `@supabase/ssr` package. Standard Next.js App Router pattern.

## Step 4 — PriceProvider interface

Create `lib/providers/price-provider.ts`:

```typescript
export type Bar = {
  timestamp: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export type PricePoint = {
  timestamp: Date;
  price: number;
  volume?: number;
};

export type Granularity = 'second' | 'minute' | 'daily';

export interface PriceProvider {
  name(): string;
  getPriceAt(ticker: string, timestamp: Date): Promise<PricePoint>;
  getBars(
    ticker: string,
    from: Date,
    to: Date,
    granularity: Granularity
  ): Promise<Bar[]>;
  getDailyClose(ticker: string, date: Date): Promise<number>;
  getTradingDayClose(
    ticker: string,
    fromDate: Date,
    nTradingDaysAfter: number
  ): Promise<PricePoint>;
}
```

Then create `lib/providers/mock-provider.ts` implementing the interface with deterministic synthetic data (sine wave + noise seeded by ticker hash). Used by tests and by Session 3 development before we wire a real provider.

Create `lib/providers/index.ts` exporting a `getPriceProvider()` factory that reads `process.env.PRICE_PROVIDER` (`mock` | `polygon` | `databento`) and returns the right instance. For Session 1, only `mock` is implemented; the others throw "not implemented."

## Step 5 — Trusted analyst CRUD page

Build `/dashboard/analysts` as a server component that lists all rows in `trusted_analysts` and a client subcomponent for the create/edit form. Fields editable in the form:

- `name` (text, required)
- `firm` (text, required)
- `uw_analyst_id` (text, required, unique)
- `tier` (select: 1 / 2 / 3, required)
- `confidence_score` (number 1-10, required)
- `sectors` (multi-select tag input, optional — common values: tech, semis, software, consumer, financials, healthcare, energy, industrials, materials, REITs, comms)
- `notes` (textarea, optional but encouraged — this is where I'll record *why* I trust this analyst)
- `active` (boolean toggle, default true)

Actions: create, edit, deactivate (soft delete by setting `active = false`), reactivate. Hard delete is not exposed in the UI — analysts are historical records once they've issued ratings.

Use shadcn/ui components throughout: `Table`, `Dialog`, `Form`, `Input`, `Textarea`, `Select`, `Switch`, `Button`. Use `react-hook-form` + `zod` for validation.

Wire all writes through Server Actions (not API routes) — they're cleaner for this CRUD pattern.

## Step 6 — Anthropic SDK client

Create `lib/anthropic/client.ts`:

```typescript
import Anthropic from '@anthropic-ai/sdk';

export const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY!,
});

export const DEFAULT_MODEL = 'claude-sonnet-4-6';
```

No usage yet — just the client ready for Session 6+ when we generate event narratives and weekly reports.

## Step 7 — Health check page

Build `/dashboard` as a placeholder home that renders:
- Count of active trusted analysts
- Count of rating events (will be 0 after Session 1)
- "Price provider: mock" badge
- Link to `/dashboard/analysts`

This is throwaway scaffolding — Session 4 will replace it with the live event feed.

## Step 8 — Verify

Run:
- `npm run build` — must pass with no TypeScript errors
- `npm run lint` — must pass
- Manually: open `/dashboard/analysts`, create one test analyst, edit it, deactivate it, reactivate it. Confirm it persists across page refresh.

## Output expected

A working Next.js app where I can:
1. See the full database schema applied (run `npx supabase db dump` to verify)
2. Manually manage my trusted analyst list through a real UI
3. Import `getPriceProvider()` and get back a working `MockPriceProvider`
4. Import `anthropic` and have a configured client ready

## Things to NOT do this session

- Do not call the UW API
- Do not implement Polygon or Databento providers
- Do not build the event detail page or chart
- Do not build any model code
- Do not seed analyst data — I will enter my list manually through the UI

## When you finish

Print a summary of: files created, migrations applied, manual test steps for me to verify, and any decisions you made that I should know about. Then stop and wait for me to test before starting Session 2.

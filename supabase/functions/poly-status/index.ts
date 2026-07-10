import postgres from "npm:postgres@3.4.5";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const STATUS_SQL = `SELECT jsonb_build_object(
 'now', now(),
 'archive', jsonb_build_object(
   'marker',(SELECT count(*) FROM research_archive_progress WHERE day='2099-01-01'),
   'days',(SELECT count(*) FROM research_archive_progress WHERE day<'2099-01-01'),
   'ticks_mb',(SELECT round(pg_relation_size('research_ticks')/1048576.0)),
   'pass',(SELECT jsonb_agg(jsonb_build_object('runtime',(now()-query_start)::text,'wait',wait_event))
           FROM pg_stat_activity WHERE query ILIKE '%build_research_ticks%' AND pid<>pg_backend_pid()),
   'crons',(SELECT jsonb_agg(jobname) FROM cron.job)),
 'logger', jsonb_build_object(
   'last_pc',(SELECT max(received_at) FROM poly_price_changes),
   'last_trade',(SELECT max(received_at) FROM poly_trades),
   'active_markets',(SELECT count(*) FROM poly_markets WHERE window_end_ts>now())),
 'fav60',(SELECT jsonb_build_object('n',count(*),
   'closed',count(*) FILTER (WHERE status='CLOSED'),
   'avg_cents',round((avg(pnl_per_share) FILTER (WHERE status='CLOSED')*100)::numeric,2),
   'wr',round((100.0*avg((net_pnl_usd>0)::int) FILTER (WHERE status='CLOSED'))::numeric,1),
   'pnl',round((sum(net_pnl_usd) FILTER (WHERE status='CLOSED'))::numeric,2),
   'first_ts',min(entry_ts),'last_ts',max(entry_ts))
   FROM btc5m_live_trades WHERE strategy='favorite_60_v1' AND dry_run),
 'hb',(SELECT to_jsonb(h) FROM server_heartbeat h WHERE id=1),
 'wallets',(SELECT jsonb_agg(w) FROM (SELECT alias,address,status,discovered_via,
    scores->>'copy_score' AS copy_score, style->>'mm' AS mm
    FROM pm_wallets ORDER BY (status='tracked') DESC, updated_at DESC LIMIT 12) w)
) AS d`;

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return new Response("method not allowed", { status: 405, headers: CORS });

  let password = "";
  try { password = (await req.json())?.password ?? ""; } catch { /* fall through */ }

  // SHA-256 hash of the dashboard password (safe to commit — not the password itself).
  // A DASH_PASS_HASH function secret, if set, takes precedence.
  const expected = Deno.env.get("DASH_PASS_HASH") ??
    "becefb52d89314464241a2c6d946f6761c25158c62d667b3fc7a97a864dcde6d";
  if (!expected || (await sha256Hex(password)) !== expected) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false });
  try {
    const rows = await sql.unsafe(STATUS_SQL);
    return new Response(JSON.stringify(rows[0].d), {
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  } finally {
    await sql.end();
  }
});

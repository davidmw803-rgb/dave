import { NextResponse, type NextRequest } from 'next/server';
import { buildTools } from '@/lib/mcp/tools';
import { checkMcpToken } from '@/lib/mcp/token';
import { dispatch, type JsonRpcRequest } from '@/lib/mcp/protocol';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// A single enrichment pass is budgeted at 45s, so the function needs room.
export const maxDuration = 60;

const INSTRUCTIONS = `Analyst-ratings research for one person's own account.

Ratings come from the Unusual Whales screener; each one is joined to what the
stock did afterwards over 38 windows from one minute to thirty days, and to the
matching move in its sector ETF.

Read this before drawing conclusions:
- "abn" columns are sector-adjusted, "pct"/"move" columns are raw. Only the
  adjusted ones are comparable across different dates.
- A blank intraday window means no trade printed in that window. It is not a
  zero, and filling it with one would invent a cluster of flat observations.
- Windows overlap and ratings cluster on dates, so ordinary standard errors
  overstate significance badly. Say so rather than quoting a p-value.
- Everything pulled is an analyst rating; there is no control group of
  non-rated names, so "rated stocks went up" is not on its own a finding.
- This is one person's research on their own data. It is not investment advice
  and must not be presented as a recommendation.`;

function unauthorized(): NextResponse {
  return NextResponse.json(
    {
      jsonrpc: '2.0',
      id: null,
      error: { code: -32001, message: 'Unauthorized. Send Authorization: Bearer <MCP token>.' },
    },
    { status: 401, headers: { 'WWW-Authenticate': 'Bearer' } }
  );
}

/**
 * Bearer auth against a token that has nothing to do with the dashboard
 * password: it can be handed to a client and revoked on its own. Stored as a
 * scrypt hash, verified in constant time, and never logged.
 */
async function authorized(req: NextRequest): Promise<boolean> {
  const header = req.headers.get('authorization') ?? '';
  const bearer = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
  // Some clients can only put the key in the query string.
  const query = req.nextUrl.searchParams.get('apikey') ?? '';
  return checkMcpToken(bearer || query);
}

export async function POST(req: NextRequest) {
  if (!(await authorized(req))) return unauthorized();

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error.' } },
      { status: 400 }
    );
  }

  const tools = buildTools();
  const info = { name: 'dave-research', version: '1.0.0', instructions: INSTRUCTIONS };

  // A batch is a JSON array; a single call is an object. Notifications produce
  // no response, so a batch of only notifications answers 202 with no body.
  const batch = Array.isArray(body) ? (body as JsonRpcRequest[]) : [body as JsonRpcRequest];
  const responses = [];
  for (const one of batch) {
    const res = await dispatch(one, tools, info);
    if (res) responses.push(res);
  }

  if (responses.length === 0) return new NextResponse(null, { status: 202 });
  return NextResponse.json(Array.isArray(body) ? responses : responses[0]);
}

/** A bare GET is how some clients probe; say what this is without leaking anything. */
export async function GET() {
  return NextResponse.json({
    name: 'dave-research',
    transport: 'streamable-http',
    protocol: 'mcp',
    note: 'POST JSON-RPC here with Authorization: Bearer <MCP token>.',
  });
}

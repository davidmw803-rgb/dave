import { NextResponse, type NextRequest } from 'next/server';
import {
  SESSION_COOKIE,
  devBypassAllowed,
  sessionKeyMaterial,
  verifySessionToken,
} from '@/lib/auth/session';

export const config = {
  // Everything except Next internals, the login endpoints, the self-gated
  // static ops page in public/, the MCP endpoint — which carries its own
  // bearer token because an MCP client has no session cookie to present — and
  // `.well-known`, where OAuth discovery has to be able to reach a 404. A
  // redirect to /login there reads to an MCP client as a sign-in service it
  // must register with, which is how the connector handshake used to fail.
  matcher: [
    '/((?!_next/|favicon.ico|robots.txt|dashboard.html|login|api/auth/|api/mcp|\\.well-known/).*)',
  ],
};

function unauthorized(req: NextRequest, reason: string): NextResponse {
  if (req.nextUrl.pathname.startsWith('/api/')) {
    return NextResponse.json({ error: 'unauthorized', reason }, { status: 401 });
  }
  const url = req.nextUrl.clone();
  url.pathname = '/login';
  url.search = '';
  // Come back to where they were headed once they're in.
  const next = req.nextUrl.pathname + req.nextUrl.search;
  if (next && next !== '/') url.searchParams.set('next', next);
  return NextResponse.redirect(url);
}

export async function middleware(req: NextRequest): Promise<NextResponse> {
  if (!sessionKeyMaterial()) {
    if (devBypassAllowed()) return NextResponse.next();
    return unauthorized(req, 'no-session-secret');
  }

  const ok = await verifySessionToken(req.cookies.get(SESSION_COOKIE)?.value);
  return ok ? NextResponse.next() : unauthorized(req, 'no-session');
}

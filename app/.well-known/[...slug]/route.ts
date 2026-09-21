import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

// OAuth discovery, answered honestly.
//
// An MCP client probes `/.well-known/oauth-protected-resource` and
// `/.well-known/oauth-authorization-server` (and the RFC 8414 defaults that
// follow from them, `/register` and friends) before it will talk to a server.
// A 404 means "no OAuth here" and the client falls back to the bearer token it
// was configured with. Anything else means "there is a sign-in service", and
// the client will try to register against it.
//
// Without this route the auth middleware caught these paths and 307'd them to
// the HTML login page, so Claude's connector discovered a sign-in service that
// could not answer a registration request, and failed with
// "Couldn't register with Dave Research's sign-in service". The MCP endpoint
// authenticates per-request with its own token; there is no OAuth to find.
export async function GET(): Promise<NextResponse> {
  return NextResponse.json(
    { error: 'not_found', detail: 'This server does not use OAuth. Authenticate to /api/mcp with a bearer token.' },
    { status: 404 },
  );
}

export const POST = GET;

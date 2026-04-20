import { NextResponse, type NextRequest } from 'next/server';
import {
  SESSION_COOKIE,
  SESSION_MAX_AGE_DAYS,
  constantTimeEqual,
  expectedSessionValue,
  sha256Hex,
} from '@/lib/auth';

export const config = {
  // Match everything except next internals, favicon, and static files.
  matcher: ['/((?!_next/|favicon.ico|robots.txt).*)'],
};

async function unauth(req: NextRequest, reason: string): Promise<NextResponse> {
  if (req.nextUrl.pathname.startsWith('/api/')) {
    return NextResponse.json({ error: 'unauthorized', reason }, { status: 401 });
  }
  const url = req.nextUrl.clone();
  url.pathname = '/login';
  url.search = '';
  return NextResponse.redirect(url);
}

export async function middleware(req: NextRequest): Promise<NextResponse> {
  const expected = await expectedSessionValue();
  // Fail closed when the server is mis-configured (no token set).
  if (!expected) return unauth(req, 'server-misconfigured');

  const { pathname, searchParams } = req.nextUrl;

  // /login accepts ?token=... and sets the cookie, then redirects to /.
  if (pathname === '/login') {
    const token = searchParams.get('token');
    if (token) {
      const provided = await sha256Hex(token);
      if (constantTimeEqual(provided, expected)) {
        const url = req.nextUrl.clone();
        url.pathname = '/';
        url.search = '';
        const res = NextResponse.redirect(url);
        res.cookies.set({
          name: SESSION_COOKIE,
          value: expected,
          httpOnly: true,
          sameSite: 'strict',
          secure: req.nextUrl.protocol === 'https:',
          path: '/',
          maxAge: 60 * 60 * 24 * SESSION_MAX_AGE_DAYS,
        });
        return res;
      }
    }
    // No token / bad token -> render the login page (handled by the route).
    return NextResponse.next();
  }

  const cookie = req.cookies.get(SESSION_COOKIE)?.value;
  if (!cookie) return unauth(req, 'no-cookie');
  if (!constantTimeEqual(cookie, expected)) return unauth(req, 'stale-cookie');
  return NextResponse.next();
}

import { NextResponse, type NextRequest } from 'next/server';
import { COOKIE_NAME, verifySession } from '@/lib/auth/session';

export async function middleware(req: NextRequest) {
  const token = req.cookies.get(COOKIE_NAME)?.value;
  const ok = await verifySession(token);

  if (!ok) {
    const url = req.nextUrl.clone();
    url.pathname = '/login';
    // Preserve where the user was going so we can bounce back after login.
    const from = req.nextUrl.pathname + req.nextUrl.search;
    if (from && from !== '/') url.searchParams.set('from', from);
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  // Everything except the login page itself, Next internals, and static assets.
  matcher: [
    '/((?!login|_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml).*)',
  ],
};

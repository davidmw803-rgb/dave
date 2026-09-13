import { NextResponse, type NextRequest } from 'next/server';
import {
  SESSION_COOKIE,
  SESSION_MAX_AGE_DAYS,
  issueSessionToken,
  sessionKeyMaterial,
} from '@/lib/auth/session';
import { checkPassword, passwordSource, setPassword } from '@/lib/auth/password';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Best-effort brute-force throttle. Serverless instances don't share this map,
// so it slows an attacker down rather than stopping one — the real protection
// is a long password.
const WINDOW_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 10;
const attempts = new Map<string, { count: number; first: number }>();

function tooManyAttempts(ip: string): boolean {
  const now = Date.now();
  const rec = attempts.get(ip);
  if (!rec || now - rec.first > WINDOW_MS) {
    attempts.set(ip, { count: 1, first: now });
    return false;
  }
  rec.count += 1;
  return rec.count > MAX_ATTEMPTS;
}

async function sessionResponse(req: NextRequest, body: Record<string, unknown>) {
  const token = await issueSessionToken();
  if (!token) {
    return NextResponse.json(
      { error: 'Server cannot sign sessions: no session secret available.' },
      { status: 503 }
    );
  }
  const res = NextResponse.json(body);
  res.cookies.set({
    name: SESSION_COOKIE,
    value: token,
    httpOnly: true,
    sameSite: 'lax',
    secure: req.nextUrl.protocol === 'https:',
    path: '/',
    maxAge: 60 * 60 * 24 * SESSION_MAX_AGE_DAYS,
  });
  return res;
}

export async function POST(req: NextRequest) {
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
  if (tooManyAttempts(ip)) {
    return NextResponse.json(
      { error: 'Too many attempts. Wait a few minutes and try again.' },
      { status: 429 }
    );
  }

  if (!sessionKeyMaterial()) {
    return NextResponse.json(
      { error: 'Server is missing a session secret (SUPABASE_SERVICE_ROLE_KEY).' },
      { status: 503 }
    );
  }

  let password = '';
  try {
    const body = await req.json();
    password = typeof body?.password === 'string' ? body.password : '';
  } catch {
    return NextResponse.json({ error: 'Malformed request.' }, { status: 400 });
  }

  // First run: no password anywhere yet, so the first visitor sets one.
  if ((await passwordSource()) === 'none') {
    try {
      await setPassword(password);
    } catch (e) {
      return NextResponse.json(
        { error: e instanceof Error ? e.message : 'Could not set the password.' },
        { status: 400 }
      );
    }
    attempts.delete(ip);
    return sessionResponse(req, { ok: true, created: true });
  }

  if (!(await checkPassword(password))) {
    return NextResponse.json({ error: 'Wrong password.' }, { status: 401 });
  }

  attempts.delete(ip);
  return sessionResponse(req, { ok: true });
}

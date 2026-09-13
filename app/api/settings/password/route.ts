import { NextResponse, type NextRequest } from 'next/server';
import { checkPassword, passwordSource, setPassword } from '@/lib/auth/password';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Gated by the middleware like every other /api route: only a signed-in
// session reaches this handler.

export async function GET() {
  return NextResponse.json({ source: await passwordSource() });
}

export async function POST(req: NextRequest) {
  let currentPassword = '';
  let newPassword = '';
  try {
    const body = await req.json();
    currentPassword = typeof body?.currentPassword === 'string' ? body.currentPassword : '';
    newPassword = typeof body?.newPassword === 'string' ? body.newPassword : '';
  } catch {
    return NextResponse.json({ error: 'Malformed request.' }, { status: 400 });
  }

  // Changing an existing password requires the current one, even from inside a
  // session — a borrowed laptop shouldn't be able to lock the owner out.
  if ((await passwordSource()) !== 'none' && !(await checkPassword(currentPassword))) {
    return NextResponse.json({ error: 'Current password is wrong.' }, { status: 401 });
  }

  try {
    await setPassword(newPassword);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Could not save the password.' },
      { status: 400 }
    );
  }

  return NextResponse.json({ ok: true, source: await passwordSource() });
}

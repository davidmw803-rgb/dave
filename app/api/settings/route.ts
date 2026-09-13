import { NextResponse, type NextRequest } from 'next/server';
import {
  SETTING_DEFS,
  clearSetting,
  getSettingStatuses,
  setSetting,
  type SettingKey,
} from '@/lib/settings/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// The middleware gates every /api route behind the session cookie, so anything
// reaching this handler is already authenticated.

function isKnownKey(key: unknown): key is SettingKey {
  return typeof key === 'string' && SETTING_DEFS.some((d) => d.key === key);
}

export async function GET() {
  const { statuses, error } = await getSettingStatuses();
  return NextResponse.json({ statuses, error });
}

export async function POST(req: NextRequest) {
  let body: { key?: unknown; value?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Malformed request.' }, { status: 400 });
  }

  if (!isKnownKey(body.key)) {
    return NextResponse.json({ error: 'Unknown setting key.' }, { status: 400 });
  }
  if (typeof body.value !== 'string' || body.value.trim().length === 0) {
    return NextResponse.json({ error: 'Value is required.' }, { status: 400 });
  }

  try {
    await setSetting(body.key, body.value);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Could not save setting.' },
      { status: 500 }
    );
  }

  const { statuses } = await getSettingStatuses();
  return NextResponse.json({ ok: true, statuses });
}

export async function DELETE(req: NextRequest) {
  const key = req.nextUrl.searchParams.get('key');
  if (!isKnownKey(key)) {
    return NextResponse.json({ error: 'Unknown setting key.' }, { status: 400 });
  }

  try {
    await clearSetting(key);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Could not clear setting.' },
      { status: 500 }
    );
  }

  const { statuses } = await getSettingStatuses();
  return NextResponse.json({ ok: true, statuses });
}

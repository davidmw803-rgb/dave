import { NextResponse } from 'next/server';
import { serverClient } from '@/lib/supabase';
import { getHaltsData } from '@/lib/queries';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET() {
  try {
    const data = await getHaltsData(serverClient());
    return NextResponse.json(data);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'unknown' },
      { status: 500 }
    );
  }
}

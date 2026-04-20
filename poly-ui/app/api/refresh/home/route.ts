import { NextResponse } from 'next/server';
import { serverClient } from '@/lib/supabase';
import { getHomeData } from '@/lib/queries';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const dryRun = searchParams.get('mode') === 'dry';
    const data = await getHomeData(serverClient(), dryRun);
    return NextResponse.json(data);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'unknown' },
      { status: 500 }
    );
  }
}

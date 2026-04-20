import { NextResponse } from 'next/server';
import { serverClient } from '@/lib/supabase';
import { getTradesData } from '@/lib/queries';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const source = searchParams.get('source') === 'paper' ? 'paper' : 'live';
    const strategy = searchParams.get('strategy') || null;
    const dryRun = searchParams.get('mode') === 'dry';
    const data = await getTradesData(serverClient(), { source, strategy, dryRun });
    return NextResponse.json(data);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'unknown' },
      { status: 500 }
    );
  }
}

/**
 * GET /api/vdot
 * Get VDOT history data for trend visualization.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getVDOTHistory } from '@/app/lib/db';
import { parseIntParam } from '@/app/lib/query-params';

const NO_STORE = { 'Cache-Control': 'no-store' };

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const limit = parseIntParam(searchParams.get('limit'), {
    fallback: 50,
    min: 1,
    max: 500,
    name: 'limit',
  });
  if (!limit.ok) return NextResponse.json({ error: limit.error }, { status: 400 });

  try {
    const data = getVDOTHistory(limit.value);
    return NextResponse.json({ data, count: data.length }, { headers: NO_STORE });
  } catch (error) {
    console.error('Error fetching VDOT data:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500, headers: NO_STORE }
    );
  }
}

/**
 * GET /api/activities/months
 * Returns per-month summaries (monthKey, totalDistance, count).
 * Query: limit, offset — 可选，用于分页；不传则返回全部。
 */

import { NextRequest, NextResponse } from 'next/server';
import { getMonthSummaries } from '@/app/lib/db';

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const limitParam = searchParams.get('limit');
    const offsetParam = searchParams.get('offset');
    const limit = limitParam != null ? parseInt(limitParam, 10) : undefined;
    const offset = offsetParam != null ? parseInt(offsetParam, 10) : undefined;

    if (limit != null && (Number.isNaN(limit) || limit < 1 || limit > 100)) {
      return NextResponse.json({ error: 'limit must be 1–100' }, { status: 400 });
    }
    if (offset != null && (Number.isNaN(offset) || offset < 0)) {
      return NextResponse.json({ error: 'offset must be >= 0' }, { status: 400 });
    }

    const result = getMonthSummaries(limit, offset);
    const headers = { 'Cache-Control': 'no-store' };
    if (Array.isArray(result)) {
      return NextResponse.json({ data: result }, { headers });
    }
    return NextResponse.json({ data: result.data, total: result.total }, { headers });
  } catch (error) {
    console.error('Error fetching month summaries:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500, headers: { 'Cache-Control': 'no-store' } }
    );
  }
}

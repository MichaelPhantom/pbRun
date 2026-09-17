/**
 * GET /api/activities/months
 * Returns per-month summaries (monthKey, totalDistance, count).
 * Query: limit, offset — 可选，用于分页；不传则返回全部。
 */

import { NextRequest, NextResponse } from 'next/server';
import { getMonthSummaries } from '@/app/lib/db';
import { parseIntParam } from '@/app/lib/query-params';

const NO_STORE = { 'Cache-Control': 'no-store' };

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;

  const limitParam = searchParams.get('limit');
  const offsetParam = searchParams.get('offset');

  // 保留「未传则为 undefined(返回全部)」语义: 仅在显式传参时解析校验。
  let limit: number | undefined;
  if (limitParam != null && limitParam !== '') {
    const p = parseIntParam(limitParam, { fallback: 6, min: 1, max: 100, name: 'limit' });
    if (!p.ok) return NextResponse.json({ error: p.error }, { status: 400 });
    limit = p.value;
  }
  let offset: number | undefined;
  if (offsetParam != null && offsetParam !== '') {
    const p = parseIntParam(offsetParam, { fallback: 0, min: 0, max: 10_000_000, name: 'offset' });
    if (!p.ok) return NextResponse.json({ error: p.error }, { status: 400 });
    offset = p.value;
  }

  try {
    const result = getMonthSummaries(limit, offset);
    if (Array.isArray(result)) {
      return NextResponse.json({ data: result }, { headers: NO_STORE });
    }
    return NextResponse.json({ data: result.data, total: result.total }, { headers: NO_STORE });
  } catch (error) {
    console.error('Error fetching month summaries:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500, headers: NO_STORE }
    );
  }
}

/**
 * GET /api/activities
 * Get list of activities with pagination and filtering.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getActivities } from '@/app/lib/db';
import { ActivityQueryParams } from '@/app/lib/types';
import { parseIntParam, parseDateParam } from '@/app/lib/query-params';

const NO_STORE = { 'Cache-Control': 'no-store' };

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;

  const page = parseIntParam(searchParams.get('page'), {
    fallback: 1,
    min: 1,
    max: 1_000_000,
    name: 'page',
  });
  if (!page.ok) return NextResponse.json({ error: page.error }, { status: 400 });
  const limit = parseIntParam(searchParams.get('limit'), {
    fallback: 20,
    min: 1,
    max: 500,
    name: 'limit',
  });
  if (!limit.ok) return NextResponse.json({ error: limit.error }, { status: 400 });
  const startDate = parseDateParam(searchParams.get('startDate'), 'startDate');
  if (!startDate.ok) return NextResponse.json({ error: startDate.error }, { status: 400 });
  const endDate = parseDateParam(searchParams.get('endDate'), 'endDate');
  if (!endDate.ok) return NextResponse.json({ error: endDate.error }, { status: 400 });

  if (startDate.value && endDate.value && startDate.value > endDate.value) {
    return NextResponse.json({ error: 'startDate must be <= endDate' }, { status: 400 });
  }

  const params: ActivityQueryParams = {
    page: page.value,
    limit: limit.value,
    type: searchParams.get('type') || undefined,
    startDate: startDate.value,
    endDate: endDate.value,
  };

  try {
    const result = getActivities(params);
    return NextResponse.json(result, { headers: NO_STORE });
  } catch (error) {
    console.error('Error fetching activities:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500, headers: NO_STORE }
    );
  }
}

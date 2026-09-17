/**
 * GET /api/analysis/vdot-trend
 * Get VDOT trend data grouped by week or month.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getVDOTTrend } from '@/app/lib/db';
import { parseDateParam } from '@/app/lib/query-params';
import type { VDOTTrendParams } from '@/app/lib/types';

const NO_STORE = { 'Cache-Control': 'no-store' };

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const groupBy = (searchParams.get('groupBy') || 'month') as 'week' | 'month';

  // Validate groupBy parameter
  if (!['week', 'month'].includes(groupBy)) {
    return NextResponse.json(
      { error: 'groupBy must be either "week" or "month"' },
      { status: 400 }
    );
  }

  // 校验日期 (含真实日历日)
  const startDate = parseDateParam(searchParams.get('startDate'), 'startDate');
  if (!startDate.ok) return NextResponse.json({ error: startDate.error }, { status: 400 });
  const endDate = parseDateParam(searchParams.get('endDate'), 'endDate');
  if (!endDate.ok) return NextResponse.json({ error: endDate.error }, { status: 400 });
  if (startDate.value && endDate.value && startDate.value > endDate.value) {
    return NextResponse.json(
      { error: 'startDate must not be later than endDate' },
      { status: 400 }
    );
  }

  try {
    const params: VDOTTrendParams = {
      startDate: startDate.value,
      endDate: endDate.value,
      groupBy,
    };

    const data = getVDOTTrend(params);
    return NextResponse.json(
      { data, groupBy, count: data.length },
      { headers: NO_STORE }
    );
  } catch (error) {
    console.error('Error fetching VDOT trend:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500, headers: NO_STORE }
    );
  }
}

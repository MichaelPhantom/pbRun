/**
 * GET /api/analysis/hr-zones
 * 按心率区间统计（以心率为准），按周或月聚合。
 * Get heart rate zone statistics grouped by week or month.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getHrZoneStats } from '@/app/lib/db';
import { hrZoneRangeMap, resolveMaxHr } from '@/app/lib/hr-zones';
import { parseDateParam } from '@/app/lib/query-params';
import type { HrZoneAnalysisParams } from '@/app/lib/types';

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

  // 校验日期 (含真实日历日, 如 2024-02-30 拒绝)
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
    const params: HrZoneAnalysisParams = {
      startDate: startDate.value,
      endDate: endDate.value,
      groupBy,
    };

    // Get HR zone statistics
    const data = getHrZoneStats(params);

    // 心率区间 BPM 范围：与 lib/db getHrZone 及 MCP 工具一致（共享 app/lib/hr-zones）
    const zoneRanges = hrZoneRangeMap(resolveMaxHr());

    const summary = {
      total_activities: data.reduce((sum, item) => sum + item.activity_count, 0),
      total_periods: new Set(data.map(item => item.period)).size,
      date_range: {
        start: startDate.value || 'all',
        end: endDate.value || 'all',
      },
    };

    return NextResponse.json(
      { data, zoneRanges, summary, groupBy },
      { headers: NO_STORE }
    );
  } catch (error) {
    console.error('Error fetching HR zone stats:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500, headers: NO_STORE }
    );
  }
}

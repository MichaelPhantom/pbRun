/**
 * GET /api/analysis/vdot-trend
 * Get VDOT trend data grouped by week or month.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getVDOTTrend } from '@/app/lib/db';
import type { VDOTTrendParams } from '@/app/lib/types';

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const startDate = searchParams.get('startDate') || undefined;
    const endDate = searchParams.get('endDate') || undefined;
    const groupBy = (searchParams.get('groupBy') || 'month') as 'week' | 'month';

    // Validate groupBy parameter
    if (!['week', 'month'].includes(groupBy)) {
      return NextResponse.json(
        { error: 'groupBy must be either "week" or "month"' },
        { status: 400 }
      );
    }

    // Validate date format if provided
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (startDate && !dateRegex.test(startDate)) {
      return NextResponse.json(
        { error: 'startDate must be in YYYY-MM-DD format' },
        { status: 400 }
      );
    }
    if (endDate && !dateRegex.test(endDate)) {
      return NextResponse.json(
        { error: 'endDate must be in YYYY-MM-DD format' },
        { status: 400 }
      );
    }
    if (startDate && endDate && startDate > endDate) {
      return NextResponse.json(
        { error: 'startDate must not be later than endDate' },
        { status: 400 }
      );
    }

    const params: VDOTTrendParams = {
      startDate,
      endDate,
      groupBy,
    };

    // Get VDOT trend data
    const data = getVDOTTrend(params);

    return NextResponse.json({
      data,
      groupBy,
      count: data.length,
    });
  } catch (error) {
    console.error('Error fetching VDOT trend:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

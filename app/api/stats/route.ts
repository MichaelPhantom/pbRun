/**
 * GET /api/stats
 * Get statistics for a time period.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getStats } from '@/app/lib/db';

const NO_STORE = { 'Cache-Control': 'no-store' };

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const period = searchParams.get('period');

    if (period && !['week', 'month', 'year', 'total'].includes(period)) {
      return NextResponse.json(
        { error: 'Period must be one of: week, month, year, total' },
        { status: 400, headers: NO_STORE }
      );
    }

    const stats = getStats(
      (period as 'week' | 'month' | 'year' | 'total' | null) || undefined,
    );

    return NextResponse.json(stats, { headers: NO_STORE });
  } catch (error) {
    console.error('Error fetching stats:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500, headers: NO_STORE }
    );
  }
}

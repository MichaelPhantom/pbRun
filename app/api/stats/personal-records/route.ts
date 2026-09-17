/**
 * GET /api/stats/personal-records?period=week|month|year|total|6months
 * 默认 period=total（全部时间），避免最近 6 个月无数据时一片空白
 */

import { NextRequest, NextResponse } from 'next/server';
import { getPersonalRecords } from '@/app/lib/db';

const NO_STORE = { 'Cache-Control': 'no-store' };

export async function GET(request: NextRequest) {
  try {
    const period = (request.nextUrl.searchParams.get('period') || 'total') as 'week' | 'month' | 'year' | 'total' | '6months';
    if (!['week', 'month', 'year', 'total', '6months'].includes(period)) {
      return NextResponse.json(
        { error: 'Period must be one of: week, month, year, total, 6months' },
        { status: 400, headers: NO_STORE }
      );
    }
    const data = getPersonalRecords(period);
    return NextResponse.json(data, { headers: NO_STORE });
  } catch (error) {
    console.error('Error fetching personal records:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500, headers: NO_STORE }
    );
  }
}

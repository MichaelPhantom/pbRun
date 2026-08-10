/**
 * GET /api/analysis/pace-zones?startDate=&endDate=&vdot=
 * 根据当前跑力 VDOT 计算 Z1-Z5 配速区间，并基于 laps 统计各区间内心率、步频、步幅
 */

import { NextRequest, NextResponse } from 'next/server';
import { getPaceZoneStats } from '@/app/lib/db';

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const startDate = searchParams.get('startDate') ?? '';
    const endDate = searchParams.get('endDate') ?? '';
    const vdotStr = searchParams.get('vdot') ?? '';

    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (!dateRegex.test(startDate) || !dateRegex.test(endDate)) {
      return NextResponse.json(
        { error: 'startDate and endDate must be YYYY-MM-DD' },
        { status: 400 }
      );
    }
    if (startDate > endDate) {
      return NextResponse.json(
        { error: 'startDate must not be later than endDate' },
        { status: 400 }
      );
    }
    const vdot = parseFloat(vdotStr);
    if (Number.isNaN(vdot) || vdot <= 0) {
      return NextResponse.json(
        { error: 'vdot must be a positive number (current running power)' },
        { status: 400 }
      );
    }

    const data = getPaceZoneStats(vdot, startDate, endDate);
    return NextResponse.json({ data });
  } catch (error) {
    console.error('Error fetching pace zone stats:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

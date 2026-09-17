/**
 * GET /api/analysis/pace-zones?startDate=&endDate=&vdot=
 * 根据当前跑力 VDOT 计算 Z1-Z5 配速区间，并基于 laps 统计各区间内心率、步频、步幅
 */

import { NextRequest, NextResponse } from 'next/server';
import { getPaceZoneStats } from '@/app/lib/db';
import { parseDateParam, parseFloatParam } from '@/app/lib/query-params';

const NO_STORE = { 'Cache-Control': 'no-store' };

// VDOT 实际取值约 20–90; 上限放宽到 100 以防异常输入。
const VDOT_MIN = 1;
const VDOT_MAX = 100;

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;

  const startDate = parseDateParam(searchParams.get('startDate'), 'startDate');
  if (!startDate.ok || !startDate.value) {
    return NextResponse.json(
      { error: startDate.ok ? 'startDate is required (YYYY-MM-DD)' : startDate.error },
      { status: 400 },
    );
  }
  const endDate = parseDateParam(searchParams.get('endDate'), 'endDate');
  if (!endDate.ok || !endDate.value) {
    return NextResponse.json(
      { error: endDate.ok ? 'endDate is required (YYYY-MM-DD)' : endDate.error },
      { status: 400 },
    );
  }
  if (startDate.value > endDate.value) {
    return NextResponse.json(
      { error: 'startDate must not be later than endDate' },
      { status: 400 },
    );
  }
  // parseFloatParam 用 Number() 且校验 isFinite: 拒绝 "Infinity" / "12.5abc" / NaN。
  const vdot = parseFloatParam(searchParams.get('vdot'), {
    min: VDOT_MIN,
    max: VDOT_MAX,
    name: 'vdot',
  });
  if (!vdot.ok) return NextResponse.json({ error: vdot.error }, { status: 400 });

  try {
    const data = getPaceZoneStats(vdot.value, startDate.value, endDate.value);
    return NextResponse.json({ data }, { headers: NO_STORE });
  } catch (error) {
    console.error('Error fetching pace zone stats:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500, headers: NO_STORE }
    );
  }
}

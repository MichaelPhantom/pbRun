/**
 * GET /api/activities/:id/records
 * Get record-level data for an activity (heart rate, cadence, stride trend over time).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getActivityRecords, getActivityById } from '@/app/lib/db';
import { parseIdParam } from '@/app/lib/query-params';

const NO_STORE = { 'Cache-Control': 'no-store' };

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const parsed = parseIdParam(id);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  try {
    const activity = getActivityById(parsed.value);
    if (!activity) {
      return NextResponse.json({ error: 'Activity not found' }, { status: 404, headers: NO_STORE });
    }

    // getActivityRecords 对「无记录」已返回 []; 此处不再吞掉 DB 异常,
    // 真正的读取失败交由下方 catch 返回 500 (此前会伪装成 200 空数组)。
    const records = getActivityRecords(parsed.value);
    return NextResponse.json(
      { activity_id: parsed.value, records },
      { headers: NO_STORE }
    );
  } catch (error) {
    console.error('Error fetching activity records:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500, headers: NO_STORE }
    );
  }
}

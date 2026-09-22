import { NextRequest, NextResponse } from 'next/server';
import { getActivityInsight } from '@/app/lib/activity-insight-service';
import { parseIdParam } from '@/app/lib/query-params';

const NO_STORE = { 'Cache-Control': 'no-store' };

/**
 * GET /api/activities/[id]/insight —— 活动详情深挖。
 * 返回分段角色分析 / 主课漂移 / 心率区间占比 / 逐秒解耦 / 同路线对比。
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const parsed = parseIdParam(id);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400, headers: NO_STORE });
  }

  try {
    const data = getActivityInsight(parsed.value);
    if (!data) {
      return NextResponse.json({ error: 'Activity not found' }, { status: 404, headers: NO_STORE });
    }
    return NextResponse.json({ data }, { headers: NO_STORE });
  } catch (error) {
    console.error('Error generating activity insight:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500, headers: NO_STORE },
    );
  }
}

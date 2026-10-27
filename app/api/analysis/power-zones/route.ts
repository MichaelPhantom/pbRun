/**
 * GET /api/analysis/power-zones?startDate=&endDate=
 *
 * 功率区间统计：把每个 **lap 的平均功率**按**该活动自己的 FTP** 归入 app 的
 * 5 区 %FTP 模型（Z1<65% / Z2<80% / Z3<90% / Z4<100% / Z5≥100%），再跨活动聚合。
 *
 * **必须按 %FTP 而不是绝对瓦数**：真实库 241 条有功率的跑步活动共 14 个不同
 * FTP（338–379W），按瓦数分桶会让同一段 320W 在不同活动里落到不同区间 ——
 * 与心率区间当年的 19 套边界是同一个陷阱（见 docs/features.md §1.2）。
 * 响应里的 `reference.ftp_median_watts` 是**参照**分母，用于把区间换算成瓦数，
 * 不是任何一次活动的 FTP。
 *
 * 跑步口径：非跑步活动逐秒功率 0/107、lap `average_power` 0/255，天然不参与。
 */

import { NextRequest, NextResponse } from 'next/server';
import { getPowerZoneStats } from '@/app/lib/db';
import { parseDateParam } from '@/app/lib/query-params';
import { powerZoneBoundsLabel, powerZoneRanges } from '@/app/lib/power-zones';

const NO_STORE = { 'Cache-Control': 'no-store' };

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;

  const startDate = parseDateParam(searchParams.get('startDate'), 'startDate');
  if (!startDate.ok || !startDate.value) {
    return NextResponse.json(
      { error: startDate.ok ? 'startDate is required (YYYY-MM-DD)' : startDate.error },
      { status: 400, headers: NO_STORE },
    );
  }
  const endDate = parseDateParam(searchParams.get('endDate'), 'endDate');
  if (!endDate.ok || !endDate.value) {
    return NextResponse.json(
      { error: endDate.ok ? 'endDate is required (YYYY-MM-DD)' : endDate.error },
      { status: 400, headers: NO_STORE },
    );
  }
  if (startDate.value > endDate.value) {
    return NextResponse.json(
      { error: 'startDate must not be later than endDate' },
      { status: 400, headers: NO_STORE },
    );
  }

  try {
    const { zones, reference } = getPowerZoneStats(startDate.value, endDate.value);

    // 参照 FTP 的瓦数范围表 —— 与区间判定函数同源（powerZoneRanges 下界用 ceil，
    // 保证「表说 Z2 从 242W 开始」与「powerZoneOf(242) 返回 Z2」永远一致）。
    const ranges =
      reference.ftp_median_watts != null
        ? powerZoneRanges(reference.ftp_median_watts)
        : null;

    return NextResponse.json(
      {
        zones,
        reference,
        ranges,
        // 口径说明由常量派生，不在客户端手写百分比（改边界时文案自动跟随）。
        boundsLabel: powerZoneBoundsLabel(),
      },
      { headers: NO_STORE },
    );
  } catch (error) {
    console.error('Error fetching power zone stats:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500, headers: NO_STORE });
  }
}

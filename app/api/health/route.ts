/**
 * GET /api/health
 * 存活 + 就绪探针(2026-09-15 新增)。
 *
 * 此前无任何探活端点, 外部(Nginx/systemd/监控)无法判断服务 + DB 是否健康。
 * 浅探活: 进程存活即 200(不触 DB, 供高频轮询);
 * 深探活(?deep=1): 校验 SQLite 可读(轻量 count), 失败 503 degraded。
 */

import { NextRequest, NextResponse } from 'next/server';
import { getVDOTHistoryTotal } from '@/app/lib/db';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const deep = request.nextUrl.searchParams.get('deep') === '1';
  const base = {
    service: 'pbRun',
    time: new Date().toISOString(),
    uptime_s: Math.round(process.uptime()),
  };

  if (!deep) {
    return NextResponse.json({ status: 'ok', ...base });
  }

  // 深探活: DB 可读性(轻量查询, 不依赖业务数据存在)
  try {
    const total = getVDOTHistoryTotal();
    return NextResponse.json({ status: 'ok', db: 'reachable', vdot_rows: total, ...base });
  } catch (error) {
    console.error('[health] DB 探活失败:', error);
    return NextResponse.json(
      { status: 'degraded', db: 'unreachable', ...base },
      { status: 503 }
    );
  }
}

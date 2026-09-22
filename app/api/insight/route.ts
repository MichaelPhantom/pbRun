import { NextRequest, NextResponse } from 'next/server';
import { getInsight } from '@/app/lib/insight-service';
import { parseDateParam } from '@/app/lib/query-params';
import { getDateRangeFromDays, parseTimeRangeDays } from '@/app/lib/date-utils';

const NO_STORE = { 'Cache-Control': 'no-store' };

/**
 * GET /api/insight —— 动态生成训练洞察。
 *
 * 查询参数 (二选一):
 *  - days=30|90|180  : 预设时间窗 (缺省 90)
 *  - startDate & endDate (YYYY-MM-DD) : 显式区间, 优先于 days
 *
 * 所有指标请求时实时计算, 响应头 no-store。
 */
export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;

  let startDate: string | undefined;
  let endDate: string | undefined;

  const startParsed = parseDateParam(searchParams.get('startDate'), 'startDate');
  if (!startParsed.ok) {
    return NextResponse.json({ error: startParsed.error }, { status: 400, headers: NO_STORE });
  }
  const endParsed = parseDateParam(searchParams.get('endDate'), 'endDate');
  if (!endParsed.ok) {
    return NextResponse.json({ error: endParsed.error }, { status: 400, headers: NO_STORE });
  }

  if (startParsed.value && endParsed.value) {
    if (startParsed.value > endParsed.value) {
      return NextResponse.json(
        { error: 'startDate must not be later than endDate' },
        { status: 400, headers: NO_STORE },
      );
    }
    startDate = startParsed.value;
    endDate = endParsed.value;
  } else {
    const days = parseTimeRangeDays(searchParams.get('days'));
    const range = getDateRangeFromDays(days);
    startDate = range.startDate;
    endDate = range.endDate;
  }

  try {
    const data = getInsight({ startDate, endDate });
    return NextResponse.json({ data }, { headers: NO_STORE });
  } catch (error) {
    console.error('Error generating insight:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500, headers: NO_STORE },
    );
  }
}

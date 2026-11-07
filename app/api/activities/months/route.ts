/**
 * GET /api/activities/months
 * Returns per-month summaries (monthKey, totalDistance, count, runDistance, runCount).
 * Query: limit, offset — 可选，用于分页；不传则返回全部。
 *        type — 活动类型过滤（原始 activity_type 键）
 *        q    — 名称模糊搜索
 *
 * 过滤必须作用在**月度汇总本身**：只在展开的单月里过滤会让「按类型筛选」退化成
 * 「在当前月份里筛选」，用户选「力量训练」时当月没有力量课就只看到「无匹配」。
 */

import { NextRequest, NextResponse } from 'next/server';
import { getMonthSummaries } from '@/app/lib/db';
import { parseIntParam } from '@/app/lib/query-params';

const NO_STORE = { 'Cache-Control': 'no-store' };

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;

  const limitParam = searchParams.get('limit');
  const offsetParam = searchParams.get('offset');

  // 保留「未传则为 undefined(返回全部)」语义: 仅在显式传参时解析校验。
  let limit: number | undefined;
  if (limitParam != null && limitParam !== '') {
    const p = parseIntParam(limitParam, { fallback: 6, min: 1, max: 100, name: 'limit' });
    if (!p.ok) return NextResponse.json({ error: p.error }, { status: 400 });
    limit = p.value;
  }
  let offset: number | undefined;
  if (offsetParam != null && offsetParam !== '') {
    const p = parseIntParam(offsetParam, { fallback: 0, min: 0, max: 10_000_000, name: 'offset' });
    if (!p.ok) return NextResponse.json({ error: p.error }, { status: 400 });
    offset = p.value;
  }

  // 过滤参数: 空串按「不过滤」处理, 长度设上限避免超长 LIKE 拖库。
  // `all` / 空串的归一收在 `db.normalizeTypeFilter` 单一来源（route 只透传原始值），
  // 避免「一个端点认得 all、另一个把它当类型值查」。
  const typeRaw = searchParams.get('type');
  const qRaw = searchParams.get('q');
  if (typeRaw != null && typeRaw.length > 64) {
    return NextResponse.json({ error: 'type is too long' }, { status: 400 });
  }
  if (qRaw != null && qRaw.length > 200) {
    return NextResponse.json({ error: 'q is too long' }, { status: 400 });
  }
  const filter = {
    type: typeRaw ?? undefined,
    q: qRaw ? qRaw : undefined,
  };

  try {
    const result = getMonthSummaries(limit, offset, filter);
    if (Array.isArray(result)) {
      return NextResponse.json({ data: result }, { headers: NO_STORE });
    }
    return NextResponse.json({ data: result.data, total: result.total }, { headers: NO_STORE });
  } catch (error) {
    console.error('Error fetching month summaries:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500, headers: NO_STORE }
    );
  }
}

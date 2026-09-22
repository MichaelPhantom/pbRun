import { NextRequest, NextResponse } from 'next/server';
import { getInsight } from '@/app/lib/insight-service';
import { buildRunnerProfile, formatRunnerProfile } from '@/app/lib/runner-profile';
import {
  buildAnalysisRequestBody,
  buildGlobalCoachFollowupMessages,
  buildGlobalCoachMessages,
  getFreellmConfig,
  type ChatMessage,
  type GlobalCoachContext,
} from '@/app/lib/llm';
import { formatInsightForCoach } from '@/app/lib/insight-coach';
import { getDateRangeFromDays, parseTimeRangeDays } from '@/app/lib/date-utils';
import { parseDateParam } from '@/app/lib/query-params';
import { getActivities } from '@/app/lib/db';

export const dynamic = 'force-dynamic';

/**
 * POST /api/insight/coach —— 全局 AI 教练 (跨全部历史数据)。
 *
 * Body (JSON, 可选):
 *  - model: 模型 id (默认 auto)
 *  - question: 追问内容 (有则为多轮)
 *  - history: 历史对话 [{role,content}]
 *  - days: 30|90|180 (默认 90)
 *  - startDate/endDate: 显式区间
 *
 * 返回 SSE 流 (与单活动分析一致)。
 */
export async function POST(request: NextRequest) {
  const cfg = getFreellmConfig();
  if (!cfg) {
    return NextResponse.json(
      { error: 'AI 分析未配置 (缺少 freellmapi 凭证)' },
      { status: 503 },
    );
  }

  let model = 'auto';
  let question = '';
  let history: ChatMessage[] = [];
  let days = 90;
  let startDate: string | undefined;
  let endDate: string | undefined;

  try {
    const body = await request.json();
    if (body && typeof body.model === 'string' && body.model.length <= 64) model = body.model;
    if (body && typeof body.question === 'string') question = body.question.trim();
    if (body && Array.isArray(body.history)) history = body.history as ChatMessage[];
    if (body && body.days != null) days = parseTimeRangeDays(String(body.days));
    const sd = parseDateParam(body?.startDate ?? null, 'startDate');
    const ed = parseDateParam(body?.endDate ?? null, 'endDate');
    if (sd.ok && sd.value) startDate = sd.value;
    if (ed.ok && ed.value) endDate = ed.value;
  } catch {
    // 无 body 或非 JSON, 用默认
  }

  if (!startDate || !endDate) {
    const range = getDateRangeFromDays(parseTimeRangeDays(String(days)));
    startDate = range.startDate;
    endDate = range.endDate;
  }

  // 构建全局教练上下文
  let ctx: GlobalCoachContext;
  try {
    const insight = getInsight({ startDate, endDate });

    // 跑者画像: 取最近一次活动作为"排除基准", 以便画像覆盖全历史
    let profileBlock = '';
    try {
      const recent = getActivities({ page: 1, limit: 1 });
      if (recent.data.length > 0) {
        profileBlock = formatRunnerProfile(buildRunnerProfile(recent.data[0]));
      }
    } catch {
      profileBlock = '';
    }

    ctx = {
      profileBlock,
      insightBlock: formatInsightForCoach(insight),
      rangeLabel: `${startDate} ~ ${endDate}`,
    };
  } catch (error) {
    console.error('Error building global coach context:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }

  const messages = question
    ? buildGlobalCoachFollowupMessages(ctx, history, question)
    : buildGlobalCoachMessages(ctx);

  const primaryBody = buildAnalysisRequestBody(model, messages, 4500);

  const { baseUrl, key } = cfg;
  async function tryUpstream(body: unknown): Promise<Response> {
    return fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120000),
    });
  }

  let upstream: Response | null = null;
  let usedModel = model;
  let fallback = false;
  try {
    upstream = await tryUpstream(primaryBody);
  } catch {
    upstream = null;
  }

  const isRateLimited = upstream?.status === 429;
  const primaryFailedRetryable = !upstream || (upstream.status >= 500 && !upstream.ok) || isRateLimited;
  if (primaryFailedRetryable && model !== 'auto') {
    if (isRateLimited) await new Promise((r) => setTimeout(r, 800));
    try {
      const retry = await tryUpstream(buildAnalysisRequestBody('auto', messages, 4500));
      if (retry.ok && retry.body) {
        upstream = retry;
        usedModel = 'auto';
        fallback = true;
      }
    } catch {
      // 保留主错误
    }
  }

  if (!upstream || !upstream.ok || !upstream.body) {
    const detail = upstream ? await upstream.text().catch(() => '') : 'freellmapi 不可达或 120s 超时';
    const status = upstream?.status ?? 502;
    const error =
      status === 429
        ? '模型暂受限流，请稍后重试或切换其他模型'
        : `上游错误 ${upstream?.status ?? 'TIMEOUT'}`;
    return NextResponse.json(
      { error, detail: detail.slice(0, 300) },
      { status: status < 500 && status !== 429 ? status : 502 },
    );
  }

  const headers: Record<string, string> = {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'X-Accel-Buffering': 'no',
  };
  if (fallback) {
    headers['X-Model-Fallback'] = '1';
    headers['X-Model-Requested'] = model;
    headers['X-Model-Used'] = usedModel;
  }
  return new Response(upstream.body, { headers });
}

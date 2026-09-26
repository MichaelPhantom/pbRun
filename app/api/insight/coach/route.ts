import { NextRequest, NextResponse } from 'next/server';
import { getInsight } from '@/app/lib/insight-service';
import { buildRunnerProfile, formatRunnerProfile } from '@/app/lib/runner-profile';
import {
  buildGlobalCoachFollowupMessages,
  buildGlobalCoachMessages,
  getFreellmConfig,
  type ChatMessage,
  type GlobalCoachContext,
} from '@/app/lib/llm';
import { runCoachStream } from '@/app/lib/coach-stream';
import { DEFAULT_MODEL, resolveRequestedModel } from '@/app/lib/model-curation';
import { formatInsightForCoach } from '@/app/lib/insight-coach';
import { getDateRangeFromDays, parseTimeRangeDays } from '@/app/lib/date-utils';
import { parseDateParam } from '@/app/lib/query-params';
import { getActivities } from '@/app/lib/db';

export const dynamic = 'force-dynamic';

/**
 * POST /api/insight/coach —— 全局 AI 教练 (跨全部历史数据)。
 *
 * Body (JSON, 可选):
 *  - model: 模型 id (默认 deepseek-v4.1-flash-wb; 只接受白名单值)
 *  - question: 追问内容 (有则为多轮)
 *  - history: 历史对话 [{role,content}]
 *  - days: 30|90|180 (默认 90)
 *  - startDate/endDate: 显式区间
 *
 * 返回 SSE 流 (与单活动分析一致); 调用策略见 app/lib/coach-stream.ts。
 */
export async function POST(request: NextRequest) {
  const cfg = getFreellmConfig();
  if (!cfg) {
    return NextResponse.json(
      { error: 'AI 分析未配置 (缺少 freellmapi 凭证)' },
      { status: 503 },
    );
  }

  let model = DEFAULT_MODEL;
  let question = '';
  let history: ChatMessage[] = [];
  let days = 90;
  let startDate: string | undefined;
  let endDate: string | undefined;

  try {
    const body = await request.json();
    model = resolveRequestedModel(body?.model);
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

  return runCoachStream({
    baseUrl: cfg.baseUrl,
    key: cfg.key,
    model,
    messages,
    maxTokens: 4500,
    clientSignal: request.signal,
  });
}

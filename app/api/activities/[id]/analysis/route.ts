/**
 * POST /api/activities/:id/analysis
 * 基于本次活动数据 (配速/心率/步频/VDOT/分段) 与【跑者画像】调用本机 freellm
 * 生成 AI 教练分析, 以 SSE 流式返回 (透传 freellmapi 的 OpenAI 兼容流)。
 *
 * Body:
 *   { model?: string }                                 初次分析 (默认 auto)
 *   { model?: string, question: string, history: [] }  追加追问 (多轮对话)
 * 凭证 (FREELLMAPI_KEY) 在 .env, 不入库; 服务端持密钥, 浏览器只与本路由通信。
 */
import { NextRequest, NextResponse } from 'next/server';
import { getActivityById, getActivityLaps } from '@/app/lib/db';
import {
  buildAnalysisMessages,
  buildAnalysisRequestBody,
  buildFollowupMessages,
  getFreellmConfig,
  type ChatMessage,
} from '@/app/lib/llm';
import { buildRunnerProfile, formatRunnerProfile } from '@/app/lib/runner-profile';

export const dynamic = 'force-dynamic';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const activityId = parseInt(id, 10);
  if (Number.isNaN(activityId)) {
    return NextResponse.json({ error: 'Invalid activity ID' }, { status: 400 });
  }

  const activity = getActivityById(activityId);
  if (!activity) {
    return NextResponse.json({ error: 'Activity not found' }, { status: 404 });
  }
  const laps = getActivityLaps(activityId);

  const cfg = getFreellmConfig();
  if (!cfg) {
    return NextResponse.json({ error: 'AI 分析未配置 (缺少 freellmapi 凭证)' }, { status: 503 });
  }

  let model = 'auto';
  let question = '';
  let history: ChatMessage[] = [];
  try {
    const body = await request.json();
    if (body && typeof body.model === 'string' && body.model.length <= 64) {
      model = body.model;
    }
    if (body && typeof body.question === 'string') {
      question = body.question.trim();
    }
    if (body && Array.isArray(body.history)) {
      history = body.history as ChatMessage[];
    }
  } catch {
    // 无 body 或非 JSON, 用默认模型
  }

  // 跑者画像（长期基础 + 近期状态；内部吞错降级，失败时为空串，不阻塞主流程）。
  const profileBlock = formatRunnerProfile(buildRunnerProfile(activity));
  // 有 question → 多轮追问 (保留 system+活动数据+历史); 否则初次分析。
  const messages = question
    ? buildFollowupMessages(activity, laps, profileBlock, history, question)
    : buildAnalysisMessages(activity, laps, profileBlock);

  // 请求体由 buildAnalysisRequestBody 构造：思考模型自动加
  // reasoning_effort low（否则 reasoning 占满预算致 length 截断）；
  // 非思考模型不加（该参数会诱发其输出思考过程）。上限见 llm.ts 注释。
  const primaryBody = buildAnalysisRequestBody(model, messages);

  // 上游单次调用（120s 超时；wb/shim 实测 P99 < 30s，120s 仅防挂死）。
  const { baseUrl, key } = cfg;
  async function tryUpstream(body: unknown): Promise<Response> {
    return fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
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
    upstream = null; // 不可达/超时：下沉到 fallback 逻辑统一处理
  }

  // 主模型失败时的回退策略:
  // - 5xx/超时/不可达 (非 auto): 用 auto 路由择优重试 (auto 会自动避开故障模型)。
  // - 429 限流: 先短暂等待重试一次同一 auto (限流多为瞬时), 仍失败则透传。
  // - 4xx (参数/模型名错误): 不重试, 重试必然失败。
  const isRateLimited = upstream?.status === 429;
  const primaryFailedRetryable = !upstream || (upstream.status >= 500 && !upstream.ok) || isRateLimited;
  if (primaryFailedRetryable && model !== 'auto') {
    if (isRateLimited) {
      // 限流: 等待 ~800ms 让上游冷却, 再用 auto 重试
      await new Promise((r) => setTimeout(r, 800));
    }
    try {
      const retry = await tryUpstream(buildAnalysisRequestBody('auto', messages));
      if (retry.ok && retry.body) {
        upstream = retry;
        usedModel = 'auto';
        fallback = true;
      }
    } catch {
      // 保留主错误，下沉统一返回
    }
  }

  if (!upstream || !upstream.ok || !upstream.body) {
    const detail = upstream
      ? await upstream.text().catch(() => '')
      : 'freellmapi 不可达或 120s 超时';
    const status = upstream?.status ?? 502;
    // 限流: 给出可操作提示 (切换模型/稍后重试), 而非仅透传上游 JSON。
    const error =
      status === 429
        ? '模型暂受限流，请稍后重试或切换其他模型'
        : `上游错误 ${upstream?.status ?? 'TIMEOUT'}`;
    return NextResponse.json(
      { error, detail: detail.slice(0, 300) },
      { status: status < 500 && status !== 429 ? status : 502 },
    );
  }

  // 透传上游 SSE 流 (OpenAI 兼容: data: {delta} ... data: [DONE])
  const headers: Record<string, string> = {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'X-Accel-Buffering': 'no', // 经 Nginx 时禁用缓冲, 保证流式
  };
  if (fallback) {
    // X-Model-Fallback 是前端判定「已自动回退」的契约头 (见 AiAnalysis.tsx);
    // X-Model-Requested/Used 仅作可观测性辅助。
    headers['X-Model-Fallback'] = '1';
    headers['X-Model-Requested'] = model;
    headers['X-Model-Used'] = usedModel;
  }
  return new Response(upstream.body, { headers });
}

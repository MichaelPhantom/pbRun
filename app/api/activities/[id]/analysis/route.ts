/**
 * POST /api/activities/:id/analysis
 * 基于本次活动数据 (配速/心率/步频/VDOT/分段) 与【跑者画像】调用本机 freellm
 * 生成 AI 教练分析, 以 SSE 流式返回 (透传 freellmapi 的 OpenAI 兼容流)。
 *
 * Body:
 *   { model?: string }                                 初次分析 (默认 deepseek-v4.1-flash-wb)
 *   { model?: string, question: string, history: [] }  追加追问 (多轮对话)
 * model 只接受白名单值 (model-curation), 非法值清洗为默认模型。
 * 凭证 (FREELLMAPI_KEY) 在 .env, 不入库; 服务端持密钥, 浏览器只与本路由通信。
 *
 * 调用策略 (回退/首字节看门狗/断开传播) 见 app/lib/coach-stream.ts。
 */
import { NextRequest, NextResponse } from 'next/server';
import { getActivityById, getActivityLaps } from '@/app/lib/db';
import {
  buildAnalysisMessages,
  buildFollowupMessages,
  getFreellmConfig,
  type ChatMessage,
} from '@/app/lib/llm';
import { runCoachStream } from '@/app/lib/coach-stream';
import { DEFAULT_MODEL, resolveRequestedModel } from '@/app/lib/model-curation';
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

  let model = DEFAULT_MODEL;
  let question = '';
  let history: ChatMessage[] = [];
  try {
    const body = await request.json();
    model = resolveRequestedModel(body?.model);
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

  return runCoachStream({
    baseUrl: cfg.baseUrl,
    key: cfg.key,
    model,
    messages,
    clientSignal: request.signal,
  });
}

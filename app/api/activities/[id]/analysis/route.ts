/**
 * POST /api/activities/:id/analysis
 * 基于本次活动数据 (配速/心率/步频/VDOT/分段) 调用本机 freellm 生成 AI 教练分析,
 * 以 SSE 流式返回 (透传 freellmapi 的 OpenAI 兼容流)。
 *
 * Body: { model?: string }  默认 "auto" (路由器择优)。
 * 凭证 (FREELLMAPI_KEY) 在 .env, 不入库; 服务端持密钥, 浏览器只与本路由通信。
 */
import { NextRequest, NextResponse } from 'next/server';
import { getActivityById, getActivityLaps } from '@/app/lib/db';
import { buildAnalysisMessages, getFreellmConfig } from '@/app/lib/llm';

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
  try {
    const body = await request.json();
    if (body && typeof body.model === 'string' && body.model.length <= 64) {
      model = body.model;
    }
  } catch {
    // 无 body 或非 JSON, 用默认模型
  }

  const messages = buildAnalysisMessages(activity, laps);

  let upstream: Response;
  try {
    upstream = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cfg.key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages,
        stream: true,
        temperature: 0.5,
        max_tokens: 1400,
      }),
    });
  } catch {
    return NextResponse.json({ error: 'freellmapi 不可达' }, { status: 502 });
  }

  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text().catch(() => '');
    return NextResponse.json(
      { error: `上游错误 ${upstream.status}`, detail: detail.slice(0, 300) },
      { status: 502 },
    );
  }

  // 透传上游 SSE 流 (OpenAI 兼容: data: {delta} ... data: [DONE])
  return new Response(upstream.body, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no', // 经 Nginx 时禁用缓冲, 保证流式
    },
  });
}

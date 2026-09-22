/**
 * GET /api/llm/models
 * 代理 freellmapi 可用模型列表 (服务端持密钥, 客户端不接触凭证)。
 * configured = 凭证是否就绪; models 可能为空 (拉取失败时), 客户端仍可用默认 auto。
 */
import { NextResponse } from 'next/server';
import { fetchModels, getFreellmConfig } from '@/app/lib/llm';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const configured = !!getFreellmConfig();
    const models = await fetchModels();
    return NextResponse.json(
      { models, configured },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    console.error('Error fetching LLM models:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}

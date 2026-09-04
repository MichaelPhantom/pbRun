/**
 * GET /api/llm/models
 * 代理 freellmapi 可用模型列表 (服务端持密钥, 客户端不接触凭证)。
 * configured = 凭证是否就绪; models 可能为空 (拉取失败时), 客户端仍可用默认 auto。
 */
import { NextResponse } from 'next/server';
import { fetchModels, getFreellmConfig } from '@/app/lib/llm';

export const dynamic = 'force-dynamic';

export async function GET() {
  const configured = !!getFreellmConfig();
  const models = await fetchModels();
  return NextResponse.json({ models, configured });
}

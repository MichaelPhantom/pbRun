/**
 * AI 教练分析的失败提示文案（纯函数，可单测）。
 *
 * 背景（2026-09 实测）：
 * - 部分渠道走本机网关的 shim，凭证缺失/上游抖动时接口返回 502（上游错误）/
 *   503（未配置）；此时换一个模型（非思考模型更稳）通常即恢复。
 * - 思考模型的 reasoning 会占用 max_tokens 预算，预算耗尽时输出以
 *   finish_reason=length 截断；选非思考模型可从根上避免。
 */

/** 将分析接口的失败翻译为用户可操作的一句话提示。 */
export function friendlyAnalysisError(
  status: number,
  serverError?: string,
  detail?: string,
): string {
  const d = (detail ?? '').trim().slice(0, 120);
  const tail = d ? `：${d}` : '';
  if (status === 504) {
    return '分析超时（上游长时间无响应），请稍后重试或切换模型';
  }
  if (status === 429) {
    return '模型暂受限流，请稍后重试或切换其他模型';
  }
  if (status === 502 || status === 503) {
    return `分析通道故障${serverError ? `（${serverError}）` : ''}，建议切换其他模型后重试（非思考模型更稳，如 Gemini 3.5 Flash Lite）${tail}`;
  }
  if (serverError) return d ? `${serverError}${tail}` : serverError;
  return `HTTP ${status}${tail}`;
}

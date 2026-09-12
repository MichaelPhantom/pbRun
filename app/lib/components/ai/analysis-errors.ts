/**
 * AI 教练分析的失败提示文案（纯函数，可单测）。
 *
 * 背景（2026-09 实测）：
 * - `*-juzi` 系与部分 `-wb` 思考模型走本机网关的 shim 渠道，凭证缺失/上游抖动时
 *   接口返回 502（上游错误）/503（未配置）；此时换 auto 或非思考模型
 *   （如 glm-5.1-wb）通常即恢复。
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
  if (status === 502 || status === 503) {
    return `分析通道故障${serverError ? `（${serverError}）` : ''}，建议切换模型为 auto 或 glm-5.1-wb（非思考模型，更稳定）后重试${tail}`;
  }
  if (serverError) return d ? `${serverError}${tail}` : serverError;
  return `HTTP ${status}${tail}`;
}

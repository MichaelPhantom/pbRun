/**
 * 逐秒记录降采样 (app 与 mcp-server 共用)。
 * 优先 samplingInterval, 结果超过 maxPoints 时自动加大步长。
 * - 自动放大步长 (truncated=true) 时按等距采样并**强制包含首末点**, 避免尾部极值
 *   (如最大心率/冲刺段) 丢失;
 * - truncated 标志供使用方识别 "未拿到全量", 需要秒级全量时提高 maxPoints。
 */
export function downsampleRecords<T>(
  records: T[],
  samplingInterval: number,
  maxPoints: number
): {
  records: T[];
  total_original: number;
  sampled: number;
  step: number;
  truncated: boolean;
} {
  const total = records.length;
  if (total === 0) {
    return { records: [], total_original: 0, sampled: 0, step: 1, truncated: false };
  }
  let step = Math.max(1, samplingInterval);
  const truncated = Math.ceil(total / step) > maxPoints;
  if (truncated) {
    // 预留首末两个点位, 中间按 (maxPoints-2) 等距 —— 保证结果**不超过** maxPoints
    // (原实现 append 末点后会得到 maxPoints+1, 与文档"最多 maxPoints"矛盾)。
    step = Math.max(1, Math.ceil((total - 1) / Math.max(1, maxPoints - 1)));
  }
  let sampled: T[];
  if (step === 1) {
    sampled = records;
  } else {
    sampled = records.filter((_, i) => i % step === 0);
    const lastRecord = records[total - 1];
    if (sampled[sampled.length - 1] !== lastRecord) {
      // 若追加末点会超限, 先移除倒数第二个采样点再追加, 保持 <= maxPoints
      if (sampled.length >= maxPoints) sampled.pop();
      sampled.push(lastRecord);
    }
  }
  return { records: sampled, total_original: total, sampled: sampled.length, step, truncated };
}

/**
 * 活动内温度漂移 —— 由逐秒温度记录比较起跑/结束阶段。
 *
 * 目的：同一次跑步中，气温上升 5°C 会让后程心率明显上漂，单看平均温度
 * 无法解释「前半程轻松、后半程吃力」。温度传感器缺失时返回 null。
 *
 * 纯函数，无 DB 依赖。
 */

import type { RecordSample } from './insight';
import type { TemperatureDrift } from './types';

export type { TemperatureDrift } from './types';

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * 计算温度漂移。前后各取 10% 采样（至少 1 个）求均值；
 * 少于 2 个有效温度点返回 null。
 */
export function computeTemperatureDrift(
  records: RecordSample[],
): TemperatureDrift | null {
  const temps = records
    .filter((r) => r.temperature != null && Number.isFinite(r.temperature))
    .map((r) => r.temperature as number);
  if (temps.length < 2) return null;

  const window = Math.max(1, Math.floor(temps.length * 0.1));
  const start = mean(temps.slice(0, window));
  const end = mean(temps.slice(-window));
  if (start == null || end == null) return null;

  return {
    startC: Math.round(start * 10) / 10,
    endC: Math.round(end * 10) / 10,
    deltaC: Math.round((end - start) * 10) / 10,
    minC: Math.round(Math.min(...temps) * 10) / 10,
    maxC: Math.round(Math.max(...temps) * 10) / 10,
    sampleCount: temps.length,
  };
}

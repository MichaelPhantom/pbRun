/**
 * 单次活动的环境可比性 —— 温度 / 爬升 / 同温档表现。
 *
 * 配速与心率对气温、爬升高度非常敏感：同一配速在 32°C 与 18°C 下的心率可差
 * 10–20bpm。单次 AI 分析若只做同路线/同距离对比而不标注环境差异，容易把
 * 「天气更热」误判为「能力下降」。本模块把这类可比性差异量化后注入 prompt。
 *
 * 纯函数，无 DB 依赖。
 */

import { weatherBucketOf } from './insight-compare';
import type {
  ActivityEnvironmentSummary,
  EnvironmentCurrent,
  EnvironmentPeer,
  TemperatureBandSummary,
} from './types';

export type {
  ActivityEnvironmentSummary,
  EnvironmentCurrent,
  EnvironmentPeer,
  TemperatureBandSummary,
} from './types';

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function finite(v: number | null | undefined): v is number {
  return v != null && Number.isFinite(v);
}

/**
 * 汇总同距离样本的环境差异 + 同温档表现。
 * 无任何温湿度/爬升数据时返回 null（调用方直接省略该段）。
 */
export function summarizeActivityEnvironment(
  current: EnvironmentCurrent,
  peers: EnvironmentPeer[],
): ActivityEnvironmentSummary | null {
  if (peers.length === 0) return null;

  const peerTemps = peers.map((p) => p.temperatureC).filter(finite);
  const peerAscents = peers.map((p) => p.ascentM).filter(finite);
  const currentTempC = finite(current.temperatureC) ? current.temperatureC : null;
  const currentAscentM = finite(current.ascentM) ? current.ascentM : null;

  if (
    peerTemps.length === 0 &&
    peerAscents.length === 0 &&
    currentTempC == null &&
    currentAscentM == null
  ) {
    return null;
  }

  const peerAvgTempC = mean(peerTemps);
  const peerAvgAscentM = mean(peerAscents);

  let tempBand: TemperatureBandSummary | null = null;
  const label = currentTempC != null ? weatherBucketOf(currentTempC) : null;
  if (label) {
    const bandPeers = peers.filter(
      (p) => p.temperatureC != null && weatherBucketOf(p.temperatureC) === label,
    );
    if (bandPeers.length > 0) {
      const paces = bandPeers
        .map((p) => p.paceSecPerKm)
        .filter((v): v is number => finite(v) && v > 0);
      const hrs = bandPeers
        .map((p) => p.heartRate)
        .filter((v): v is number => finite(v) && v > 0);
      const avgPace = mean(paces);
      const avgHr = mean(hrs);
      const currentPace = finite(current.paceSecPerKm) && current.paceSecPerKm > 0
        ? current.paceSecPerKm
        : null;
      const currentHr = finite(current.heartRate) && current.heartRate > 0
        ? current.heartRate
        : null;
      const rank = currentPace != null
        ? {
            byPace: paces.filter((p) => p < currentPace).length + 1,
            total: paces.length + 1,
          }
        : null;
      tempBand = {
        label,
        count: bandPeers.length + 1,
        peerCount: bandPeers.length,
        avgPaceSecPerKm: avgPace,
        avgHeartRate: avgHr,
        rank,
        paceDeltaSecPerKm:
          currentPace != null && avgPace != null ? currentPace - avgPace : null,
        hrDeltaBpm: currentHr != null && avgHr != null ? currentHr - avgHr : null,
      };
    }
  }

  return {
    peerCount: peers.length,
    currentTempC,
    peerAvgTempC,
    tempDeltaC:
      currentTempC != null && peerAvgTempC != null ? currentTempC - peerAvgTempC : null,
    currentAscentM,
    peerAvgAscentM,
    ascentDeltaM:
      currentAscentM != null && peerAvgAscentM != null
        ? currentAscentM - peerAvgAscentM
        : null,
    tempBand,
  };
}

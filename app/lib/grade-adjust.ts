/**
 * 海拔/坡度修正 —— 等价平路配速（Grade Adjusted Pace, GAP）。
 *
 * 使用 Minetti et al. (2002) 的跑步能量成本多项式：
 *   Cr(i) = 155.4i⁵ − 30.4i⁴ − 43.3i³ + 46.3i² + 19.5i + 3.6   (J·kg⁻¹·m⁻¹)
 * 其中 i 为坡度（上升米 / 水平米）。相同代谢功率下，坡度 i 的等价平路距离：
 *   d_flat = d × Cr(i) / Cr(0)
 * 因此等价平路配速 = 实际配速 × 实际距离 / 等价平路距离。
 *
 * 这是一个**估算模型**，用于横向可比，不替代功率计/实测。坡度截断到 ±30%，
 * 避免 GPS/气压计噪声导致极端值。纯函数，无 DB 依赖。
 */

import type { RecordSample } from './insight';
import type { GradeAdjustedPace } from './types';

export type { GradeAdjustedPace } from './types';

const MINETTI_MAX_GRADE = 0.3;
const FLAT_COST = 3.6;

function clampGrade(grade: number): number {
  if (!Number.isFinite(grade)) return 0;
  return Math.max(-MINETTI_MAX_GRADE, Math.min(MINETTI_MAX_GRADE, grade));
}

/** Minetti 跑步能量成本 (J/kg/m)。 */
export function minettiCost(grade: number): number {
  const i = clampGrade(grade);
  const c =
    155.4 * i ** 5 -
    30.4 * i ** 4 -
    43.3 * i ** 3 +
    46.3 * i ** 2 +
    19.5 * i +
    FLAT_COST;
  return Math.max(0.5, c);
}

export interface GradeAdjustedOptions {
  /** 活动官方平均配速；缺省时用记录时间/距离推算 */
  actualPaceSecPerKm?: number | null;
}

/**
 * 由逐秒记录估算等价平路配速。记录不足（<5 段有效海拔变化或 <500m）返回 null。
 */
export function gradeAdjustedPace(
  records: RecordSample[],
  opts: GradeAdjustedOptions = {},
): GradeAdjustedPace | null {
  if (records.length < 2) return null;

  let actualDistance = 0;
  let actualTime = 0;
  let flatDistance = 0;
  let ascent = 0;
  let samples = 0;

  for (let i = 1; i < records.length; i++) {
    const prev = records[i - 1];
    const cur = records[i];
    if (
      prev.distance == null ||
      cur.distance == null ||
      prev.altitude == null ||
      cur.altitude == null ||
      prev.elapsed_sec == null ||
      cur.elapsed_sec == null
    ) {
      continue;
    }
    // activity_records.distance 为公里 (fit-parser lengthUnit=km)
    const dDistM = (cur.distance - prev.distance) * 1000;
    const dt = cur.elapsed_sec - prev.elapsed_sec;
    // 过滤 GPS 跳变/暂停/超长采样间隔
    if (!Number.isFinite(dDistM) || dDistM <= 0.5 || dDistM > 1000) continue;
    if (!Number.isFinite(dt) || dt <= 0 || dt > 300) continue;

    const dAlt = cur.altitude - prev.altitude;
    const grade = clampGrade(dAlt / dDistM);
    const cost = minettiCost(grade);
    actualDistance += dDistM;
    actualTime += dt;
    flatDistance += dDistM * (cost / FLAT_COST);
    if (dAlt > 0) ascent += dAlt;
    samples += 1;
  }

  if (samples < 5 || actualDistance < 500 || flatDistance <= 0) return null;

  const actualPace =
    opts.actualPaceSecPerKm != null && opts.actualPaceSecPerKm > 0
      ? opts.actualPaceSecPerKm
      : actualTime / (actualDistance / 1000);
  if (!Number.isFinite(actualPace) || actualPace <= 0) return null;

  const equivalentPace = actualPace * (actualDistance / flatDistance);
  return {
    equivalentPaceSecPerKm: Math.round(equivalentPace * 10) / 10,
    actualPaceSecPerKm: Math.round(actualPace * 10) / 10,
    deltaSecPerKm: Math.round((equivalentPace - actualPace) * 10) / 10,
    distanceMeters: Math.round(actualDistance),
    ascentPerKm: Math.round((ascent / (actualDistance / 1000)) * 10) / 10,
    sampleCount: samples,
    model: 'minetti-2002',
  };
}

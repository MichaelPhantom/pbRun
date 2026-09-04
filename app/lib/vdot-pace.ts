/**
 * VDOT 与配速区间换算（基于 Jack Daniels 公式）
 * VO2 = -4.60 + 0.182258*v + 0.000104*v²，v 为米/分钟
 * 由 VDOT * %VO2max = VO2(v) 反解 v，再得配速 秒/公里 = 60000/v
 */

/** 给定 VDOT 与 %VO2max（0-1），返回该强度下的配速（秒/公里） */
export function vdotToPaceSecPerKm(vdot: number, percentVo2max: number): number {
  if (vdot <= 0 || percentVo2max <= 0 || percentVo2max > 1) return 9999;
  const c = 4.60 + vdot * percentVo2max;
  const disc = 0.182258 ** 2 + 4 * 0.000104 * c;
  if (disc < 0) return 9999;
  const v = (-0.182258 + Math.sqrt(disc)) / (2 * 0.000104);
  if (v <= 0) return 9999;
  return 60000 / v; // 秒/公里
}

/** Z1-Z5 对应的 %VO2max（Daniels: E≈59-74%, M≈75-84%, T≈83-92%, I≈95-100%） */
const ZONE_PERCENT: Record<number, number> = {
  1: 0.65,  // Z1 轻松 ≈ E 低端
  2: 0.72,  // Z2 有氧 ≈ E 高端
  3: 0.80,  // Z3 节奏 ≈ M
  4: 0.88,  // Z4 乳酸阈 ≈ T
  5: 0.98,  // Z5 Vo2max ≈ I
};

/** 根据当前跑力 VDOT 计算 Z1-Z5 的目标配速区间 [paceMin, paceMax]（秒/公里），用于将 lap 归入某区 */
export function getPaceZoneBoundsFromVdot(vdot: number): Record<number, { paceMin: number; paceMax: number }> {
  if (vdot <= 0) return {};
  const paces: number[] = [];
  for (let z = 1; z <= 5; z++) {
    const p = ZONE_PERCENT[z] ?? 0.8;
    paces.push(vdotToPaceSecPerKm(vdot, p));
  }
  // paces[0]=Z1(最慢), paces[4]=Z5(最快)。边界取中点，Z1 上限无穷
  const bounds: Record<number, { paceMin: number; paceMax: number }> = {};
  bounds[1] = { paceMin: (paces[0] + paces[1]) / 2, paceMax: 9999 };
  bounds[2] = { paceMin: (paces[1] + paces[2]) / 2, paceMax: (paces[0] + paces[1]) / 2 };
  bounds[3] = { paceMin: (paces[2] + paces[3]) / 2, paceMax: (paces[1] + paces[2]) / 2 };
  bounds[4] = { paceMin: (paces[3] + paces[4]) / 2, paceMax: (paces[2] + paces[3]) / 2 };
  bounds[5] = { paceMin: 0, paceMax: (paces[3] + paces[4]) / 2 };
  return bounds;
}

/** 返回 Z1-Z5 的中心配速（秒/公里），用于展示「该区间建议配速」 */
export function getPaceZoneCenterFromVdot(vdot: number): Record<number, number> {
  const out: Record<number, number> = {};
  for (let z = 1; z <= 5; z++) {
    out[z] = vdotToPaceSecPerKm(vdot, ZONE_PERCENT[z] ?? 0.8);
  }
  return out;
}

/*
 * 赛事预测 — Daniels VDOT 等价模型
 *
 * VDOT 本身由某次比赛成绩反算而得: VO2(v) = VDOT * frac(t),
 * 其中 v=d/t (米/分钟), VO2(v)=-4.6+0.182258v+0.000104v²,
 * frac(t) 为该时长可维持的 %VO2max (Daniels 经验曲线)。
 *
 * 预测另一距离时 VDOT 视为常量, 解 VO2(d/t) = VDOT*frac(t) 求 t。
 * f(t)=VO2(d/t)-VDOT*frac(t): t→0 时 v→∞→VO2→∞ (f>0);
 * t→∞ 时 v→0→VO2→-4.6, frac→0.8, f→-4.6-0.8*VDOT<0。
 * 故 f 单调递减 (VO2 关于 t 递减, frac 关于 t 递减), 唯一根, 二分法收敛。
 *
 * %VO2max-时长曲线 (Daniels, t 单位分钟):
 *   frac(t) = 0.8 + 0.1894398·e^(-0.012778·t) + 0.2989558·e^(-0.193055·t)
 *   (5K≈17min→96%, 10K≈35min→92%, 半马≈88%, 全马≈83.6%, 与 Daniels 表吻合)
 */
const _fracOf = (tMin: number) =>
  Math.min(1, 0.8 + 0.1894398 * Math.exp(-0.012778 * tMin) + 0.2989558 * Math.exp(-0.193055 * tMin));

const _vo2Of = (vMpm: number) => -4.6 + 0.182258 * vMpm + 0.000104 * vMpm * vMpm;

/** 给定 VDOT 与距离(米), 返回预测完赛秒数 (二分法, 单调递减根)。 */
export function predictRaceTimeSec(vdot: number, distanceMeters: number): number | null {
  if (vdot <= 0 || distanceMeters <= 0) return null;
  const f = (t: number) => _vo2Of(distanceMeters / t) - vdot * _fracOf(t);
  let lo = 0.5; // 30s 上限 (不可能更快, 保证 f(lo)>0)
  let hi = 480; // 8h 下限 (全马步行级, 保证 f(hi)<0)
  // 收敛区间内根 (f 单调递减)
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (f(mid) > 0) lo = mid;
    else hi = mid;
  }
  return ((lo + hi) / 2) * 60; // 秒
}

export interface RacePrediction {
  label: string;
  distanceMeters: number;
  seconds: number | null;
}

/** 5K / 10K / 半马 / 全马 预测完赛时间列表 (秒)。 */
export function predictRaceTimes(vdot: number): RacePrediction[] {
  return [
    { label: "5K", distanceMeters: 5000, seconds: predictRaceTimeSec(vdot, 5000) },
    { label: "10K", distanceMeters: 10000, seconds: predictRaceTimeSec(vdot, 10000) },
    { label: "半马", distanceMeters: 21097.5, seconds: predictRaceTimeSec(vdot, 21097.5) },
    { label: "全马", distanceMeters: 42195, seconds: predictRaceTimeSec(vdot, 42195) },
  ];
}

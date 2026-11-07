/**
 * 力量训练聚合口径（db 层）契约测试。
 *
 * 核心纪律：**负荷合并、里程/时长/次数不合并**。
 *  - `load` 相加：力量训练也是负荷，ACWR/CTL 必须看见它（否则每周 2 次力量课隐形）；
 *  - `distance` / `duration` / `runs` 只取跑步：`duration` 喂给「当月均配速」
 *    （Σduration / Σdistance），混入力量时长会把配速拖慢 —— 这正是 db.ts 大注释
 *    里用实测数字守住的线（369 → 989 s/km）。
 */
import {
  mergeStrengthIntoTrainingLoads,
  strengthLoadOf,
} from '@/app/lib/strength';
import type { TrainingLoadPoint } from '@/app/lib/types';

describe('mergeStrengthIntoTrainingLoads', () => {
  const runPoints: TrainingLoadPoint[] = [
    { date: '2026-11-01', load: 60, distance: 10000, duration: 3000, runs: 1 },
    { date: '2026-11-03', load: 40, distance: 5000, duration: 1800, runs: 1 },
  ];

  test('负荷相加, 里程/时长/次数只取跑步 (保护均配速口径)', () => {
    const merged = mergeStrengthIntoTrainingLoads(runPoints, [
      { date: '2026-11-01', load: 35, duration: 3600, sessions: 1, workingSets: 7 },
      { date: '2026-11-02', load: 25, duration: 1800, sessions: 1, workingSets: 5 },
    ]);

    const d1 = merged.find((p) => p.date === '2026-11-01')!;
    expect(d1.load).toBe(95); // 60 + 35
    expect(d1.distance).toBe(10000); // 未被力量污染
    expect(d1.duration).toBe(3000); // 未被力量污染 (否则均配速变慢)
    expect(d1.runs).toBe(1); // 力量课不计入跑步次数

    // 只有力量、没有跑步的日子也要出现 (否则该天负荷丢失)
    const d2 = merged.find((p) => p.date === '2026-11-02')!;
    expect(d2.load).toBe(25);
    expect(d2.distance).toBe(0);
    expect(d2.duration).toBe(0);
    expect(d2.runs).toBe(0);
  });

  test('按日期升序合并, 不改原数组', () => {
    const merged = mergeStrengthIntoTrainingLoads(runPoints, [
      { date: '2026-11-02', load: 25, duration: 1800, sessions: 1, workingSets: 5 },
    ]);
    expect(merged.map((p) => p.date)).toEqual(['2026-11-01', '2026-11-02', '2026-11-03']);
    expect(runPoints).toHaveLength(2); // 入参未被修改
  });

  test('无力量数据 → 与原始跑步序列完全一致 (零风险回归)', () => {
    expect(mergeStrengthIntoTrainingLoads(runPoints, [])).toEqual(runPoints);
  });

  test('无跑步数据 → 力量负荷独立成序列', () => {
    const merged = mergeStrengthIntoTrainingLoads([], [
      { date: '2026-11-02', load: 25, duration: 1800, sessions: 1, workingSets: 5 },
    ]);
    expect(merged).toEqual([
      { date: '2026-11-02', load: 25, distance: 0, duration: 0, runs: 0 },
    ]);
  });

  test('同一天多次力量课 → 负荷与次数累加', () => {
    const merged = mergeStrengthIntoTrainingLoads([], [
      { date: '2026-11-02', load: 20, duration: 1200, sessions: 1, workingSets: 4 },
      { date: '2026-11-02', load: 30, duration: 1800, sessions: 1, workingSets: 6 },
    ]);
    expect(merged).toEqual([{ date: '2026-11-02', load: 50, distance: 0, duration: 0, runs: 0 }]);
  });

  test('非法/空值兜底为 0, 不产生 NaN', () => {
    const merged = mergeStrengthIntoTrainingLoads(runPoints, [
      { date: '2026-11-04', load: NaN as unknown as number, duration: 0, sessions: 0, workingSets: 0 },
    ]);
    expect(merged.find((p) => p.date === '2026-11-04')!.load).toBe(0);
    for (const p of merged) {
      expect(Number.isFinite(p.load)).toBe(true);
      expect(Number.isFinite(p.distance)).toBe(true);
      expect(Number.isFinite(p.duration)).toBe(true);
      expect(Number.isFinite(p.runs)).toBe(true);
    }
  });
});

describe('strengthLoadOf (单条活动 → 负荷)', () => {
  test('从真实活动字段派生 (核心稳定性1: 3609s, TE 0.1)', () => {
    const load = strengthLoadOf({
      workout_name: '核心稳定性1',
      workout_steps: JSON.stringify(
        Array.from({ length: 14 }, (_, i) => ({
          duration_sec: i % 2 === 0 ? 40 : 20,
          intensity: i % 2 === 0 ? 'active' : 'rest',
        })),
      ),
      duration: 3609,
      moving_time: 3609,
      average_heart_rate: 73,
      total_training_effect: 0.1,
    });
    // 3609s = 1.0025h × 100 × 0.6(recovery) ≈ 60
    expect(load).toBe(60);
  });

  test('高强度循环按 TE 加权 (不会被压成 0)', () => {
    const load = strengthLoadOf({
      duration: 1920,
      moving_time: 1920,
      total_training_effect: 4.0,
      average_heart_rate: 120,
    });
    expect(load).toBe(80); // 0.5333h × 100 × 1.5
  });

  test('时长缺失 → 0', () => {
    expect(strengthLoadOf({})).toBe(0);
    expect(strengthLoadOf({ duration: 0, moving_time: 0 })).toBe(0);
  });
});

/**
 * 力量训练**汇总**（`summarizeStrengthSessions`）契约测试。
 *
 * 首页/分析页要展示的是「这一段时期我练了多少力量」——次数、时长、组数、
 * 强度域分布、负荷贡献。汇总逻辑必须在纯函数层做一次（两页共用），
 * 否则同一个「本月力量次数」在两张卡片里会各算一遍、各错一遍。
 *
 * 数据边界同 `app/lib/strength.ts`：**不输出重量/次数**（FIT 无 set 消息）。
 */
import { summarizeStrengthSessions } from '@/app/lib/strength';

const s = (over: Record<string, unknown> = {}) => ({
  planName: '全身循环1',
  workingSets: 7,
  restSets: 7,
  plannedSeconds: 420,
  workingSeconds: 280,
  restSeconds: 140,
  workRestRatio: 2,
  structure: 'intervals' as const,
  intensityDomain: 'base' as const,
  durationSeconds: 1800,
  load: 50,
  avgHeartRate: 110,
  aerobicEffect: 2,
  anaerobicEffect: 0,
  recoveryTimeMinutes: 600,
  ...over,
});

describe('summarizeStrengthSessions', () => {
  test('空列表 → 全零 + 分布为空, 不产生 NaN', () => {
    const r = summarizeStrengthSessions([]);
    expect(r.sessions).toBe(0);
    expect(r.totalSeconds).toBe(0);
    expect(r.avgSeconds).toBe(0);
    expect(r.workingSets).toBe(0);
    expect(r.totalLoad).toBe(0);
    expect(r.domains.base).toBe(0);
    expect(r.structures.intervals).toBe(0);
    expect(r.latestPlanName).toBeNull();
  });

  test('多次课: 时长/组数/负荷累加, 均值为整数分', () => {
    const r = summarizeStrengthSessions([
      s({ durationSeconds: 1800, load: 50, workingSets: 7 }),
      s({ durationSeconds: 2400, load: 40, workingSets: 9 }),
    ]);
    expect(r.sessions).toBe(2);
    expect(r.totalSeconds).toBe(4200);
    expect(r.avgSeconds).toBe(2100);
    expect(r.workingSets).toBe(16);
    expect(r.totalLoad).toBe(90);
  });

  test('强度域分布按次数计数 (含 unknown 不丢)', () => {
    const r = summarizeStrengthSessions([
      s({ intensityDomain: 'high' }),
      s({ intensityDomain: 'base' }),
      s({ intensityDomain: 'base' }),
      s({ intensityDomain: 'unknown' }),
    ]);
    expect(r.domains).toEqual({ recovery: 0, base: 2, tempo: 0, high: 1, unknown: 1 });
  });

  test('结构分布按次数计数', () => {
    const r = summarizeStrengthSessions([
      s({ structure: 'intervals' }),
      s({ structure: 'continuous' }),
      s({ structure: 'unknown' }),
      s({ structure: 'intervals' }),
    ]);
    expect(r.structures).toEqual({ intervals: 2, continuous: 1, unknown: 1 });
  });

  test('工作/休息时长合计 (画像里的 plannedSeconds 是「一轮」模板, 不能直接当实际)', () => {
    const r = summarizeStrengthSessions([
      s({ workingSeconds: 280, restSeconds: 140 }),
      s({ workingSeconds: 300, restSeconds: 150 }),
    ]);
    expect(r.workingSeconds).toBe(580);
    expect(r.restSeconds).toBe(290);
    // 总工作:休息比 = 580/290 = 2
    expect(r.workRestRatio).toBeCloseTo(2, 5);
  });

  test('无休息段 → workRestRatio 为 null (不除零)', () => {
    const r = summarizeStrengthSessions([s({ workingSeconds: 600, restSeconds: 0 })]);
    expect(r.workRestRatio).toBeNull();
  });

  test('最近一次计划名: 入参按时间倒序时取第一条', () => {
    const r = summarizeStrengthSessions([s({ planName: '核心稳定性1' }), s({ planName: '全身循环2' })]);
    expect(r.latestPlanName).toBe('核心稳定性1');
  });

  test('计划名缺失/空串 → 回落 null (不展示空白标题)', () => {
    expect(summarizeStrengthSessions([s({ planName: null })]).latestPlanName).toBeNull();
    expect(summarizeStrengthSessions([s({ planName: '   ' })]).latestPlanName).toBeNull();
  });

  test('非法数值兜底为 0, 不污染汇总', () => {
    const r = summarizeStrengthSessions([
      s({ durationSeconds: NaN, load: NaN, workingSets: NaN }),
      s({ durationSeconds: 1800, load: 50, workingSets: 7 }),
    ]);
    expect(r.totalSeconds).toBe(1800);
    expect(r.totalLoad).toBe(50);
    expect(r.workingSets).toBe(7);
    expect(r.sessions).toBe(2);
    for (const v of [r.totalSeconds, r.avgSeconds, r.totalLoad, r.workingSets, r.workingSeconds]) {
      expect(Number.isFinite(v)).toBe(true);
    }
  });

  test('实际总时长 vs 计划时长: 计划是一轮模板, 汇总只累计实际时长', () => {
    // 真实库「核心稳定性1」: plannedSeconds 420, 实际 3609 —— 课表是一轮模板,
    // 用户做了多轮。汇总绝不能把 plannedSeconds 当实际时长。
    const r = summarizeStrengthSessions([s({ plannedSeconds: 420, durationSeconds: 3609 })]);
    expect(r.totalSeconds).toBe(3609);
    expect(r.avgSeconds).toBe(3609);
  });
});

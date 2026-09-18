/**
 * @jest-environment node
 *
 * followup-suggestions 单测 — 上下文相关的追问建议生成。
 */
import { suggestFollowups, type FollowupContext } from '@/app/lib/components/ai/followup-suggestions';

function ctx(over: Partial<FollowupContext> = {}): FollowupContext {
  return {
    analysisText: '',
    activity: { distanceKm: 10, averagePace: 300, averageHeartRate: 150, averageCadence: 180, vdot: 45, hasHrData: true },
    profile: { intensityZ45Pct: null, weeklyVolumeChangePct: null, tsb: null, vdotTrend: null },
    ...over,
  };
}

describe('suggestFollowups', () => {
  test('返回 1-4 条建议, 去重', () => {
    const s = suggestFollowups(ctx());
    expect(s.length).toBeGreaterThan(0);
    expect(s.length).toBeLessThanOrEqual(4);
    expect(new Set(s).size).toBe(s.length);
  });

  test('强度失衡 (Z4+Z5>40%) 且分析未提时建议训练结构', () => {
    const s = suggestFollowups(ctx({ profile: { ...ctx().profile, intensityZ45Pct: 60 } }));
    expect(s.some((x) => x.includes('强度结构'))).toBe(true);
  });

  test('分析已提 80/20 时不重复建议训练结构', () => {
    const s = suggestFollowups(
      ctx({ analysisText: '建议遵循 80/20 极化训练原则', profile: { ...ctx().profile, intensityZ45Pct: 60 } }),
    );
    expect(s.some((x) => x.includes('强度结构'))).toBe(false);
  });

  test('有心率数据且分析未提漂移时建议心率问题', () => {
    const s = suggestFollowups(ctx());
    expect(s.some((x) => x.includes('心率漂移'))).toBe(true);
  });

  test('TSB 偏负时建议恢复安排', () => {
    const s = suggestFollowups(ctx({ profile: { ...ctx().profile, tsb: -20 } }));
    expect(s.some((x) => x.includes('疲劳') || x.includes('恢复'))).toBe(true);
  });

  test('VDOT 上升时建议目标设定', () => {
    const s = suggestFollowups(ctx({ profile: { ...ctx().profile, vdotTrend: 'up' } }));
    expect(s.some((x) => x.includes('目标'))).toBe(true);
  });

  test('永远包含伤病风险兜底问题', () => {
    expect(suggestFollowups(ctx()).some((x) => x.includes('伤病'))).toBe(true);
  });
});

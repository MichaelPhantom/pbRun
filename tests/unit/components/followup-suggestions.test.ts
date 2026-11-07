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
    profile: { weeklyVolumeChangePct: null, tsb: null, vdotTrend: null },
    ...over,
  };
}

describe('suggestFollowups', () => {
  test('返回 2-5 条建议, 去重, 最后一条恒为安全兜底', () => {
    const s = suggestFollowups(ctx());
    expect(s.length).toBeGreaterThan(1);
    expect(s.length).toBeLessThanOrEqual(5);
    expect(new Set(s).size).toBe(s.length);
    // 安全建议永远在最后一条（不被上下文建议挤掉）
    expect(s[s.length - 1]).toContain('伤病');
  });

  test('有心率但分析未提强度分布时，建议问「这一次」的强度分布', () => {
    const s = suggestFollowups(ctx());
    expect(s.some((x) => x.includes('这次训练的强度分布'))).toBe(true);
  });

  test('分析已提强度分布/区间占比时不重复', () => {
    const s = suggestFollowups(ctx({ analysisText: '强度分布集中在 Z3，区间占比 60%' }));
    expect(s.some((x) => x.includes('这次训练的强度分布'))).toBe(false);
  });

  test('有心率数据且分析未提漂移时建议心率问题', () => {
    const s = suggestFollowups(ctx());
    expect(s.some((x) => x.includes('心率漂移'))).toBe(true);
  });

  test('TSB 偏负时建议恢复安排', () => {
    const s = suggestFollowups(ctx({ profile: { ...ctx().profile, tsb: -20 } }));
    expect(s.some((x) => x.includes('疲劳') || x.includes('恢复'))).toBe(true);
  });

  test('VDOT 上升时建议问「下一次怎么加量」（而不是目标设定）', () => {
    const s = suggestFollowups(ctx({ profile: { ...ctx().profile, vdotTrend: 'up' } }));
    expect(s.some((x) => x.includes('下一次'))).toBe(true);
  });

  /**
   * 能力边界守卫：这些建议会被**一键发送给「单次活动」教练**，而它的提示词明确
   * 写着「跨多次活动的统计与周期化不在这里做」。旧实现推荐过三个越界问题
   * （训练结构是否合理 / 下一个目标定多少 / 距离下一个 PB 还有多远），
   * 用户点了之后教练只能二选一：违反边界回答，或拒绝 —— 两者都荒谬。
   */
  test('任何建议都不得越界到统计类能力（周期化 / 目标 / PB / 多周聚合）', () => {
    const banned = ['PB', '下一个目标', '多久能达成', '赛季', '3 个月', '三个月', '长期规划', '月跑量', '周均', '训练结构是否合理'];
    const scenarios = [
      ctx({ profile: { ...ctx().profile, vdotTrend: 'up' } }),
      ctx({ profile: { ...ctx().profile, vdotTrend: 'down' } }),
      ctx({ profile: { ...ctx().profile, tsb: -25, weeklyVolumeChangePct: 40 } }),
      ctx({ running: false }),
      ctx({ activity: { ...ctx().activity, hasHrData: false } }),
    ];
    for (const c of scenarios) {
      for (const suggestion of suggestFollowups(c)) {
        for (const word of banned) {
          expect(suggestion).not.toContain(word);
        }
      }
    }
  });

  test('永远包含伤病风险兜底问题', () => {
    expect(suggestFollowups(ctx()).some((x) => x.includes('伤病'))).toBe(true);
  });

  test('非跑步: 不建议跑步技术/PB/跑力类追问, 改问交叉训练配比', () => {
    // 泳池游泳的 average_cadence=48 是划水频次, 不是跑步步频;
    // vdotTrend 也是跑步跑力趋势。这两类追问对非跑步活动纯属误导。
    const s = suggestFollowups(
      ctx({
        running: false,
        activity: { distanceKm: 2.05, averagePace: 1670, averageHeartRate: 102, averageCadence: 48, vdot: null, hasHrData: true },
        profile: { ...ctx().profile, vdotTrend: 'up' },
      }),
    );
    expect(s.some((x) => x.includes('跑步技术'))).toBe(false);
    expect(s.some((x) => x.includes('步频'))).toBe(false);
    expect(s.some((x) => x.includes('PB'))).toBe(false);
    // 交叉训练对跑步的影响是更贴切的替代问题
    expect(s.some((x) => x.includes('交叉训练'))).toBe(true);
    // 与运动类型无关的建议仍然保留
    expect(s.some((x) => x.includes('心率漂移'))).toBe(true);
    expect(s.some((x) => x.includes('伤病'))).toBe(true);
  });

  test('跑步(running=true 或未声明): 保留跑步技术类追问（但不再有 PB/目标）', () => {
    const s = suggestFollowups(ctx({ running: true }));
    expect(s.some((x) => x.includes('跑步技术'))).toBe(true);
    expect(s.some((x) => x.includes('PB'))).toBe(false);
  });
});

/**
 * 力量训练专属追问（2026-11 新增）。
 *
 * 力量课走「非跑步」分支，旧建议会问「心率漂移说明了什么？有氧能力如何？」——
 * 力量训练的心率响应滞后且峰值低（真实库 51 条平均心率 73–129），拿它评有氧能力
 * 是错的维度。力量课真正该问的是**组结构是否合理、强度域与恢复预算、与跑步的负荷竞争**。
 */
describe('suggestFollowups — 力量训练', () => {
  const strengthCtx = (over: Partial<FollowupContext> = {}) =>
    ctx({
      running: false,
      strength: true,
      activity: { distanceKm: 0, averagePace: null, averageHeartRate: 110, averageCadence: null, vdot: null, hasHrData: true },
      ...over,
    });

  test('力量课不建议问心率漂移/有氧能力 (心率滞后且峰值低, 不是有氧指标)', () => {
    const s = suggestFollowups(strengthCtx());
    expect(s.some((x) => x.includes('心率漂移'))).toBe(false);
    expect(s.some((x) => x.includes('有氧能力'))).toBe(false);
  });

  test('力量课建议问组结构/强度域与恢复预算', () => {
    const s = suggestFollowups(strengthCtx());
    expect(s.some((x) => /组结构|工作:休息|组数/.test(x))).toBe(true);
    expect(s.some((x) => /强度域|训练效应|恢复/.test(x))).toBe(true);
  });

  test('力量课建议问与跑步的负荷竞争 (合并口径下力量课进 ACWR)', () => {
    const s = suggestFollowups(strengthCtx());
    expect(s.some((x) => /跑步|负荷/.test(x))).toBe(true);
  });

  test('力量课不出现「交叉训练」这种泛泛说法 (它有专属建议)', () => {
    const s = suggestFollowups(strengthCtx());
    expect(s.some((x) => x.includes('交叉训练'))).toBe(false);
  });

  test('安全兜底永远在最后 (力量课也不例外)', () => {
    const s = suggestFollowups(strengthCtx());
    expect(s[s.length - 1]).toContain('伤病');
  });

  test('strength 缺省时行为不变 (游泳等仍走通用交叉训练建议)', () => {
    const s = suggestFollowups(ctx({ running: false, activity: { ...ctx().activity, distanceKm: 2, averageCadence: 48 } }));
    expect(s.some((x) => x.includes('交叉训练'))).toBe(true);
  });
});

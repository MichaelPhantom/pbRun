/**
 * `type-metrics.ts` —— 非跑步活动的类型专属核心指标（三处卡片/详情共用）。
 *
 * 缺陷背景见模块头注释：120 条非跑步活动在列表卡片上只有「时长 + 类型徽标」，
 * 爬楼 30 条（distance 全 0、training_load 全 null）是纯空壳。
 *
 * 这些用例钉住三件容易漂移的事：
 *  ① 楼层**只对爬楼**派生（山地跑的爬升不是楼层）；
 *  ② total_cycles 只对**语义已确认**类型展示（力量 51 条都有值但语义未知）；
 *  ③ 数值与单位**同生共死**（不渲染孤零零的「次划水」）。
 */
import { typeMetricsOf } from '@/app/lib/type-metrics';

describe('typeMetricsOf —— 楼层（仅爬楼）', () => {
  test('爬楼 46m → 约 15 层（真实库实测值）', () => {
    const m = typeMetricsOf({ activity_type: 'floor_climbing', total_ascent: 46 });
    expect(m.floors).toBe(15);
    expect(m.floorsText).toBe('约 15 层');
  });

  test.each([
    [27, '约 9 层'],
    [30, '约 10 层'],
    [40, '约 13 层'],
    [43, '约 14 层'],
    [46, '约 15 层'],
    [49, '约 16 层'],
  ])('真实库 6 个爬升值 %i m → %s', (ascent, expected) => {
    const m = typeMetricsOf({ activity_type: 'floor_climbing', total_ascent: ascent });
    expect(m.floorsText).toBe(expected);
    expect(m.floors).toBe(Number(expected.match(/\d+/)![0]));
  });

  /**
   * **跑步即使有 300m 爬升也不派生楼层** —— 山地跑的爬升是「爬了多少层楼的
   * 高度」，不是「爬了多少层楼」。同一个算式在两种语义下都算得通，但结论不同。
   */
  test.each(['running', 'track_running', 'treadmill_running'])(
    '%s 带 300m 爬升也不给楼层',
    (type) => {
      const m = typeMetricsOf({ activity_type: type, total_ascent: 300 });
      expect(m.floors).toBeNull();
      expect(m.floorsText).toBeNull();
    },
  );

  test.each(['strength_training', 'basketball', 'lap_swimming', 'jump_rope', 'hiit'])(
    '%s 有爬升也不给楼层（非爬楼类型）',
    (type) => {
      const m = typeMetricsOf({ activity_type: type, total_ascent: 46 });
      expect(m.floors).toBeNull();
      expect(m.floorsText).toBeNull();
    },
  );

  test('爬楼但无爬升 → null（不显示「约 0 层」）', () => {
    for (const v of [null, 0]) {
      const m = typeMetricsOf({ activity_type: 'floor_climbing', total_ascent: v });
      expect(m.floors).toBeNull();
      expect(m.floorsText).toBeNull();
    }
  });

  test('爬楼但爬升不足半层 → null（不把 GPS 漂移说成 1 层）', () => {
    const m = typeMetricsOf({ activity_type: 'floor_climbing', total_ascent: 1 });
    expect(m.floors).toBeNull();
    expect(m.floorsText).toBeNull();
  });
});

describe('typeMetricsOf —— 总次数（仅语义已确认类型）', () => {
  test('游泳 518 → 次划水（真实库 518/798/923/695）', () => {
    const m = typeMetricsOf({ activity_type: 'lap_swimming', total_cycles: 518 });
    expect(m.cycles).toBe(518);
    expect(m.cyclesLabel?.unit).toBe('次划水');
  });

  test('公开水域游泳同语义', () => {
    const m = typeMetricsOf({ activity_type: 'open_water', total_cycles: 300 });
    expect(m.cycles).toBe(300);
    expect(m.cyclesLabel?.unit).toBe('次划水');
  });

  test('跳绳 189 → 次跳跃（真实库 189/187/193）', () => {
    const m = typeMetricsOf({ activity_type: 'jump_rope', total_cycles: 189 });
    expect(m.cycles).toBe(189);
    expect(m.cyclesLabel?.unit).toBe('次跳跃');
  });

  test('爬楼 300 → 步（Σlap==session 30/30）', () => {
    const m = typeMetricsOf({ activity_type: 'floor_climbing', total_cycles: 300 });
    expect(m.cycles).toBe(300);
    expect(m.cyclesLabel?.unit).toBe('步');
  });

  /**
   * **力量课 51 条都有 total_cycles（51/51），但语义未确认** ——
   * `r(cyc, 时长) = −0.118` 否掉了「次数」假设，而 `r = 0.68` 也不能证明它是
   * 别的东西。把 73 写成「73 次」是编造语义。
   */
  test.each(['strength_training', 'indoor_cardio', 'hiit', 'basketball', 'table_tennis', 'badminton', 'indoor_cycling'])(
    '%s 不展示 total_cycles（语义未确认, 不给兜底标签）',
    (type) => {
      const m = typeMetricsOf({ activity_type: type, total_cycles: 73 });
      expect(m.cycles).toBeNull();
      expect(m.cyclesLabel).toBeNull();
    },
  );

  test('跑步不展示 total_cycles（步幅周期数对用户无意义）', () => {
    const m = typeMetricsOf({ activity_type: 'running', total_cycles: 5234 });
    expect(m.cycles).toBeNull();
    expect(m.cyclesLabel).toBeNull();
  });

  test('空 activity_type 按跑步处理（旧库兼容）→ 不展示', () => {
    const m = typeMetricsOf({ activity_type: '', total_cycles: 100 });
    expect(m.cycles).toBeNull();
  });

  test('已确认类型但字段缺失 → null（不显示「0 次划水」）', () => {
    const m = typeMetricsOf({ activity_type: 'lap_swimming', total_cycles: null });
    expect(m.cycles).toBeNull();
    expect(m.cyclesLabel).toBeNull();
  });

  /**
   * 数值与单位**同生共死**：单位只随数值出现。否则调用方容易渲染出
   * 「次划水」而没有数字，或者有数字而没有单位。
   */
  test('单位只在有数值时存在（同生共死）', () => {
    for (const cycles of [null, undefined, 0]) {
      const m = typeMetricsOf({ activity_type: 'jump_rope', total_cycles: cycles as number | null });
      expect(m.cyclesLabel == null).toBe(m.cycles == null);
    }
  });

  test('四舍五入到整数（total_cycles 是计数, 不该有小数）', () => {
    expect(typeMetricsOf({ activity_type: 'jump_rope', total_cycles: 188.6 }).cycles).toBe(189);
  });

  test('NaN / Infinity 视为缺失（不渲染 NaN 次）', () => {
    expect(typeMetricsOf({ activity_type: 'jump_rope', total_cycles: NaN }).cycles).toBeNull();
    expect(typeMetricsOf({ activity_type: 'jump_rope', total_cycles: Infinity }).cycles).toBeNull();
  });
});

describe('typeMetricsOf —— 组合与边界', () => {
  test('爬楼同时有楼层与步数（两个指标都要给）', () => {
    const m = typeMetricsOf({ activity_type: 'floor_climbing', total_ascent: 46, total_cycles: 300 });
    expect(m.floors).toBe(15);
    expect(m.floorsText).toBe('约 15 层');
    expect(m.cycles).toBe(300);
    expect(m.cyclesLabel?.unit).toBe('步');
  });

  test('普通跑步：两个字段都 null（卡片只剩时长 + 配速）', () => {
    const m = typeMetricsOf({ activity_type: 'running', total_ascent: 120, total_cycles: 5000 });
    expect(m).toEqual({ floors: null, floorsText: null, cycles: null, cyclesLabel: null });
  });

  test('空对象不抛异常', () => {
    expect(() => typeMetricsOf({})).not.toThrow();
    expect(typeMetricsOf({})).toEqual({ floors: null, floorsText: null, cycles: null, cyclesLabel: null });
  });
});

/**
 * `swim-stroke.ts` —— 泳姿（FIT lap `swim_stroke`）的唯一来源。
 *
 * 缺陷背景见模块头注释：session 级恒 255（无效），lap 级才有真实值。
 * 这些用例同时承担「口径守护」与「真实数据自证」两件事：
 * 若将来有人把 `mixed` 摊到自由泳、或把 0 距离休息段算进泳姿统计，
 * 这里必须转红。
 */
import {
  swimStrokeLabel,
  hasSwimStroke,
  isComparableStroke,
  summarizeSwimStrokes,
  validateSwimStrokes,
  type SwimStrokeLapLike,
} from '@/app/lib/swim-stroke';

describe('swimStrokeLabel —— FIT 枚举 → 中文名', () => {
  test.each([
    ['freestyle', '自由泳'],
    ['backstroke', '仰泳'],
    ['breaststroke', '蛙泳'],
    ['butterfly', '蝶泳'],
    ['drill', '分解练习'],
    ['mixed', '混合泳姿'],
    ['im', '个人混合泳'],
  ])('%s → %s', (raw, label) => {
    expect(swimStrokeLabel(raw)).toBe(label);
  });

  /**
   * `mixed` 必须返回中文名，**不是 `null`** —— 它是设备记录的真实取值
   * （「这一段换了泳姿」），不是「未知」。若这里返回 null，
   * 详情页会把它渲染成「--」（数据缺失），与事实相反。
   */
  test('mixed 不是未知（必须给出中文名）', () => {
    expect(swimStrokeLabel('mixed')).toBe('混合泳姿');
    expect(hasSwimStroke('mixed')).toBe(true);
  });

  test('255 是无效哨兵 → null', () => {
    expect(swimStrokeLabel('255')).toBeNull();
    expect(hasSwimStroke('255')).toBe(false);
  });

  test.each([null, undefined, '', '   ', 255, 0, 'unknown_stroke'])(
    '无效输入 %p → null',
    (v) => {
      expect(swimStrokeLabel(v as unknown)).toBeNull();
      expect(hasSwimStroke(v as unknown)).toBe(false);
    },
  );

  test('大小写与空白不敏感（DB 存原始值，读侧归一）', () => {
    expect(swimStrokeLabel('  FreeStyle  ')).toBe('自由泳');
    expect(swimStrokeLabel('MIXED')).toBe('混合泳姿');
  });
});

describe('isComparableStroke —— 只有构成确定的单泳姿才能算效率', () => {
  test.each(['freestyle', 'backstroke', 'breaststroke', 'butterfly'])('%s 可比', (s) => {
    expect(isComparableStroke(s)).toBe(true);
  });

  /**
   * 这三类**不可比**：
   * - `mixed` 构成未知；
   * - `im` 按规则轮换四种泳姿；
   * - `drill` 是分解练习，配速不代表完整技术。
   * 给它们算「每 100m」会造出一个没有物理含义的数。
   */
  test.each(['mixed', 'im', 'drill', '255', '', null, undefined])('%p 不可比', (s) => {
    expect(isComparableStroke(s as unknown)).toBe(false);
  });
});

describe('summarizeSwimStrokes —— 按泳姿汇总（事实层）', () => {
  const lap = (over: Partial<SwimStrokeLapLike>): SwimStrokeLapLike => ({
    distance: 25,
    moving_time: 30,
    total_cycles: 20,
    swim_stroke: 'freestyle',
    ...over,
  });

  test('空输入 → 空数组（非游泳活动）', () => {
    expect(summarizeSwimStrokes([])).toEqual([]);
    expect(summarizeSwimStrokes(null)).toEqual([]);
    expect(summarizeSwimStrokes(undefined)).toEqual([]);
  });

  test('全 255 → 空数组（设备没写泳姿）', () => {
    expect(summarizeSwimStrokes([lap({ swim_stroke: '255' }), lap({ swim_stroke: '255' })])).toEqual([]);
  });

  /**
   * **0 距离休息段必须被排除** —— 即使某个固件给休息段写了泳姿，
   * 也不能把它的时间算进该泳姿（休息不是「用某泳姿游的」）。
   */
  test('0 距离休息段不参与任何泳姿统计', () => {
    const r = summarizeSwimStrokes([
      lap({ distance: 50, moving_time: 60, total_cycles: 40, swim_stroke: 'freestyle' }),
      lap({ distance: 0, moving_time: 999, total_cycles: 0, swim_stroke: 'freestyle' }),
    ]);
    expect(r).toHaveLength(1);
    expect(r[0].distanceM).toBe(50);
    // 999 秒的休息没被算进去
    expect(r[0].timeSec).toBe(60);
    expect(r[0].laps).toBe(1);
  });

  test('同一泳姿多段合并，距离/时间/次数分别相加', () => {
    const r = summarizeSwimStrokes([
      lap({ distance: 50, moving_time: 60, total_cycles: 40 }),
      lap({ distance: 100, moving_time: 120, total_cycles: 80 }),
    ]);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({
      stroke: 'freestyle',
      label: '自由泳',
      laps: 2,
      distanceM: 150,
      timeSec: 180,
      cycles: 120,
    });
    // 180s / 150m * 100 = 120 s/100m
    expect(r[0].paceSecPer100m).toBeCloseTo(120, 6);
    // 150m / 120 划 = 1.25 m/划
    expect(r[0].metersPerStroke).toBeCloseTo(1.25, 6);
  });

  /**
   * `mixed` 单列一组，**但效率字段必须是 null**。
   * 给 mixed 算「每 100m」等于编一个构成未知的数字。
   */
  test('mixed 单列一组且不给效率数字', () => {
    const r = summarizeSwimStrokes([
      lap({ distance: 50, moving_time: 60, total_cycles: 40, swim_stroke: 'freestyle' }),
      lap({ distance: 75, moving_time: 100, total_cycles: 50, swim_stroke: 'mixed' }),
    ]);
    const mixed = r.find((g) => g.stroke === 'mixed')!;
    expect(mixed).toBeDefined();
    expect(mixed.label).toBe('混合泳姿');
    expect(mixed.distanceM).toBe(75);
    expect(mixed.timeSec).toBe(100);
    expect(mixed.cycles).toBe(50);
    // 构成未知 → 不给效率结论
    expect(mixed.paceSecPer100m).toBeNull();
    expect(mixed.metersPerStroke).toBeNull();
    // 自由泳仍正常给
    const free = r.find((g) => g.stroke === 'freestyle')!;
    expect(free.paceSecPer100m).not.toBeNull();
  });

  test('im / drill 同样不给效率数字', () => {
    const r = summarizeSwimStrokes([
      lap({ swim_stroke: 'im' }),
      lap({ swim_stroke: 'drill' }),
    ]);
    expect(r).toHaveLength(2);
    for (const g of r) {
      expect(g.paceSecPer100m).toBeNull();
      expect(g.metersPerStroke).toBeNull();
    }
  });

  test('缺 moving_time 时回退 duration（与全站 effectiveTimeSec 同优先级）', () => {
    const r = summarizeSwimStrokes([
      lap({ distance: 25, moving_time: null, duration: 45, total_cycles: 20 }),
    ]);
    expect(r[0].timeSec).toBe(45);
  });

  test('两者都缺 → timeSec 为 0，效率字段为 null（不编）', () => {
    const r = summarizeSwimStrokes([
      lap({ distance: 25, moving_time: null, duration: null, total_cycles: 20 }),
    ]);
    expect(r[0].timeSec).toBe(0);
    expect(r[0].paceSecPer100m).toBeNull();
    // 每划距离只依赖 distance 与 cycles，仍可算
    expect(r[0].metersPerStroke).toBeCloseTo(1.25, 6);
  });

  test('cycles 缺失 → 每划距离 null（不除以 0）', () => {
    const r = summarizeSwimStrokes([lap({ total_cycles: 0 })]);
    expect(r[0].cycles).toBe(0);
    expect(r[0].metersPerStroke).toBeNull();
  });

  test('未知枚举不静默归入「其他」—— 整段跳过', () => {
    const r = summarizeSwimStrokes([
      lap({ swim_stroke: 'freestyle' }),
      lap({ swim_stroke: 'kayak_stroke' }),
    ]);
    expect(r).toHaveLength(1);
    expect(r[0].stroke).toBe('freestyle');
  });

  test('输出按泳姿字典序稳定（同一活动多次调用结果一致）', () => {
    const a = summarizeSwimStrokes([
      lap({ swim_stroke: 'mixed' }),
      lap({ swim_stroke: 'breaststroke' }),
      lap({ swim_stroke: 'freestyle' }),
    ]);
    const b = summarizeSwimStrokes([
      lap({ swim_stroke: 'freestyle' }),
      lap({ swim_stroke: 'mixed' }),
      lap({ swim_stroke: 'breaststroke' }),
    ]);
    expect(a.map((g) => g.stroke)).toEqual(['breaststroke', 'freestyle', 'mixed']);
    expect(a.map((g) => g.stroke)).toEqual(b.map((g) => g.stroke));
  });
});

describe('validateSwimStrokes —— 结构自证（255 ⟺ 0 距离）', () => {
  /**
   * 真实库 4/4 条游泳的形态：有距离的段有泳姿、0 距离休息段是 255。
   * 这是独立两字段（距离与泳姿）的一致性，能抓解析错位。
   */
  test('真实形态（有距离→有泳姿 / 0 距离→255）零违规', () => {
    expect(
      validateSwimStrokes([
        { distance: 0, swim_stroke: '255' },
        { distance: 50, swim_stroke: 'breaststroke' },
        { distance: 0, swim_stroke: '255' },
        { distance: 25, swim_stroke: 'mixed' },
      ]),
    ).toEqual([]);
  });

  test('有距离却没泳姿 → 违规（漏读/错位）', () => {
    const p = validateSwimStrokes([{ distance: 50, swim_stroke: null }]);
    expect(p).toHaveLength(1);
    expect(p[0]).toMatch(/有距离/);
  });

  test('0 距离却有泳姿 → 违规（错位）', () => {
    const p = validateSwimStrokes([{ distance: 0, swim_stroke: 'freestyle' }]);
    expect(p).toHaveLength(1);
    expect(p[0]).toMatch(/休息段却有泳姿/);
  });

  test('空输入 → 零违规', () => {
    expect(validateSwimStrokes([])).toEqual([]);
    expect(validateSwimStrokes(null)).toEqual([]);
  });
});

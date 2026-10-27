/**
 * `app/lib/workout.ts` —— FIT 课表读取层的契约守护。
 *
 * 这里守的是**三类真实缺陷**，每一条都有真实库样本做依据：
 *
 *  1. 多步课表被解析器压成最后一步（120/120 条多步课表受影响，60 条的最后一步是冷身）；
 *  2. `duration_sec` 旧格式是 FIT 原始**毫秒**（536624700: 2400000 vs 实际 2404 秒）；
 *  3. 目标配速旧格式是 **mm/s**（2944/3361），不是秒/公里。
 *
 * 另外守护「加权区间」的口径：多步课表不能用某一步（尤其冷身）当整体目标。
 */
import {
  collapseWorkoutBlocks,
  evaluateWorkoutExecution,
  formatWorkoutExecution,
  formatWorkoutPlan,
  formatWorkoutStep,
  mmpsToSecPerKm,
  parseWorkoutSteps,
  workoutTargetRange,
} from '@/app/lib/workout';

/** 新格式（`fit-workout.js` 规范化后）的一步。 */
function newStep(over: Record<string, unknown> = {}) {
  return {
    index: 0,
    name: null,
    duration_type: 'time',
    duration_type_label: '时长',
    duration_sec: 600,
    distance_m: null,
    reps: null,
    target_type: 'speed',
    target_low: 2888,
    target_high: 3250,
    target_pace_sec_per_km: { fast: 308, slow: 346 },
    intensity: 'warmup',
    intensity_label: '热身',
    ...over,
  };
}

describe('mmpsToSecPerKm', () => {
  test('mm/s → 秒/公里（速度越低配速数值越大）', () => {
    // 2888 mm/s = 2.888 m/s → 1000/2.888 ≈ 346 s/km
    expect(mmpsToSecPerKm(2888)).toBe(346);
    // 3250 mm/s = 3.25 m/s → 308 s/km
    expect(mmpsToSecPerKm(3250)).toBe(308);
    // 配速与速度反向: 更快的速度(更大 mm/s) → 更小的秒/公里
    expect(mmpsToSecPerKm(5000)!).toBeLessThan(mmpsToSecPerKm(2000)!);
  });

  test('非正/空值返回 null (不能除以 0)', () => {
    expect(mmpsToSecPerKm(0)).toBeNull();
    expect(mmpsToSecPerKm(-100)).toBeNull();
    expect(mmpsToSecPerKm(null)).toBeNull();
    expect(mmpsToSecPerKm(Number.NaN)).toBeNull();
  });
});

describe('parseWorkoutSteps —— 旧格式单位换算', () => {
  // 真实库 536624700 的旧值（回填前）: duration_sec=2400000、target 2944/3361 mm/s。
  const legacy = JSON.stringify([
    {
      index: 0,
      name: '',
      duration_type: 'time',
      duration_sec: 2400000,
      target_type: 'speed',
      target_low: 2944,
      target_high: 3361,
      intensity: 'interval',
    },
  ]);

  test('duration_sec 毫秒 → 秒 (2400000ms = 40 分钟, 不是 27.8 天)', () => {
    const [s] = parseWorkoutSteps(legacy);
    expect(s.durationSec).toBe(2400);
    expect(s.durationSec).not.toBe(2400000);
  });

  test('target_low/high mm/s → targetPace 秒/公里', () => {
    const [s] = parseWorkoutSteps(legacy);
    // 2944 mm/s ≈ 340 s/km (慢端), 3361 mm/s ≈ 298 s/km (快端)
    expect(s.targetPace).toEqual({ fast: 298, slow: 340 });
    // 绝不能把设备原始值当秒/公里: 2944 s/km = 49 分钟/公里
    expect(s.targetPace!.slow).toBeLessThan(400);
  });

  test('旧格式缺 duration_type_label, 但读取端补齐中文标签', () => {
    const [s] = parseWorkoutSteps(legacy);
    expect(s.durationTypeLabel).toBe('时长');
    expect(s.intensityLabel).toBe('间歇');
  });

  test('距离步的厘米 → 米', () => {
    const [s] = parseWorkoutSteps(
      JSON.stringify([{ duration_type: 'distance', duration_sec: 500000, intensity: 'active' }]),
    );
    expect(s.distanceM).toBe(5000); // 500000 cm = 5000 m
    expect(s.durationSec).toBeNull();
  });

  test('次数步保留 reps', () => {
    const [s] = parseWorkoutSteps(
      JSON.stringify([{ duration_type: 'reps', duration_sec: 12, intensity: 'active' }]),
    );
    expect(s.reps).toBe(12);
  });
});

describe('parseWorkoutSteps —— 新格式不再二次换算', () => {
  test('新格式 duration_sec 已是秒, 原样读取 (不 ÷1000)', () => {
    const [s] = parseWorkoutSteps(JSON.stringify([newStep({ duration_sec: 600 })]));
    expect(s.durationSec).toBe(600);
  });

  test('新格式 target_pace_sec_per_km 优先于原始 mm/s', () => {
    const [s] = parseWorkoutSteps(
      JSON.stringify([newStep({ target_pace_sec_per_km: { fast: 263, slow: 284 } })]),
    );
    expect(s.targetPace).toEqual({ fast: 263, slow: 284 });
  });

  test('fast/slow 顺序错乱时按数值归一 (fast 恒为更小值)', () => {
    const [s] = parseWorkoutSteps(
      JSON.stringify([newStep({ target_pace_sec_per_km: { fast: 400, slow: 300 } })]),
    );
    expect(s.targetPace).toEqual({ fast: 300, slow: 400 });
  });
});

describe('parseWorkoutSteps —— 防御性', () => {
  test('非法 JSON / null / 非数组 返回空数组 (绝不抛异常)', () => {
    expect(parseWorkoutSteps('not json')).toEqual([]);
    expect(parseWorkoutSteps(null)).toEqual([]);
    expect(parseWorkoutSteps(undefined)).toEqual([]);
    expect(parseWorkoutSteps('')).toEqual([]);
    expect(parseWorkoutSteps('{"a":1}')).toEqual([]);
    expect(parseWorkoutSteps('[]')).toEqual([]);
  });

  test('FIT 占位步 (intensity/target 均为 255 且无时长) 被剔除', () => {
    const steps = parseWorkoutSteps(
      JSON.stringify([
        newStep({ index: 0 }),
        // 真实库 50 条这样的填充消息
        { index: 1, duration_type: 'reps', duration_sec: 0, target_type: 255, intensity: 255 },
      ]),
    );
    expect(steps).toHaveLength(1);
    expect(steps[0].index).toBe(0);
  });

  test('按 index 升序 (FIT 消息顺序不保证)', () => {
    const steps = parseWorkoutSteps(
      JSON.stringify([
        newStep({ index: 2, intensity_label: '冷身' }),
        newStep({ index: 0, intensity_label: '热身' }),
        newStep({ index: 1, intensity_label: '间歇' }),
      ]),
    );
    expect(steps.map((s) => s.index)).toEqual([0, 1, 2]);
  });

  test('message_index 为 {value} 包装对象时也能取到序号', () => {
    const [s] = parseWorkoutSteps(
      JSON.stringify([{ message_index: { value: 7 }, duration_type: 'time', duration_sec: 600 }]),
    );
    expect(s.index).toBe(7);
  });
});

describe('多步课表不再只剩最后一步', () => {
  // 真实库 540880879「节奏」3 步, 旧实现只拿到 cooldown 一步。
  const tempo = JSON.stringify([
    newStep({ index: 0, duration_sec: 600, intensity: 'warmup', intensity_label: '热身', target_pace_sec_per_km: { fast: 308, slow: 346 } }),
    newStep({ index: 1, duration_sec: 1320, intensity: 'interval', intensity_label: '间歇', target_pace_sec_per_km: { fast: 263, slow: 284 } }),
    newStep({ index: 2, duration_sec: 600, intensity: 'cooldown', intensity_label: '冷身', target_pace_sec_per_km: { fast: 308, slow: 346 } }),
  ]);

  test('三步全部保留, 热身与主课不再丢失', () => {
    const steps = parseWorkoutSteps(tempo);
    expect(steps).toHaveLength(3);
    expect(steps.map((s) => s.intensityLabel)).toEqual(['热身', '间歇', '冷身']);
  });

  test('摘要包含热身/主课/冷身, 而不是只有冷身', () => {
    const plan = formatWorkoutPlan(tempo)!;
    expect(plan).toContain('热身');
    expect(plan).toContain('间歇');
    expect(plan).toContain('冷身');
    expect(plan).toContain('4:44-4:23/km'); // 主课目标区间
  });
});

describe('workoutTargetRange —— 按步骤时长加权', () => {
  test('单步: 区间即该步目标', () => {
    const r = workoutTargetRange(JSON.stringify([newStep({ target_pace_sec_per_km: { fast: 298, slow: 340 } })]))!;
    expect(r.fast).toBe(298);
    expect(r.slow).toBe(340);
    expect(r.stepCount).toBe(1);
    expect(r.multiStep).toBe(false);
  });

  /**
   * 核心口径守护：真实库 540880879 的三步目标分别是 5:46-5:08（热身 600s）、
   * 4:44-4:23（间歇 1320s）、5:46-5:08（冷身 600s）。
   * 旧实现只留最后一步 → 整体目标是「冷身 5:46-5:08」；而该活动实际均配速 5:18
   * 恰好落在冷身区间内 → 被判「区间内」，但主课 4:44-4:23 根本没跑出来。
   */
  test('多步课表加权后不等于任何单步 (尤其不等于冷身)', () => {
    const tempo = JSON.stringify([
      newStep({ index: 0, duration_sec: 600, target_pace_sec_per_km: { fast: 308, slow: 346 } }),
      newStep({ index: 1, duration_sec: 1320, target_pace_sec_per_km: { fast: 263, slow: 284 } }),
      newStep({ index: 2, duration_sec: 600, target_pace_sec_per_km: { fast: 308, slow: 346 } }),
    ]);
    const r = workoutTargetRange(tempo)!;
    expect(r.multiStep).toBe(true);
    expect(r.stepCount).toBe(3);
    expect(r.weightSec).toBe(2520);
    // 加权: (600*308 + 1320*263 + 600*308) / 2520 ≈ 284.2 → 284
    expect(r.fast).toBe(284);
    // (600*346 + 1320*284 + 600*346) / 2520 ≈ 313.5 → 314
    expect(r.slow).toBe(314);
    // 与冷身目标(308-346)不同 —— 这正是旧实现的口径错误
    expect(r.fast).not.toBe(308);
    expect(r.slow).not.toBe(346);
  });

  test('无目标配速的步不参与加权 (真实库 71 步 target=open)', () => {
    const r = workoutTargetRange(
      JSON.stringify([
        newStep({ index: 0, duration_sec: 600, target_pace_sec_per_km: { fast: 300, slow: 330 } }),
        newStep({ index: 1, duration_sec: 3600, target_pace_sec_per_km: null, target_type: 'open' }),
      ]),
    )!;
    // 3600 秒的开放步若计入会让区间被稀释; 它没有目标, 必须排除
    expect(r.fast).toBe(300);
    expect(r.slow).toBe(330);
    expect(r.weightSec).toBe(600);
  });

  test('无目标配速 / 无步骤 → null', () => {
    expect(workoutTargetRange(JSON.stringify([newStep({ target_pace_sec_per_km: null, target_type: 'open' })]))).toBeNull();
    expect(workoutTargetRange(null)).toBeNull();
    expect(workoutTargetRange('[]')).toBeNull();
  });

  test('旧格式也能算出加权区间 (mm/s 换算后)', () => {
    const legacy = JSON.stringify([
      { index: 0, duration_type: 'time', duration_sec: 600000, target_type: 'speed', target_low: 2888, target_high: 3250, intensity: 'warmup' },
      { index: 1, duration_type: 'time', duration_sec: 1320000, target_type: 'speed', target_low: 3527, target_high: 3805, intensity: 'interval' },
    ]);
    const r = workoutTargetRange(legacy)!;
    expect(r.multiStep).toBe(true);
    // 旧格式毫秒被正确换算成秒后加权: (600*346 + 1320*284) / 1920 ≈ 303
    expect(r.fast).toBeGreaterThan(250);
    expect(r.fast).toBeLessThan(320);
  });
});

describe('evaluateWorkoutExecution', () => {
  const plan = JSON.stringify([newStep({ target_pace_sec_per_km: { fast: 300, slow: 330 } })]);

  test('区间内 / 偏快 / 偏慢 三态', () => {
    expect(evaluateWorkoutExecution(plan, 315)!.verdict).toBe('in-range');
    expect(evaluateWorkoutExecution(plan, 280)!.verdict).toBe('faster');
    expect(evaluateWorkoutExecution(plan, 360)!.verdict).toBe('slower');
  });

  test('偏离量以最近边界计 (秒/公里, 正=慢 负=快)', () => {
    expect(evaluateWorkoutExecution(plan, 315)!.deltaSecPerKm).toBe(0);
    expect(evaluateWorkoutExecution(plan, 350)!.deltaSecPerKm).toBe(20);
    expect(evaluateWorkoutExecution(plan, 280)!.deltaSecPerKm).toBe(-20);
  });

  test('缺实际配速 / 缺课表 → null (不是「区间内」)', () => {
    expect(evaluateWorkoutExecution(plan, null)).toBeNull();
    expect(evaluateWorkoutExecution(plan, 0)).toBeNull();
    expect(evaluateWorkoutExecution(null, 315)).toBeNull();
    // 无 speed 目标（target_type='open'）时即使有原始 target_low/high 也不算目标
    expect(
      evaluateWorkoutExecution(
        JSON.stringify([newStep({ target_type: 'open', target_pace_sec_per_km: null })]),
        315,
      ),
    ).toBeNull();
  });

  test('多步课表标记 multiStep, 文案带混合强度提示', () => {
    const tempo = JSON.stringify([
      newStep({ index: 0, duration_sec: 600, target_pace_sec_per_km: { fast: 308, slow: 346 } }),
      newStep({ index: 1, duration_sec: 1320, target_pace_sec_per_km: { fast: 263, slow: 284 } }),
    ]);
    const e = evaluateWorkoutExecution(tempo, 400)!;
    expect(e.multiStep).toBe(true);
    expect(formatWorkoutExecution(e)).toContain('多步课表');
  });
});

describe('formatWorkoutExecution', () => {
  test('三态文案各自可读, 都带计划区间与实际值', () => {
    const plan = JSON.stringify([newStep({ target_pace_sec_per_km: { fast: 300, slow: 330 } })]);
    for (const [actual, expected] of [
      [315, '区间内'],
      [280, '偏快 20s/km'],
      [360, '偏慢 30s/km'],
    ] as const) {
      const text = formatWorkoutExecution(evaluateWorkoutExecution(plan, actual)!);
      expect(text).toContain('计划 5:30-5:00/km');
      expect(text).toContain(expected);
    }
  });
});

describe('collapseWorkoutBlocks', () => {
  test('连续相同步骤折叠为 ×N (真实库「主课 1:00 ×5」)', () => {
    const five = JSON.stringify(
      Array.from({ length: 5 }, (_, i) => newStep({ index: i, duration_sec: 60, target_pace_sec_per_km: null, target_type: 'open', intensity: 'active', intensity_label: '主课' })),
    );
    const plan = formatWorkoutPlan(five)!;
    expect(plan).toBe('主课 1:00 ×5');
    expect(plan).not.toContain('→');
  });

  test('不连续的同参数步不合并 (中间夹了别的步)', () => {
    const steps = parseWorkoutSteps(
      JSON.stringify([
        newStep({ index: 0, duration_sec: 60, intensity: 'active', intensity_label: '主课', target_pace_sec_per_km: null, target_type: 'open' }),
        newStep({ index: 1, duration_sec: 30, intensity: 'rest', intensity_label: '休息', target_pace_sec_per_km: null, target_type: 'open' }),
        newStep({ index: 2, duration_sec: 60, intensity: 'active', intensity_label: '主课', target_pace_sec_per_km: null, target_type: 'open' }),
      ]),
    );
    const blocks = collapseWorkoutBlocks(steps);
    expect(blocks.map((b) => b.repeat)).toEqual([1, 1, 1]);
  });

  test('长课表截断时标注剩余组数', () => {
    const many = JSON.stringify(
      Array.from({ length: 9 }, (_, i) => newStep({ index: i, duration_sec: 60 + i, target_pace_sec_per_km: null, target_type: 'open' })),
    );
    const plan = formatWorkoutPlan(many, 3)!;
    expect(plan).toContain('…(+6 组)');
  });
});

describe('formatWorkoutPlan / formatWorkoutStep', () => {
  test('无执行步 (只有循环控制步) → null, 不输出空壳课表行', () => {
    expect(formatWorkoutPlan(JSON.stringify([{ index: 0, duration_type: 'repeat_until_steps_cmplt', intensity: 'active' }]))).toBeNull();
    expect(formatWorkoutPlan(null)).toBeNull();
  });

  test('距离步 / 次数步 / 开放步 各有文案', () => {
    expect(formatWorkoutStep(parseWorkoutSteps(JSON.stringify([{ duration_type: 'distance', duration_sec: 500000, intensity: 'active' }]))[0])).toContain('5.00km');
    expect(formatWorkoutStep(parseWorkoutSteps(JSON.stringify([{ duration_type: 'reps', duration_sec: 8, intensity: 'active' }]))[0])).toContain('×8');
    expect(formatWorkoutStep(parseWorkoutSteps(JSON.stringify([{ duration_type: 'open', intensity: 'active' }]))[0])).toBe('主课 开放式');
  });

  test('超过 1 小时的步显示 h:mm:ss', () => {
    const [s] = parseWorkoutSteps(JSON.stringify([{ duration_type: 'time', duration_sec: 3900000, intensity: 'active' }]));
    expect(formatWorkoutStep(s)).toContain('1:05:00');
  });

  test('无名无强度步回落「步骤」而不是空串', () => {
    const [s] = parseWorkoutSteps(JSON.stringify([{ duration_type: 'time', duration_sec: 60000 }]));
    expect(formatWorkoutStep(s)).toContain('步骤');
  });
});

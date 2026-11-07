/**
 * 力量训练分析语义（`app/lib/strength.ts`）契约测试。
 *
 * 背景：生产库 51 条 `strength_training` 此前「收录了但零分析语义」——不进
 * 训练负荷、没有结构化画像。本模块提供纯函数基础，测试把口径钉死：
 *
 *  1. 数据边界：重量/次数**不可得**（FIT 无 set 消息），画像只输出真实可推导字段；
 *  2. 组结构：active/interval = 工作段、rest/recovery = 休息段；
 *  3. 强度域：以训练效应为主、心率为辅（力量心率响应滞后，单看心率会误判）；
 *  4. 负荷估算：与跑步同量纲但按 TE 加权，不让力量课趋近于零。
 */
import {
  STRENGTH_ACTIVITY_TYPE,
  STRENGTH_DOMAIN_LABELS,
  STRENGTH_STRUCTURE_LABELS,
  buildStrengthProfile,
  describeStrengthStructure,
  estimateStrengthLoad,
  isStrengthType,
  parseWorkoutSteps,
  strengthIntensityDomain,
  strengthLoadBaseSeconds,
} from '@/app/lib/strength';

describe('isStrengthType', () => {
  test('只认 strength_training, 其它类型一律否', () => {
    expect(isStrengthType('strength_training')).toBe(true);
    expect(isStrengthType('running')).toBe(false);
    expect(isStrengthType('indoor_cardio')).toBe(false); // 语义不同, 暂不并入
    expect(isStrengthType('hiit')).toBe(false);
    expect(isStrengthType(null)).toBe(false);
    expect(isStrengthType(undefined)).toBe(false);
    expect(isStrengthType('')).toBe(false);
  });

  test('STRENGTH_ACTIVITY_TYPE 与 Garmin activity_type 对齐', () => {
    expect(STRENGTH_ACTIVITY_TYPE).toBe('strength_training');
  });
});

describe('parseWorkoutSteps', () => {
  test('JSON 字符串 → 数组 (真实库 workout_steps 是 TEXT 列)', () => {
    const raw = JSON.stringify([
      { duration_type: 'time', duration_sec: 40, intensity: 'active' },
      { duration_type: 'time', duration_sec: 20, intensity: 'rest' },
    ]);
    expect(parseWorkoutSteps(raw)).toHaveLength(2);
  });

  test('已解析数组 → 原样返回', () => {
    const arr = [{ duration_sec: 40, intensity: 'active' }];
    expect(parseWorkoutSteps(arr)).toHaveLength(1);
  });

  test('坏数据不抛错 (一条脏记录不应让统计接口 500)', () => {
    expect(parseWorkoutSteps(null)).toEqual([]);
    expect(parseWorkoutSteps(undefined)).toEqual([]);
    expect(parseWorkoutSteps('')).toEqual([]);
    expect(parseWorkoutSteps('{bad json')).toEqual([]);
    expect(parseWorkoutSteps('{"not":"array"}')).toEqual([]);
    expect(parseWorkoutSteps(42)).toEqual([]);
  });

  test('数组里的非对象元素被过滤', () => {
    expect(parseWorkoutSteps([{ duration_sec: 40 }, null, 'x', 1])).toHaveLength(1);
  });
});

describe('strengthIntensityDomain', () => {
  test('以训练效应为主 (力量心率响应滞后, 单看心率会误判)', () => {
    // TE 4.0 + 平均心率仅 110 → 仍判高强度 (心率低不代表刺激低)
    expect(strengthIntensityDomain(4.0, 110)).toBe('high');
    expect(strengthIntensityDomain(3.5, 90)).toBe('high');
    expect(strengthIntensityDomain(3.0, 100)).toBe('tempo');
    expect(strengthIntensityDomain(2.5, 95)).toBe('tempo');
    expect(strengthIntensityDomain(2.0, 90)).toBe('base');
    expect(strengthIntensityDomain(1.5, 85)).toBe('base');
    expect(strengthIntensityDomain(1.0, 80)).toBe('recovery');
    expect(strengthIntensityDomain(0.1, 70)).toBe('recovery');
  });

  test('TE 缺失/为 0 时退回心率粗判', () => {
    expect(strengthIntensityDomain(null, 90)).toBe('recovery');
    expect(strengthIntensityDomain(null, 110)).toBe('base');
    expect(strengthIntensityDomain(null, 140)).toBe('tempo');
    expect(strengthIntensityDomain(0, 140)).toBe('tempo'); // TE=0 视为缺失
  });

  test('两者都缺失 → unknown', () => {
    expect(strengthIntensityDomain(null, null)).toBe('unknown');
    expect(strengthIntensityDomain(undefined, undefined)).toBe('unknown');
    expect(strengthIntensityDomain(NaN, NaN)).toBe('unknown');
    expect(strengthIntensityDomain(null, 0)).toBe('unknown');
  });
});

describe('buildStrengthProfile', () => {
  /**
   * 算术夹具：**整齐的** 7×(40 做 + 20 歇) = 420s。
   *
   * ⚠ 这不是生产形态（真实「核心稳定性1」末段休息是 `open` → 400s）。这里保留整齐
   * 形态是为了让「组数 × 时长」的算术断言一眼可验（7×40=280、7×20=140）；
   * **真实形态的回归在下面的「真实库回归」与 `activity-detail.test.tsx` 里**。
   * 若要改这里，先确认不是把真实形态用例也一起「整齐化」。
   */
  const coreSteps = JSON.stringify(
    Array.from({ length: 14 }, (_, i) => ({
      duration_type: 'time',
      duration_sec: i % 2 === 0 ? 40 : 20,
      intensity: i % 2 === 0 ? 'active' : 'rest',
    })),
  );

  test('循环结构: 组数/时长/工作休息比', () => {
    const p = buildStrengthProfile({
      name: '核心稳定性1',
      workout_name: '核心稳定性1',
      workout_steps: coreSteps,
      duration: 3609,
      average_heart_rate: 73,
      total_training_effect: 0.1,
    });
    expect(p.planName).toBe('核心稳定性1');
    expect(p.workingSets).toBe(7);
    expect(p.restSets).toBe(7);
    expect(p.workingSeconds).toBe(7 * 40);
    expect(p.restSeconds).toBe(7 * 20);
    expect(p.plannedSeconds).toBe(7 * 40 + 7 * 20);
    expect(p.workRestRatio).toBeCloseTo(2.0, 5);
    expect(p.structure).toBe('intervals');
    expect(p.intensityDomain).toBe('recovery');
  });

  test('interval 强度也算工作段 (真实库第 5 条样本用 interval 而非 active)', () => {
    const steps = JSON.stringify([
      { duration_sec: 60, intensity: 'interval' },
      { duration_sec: 30, intensity: 'rest' },
      { duration_sec: 60, intensity: 'interval' },
    ]);
    const p = buildStrengthProfile({ workout_steps: steps });
    expect(p.workingSets).toBe(2);
    expect(p.structure).toBe('intervals');
  });

  test('只有 1 个工作段 → continuous (不是循环结构)', () => {
    const steps = JSON.stringify([{ duration_sec: 1800, intensity: 'active' }]);
    const p = buildStrengthProfile({ workout_steps: steps });
    expect(p.workingSets).toBe(1);
    expect(p.structure).toBe('continuous');
  });

  test('无课表 → unknown 结构 + 全零组数, 但不抛错', () => {
    const p = buildStrengthProfile({ name: '自由训练', duration: 1200 });
    expect(p.structure).toBe('unknown');
    expect(p.workingSets).toBe(0);
    expect(p.restSets).toBe(0);
    expect(p.plannedSeconds).toBe(0);
    expect(p.workRestRatio).toBeNull();
  });

  test('无休息段时 工作休息比 = null (不除零)', () => {
    const p = buildStrengthProfile({
      workout_steps: JSON.stringify([
        { duration_sec: 60, intensity: 'active' },
        { duration_sec: 60, intensity: 'active' },
      ]),
    });
    expect(p.workRestRatio).toBeNull();
  });

  test('计划名回落: workout_name → name → null', () => {
    expect(buildStrengthProfile({ workout_name: '全身循环1', name: 'x' }).planName).toBe('全身循环1');
    expect(buildStrengthProfile({ workout_name: '  ', name: '活动名' }).planName).toBe('活动名');
    expect(buildStrengthProfile({}).planName).toBeNull();
  });

  test('训练效应原样透传, 缺失为 null', () => {
    const p = buildStrengthProfile({
      total_training_effect: 2.7,
      total_anaerobic_training_effect: 1.2,
      average_heart_rate: 118,
    });
    expect(p.aerobicEffect).toBe(2.7);
    expect(p.anaerobicEffect).toBe(1.2);
    expect(p.avgHeartRate).toBe(118);
    expect(p.intensityDomain).toBe('tempo');

    const empty = buildStrengthProfile({});
    expect(empty.aerobicEffect).toBeNull();
    expect(empty.anaerobicEffect).toBeNull();
    expect(empty.avgHeartRate).toBeNull();
  });

  test('recovery 强度步也被归为休息段 (intensity=recovery)', () => {
    const steps = JSON.stringify([
      { duration_sec: 40, intensity: 'active' },
      { duration_sec: 20, intensity: 'recovery' },
    ]);
    const p = buildStrengthProfile({ workout_steps: steps });
    expect(p.restSets).toBe(1);
    expect(p.restSeconds).toBe(20);
  });
});

describe('estimateStrengthLoad', () => {
  test('按强度域加权 (与跑步同基线 时长h × 100, 但系数按 TE)', () => {
    // 32 分钟: 0.5333h × 100 = 53.33
    expect(estimateStrengthLoad(1920, { intensityDomain: 'base' })).toBe(53);
    expect(estimateStrengthLoad(1920, { intensityDomain: 'high' })).toBe(80); // ×1.5
    expect(estimateStrengthLoad(1920, { intensityDomain: 'tempo' })).toBe(69); // ×1.3
    expect(estimateStrengthLoad(1920, { intensityDomain: 'recovery' })).toBe(32); // ×0.6
    expect(estimateStrengthLoad(1920, { intensityDomain: 'unknown' })).toBe(43); // ×0.8
  });

  test('时长非法 → 0 (不产生 NaN 负荷)', () => {
    expect(estimateStrengthLoad(0, { intensityDomain: 'base' })).toBe(0);
    expect(estimateStrengthLoad(-1, { intensityDomain: 'base' })).toBe(0);
    expect(estimateStrengthLoad(null, { intensityDomain: 'base' })).toBe(0);
    expect(estimateStrengthLoad(undefined, { intensityDomain: 'base' })).toBe(0);
    expect(estimateStrengthLoad(NaN, { intensityDomain: 'base' })).toBe(0);
  });

  test('力量课不会被系统性压成 0 (旧跑步口径的缺陷)', () => {
    // 真实库「核心稳定性1」: 3609s, TE 0.1, 平均心率 73 → recovery 域
    const p = buildStrengthProfile({ total_training_effect: 0.1, average_heart_rate: 73 });
    const load = estimateStrengthLoad(3609, p);
    expect(load).toBeGreaterThan(30); // 60min × 0.6 ≈ 36
  });
});

describe('strengthLoadBaseSeconds', () => {
  test('计时器时间优先 (与配速/TSS 同一纪律)', () => {
    expect(strengthLoadBaseSeconds(1800, 2400)).toBe(1800);
  });

  test('计时器时间缺失/为 0 → 回退经过时间', () => {
    expect(strengthLoadBaseSeconds(0, 2400)).toBe(2400);
    expect(strengthLoadBaseSeconds(null, 2400)).toBe(2400);
    expect(strengthLoadBaseSeconds(undefined, 2400)).toBe(2400);
  });

  test('两者都缺失 → 0', () => {
    expect(strengthLoadBaseSeconds(null, null)).toBe(0);
    expect(strengthLoadBaseSeconds(0, 0)).toBe(0);
  });
});

describe('中文标签', () => {
  test('强度域与结构类型都有中文标签 (展示/AI 数据块共用)', () => {
    expect(STRENGTH_DOMAIN_LABELS.recovery).toBe('恢复');
    expect(STRENGTH_DOMAIN_LABELS.base).toBe('基础');
    expect(STRENGTH_DOMAIN_LABELS.tempo).toBe('提升');
    expect(STRENGTH_DOMAIN_LABELS.high).toBe('高强度');
    expect(STRENGTH_DOMAIN_LABELS.unknown).toBe('未知');
    expect(STRENGTH_STRUCTURE_LABELS.intervals).toBe('循环/间歇');
    expect(STRENGTH_STRUCTURE_LABELS.continuous).toBe('连续');
    expect(STRENGTH_STRUCTURE_LABELS.unknown).toBe('无课表');
  });
});

describe('真实库回归 (51 条力量训练)', () => {
  test('样本画像与生产库字段一致 (核心稳定性1: 真实 14 步/400s)', () => {
    // 该活动真实值: duration 3609s, avg_hr 73, TE 0.1, recovery_time 2089min
    // 课表真实形态: 6×(40 做 + 20 歇) + 40 做 + **open 休息(无时长)** = 400s
    const p = buildStrengthProfile({
      workout_name: '核心稳定性1',
      workout_steps: JSON.stringify([
        ...Array.from({ length: 6 }, () => [
          { duration_type: 'time', duration_sec: 40, intensity: 'active' },
          { duration_type: 'time', duration_sec: 20, intensity: 'rest' },
        ]).flat(),
        { duration_type: 'time', duration_sec: 40, intensity: 'active' },
        { duration_type: 'open', duration_sec: null, intensity: 'rest' },
      ]),
      duration: 3609,
      moving_time: 3609,
      average_heart_rate: 73,
      total_training_effect: 0.1,
      total_anaerobic_training_effect: 0,
    });
    expect(p.workingSets).toBe(7);
    // 末段 open 休息无时长 → 计划 400s 而非整齐的 420s
    expect(p.plannedSeconds).toBe(400);
    // 工作 280s / 休息 120s（open 不计秒）→ 2.33
    expect(p.workRestRatio).toBeCloseTo(2.33, 2);
    // 计划 400s 而实际 3609s: 课表是「一轮」的模板, 用户做了多轮 —— 画像只报
    // 计划结构, 不推断实际轮数 (后者需 set 消息, 不可得)
    expect(p.structure).toBe('intervals');
  });

  /**
   * FIT 的 `repeat_until_*` 是**循环控制步**（回跳到前面某一步，本身没有时长），
   * 不是训练段。真实库 3 条课表（「全身肌群循环式训练 3」「核心肌群稳定性训练 4」）
   * 末尾带一步 `duration_type='repeat_until_steps_cmplt', intensity='active', duration_sec=null`。
   *
   * 旧实现只按 `intensity === 'active'` 判工作段，于是：
   *   - 有效组数 7 → **8**（凭空多一组）
   *   - 休息段 7 → **8**
   *   - 结构描述尾巴多出「→ ? 连续」（`stepSeconds` 为 0 → 格式化成 `?`）
   * 组数虚高会直接进首页/分析页的「本月有效组数」，是**给用户看的数字**。
   */
  test('repeat_until_* 循环控制步不得计入工作段 (真实库 3 条课表)', () => {
    const real = JSON.stringify([
      ...Array.from({ length: 6 }, () => [
        { duration_type: 'time', duration_sec: 40, intensity: 'interval' },
        { duration_type: 'time', duration_sec: 20, intensity: 'rest' },
      ]).flat(),
      { duration_type: 'time', duration_sec: 40, intensity: 'interval' },
      { duration_type: 'open', duration_sec: null, intensity: 'rest' },
      { duration_type: 'repeat_until_steps_cmplt', duration_sec: null, intensity: 'active' },
    ]);
    const p = buildStrengthProfile({ workout_name: '全身肌群循环式训练 3', workout_steps: real, duration: 3600 });
    expect(p.workingSets).toBe(7);
    expect(p.restSets).toBe(7);
    expect(p.plannedSeconds).toBe(400);
    // 结构描述同样不得出现「? 连续」噪音
    expect(describeStrengthStructure(real)).toBe('40s 做 / 20s 歇 × 6 → 40s 连续');
  });

  test('其它 repeat_until_* 变体同样不计入 (不写死单一枚举值)', () => {
    for (const type of [
      'repeat_until_time',
      'repeat_until_distance',
      'repeat_until_calories',
      'repeat_until_hr_greater_than',
      'repeat_until_power_less_than',
    ]) {
      const p = buildStrengthProfile({
        workout_steps: JSON.stringify([
          { duration_type: 'time', duration_sec: 30, intensity: 'active' },
          { duration_type: type, duration_sec: null, intensity: 'active' },
        ]),
        duration: 1800,
      });
      expect(p.workingSets).toBe(1);
      expect(
        describeStrengthStructure(
          JSON.stringify([
            { duration_type: 'time', duration_sec: 30, intensity: 'active' },
            { duration_type: type, duration_sec: null, intensity: 'active' },
          ]),
        ),
      ).toBe('30s 连续');
    }
  });
});

describe('describeStrengthStructure (组结构可读描述)', () => {
  const alternating = (work: number, rest: number, n: number) =>
    JSON.stringify(
      Array.from({ length: n * 2 }, (_, i) => ({
        duration_sec: i % 2 === 0 ? work : rest,
        intensity: i % 2 === 0 ? 'active' : 'rest',
      })),
    );

  test('交替结构 → 「40s 做 / 20s 歇 × 7」', () => {
    expect(describeStrengthStructure(alternating(40, 20, 7))).toBe('40s 做 / 20s 歇 × 7');
  });

  test('不同工作/休息时长各自格式化', () => {
    expect(describeStrengthStructure(alternating(60, 30, 3))).toBe('60s 做 / 30s 歇 × 3');
    expect(describeStrengthStructure(alternating(45, 15, 4))).toBe('45s 做 / 15s 歇 × 4');
  });

  test('长时长用分/秒 (600s → 10:00)', () => {
    expect(describeStrengthStructure(alternating(600, 120, 2))).toBe('10:00 做 / 2:00 歇 × 2');
  });

  test('只有工作段 (连续) → 「60s 连续 × 2」, 不虚构休息', () => {
    const steps = JSON.stringify([
      { duration_sec: 60, intensity: 'active' },
      { duration_sec: 60, intensity: 'active' },
    ]);
    expect(describeStrengthStructure(steps)).toBe('60s 连续 × 2');
  });

  test('工作段时长不一致 → 逐段罗列 (不假装是循环)', () => {
    const steps = JSON.stringify([
      { duration_sec: 40, intensity: 'active' },
      { duration_sec: 20, intensity: 'rest' },
      { duration_sec: 60, intensity: 'active' },
      { duration_sec: 20, intensity: 'rest' },
    ]);
    expect(describeStrengthStructure(steps)).toBe('40s 做 / 20s 歇 → 60s 做 / 20s 歇');
  });

  test('无课表/坏数据 → null (调用方不渲染该行)', () => {
    expect(describeStrengthStructure(null)).toBeNull();
    expect(describeStrengthStructure('')).toBeNull();
    expect(describeStrengthStructure('{bad')).toBeNull();
    expect(describeStrengthStructure(JSON.stringify([]))).toBeNull();
  });

  test('轮数上限: 只报「一轮的组结构」, 不推断实际做了几轮', () => {
    // 真实库「核心稳定性1」计划 400s 而实际 3609s —— 用户做了多轮, 但 FIT 无 set
    // 消息, 无法知道真实轮数。描述只讲课表本身。
    const d = describeStrengthStructure(alternating(40, 20, 7));
    expect(d).toContain('× 7');
    expect(d).not.toMatch(/轮/);
  });
});

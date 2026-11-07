import {
  formatPacePer100m,
  groupCadence,
  groupHeartRate,
  groupPaceSecPerKm,
  paceSecPer100m,
  type GroupSample,
} from '@/app/lib/pace';

/**
 * 「一组活动的均配速/均心率/均步频」的**唯一实现**。
 *
 * 这一族的历史缺陷是「用比值的算术平均冒充总量之比」——`AVG(average_pace)`
 * 只在每次跑的距离相同时才等于这段时期的配速，而真实的跑量结构里长短差异极大。
 * 真实库近 7 天：`AVG(average_pace)` = 388.3 而 `Σt/Σd` = 358.3，**差 30 s/km
 * （8.4%）**，方向永远是「显示得比实际更慢」。
 *
 * 这些用例都用**判别式**：断言结果等于 Σt/Σd，且**不等于**算术平均。
 */
describe('groupPaceSecPerKm', () => {
  test('陡峭的长度差：Σt/Σd 而非各次配速的平均', () => {
    // 4.76 km 恢复跑（7:26/km）+ 15.06 km 常规跑（5:31/km）—— 真实库 2026-10 的形态
    const samples: GroupSample[] = [
      { paceSecPerKm: 446, distanceKm: 4.76 },
      { paceSecPerKm: 330.6, distanceKm: 15.06 },
    ];
    const got = groupPaceSecPerKm(samples)!;
    expect(got).toBeCloseTo((446 * 4.76 + 330.6 * 15.06) / (4.76 + 15.06), 6);
    expect(got).toBeCloseTo(358.31, 1);
    // 算术平均是 388.3 —— 差 30 s/km
    expect(got).not.toBeCloseTo((446 + 330.6) / 2, 1);
  });

  test('可从展示出的总时长/总距离自证', () => {
    const samples: GroupSample[] = [
      { paceSecPerKm: 300, distanceKm: 10 }, // 3000 s
      { paceSecPerKm: 400, distanceKm: 5 }, //  2000 s
    ];
    const pace = groupPaceSecPerKm(samples)!;
    const totalSeconds = 3000 + 2000;
    const totalKm = 15;
    expect(pace).toBeCloseTo(totalSeconds / totalKm, 9);
  });

  test('可组合：切分窗口后再合并，结果不变', () => {
    const all: GroupSample[] = [
      { paceSecPerKm: 320, distanceKm: 12 },
      { paceSecPerKm: 410, distanceKm: 3 },
      { paceSecPerKm: 350, distanceKm: 8 },
    ];
    const whole = groupPaceSecPerKm(all)!;
    // 子区间各自只带 Σt、Σd（这是关键：算术平均做不到下一步）
    const part = (rows: GroupSample[]) => ({
      seconds: rows.reduce((a, r) => a + r.paceSecPerKm! * r.distanceKm!, 0),
      km: rows.reduce((a, r) => a + r.distanceKm!, 0),
    });
    const a = part(all.slice(0, 2));
    const b = part(all.slice(2));
    expect((a.seconds + b.seconds) / (a.km + b.km)).toBeCloseTo(whole, 9);
  });

  test('算术平均不可组合（这就是它不适合当"均配速"的原因）', () => {
    // 两个子组的算术平均再平均 ≠ 全体的算术平均（除非距离相同）
    const g1: GroupSample[] = [
      { paceSecPerKm: 300, distanceKm: 10 },
      { paceSecPerKm: 300, distanceKm: 10 },
    ];
    const g2: GroupSample[] = [{ paceSecPerKm: 500, distanceKm: 2 }];
    const meanOf = (rows: GroupSample[]) =>
      rows.reduce((a, r) => a + r.paceSecPerKm!, 0) / rows.length;
    const aggregateOfMeans = (meanOf(g1) + meanOf(g2)) / 2; // 400
    const allMean = meanOf([...g1, ...g2]); // 366.7
    expect(aggregateOfMeans).not.toBeCloseTo(allMean, 1);
    // 而 Σt/Σd 无论怎么切分都一致
    expect(groupPaceSecPerKm([...g1, ...g2])).toBeCloseTo(
      (300 * 20 + 500 * 2) / 22,
      9,
    );
  });

  test('seconds 缺失/为 0 时由 pace × distance 精确还原', () => {
    expect(groupPaceSecPerKm([{ paceSecPerKm: 350, distanceKm: 8, seconds: 0 }])).toBeCloseTo(350, 9);
    expect(groupPaceSecPerKm([{ paceSecPerKm: 350, distanceKm: 8 }])).toBeCloseTo(350, 9);
  });

  test('显式 seconds 优先于 pace × distance（时间基数以 timer 为准）', () => {
    // 配速列与计时器不一致时（历史脏数据），以 seconds 为准
    expect(groupPaceSecPerKm([{ paceSecPerKm: 300, distanceKm: 10, seconds: 3600 }])).toBeCloseTo(360, 9);
  });

  test('跳过非法样本：距离 ≤0 / 既无秒数也无配速', () => {
    const samples: GroupSample[] = [
      { paceSecPerKm: 300, distanceKm: 10 },
      { paceSecPerKm: 300, distanceKm: 0 }, // 0 距离不能贡献分母
      { paceSecPerKm: null, distanceKm: 5 }, // 既无 pace 又无 seconds
      { paceSecPerKm: 300, distanceKm: null },
    ];
    expect(groupPaceSecPerKm(samples)).toBeCloseTo(300, 9);
  });

  test('空输入 / 全非法 → null（不编造 0）', () => {
    expect(groupPaceSecPerKm([])).toBeNull();
    expect(groupPaceSecPerKm([{ paceSecPerKm: null, distanceKm: null }])).toBeNull();
  });
});

describe('groupHeartRate', () => {
  test('按计时器时间加权，短跑不主导', () => {
    const samples: GroupSample[] = [
      { heartRate: 150, seconds: 7200 }, // 2 小时
      { heartRate: 178, seconds: 600 }, // 10 分钟间歇
    ];
    const got = groupHeartRate(samples)!;
    expect(got).toBeCloseTo((150 * 7200 + 178 * 600) / 7800, 9);
    expect(got).toBeCloseTo(152.15, 1);
    // 等权平均 164 —— 被那 10 分钟拉高 12bpm
    expect(got).not.toBeCloseTo((150 + 178) / 2, 0);
  });

  test('seconds 缺失时由 pace × distance 还原权重', () => {
    const samples: GroupSample[] = [
      { heartRate: 150, paceSecPerKm: 360, distanceKm: 20 }, // 7200 s
      { heartRate: 170, paceSecPerKm: 400, distanceKm: 4 }, // 1600 s
    ];
    expect(groupHeartRate(samples)).toBeCloseTo((150 * 7200 + 170 * 1600) / 8800, 9);
  });

  test('跳过无心率 / 无法确定权重的样本', () => {
    expect(
      groupHeartRate([
        { heartRate: null, seconds: 1000 },
        { heartRate: 0, seconds: 1000 },
        { heartRate: 160, seconds: 0, paceSecPerKm: null, distanceKm: null },
        { heartRate: 150, seconds: 1000 },
      ]),
    ).toBeCloseTo(150, 9);
  });

  test('空输入 → null', () => {
    expect(groupHeartRate([])).toBeNull();
  });
});

describe('groupCadence', () => {
  test('按时间加权', () => {
    const samples: GroupSample[] = [
      { cadence: 170, seconds: 7200 },
      { cadence: 192, seconds: 600 },
    ];
    expect(groupCadence(samples)).toBeCloseTo((170 * 7200 + 192 * 600) / 7800, 9);
    expect(groupCadence(samples)).not.toBeCloseTo(181, 0);
  });

  test('空输入 / 全缺 → null', () => {
    expect(groupCadence([])).toBeNull();
    expect(groupCadence([{ cadence: null, seconds: 100 }])).toBeNull();
  });
});

/**
 * 游泳「每 100m 配速」—— 提示词曾写「由平均速度换算（÷10 即秒/100m）」。
 *
 * 这句话**两处都错**：
 *  1. `÷10` 只对「秒/公里」成立（100m = 0.1km），数据块里给的是 `average_speed`
 *     （km/h）—— 对 2.535 km/h 做 ÷10 得 0.25，会被读成「每 100 米 0.25 秒」；
 *  2. 换算需要 `3600 / 速度(km/h) / 10 = 360 / 速度`，中间隔着两步。
 *
 * 验算用**真实库四条游泳**的 `average_speed`（见下方用例），并与
 * `average_pace / 10` 交叉校验 —— 两者本应完全一致（互为倒数）。
 */
describe('paceSecPer100m / formatPacePer100m', () => {
  test.each([
    // [activity_id, average_speed(km/h), average_pace(s/km), 期望秒/100m, 期望展示]
    [630387237, 2.5352112676056335, 1420.0000000000002, 142.0, '2:22'],
    [599287904, 1.3362068965517242, 2694.1935483870966, 269.4, '4:29'],
    [617083438, 3.322147651006712, 1083.6363636363635, 108.4, '1:48'],
    [614598589, 1.6024844720496896, 2246.5116279069766, 224.7, '3:45'],
  ])('真实库游泳 %i: %s km/h → %s s/100m (%s)', (_id, speed, pace, wantSec, wantText) => {
    const got = paceSecPer100m(speed)!;
    expect(got).toBeCloseTo(wantSec, 1);
    // 与 average_pace ÷ 10 交叉校验（同一口径的两种表达，必须自洽）
    expect(got).toBeCloseTo(pace / 10, 6);
    expect(formatPacePer100m(got)).toBe(wantText);
  });

  test('÷10 的旧公式对 km/h 是错的 (2.535 → 0.25, 不是 142)', () => {
    // 守护这条注释：如果有人「优化」成 speed/10，这个断言会立刻炸
    expect(2.5352112676056335 / 10).toBeCloseTo(0.2535, 4);
    expect(paceSecPer100m(2.5352112676056335)).toBeCloseTo(142.0, 1);
  });

  test('null / 0 / 负数 / 非有限 → null (不造 0 配速)', () => {
    expect(paceSecPer100m(null)).toBeNull();
    expect(paceSecPer100m(undefined)).toBeNull();
    expect(paceSecPer100m(0)).toBeNull();
    expect(paceSecPer100m(-2.5)).toBeNull();
    expect(paceSecPer100m(Number.NaN)).toBeNull();
    expect(paceSecPer100m(Number.POSITIVE_INFINITY)).toBeNull();
  });

  test('formatPacePer100m 三态 + 秒补零', () => {
    expect(formatPacePer100m(null)).toBeNull();
    expect(formatPacePer100m(0)).toBeNull();
    expect(formatPacePer100m(-1)).toBeNull();
    expect(formatPacePer100m(108.4)).toBe('1:48');
    expect(formatPacePer100m(65)).toBe('1:05'); // 秒必须补零, 不能是 1:5
    expect(formatPacePer100m(60)).toBe('1:00');
    // 359.6 四舍五入到 360 → 6:00 (不能出现 5:60)
    expect(formatPacePer100m(359.6)).toBe('6:00');
  });
});

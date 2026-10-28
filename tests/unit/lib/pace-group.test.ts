import {
  groupCadence,
  groupHeartRate,
  groupPaceSecPerKm,
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

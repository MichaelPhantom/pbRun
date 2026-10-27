/**
 * @jest-environment node
 *
 * lap 级区间列的**口径守卫**。
 *
 * ## 背景（2026-10-27 审计）
 *
 * `activities` 表早已把「统计口径列」与「设备原始数组」分成两套列：
 *   - `time_in_hr_zone` / `time_in_power_zone` = app 5 区模型，长度恒为 5，
 *     可按索引跨活动聚合；
 *   - `device_time_in_*_zone` = 设备原始数组，仅供追溯。
 *
 * 但 `activity_laps` 表**漏做了这一步**：`_extractLapsData` 直接把设备数组
 * 写进统一列。这是潜伏缺陷 —— 实测 348 个 FIT 的 3082 个 lap **全都不写**
 * 区间数组，所以生产库暂时没有脏数据；但任何写了 lap 级区间的固件都会
 * 立刻污染统一列（设备数组长度 7/8，而统一列承诺恒为 5）。
 *
 * ## 本文件守的两件事
 *
 * 1. **分流**：lap 级设备数组只能进 `device_*` 列，统一列不接受设备输入；
 * 2. **推导**：统一列的值由逐秒记录按 lap 时间窗推导，长度恒为 5，且各 lap
 *    求和应等于活动级总数（允许末尾采样点造成的几秒误差）。
 */
const GarminFITParser = require('../../../scripts/garmin/fit-parser');

const parser = () => new GarminFITParser();

/** 构造一条活动的逐秒记录（elapsed_sec 递增 1s）。 */
function makeRecords(count, { heartRate = 150, power = 300 } = {}) {
  return Array.from({ length: count }, (_, i) => ({
    record_index: i,
    elapsed_sec: i,
    heart_rate: heartRate,
    power,
  }));
}

/** 构造 laps（cumulative_time 依次累加）。 */
function makeLaps(durations) {
  let cum = 0;
  return durations.map((d, i) => {
    cum += d;
    return { lap_index: i, duration: d, cumulative_time: cum };
  });
}

describe('lap 级区间: 设备数组不得进统一列', () => {
  test('lap 级 time_in_hr_zone / time_in_power_zone 即使设备给了也不采纳', () => {
    const p = parser();
    // 设备原始数组：7 槽（心率）/ 8 槽（功率），长度都不等于 5
    const laps = p._extractLapsData({
      laps: [
        {
          total_distance: 5,
          total_elapsed_time: 1800,
          time_in_hr_zone: [0, 18.3, 431.5, 1043.2, 348.9, 795.9, 0],
          time_in_power_zone: [656.1, 552.0, 273.0, 612.8, 544.0, 0, 0, 0],
        },
      ],
    });
    // 统一列必须是**空的** —— 它的唯一生产路径是按时间窗推导（下面另一组测试）
    expect(laps[0].time_in_hr_zone).toBeUndefined();
    expect(laps[0].time_in_power_zone).toBeUndefined();
    // 设备数组落到 device_* 列，保留取证能力
    expect(JSON.parse(laps[0].device_time_in_hr_zone)).toHaveLength(7);
    expect(JSON.parse(laps[0].device_time_in_power_zone)).toHaveLength(8);
  });

  test('lap 级速度/步频区间同样走 device_ 前缀（app 无对应模型）', () => {
    const p = parser();
    const [lap] = p._extractLapsData({
      laps: [
        {
          total_distance: 5,
          total_elapsed_time: 1800,
          time_in_speed_zone: [1, 2, 3],
          time_in_cadence_zone: [4, 5, 6],
        },
      ],
    });
    // 旧实现写的是 time_in_speed_zone / time_in_cadence_zone（无 device_ 前缀）
    expect(lap.time_in_speed_zone).toBeUndefined();
    expect(lap.time_in_cadence_zone).toBeUndefined();
    expect(JSON.parse(lap.device_time_in_speed_zone)).toEqual([1, 2, 3]);
    expect(JSON.parse(lap.device_time_in_cadence_zone)).toEqual([4, 5, 6]);
  });

  test('活动级 session 级速度/步频区间同样走 device_ 前缀', () => {
    const p = parser();
    const out = p._extractActivityData({
      sessions: [
        {
          total_distance: 10,
          total_elapsed_time: 3600,
          time_in_speed_zone: [1, 2, 3],
          time_in_cadence_zone: [4, 5, 6],
        },
      ],
    });
    expect(out.time_in_speed_zone).toBeUndefined();
    expect(out.time_in_cadence_zone).toBeUndefined();
    expect(JSON.parse(out.device_time_in_speed_zone)).toEqual([1, 2, 3]);
    expect(JSON.parse(out.device_time_in_cadence_zone)).toEqual([4, 5, 6]);
  });

  test('设备没写区间时 device_ 列也不凭空造值', () => {
    const p = parser();
    const [lap] = p._extractLapsData({
      laps: [{ total_distance: 5, total_elapsed_time: 1800 }],
    });
    for (const key of [
      'time_in_hr_zone',
      'time_in_power_zone',
      'device_time_in_hr_zone',
      'device_time_in_power_zone',
      'device_time_in_speed_zone',
      'device_time_in_cadence_zone',
    ]) {
      expect({ key, present: key in lap }).toEqual({ key, present: false });
    }
  });
});

describe('lap 级区间: 由逐秒记录按时间窗推导', () => {
  test('每个 lap 的长度恒为 5, 且各 lap 求和 ≈ 活动级总数', () => {
    const p = parser();
    // 3 个 lap：200s / 150s / 100s；心率全在 Z2（150 bpm / MAX_HR 194 → 77%）
    const records = makeRecords(450, { heartRate: 150, power: 300 });
    const laps = makeLaps([200, 150, 100]);
    const activity = { functional_threshold_power: 300 };

    p._assignLapZoneSeconds(laps, records, activity, 194);

    const sums = [0, 0, 0, 0, 0];
    for (const lap of laps) {
      const hr = JSON.parse(lap.time_in_hr_zone);
      expect(hr).toHaveLength(5);
      hr.forEach((v, i) => (sums[i] += v));
      // 功率区间同样 5 槽
      expect(JSON.parse(lap.time_in_power_zone)).toHaveLength(5);
    }
    // 心率全部落在同一个区间 → 该区间秒数 = 记录条数（450 个样本各代表 1s）
    const totalHr = sums.reduce((a, b) => a + b, 0);
    expect(totalHr).toBeGreaterThanOrEqual(445);
    expect(totalHr).toBeLessThanOrEqual(450);
    // 且只有唯一一个非零槽
    expect(sums.filter((v) => v > 0)).toHaveLength(1);
  });

  test('窗口是半开区间 [前一段累计, 本段累计), 不重不漏', () => {
    const p = parser();
    // 每 100 秒一段，心率固定 → 各 lap 秒数应 ≈ 段长
    const records = makeRecords(300, { heartRate: 150 });
    const laps = makeLaps([100, 100, 100]);
    p._assignLapZoneSeconds(laps, records, {}, 194);

    const perLap = laps.map((l) => JSON.parse(l.time_in_hr_zone).reduce((a, b) => a + b, 0));
    // 每段 100 秒 → 100 或 99（末样本归属），不应出现 200（重复计入）
    for (const v of perLap) {
      expect(v).toBeGreaterThanOrEqual(99);
      expect(v).toBeLessThanOrEqual(100);
    }
    // 三段合计不超过样本总数
    expect(perLap.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(300);
  });

  test('没有 FTP 时不推导功率区间（绝不猜默认值）', () => {
    const p = parser();
    const records = makeRecords(120, { heartRate: 150, power: 300 });
    const laps = makeLaps([120]);
    p._assignLapZoneSeconds(laps, records, {}, 194);

    expect(laps[0].time_in_hr_zone).toBeDefined();
    expect(laps[0].time_in_power_zone).toBeUndefined();
  });

  test('心率/功率全缺 → 不写统一列（保持 NULL, 不造「全 0」假分布）', () => {
    const p = parser();
    const records = makeRecords(120, { heartRate: null, power: null });
    const laps = makeLaps([120]);
    p._assignLapZoneSeconds(laps, records, { functional_threshold_power: 300 }, 194);

    expect(laps[0].time_in_hr_zone).toBeUndefined();
    expect(laps[0].time_in_power_zone).toBeUndefined();
  });

  test('cumulative_time 缺失/非有限 → 该 lap 跳过, 不猜时间窗', () => {
    const p = parser();
    const records = makeRecords(120, { heartRate: 150 });
    const laps = [
      { lap_index: 0, duration: 60, cumulative_time: 60 },
      { lap_index: 1, duration: 60 }, // 没有 cumulative_time
    ];
    p._assignLapZoneSeconds(laps, records, {}, 194);

    expect(laps[0].time_in_hr_zone).toBeDefined();
    expect(laps[1].time_in_hr_zone).toBeUndefined();
  });

  test('空 laps / 空 records 直接返回, 不抛错', () => {
    const p = parser();
    expect(() => p._assignLapZoneSeconds([], makeRecords(10), {}, 194)).not.toThrow();
    expect(() => p._assignLapZoneSeconds(makeLaps([10]), [], {}, 194)).not.toThrow();
    expect(() => p._assignLapZoneSeconds(null, null, {}, 194)).not.toThrow();
  });

  test('cumulative_time 倒退（坏数据）→ 该 lap 跳过, 不产生负窗口', () => {
    const p = parser();
    const records = makeRecords(120, { heartRate: 150 });
    const laps = [
      { lap_index: 0, duration: 60, cumulative_time: 60 },
      { lap_index: 1, duration: 60, cumulative_time: 30 }, // 倒退
    ];
    p._assignLapZoneSeconds(laps, records, {}, 194);

    expect(laps[0].time_in_hr_zone).toBeDefined();
    expect(laps[1].time_in_hr_zone).toBeUndefined();
  });
});

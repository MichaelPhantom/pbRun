/**
 * @jest-environment node
 *
 * scripts/common/lap-zones.js 单测。
 *
 * 这个模块是 lap 级区间秒数的**唯一实现**，被两条生产路径共用：
 *   - 同步: `scripts/garmin/fit-parser.js` 的 `_assignLapZoneSeconds`
 *   - 回填: `scripts/garmin/backfill-lap-zones.js`
 *
 * 两份实现漂移会让「新同步的 lap」与「回填的 lap」不可加总，而且**不会报错** ——
 * 只是「Z4 那几段配速掉了没」这类判断悄悄失真。所以窗口语义必须逐条钉死：
 *
 *   1. 半开区间 `[prevCum, cum)`：边界那一秒只属于后一段（不重不漏）；
 *   2. 按 `cumulative_time` 对齐，不是 lap 的 `start_time`（实测最大错位 19 秒）；
 *   3. 长度恒为 5；全 0 → null（「无数据」不是「全 0」）；
 *   4. `cumulative_time` 缺失/倒退 → 该段跳过（不猜）。
 */
const {
  LOCAL_ZONE_LENGTH,
  looksLocalZoneArray,
  lapWindowSamples,
  deriveLapZoneSeconds,
  applyLapZoneSeconds,
} = require('../../../scripts/common/lap-zones');

/** 构造逐秒记录（elapsed_sec 从 0 起递增 1s）。 */
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

describe('lap-zones: 常量', () => {
  test('本地口径槽数恒为 5（与心率/功率模型一致）', () => {
    expect(LOCAL_ZONE_LENGTH).toBe(5);
  });
});

describe('lap-zones: looksLocalZoneArray（回填迁移判据）', () => {
  test('长度 5 且各槽非负有限数字 → 本地口径', () => {
    expect(looksLocalZoneArray([0, 0, 120, 300, 0])).toBe(true);
    expect(looksLocalZoneArray([1, 2, 3, 4, 5])).toBe(true);
    expect(looksLocalZoneArray([0, 0, 0, 0, 0])).toBe(true);
  });

  test('设备原始数组（6/7/8 槽）→ 不是本地口径, 必须迁移', () => {
    // 真实设备形态: 心率 7 槽, 功率 8 槽
    expect(looksLocalZoneArray([0, 18.3, 431.5, 1043.2, 348.9, 795.9, 0])).toBe(false);
    expect(looksLocalZoneArray([656.1, 552, 273, 612.8, 544, 0, 0, 0])).toBe(false);
  });

  test('长度 5 但含 null / 非数字 / 负数 → 不是本地口径', () => {
    expect(looksLocalZoneArray([1, 2, 3, 4, null])).toBe(false);
    expect(looksLocalZoneArray([1, 2, 3, 4, '5'])).toBe(false);
    expect(looksLocalZoneArray([1, 2, 3, 4, -1])).toBe(false);
    expect(looksLocalZoneArray([1, 2, 3, 4, NaN])).toBe(false);
    expect(looksLocalZoneArray([1, 2, 3, 4, Infinity])).toBe(false);
  });

  test('非数组 → false（不抛错）', () => {
    expect(looksLocalZoneArray(null)).toBe(false);
    expect(looksLocalZoneArray(undefined)).toBe(false);
    expect(looksLocalZoneArray('[]')).toBe(false);
    expect(looksLocalZoneArray({})).toBe(false);
  });
});

describe('lap-zones: lapWindowSamples（半开区间）', () => {
  const records = makeRecords(10);

  test('[start, end) 含 start 不含 end', () => {
    const got = lapWindowSamples(records, 2, 5).map((r) => r.elapsed_sec);
    expect(got).toEqual([2, 3, 4]);
  });

  test('相邻窗口不重不漏（边界那一秒只属于后一段）', () => {
    const a = lapWindowSamples(records, 0, 5).map((r) => r.elapsed_sec);
    const b = lapWindowSamples(records, 5, 10).map((r) => r.elapsed_sec);
    expect(a).toEqual([0, 1, 2, 3, 4]);
    expect(b).toEqual([5, 6, 7, 8, 9]);
    // 交集为空、并集覆盖全部样本
    expect(a.filter((t) => b.includes(t))).toEqual([]);
    expect([...a, ...b].sort((x, y) => x - y)).toEqual(records.map((r) => r.elapsed_sec));
  });

  test('start 非有限 → 从 0 起; end 非有限 → 到末尾（不抛错）', () => {
    expect(lapWindowSamples(records, NaN, 3).map((r) => r.elapsed_sec)).toEqual([0, 1, 2]);
    expect(lapWindowSamples(records, 7, undefined).map((r) => r.elapsed_sec)).toEqual([7, 8, 9]);
  });

  test('空窗口 / 非数组 records → []', () => {
    expect(lapWindowSamples(records, 100, 200)).toEqual([]);
    expect(lapWindowSamples(null, 0, 10)).toEqual([]);
    expect(lapWindowSamples(records, 5, 5)).toEqual([]);
  });

  test('elapsed_sec 非数字的记录被跳过（不猜时间）', () => {
    const mixed = [
      { elapsed_sec: 1, heart_rate: 150 },
      { elapsed_sec: null, heart_rate: 150 },
      { elapsed_sec: 'x', heart_rate: 150 },
      { elapsed_sec: 3, heart_rate: 150 },
    ];
    expect(lapWindowSamples(mixed, 0, 10).map((r) => r.elapsed_sec)).toEqual([1, 3]);
  });
});

describe('lap-zones: deriveLapZoneSeconds', () => {
  test('长度恒为 5, 且各 lap 求和 ≈ 活动总数', () => {
    const records = makeRecords(450, { heartRate: 150, power: 300 });
    const laps = makeLaps([200, 150, 100]);
    const derived = deriveLapZoneSeconds(laps, records, { maxHr: 194, ftpWatts: 300 });

    const sums = [0, 0, 0, 0, 0];
    for (const d of derived) {
      expect(d).not.toBeNull();
      const hr = JSON.parse(d.hrZoneJson);
      expect(hr).toHaveLength(5);
      hr.forEach((v, i) => (sums[i] += v));
      expect(JSON.parse(d.powerZoneJson)).toHaveLength(5);
    }
    const total = sums.reduce((a, b) => a + b, 0);
    // 450 个样本各代表 1s; 末尾样本归属造成 ≤5s 误差
    expect(total).toBeGreaterThanOrEqual(445);
    expect(total).toBeLessThanOrEqual(450);
  });

  test('每段秒数 ≈ 段长（不重复计入相邻段）', () => {
    const records = makeRecords(300, { heartRate: 150 });
    const laps = makeLaps([100, 100, 100]);
    const derived = deriveLapZoneSeconds(laps, records, { maxHr: 194 });
    const perLap = derived.map((d) =>
      d.hrZoneJson ? JSON.parse(d.hrZoneJson).reduce((a, b) => a + b, 0) : 0,
    );
    for (const v of perLap) {
      expect(v).toBeGreaterThanOrEqual(99);
      expect(v).toBeLessThanOrEqual(100);
    }
    expect(perLap.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(300);
  });

  test('窗口按 cumulative_time 对齐, 不依赖 start_time', () => {
    // 两个 lap 的 start_time 故意写成与实际窗口矛盾的值 —— 结果必须只由
    // cumulative_time 决定（真实数据里两者最大错位 19 秒）。
    const records = makeRecords(200, { heartRate: 150 });
    const laps = [
      { lap_index: 0, duration: 100, cumulative_time: 100, start_time: '2099-01-01T00:00:00Z' },
      { lap_index: 1, duration: 100, cumulative_time: 200, start_time: '1999-01-01T00:00:00Z' },
    ];
    const derived = deriveLapZoneSeconds(laps, records, { maxHr: 194 });
    const a = JSON.parse(derived[0].hrZoneJson).reduce((x, y) => x + y, 0);
    const b = JSON.parse(derived[1].hrZoneJson).reduce((x, y) => x + y, 0);
    expect(a).toBe(100);
    expect(b).toBe(100);
  });

  test('无 FTP → 功率为 null, 心率照常推导', () => {
    const records = makeRecords(120, { heartRate: 150, power: 300 });
    const laps = makeLaps([120]);
    const [d] = deriveLapZoneSeconds(laps, records, { maxHr: 194, ftpWatts: null });
    expect(d.hrZoneJson).toBeTruthy();
    expect(d.powerZoneJson).toBeNull();
  });

  test('FTP 非法（0/负数/非数字）→ 同样不给功率区间（绝不猜默认值）', () => {
    const records = makeRecords(60, { heartRate: 150, power: 300 });
    for (const ftpWatts of [0, -300, NaN, undefined, null]) {
      const [d] = deriveLapZoneSeconds(makeLaps([60]), records, { maxHr: 194, ftpWatts });
      expect(d.powerZoneJson).toBeNull();
    }
  });

  test('心率/功率全缺 → 两者都 null（保持 NULL, 不造「全 0」假分布）', () => {
    const records = makeRecords(120, { heartRate: null, power: null });
    const [d] = deriveLapZoneSeconds(makeLaps([120]), records, { maxHr: 194, ftpWatts: 300 });
    expect(d.hrZoneJson).toBeNull();
    expect(d.powerZoneJson).toBeNull();
  });

  test('cumulative_time 缺失 → 该段为 null, 后续段不受影响', () => {
    const records = makeRecords(120, { heartRate: 150 });
    const laps = [
      { lap_index: 0, duration: 60, cumulative_time: 60 },
      { lap_index: 1, duration: 60 }, // 无 cumulative_time
    ];
    const derived = deriveLapZoneSeconds(laps, records, { maxHr: 194 });
    expect(derived[0]).not.toBeNull();
    expect(derived[1]).toBeNull();
  });

  test('cumulative_time 倒退 → 该段 null, 且不产生负窗口', () => {
    const records = makeRecords(120, { heartRate: 150 });
    const laps = [
      { lap_index: 0, duration: 60, cumulative_time: 60 },
      { lap_index: 1, duration: 60, cumulative_time: 30 },
      { lap_index: 2, duration: 60, cumulative_time: 180 },
    ];
    const derived = deriveLapZoneSeconds(laps, records, { maxHr: 194 });
    expect(derived[0]).not.toBeNull();
    expect(derived[1]).toBeNull();
    // 第 3 段: prevEnd 停在 60, 窗口 [60, 180) 仍有效
    expect(derived[2]).not.toBeNull();
  });

  test('cumulative_time 与上一段相同（零长度窗口）→ 该段 null', () => {
    const records = makeRecords(120, { heartRate: 150 });
    const laps = [
      { lap_index: 0, duration: 60, cumulative_time: 60 },
      { lap_index: 1, duration: 0, cumulative_time: 60 },
    ];
    const derived = deriveLapZoneSeconds(laps, records, { maxHr: 194 });
    expect(derived[0]).not.toBeNull();
    expect(derived[1]).toBeNull();
  });

  test('窗口内无样本 → null（不猜）', () => {
    const records = makeRecords(10, { heartRate: 150 });
    const laps = makeLaps([10, 100]); // 第二段窗口 [10,110) 无样本
    const derived = deriveLapZoneSeconds(laps, records, { maxHr: 194 });
    expect(derived[0]).not.toBeNull();
    expect(derived[1]).toBeNull();
  });

  test('空 laps / 空 records → 全 null 且等长（不抛错）', () => {
    expect(deriveLapZoneSeconds([], makeRecords(10), { maxHr: 194 })).toEqual([]);
    expect(deriveLapZoneSeconds(null, makeRecords(10), { maxHr: 194 })).toEqual([]);
    expect(deriveLapZoneSeconds(makeLaps([10]), [], { maxHr: 194 })).toEqual([null]);
    expect(deriveLapZoneSeconds(makeLaps([10]), null, { maxHr: 194 })).toEqual([null]);
  });

  test('opts 缺省（无 maxHr）→ 用 DEFAULT_MAX_HR, 不抛错', () => {
    const records = makeRecords(10, { heartRate: 150 });
    const derived = deriveLapZoneSeconds(makeLaps([10]), records);
    expect(JSON.parse(derived[0].hrZoneJson)).toHaveLength(5);
  });
});

describe('lap-zones: applyLapZoneSeconds', () => {
  test('只写非 null 的列, 返回写入计数', () => {
    const laps = [
      { lap_index: 0 },
      { lap_index: 1 },
      { lap_index: 2 },
    ];
    const derived = [
      { hrZoneJson: '[1,0,0,0,0]', powerZoneJson: '[0,2,0,0,0]' },
      { hrZoneJson: null, powerZoneJson: null }, // 窗口有效但无数据
      null, // 无时间窗
    ];
    const counts = applyLapZoneSeconds(laps, derived);
    expect(counts).toEqual({ hr: 1, power: 1 });
    expect(laps[0].time_in_hr_zone).toBe('[1,0,0,0,0]');
    expect(laps[0].time_in_power_zone).toBe('[0,2,0,0,0]');
    // null 结果不写列（保持「没有这个值」而不是塞空字符串）
    expect('time_in_hr_zone' in laps[1]).toBe(false);
    expect('time_in_hr_zone' in laps[2]).toBe(false);
  });

  test('非数组入参 → 计数 0, 不抛错', () => {
    expect(applyLapZoneSeconds(null, null)).toEqual({ hr: 0, power: 0 });
    expect(applyLapZoneSeconds([], [])).toEqual({ hr: 0, power: 0 });
  });

  test('derived 比 laps 短 → 只写能对上的部分（不越界）', () => {
    const laps = [{ lap_index: 0 }, { lap_index: 1 }];
    const counts = applyLapZoneSeconds(laps, [{ hrZoneJson: '[1,0,0,0,0]', powerZoneJson: null }]);
    expect(counts).toEqual({ hr: 1, power: 0 });
    expect(laps[1].time_in_hr_zone).toBeUndefined();
  });

  test('与 deriveLapZoneSeconds 串起来能真正填满 lap', () => {
    const records = makeRecords(100, { heartRate: 150, power: 300 });
    const laps = makeLaps([50, 50]);
    applyLapZoneSeconds(laps, deriveLapZoneSeconds(laps, records, { maxHr: 194, ftpWatts: 300 }));
    for (const lap of laps) {
      expect(JSON.parse(lap.time_in_hr_zone)).toHaveLength(5);
      expect(JSON.parse(lap.time_in_power_zone)).toHaveLength(5);
    }
  });
});

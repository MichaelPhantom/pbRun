/**
 * wellness-transform 单测。
 *
 * 重点不是覆盖率，而是**把口径钉住**：
 *  - 睡眠必须存秒（不是小时/分钟）
 *  - 缺数据必须是 null（不是 0）
 *  - 非法日期必须抛错（否则会写进一行 calendar_date 乱七八糟的数据，且主键冲突后静默覆盖）
 *  - hasAnySignal 决定「Garmin 那天真的没数据」与「字段全空」的边界
 */
const {
  normalizeDailyWellness,
  hasAnySignal,
  enumerateDates,
  lastNDates,
  toInt,
  toNum,
  toText,
} = require('../../../scripts/garmin/wellness-transform');

describe('wellness-transform / 基础类型转换', () => {
  test('toInt 四舍五入，非有限值 → null', () => {
    expect(toInt(45.6)).toBe(46);
    expect(toInt('47')).toBe(47);
    expect(toInt(undefined)).toBeNull();
    expect(toInt(null)).toBeNull();
    expect(toInt('abc')).toBeNull();
    expect(toInt(Infinity)).toBeNull();
  });

  test('toNum 保留小数，非有限值 → null', () => {
    expect(toNum(92.4)).toBe(92.4);
    expect(toNum('14.2')).toBe(14.2);
    expect(toNum(NaN)).toBeNull();
    expect(toNum(undefined)).toBeNull();
  });

  test('toText 空串/非字符串 → null（不要把 "" 写进库）', () => {
    expect(toText(' BALANCED ')).toBe('BALANCED');
    expect(toText('')).toBeNull();
    expect(toText('   ')).toBeNull();
    expect(toText(123)).toBeNull();
    expect(toText(null)).toBeNull();
  });
});

describe('wellness-transform / 日期区间', () => {
  test('enumerateDates 含两端且连续', () => {
    expect(enumerateDates('2026-11-01', '2026-11-04')).toEqual([
      '2026-11-01',
      '2026-11-02',
      '2026-11-03',
      '2026-11-04',
    ]);
  });

  test('enumerateDates 单日区间', () => {
    expect(enumerateDates('2026-11-25', '2026-11-25')).toEqual(['2026-11-25']);
  });

  test('enumerateDates 反向 / 非法格式抛错', () => {
    expect(() => enumerateDates('2026-11-05', '2026-11-01')).toThrow(/区间非法/);
    expect(() => enumerateDates('2026/11/01', '2026-11-02')).toThrow(/YYYY-MM-DD/);
  });

  test('enumerateDates 跨月/跨年不丢日', () => {
    const d = enumerateDates('2026-12-30', '2027-01-02');
    expect(d).toEqual(['2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02']);
  });

  test('lastNDates 含今天，长度 = N', () => {
    const today = new Date(Date.UTC(2026, 10, 25)); // 2026-11-25
    expect(lastNDates(3, today)).toEqual(['2026-11-23', '2026-11-24', '2026-11-25']);
    expect(lastNDates(1, today)).toEqual(['2026-11-25']);
  });
});

describe('wellness-transform / normalizeDailyWellness', () => {
  const summary = {
    restingHeartRate: 49,
    lastSevenDaysAvgRestingHeartRate: 46,
    minHeartRate: 44,
    maxHeartRate: 91,
    sleepingSeconds: 12600,
    averageStressLevel: 47,
    maxStressLevel: 96,
    bodyBatteryAtWakeTime: 15,
    bodyBatteryLowestValue: 5,
    bodyBatteryHighestValue: 44,
    totalSteps: 3200,
    totalDistanceMeters: 2900,
    activeKilocalories: 190,
  };
  const hrv = {
    hrvSummary: {
      calendarDate: '2026-10-26',
      weeklyAvg: 72,
      lastNightAvg: 50,
      lastNight5MinHigh: 88,
      baseline: { lowUpper: 73, balancedLow: 77, balancedUpper: 97 },
      status: 'LOW',
      feedbackPhrase: 'HRV_LOW_2',
    },
  };
  const sleep = {
    dailySleepDTO: {
      sleepTimeSeconds: 12600,
      deepSleepSeconds: 3200,
      remSleepSeconds: 4100,
      lightSleepSeconds: 4800,
      awakeSleepSeconds: 500,
      avgSleepStress: 21,
      avgHeartRate: 51,
      averageSpO2Value: 91.5,
      averageRespirationValue: 14.8,
      sleepScores: { overall: { value: 42 } },
    },
  };

  test('三个端点合并成一行，单位钉死为秒/bpm/ms', () => {
    const row = normalizeDailyWellness({ date: '2026-10-26', summary, hrv, sleep });
    expect(row.calendar_date).toBe('2026-10-26');
    expect(row.resting_heart_rate).toBe(49);
    expect(row.resting_hr_7d_avg).toBe(46);
    expect(row.sleeping_seconds).toBe(12600); // 3.5 小时 = 12600 秒，不是 3.5
    expect(row.sleep_score).toBe(42);
    expect(row.sleep_deep_seconds).toBe(3200);
    expect(row.body_battery_at_wake).toBe(15);
    expect(row.hrv_last_night_avg).toBe(50);
    expect(row.hrv_weekly_avg).toBe(72);
    expect(row.hrv_status).toBe('LOW');
    expect(row.hrv_baseline_low).toBe(77);
    expect(row.hrv_baseline_high).toBe(97);
    expect(row.sleep_spo2_avg).toBe(91.5);
    expect(row.source).toBe('garmin-cdp');
    expect(typeof row.fetched_at).toBe('string');
  });

  test('端点全缺失 → 除主键/元数据外全 null，且 hasAnySignal=false', () => {
    const row = normalizeDailyWellness({ date: '2026-10-26', summary: null, hrv: null, sleep: null });
    expect(row.calendar_date).toBe('2026-10-26');
    expect(row.resting_heart_rate).toBeNull();
    expect(row.sleeping_seconds).toBeNull();
    expect(row.hrv_status).toBeNull();
    expect(hasAnySignal(row)).toBe(false);
  });

  test('只有睡眠也要算「有数据」（休息日可能没有心率但有睡眠）', () => {
    const row = normalizeDailyWellness({
      date: '2026-11-15',
      summary: null,
      hrv: null,
      sleep: { dailySleepDTO: { sleepTimeSeconds: 25200 } },
    });
    expect(row.sleeping_seconds).toBe(25200);
    expect(row.resting_heart_rate).toBeNull();
    expect(hasAnySignal(row)).toBe(true);
  });

  test('sleeping_seconds 回退到 summary.sleepingSeconds（睡眠端点缺数据时）', () => {
    const row = normalizeDailyWellness({
      date: '2026-11-15',
      summary: { sleepingSeconds: 21600 },
      hrv: null,
      sleep: null,
    });
    expect(row.sleeping_seconds).toBe(21600);
  });

  test('非法日期抛错', () => {
    expect(() => normalizeDailyWellness({ date: '2026-1-5' })).toThrow(/非法日期/);
    expect(() => normalizeDailyWellness({})).toThrow(/非法日期/);
  });

  test('steps=0 是有效值，不能被当成缺失', () => {
    const row = normalizeDailyWellness({
      date: '2026-11-15',
      summary: { totalSteps: 0, restingHeartRate: 0 },
      hrv: null,
      sleep: null,
    });
    expect(row.total_steps).toBe(0);
    expect(row.resting_heart_rate).toBe(0);
    expect(hasAnySignal(row)).toBe(true);
  });

  test('自定义 source / fetchedAt 可透传（便于回填脚本区分来源）', () => {
    const row = normalizeDailyWellness({
      date: '2026-11-15',
      summary: {},
      source: 'backfill',
      fetchedAt: '2026-11-15T00:00:00.000Z',
    });
    expect(row.source).toBe('backfill');
    expect(row.fetched_at).toBe('2026-11-15T00:00:00.000Z');
  });
});
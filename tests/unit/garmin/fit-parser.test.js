/**
 * Garmin FIT 解析器单元测试
 *
 * 覆盖三类已修复缺陷（回归防护）：
 *   1. garmin_vo2max 双重换算（解析器已完成 scale 换算，业务层不得再乘 65536/3.5）
 *   2. devices 重复上报（同一 device_index 多次出现，需按 index 去重）
 *   3. time_in_zone 只取边界、丢失各区间停留时间与阈值元数据
 * 另覆盖 _safeGet* 的 NaN 防护与 device_type 枚举解析。
 * @jest-environment node
 */

const GarminFITParser = require('../../../scripts/garmin/fit-parser');

describe('fit-parser: _extractActivityMetrics（VO2max / 恢复时间）', () => {
  let p;
  beforeEach(() => { p = new GarminFITParser(); });

  test('vo2_max 直接取用解析器已换算的值，不再二次放大', () => {
    // 解析器输出 55.015 ml/kg/min（原始 uint32 已按 scale 65536/3.5 还原）
    const out = p._extractActivityMetrics({ activity_metrics: [{ vo2_max: 55.015464782714844 }] });
    expect(out.garmin_vo2max).toBe(55);
    // 关键回归断言：绝不能出现百万量级
    expect(out.garmin_vo2max).toBeLessThan(100);
  });

  test('recovery_time 单位即分钟，不做换算', () => {
    const out = p._extractActivityMetrics({ activity_metrics: [{ recovery_time: 1454 }] });
    expect(out.recovery_time).toBe(1454);
  });

  test('recovery_time = 0（无需恢复）被视为有效值', () => {
    const out = p._extractActivityMetrics({ activity_metrics: [{ recovery_time: 0 }] });
    expect(out.recovery_time).toBe(0);
  });

  test('超出人类合理区间的 vo2_max 被拒绝，不落脏数据', () => {
    // 模拟解析器 scale 缺失时可能吐出的原始 uint32
    expect(p._extractActivityMetrics({ activity_metrics: [{ vo2_max: 3607101 }] }).garmin_vo2max).toBeUndefined();
    expect(p._extractActivityMetrics({ activity_metrics: [{ vo2_max: 5 }] }).garmin_vo2max).toBeUndefined();
  });

  test('primary_benefit 枚举映射为中文', () => {
    expect(p._extractActivityMetrics({ activity_metrics: [{ primary_benefit: 5 }] }).primary_benefit).toBe('VO2max');
    expect(p._extractActivityMetrics({ activity_metrics: [{ primary_benefit: 3 }] }).primary_benefit).toBe('有氧阈值');
  });

  test('缺失 activity_metrics 时返回空对象', () => {
    expect(p._extractActivityMetrics({})).toEqual({});
    expect(p._extractActivityMetrics({ activity_metrics: [] })).toEqual({});
  });
});

describe('fit-parser: _extractDevices（去重与枚举解析）', () => {
  let p;
  beforeEach(() => { p = new GarminFITParser(); });

  test('按 device_index 去重，保留信息最完整的一条', () => {
    const fitData = {
      device_infos: [
        // 同一手表（index 0）被上报三次，信息逐渐完整
        { device_index: 0, manufacturer: 'garmin', product: 3992 },
        { device_index: 0, manufacturer: 'garmin', product: 3992, software_version: 29.05 },
        { device_index: 0, manufacturer: 'garmin', product: 3992, software_version: 29.05, battery_level: 88 },
        // 子设备也被重复上报
        { device_index: 2, device_type: 'gps', manufacturer: 'garmin', product: 3865, software_version: 13 },
        { device_index: 2, device_type: 'gps', manufacturer: 'garmin', product: 3865 },
      ],
    };
    const devices = JSON.parse(p._extractDevices(fitData).devices);
    expect(devices).toHaveLength(2); // 关键回归：5 条压到 2 台设备
    // index 0 保留了最完整的一条
    expect(devices[0]).toMatchObject({
      device_index: 0, product: 3992, firmware: 29.05, battery_level: 88,
    });
    // 子设备去重后仍保留固件号
    expect(devices[1]).toMatchObject({ device_index: 2, device_type: 'GPS', firmware: 13 });
  });

  test('主设备（index 0，无 device_type）识别为运动手表', () => {
    const out = JSON.parse(p._extractDevices({
      device_infos: [{ device_index: 0, manufacturer: 'garmin', product: 3992 }],
    }).devices);
    expect(out[0].device_type).toBe('运动手表');
  });

  test('local_device_type 子传感器映射为中文', () => {
    const out = JSON.parse(p._extractDevices({
      device_infos: [
        { device_index: 1, device_type: 'barometer', source_type: 'local' },
        { device_index: 3, device_type: 'accelerometer', source_type: 'local' },
        { device_index: 5, device_type: 'whr', source_type: 'local' },
        { device_index: 6, device_type: 'sensor_hub', source_type: 'local' },
      ],
    }).devices);
    expect(out.map(d => d.device_type)).toEqual(['气压计', '加速度计', '腕式心率', '传感器中枢']);
  });

  test('source_type=local 且数字未知时不误套主枚举（避免"智能骑行台"误判）', () => {
    // 8 在 device_type 主枚举里是"智能骑行台"，但 local 场景下不是
    const out = JSON.parse(p._extractDevices({
      device_infos: [{ device_index: 4, device_type: 8, source_type: 'local', manufacturer: 65535 }],
    }).devices);
    expect(out[0].device_type).not.toBe('智能骑行台');
    expect(out[0].device_type).toBe('local_8');
  });

  test('manufacturer 65535 归为未知', () => {
    const out = JSON.parse(p._extractDevices({
      device_infos: [{ device_index: 0, manufacturer: 65535, product: 0 }],
    }).devices);
    expect(out[0].manufacturer).toBe('未知');
  });

  test('脱敏：输出不含 serial_number', () => {
    const raw = p._extractDevices({
      device_infos: [{ device_index: 0, serial_number: 3615942009, manufacturer: 'garmin', product: 3992 }],
    }).devices;
    expect(raw).not.toContain('3615942009');
    expect(raw).not.toContain('serial_number');
  });

  test('无 device_infos 时返回空对象', () => {
    expect(p._extractDevices({})).toEqual({});
  });
});

describe('fit-parser: _extractZoneBoundaries（区间边界 + 停留时间 + 阈值）', () => {
  let p;
  beforeEach(() => { p = new GarminFITParser(); });

  const sessionZone = {
    reference_mesg: 18,
    hr_zone_high_boundary: [97, 117, 136, 155, 175, 194],
    power_zone_high_boundary: [221, 272, 311, 343, 395, 4000, null, null],
    time_in_hr_zone: [0, 18.261, 431.537, 1043.219, 348.913, 795.905, 0],
    time_in_power_zone: [656.066, 551.953, 272.981, 612.837, 543.998, 0, 0, 0],
    threshold_heart_rate: 174,
    resting_heart_rate: 46,
    max_heart_rate: 194,
    functional_threshold_power: 343,
  };

  test('区间边界照常提取', () => {
    const out = p._extractZoneBoundaries({ time_in_zone: [sessionZone] });
    expect(JSON.parse(out.hr_zone_boundaries)).toEqual([97, 117, 136, 155, 175, 194]);
    expect(JSON.parse(out.power_zone_boundaries)).toEqual([221, 272, 311, 343, 395, 4000, null, null]);
  });

  test('补齐各区间停留时间（此前被丢弃）', () => {
    const out = p._extractZoneBoundaries({ time_in_zone: [sessionZone] });
    expect(out.time_in_hr_zone).toBeDefined();
    // 浮点噪声收敛到 1 位小数
    expect(JSON.parse(out.time_in_hr_zone)).toEqual([0, 18.3, 431.5, 1043.2, 348.9, 795.9, 0]);
    expect(JSON.parse(out.time_in_power_zone)).toEqual([656.1, 552, 273, 612.8, 544, 0, 0, 0]);
  });

  test('补齐阈值元数据（此前被丢弃）', () => {
    const out = p._extractZoneBoundaries({ time_in_zone: [sessionZone] });
    expect(out.threshold_heart_rate).toBe(174);
    expect(out.resting_heart_rate_fit).toBe(46);
    expect(out.max_heart_rate_fit).toBe(194);
    expect(out.functional_threshold_power).toBe(343);
  });

  test('只取 session 级（reference_mesg=18），忽略 lap 级', () => {
    const out = p._extractZoneBoundaries({
      time_in_zone: [
        { reference_mesg: 19, hr_zone_high_boundary: [1, 2, 3] }, // lap 级，应被跳过
        sessionZone,
      ],
    });
    expect(JSON.parse(out.hr_zone_boundaries)).toEqual([97, 117, 136, 155, 175, 194]);
  });

  test('越界阈值被拒绝', () => {
    const out = p._extractZoneBoundaries({
      time_in_zone: [{ reference_mesg: 18, threshold_heart_rate: 9999, functional_threshold_power: 0 }],
    });
    expect(out.threshold_heart_rate).toBeUndefined();
    expect(out.functional_threshold_power).toBeUndefined();
  });

  test('无 time_in_zone 时返回空对象', () => {
    expect(p._extractZoneBoundaries({})).toEqual({});
  });
});

describe('fit-parser: _safeGet* 数值防护', () => {
  let p;
  beforeEach(() => { p = new GarminFITParser(); });

  test('非数字一律返回 null，不泄漏 NaN', () => {
    expect(p._safeGetFloat({ a: 'abc' }, 'a')).toBeNull();
    expect(p._safeGetFloat({ a: '' }, 'a')).toBeNull();
    expect(p._safeGetFloat({ a: {} }, 'a')).toBeNull();
    expect(p._safeGetInt({ a: 'abc' }, 'a')).toBeNull();
    expect(p._safeGetFloat({ a: null }, 'a')).toBeNull();
    expect(p._safeGetFloat({ a: undefined }, 'a')).toBeNull();
  });

  test('数值正常解析', () => {
    expect(p._safeGetFloat({ a: '3.14' }, 'a')).toBeCloseTo(3.14, 5);
    expect(p._safeGetInt({ a: '42' }, 'a')).toBe(42);
    // 字符串 '150.6' 此前被 parseInt 截成 150，现按四舍五入
    expect(p._safeGetInt({ a: '150.6' }, 'a')).toBe(151);
  });

  test('Infinity 被拒绝', () => {
    expect(p._safeGetFloat({ a: Infinity }, 'a')).toBeNull();
  });
});

describe('fit-parser: 端到端（真实 FIT 文件，若存在）', () => {
  const fs = require('fs');
  const CANDIDATES = [
    '/mnt/oci-block/garmin/fit/635138184.fit',
  ];
  const existing = CANDIDATES.find(f => fs.existsSync(f));

  // 真实语料不一定存在于 CI，缺失时跳过而非失败
  if (!existing) {
    test.skip('真实 FIT 端到端校验（无语料，跳过）', () => {});
    return;
  }

  test('解析真实文件：VO2max 合理、设备无重复、区间时间齐全', async () => {
    const p = new GarminFITParser();
    const { activity, laps, records } = await p.parseFitFile(existing);

    expect(activity).not.toBeNull();
    // 人类 VO2max 合理区间
    expect(activity.garmin_vo2max).toBeGreaterThanOrEqual(20);
    expect(activity.garmin_vo2max).toBeLessThanOrEqual(90);
    // 恢复时间单位为分钟，不应是秒级放大值
    expect(activity.recovery_time).toBeGreaterThanOrEqual(0);

    // 设备去重：device_index 唯一
    const devices = JSON.parse(activity.devices);
    const indexes = devices.map(d => d.device_index);
    expect(new Set(indexes).size).toBe(indexes.length);
    expect(devices.length).toBeGreaterThan(0);

    // 区间停留时间已补齐且和为正当活动时长
    expect(activity.time_in_hr_zone).toBeTruthy();
    const hrZones = JSON.parse(activity.time_in_hr_zone);
    const zoneSum = hrZones.reduce((a, b) => a + b, 0);
    expect(zoneSum).toBeGreaterThan(0);
    expect(zoneSum).toBeLessThanOrEqual(activity.duration + 60);

    expect(laps.length).toBeGreaterThan(0);
    expect(records.length).toBeGreaterThan(0);
  }, 30000);
});

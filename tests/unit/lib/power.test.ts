/**
 * `app/lib/power.ts` —— 功率强度派生层（IF / TSS / W·kg⁻¹ / FTP / 峰值功率）。
 *
 * 守的是四类**真实缺陷**（每条都有真实库样本）：
 *
 *  1. `intensity_factor` / `training_stress_score` / `average_power_to_weight`
 *     三列 **0/348** 有值 —— 但输入全在（NP 241/241、FTP 241/241、体重 241/241）。
 *     旧实现把「设备从不写入」等同于「不存在」，于是模型永远看不到强度因子。
 *  2. FTP 只有 33/348 显式有值，但 `power_zone_boundaries[3]` 恒等于 FTP
 *     （33/33 逐条相等）—— 这是把覆盖率提到 241/348 的依据。
 *  3. `max_power` 是逐秒瞬时峰值（548397123: 均 306W / 峰 3866W = 12.6 倍，
 *     67kg 即 57.7 W/kg，世界级场地车手冲刺也只有 20–25），不能直接展示，
 *     更不能参与任何派生。同一陷阱在 `max_speed` 上已踩过一次。
 *  4. TSS 的时间基数必须是 `moving_time`（timer time）而不是 `duration`
 *     （elapsed，含暂停；110/348 条活动两者最多差 7845 秒）。
 */
import {
  FTP_MAX_W,
  FTP_MIN_W,
  PEAK_POWER_RATIO_MAX,
  intensityFactor,
  peakPower,
  powerIntensity,
  powerToWeight,
  resolveFtp,
  trainingStressScore,
} from '@/app/lib/power';

describe('resolveFtp —— 设备显式值优先，缺失回退功率区间边界', () => {
  test('设备显式 FTP 直接采信，来源标记 device', () => {
    expect(resolveFtp({ functional_threshold_power: 343 })).toEqual({ watts: 343, source: 'device' });
  });

  test('设备未写时取 power_zone_boundaries[3]（真实库 241/241 的普遍路径）', () => {
    // 真实样本 536178521: [241,297,334,371,427,4000,null,null] → FTP 371
    const r = resolveFtp({ power_zone_boundaries: '[241,297,334,371,427,4000,null,null]' });
    expect(r).toEqual({ watts: 371, source: 'zone-boundary' });
  });

  test('设备值与区间边界冲突时以设备为准', () => {
    // 固件若改口径，显式字段永远比推断可靠。
    expect(resolveFtp({ functional_threshold_power: 350, power_zone_boundaries: '[241,297,334,371,427]' })).toEqual({
      watts: 350,
      source: 'device',
    });
  });

  test('越界的显式 FTP 不采信，回退区间边界', () => {
    // 33/348 真实值域 338–345；低于 100 更像缺失（FIT 里 0 表示未设置）。
    expect(resolveFtp({ functional_threshold_power: 0, power_zone_boundaries: '[241,297,334,371,427]' })).toEqual({
      watts: 371,
      source: 'zone-boundary',
    });
    expect(resolveFtp({ functional_threshold_power: 9999, power_zone_boundaries: '[241,297,334,371,427]' })).toEqual({
      watts: 371,
      source: 'zone-boundary',
    });
  });

  test('两者都不可用时返回 null —— 不猜、不填默认值', () => {
    // 编造的 FTP 会让 IF/TSS 全错，比缺值更糟。
    expect(resolveFtp({})).toBeNull();
    expect(resolveFtp({ functional_threshold_power: null, power_zone_boundaries: null })).toBeNull();
    expect(resolveFtp({ power_zone_boundaries: 'not json' })).toBeNull();
    expect(resolveFtp({ power_zone_boundaries: '[1,2,3]' })).toBeNull(); // 长度不足
    expect(resolveFtp({ power_zone_boundaries: '[1,2,3,4]' })).toBeNull(); // 索引 3 越界区间
  });

  test('区间边界必须真的呈「递增的区间数组」形状', () => {
    // 防未来固件把别的语义写进同一列：前 4 个上界必须严格递增。
    expect(resolveFtp({ power_zone_boundaries: '[300,290,280,270]' })).toBeNull();
    // 第 5 个上界若存在必须大于 FTP（Z5 上界）。
    expect(resolveFtp({ power_zone_boundaries: '[241,297,334,371,300]' })).toBeNull();
    // 前 4 个全为 null（未配置）也拒绝。
    expect(resolveFtp({ power_zone_boundaries: '[null,null,null,null,null,null,null,null]' })).toBeNull();
  });

  test('FTP 边界值恰好等于上下限时接受', () => {
    expect(resolveFtp({ functional_threshold_power: FTP_MIN_W })).toEqual({ watts: FTP_MIN_W, source: 'device' });
    expect(resolveFtp({ functional_threshold_power: FTP_MAX_W })).toEqual({ watts: FTP_MAX_W, source: 'device' });
  });
});

describe('intensityFactor —— IF = NP / FTP，越界返回 null', () => {
  test('正常范围四舍五入到 2 位', () => {
    expect(intensityFactor(303, 371)).toBe(0.82);
    expect(intensityFactor(333, 338)).toBe(0.99);
  });

  test('越界（NP/FTP 取错）返回 null 而不是输出怪物数字', () => {
    expect(intensityFactor(100, 400)).toBeNull(); // 0.25 < 0.3
    expect(intensityFactor(900, 400)).toBeNull(); // 2.25 > 1.5
  });

  test('缺值/非正数返回 null', () => {
    expect(intensityFactor(null, 371)).toBeNull();
    expect(intensityFactor(303, 0)).toBeNull();
    expect(intensityFactor(303, NaN)).toBeNull();
  });
});

describe('trainingStressScore —— 时间基数必须是移动时间', () => {
  test('1 小时阈值 = 100 TSS（定义自洽）', () => {
    expect(trainingStressScore(3600, 1)).toBe(100);
  });

  test('真实样本 536178521: 2201s × 0.8167² × 100 ≈ 41', () => {
    expect(trainingStressScore(2201, 0.82)).toBe(41);
  });

  test('零/负时长或非法 IF 返回 null', () => {
    expect(trainingStressScore(0, 0.8)).toBeNull();
    expect(trainingStressScore(3600, null)).toBeNull();
    expect(trainingStressScore(3600, 0)).toBeNull();
    expect(trainingStressScore(null, 0.8)).toBeNull();
  });

  test('超过 TSS_MAX 的离谱值返回 null（防输入错配）', () => {
    // 真实库 TSS 值域 5–138；10 小时 × IF 1.4 已不可能出现在跑步里。
    expect(trainingStressScore(36000, 1.4)).toBeNull();
  });
});

describe('powerToWeight —— 平均功率 / 体重，不碰瞬时峰值', () => {
  test('真实样本: 292W / 68.5kg ≈ 4.26 W/kg', () => {
    expect(powerToWeight(292, 68.5)).toBe(4.26);
  });

  test('用 max_power 会产出不存在的怪物数据 —— 故越界直接拒绝', () => {
    // 548397123: max_power 3866W / 67kg = 57.7 W/kg（世界级场地车手冲刺 20–25）。
    expect(powerToWeight(3866, 67)).toBeNull();
  });

  test('体重越界或缺失返回 null', () => {
    expect(powerToWeight(292, 0)).toBeNull();
    expect(powerToWeight(292, null)).toBeNull();
    expect(powerToWeight(292, 10)).toBeNull(); // < 30kg
    expect(powerToWeight(null, 68.5)).toBeNull();
  });
});

describe('peakPower —— 峰值功率只在相对均值合理时才展示', () => {
  test('正常峰值（≤3 倍均值）原样返回', () => {
    expect(peakPower(810, 271)).toBe(810); // 2.99 倍
    expect(peakPower(413, 309)).toBe(413);
  });

  test('传感器尖峰（>3 倍均值）判为脏数据返回 null', () => {
    // 548397123: 3866 / 306 = 12.6 倍。真实库 241 条里 7 条超过 3 倍。
    expect(peakPower(3866, 306)).toBeNull();
    expect(peakPower(554, 96)).toBeNull(); // 5.77 倍
  });

  test('恰好 3 倍边界接受（含等号）', () => {
    expect(peakPower(900, 300)).toBe(900);
    expect(peakPower(901, 300)).toBeNull();
  });

  test('缺值返回 null', () => {
    expect(peakPower(null, 300)).toBeNull();
    expect(peakPower(400, null)).toBeNull();
    expect(peakPower(400, 0)).toBeNull();
  });

  test('PEAK_POWER_RATIO_MAX 是 3（改动需同步本节阈值断言）', () => {
    expect(PEAK_POWER_RATIO_MAX).toBe(3);
  });
});

describe('powerIntensity —— 汇总，各字段独立可空', () => {
  test('完整输入时五项全出，且 TSS 用移动时间而非总时长', () => {
    const p = powerIntensity({
      power_zone_boundaries: '[241,297,334,371,427,4000,null,null]',
      normalized_power: 303,
      average_power: 292,
      max_power: 437,
      moving_time: 2201,
      duration: 5000, // 故意远大于 moving_time：若误用 duration，TSS 会翻倍
      user_weight: 68.5,
    });
    expect(p.ftpW).toBe(371);
    expect(p.ftpSource).toBe('zone-boundary');
    expect(p.intensityFactor).toBe(0.82);
    expect(p.trainingStressScore).toBe(41); // 2201s 而非 5000s
    expect(p.powerToWeight).toBe(4.26);
    expect(p.peakPowerW).toBe(437);
  });

  test('只有平均功率与体重时，只出功率体重比，其余为 null', () => {
    const p = powerIntensity({ average_power: 292, user_weight: 68.5 });
    expect(p.ftpW).toBeNull();
    expect(p.intensityFactor).toBeNull();
    expect(p.trainingStressScore).toBeNull();
    expect(p.powerToWeight).toBe(4.26);
    expect(p.peakPowerW).toBeNull();
  });

  test('全空输入时五项全为 null（不抛异常）', () => {
    const p = powerIntensity({});
    expect(Object.values(p).every((v) => v === null)).toBe(true);
  });

  test('moving_time 缺失时回退 duration（仅该活动没写 timer time 才会发生）', () => {
    const p = powerIntensity({
      functional_threshold_power: 371,
      normalized_power: 303,
      moving_time: 0,
      duration: 2201,
    });
    expect(p.trainingStressScore).toBe(41);
  });

  test('设备将来写入显式 IF/TSS/W·kg⁻¹ 时直接采信，不用推算值覆盖', () => {
    const p = powerIntensity({
      functional_threshold_power: 371,
      normalized_power: 303,
      average_power: 292,
      user_weight: 68.5,
      intensity_factor: 0.85,
      training_stress_score: 99,
      average_power_to_weight: 4.5,
    });
    expect(p.intensityFactor).toBe(0.85);
    expect(p.trainingStressScore).toBe(99);
    expect(p.powerToWeight).toBe(4.5);
  });

  test('显式值越界时回退推算（防脏列污染）', () => {
    const p = powerIntensity({
      functional_threshold_power: 371,
      normalized_power: 303,
      average_power: 292,
      user_weight: 68.5,
      moving_time: 2201,
      intensity_factor: 99, // 离谱
      training_stress_score: 99999,
      average_power_to_weight: 999,
    });
    expect(p.intensityFactor).toBe(0.82);
    expect(p.trainingStressScore).toBe(41);
    expect(p.powerToWeight).toBe(4.26);
  });
});
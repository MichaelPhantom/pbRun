/**
 * `scripts/garmin/fit-workout.js` —— FIT 课表重扫模块。
 *
 * 守三类真实缺陷：
 *  1. `fit-file-parser@2.3.3` 对 `workout_step` 走 `default:` 分支（覆盖而非 push），
 *     多步课表只剩最后一步 —— 真实库 120 条多步课表全部受影响；
 *  2. `duration_value` 在 `duration_type='time'` 时是**毫秒**；
 *  3. `custom_target_value_*` 在 `target_type='speed'` 时是 **mm/s**。
 *
 * 真实 FIT 样本在 `.cache/fit/`（不入库），故这里用手工构造的 FIT 字节流：
 * 用最小的 definition+data 记录验证「重扫能拿到多条 workout_step」这条核心能力。
 */
const {
  DURATION_TYPE_LABELS,
  INTENSITY_LABELS,
  formatWorkoutStep,
  formatWorkoutSummary,
  mmpsToSecPerKm,
  normalizeWorkoutStep,
  normalizeWorkoutSteps,
  readRawWorkoutSteps,
} = require('../../../scripts/garmin/fit-workout');

describe('mmpsToSecPerKm', () => {
  test('mm/s → 秒/公里 (速度与配速反向)', () => {
    expect(mmpsToSecPerKm(2888)).toBe(346); // 2.888 m/s
    expect(mmpsToSecPerKm(3250)).toBe(308); // 3.25 m/s
    expect(mmpsToSecPerKm(5000)).toBeLessThan(mmpsToSecPerKm(2000));
  });

  test('非正/空 → null', () => {
    expect(mmpsToSecPerKm(0)).toBeNull();
    expect(mmpsToSecPerKm(-1)).toBeNull();
    expect(mmpsToSecPerKm(null)).toBeNull();
    expect(mmpsToSecPerKm(undefined)).toBeNull();
  });
});

describe('normalizeWorkoutStep —— 单位换算', () => {
  /** 真实 FIT 消息形状（540880879 第 2 步）。 */
  const raw = {
    duration_value: 1320000,
    target_value: 0,
    custom_target_value_low: 3527,
    custom_target_value_high: 3805,
    message_index: { value: 1 },
    wkt_step_name: '',
    duration_type: 'time',
    target_type: 'speed',
    intensity: 'interval',
  };

  test('毫秒 → 秒 (1320000ms = 22 分钟, 不是 15.3 天)', () => {
    const s = normalizeWorkoutStep(raw, 1);
    expect(s.duration_sec).toBe(1320);
    expect(s.duration_sec).not.toBe(1320000);
  });

  test('mm/s → 秒/公里区间 (fast 数值更小)', () => {
    const s = normalizeWorkoutStep(raw, 1);
    expect(s.target_pace_sec_per_km).toEqual({ fast: 263, slow: 284 });
  });

  test('保留设备原始值供追溯', () => {
    const s = normalizeWorkoutStep(raw, 1);
    expect(s.target_low).toBe(3527);
    expect(s.target_high).toBe(3805);
    expect(s.target_type).toBe('speed');
  });

  test('中文标签 (强度/时长类型)', () => {
    const s = normalizeWorkoutStep(raw, 1);
    expect(s.intensity_label).toBe('间歇');
    expect(s.duration_type_label).toBe('时长');
  });

  test('距离步厘米 → 米; 次数步保留 reps; 开放式无时长', () => {
    expect(
      normalizeWorkoutStep({ duration_type: 'distance', duration_value: 500000 }, 0).distance_m,
    ).toBe(5000);
    expect(normalizeWorkoutStep({ duration_type: 'reps', duration_value: 12 }, 0).reps).toBe(12);
    const open = normalizeWorkoutStep({ duration_type: 'open' }, 0);
    expect(open.duration_sec).toBeNull();
    expect(open.distance_m).toBeNull();
    expect(open.reps).toBeNull();
  });

  test('message_index 裸数字 / 缺失时回落到位置序号', () => {
    expect(normalizeWorkoutStep({ message_index: 4 }, 0).index).toBe(4);
    expect(normalizeWorkoutStep({}, 3).index).toBe(3);
  });

  test('非 speed 目标不产生配速区间', () => {
    expect(
      normalizeWorkoutStep({ target_type: 'open', custom_target_value_low: 1000 }, 0)
        .target_pace_sec_per_km,
    ).toBeNull();
    // 单边缺失也不产生 (不能除以 null)
    expect(
      normalizeWorkoutStep({ target_type: 'speed', custom_target_value_low: 3000 }, 0)
        .target_pace_sec_per_km,
    ).toBeNull();
  });
});

describe('normalizeWorkoutSteps', () => {
  test('多步全部保留并按 index 升序 (旧实现只剩最后一步)', () => {
    const steps = normalizeWorkoutSteps([
      { message_index: { value: 2 }, duration_value: 600000, duration_type: 'time', intensity: 'cooldown' },
      { message_index: { value: 0 }, duration_value: 600000, duration_type: 'time', intensity: 'warmup' },
      { message_index: { value: 1 }, duration_value: 1320000, duration_type: 'time', intensity: 'interval' },
    ]);
    expect(steps).toHaveLength(3);
    expect(steps.map((s) => s.intensity)).toEqual(['warmup', 'interval', 'cooldown']);
  });

  test('FIT 占位步 (intensity=255 且 target=255 且无时长) 被剔除', () => {
    const steps = normalizeWorkoutSteps([
      { message_index: { value: 0 }, duration_value: 60000, duration_type: 'time', intensity: 'active' },
      // 真实库 50 条这样的填充/循环控制消息
      { message_index: { value: 1 }, duration_value: 0, duration_type: 'reps', target_type: 255, intensity: 255 },
    ]);
    expect(steps).toHaveLength(1);
  });

  test('非数组 / 空 → 空数组', () => {
    expect(normalizeWorkoutSteps(null)).toEqual([]);
    expect(normalizeWorkoutSteps(undefined)).toEqual([]);
    expect(normalizeWorkoutSteps([])).toEqual([]);
    expect(normalizeWorkoutSteps('oops')).toEqual([]);
  });
});

describe('readRawWorkoutSteps', () => {
  test('非 Buffer / 空值 → null (调用方回退旧路径)', () => {
    expect(readRawWorkoutSteps(null)).toBeNull();
    expect(readRawWorkoutSteps(undefined)).toBeNull();
    expect(readRawWorkoutSteps('string')).toBeNull();
    expect(readRawWorkoutSteps({})).toBeNull();
  });

  test('过短/损坏字节流 → null, 不抛异常', () => {
    expect(readRawWorkoutSteps(Buffer.alloc(0))).toBeNull();
    expect(readRawWorkoutSteps(Buffer.alloc(10))).toBeNull();
    expect(readRawWorkoutSteps(Buffer.alloc(200))).toBeNull();
  });

  /**
   * 真实 FIT 文件（`.cache/fit/` 不入库）在 CI 上不存在，故这里手工构造一个
   * 只含 `workout_step` 消息的最小 FIT 字节流，验证「重扫能拿到**多条**」——
   * 这正是旧实现做不到的那一步（它只能拿到 `fitData.workout_step` 的单对象）。
   */
  test('手工构造的 FIT 字节能重扫出多条 workout_step', () => {
    const buffer = buildMinimalFit([
      workoutStepRecord({ index: 0, durationMs: 600000, intensity: 2 /* warmup */ }),
      workoutStepRecord({ index: 1, durationMs: 1320000, intensity: 5 /* interval */ }),
      workoutStepRecord({ index: 2, durationMs: 600000, intensity: 3 /* cooldown */ }),
    ]);
    const raw = readRawWorkoutSteps(buffer);
    expect(raw).not.toBeNull();
    expect(raw).toHaveLength(3);
    const norm = normalizeWorkoutSteps(raw);
    expect(norm).toHaveLength(3);
    expect(norm.map((s) => s.intensity)).toEqual(['warmup', 'interval', 'cooldown']);
    expect(norm[1].duration_sec).toBe(1320);
  });

  test('无 workout_step 的文件 → null (不是空数组)', () => {
    expect(readRawWorkoutSteps(buildMinimalFit([]))).toBeNull();
  });
});

describe('formatWorkoutStep / formatWorkoutSummary', () => {
  test('单步文案: 强度 + 时长 + 目标配速区间 (慢-快)', () => {
    const s = normalizeWorkoutStep(
      { duration_type: 'time', duration_value: 600000, target_type: 'speed', custom_target_value_low: 2888, custom_target_value_high: 3250, intensity: 'warmup' },
      0,
    );
    // 慢端在前: 5:46(346) - 5:08(308)
    expect(formatWorkoutStep(s)).toBe('热身 10:00 @ 5:46-5:08/km');
  });

  test('距离/次数/开放式文案', () => {
    expect(
      formatWorkoutStep(normalizeWorkoutStep({ duration_type: 'distance', duration_value: 500000, intensity: 'active' }, 0)),
    ).toBe('主课 5.00km');
    expect(
      formatWorkoutStep(normalizeWorkoutStep({ duration_type: 'reps', duration_value: 8, intensity: 'active' }, 0)),
    ).toBe('主课 ×8');
    expect(
      formatWorkoutStep(normalizeWorkoutStep({ duration_type: 'open', intensity: 'active' }, 0)),
    ).toBe('主课 开放式');
  });

  test('摘要: 多步用 → 连接, 超过 maxSteps 标注剩余', () => {
    const steps = normalizeWorkoutSteps(
      [0, 1, 2, 3].map((i) => ({
        message_index: { value: i },
        duration_value: 60000 * (i + 1),
        duration_type: 'time',
        intensity: 'active',
      })),
    );
    const short = formatWorkoutSummary(steps, 2);
    expect(short).toContain('→');
    expect(short).toContain('…(+2 步)');
    expect(formatWorkoutSummary(steps, 10)).not.toContain('…');
  });

  test('无可执行步 / 空 → null (不输出空壳)', () => {
    expect(formatWorkoutSummary([])).toBeNull();
    expect(formatWorkoutSummary(null)).toBeNull();
    expect(formatWorkoutSummary(normalizeWorkoutSteps([{ duration_type: 'repeat_until_steps_cmplt', intensity: 'active' }]))).toBeNull();
  });
});

describe('标签表', () => {
  test('强度/时长类型覆盖真实库出现的取值', () => {
    // 真实库 intensity 分布: active/rest/interval/warmup/cooldown/recovery (+255 占位)
    for (const k of ['active', 'rest', 'interval', 'warmup', 'cooldown', 'recovery']) {
      expect(INTENSITY_LABELS[k]).toBeTruthy();
    }
    // duration_type 分布: time/reps/repeat_until_time/repeat_until_steps_cmplt/open
    for (const k of ['time', 'distance', 'open', 'reps', 'repeat_until_time', 'repeat_until_steps_cmplt']) {
      expect(DURATION_TYPE_LABELS[k]).toBeTruthy();
    }
  });
});

// ---------------------------------------------------------------------------
// 最小 FIT 字节流构造器（只为验证 readRecord 重扫路径，不含真实活动数据）
// ---------------------------------------------------------------------------

/** 一条 workout_step 的字段值（local message type 0 的 definition 见下）。 */
function workoutStepRecord({ index, durationMs, intensity }) {
  return { index, durationMs, intensity };
}

/**
 * 构造一个合法 FIT 头 + 一组 definition/data 记录。
 * 只定义 workout_step（global message number 27）用到的 5 个字段，字段号与
 * `fit-file-parser` 的 profile 一致：
 *   254 message_index(uint16) / 1 duration_type(uint8) / 2 duration_value(uint32)
 *   3 target_type(uint8) / 9 intensity(uint8)
 */
function buildMinimalFit(records) {
  const headerLength = 14;
  const dataChunks = [];

  if (records.length > 0) {
    // definition message: header 0x40 | localType 0
    const fieldDefs = [
      { num: 254, size: 2, baseType: 0x84 }, // message_index, uint16
      { num: 1, size: 1, baseType: 0x00 }, // duration_type, enum
      { num: 2, size: 4, baseType: 0x86 }, // duration_value, uint32
      { num: 3, size: 1, baseType: 0x00 }, // target_type, enum
      { num: 7, size: 1, baseType: 0x00 }, // intensity, enum (FIT profile field 7)
    ];
    const def = Buffer.alloc(6 + fieldDefs.length * 3);
    def.writeUInt8(0x40, 0); // definition message, normal header
    def.writeUInt8(0, 1); // reserved
    def.writeUInt8(0, 2); // architecture: little endian
    def.writeUInt16LE(27, 3); // global message number: workout_step
    def.writeUInt8(fieldDefs.length, 5);
    fieldDefs.forEach((f, i) => {
      const o = 6 + i * 3;
      def.writeUInt8(f.num, o);
      def.writeUInt8(f.size, o + 1);
      def.writeUInt8(f.baseType, o + 2);
    });
    dataChunks.push(def);

    for (const r of records) {
      const data = Buffer.alloc(1 + 2 + 1 + 4 + 1 + 1);
      data.writeUInt8(0x00, 0); // data message, local type 0
      data.writeUInt16LE(r.index, 1);
      data.writeUInt8(0, 3); // duration_type = time (FIT enum 0)
      data.writeUInt32LE(r.durationMs, 4);
      data.writeUInt8(2, 8); // target_type = open (不产生配速区间)
      data.writeUInt8(r.intensity, 9);
      dataChunks.push(data);
    }
  }

  const dataBuf = Buffer.concat(dataChunks);
  const header = Buffer.alloc(headerLength);
  header.writeUInt8(headerLength, 0);
  header.writeUInt8(0x10, 1); // protocol version
  header.writeUInt16LE(2132, 2); // profile version
  header.writeUInt32LE(dataBuf.length, 4);
  header.write(''.padEnd(4, '.'), 8); // placeholder, overwritten below
  header.write('.FIT', 8, 'ascii');
  // header CRC 用 0 即可: 模块以 force:true 解析, 不校验 CRC
  header.writeUInt16LE(0, 12);

  return Buffer.concat([header, dataBuf]);
}

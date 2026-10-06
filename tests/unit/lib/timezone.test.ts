/**
 * timezone 模块单元测试 (2026-10-06 时区缺陷修复的回归防护)。
 *
 * 该模块是"UTC 存储 + 本地墙钟展示"契约的唯一实现来源, 必须穷举边界:
 *   - UTC ↔ 本地墙钟双向换算 (含跨日/跨月/跨年);
 *   - 本地日期区间的 UTC 边界 (含端点、跨日);
 *   - 环境时区无关性 (代码不得依赖运行机器的 TZ);
 *   - 非法输入一律返回 null / 抛清晰错误 (不产生脏数据)。
 *
 * @jest-environment node
 */

import {
  LOCAL_TZ_OFFSET_MIN,
  hasExplicitTimezone,
  parseUtcMillis,
  toLocalWallClock,
  fromLocalWallClock,
  parseWallClockMillis,
  formatWallClock,
  localDateOf,
  localMonthOf,
  localDateRangeToUtc,
  todayLocalDate,
  localDateMinusDays,
  inferOffsetMinutes,
} from '@/app/lib/timezone';

describe('timezone 常量', () => {
  test('本地偏移为 Asia/Shanghai +08:00 (无夏令时)', () => {
    expect(LOCAL_TZ_OFFSET_MIN).toBe(480);
  });
});

describe('hasExplicitTimezone', () => {
  test.each([
    ['2026-10-06T07:41:39.000Z', true],
    ['2026-10-06T07:41:39+08:00', true],
    ['2026-10-06T07:41:39+0800', true],
    ['2026-10-06T07:41:39-05:00', true],
    ['2026-10-06T07:41:39.000', false],
    ['2026-10-06 07:41:39', false],
    ['2026-10-06', false],
  ])('%s → %s', (input, expected) => {
    expect(hasExplicitTimezone(input)).toBe(expected);
  });
});

describe('parseUtcMillis', () => {
  test('接受带 Z / 带偏移的绝对时刻', () => {
    expect(parseUtcMillis('1970-01-01T00:00:00.000Z')).toBe(0);
    // 本地 +08:00 的 08:00 与 UTC 00:00 是同一时刻
    expect(parseUtcMillis('1970-01-01T08:00:00+08:00')).toBe(0);
  });

  test('拒绝无时区标记的墙钟串 (避免把本地时间误当 UTC)', () => {
    expect(parseUtcMillis('2026-10-06T07:41:39.000')).toBeNull();
  });

  test('空值 / 非法返回 null', () => {
    expect(parseUtcMillis(null)).toBeNull();
    expect(parseUtcMillis(undefined)).toBeNull();
    expect(parseUtcMillis('')).toBeNull();
    expect(parseUtcMillis('not-a-date')).toBeNull();
  });
});

describe('toLocalWallClock / fromLocalWallClock 往返', () => {
  test('UTC → 本地墙钟 (跨日): 23:41Z 次日 07:41', () => {
    expect(toLocalWallClock('2026-10-05T23:41:39.000Z')).toBe('2026-10-06T07:41:39.000');
  });

  test('真实缺陷样本: 645128880 的 UTC 04:13:30 → 本地 12:13:30', () => {
    expect(toLocalWallClock('2026-09-29T04:13:30.000Z')).toBe('2026-09-29T12:13:30.000');
  });

  test('本地墙钟 → UTC (跨日反向)', () => {
    expect(fromLocalWallClock('2026-10-06T07:41:39.000')).toBe('2026-10-05T23:41:39.000Z');
  });

  test('往返恒等 (多组样本)', () => {
    const samples = [
      '2026-01-01T00:00:00.000Z',
      '2026-03-28T23:19:35.000Z',
      '2026-12-31T16:00:00.000Z',
      '2025-11-22T23:52:39.000Z',
    ];
    for (const utc of samples) {
      expect(fromLocalWallClock(toLocalWallClock(utc))).toBe(utc);
    }
  });

  test('自定义偏移 (非 +8) 也成立', () => {
    expect(toLocalWallClock('2026-10-06T00:00:00.000Z', 0)).toBe('2026-10-06T00:00:00.000');
    expect(toLocalWallClock('2026-10-06T00:00:00.000Z', -300)).toBe('2026-10-05T19:00:00.000');
  });

  test('非法输入 → null', () => {
    expect(toLocalWallClock(null)).toBeNull();
    expect(toLocalWallClock('2026-10-06T07:41:39.000')).toBeNull(); // 无时区标记
    expect(fromLocalWallClock('bad')).toBeNull();
    expect(fromLocalWallClock(null)).toBeNull();
  });
});

describe('parseWallClockMillis / formatWallClock', () => {
  test('按字面分量解析 (不含时区换算)', () => {
    expect(parseWallClockMillis('1970-01-01T00:00:00.000')).toBe(0);
    expect(parseWallClockMillis('1970-01-02T00:00:00.000')).toBe(86400000);
  });

  test('支持缺省秒 / 缺省毫秒 / 空格分隔', () => {
    expect(parseWallClockMillis('2026-10-06T07:41')).toBe(Date.UTC(2026, 9, 6, 7, 41, 0, 0));
    expect(parseWallClockMillis('2026-10-06 07:41:39')).toBe(Date.UTC(2026, 9, 6, 7, 41, 39, 0));
    expect(parseWallClockMillis('2026-10-06T07:41:39.5')).toBe(Date.UTC(2026, 9, 6, 7, 41, 39, 500));
  });

  test('非法 → null', () => {
    expect(parseWallClockMillis('')).toBeNull();
    expect(parseWallClockMillis(null)).toBeNull();
    expect(parseWallClockMillis('2026/10/06 07:41')).toBeNull();
    expect(parseWallClockMillis('2026-10-06T07:41:39Z')).toBeNull(); // 墙钟不应带 Z
  });

  test('formatWallClock 输出无 Z 且带毫秒', () => {
    expect(formatWallClock(0)).toBe('1970-01-01T00:00:00.000');
    expect(formatWallClock(Date.UTC(2026, 9, 6, 7, 41, 39, 0))).toBe('2026-10-06T07:41:39.000');
  });
});

describe('localDateOf / localMonthOf', () => {
  test('优先取 start_time_local 前 10 位', () => {
    expect(localDateOf({ start_time_local: '2026-10-06T07:41:39.000', start_time: '2026-10-05T23:41:39.000Z' })).toBe('2026-10-06');
  });

  test('start_time_local 缺失时用 start_time 按偏移换算 (兼容历史行)', () => {
    expect(localDateOf({ start_time_local: null, start_time: '2026-10-05T23:41:39.000Z' })).toBe('2026-10-06');
  });

  test('关键回归: 晨跑不被算到前一天', () => {
    // 本地 07:41 晨跑 = UTC 前一日 23:41 —— 旧实现会得到 10-05 (错)
    expect(localDateOf({ start_time_local: '2026-10-06T07:41:39.000' })).toBe('2026-10-06');
    expect(localMonthOf({ start_time_local: '2026-10-06T07:41:39.000' })).toBe('2026-10');
  });

  test('两者皆缺 / 非法 → null', () => {
    expect(localDateOf({})).toBeNull();
    expect(localDateOf({ start_time_local: '', start_time: 'garbage' })).toBeNull();
    expect(localMonthOf({ start_time_local: 'x' })).toBeNull();
  });
});

describe('localDateRangeToUtc', () => {
  test('单日区间: 本地 00:00:00.000 → 前一日 16:00Z; 本地 23:59:59.999 → 当日 15:59:59.999Z', () => {
    expect(localDateRangeToUtc('2026-10-06', '2026-10-06')).toEqual({
      startUtc: '2026-10-05T16:00:00.000Z',
      endUtc: '2026-10-06T15:59:59.999Z',
    });
  });

  test('跨月区间端点', () => {
    expect(localDateRangeToUtc('2026-07-01', '2026-07-31')).toEqual({
      startUtc: '2026-06-30T16:00:00.000Z',
      endUtc: '2026-07-31T15:59:59.999Z',
    });
  });

  test('区间包含本地整日 (边界自检: 本地当日 00:00 与 23:59:59.999 均落在区间内)', () => {
    const { startUtc, endUtc } = localDateRangeToUtc('2026-10-06', '2026-10-06');
    const dayStartUtc = new Date('2026-10-05T16:00:00.000Z').getTime();
    const dayEndUtc = new Date('2026-10-06T15:59:59.999Z').getTime();
    expect(dayStartUtc).toBeGreaterThanOrEqual(new Date(startUtc).getTime());
    expect(dayEndUtc).toBeLessThanOrEqual(new Date(endUtc).getTime());
  });

  test('非法日期抛清晰错误', () => {
    expect(() => localDateRangeToUtc('2026/10/06', '2026-10-06')).toThrow(/YYYY-MM-DD/);
    expect(() => localDateRangeToUtc('2026-10-06', '')).toThrow(/YYYY-MM-DD/);
  });
});

describe('todayLocalDate / localDateMinusDays', () => {
  test('按本地偏移取"今天" (UTC 深夜时本地已是次日)', () => {
    // UTC 2026-10-05T23:30Z → 本地 2026-10-06
    expect(todayLocalDate(new Date('2026-10-05T23:30:00Z'))).toBe('2026-10-06');
    // UTC 2026-10-05T10:00Z → 本地 2026-10-05
    expect(todayLocalDate(new Date('2026-10-05T10:00:00Z'))).toBe('2026-10-05');
  });

  test('回推按日历日 (跨月)', () => {
    expect(localDateMinusDays('2026-10-01', 1)).toBe('2026-09-30');
    expect(localDateMinusDays('2026-03-01', 1)).toBe('2026-02-28');
    expect(localDateMinusDays('2026-01-01', 1)).toBe('2025-12-31');
    expect(localDateMinusDays('2026-10-06', 7)).toBe('2026-09-29');
  });

  test('回推 0 天为自身', () => {
    expect(localDateMinusDays('2026-10-06', 0)).toBe('2026-10-06');
  });

  test('非法输入抛错', () => {
    expect(() => localDateMinusDays('bad', 1)).toThrow(/非法本地日期/);
  });
});

describe('inferOffsetMinutes', () => {
  test('真实样本推断出 +480', () => {
    expect(inferOffsetMinutes('2026-09-29T04:13:30.000Z', '2026-09-29T12:13:30.000')).toBe(480);
  });

  test('无法计算时返回 null', () => {
    expect(inferOffsetMinutes(null, '2026-09-29T12:13:30.000')).toBeNull();
    expect(inferOffsetMinutes('2026-09-29T04:13:30.000Z', null)).toBeNull();
    expect(inferOffsetMinutes('bad', 'also-bad')).toBeNull();
  });
});

describe('环境时区无关性 (不得依赖运行机器 TZ)', () => {
  const originalTz = process.env.TZ;
  afterEach(() => {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });

  test.each(['UTC', 'Asia/Shanghai', 'America/New_York'])(
    'TZ=%s 下换算结果一致',
    (tz) => {
      process.env.TZ = tz;
      expect(toLocalWallClock('2026-10-05T23:41:39.000Z')).toBe('2026-10-06T07:41:39.000');
      expect(localDateOf({ start_time_local: '2026-10-06T07:41:39.000' })).toBe('2026-10-06');
      expect(localDateRangeToUtc('2026-10-06', '2026-10-06')).toEqual({
        startUtc: '2026-10-05T16:00:00.000Z',
        endUtc: '2026-10-06T15:59:59.999Z',
      });
    },
  );
});

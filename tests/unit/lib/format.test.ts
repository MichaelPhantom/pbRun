import {
  formatPace,
  formatPaceShort,
  formatDistance,
  formatDistanceFromMeters,
  formatDuration,
  formatDurationRecord,
  formatDateTime,
  formatDate,
  formatListDateTime,
  formatMonthYear,
  formatInt,
  formatCadence,
  formatTemp,
  formatRecoveryTime,
} from '@/app/lib/format';

describe('format', () => {
  describe('formatPace', () => {
    test('应正确格式化配速', () => {
      expect(formatPace(300)).toBe('5:00 /km'); // 5:00/km
      expect(formatPace(330)).toBe('5:30 /km');
      expect(formatPace(420)).toBe('7:00 /km');
    });

    test('无单位时应只返回配速值', () => {
      expect(formatPace(300, false)).toBe('5:00');
    });

    test('null或NaN应返回--', () => {
      expect(formatPace(null)).toBe('--');
      expect(formatPace(undefined)).toBe('--');
      expect(formatPace(NaN)).toBe('--');
    });

    test('应正确处理秒数进位', () => {
      expect(formatPace(305)).toBe('5:05 /km');
      expect(formatPace(359)).toBe('5:59 /km');
    });

    test('回归: 秒数四舍五入到 60 时正确进位 (不出现 5:60)', () => {
      expect(formatPace(359.6)).toBe('6:00 /km');
      expect(formatPace(59.6, false)).toBe('1:00');
      expect(formatPace(299.5, false)).toBe('5:00');
    });
  });

  describe('formatPaceShort', () => {
    test('应正确格式化简短配速', () => {
      expect(formatPaceShort(297)).toBe("4'57''");
      expect(formatPaceShort(300)).toBe("5'00''");
      expect(formatPaceShort(305)).toBe("5'05''");
    });

    test('null或NaN应返回--', () => {
      expect(formatPaceShort(null)).toBe('--');
      expect(formatPaceShort(undefined)).toBe('--');
    });
  });

  describe('formatDistance', () => {
    test('应正确格式化距离(公里)', () => {
      expect(formatDistance(10)).toBe('10.00 km');
      expect(formatDistance(10.5)).toBe('10.50 km');
      expect(formatDistance(0)).toBe('0.00 km');
    });

    test('null或NaN应返回--', () => {
      expect(formatDistance(null)).toBe('--');
      expect(formatDistance(undefined)).toBe('--');
    });

    test('应保留两位小数', () => {
      expect(formatDistance(5.123)).toBe('5.12 km');
      expect(formatDistance(5.999)).toBe('6.00 km');
    });
  });

  describe('formatDistanceFromMeters', () => {
    test('应正确将米转换为公里', () => {
      expect(formatDistanceFromMeters(10000)).toBe('10.00 km');
      expect(formatDistanceFromMeters(5000)).toBe('5.00 km');
      expect(formatDistanceFromMeters(0)).toBe('0.00 km');
    });

    test('null或NaN应返回--', () => {
      expect(formatDistanceFromMeters(null)).toBe('--');
      expect(formatDistanceFromMeters(undefined)).toBe('--');
    });
  });

  describe('formatDuration', () => {
    test('应正确格式化小于1小时的时长', () => {
      expect(formatDuration(3599)).toBe('59:59');
    });

    test('应正确格式化等于1小时的时长', () => {
      expect(formatDuration(3600)).toBe('1:00:00');
    });

    test('应正确格式化大于1小时的时长', () => {
      expect(formatDuration(3661)).toBe('1:01:01');
      expect(formatDuration(7322)).toBe('2:02:02');
    });

    test('应正确格式化分钟和秒', () => {
      expect(formatDuration(65)).toBe('1:05');
      expect(formatDuration(125)).toBe('2:05');
    });

    test('null或NaN应返回--', () => {
      expect(formatDuration(null)).toBe('--');
      expect(formatDuration(undefined)).toBe('--');
    });

    test('应正确处理0秒', () => {
      expect(formatDuration(0)).toBe('0:00');
    });
  });

  describe('formatDurationRecord', () => {
    test('应始终返回HH:MM:SS格式', () => {
      expect(formatDurationRecord(3661)).toBe('01:01:01');
      expect(formatDurationRecord(65)).toBe('00:01:05');
      expect(formatDurationRecord(3600)).toBe('01:00:00');
    });

    test('null或NaN应返回--', () => {
      expect(formatDurationRecord(null)).toBe('--');
      expect(formatDurationRecord(undefined)).toBe('--');
    });
  });

  describe('formatDateTime', () => {
    test('应正确格式化日期时间', () => {
      const result = formatDateTime('2024-03-15T08:30:00Z');
      // 使用本地格式，可能是 YYYY/MM/DD 或 MM/DD/YYYY
      expect(result).toMatch(/\d{4}[\/\-]\d{1,2}[\/\-]\d{1,2}/);
      expect(result).toMatch(/\d{1,2}:\d{2}/);
    });

    test('null或空字符串应返回--', () => {
      expect(formatDateTime(null)).toBe('--');
      expect(formatDateTime(undefined)).toBe('--');
      expect(formatDateTime('')).toBe('--');
    });
  });

  describe('formatDate', () => {
    test('应正确格式化日期', () => {
      const result = formatDate('2024-03-15T08:30:00Z');
      // 使用本地格式，可能是 YYYY/MM/DD 或 MM/DD/YYYY
      expect(result).toMatch(/\d{4}[\/\-]\d{1,2}[\/\-]\d{1,2}/);
    });

    test('null应返回--', () => {
      expect(formatDate(null)).toBe('--');
    });
  });

  describe('formatListDateTime', () => {
    test('应正确格式化列表日期时间', () => {
      const result = formatListDateTime('2024-03-15T08:30:00Z');
      expect(result).toContain('2024/03/15');
      expect(result).toContain('(');
      expect(result).toContain(')');
      // 显示的是本地时间
      expect(result).toMatch(/\d{2}:\d{2}/);
    });

    test('应正确显示中文星期', () => {
      // 2024-03-15 是周五
      const result = formatListDateTime('2024-03-15T08:30:00Z');
      expect(result).toContain('周五');
    });

    test('null应返回--', () => {
      expect(formatListDateTime(null)).toBe('--');
    });
  });

  describe('formatMonthYear', () => {
    test('应正确格式化年月', () => {
      expect(formatMonthYear('2024-03')).toBe('2024年3月');
      expect(formatMonthYear('2024-12')).toBe('2024年12月');
      expect(formatMonthYear('2024-01')).toBe('2024年1月');
    });

    test('无效格式应原样返回', () => {
      expect(formatMonthYear('invalid')).toBe('invalid');
      expect(formatMonthYear('')).toBe('');
    });
  });

  describe('formatInt', () => {
    test('应正确格式化整数', () => {
      expect(formatInt(150)).toBe('150');
      expect(formatInt(150, 'bpm')).toBe('150 bpm');
    });

    test('应四舍五入', () => {
      expect(formatInt(150.4)).toBe('150');
      expect(formatInt(150.5)).toBe('151');
    });

    test('null或NaN应返回--', () => {
      expect(formatInt(null)).toBe('--');
      expect(formatInt(undefined)).toBe('--');
    });
  });

  describe('formatCadence', () => {
    test('应正确格式化步频', () => {
      expect(formatCadence(180)).toBe('180 步/分');
      expect(formatCadence(175.5)).toBe('176 步/分');
    });

    test('null应返回--', () => {
      expect(formatCadence(null)).toBe('--');
    });
  });

  describe('formatTemp', () => {
    test('应正确格式化温度', () => {
      expect(formatTemp(25.5)).toBe('25.5 °C');
      expect(formatTemp(0)).toBe('0.0 °C');
      expect(formatTemp(-5)).toBe('-5.0 °C');
    });

    test('null或NaN应返回--', () => {
      expect(formatTemp(null)).toBe('--');
      expect(formatTemp(undefined)).toBe('--');
    });
  });

  describe('formatRecoveryTime', () => {
    // 真实库 348 条 recovery_time 分布: 0 分 13 条 / 1-59 分 3 条 /
    // 1-23 小时 152 条 / >=24 小时 180 条 (最长 5020 分 ≈ 3.5 天)。
    test('0 分钟照常输出「0 分」(0 = 无需恢复, 是有效结论而非缺失)', () => {
      expect(formatRecoveryTime(0)).toEqual({ value: '0', unit: '分' });
    });

    test('<60 分钟用「分」', () => {
      expect(formatRecoveryTime(45)).toEqual({ value: '45', unit: '分' });
      expect(formatRecoveryTime(59)).toEqual({ value: '59', unit: '分' });
    });

    test('60-1439 分钟用「小时」(四舍五入)', () => {
      expect(formatRecoveryTime(60)).toEqual({ value: '1', unit: '小时' });
      expect(formatRecoveryTime(1400)).toEqual({ value: '23', unit: '小时' });
      expect(formatRecoveryTime(119)).toEqual({ value: '2', unit: '小时' });
    });

    test('>=24 小时用「天」, 避免把 3.5 天写成「84 小时」', () => {
      expect(formatRecoveryTime(1440)).toEqual({ value: '1.0', unit: '天' });
      expect(formatRecoveryTime(5020)).toEqual({ value: '3.5', unit: '天' });
    });

    test('null / undefined / NaN / 负数 → null (整项不渲染)', () => {
      expect(formatRecoveryTime(null)).toBeNull();
      expect(formatRecoveryTime(undefined)).toBeNull();
      expect(formatRecoveryTime(Number.NaN)).toBeNull();
      expect(formatRecoveryTime(-5)).toBeNull();
    });
  });
});

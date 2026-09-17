/**
 * @jest-environment node
 *
 * query-params.ts 单测 —— API 参数解析 SSOT。
 * 覆盖: 整数 (radix/NaN/范围/科学计数/脏尾)、路径 id、浮点 (Infinity/NaN/脏尾)、日期 (日历有效性)。
 */
import {
  parseIntParam,
  parseIdParam,
  parseFloatParam,
  parseDateParam,
  isValidDateParam,
} from '@/app/lib/query-params';

describe('parseIntParam', () => {
  const opts = { fallback: 20, min: 1, max: 500, name: 'limit' };

  test('null/空串 → fallback', () => {
    expect(parseIntParam(null, opts)).toEqual({ ok: true, value: 20 });
    expect(parseIntParam('', opts)).toEqual({ ok: true, value: 20 });
  });

  test('合法整数原样解析', () => {
    expect(parseIntParam('42', opts)).toEqual({ ok: true, value: 42 });
    expect(parseIntParam('1', opts)).toEqual({ ok: true, value: 1 });
    expect(parseIntParam('500', opts)).toEqual({ ok: true, value: 500 });
  });

  test('回归: "abc" 不再产生 NaN, 而是显式失败 (此前绕过比较 → 500)', () => {
    const r = parseIntParam('abc', opts);
    expect(r.ok).toBe(false);
  });

  test('回归: 拒绝十六进制/科学计数/小数/脏尾 (此前 parseInt 静默截断)', () => {
    for (const bad of ['0x10', '1e3', '12.5', '3abc', '+5', ' 5']) {
      expect(parseIntParam(bad, opts).ok).toBe(false);
    }
  });

  test('越界返回错误', () => {
    expect(parseIntParam('0', opts).ok).toBe(false);
    expect(parseIntParam('501', opts).ok).toBe(false);
    expect(parseIntParam('-1', opts).ok).toBe(false);
  });

  test('超出安全整数范围返回错误', () => {
    expect(parseIntParam('99999999999999999999', opts).ok).toBe(false);
  });

  test('min=0 允许 0 (offset 场景)', () => {
    const r = parseIntParam('0', { fallback: 0, min: 0, max: 100, name: 'offset' });
    expect(r).toEqual({ ok: true, value: 0 });
  });
});

describe('parseIdParam', () => {
  test('合法正整数', () => {
    expect(parseIdParam('536178521')).toEqual({ ok: true, value: 536178521 });
  });

  test('拒绝十六进制 (此前 "0x10" → 16 命中错误活动)', () => {
    expect(parseIdParam('0x10').ok).toBe(false);
  });

  test('拒绝脏尾 (此前 "5abc" → 5)', () => {
    expect(parseIdParam('5abc').ok).toBe(false);
  });

  test('拒绝小数/负数/零/空', () => {
    for (const bad of ['1.9', '-1', '0', '']) {
      expect(parseIdParam(bad).ok).toBe(false);
    }
  });
});

describe('parseFloatParam', () => {
  const opts = { min: 1, max: 100, name: 'vdot' };

  test('回归: Infinity/NaN 被拒绝 (此前 parseFloat 通过 → 垃圾数据 200)', () => {
    expect(parseFloatParam('Infinity', opts).ok).toBe(false);
    expect(parseFloatParam('NaN', opts).ok).toBe(false);
    expect(parseFloatParam('-Infinity', opts).ok).toBe(false);
    expect(parseFloatParam('1e309', opts).ok).toBe(false); // 溢出为 Infinity
  });

  test('拒绝脏尾 (此前 "12.5abc" → 12.5)', () => {
    expect(parseFloatParam('12.5abc', opts).ok).toBe(false);
  });

  test('合法有限数', () => {
    expect(parseFloatParam('45.3', opts)).toEqual({ ok: true, value: 45.3 });
  });

  test('必填 (无 fallback) 且缺失 → 错误', () => {
    expect(parseFloatParam(null, opts).ok).toBe(false);
    expect(parseFloatParam(null, { ...opts, fallback: 50 })).toEqual({ ok: true, value: 50 });
  });

  test('越界拒绝', () => {
    expect(parseFloatParam('0.5', opts).ok).toBe(false);
    expect(parseFloatParam('101', opts).ok).toBe(false);
  });
});

describe('日期校验', () => {
  test('真实日历日通过', () => {
    expect(isValidDateParam('2026-09-17')).toBe(true);
    expect(isValidDateParam('2024-02-29')).toBe(true); // 闰年
  });

  test('格式错/不可能日期拒绝 (此前仅正则, "2024-13-45" 通过)', () => {
    for (const bad of ['2024-13-45', '2024-02-30', '2023-02-29', '0000-00-00', '2026-9-17', 'abc']) {
      expect(isValidDateParam(bad)).toBe(false);
    }
  });

  test('parseDateParam: 缺省 undefined, 非法报错', () => {
    expect(parseDateParam(null, 'startDate')).toEqual({ ok: true, value: undefined });
    expect(parseDateParam('', 'startDate')).toEqual({ ok: true, value: undefined });
    expect(parseDateParam('2026-09-17', 'startDate')).toEqual({ ok: true, value: '2026-09-17' });
    expect(parseDateParam('2024-02-30', 'startDate').ok).toBe(false);
  });
});

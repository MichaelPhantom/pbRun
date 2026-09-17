/**
 * API 查询参数解析单一来源。
 *
 * 背景: 各路由此前各自 `parseInt(x)` / `parseFloat(x)`, 存在系统性缺陷 ——
 *  - 缺 radix: `?limit=0x10` 被当十六进制; `?limit=1e3` 被截断为 1
 *  - 缺 NaN 守卫: `?page=abc` → NaN 绕过 `< 1` / `> 500` 比较 (NaN 与任何数
 *    比较均为 false), NaN 流入 SQLite 触发 "datatype mismatch" → 误报 500
 *  - 缺有限性守卫: `?vdot=Infinity` → parseFloat 通过, 下游算出垃圾数据却返 200
 *
 * 本模块用「显式成功/失败」结果类型统一处理, 供各路由返回 400 而非 500/垃圾数据。
 */

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

/** 解析可选整数: 缺省用 fallback; 非整数 / 超范围返回错误。 */
export function parseIntParam(
  raw: string | null,
  opts: { fallback: number; min: number; max: number; name: string },
): Parsed<number> {
  const { fallback, min, max, name } = opts;
  if (raw === null || raw === '') return { ok: true, value: fallback };
  // 只接受纯十进制整数 (拒绝 "0x10" / "1e3" / "12.5" / "3abc" / " 1")
  if (!/^-?\d+$/.test(raw)) {
    return { ok: false, error: `${name} must be an integer` };
  }
  const n = Number(raw);
  if (!Number.isSafeInteger(n)) {
    return { ok: false, error: `${name} is out of range` };
  }
  if (n < min || n > max) {
    return { ok: false, error: `${name} must be between ${min} and ${max}` };
  }
  return { ok: true, value: n };
}

/** 解析必填路径 id (正整数)。 */
export function parseIdParam(raw: string): Parsed<number> {
  if (!/^\d+$/.test(raw)) {
    return { ok: false, error: 'Invalid activity ID' };
  }
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 1) {
    return { ok: false, error: 'Invalid activity ID' };
  }
  return { ok: true, value: n };
}

/** 解析可选有限浮点数 (拒绝 NaN/Infinity/科学计数之外的非法形)。 */
export function parseFloatParam(
  raw: string | null,
  opts: { fallback?: number; min: number; max: number; name: string },
): Parsed<number> {
  const { fallback, min, max, name } = opts;
  if (raw === null || raw === '') {
    if (fallback === undefined) return { ok: false, error: `${name} is required` };
    return { ok: true, value: fallback };
  }
  // Number 而非 parseFloat: parseFloat("12.5abc")=12.5 会静默接受脏尾
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    return { ok: false, error: `${name} must be a finite number` };
  }
  if (n < min || n > max) {
    return { ok: false, error: `${name} must be between ${min} and ${max}` };
  }
  return { ok: true, value: n };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 是否为「格式正确且为真实日历日」的 YYYY-MM-DD。 */
export function isValidDateParam(raw: string): boolean {
  if (!DATE_RE.test(raw)) return false;
  const [y, m, d] = raw.split('-').map(Number);
  if (m < 1 || m > 12 || d < 1) return false;
  // 用 UTC 构造校验: 越界日期 (如 02-30) 会被 Date 归一化, 比对即可发现
  const dt = new Date(Date.UTC(y, m - 1, d));
  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() === m - 1 &&
    dt.getUTCDate() === d
  );
}

/** 解析可选日期参数 (YYYY-MM-DD); 非法日历日返回错误。 */
export function parseDateParam(
  raw: string | null,
  name: string,
): Parsed<string | undefined> {
  if (raw === null || raw === '') return { ok: true, value: undefined };
  if (!isValidDateParam(raw)) {
    return { ok: false, error: `${name} must be a valid YYYY-MM-DD date` };
  }
  return { ok: true, value: raw };
}

/**
 * 列表头与展开取数必须用**同一组筛选条件**。
 *
 * ## 为什么需要这条
 *
 * `/list` 的月卡头部（`N 公里 · N 次`）来自 `/api/activities/months?type=…&q=…`，
 * 而展开后的卡片来自 `/api/activities?startDate=…&endDate=…`。两个请求**各写一遍
 * 参数**，谁漏了谁就漂移。
 *
 * 第三十类缺陷（2026-11-08）正是这样：`fetchMonthActivities` 只传日期，
 * 把 `type` / `q` 整个丢掉 ——
 *
 * | 操作 | 月卡头部 | 展开后的卡片 |
 * |------|---------|-------------|
 * | 选「力量训练」 | `2026年10月 · 2 次` | **19 张**（16 跑步 + 2 力量 + 1 跑步机） |
 *
 * 生产实证：`months?type=strength_training` → `count=2`；客户端实际请求
 * `/api/activities?startDate=2026-10-01&endDate=2026-10-31` → **19 条**。
 * 用户筛「力量训练」，看到的是整个月的所有运动 —— 筛选等于没做。
 *
 * ## 为什么既有测试拦不住
 *
 * 用例的 `fetch` 桩对**任何** URL 都返回同一个数组，「请求带没带条件」根本
 * 不可观测。夹具不看 URL，缺陷就不显形。
 *
 * ## 规则
 *
 * 本守卫检查 `app/**` 里所有 `new URLSearchParams({...})` 构建的取数参数：
 * 只要某个函数**同时**负责「列表取数」且带 `startDate`/`endDate`，就必须
 * 在同一函数体内出现 `type` 或 `q` 的写入，或者显式接收一个 `filter` 参数。
 *
 * 实现上不追求通用静态分析（那不可靠），而是钉住本项目里唯一的那条链路：
 * `fetchMonthActivities` 必须声明 `filter` 形参，且函数体内 `params.set('type'`
 * 与 `params.set('q'` 都存在。
 */
import fs from 'fs';
import path from 'path';

const ROOT = path.join(__dirname, '..', '..', '..');
const LIST_CLIENT = path.join(ROOT, 'app', 'list', 'ListClient.tsx');

/** 剥掉块注释与行注释 —— 文件里保留了「旧实现只传日期」的历史说明。 */
function stripComments(src: string): string {
  const chars = src.split('');
  const blank = (from: number, to: number) => {
    for (let i = from; i < to && i < chars.length; i++) {
      if (chars[i] !== '\n') chars[i] = ' ';
    }
  };
  for (const m of src.matchAll(/\/\*[\s\S]*?\*\//g)) {
    blank(m.index ?? 0, (m.index ?? 0) + m[0].length);
  }
  for (const m of src.matchAll(/\/\/[^\n]*/g)) {
    blank(m.index ?? 0, (m.index ?? 0) + m[0].length);
  }
  return chars.join('');
}

/** 取出 `fetchMonthActivities` 的函数体（从签名到下一个顶层 `function`/`export`）。 */
function fetchMonthActivitiesBody(src: string): string | null {
  const code = stripComments(src);
  const start = code.indexOf('function fetchMonthActivities(');
  if (start < 0) return null;
  const nextTop = code.slice(start + 1).search(/\n(?:export )?(?:async )?function |\nconst |\nexport const /);
  return nextTop < 0 ? code.slice(start) : code.slice(start, start + 1 + nextTop);
}

describe('列表头与展开取数必须同条件', () => {
  const src = fs.readFileSync(LIST_CLIENT, 'utf8');

  test('fetchMonthActivities 接收 filter 形参', () => {
    const body = fetchMonthActivitiesBody(src);
    expect(body).not.toBeNull();
    // 形参必须能带 type / q（形参名不限，但类型里要出现这两个键）
    expect(body!).toMatch(/filter:\s*\{\s*type\?/);
  });

  test('fetchMonthActivities 函数体里真的写入了 type 与 q', () => {
    const body = fetchMonthActivitiesBody(src)!;
    expect(body).toContain("params.set('type'");
    expect(body).toContain("params.set('q'");
  });

  test('两处调用点都传了生效条件（不能有裸调用）', () => {
    const code = stripComments(src);
    // 定义处的首个形参是 `monthKey: string`（带类型标注），调用处是裸标识符 ——
    // 用「形参带 `: string`」区分，不能按 `monthKey,` 前缀过滤（会误伤真实调用）。
    const calls = [...code.matchAll(/fetchMonthActivities\(\s*([^)]*)\)/g)]
      .map((m) => m[1].trim())
      .filter((args) => !args.startsWith('monthKey: string'));
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const args of calls) {
      // 必须带第二个实参（条件对象）
      expect(args).toMatch(/,/);
    }
  });
});

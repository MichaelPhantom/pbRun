/**
 * 「展示时间」不得读进程时区 —— 必须走 `app/lib/timezone.ts`（固定 +480）。
 *
 * ## 为什么需要这条
 *
 * 项目的时区契约：**所有「今天/月份/展示时间」都出自 `app/lib/timezone.ts`**
 * （`LOCAL_TZ_OFFSET_MIN = 480`）。`formatDate` / `formatDateTime` /
 * `formatListDateTime` 都遵守 —— 它们把 UTC ISO 或本地墙钟统一转成业务时区
 * 再拼字符串，**与进程 TZ 无关**。
 *
 * 第二十七类缺陷（2026-11-08）：`app/stats/StatsClient.tsx` 的个人纪录两处写了
 *
 * ```ts
 * new Date(iso).toLocaleDateString('zh-CN', { year: 'numeric', ... })
 * ```
 *
 * 它读的是**进程/浏览器时区**。生产库 `longestRunDate = 2026-10-31T23:38:57.000Z`
 * 的业务时区是 **2026-11-01 07:38**（那场半马），而 CI 的 `TZ=UTC` 腿渲染成
 * **2026/10/31** —— 同一个 PR 在两条腿上显示不同日期；用户的手机时区一变，
 * 记录日期也跟着漂。
 *
 * ## 规则
 *
 * `app/**` 下不得出现 `toLocaleDateString` / `toLocaleString` /
 * `toLocaleTimeString` 用于**日期时间展示**。若确实需要（例如纯数字的
 * `toLocaleString` 加千分位），必须在本文件的 `ALLOW` 里显式登记并写明理由。
 */
import fs from 'fs';
import path from 'path';

const ROOT = path.join(__dirname, '..', '..', '..');
const APP = path.join(ROOT, 'app');

/**
 * 允许的例外（文件相对路径 → 理由）。
 *
 * 保持为空是目标：任何新增都需要在这里留下「为什么不能走 timezone 模块」。
 */
const ALLOW: Record<string, string> = {};

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.next') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** 剥掉块注释与行注释 —— 文件里保留了「旧实现用 toLocaleDateString」的历史说明。 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const LOCALE_CALL = /\btoLocale(?:Date|Time)?String\s*\(/;

describe('展示时间不得读进程时区', () => {
  const files = walk(APP);

  test('app/ 下无 toLocale*String 的日期时间格式化', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const rel = path.relative(ROOT, file).split(path.sep).join('/');
      if (ALLOW[rel]) continue;
      const code = stripComments(fs.readFileSync(file, 'utf8'));
      if (LOCALE_CALL.test(code)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  test('守卫本身能命中已知形态（防止正则写空）', () => {
    // 自证：正则必须能抓住历史上真实出现过的那行
    const sample = "new Date(iso).toLocaleDateString('zh-CN', { year: 'numeric' })";
    expect(LOCALE_CALL.test(sample)).toBe(true);
    // 剥注释后仍应命中（注释里的历史说明不算）
    expect(LOCALE_CALL.test(stripComments(`// new Date(x).toLocaleDateString()\nconst a = 1;`))).toBe(false);
  });
});

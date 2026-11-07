/**
 * 站内链接的路由卫生 —— 动态链接不得指向不存在的路由。
 *
 * ## 为什么需要这条
 *
 * 详情页的路由文件是 `app/pages/[id]/page.tsx`，URL 是 `/pages/{id}`。
 * 这个事实**只存在于文件系统里**：`href={`/${id}`}` 在 TypeScript 里完全合法
 * （就是字符串），写错了不会有任何编译错误 —— 只有用户点下去才变成 404。
 *
 * 第二十八类缺陷（2026-11-08）：`/insight` 的常跑路线卡两处写成 `/${activityId}`。
 *
 * | 位置 | 生产实测 |
 * |------|----------|
 * | `/pbrun/659795962`（错误形态） | **404** |
 * | `/pbrun/pages/659795962`（正确形态） | 200 |
 *
 * 近 90 天的洞察页有 **24 个**死链（6 条路线 × (1 最佳 + ≤5 最近)）。
 * 用户点「最佳 5:14/km」想看是哪一次跑，得到 404。
 *
 * ## 规则
 *
 * `app/**` 里**动态拼接的根路径**（`href={`/${...}`}`、`router.push(`/${...}`)`）
 * 一律视为错误 —— 本站没有 `app/[id]/` 这样的顶层动态段，任何 `/{数字}`
 * 都必然 404。指向活动详情必须走 `app/lib/routes.ts` 的 `activityDetailPath()`。
 *
 * 静态根路径（`href="/"`、`href="/list"`）不受影响。
 */
import fs from 'fs';
import path from 'path';

const ROOT = path.join(__dirname, '..', '..', '..');
const APP = path.join(ROOT, 'app');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.next') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** 剥掉块注释与行注释 —— 文件里保留了「旧实现写 /${id}」的历史说明。 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/**
 * 动态根路径：`/` 后紧跟模板插值，且整段路径**没有**更深的分段。
 *
 * 匹配 `href={`/${id}`}`、`router.push(`/${x.activityId}`)`。
 * 不匹配 `href={`/pages/${id}`}`（有 `/pages/` 前缀）、也不匹配静态 `href="/"`。
 */
const DYNAMIC_ROOT_PATH = /(?:href\s*=\s*\{\s*`|(?:push|replace)\s*\(\s*`)\/\$\{/;

describe('动态链接不得指向不存在的根路由', () => {
  const files = walk(APP);

  test('app/ 下无 `/${…}` 形态的动态根路径', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const rel = path.relative(ROOT, file).split(path.sep).join('/');
      const code = stripComments(fs.readFileSync(file, 'utf8'));
      if (DYNAMIC_ROOT_PATH.test(code)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  test('守卫能命中已知形态（防止正则写空）', () => {
    // 历史上真实出现过的两行
    expect(DYNAMIC_ROOT_PATH.test('href={`/${r.best.activityId}`}')).toBe(true);
    expect(DYNAMIC_ROOT_PATH.test('router.push(`/${a.activity_id}`)')).toBe(true);
    // 正确形态不得误报
    expect(DYNAMIC_ROOT_PATH.test('href={activityDetailPath(id)}')).toBe(false);
    expect(DYNAMIC_ROOT_PATH.test('href={`/pages/${id}`}')).toBe(false);
    expect(DYNAMIC_ROOT_PATH.test('href="/"')).toBe(false);
    expect(DYNAMIC_ROOT_PATH.test('router.push("/list")')).toBe(false);
  });

  test('详情页路由文件存在（activityDetailPath 的前提）', () => {
    expect(fs.existsSync(path.join(APP, 'pages', '[id]', 'page.tsx'))).toBe(true);
  });
});

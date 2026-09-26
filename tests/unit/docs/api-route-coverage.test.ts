/**
 * @jest-environment node
 *
 * API 路由 ↔ 文档 覆盖守护 (文档与实际一致)。
 *
 * 三个方向:
 *  1. 正向-入口: 每个 app/api 下的 route.ts 必须出现在 README (架构树/API 表);
 *  2. 正向-详述: 每个路由必须在 docs/api-reference.md 或 docs/insight.md 有详述;
 *  3. 反向-存在: docs/api-reference.md 里出现的 /api/... 路径必须真实存在
 *     (防止文档虚构端点)。
 *
 * 路径形态归一: [id] / {id} / {activity_id} / 数字示例 id 视为同一段
 * (`/api/activities/[id]` ≡ `/api/activities/{id}` ≡ `/api/activities/14234567890`)。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = path.resolve(__dirname, '../../..');
const read = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf8');

const README = read('README.md');
const API_REF = read('docs/api-reference.md');
const INSIGHT = read('docs/insight.md');

/** 递归收集 app/api 下所有 route.ts → `/api/...` 形态。 */
function listRoutePaths(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listRoutePaths(full, `${prefix}/${entry.name}`));
    } else if (entry.name === 'route.ts') {
      out.push(`/api${prefix}`);
    }
  }
  return out.sort();
}

/** 归一化动态段: {x} / [x] 与 ≥4 位数字 id 视为同一段。 */
function canon(p: string): string {
  return p
    .replace(/[{}[\]]+[^{}[\]]*[{}[\]]/g, '<id>')
    .replace(/\d{4,}/g, '<id>');
}

const routePaths = listRoutePaths(path.join(root, 'app', 'api'));
const canonicalRoutes = routePaths.map(canon);

/** 从文档正文抽取 /api/... 路径引用 (去掉句尾标点与 route.ts 文件后缀)。 */
function extractApiPaths(text: string): string[] {
  const re = /\/api\/[A-Za-z0-9_.\-{}[\]]+(?:\/[A-Za-z0-9_.\-{}[\]]+)*/g;
  return [...new Set((text.match(re) ?? []).map((m) => m.replace(/[.,;:]+$/, '').replace(/\/route\.ts$/, '')))];
}

describe('API 路由 ↔ 文档覆盖', () => {
  test('路由枚举非空 (防正则/路径失配静默通过)', () => {
    expect(routePaths.length).toBeGreaterThanOrEqual(15);
  });

  test('README 覆盖每个路由', () => {
    const extracted = extractApiPaths(README);
    expect(extracted.length).toBeGreaterThanOrEqual(15); // 防抽取正则失配静默通过
    const readme = new Set(extracted.map(canon));
    const missing = canonicalRoutes.filter((r) => !readme.has(r));
    expect(missing).toEqual([]);
  });

  test('详述文档 (api-reference ∪ insight) 覆盖每个路由', () => {
    const extracted = [...extractApiPaths(API_REF), ...extractApiPaths(INSIGHT)];
    expect(extracted.length).toBeGreaterThanOrEqual(15); // 防抽取正则失配静默通过
    const detailed = new Set(extracted.map(canon));
    const missing = canonicalRoutes.filter((r) => !detailed.has(r));
    expect(missing).toEqual([]);
  });

  test('api-reference 引用的每个 /api/ 路径都真实存在', () => {
    const routes = new Set(canonicalRoutes);
    const documented = extractApiPaths(API_REF);
    expect(documented.length).toBeGreaterThanOrEqual(10); // 防抽取正则失配静默通过
    const ghosts = [...new Set(documented.map(canon))].filter((p) => !routes.has(p));
    expect(ghosts).toEqual([]);
  });

  test('api-reference 端点编号连续且目录齐全 (1..N)', () => {
    const numbers = [...API_REF.matchAll(/^### (\d+)\. /gm)].map((m) => Number(m[1]));
    expect(numbers.length).toBeGreaterThanOrEqual(15);
    expect(numbers).toEqual(numbers.map((_, i) => i + 1));
  });
});

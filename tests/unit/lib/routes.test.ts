/**
 * `activityDetailPath` 与**文件系统路由**的一致性。
 *
 * 第二十八类缺陷的根因不是「算错了」，而是「两处事实各说各话」：
 *
 * - 文件系统说：详情页在 `app/pages/[id]/page.tsx` → URL 是 `/pages/{id}`
 * - 链接代码说：`/${activityId}` → URL 是 `/{id}`
 *
 * 没有任何东西把这两者绑在一起，所以代码里的错永远编译得过。
 * 本测试把「路由文件在哪」变成机器可读的断言 —— 若哪天详情页搬到
 * `app/activities/[id]/`，这条测试会红，逼着 `activityDetailPath` 一起改。
 */
import fs from 'fs';
import path from 'path';
import { activityDetailPath } from '@/app/lib/routes';

const ROOT = path.join(__dirname, '..', '..', '..');
const APP = path.join(ROOT, 'app');

/** 从 `activityDetailPath(123)` 里取出实际会请求的路径段。 */
const SAMPLE_ID = 653862644;
const pathOfSample = activityDetailPath(SAMPLE_ID);

describe('activityDetailPath 必须对应真实存在的路由文件', () => {
  test('返回 /pages/{id} 形态', () => {
    expect(pathOfSample).toBe(`/pages/${SAMPLE_ID}`);
  });

  test('字符串 ID 与数字 ID 等价（MCP / 查询串可能传字符串）', () => {
    expect(activityDetailPath(String(SAMPLE_ID))).toBe(pathOfSample);
  });

  test('该路径对应的 page.tsx 真的存在', () => {
    // `/pages/{id}` → app/pages/[id]/page.tsx
    const segments = pathOfSample.split('/').filter(Boolean);
    // 最后一段是具体 id，路由文件里对应 [id]
    segments[segments.length - 1] = '[id]';
    const routeFile = path.join(APP, ...segments, 'page.tsx');
    expect(fs.existsSync(routeFile)).toBe(true);
  });

  test('顶层没有同名动态段（否则 /{id} 也可能是合法路由，缺陷就不成立）', () => {
    // 若有人加了 app/[id]/page.tsx，则 `/${id}` 会变成合法路由 ——
    // 那时本缺陷的「必然 404」论断失效，需要重新评估 activityDetailPath 的形态。
    expect(fs.existsSync(path.join(APP, '[id]'))).toBe(false);
  });
});

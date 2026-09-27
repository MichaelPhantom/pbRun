import { test, expect, devices } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/**
 * 无障碍 (a11y) 自动断言 —— axe-core 扫描关键页面。
 *
 * 门禁口径: **只拦 serious / critical** 违规 (WCAG 2.x A/AA 中影响可用性的硬伤,
 * 如缺 label、对比度过低、ARIA 误用)。moderate/minor 仅记录不拦截 —— 否则本仓库
 * 既有的一些装饰性提示 (如颜色轻微对比) 会让门禁长期红, 反而失去意义。
 *
 * 失败信息会列出违规 id / 描述 / 命中节点, 便于直接修复。
 */
const PAGES = [
  { path: '/pbrun', name: '首页' },
  { path: '/pbrun/list', name: '运动记录' },
  { path: '/pbrun/analysis', name: '数据分析' },
  { path: '/pbrun/stats', name: '统计' },
  { path: '/pbrun/insight', name: '运动洞察' },
  { path: '/pbrun/daniels', name: '丹尼尔斯介绍' },
  // 活动详情页含最多图表/表格/徽章 (分段表、区间表、对比表、地图), 是最容易出对比度问题的一页
  { path: '/pbrun/pages/900000001', name: '活动详情' },
];

/** 只拦这两档; 其它档位输出但不失败 */
const BLOCKING = new Set(['serious', 'critical']);

for (const { path, name } of PAGES) {
  test(`无障碍: ${name} 无 serious/critical 违规`, async ({ page }) => {
    await page.goto(path);
    await page.waitForLoadState('networkidle');

    const results = await new AxeBuilder({ page })
      // 图表 (canvas/SVG) 由 axe 难以判定, 已在组件内用 role=img + aria-label 标注
      .disableRules(['color-contrast-enhanced'])
      .analyze();

    const blocking = results.violations.filter((v) => BLOCKING.has(v.impact ?? ''));
    const message = blocking
      .map(
        (v) =>
          `[${v.impact}] ${v.id}: ${v.help}\n` +
          v.nodes
            .slice(0, 3)
            .map((n) => `    ${n.target.join(' ')}`)
            .join('\n'),
      )
      .join('\n');

    expect(blocking, `\n${message}\n`).toEqual([]);
  });
}

test('无障碍: 键盘可达性 (Tab 能到主导航与主内容跳板链接)', async ({ page }) => {
  await page.goto('/pbrun');
  await page.waitForLoadState('networkidle');

  // 首个 Tab 应落在「跳到主要内容」跳板链接 (布局已实现 sr-only + focus 可见)
  await page.keyboard.press('Tab');
  const focused = await page.evaluate(() => {
    const el = document.activeElement;
    return { tag: el?.tagName, text: (el?.textContent ?? '').trim(), href: el?.getAttribute('href') };
  });
  expect(focused.tag).toBe('A');
  expect(focused.href).toBe('#main-content');
});


/**
 * 移动端视口 (Pixel 5) —— 布局断点不同 (卡片改单列、表格横向滚动、图表变窄),
 * 与桌面是**不同的渲染路径**, 故单独扫一遍。CI 只跑 chromium project,
 * 这里用 test.use 在 project 内切换视口, 保证 CI 也覆盖。
 */
test.describe('移动端视口 (Pixel 5)', () => {
  // 注意: 不能整体展开 devices['Pixel 5'] —— 它含 defaultBrowserType,
  // 在 describe 内 test.use 会强制新 worker 而报错; 只取视口相关字段。
  test.use({
    viewport: devices['Pixel 5'].viewport,
    deviceScaleFactor: devices['Pixel 5'].deviceScaleFactor,
    isMobile: devices['Pixel 5'].isMobile,
    hasTouch: devices['Pixel 5'].hasTouch,
    userAgent: devices['Pixel 5'].userAgent,
  });

  for (const { path, name } of PAGES) {
    test(`无障碍(移动端): ${name} 无 serious/critical 违规`, async ({ page }) => {
      await page.goto(path);
      await page.waitForLoadState('networkidle');

      const results = await new AxeBuilder({ page })
        .disableRules(['color-contrast-enhanced'])
        .analyze();

      const blocking = results.violations.filter((v) => BLOCKING.has(v.impact ?? ''));
      const message = blocking
        .map(
          (v) =>
            `[${v.impact}] ${v.id}: ${v.help}\n` +
            v.nodes.slice(0, 3).map((n) => `    ${n.target.join(' ')}`).join('\n'),
        )
        .join('\n');

      expect(blocking, `\n${message}\n`).toEqual([]);
    });
  }
});

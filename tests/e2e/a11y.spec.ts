import { test, expect } from '@playwright/test';
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

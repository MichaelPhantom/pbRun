import { test, expect } from '@playwright/test';

test.describe('移动端响应式', () => {
  test.use({ viewport: { width: 375, height: 667 } });

  test('活动列表在移动端应正常显示', async ({ page }) => {
    await page.goto('/pbrun/list');
    await page.waitForTimeout(1000);

    // 检查月份标题可见
    const monthTitles = page.locator('text=/\\d{4}年\\d{1,2}月/').first();
    await expect(monthTitles).toBeVisible();
  });

  test('导航栏在移动端应正常显示', async ({ page }) => {
    await page.goto('/pbrun/list');

    // 检查导航项
    const navItems = page.locator('nav a, [class*="nav"] a').first();
    await expect(navItems).toBeVisible();
  });

  test('统计页面在移动端应正常显示', async ({ page }) => {
    await page.goto('/pbrun/stats');
    await page.waitForTimeout(1000);

    // 检查统计内容
    const stats = page.locator('text=/\\d+/').first();
    await expect(stats).toBeVisible();
  });

  test('活动详情分段表在移动端单行不换行', async ({ page }) => {
    await page.goto('/pbrun/pages/900000001');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1500);

    const table = page.locator('table').filter({ has: page.locator('thead th', { hasText: '角色' }) });
    await expect(table).toBeVisible();
    // 每个数据单元格高度应≈单行 (无换行)
    const heights = await table.locator('tbody tr:first-child td').evaluateAll((tds) =>
      tds.map((td) => Math.round((td as HTMLElement).getBoundingClientRect().height)),
    );
    for (const h of heights) expect(h).toBeLessThanOrEqual(40);
    // 外层容器可横向滚动
    const overflowX = await table.evaluate((t) => getComputedStyle((t.parentElement as HTMLElement)).overflowX);
    expect(overflowX).toBe('auto');
  });

  test('洞察页表格在移动端正常渲染', async ({ page }) => {
    await page.goto('/pbrun/insight?days=180');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2000);
    await expect(page.getByRole('heading', { name: '训练类别对比' })).toBeVisible();
    await expect(page.locator('table').filter({ has: page.locator('thead th', { hasText: '里程占比' }) })).toBeVisible();
  });
});

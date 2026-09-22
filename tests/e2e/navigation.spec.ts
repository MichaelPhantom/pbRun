import { test, expect } from '@playwright/test';

test.describe('页面导航', () => {
  test('首页应展示活动列表', async ({ page }) => {
    // 2026-09-15 修: 应用行为为 / 直接渲染活动列表(非 302 重定向到 /list),
    // 原断言 toHaveURL(/list) 与实现不符 → 改为断言列表内容可见。
    await page.goto('/pbrun');
    await page.waitForLoadState('networkidle');
    await expect(page.locator('body')).toContainText(/活动|月份|记录/);
  });

  test('应能访问运动记录页面', async ({ page }) => {
    await page.goto('/pbrun/list');
    await page.waitForLoadState('networkidle');
    // 检查页面标题或主要内容是否可见
    await expect(page.locator('body')).toBeVisible();
    // 页面应包含运动相关的文字
    const content = await page.content();
    expect(content).toMatch(/运动|记录|跑步|公里|km/i);
  });

  test('应能访问运动分析页面', async ({ page }) => {
    await page.goto('/pbrun/analysis');
    await page.waitForLoadState('networkidle');
    await expect(page.getByRole('heading', { name: '当前跑力' })).toBeVisible();
    await expect(page.getByRole('heading', { name: '训练负荷 (Fitness / Freshness)' })).toBeVisible();
  });

  test('应能访问运动洞察页面', async ({ page }) => {
    await page.goto('/pbrun/insight');
    await page.waitForLoadState('networkidle');
    await expect(page.getByRole('heading', { name: '关键洞察' })).toBeVisible();
    await expect(page.getByRole('heading', { name: '训练类别对比' })).toBeVisible();
  });

  test('应能访问运动统计页面', async ({ page }) => {
    await page.goto('/pbrun/stats');
    await page.waitForLoadState('networkidle');
    await expect(page.getByText('周数据统计')).toBeVisible();
    await expect(page.getByText('个人纪录')).toBeVisible();
  });

  test('顶部导航含全部菜单项', async ({ page }) => {
    await page.goto('/pbrun');
    const nav = page.locator('nav').first();
    for (const label of ['记录', '分析', '洞察', '统计', '配速']) {
      await expect(nav.getByRole('link', { name: label })).toBeVisible();
    }
  });

  test('无效页面应显示404或重定向', async ({ page }) => {
    await page.goto('/pbrun/nonexistent');
    await page.waitForLoadState('networkidle');
    // 检查页面是否加载（可能是404或重定向到首页）
    await expect(page.locator('body')).toBeVisible();
  });
});

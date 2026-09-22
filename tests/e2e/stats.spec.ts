import { test, expect } from '@playwright/test';

test.describe('统计页面', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/pbrun/stats');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);
  });

  test('应显示统计概览指标', async ({ page }) => {
    await expect(page.getByText('周数据统计')).toBeVisible();
    await expect(page.getByText('当前跑力')).toBeVisible();
    await expect(page.getByText('距离 (公里)')).toBeVisible();
    await expect(page.getByText('平均配速')).toBeVisible();
  });

  test('应支持切换时间周期', async ({ page }) => {
    await expect(page.getByText('总', { exact: true })).toBeVisible();
    await page.getByText('总', { exact: true }).click();
    await page.waitForTimeout(800);
    // 切到「总」后仍渲染统计框架
    await expect(page.getByText('当前跑力')).toBeVisible();
  });

  test('应显示个人纪录 (夹具含各距离最佳)', async ({ page }) => {
    await expect(page.getByText('个人纪录')).toBeVisible();
    await expect(page.getByText('5公里最佳成绩')).toBeVisible();
    await expect(page.getByText('10公里最佳成绩')).toBeVisible();
    // 单次最长距离 18.6 km
    await expect(page.getByText('单次训练最长距离')).toBeVisible();
    await expect(page.getByText(/18\.6/)).toBeVisible();
  });
});

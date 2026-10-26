import { test, expect } from '@playwright/test';

test.describe('活动详情页', () => {
  test('应显示活动基本信息 (标题/概览)', async ({ page }) => {
    await page.goto('/pbrun/pages/900000001');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);
    // 标题含活动名
    await expect(page.getByText('两江新区 - 乳酸阈值').first()).toBeVisible();
    // 概览区块
    await expect(page.getByText('活动概览')).toBeVisible();
    await expect(page.getByText('平均配速')).toBeVisible();
    await expect(page.getByText('平均心率')).toBeVisible();
  });

  test('应显示分段数据表', async ({ page }) => {
    await page.goto('/pbrun/pages/900000001');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1200);
    await expect(page.getByRole('heading', { name: '分段数据' })).toBeVisible();
    // 分段表存在 (通过 caption 区分的无障碍名)
    await expect(page.getByRole('table', { name: '每公里分段数据' })).toBeVisible();
  });

  test('应显示趋势图与深度分析区', async ({ page }) => {
    await page.goto('/pbrun/pages/900000001');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1500);
    // 标题由实际可渲染的图派生 (trendChartTitle), 不要写死完整图表清单:
    // 夹具里同时有 step_length, 标题会多出「步幅」; 缺海拔时又会少一项。
    await expect(page.getByText(/配速 \/ 心率 \/ 步频( \/ 步幅)? \/ 海拔 趋势/)).toBeVisible();
    await expect(page.getByRole('heading', { name: '深度分析' })).toBeVisible();
  });

  test('应显示跑步动态 (触地时间/垂直摆动, 真实库 241/241 条跑步活动都有)', async ({ page }) => {
    await page.goto('/pbrun/pages/900000001');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1200);
    // 真实库 average_gct_balance 348/348 全为 NULL, 旧展示条件只判该字段 →
    // 这张卡片在生产环境从未渲染过。夹具按真实分布只写触地时间/垂直摆动。
    await expect(page.getByRole('heading', { name: '跑步动态' })).toBeVisible();
    await expect(page.getByText('触地时间')).toBeVisible();
    await expect(page.getByText('垂直摆动')).toBeVisible();
    await expect(page.getByText('垂直振幅比')).toBeVisible();
    // 无 gct_balance → 不显示「触地平衡」(而不是 '--')
    await expect(page.getByText('触地平衡')).toHaveCount(0);
  });

  test('应显示 AI 教练分析区', async ({ page }) => {
    await page.goto('/pbrun/pages/900000001');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);
    await expect(page.getByRole('heading', { name: 'AI 教练分析' })).toBeVisible();
  });

  test('应支持返回列表页', async ({ page }) => {
    await page.goto('/pbrun/pages/900000001');
    await page.waitForLoadState('networkidle');
    await page.getByRole('link', { name: '记录' }).click();
    await expect(page).toHaveURL(/\/pbrun\/list$/);
  });
});

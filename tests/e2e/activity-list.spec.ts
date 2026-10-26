import { test, expect } from '@playwright/test';

test.describe('活动列表页', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/pbrun/list');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);
  });

  test('应显示月份列表 (含月度汇总)', async ({ page }) => {
    // 夹具时间相对「今天」生成 (见 scripts/testing/make-fixture-db.js), 因此不能断言
    // 具体年月 —— 那会让用例在跨月后必红。只断言「当前月份 + 月度里程汇总」的形态。
    const now = new Date();
    const monthLabel = `${now.getFullYear()}年${now.getMonth() + 1}月`;
    await expect(page.getByText(new RegExp(monthLabel))).toBeVisible();
    // 月度汇总形如「46.90 公里」/「46.90km」, 只校验数字与单位存在
    await expect(page.getByText(/\d+\.\d{2}\s*(公里|km)/).first()).toBeVisible();
  });

  test('应展示活动条目 (夹具 5 条)', async ({ page }) => {
    // 活动行以 button 渲染, 含活动名
    await expect(page.getByText('两江新区 - 乳酸阈值').first()).toBeVisible();
    await expect(page.getByText('渝中区 - 长距离跑')).toBeVisible();
    await expect(page.getByText('九龙坡区 - 恢复')).toBeVisible();
  });

  test('应支持搜索过滤功能', async ({ page }) => {
    const searchInput = page.getByPlaceholder('搜索');
    await expect(searchInput).toBeVisible();
    await searchInput.fill('渝中区');
    await page.waitForTimeout(400);
    // 过滤后仅剩匹配项
    await expect(page.getByText('渝中区 - 长距离跑')).toBeVisible();
    await expect(page.getByText('两江新区 - 乳酸阈值')).toHaveCount(0);
    // 清空恢复
    await searchInput.fill('');
    await page.waitForTimeout(300);
    await expect(page.getByText('两江新区 - 乳酸阈值').first()).toBeVisible();
  });

  test('点击活动应跳转到详情页', async ({ page }) => {
    await page.getByText('两江新区 - 乳酸阈值').first().click();
    await expect(page).toHaveURL(/\/pages\/\d+/);
  });

  test('活动类型筛选控件存在', async ({ page }) => {
    await expect(page.getByText('活动类型筛选')).toBeVisible();
  });
});

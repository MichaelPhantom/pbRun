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
    // 注意「最新夹具活动」是 2 天前 —— 每月 1–2 日时它在**上个**月, 所以断言
    // 「now-2d 所在月」而非「now 所在月」, 否则月初两天必红 (与 2026-11-05 的
    // 条目断言失败同一根因)。
    const now = new Date();
    const newest = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000);
    const monthLabel = `${newest.getFullYear()}年${newest.getMonth() + 1}月`;
    await expect(page.getByText(new RegExp(monthLabel))).toBeVisible();
    // 月度汇总形如「46.90 公里」/「46.90km」, 只校验数字与单位存在
    await expect(page.getByText(/\d+\.\d{2}\s*(公里|km)/).first()).toBeVisible();
  });

  test('应展示活动条目 (夹具 5 条)', async ({ page }) => {
    // 夹具时间相对「今天」生成 (偏移见 make-fixture-db.js: 阈值 2d/长距离 4d/
    // 基础 7d/恢复 12d/基础 14d), 列表按月分组且为**手风琴**设计 —— 同一时刻
    // 只展开一个月组 (默认展开最近一月)。跨月后 (如 2026-11-05) 老活动落在
    // 折叠的上月分组里, 条目不在 DOM (2026-11-05 CI 三引擎失败的根因)。
    // 因此: 先算出每条活动所在月, 确保该月组展开, 再断言条目可见。
    const ensureMonthExpanded = async (daysAgo: number) => {
      const d = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
      const label = new RegExp(`${d.getFullYear()}年${d.getMonth() + 1}月`);
      const btn = page.getByRole('button', { name: label });
      if ((await btn.getAttribute('aria-expanded')) !== 'true') await btn.click();
    };
    // 阈值跑 (2d, 最新一条; 另一条同名 12d) / 长距离 (4d) / 恢复跑 (12d)
    await ensureMonthExpanded(2);
    await expect(page.getByText('两江新区 - 乳酸阈值').first()).toBeVisible();
    await ensureMonthExpanded(4);
    await expect(page.getByText('渝中区 - 长距离跑')).toBeVisible();
    await ensureMonthExpanded(12);
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

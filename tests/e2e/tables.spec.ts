import { test, expect } from '@playwright/test';
import { tableByColumn, rowCount } from './helpers/tables';

/**
 * 数据表内容/结构断言 (统一 DataTable 风格)。
 * 夹具库 (scripts/testing/make-fixture-db.js) 提供确定性数据, 故可精确断言。
 */

test.describe('活动详情页 · 分段数据表', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/pbrun/pages/900000001');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1200);
  });

  test('分段表含角色列且每行有 lap 数据', async ({ page }) => {
    const table = tableByColumn(page, '角色');
    await expect(table).toBeVisible();
    // 表头含 8 列 (含角色)
    const headers = await table.locator('thead th').allInnerTexts();
    const joined = headers.join('|').replace(/\s+/g, '');
    for (const h of ['#', '角色', '距离', '配速', '时长', '心率', '步频', '爬升']) {
      expect(joined).toContain(h);
    }
    // 夹具 4 段
    expect(await rowCount(table)).toBe(4);
  });

  test('角色列渲染徽章 (热身/主课等)', async ({ page }) => {
    const table = tableByColumn(page, '角色');
    const roleCells = table.locator('tbody tr td:nth-child(2)');
    const texts = (await roleCells.allInnerTexts()).map((t) => t.trim());
    // 夹具 lap: 热身 / 主课 / 主课 / 冷身 (角色推断)
    expect(texts.some((t) => ['热身', '主课', '恢复', '冷身', '匀速'].includes(t))).toBe(true);
  });

  test('最快分段行高亮 (good-soft)', async ({ page }) => {
    const table = tableByColumn(page, '角色');
    const highlighted = table.locator('tbody tr.bg-\\[var\\(--good-soft\\)\\]');
    await expect(highlighted).toHaveCount(1);
  });

  test('每行单元格单行不换行 (高度近似相等)', async ({ page }) => {
    const table = tableByColumn(page, '角色');
    const heights = await table.locator('tbody tr:first-child td').evaluateAll((tds) =>
      tds.map((td) => Math.round((td as HTMLElement).getBoundingClientRect().height)),
    );
    for (const h of heights) expect(h).toBeLessThanOrEqual(40);
  });
});

test.describe('活动详情页 · 同路线对比表', () => {
  test('同路线对比表含类别与 vs 本次 列', async ({ page }) => {
    await page.goto('/pbrun/pages/900000001');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1500);

    const table = tableByColumn(page, 'vs 本次');
    await expect(table).toBeVisible();
    const joined = (await table.locator('thead th').allInnerTexts()).join('|').replace(/\s+/g, '');
    for (const h of ['日期', '类别', '距离', '配速', '心率', 'vs本次']) {
      expect(joined).toContain(h);
    }
    // 夹具: 两江新区 同路线共 3 条 (含本次) → 对比列 2 行
    expect(await rowCount(table)).toBeGreaterThanOrEqual(1);
  });

  test('同路线对比上方显示组均/组最佳/同类对标', async ({ page }) => {
    await page.goto('/pbrun/pages/900000001');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1500);
    await expect(page.getByText('组均配速')).toBeVisible();
    await expect(page.getByText('组内最佳')).toBeVisible();
    await expect(page.getByText(/同类均速/)).toBeVisible();
  });
});

test.describe('洞察页 · 数据表', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/pbrun/insight?days=180');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2000);
  });

  test('训练类别对比表含占比与效率列', async ({ page }) => {
    const table = tableByColumn(page, '里程占比');
    await expect(table).toBeVisible();
    const joined = (await table.locator('thead th').allInnerTexts()).join('|').replace(/\s+/g, '');
    for (const h of ['类别', '次数', '总里程', '里程占比', '时长占比', '均配速', '均心率', '均VDOT', '效率']) {
      expect(joined).toContain(h);
    }
    expect(await rowCount(table)).toBeGreaterThanOrEqual(1);
  });

  test('最经济类别行被标记 + 徽章', async ({ page }) => {
    const table = tableByColumn(page, '里程占比');
    await expect(table.getByText('最经济')).toBeVisible();
    // 高亮行存在
    await expect(table.locator('tbody tr.bg-\\[var\\(--good-soft\\)\\]')).toHaveCount(1);
  });

  test('周期化周维度表含 CTL/ATL/TSB 列', async ({ page }) => {
    const table = tableByColumn(page, 'CTL');
    await expect(table).toBeVisible();
    const joined = (await table.locator('thead th').allInnerTexts()).join('|').replace(/\s+/g, '');
    for (const h of ['周', '跑量', '负荷', '次数', 'CTL', 'ATL', 'TSB']) {
      expect(joined).toContain(h);
    }
  });

  test('关键洞察区域渲染 (findings)', async ({ page }) => {
    await expect(page.getByText('关键洞察')).toBeVisible();
  });
});

test.describe('分析页 · 区间表', () => {
  test('心率区间表存在且含单位表头', async ({ page }) => {
    await page.goto('/pbrun/analysis?days=90');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1500);
    const table = tableByColumn(page, '心率区间');
    await expect(table).toBeVisible();
    const joined = (await table.locator('thead th').allInnerTexts()).join('|').replace(/\s+/g, '');
    for (const h of ['心率区间', '配速', '步频', '步幅']) {
      expect(joined).toContain(h);
    }
  });
});

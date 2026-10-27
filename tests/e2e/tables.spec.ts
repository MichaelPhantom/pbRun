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
    for (const h of ['#', '角色', '距离', '配速', '时长', '心率', '步频', '功率', '爬升']) {
      expect(joined).toContain(h);
    }
    // 夹具 4 段
    expect(await rowCount(table)).toBe(4);
  });

  /**
   * 「主要区间」列 —— lap 级心率区间秒数的唯一消费方。
   *
   * 这一列存在的意义: `activity_laps.time_in_hr_zone` 生产库里原本 **0/3082 全 NULL**
   * （设备不写 lap 级数组），2026-10-27 改由逐秒记录按 `cumulative_time` 时间窗推导
   * 后才有值。若哪天推导链路断了，这一列会静默全变 `--` —— 数据层看不出异常，
   * 只有在这里断言「至少两种不同区间」才能发现。
   *
   * 夹具 4 段心率分别 120/138/168/175（边界 133/152/165/177）→ 主区间 Z1/Z2/Z4/Z4。
   * 断言「≥2 种不同值」而不是写死 Z1/Z2/Z4 —— 写死的话，MAX_HR 缺省值一改就误报，
   * 而我们要守的是「区间确实按段不同」这个性质。
   */
  test('分段表「主要区间」列由 lap 级心率区间推导, 且各段不同', async ({ page }) => {
    const table = tableByColumn(page, '角色');
    const headers = (await table.locator('thead th').allInnerTexts()).join('|').replace(/\s+/g, '');
    expect(headers).toContain('主要区间');

    // 列序号由表头**动态定位**（跑步/非跑步的列数不同: 非跑步没有配速/步频/功率
    // 三列），写死 nth-child 会在运动类型切换时静默选错列。
    const headers0 = await table.locator('thead th').allInnerTexts();
    const zoneCol = headers0.findIndex((h) => h.replace(/\s+/g, '').includes('主要区间')) + 1;
    expect(zoneCol).toBeGreaterThan(0);
    const zoneCells = table.locator(`tbody tr td:nth-child(${zoneCol})`);
    const texts = (await zoneCells.allInnerTexts()).map((t) => t.trim());
    expect(texts).toHaveLength(4);
    // 每段都必须有区间（不是 '--'）—— 记录覆盖了全部 lap 的时间窗
    for (const t of texts) expect(t).toMatch(/^Z[1-5]$/);
    // 至少两种不同区间 → 推导确实按时间窗切分，而不是整条活动一个值
    expect(new Set(texts).size).toBeGreaterThan(1);
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
    for (const h of [
      '类别', '次数', '总里程', '里程占比', '时长占比',
      '均配速', '均心率', '均步频', '均负荷', '均VDOT', '效率',
    ]) {
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

  /**
   * 「算出来却从不展示」缺陷族的 e2e 守护。
   * 跑姿的步幅/垂直摆动与步频/触地差 2 个数量级, 不能同轴作图 → 走明细表。
   */
  test('跑姿技术月度明细表含步幅/垂直摆动/垂直比列', async ({ page }) => {
    const table = tableByColumn(page, '垂直摆动');
    await expect(table).toBeVisible();
    const joined = (await table.locator('thead th').allInnerTexts()).join('|').replace(/\s+/g, '');
    for (const h of ['月份', '次数', '步频', '步幅', '触地', '垂直摆动', '垂直比']) {
      expect(joined).toContain(h);
    }
    // 夹具 5 条活动均有 stride_length / vertical_oscillation → 至少 1 行真实数字
    expect(await rowCount(table)).toBeGreaterThanOrEqual(1);
  });

  test('气温分档卡片展示步频', async ({ page }) => {
    const card = page.locator('section', { hasText: '气温影响对比' });
    await expect(card).toBeVisible();
    await expect(card.getByText(/步频 \d+/).first()).toBeVisible();
  });

  test('常跑路线卡声明可识别地点活动数', async ({ page }) => {
    const card = page.locator('section', { hasText: '常跑路线对比' });
    await expect(card).toBeVisible();
    await expect(card.getByText(/\d+ 次有地点轨迹/)).toBeVisible();
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

  /**
   * 功率区间表 —— 与心率/配速区间表**并列的第三张表**，分母是逐活动不同的 FTP。
   *
   * 夹具只有活动 900000001 有 lap 数据，4 段平均功率 232/298/305/240W，
   * FTP 371W（来自 power_zone_boundaries[3]）→ Z1(0-241) 两段、Z3(297-333) 两段。
   * 断言要点:
   *  1. 表存在且含「时长/距离/次数/平均功率」列（数据层算好但曾经从不展示）；
   *  2. 「参照瓦数」列由参照 FTP 派生（242-296W 是 Z2，不硬编码）；
   *  3. 必须披露「参照值不是定义域」—— 这是功率区间表与另两张表的本质差异。
   */
  test('功率区间表存在, 参照瓦数由中位 FTP 派生, 且披露参照值语义', async ({ page }) => {
    await page.goto('/pbrun/analysis?days=90');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1500);

    const table = tableByColumn(page, '功率区间');
    await expect(table).toBeVisible();

    const joined = (await table.locator('thead th').allInnerTexts()).join('|').replace(/\s+/g, '');
    for (const h of ['功率区间', '参照瓦数', '时长', '距离', '次数', '平均功率']) {
      expect(joined).toContain(h);
    }

    // 参照 FTP = 371W（夹具唯一有 lap 的活动）→ ceil(371*65%)=242 → Z2 242-296W。
    // 若 ranges 被硬编码成「65/80/90/100 %FTP 的固定瓦数」，这里会失败。
    await expect(table).toContainText('242-296W');

    // 夹具只有 1 套 FTP → 不应出现「共 N 个不同 FTP」噪音，但「参照」语义必须在。
    await expect(page.getByText(/「参照瓦数」按参与统计活动的/)).toBeVisible();
    await expect(page.getByText(/不是绝对瓦数/)).toBeVisible();
  });

  test('功率区间表说明三张区间表分母不同 (VDOT / MAX_HR / FTP)', async ({ page }) => {
    await page.goto('/pbrun/analysis?days=90');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1500);
    // 三张表的「Z3」不是同一个强度概念 —— 不说明的话用户会横向对比百分比。
    await expect(
      page.getByText(/配速区间看 VDOT、心率区间看最大心率、功率区间看 FTP/),
    ).toBeVisible();
  });
});

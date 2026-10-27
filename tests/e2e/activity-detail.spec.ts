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

  test('概览应显示推算的 IF/TSS/功率体重比/瞬时峰值功率 (设备从不写入, 但可推算)', async ({ page }) => {
    await page.goto('/pbrun/pages/900000001');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);
    // 夹具只给输入（NP 303 / 平均功率 292 / 峰值 437 / 区间边界 / 体重 68.5）,
    // 派生值必须由 app/lib/power.ts 现场算出 —— 写死的话就绕过了被测代码。
    // 期望: FTP 371(区间边界[3]) → IF 0.82 → TSS 51(moving_time 2750s) → 4.26 W/kg
    await expect(page.getByText('强度因子 IF')).toBeVisible();
    await expect(page.getByText('0.82', { exact: true })).toBeVisible();
    await expect(page.getByText('TSS', { exact: true })).toBeVisible();
    await expect(page.getByText('51', { exact: true })).toBeVisible();
    await expect(page.getByText('功率体重比')).toBeVisible();
    await expect(page.getByText('4.26', { exact: true })).toBeVisible();
    // 437 / 292 = 1.5 倍 → 合理, 展示且标签带「瞬时」
    await expect(page.getByText('瞬时峰值功率')).toBeVisible();
  });

  test('概览应把「累计爬升」与「海拔净高差」分开显示 (191/234 条净高差 < 累计爬升)', async ({ page }) => {
    await page.goto('/pbrun/pages/900000001');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);
    // 夹具: total_ascent 25m / min 284m / max 312m → 净高差 28m。
    // 两个数是不同语义, 标签必须能区分, 否则用户以为数据矛盾。
    await expect(page.getByText('累计爬升')).toBeVisible();
    await expect(page.getByText('25', { exact: true })).toBeVisible();
    await expect(page.getByText('海拔净高差')).toBeVisible();
    await expect(page.getByText('28', { exact: true })).toBeVisible();
  });

  test('跑步动态应显示最高步频 (241/241 跑步活动有值)', async ({ page }) => {
    await page.goto('/pbrun/pages/900000001');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1200);
    await expect(page.getByText('最高步频')).toBeVisible();
    await expect(page.getByText('188 spm')).toBeVisible();
  });

  test('应显示功率区间占比 (本地 5 区 %FTP 口径, 由逐秒功率推导)', async ({ page }) => {
    await page.goto('/pbrun/pages/900000001');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1200);
    // 夹具逐秒功率在五个区间里循环 (200/270/320/350/400W, FTP 371) → 每区 20%。
    // 设备 time_in_power_zone 只有 33/348 有值且是绝对瓦数边界, 故本区块只能来自
    // 逐秒功率推导 —— 若推导链路断开, 这里会整块消失。
    await expect(page.getByText('功率区间占比（Z1–Z5）')).toBeVisible();
    // FTP 是分母, 不显示的话「Z3 20%」无法换算成瓦数
    await expect(page.getByText('FTP 371W')).toBeVisible();
    await expect(page.getByRole('img', { name: '功率区间占比（Z1–Z5）柱状图' })).toBeVisible();
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

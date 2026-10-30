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

  /**
   * **卡片自洽性**：配速必须按计时器时间（`moving_time`）推导，不是经过时间。
   *
   * 缺陷原状（2026-10-27）：配速由 `duration`（FIT `total_elapsed_time`，含暂停）
   * 推导，而「时长」格显示 `moving_time`（`total_timer_time`）。于是同一个活动卡片
   * 自相矛盾 —— 真实库 `582132079` 显示「6.63 km / 43.7 分 / 26:19 每公里」，
   * 而 26:19 × 6.63 = **174.4 分钟**，是显示时长的 4 倍。
   *
   * 夹具活动 1 刻意让 `moving_time`（2750s）≠ `duration`（2800s），两个口径给出的
   * 配速分别是 **343.8 s/km（5:44）** 与 **350 s/km（5:50）**。
   *
   * ## 断言方式：判别式，不是写死数值
   *
   * 不写死「必须显示 5:44」—— 那等于把夹具**输入**当**期望输出**，夹具一改就误报。
   * 这里从页面读出真实渲染的配速，然后断言它**离计时器口径更近、离经过时间口径更远**。
   * 这是一个判别式：只要口径错了，两边距离就必然反转，且不依赖具体数值大小。
   * （两个口径只差 1.8%，所以不能用「落在 ±x% 容差内」——容差比差值还大就测不出来。）
   */
  test('概览配速按计时器时间推导 (离 moving_time 口径更近)', async ({ page }) => {
    await page.goto('/pbrun/pages/900000001');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1200);

    // 精确定位「平均配速」那一格（label 的兄弟节点），不要扫整页 —— 整页还有
    // 分段表/趋势图里的大量 m:ss，容易取到别的值。
    const cell = page.locator('div', { hasText: '平均配速' }).last();
    await expect(page.getByText('平均配速')).toBeVisible();
    const cellText = await cell.innerText();

    const m = /(\d+):(\d{2})/.exec(cellText);
    expect(m).not.toBeNull();
    const displayed = Number(m![1]) * 60 + Number(m![2]);
    // 跑步配速的生理边界，防止把别处的 m:ss（如时长 45:50）误当配速。
    expect(displayed).toBeGreaterThan(120);
    expect(displayed).toBeLessThan(900);

    // 夹具活动 1 的输入（8.0 km / moving_time 2750s / duration 2800s）。
    const distanceKm = 8.0;
    const timerPace = 2750 / distanceKm; // 343.75
    const elapsedPace = 2800 / distanceKm; // 350.00

    const distToTimer = Math.abs(displayed - timerPace);
    const distToElapsed = Math.abs(displayed - elapsedPace);

    // 判别式：必须明显更接近计时器口径。
    expect(distToTimer).toBeLessThan(distToElapsed);
    // 且确实落在计时器口径上（±1 秒取整误差）。
    expect(distToTimer).toBeLessThanOrEqual(1);
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
    // 断言必须**限定在指标卡内**: 「环境可比」卡里也有「本次爬升 25」,
    // 裸 getByText('25', {exact:true}) 会命中两个元素 (strict mode violation)。
    const metric = (label: string) => page.getByText(label, { exact: true }).locator('..');
    await expect(page.getByText('累计爬升')).toBeVisible();
    await expect(metric('累计爬升').getByText('25', { exact: true })).toBeVisible();
    await expect(page.getByText('海拔净高差')).toBeVisible();
    await expect(metric('海拔净高差').getByText('28', { exact: true })).toBeVisible();
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
    // 夹具 1448 条逐秒记录的功率在五个区间里循环 (200/270/320/350/400W, FTP 371)
    // → 每区各 20%。设备 time_in_power_zone 只有 33/348 有值且是绝对瓦数边界,
    // 故本区块只能来自逐秒功率推导 —— 若推导链路断开, 这里会整块消失。
    await expect(page.getByText('功率区间占比（Z1–Z5）')).toBeVisible();
    // FTP 是分母, 不显示的话「Z3 20%」无法换算成瓦数
    await expect(page.getByText('FTP 371W')).toBeVisible();
    await expect(page.getByRole('img', { name: '功率区间占比（Z1–Z5）柱状图' })).toBeVisible();
  });

  test('应显示 AI 教练分析区', async ({ page }) => {
    await page.goto('/pbrun/pages/900000001');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);
    // 34d9906 起标题区分能力维度: 「AI 单次训练分析」+「单次活动」徽标
    await expect(page.getByRole('heading', { name: 'AI 单次训练分析' })).toBeVisible();
  });

  test('应支持返回列表页', async ({ page }) => {
    await page.goto('/pbrun/pages/900000001');
    await page.waitForLoadState('networkidle');
    await page.getByRole('link', { name: '记录' }).click();
    await expect(page).toHaveURL(/\/pbrun\/list$/);
  });
});

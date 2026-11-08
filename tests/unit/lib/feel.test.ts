/**
 * @jest-environment node
 *
 * 主观感受（feel / RPE）与估计出汗量 —— 第十类缺陷第二轮的守卫。
 *
 * ## 为什么需要单独一层
 *
 * `workout_feel` / `workout_rpe` 是**唯一由用户主动输入**的数据（Garmin 活动
 * 结束后弹窗问「感觉如何 / 多累」）。覆盖 **252/354**（全部跑步 + 游泳 + 1 条
 * 室内骑行；力量/球类/爬楼不弹窗）。
 *
 * 它们是「体感 vs 数据」对比的唯一来源：客观指标（TE / 心率漂移）说「这课很轻」，
 * 而用户标了 RPE 9，才是真正值得解释的信号。若只把 0–100 的裸数字丢到页面上，
 * 用户不知道 25 比 50 好还是差。
 *
 * ## 两条自证（实测，都不依赖外部标准）
 *
 * 1. **`r(feel, rpe) = −0.856`**（n=251）—— 感觉越好 RPE 越低。若解析错位
 *    （比如 rpe 忘了 FIT scale=10，全变成 20–90），相关性会消失或变正。
 * 2. **feel 各档的 RPE 均值严格单调**：0→8.1、25→5.9、50→3.8、75→2.4、100→1.4。
 *    五档五值，无一例外 —— 说明两个字段描述的是同一件事的两面。
 *
 * ## `feel = 0` 是有效值
 *
 * 14/252 条是 `feel = 0`（感觉最糟）。任何 `if (feel)` 的真值判断都会把这 14 条
 * 当成「没有填写」而静默丢掉。判空必须用 `!= null`。
 *
 * ## 出汗量是**设备估算值**且有速率上限
 *
 * `est_sweat_loss` 覆盖 350/354（除游泳 0/4）。实测 306 条有效速率里 **88 条**
 * 达到 999–1000 ml/h 的天花板（p90 = 989、p99 = 999、max = 999，无一超过 1000），
 * 而真实出汗率可达 1500–2000 ml/h。所以它是**保守下限**，展示必须带「约」，
 * 且绝不能当实测值用于医学判断。
 */
import {
  FEEL_LEVELS,
  feelLabel,
  rpeLabel,
  formatSweatLoss,
  sweatRateMlPerHour,
  SWEAT_RATE_CAP_ML_PER_H,
} from '../../../app/lib/feel';

describe('feelLabel —— 0/25/50/75/100 五档，0 是有效值', () => {
  test('五档全部有中文标签', () => {
    expect(FEEL_LEVELS.map((x) => x.value)).toEqual([0, 25, 50, 75, 100]);
    expect(feelLabel(0)).toBe('很差');
    expect(feelLabel(25)).toBe('较差');
    expect(feelLabel(50)).toBe('一般');
    expect(feelLabel(75)).toBe('良好');
    expect(feelLabel(100)).toBe('很好');
  });

  test('feel = 0 必须返回「很差」而不是 null（14/252 条是 0）', () => {
    // 这一条是整组测试的核心：任何 `if (feel)` 的真值判断都会丢掉这 14 条
    expect(feelLabel(0)).not.toBeNull();
    expect(feelLabel(0)).toBe('很差');
  });

  test('缺失 → null（不是「一般」）', () => {
    expect(feelLabel(null)).toBeNull();
    expect(feelLabel(undefined)).toBeNull();
  });

  test('非 5 档的值 → null（不猜测）', () => {
    // Garmin 只发这 5 个值。出现 33 说明解析错位，宁可整项不显示
    expect(feelLabel(33)).toBeNull();
    expect(feelLabel(-1)).toBeNull();
    expect(feelLabel(101)).toBeNull();
  });
});

describe('rpeLabel —— Borg CR10 1–10', () => {
  test('1–10 全部有标签，且随数值单调变难', () => {
    const labels = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((v) => rpeLabel(v));
    expect(labels.every((x) => x != null)).toBe(true);
    expect(rpeLabel(1)).toBe('极轻松');
    expect(rpeLabel(10)).toBe('极限');
  });

  test('缺失 / 越界 → null', () => {
    expect(rpeLabel(null)).toBeNull();
    expect(rpeLabel(undefined)).toBeNull();
    expect(rpeLabel(0)).toBeNull();
    expect(rpeLabel(11)).toBeNull();
    // 小数不是合法 RPE（FIT scale=10 已应用，解析后是整数）
    expect(rpeLabel(3.5)).toBeNull();
  });
});

describe('formatSweatLoss —— 必须带「约」（设备估算值，且有速率上限）', () => {
  test('正常值输出「约 519 ml」', () => {
    expect(formatSweatLoss(519)).toBe('约 519 ml');
    expect(formatSweatLoss(1794)).toBe('约 1794 ml');
  });

  test('缺失 / 非正 → null', () => {
    expect(formatSweatLoss(null)).toBeNull();
    expect(formatSweatLoss(undefined)).toBeNull();
    expect(formatSweatLoss(0)).toBeNull();
    expect(formatSweatLoss(-5)).toBeNull();
  });

  test('文案里必须有「约」—— 去掉就变成「实测 519ml」的假话', () => {
    const s = formatSweatLoss(519)!;
    expect(s).toContain('约');
    expect(s).not.toMatch(/^519/);
  });
});

describe('sweatRateMlPerHour —— 上限 1000 ml/h 是设备 cap', () => {
  test('真实库样本：519ml / 0.67h → 约 776 ml/h', () => {
    // 659052168: sweat=519ml, moving_time=2412s
    expect(sweatRateMlPerHour(519, 2412)).toBe(775);
  });

  test('真实库上限样本：1794ml / 1.83h → 983 ml/h', () => {
    // 657456825: sweat=1794ml, moving_time=6588s
    expect(sweatRateMlPerHour(1794, 6588)).toBe(980);
  });

  test('绝不输出 > 1000（实测 306 条无一超过 999）', () => {
    // 500ml / 600s = 3000 ml/h 属脏数据，必须被 cap 到 1000 而不是原样输出
    const r = sweatRateMlPerHour(500, 600);
    expect(r).not.toBeNull();
    expect(r!).toBe(SWEAT_RATE_CAP_ML_PER_H);
    expect(SWEAT_RATE_CAP_ML_PER_H).toBe(1000);
  });

  test('时长缺失 / 为 0 → null（不能除以 0）', () => {
    expect(sweatRateMlPerHour(519, null)).toBeNull();
    expect(sweatRateMlPerHour(519, undefined)).toBeNull();
    expect(sweatRateMlPerHour(519, 0)).toBeNull();
    expect(sweatRateMlPerHour(null, 2412)).toBeNull();
    expect(sweatRateMlPerHour(0, 2412)).toBeNull();
  });

  test('过短的活动不算速率（< 5 分钟，噪声太大）', () => {
    expect(sweatRateMlPerHour(519, 120)).toBeNull();
  });
});

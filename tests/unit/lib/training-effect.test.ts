/**
 * `app/lib/training-effect.ts` 的单测。
 *
 * 这一层的存在理由是「三处消费面口径一致」，但**单元测试守的是边界**：
 *  - `null` / `undefined` / `NaN` / `Infinity` → `null`（调用方整项不渲染）；
 *  - **`0` → `'0.0'`**（有效值，真实库羽毛球 560273729 精确为 0）；
 *  - 一位小数（与详情页 / AI 数据块一致）。
 *
 * 若这里把 `0` 当成假值返回 `null`，羽毛球 1 条 + 跳绳 3 条（0–0.1）的
 * 强度信号会在三处同时消失 —— 而它们恰恰是「这课基本没有训练刺激」的
 * 唯一证据。这类缺陷只在真实数据上暴露，故单测必须显式钉住 `0`。
 */
import { formatTrainingEffect, TRAINING_EFFECT_DETAIL_LABEL, TRAINING_EFFECT_LABEL } from '@/app/lib/training-effect';

describe('formatTrainingEffect', () => {
  test('保留一位小数（与详情页 / AI 数据块一致）', () => {
    expect(formatTrainingEffect(0.9)).toBe('0.9');
    expect(formatTrainingEffect(3.64)).toBe('3.6');
    expect(formatTrainingEffect(5)).toBe('5.0');
    expect(formatTrainingEffect(1.25)).toBe('1.3');
  });

  /**
   * **`0` 是有效值**。真实库羽毛球 `560273729` 的 `total_training_effect`
   * 精确为 0、跳绳 3 条为 0–0.1。
   */
  test('0 → 「0.0」（有效值, 不是缺失）', () => {
    expect(formatTrainingEffect(0)).toBe('0.0');
  });

  test('null / undefined / 非有限数 → null（调用方整项不渲染）', () => {
    expect(formatTrainingEffect(null)).toBeNull();
    expect(formatTrainingEffect(undefined)).toBeNull();
    expect(formatTrainingEffect(Number.NaN)).toBeNull();
    expect(formatTrainingEffect(Number.POSITIVE_INFINITY)).toBeNull();
    expect(formatTrainingEffect(Number.NEGATIVE_INFINITY)).toBeNull();
  });

  /**
   * 标签必须两套：详情页同时展示有氧/无氧两格，写「训练效果」会让用户以为
   * 那一格是合计；卡片只展示有氧，短标签即可。两者都从这里出，避免措辞漂移。
   */
  test('两套标签：卡片短标签 + 详情页「有氧」限定', () => {
    expect(TRAINING_EFFECT_LABEL).toBe('训练效果');
    expect(TRAINING_EFFECT_DETAIL_LABEL).toBe('有氧训练效果');
    // 详情页标签必须带「有氧」，否则与相邻的「无氧训练效果」并列时含义不清
    expect(TRAINING_EFFECT_DETAIL_LABEL).toContain('有氧');
    expect(TRAINING_EFFECT_LABEL).not.toContain('有氧');
  });
});

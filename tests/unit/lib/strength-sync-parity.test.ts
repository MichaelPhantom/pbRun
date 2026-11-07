/**
 * 力量负荷口径的**双实现一致性守护**。
 *
 * `app/lib/strength.ts`（TS，服务端/MCP 用）与 `scripts/common/strength-load.js`
 * （JS 镜像，同步脚本用）必须给出**逐位相同**的结果。为什么要两份实现：
 * `scripts/garmin/sync.js` 是纯 CJS 脚本，无法 import TS 模块（不经 tsc 构建）。
 *
 * 这份测试用同一批输入逐一比对两边输出 —— 任一侧改了阈值/系数而另一侧没跟上，
 * 立刻红灯。没有它，同步写入的 `training_load` 会与页面/MCP 展示的负荷分叉，
 * 而这种分叉**不会报错、不会让任何测试变红**，只在 ACWR 数字对不上时显形。
 */
import {
  estimateStrengthLoad,
  strengthIntensityDomain,
  strengthLoadBaseSeconds,
} from '@/app/lib/strength';

const jsImpl = require('../../../scripts/common/strength-load');

/** 穷举 TE × 心率的组合（含边界与缺失值）。 */
const TE_VALUES: (number | null)[] = [null, 0, 0.1, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0, 5.0, NaN];
const HR_VALUES: (number | null)[] = [null, 0, 70, 90, 99, 100, 110, 129, 130, 140, 180, NaN];

describe('strengthIntensityDomain: TS ↔ JS 逐位一致', () => {
  test('穷举 TE × 心率组合', () => {
    for (const te of TE_VALUES) {
      for (const hr of HR_VALUES) {
        const ts = strengthIntensityDomain(te, hr);
        const js = jsImpl.strengthIntensityDomain(te, hr);
        expect({ te, hr, ts }).toEqual({ te, hr, ts: js });
      }
    }
  });
});

describe('estimateStrengthLoad: TS ↔ JS 逐位一致', () => {
  test('穷举时长 × 强度域', () => {
    const durations: (number | null)[] = [null, 0, -1, 60, 600, 1800, 1920, 3600, 3609, 7200, NaN];
    const domains = ['recovery', 'base', 'tempo', 'high', 'unknown'] as const;
    for (const d of durations) {
      for (const domain of domains) {
        expect(estimateStrengthLoad(d, { intensityDomain: domain })).toBe(
          jsImpl.estimateStrengthLoad(d, domain),
        );
      }
    }
  });
});

describe('strengthLoadBaseSeconds: TS ↔ JS 逐位一致', () => {
  test('穷举计时器时间 × 经过时间', () => {
    const vals: (number | null)[] = [null, 0, -1, 60, 1800, 3600, NaN];
    for (const moving of vals) {
      for (const dur of vals) {
        expect(strengthLoadBaseSeconds(moving, dur)).toBe(jsImpl.strengthLoadBaseSeconds(moving, dur));
      }
    }
  });
});

describe('calculateStrengthLoad (JS 组合入口) 与 TS 组合等价', () => {
  test('真实库样本逐一比对', () => {
    const samples = [
      // 核心稳定性1: 3609s, TE 0.1, HR 73
      { moving_time: 3609, duration: 3609, average_heart_rate: 73, total_training_effect: 0.1 },
      // 全身循环2: 1446s, TE ~0.6, HR 117
      { moving_time: 1446, duration: 1446, average_heart_rate: 117, total_training_effect: 0.6 },
      // 高强度循环: 1920s, TE 4.0, HR 120
      { moving_time: 1920, duration: 1920, average_heart_rate: 120, total_training_effect: 4.0 },
      // 无 TE 有 HR
      { moving_time: 1800, duration: 1800, average_heart_rate: 140, total_training_effect: null },
      // 全缺失
      { moving_time: null, duration: null, average_heart_rate: null, total_training_effect: null },
      // moving_time 缺失回退 duration
      { moving_time: 0, duration: 2400, average_heart_rate: 100, total_training_effect: 2.0 },
    ];
    for (const s of samples) {
      const domain = strengthIntensityDomain(s.total_training_effect, s.average_heart_rate);
      const ts = estimateStrengthLoad(
        strengthLoadBaseSeconds(s.moving_time, s.duration),
        { intensityDomain: domain },
      );
      expect(jsImpl.calculateStrengthLoad(s)).toBe(ts);
    }
  });
});

describe('系数常量一致 (改阈值必须两侧同步)', () => {
  test('DOMAIN_FACTORS 与 TS 实现内联的系数相同', () => {
    // 用已知时长反推系数：1800s = 0.5h × 100 = 50 基线
    const base = 50;
    expect(jsImpl.DOMAIN_FACTORS.high).toBeCloseTo(1.5, 10);
    expect(jsImpl.DOMAIN_FACTORS.tempo).toBeCloseTo(1.3, 10);
    expect(jsImpl.DOMAIN_FACTORS.base).toBeCloseTo(1.0, 10);
    expect(jsImpl.DOMAIN_FACTORS.recovery).toBeCloseTo(0.6, 10);
    expect(jsImpl.DOMAIN_FACTORS.unknown).toBeCloseTo(0.8, 10);
    // TS 侧同值验证（通过输出反推）
    expect(estimateStrengthLoad(1800, { intensityDomain: 'high' })).toBe(Math.round(base * 1.5));
    expect(estimateStrengthLoad(1800, { intensityDomain: 'recovery' })).toBe(Math.round(base * 0.6));
  });
});

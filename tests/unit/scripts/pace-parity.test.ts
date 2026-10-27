/**
 * `scripts/common/pace.js` 是 `app/lib/pace.ts` 的 CJS 镜像 —— 一致性守护。
 *
 * ## 为什么必须有这层守护
 *
 * 配速的时间基数（计时器时间 `moving_time` vs 经过时间 `duration`）必须**只有
 * 一个答案**。但写入侧（`scripts/garmin/fit-parser.js`、`backfill-vdot.js`）是
 * CommonJS，无法 require TS 模块，所以只能镜像一份纯函数。
 *
 * 两份实现一旦漂移，症状极其隐蔽：
 *  - 同步时写进库的 `average_pace` 用一套口径，UI/AI 读出来又按另一套理解；
 *  - 校验器（`validate-data.js`）会**站在其中一边**宣布「全部正确」；
 *  - 没有任何报错，只有数字悄悄错开。
 *
 * 与 `hr-zones-parity` / `power-zones-parity` 同一模式：逐值比对，不靠人眼。
 */
import { effectiveTimeSec, paceSecPerKm, speedKmh } from '@/app/lib/pace';

const cjs = require('../../../scripts/common/pace.js');

describe('pace CJS 镜像与 TS 源一致', () => {
  /**
   * 覆盖真实库里出现过的全部时间形态：
   *  - 两者都有且相等（2972 - 138 个 lap、大部分活动）
   *  - `moving_time` < `duration`（138 个 lap / 110 个活动，暂停场景）
   *  - `moving_time` = 0 / null（2 个 lap）
   *  - `duration` = 0 / null（异常行）
   *  - 负值 / NaN / 字符串（脏数据与 JSON 反序列化边界）
   */
  const timeCases: Array<Record<string, unknown>> = [
    { moving_time: 2750, duration: 2800 },
    { moving_time: 392, duration: 983 },
    { moving_time: 0, duration: 300 },
    { moving_time: null, duration: 300 },
    { moving_time: undefined, duration: 300 },
    { moving_time: 300, duration: 0 },
    { moving_time: 300, duration: null },
    { moving_time: 0, duration: 0 },
    { moving_time: null, duration: null },
    { moving_time: -5, duration: 300 },
    { moving_time: Number.NaN, duration: 300 },
    { moving_time: 300, duration: -1 },
    { moving_time: Number.POSITIVE_INFINITY, duration: 300 },
    { moving_time: 1, duration: 1 },
  ];

  test('effectiveTimeSec 逐形态一致', () => {
    for (const row of timeCases) {
      expect({ row, v: cjs.effectiveTimeSec(row) }).toEqual({ row, v: effectiveTimeSec(row as never) });
    }
  });

  test('effectiveTimeSec: 空对象 / undefined / null 一致 (不得抛错)', () => {
    for (const row of [{}, undefined, null]) {
      expect(cjs.effectiveTimeSec(row as never)).toBe(effectiveTimeSec(row as never));
    }
  });

  test('paceSecPerKm 逐形态一致 (含距离边界)', () => {
    const distances = [8, 6.63, 7.17, 1, 0.016, 0, -1, null, undefined, Number.NaN];
    const seconds = [2750, 392, 1, 0, -1, null, undefined, Number.NaN];
    for (const d of distances) {
      for (const s of seconds) {
        expect({ d, s, v: cjs.paceSecPerKm(d, s) }).toEqual({ d, s, v: paceSecPerKm(d as never, s as never) });
      }
    }
  });

  test('speedKmh 逐形态一致 (与 pace 严格互为倒数)', () => {
    const distances = [8, 6.63, 1, 0, null];
    const seconds = [2750, 392, 1, 0, null];
    for (const d of distances) {
      for (const s of seconds) {
        const a = cjs.speedKmh(d, s);
        const b = speedKmh(d as never, s as never);
        expect({ d, s, v: a }).toEqual({ d, s, v: b });
        if (a != null) expect(a * (cjs.paceSecPerKm(d, s) as number)).toBeCloseTo(3600, 9);
      }
    }
  });

  /**
   * 真实库锚点：这些数字来自生产数据，是「口径应该是哪个」的证据。
   *
   * 若哪天有人把实现改回 `duration`，前两条会立刻变红。
   */
  test('真实库锚点: 暂停较多的活动用计时器时间', () => {
    // 582132079: 6.63 km / moving_time 2621s / duration 10465s
    const row = { moving_time: 2621, duration: 10465 };
    expect(effectiveTimeSec(row)).toBe(2621);
    // 6:35/km（展示口径），而不是 26:19/km（含 7845s 暂停）
    expect(paceSecPerKm(6.63, effectiveTimeSec(row))).toBeCloseTo(395.3, 0);
  });

  test('真实库锚点: 16 m 的收尾段不再算出 60792 s/km', () => {
    // 598287817 lap 7: 16 m / moving_time 392s / duration 983s
    const row = { moving_time: 392, duration: 983 };
    expect(effectiveTimeSec(row)).toBe(392);
    // 392s / 0.016km = 24500 s/km（仍然很慢，但这是真实数据：走完最后 16 米）
    expect(paceSecPerKm(0.016, effectiveTimeSec(row))).toBe(24500);
  });
});

/**
 * CJS 镜像与 TS 源的一致性守护。
 *
 * `scripts/common/hr-zones.js` 是 `app/lib/hr-zones.ts` 的 CommonJS 镜像
 * （同步脚本是 CJS，无法 require TS）。两份实现漂移会让**同步时写入库的区间**
 * 与**UI/AI 读到的区间**对不上 —— 这类缺陷不会报错，只会让数字悄悄错开。
 * 与 `route-shape` 的 parity 测试同一模式。
 */
import {
  hrZoneOf,
  hrZoneSecondsFromSamples,
  resolveMaxHr,
  HR_ZONE_BOUNDS,
  DEFAULT_MAX_HR,
  HR_SAMPLE_MAX_GAP_SEC,
} from '@/app/lib/hr-zones';
const cjs = require('../../../scripts/common/hr-zones.js');

describe('hr-zones CJS 镜像与 TS 源一致', () => {
  test('常量一致', () => {
    expect(cjs.HR_ZONE_BOUNDS).toEqual([...HR_ZONE_BOUNDS]);
    expect(cjs.DEFAULT_MAX_HR).toBe(DEFAULT_MAX_HR);
    expect(cjs.HR_SAMPLE_MAX_GAP_SEC).toBe(HR_SAMPLE_MAX_GAP_SEC);
  });

  test('resolveMaxHr 对各种输入一致', () => {
    for (const raw of [undefined, '', 'abc', '0', '-5', '194', '190', '150.7', ' 200 ']) {
      expect(cjs.resolveMaxHr(raw)).toBe(resolveMaxHr(raw));
    }
  });

  test('hrZoneOf 逐 bpm 扫描一致 (覆盖 40-220 与多个 MAX_HR)', () => {
    for (const maxHr of [150, 180, 190, 194, 197, 210]) {
      for (let hr = 40; hr <= 220; hr++) {
        expect({ maxHr, hr, zone: cjs.hrZoneOf(hr, maxHr) }).toEqual({
          maxHr,
          hr,
          zone: hrZoneOf(hr, maxHr),
        });
      }
    }
  });

  test('hrZoneSecondsFromSamples 对真实形态样本一致', () => {
    const cases = [
      [],
      [{ elapsedSec: 0, heartRate: 120 }],
      [
        { elapsedSec: 0, heartRate: 120 },
        { elapsedSec: 1, heartRate: 130 },
        { elapsedSec: 2, heartRate: 175 },
      ],
      // 暂停空档: 应被 maxGapSec 截断
      [
        { elapsedSec: 0, heartRate: 120 },
        { elapsedSec: 300, heartRate: 175 },
      ],
      // 乱序输入: 应自行排序
      [
        { elapsedSec: 2, heartRate: 175 },
        { elapsedSec: 0, heartRate: 120 },
        { elapsedSec: 1, heartRate: 130 },
      ],
      // 无效心率: 应被跳过
      [
        { elapsedSec: 0, heartRate: null },
        { elapsedSec: 1, heartRate: 0 },
        { elapsedSec: 2, heartRate: 160 },
        { elapsedSec: 3, heartRate: Number.NaN },
      ],
      // 同一秒多条
      [
        { elapsedSec: 5, heartRate: 150 },
        { elapsedSec: 5, heartRate: 160 },
        { elapsedSec: 6, heartRate: 170 },
      ],
    ];
    for (const maxHr of [190, 194]) {
      for (const samples of cases) {
        expect({ maxHr, samples, out: cjs.hrZoneSecondsFromSamples(samples, maxHr) }).toEqual({
          maxHr,
          samples,
          out: hrZoneSecondsFromSamples(samples, maxHr),
        });
      }
    }
  });
});

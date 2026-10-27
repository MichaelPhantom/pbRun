/**
 * CJS 镜像与 TS 源的一致性守护（功率区间 + FTP 解析）。
 *
 * `scripts/common/power-zones.js` 是 `app/lib/power-zones.ts`（区间判定）与
 * `app/lib/power.ts`（FTP 解析）的 CommonJS 镜像 —— 同步脚本是 CJS，无法 require TS。
 * 两份实现漂移会让**同步时写入库的区间**与**UI/AI 读到的区间**对不上；
 * 这类缺陷不报错，只会让数字悄悄错开。与 `hr-zones-parity` 同一模式。
 */
import {
  DEVICE_POWER_ZONE_BOUNDS_PCT,
  POWER_SAMPLE_MAX_GAP_SEC,
  POWER_ZONE_BOUNDS,
  powerZoneBoundsLabel,
  powerZoneOf,
  powerZoneSecondsFromSamples,
} from '@/app/lib/power-zones';
import { FTP_MAX_W, FTP_MIN_W, POWER_ZONE_FTP_INDEX, resolveFtp } from '@/app/lib/power';

const cjs = require('../../../scripts/common/power-zones.js');

describe('power-zones CJS 镜像与 TS 源一致', () => {
  test('常量一致', () => {
    expect(cjs.POWER_ZONE_BOUNDS).toEqual([...POWER_ZONE_BOUNDS]);
    expect(cjs.DEVICE_POWER_ZONE_BOUNDS_PCT).toEqual([...DEVICE_POWER_ZONE_BOUNDS_PCT]);
    expect(cjs.POWER_SAMPLE_MAX_GAP_SEC).toBe(POWER_SAMPLE_MAX_GAP_SEC);
    expect(cjs.FTP_MIN_W).toBe(FTP_MIN_W);
    expect(cjs.FTP_MAX_W).toBe(FTP_MAX_W);
    expect(cjs.POWER_ZONE_FTP_INDEX).toBe(POWER_ZONE_FTP_INDEX);
  });

  test('powerZoneBoundsLabel 文案一致', () => {
    expect(cjs.powerZoneBoundsLabel()).toBe(powerZoneBoundsLabel());
  });

  test('powerZoneOf 逐瓦扫描一致 (覆盖 0-1200W 与多个 FTP)', () => {
    for (const ftp of [150, 250, 338, 371, 480, 600]) {
      for (let w = 0; w <= 1200; w += 1) {
        expect({ ftp, w, zone: cjs.powerZoneOf(w, ftp) }).toEqual({ ftp, w, zone: powerZoneOf(w, ftp) });
      }
    }
  });

  test('powerZoneOf 非法输入一致 (null 语义)', () => {
    const cases: [number, number][] = [
      [0, 371],
      [-5, 371],
      [Number.NaN, 371],
      [300, 0],
      [300, -1],
      [300, Number.NaN],
    ];
    for (const [w, ftp] of cases) {
      expect({ w, ftp, z: cjs.powerZoneOf(w, ftp) }).toEqual({ w, ftp, z: powerZoneOf(w, ftp) });
    }
  });

  test('powerZoneSecondsFromSamples 对真实形态样本一致', () => {
    const cases = [
      [],
      [{ elapsedSec: 0, power: 200 }],
      [
        { elapsedSec: 0, power: 200 },
        { elapsedSec: 1, power: 300 },
        { elapsedSec: 2, power: 420 },
      ],
      // 暂停空档: 应被 maxGapSec 截断
      [
        { elapsedSec: 0, power: 200 },
        { elapsedSec: 300, power: 420 },
      ],
      // 乱序输入: 应自行排序
      [
        { elapsedSec: 2, power: 420 },
        { elapsedSec: 0, power: 200 },
        { elapsedSec: 1, power: 300 },
      ],
      // 无效功率: 应被跳过
      [
        { elapsedSec: 0, power: null },
        { elapsedSec: 1, power: 0 },
        { elapsedSec: 2, power: 380 },
        { elapsedSec: 3, power: Number.NaN },
      ],
      // 同一秒多条
      [
        { elapsedSec: 5, power: 300 },
        { elapsedSec: 5, power: 420 },
        { elapsedSec: 6, power: 500 },
      ],
    ];
    for (const ftp of [338, 371]) {
      for (const samples of cases) {
        expect({ ftp, samples, out: cjs.powerZoneSecondsFromSamples(samples, ftp) }).toEqual({
          ftp,
          samples,
          out: powerZoneSecondsFromSamples(samples, ftp),
        });
      }
    }
  });

  test('FTP 解析逐值一致 (显式优先 / 区间回退 / 形状拒绝)', () => {
    const cases: Array<Record<string, unknown>> = [
      { functional_threshold_power: 343 },
      { power_zone_boundaries: '[241,297,334,371,427,4000,null,null]' },
      { functional_threshold_power: 350, power_zone_boundaries: '[241,297,334,371,427]' },
      { functional_threshold_power: 0, power_zone_boundaries: '[241,297,334,371,427]' },
      { functional_threshold_power: 9999, power_zone_boundaries: '[241,297,334,371,427]' },
      {},
      { functional_threshold_power: null, power_zone_boundaries: null },
      { power_zone_boundaries: 'not json' },
      { power_zone_boundaries: '[1,2,3]' },
      { power_zone_boundaries: '[1,2,3,4]' },
      { power_zone_boundaries: '[300,290,280,270]' },
      { power_zone_boundaries: '[241,297,334,371,300]' },
      { power_zone_boundaries: '[null,null,null,null,null,null,null,null]' },
      { functional_threshold_power: FTP_MIN_W },
      { functional_threshold_power: FTP_MAX_W },
      { functional_threshold_power: FTP_MAX_W + 1 },
    ];
    for (const a of cases) {
      expect({ a, out: cjs.resolveFtp(a) }).toEqual({ a, out: resolveFtp(a as never) });
    }
  });
});

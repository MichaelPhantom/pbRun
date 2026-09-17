/**
 * @jest-environment node
 *
 * getPaceZoneStats 回归测试。
 * 修复点:
 *  - activity_count 应为「去重活动数」而非 lap 计数 (与 getHrZoneStats 口径一致)
 *  - avg_* 应按 lap 时长加权 (此前简单平均, 长短 lap 等权)
 */
jest.unmock('better-sqlite3');

const lapRows = [
  // 活动 100: 3 个 lap, 全部慢速 → Z1
  { activity_id: 100, lap_index: 0, distance: 1000, duration: 400, average_pace: 400, average_heart_rate: 130, average_cadence: 170, average_stride_length: 1.0 },
  { activity_id: 100, lap_index: 1, distance: 1000, duration: 410, average_pace: 410, average_heart_rate: 132, average_cadence: 172, average_stride_length: 1.0 },
  { activity_id: 100, lap_index: 2, distance: 1000, duration: 420, average_pace: 420, average_heart_rate: 134, average_cadence: 174, average_stride_length: 1.1 },
  // 活动 200: 1 个 lap, 更慢 → Z1 (用于验证去重计数 = 2 而非 4)
  { activity_id: 200, lap_index: 0, distance: 5000, duration: 2500, average_pace: 450, average_heart_rate: 120, average_cadence: 160, average_stride_length: 0.9 },
];

const allMock = jest.fn(() => lapRows);
jest.mock('better-sqlite3', () =>
  jest.fn().mockImplementation(() => ({
    prepare: jest.fn(() => ({ all: allMock, get: jest.fn(), run: jest.fn() })),
    close: jest.fn(),
  })),
);
jest.mock('fs', () => ({ existsSync: jest.fn(() => true) }));

import { getPaceZoneStats } from '@/app/lib/db';

describe('getPaceZoneStats', () => {
  test('activity_count 为去重活动数 (回归: 此前按 lap 计为 4)', () => {
    const stats = getPaceZoneStats(45, '2026-01-01', '2026-12-31');
    const z1 = stats.find((s) => s.zone === 1)!;
    // 活动 100 的 3 个 lap + 活动 200 的 1 个 lap 均落 Z1 → 去重活动数 = 2
    expect(z1.activity_count).toBe(2);
    // 其余区间无数据
    for (const z of [2, 3, 4, 5]) {
      expect(stats.find((s) => s.zone === z)!.activity_count).toBe(0);
    }
  });

  test('avg_pace 按时长加权 (回归: 此前简单平均)', () => {
    const stats = getPaceZoneStats(45, '2026-01-01', '2026-12-31');
    const z1 = stats.find((s) => s.zone === 1)!;
    // 时长加权: (400*400 + 410*410 + 420*420 + 450*2500) / (400+410+420+2500)
    const expected =
      (400 * 400 + 410 * 410 + 420 * 420 + 450 * 2500) / (400 + 410 + 420 + 2500);
    expect(z1.avg_pace).toBeCloseTo(expected, 6);
    // 与简单平均不同 (证明确实加权)
    const simple = (400 + 410 + 420 + 450) / 4;
    expect(z1.avg_pace).not.toBeCloseTo(simple, 3);
  });

  test('空区间 avg_* 为 null (非 0)', () => {
    const stats = getPaceZoneStats(45, '2026-01-01', '2026-12-31');
    expect(stats.find((s) => s.zone === 5)!.avg_pace).toBeNull();
    expect(stats.find((s) => s.zone === 5)!.avg_heart_rate).toBeNull();
  });

  test('非法 vdot (<=0) → 空数组', () => {
    expect(getPaceZoneStats(0, '2026-01-01', '2026-12-31')).toEqual([]);
  });
});

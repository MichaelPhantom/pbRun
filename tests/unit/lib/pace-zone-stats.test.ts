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
  // 5 km @ 450 s/km → 时长必须是 2250s（旧夹具写 2500 = 500 s/km，自相矛盾）
  { activity_id: 200, lap_index: 0, distance: 5000, duration: 2250, average_pace: 450, average_heart_rate: 120, average_cadence: 160, average_stride_length: 0.9 },
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

  /**
   * 均配速 ≡ **同一行的** total_duration / total_distance。
   *
   * 这一行的三个数字并排展示，用户可以直接相除验算。旧实现是逐 lap 的
   * 时长加权均值 —— 真实库 Z1 行给 406.0，而它自己的总时长/总距离是 388.1
   * （差 18 s/km），同一行自相矛盾。
   */
  test('avg_pace ≡ 同行总时长/总距离 (可被用户验算)', () => {
    const stats = getPaceZoneStats(45, '2026-01-01', '2026-12-31');
    const z1 = stats.find((s) => s.zone === 1)!;
    const expected = (400 + 410 + 420 + 2250) / 8; // Σt / Σd(km) = 435
    expect(z1.avg_pace).toBeCloseTo(expected, 6);
    expect(z1.avg_pace! * (z1.total_distance / 1000)).toBeCloseTo(z1.total_duration, 6);
    // 判别式: 各 lap 配速的算术平均是 420
    expect(z1.avg_pace).not.toBeCloseTo((400 + 410 + 420 + 450) / 4, 1);
  });

  /**
   * 计时器列全缺（moving_time 与 duration 都为 0）但配速有值时，
   * 时长由 `配速 × 距离` 还原 —— 否则「总时长 0 / 总距离 1km」会算出均配速 0。
   */
  test('计时器列全缺 → 时长由 pace×distance 还原，均配速不为 0', () => {
    const stats = getPaceZoneStats(45, '2026-01-01', '2026-12-31');
    const z1 = stats.find((s) => s.zone === 1)!;
    expect(z1.total_duration).toBe(3480); // 400+410+420+2250
    expect(z1.avg_pace).toBeCloseTo(435, 6);
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

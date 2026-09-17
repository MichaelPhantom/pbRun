/**
 * @jest-environment node
 *
 * runner-profile 单测 — 跑者画像聚合与 prompt 文本生成。
 * DB 依赖通过 mock db 注入固定数据。
 */
jest.unmock('better-sqlite3');

jest.mock('@/app/lib/db', () => ({
  getActivities: jest.fn(),
  getPersonalRecords: jest.fn(),
  getStats: jest.fn(),
  getTrainingLoads: jest.fn(),
  getVDOTHistory: jest.fn(),
}));

// training-load 使用真实实现 (纯函数)
import * as db from '@/app/lib/db';
import { buildRunnerProfile, formatRunnerProfile } from '@/app/lib/runner-profile';

const baseActivity = {
  activity_id: 100,
  start_time: '2026-09-17T10:00:00.000Z',
  start_time_local: '2026-09-17T18:00:00',
  name: '今日跑',
  distance: 10,
  average_pace: 360,
} as never;

function setDbMocks(over: Record<string, unknown> = {}) {
  (db.getStats as jest.Mock).mockReturnValue({
    totalDistance: 1_000_000, // 米 → 1000 km
    totalActivities: 200,
    averageCadence: 178,
    averageHeartRate: 148,
  });
  (db.getActivities as jest.Mock).mockImplementation((params: { limit: number }) => {
    if (params.limit >= 500) {
      // 最早一条查询
      return { data: [{ activity_id: 1, start_time: '2024-01-01T00:00:00Z', start_time_local: '2024-01-01', distance: 5 }] };
    }
    return {
      data: [
        { activity_id: 100, start_time: '2026-09-17T10:00:00.000Z', distance: 10 }, // 本次 (应排除)
        { activity_id: 99, start_time: '2026-09-15T10:00:00.000Z', start_time_local: '2026-09-15T18:00:00', name: '上次', distance: 8, average_pace: 330 },
        { activity_id: 98, start_time: '2026-09-01T10:00:00.000Z', start_time_local: '2026-09-01T18:00:00', name: '较早', distance: 12, average_pace: 350 },
      ],
    };
  });
  (db.getTrainingLoads as jest.Mock).mockReturnValue([
    { date: '2026-09-17', load: 50 },
  ]);
  (db.getVDOTHistory as jest.Mock).mockReturnValue([
    { activity_id: 100, start_time: '2026-09-17T10:00:00.000Z', vdot_value: 46, distance: 10000, duration: 3600 },
    { activity_id: 50, start_time: '2026-08-01T10:00:00.000Z', vdot_value: 42, distance: 10000, duration: 3600 },
  ]);
  (db.getPersonalRecords as jest.Mock).mockReturnValue({
    period: 'total',
    startDate: '1970-01-01',
    endDate: '2026-09-17',
    records: [
      { distanceLabel: '5公里最佳成绩', durationSeconds: 1230, achievedAt: '2025-11-15' },
      { distanceLabel: '10公里最佳成绩', durationSeconds: null, achievedAt: null },
    ],
    longestRunMeters: 21750,
    longestRunDate: '2026-03-15',
  });
  for (const [k, v] of Object.entries(over)) {
    (db[k as keyof typeof db] as jest.Mock).mockReturnValue(v);
  }
}

describe('buildRunnerProfile', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setDbMocks();
  });

  test('聚合生涯/近期/负荷/跑力/PB/习惯', () => {
    const p = buildRunnerProfile(baseActivity);
    expect(p.lifetimeKm).toBe(1000);
    expect(p.lifetimeRuns).toBe(200);
    expect(p.firstRunYear).toBe(2024);
    expect(p.last7Runs).toBe(1); // 仅 09-15 (本次排除)
    expect(p.vdotNow).toBe(46);
    expect(p.vdot30dAgo).toBe(42);
    expect(p.vdotTrend).toBe('up');
    expect(p.personalBests).toEqual([{ label: '5公里', time: '20:30', date: '2025-11-15' }]);
    expect(p.longestKm).toBe(21.75);
    expect(p.typicalCadence).toBe(178);
    expect(p.prev?.name).toBe('上次');
  });

  test('容错: 任一查询抛错不阻塞, 降级为默认值', () => {
    (db.getStats as jest.Mock).mockImplementation(() => {
      throw new Error('boom');
    });
    (db.getVDOTHistory as jest.Mock).mockImplementation(() => {
      throw new Error('boom');
    });
    (db.getPersonalRecords as jest.Mock).mockImplementation(() => {
      throw new Error('boom');
    });
    expect(() => buildRunnerProfile(baseActivity)).not.toThrow();
    const p = buildRunnerProfile(baseActivity);
    expect(p.lifetimeKm).toBe(0);
    expect(p.vdotNow).toBeNull();
    expect(p.personalBests).toEqual([]);
  });
});

describe('formatRunnerProfile', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setDbMocks();
  });

  test('生成含关键分区的 prompt 文本', () => {
    const txt = formatRunnerProfile(buildRunnerProfile(baseActivity));
    expect(txt).toContain('【跑者画像】');
    expect(txt).toContain('生涯:');
    expect(txt).toContain('近期:');
    expect(txt).toContain('负荷:');
    expect(txt).toContain('跑力:');
    expect(txt).toContain('个人纪录:');
    expect(txt).toContain('上次跑步:');
  });

  test('无任何数据 → 空串', () => {
    const empty = buildRunnerProfile(baseActivity);
    empty.lifetimeRuns = 0;
    empty.last28Runs = 0;
    empty.tsb = null;
    empty.vdotNow = null;
    empty.personalBests = [];
    expect(formatRunnerProfile(empty)).toBe('');
  });
});

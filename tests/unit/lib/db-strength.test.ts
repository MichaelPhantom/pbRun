/**
 * 力量训练 db 层查询（`getStrengthLoads` / `getStrengthSessions`）契约测试。
 *
 * 用 better-sqlite3 mock（与 db-stats-branches.test.ts 同模式），验证：
 *  - SQL 只查 `strength_training`（不污染跑步口径）；
 *  - 按日聚合：负荷/时长/次数/组数累加；
 *  - 画像字段来自 `buildStrengthProfile`（计划名/组结构/强度域）；
 *  - 分页契约与空值兜底。
 */
const mockGet = jest.fn();
const mockAll = jest.fn();
const ACTIVITY_COLUMNS = [{ name: 'activity_type' }, { name: 'track' }, { name: 'start_lat' }, { name: 'start_lng' }, { name: 'route_cells' }, { name: 'route_km' }];
const mockPrepare = jest.fn((sql?: unknown) => {
  if (/^\s*PRAGMA\s+table_info/i.test(String(sql ?? ''))) {
    return { all: () => ACTIVITY_COLUMNS, get: () => undefined };
  }
  return { get: mockGet, all: mockAll };
});
const mockClose = jest.fn();
jest.mock('better-sqlite3', () =>
  jest.fn().mockImplementation(() => ({ prepare: mockPrepare, get: mockGet, all: mockAll, close: mockClose })),
);
jest.mock('fs', () => ({ existsSync: jest.fn(() => true) }));
jest.mock('path', () => ({ join: jest.fn((...a: string[]) => a.join('/')) }));

import { getStrengthLoads, getStrengthSessions, closeDatabase } from '@/app/lib/db';

/** 14 步循环课表: 40s 做 + 20s 歇 ×7（真实库「核心稳定性1」结构）。 */
const CORE_STEPS = JSON.stringify(
  Array.from({ length: 14 }, (_, i) => ({
    duration_type: 'time',
    duration_sec: i % 2 === 0 ? 40 : 20,
    intensity: i % 2 === 0 ? 'active' : 'rest',
  })),
);

const row = (over: Record<string, unknown> = {}) => ({
  activity_id: 1,
  date: '2026-11-02',
  name: '核心稳定性1',
  workout_name: '核心稳定性1',
  workout_steps: CORE_STEPS,
  duration: 3609,
  moving_time: 3609,
  average_heart_rate: 73,
  total_training_effect: 0.1,
  total_anaerobic_training_effect: 0,
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockGet.mockReset();
  mockAll.mockReset();
  mockGet.mockReturnValue({});
  mockAll.mockReturnValue([]);
});

afterAll(() => closeDatabase());

describe('getStrengthLoads', () => {
  test('SQL 只查 strength_training (不污染跑步口径)', () => {
    getStrengthLoads('2026-11-01', '2026-11-30');
    const sql = String(mockPrepare.mock.calls.at(-1)?.[0] ?? '');
    expect(sql).toMatch(/activity_type = 'strength_training'/);
    expect(sql).not.toMatch(/IN \('running'/);
  });

  test('按日聚合: 负荷/时长/次数/组数', () => {
    mockAll.mockReturnValueOnce([row()]);
    const [p] = getStrengthLoads('2026-11-01', '2026-11-30');
    expect(p.date).toBe('2026-11-02');
    // 3609s = 1.0025h × 100 × 0.6 (TE 0.1 → recovery) ≈ 60
    expect(p.load).toBe(60);
    expect(p.duration).toBe(3609);
    expect(p.sessions).toBe(1);
    expect(p.workingSets).toBe(7);
  });

  test('同一天多次力量课 → 累加', () => {
    mockAll.mockReturnValueOnce([row({ activity_id: 1 }), row({ activity_id: 2, duration: 1800, moving_time: 1800 })]);
    const [p] = getStrengthLoads('2026-11-01', '2026-11-30');
    expect(p.sessions).toBe(2);
    expect(p.workingSets).toBe(14);
    expect(p.duration).toBe(3609 + 1800);
    expect(p.load).toBeGreaterThan(0);
  });

  test('空结果 → []', () => {
    expect(getStrengthLoads('2026-11-01', '2026-11-30')).toEqual([]);
  });

  test('非法/逆序日期 → 抛清晰错误', () => {
    expect(() => getStrengthLoads('2026-11-01', '2026/11/30')).toThrow(/YYYY-MM-DD/);
    expect(() => getStrengthLoads('2026-11-30', '2026-11-01')).toThrow(/startDate/);
  });

  test('空值兜底不产生 NaN', () => {
    mockAll.mockReturnValueOnce([
      row({ duration: null, moving_time: null, average_heart_rate: null, total_training_effect: null, workout_steps: null }),
    ]);
    const [p] = getStrengthLoads('2026-11-01', '2026-11-30');
    expect(p.load).toBe(0);
    expect(p.duration).toBe(0);
    expect(p.workingSets).toBe(0);
    expect(Number.isFinite(p.load)).toBe(true);
  });
});

describe('getStrengthSessions', () => {
  const sessionRow = {
    activity_id: 652761578,
    name: '核心稳定性1',
    activity_type: 'strength_training',
    start_time_local: '2026-10-19T18:00:00',
    duration: 3609,
    moving_time: 3609,
    average_heart_rate: 73,
    max_heart_rate: 108,
    calories: 127,
    total_training_effect: 0.1,
    total_anaerobic_training_effect: 0,
    primary_benefit: '通用',
    recovery_time: 2089,
    workout_name: '核心稳定性1',
    workout_steps: CORE_STEPS,
  };

  test('返回结构化画像 + 基础信息 + 派生负荷', () => {
    mockGet.mockReturnValueOnce({ total: 51 });
    mockAll.mockReturnValueOnce([sessionRow]);
    const res = getStrengthSessions({ limit: 10 });
    expect(res.total).toBe(51);
    expect(res.returned).toBe(1);
    expect(res.limit).toBe(10);
    expect(res.data[0]).toMatchObject({
      activityId: 652761578,
      planName: '核心稳定性1',
      workingSets: 7,
      restSets: 7,
      structure: 'intervals',
      intensityDomain: 'recovery',
      durationSeconds: 3609,
      recoveryTimeMinutes: 2089,
    });
    expect(res.data[0].load).toBe(60);
  });

  test('默认 limit=20, 夹取上限 100', () => {
    mockGet.mockReturnValueOnce({ total: 0 });
    expect(getStrengthSessions().limit).toBe(20);
    mockGet.mockReturnValueOnce({ total: 0 });
    expect(getStrengthSessions({ limit: 999 }).limit).toBe(100);
    mockGet.mockReturnValueOnce({ total: 0 });
    expect(getStrengthSessions({ limit: 0 }).limit).toBe(1);
  });

  test('日期范围过滤时校验并传参', () => {
    mockGet.mockReturnValueOnce({ total: 2 });
    getStrengthSessions({ startDate: '2026-10-01', endDate: '2026-10-31' });
    const sql = String(mockPrepare.mock.calls.at(-1)?.[0] ?? '');
    expect(sql).toMatch(/start_time_local >= \?/);
  });

  test('非法日期 → 抛错', () => {
    expect(() => getStrengthSessions({ startDate: '2026-10-01', endDate: '2026/10/31' })).toThrow(/YYYY-MM-DD/);
  });

  test('无课表的活动 → structure=unknown, 组数 0', () => {
    mockGet.mockReturnValueOnce({ total: 1 });
    mockAll.mockReturnValueOnce([{ ...sessionRow, workout_steps: null, workout_name: null }]);
    const res = getStrengthSessions();
    expect(res.data[0].structure).toBe('unknown');
    expect(res.data[0].workingSets).toBe(0);
    expect(res.data[0].planName).toBe('核心稳定性1'); // 回落活动名
  });

  test('空结果 → data=[] 且 total=0', () => {
    mockGet.mockReturnValueOnce({ total: 0 });
    const res = getStrengthSessions();
    expect(res.data).toEqual([]);
    expect(res.total).toBe(0);
  });
});

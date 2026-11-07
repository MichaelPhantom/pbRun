/**
 * **第三十五类缺陷的行为面：一次标准半马（21.0975 km）必须能命中半马个人纪录。**
 *
 * 旧门槛 `PR_DISTANCES` 写 21100，而 `bestTimeForDistanceMeters` 的第一行是
 * `if (activityDistanceMeters < targetMeters) return null` —— 门槛**单向**。
 *
 * `activities.distance` 存公里，一次比赛距离精确的半马是 `21.0975`：
 *
 *   21.0975 * 1000 = 21097.5  <  21100   →  return null  →  页面显示 `--`
 *
 * 而首页同一时刻用 `vdot-pace.predictRaceTimes` 的 21097.5 给它预测出
 * 「半马 1:50:11」。同一个距离，一处说没有纪录、一处说能跑进 1:50。
 *
 * 真实库最大距离 21.74561 km 恰好 > 21100，缺陷被数据侥幸掩盖。这里用**夹具**
 * 把那个「真实半马」造出来 —— 它下一次就会出现在库里。
 */
const mockAll = jest.fn();
const mockGet = jest.fn();
const mockPrepare = jest.fn((sql?: unknown) => {
  if (/^\s*PRAGMA\s+table_info/i.test(String(sql ?? ''))) {
    return {
      all: () => [{ name: 'activity_type' }, { name: 'track' }],
      get: () => undefined,
    };
  }
  return { get: mockGet, all: mockAll };
});

jest.mock('better-sqlite3', () =>
  jest.fn().mockImplementation(() => ({ prepare: mockPrepare, close: jest.fn() })),
);
jest.mock('fs', () => ({ existsSync: jest.fn().mockReturnValue(true) }));
jest.mock('path', () => ({ join: jest.fn((...a: string[]) => a.join('/')) }));

import { getPersonalRecords } from '@/app/lib/db';

/** 一次「比赛距离精确」的半马：`distance` 存公里 → 21.0975。 */
const halfMarathon = {
  activity_id: 900001,
  distance: 21.0975,
  duration: 6300,
  moving_time: 6300,
  start_time: '2026-05-10T00:00:00.000Z',
};

function findRecord(label: string) {
  return getPersonalRecords('total').records.find((r) => r.distanceLabel === label);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGet.mockReturnValue({ count: 1 });
});

describe('标准半马必须能命中个人纪录', () => {
  test('distance = 21.0975 km → 半马纪录有值', () => {
    // 第一次 all() 是活动列表，之后每次是 getActivityLaps（空 → 走比例折算）
    mockAll.mockReturnValueOnce([halfMarathon]).mockReturnValue([]);
    const half = findRecord('半程马拉松最佳成绩');
    expect(half).toBeDefined();
    expect(half?.durationSeconds).not.toBeNull();
    // 比例折算：21.0975/21.0975 = 1 → 6300 s
    expect(half?.durationSeconds).toBe(6300);
  });

  test('distance = 21.09 km（差 7.5m）→ 不算半马（门槛不放宽到「约等于」）', () => {
    mockAll
      .mockReturnValueOnce([{ ...halfMarathon, distance: 21.09 }])
      .mockReturnValue([]);
    expect(findRecord('半程马拉松最佳成绩')?.durationSeconds).toBeNull();
  });

  test('distance = 42.195 km → 全马纪录有值（同一门槛纪律）', () => {
    mockAll
      .mockReturnValueOnce([{ ...halfMarathon, distance: 42.195 }])
      .mockReturnValue([]);
    expect(findRecord('全程马拉松最佳成绩')?.durationSeconds).not.toBeNull();
  });
});

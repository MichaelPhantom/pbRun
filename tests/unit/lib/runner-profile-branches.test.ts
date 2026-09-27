/**
 * @jest-environment node
 *
 * app/lib/runner-profile.ts 分支补测 (此前分支 68.0%, 57 个未覆盖分支)。
 * 复用真实的 training-load 纯函数; 只 mock db。
 *
 * 覆盖: 生涯/负荷/跑力查询抛错降级、近 7/14/28/30 天窗口边界与坏时间戳、
 * 强度分布的坏 JSON / 非数组 / 负值 / 全零 / 混杂类型、周环比 0-持平与减量、
 * 跑力趋势 up/down/flat 与缺 30 天前值、配速趋势 变快/变慢/基本持平、
 * formatRunnerProfile 各分区缺失时的省略与 PR 行。
 */
jest.unmock('better-sqlite3');

jest.mock('@/app/lib/db', () => ({
  getActivities: jest.fn(),
  getPersonalRecords: jest.fn(),
  getStats: jest.fn(),
  getTrainingLoads: jest.fn(),
  getVDOTHistory: jest.fn(),
}));

import * as db from '@/app/lib/db';
import { buildRunnerProfile, formatRunnerProfile } from '@/app/lib/runner-profile';
import type { Activity, RunnerProfile } from '@/app/lib/types';

const today = new Date();
const ymd = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const daysAgo = (n: number) => {
  const d = new Date(today);
  d.setDate(d.getDate() - n);
  return d;
};

const base = {
  activity_id: 999,
  start_time: `${ymd(today)}T10:00:00.000Z`,
  start_time_local: `${ymd(today)}T18:00:00`,
  name: '今日跑',
  distance: 10,
  average_pace: 360,
} as unknown as Activity;

const act = (id: number, agoDays: number, over: Record<string, unknown> = {}) => ({
  activity_id: id,
  start_time_local: `${ymd(daysAgo(agoDays))}T18:00:00`,
  name: `跑 ${id}`,
  distance: 8,
  average_pace: 350,
  ...over,
});

/** 默认: 全部查询成功且数据充足 */
function wire(over: Record<string, jest.Mock | unknown> = {}) {
  (db.getStats as jest.Mock).mockReturnValue({
    totalDistance: 1_000_000,
    totalActivities: 200,
    averageCadence: 178.4,
    averageHeartRate: 147.6,
  });
  (db.getActivities as jest.Mock).mockImplementation((params: { limit: number }) => {
    if (params.limit >= 200) {
      // recentVolume: 近 60 天序列 (排除本次)
      return {
        data: [
          act(1, 1), // 近 7 天
          act(2, 10), // 7–14 天 (上周)
          act(3, 20), // 14–28 天
          act(4, 40, { average_pace: 380 }), // 31–60 天 (earlierPace)
        ],
      };
    }
    if (params.limit === 1) return { data: [] };
    return { data: [] };
  });
  (db.getTrainingLoads as jest.Mock).mockReturnValue([
    { date: ymd(daysAgo(1)), distance: 8000, load: 60, duration: 2800 },
    { date: ymd(today), distance: 8000, load: 80, duration: 2800 },
  ]);
  (db.getVDOTHistory as jest.Mock).mockReturnValue([
    { period: ymd(today), vdot_value: 47 },
    { period: ymd(daysAgo(35)), vdot_value: 45 },
  ]);
  (db.getPersonalRecords as jest.Mock).mockReturnValue({ records: [], longestRunMeters: 0, longestRunDate: null });
  for (const [k, v] of Object.entries(over)) {
    if (typeof v === 'function' && /^mock/.test((v as jest.Mock).name ?? '')) continue;
    (db[k as keyof typeof db] as unknown as jest.Mock).mockReturnValue(v);
  }
}

beforeEach(() => {
  jest.clearAllMocks();
  wire();
});

describe('降级路径 (查询抛错)', () => {
  test('生涯统计抛错 → 生涯字段归零', () => {
    (db.getStats as jest.Mock).mockImplementation(() => {
      throw new Error('db down');
    });
    const p = buildRunnerProfile(base);
    expect(p.lifetimeKm).toBe(0);
    expect(p.lifetimeRuns).toBe(0);
    expect(p.typicalCadence).toBeNull();
  });

  test('负荷查询抛错 → ctl/atl/tsb 全 null', () => {
    (db.getTrainingLoads as jest.Mock).mockImplementation(() => {
      throw new Error('no table');
    });
    const p = buildRunnerProfile(base);
    expect(p.ctl).toBeNull();
    expect(p.tsb).toBeNull();
    expect(p.tsbLabel).toBeNull();
  });

  test('跑力历史抛错 → vdotNow 为 null', () => {
    (db.getVDOTHistory as jest.Mock).mockImplementation(() => {
      throw new Error('boom');
    });
    const p = buildRunnerProfile(base);
    expect(p.vdotNow).toBeNull();
  });

  test('PB 查询抛错 → 个人最好成绩为空', () => {
    (db.getPersonalRecords as jest.Mock).mockImplementation(() => {
      throw new Error('boom');
    });
    expect(buildRunnerProfile(base).personalBests).toEqual([]);
  });
});

describe('近期跑量窗口边界', () => {
  test('坏时间戳与本次活动被跳过; 近 7/14/28 天分别归集', () => {
    (db.getActivities as jest.Mock).mockImplementation((params: { limit: number }) => {
      if (params.limit >= 200) {
        return {
          data: [
            { activity_id: 999, start_time_local: `${ymd(today)}T18:00:00`, distance: 99 }, // 本次 → 排除
            { activity_id: 1, start_time_local: 'not-a-date', distance: 50 }, // 坏时间戳 → 跳过
            act(2, 3, { distance: 5 }), // 近 7 天
            act(3, 10, { distance: 7 }), // 上周 (7–14)
            act(4, 25, { distance: 11 }), // 近 28 天
            act(5, 45, { distance: 13 }), // 28–60 天
          ],
        };
      }
      return { data: [] };
    });

    const p = buildRunnerProfile(base);
    expect(p.last7Km).toBe(5);
    expect(p.last28Km).toBe(5 + 7 + 11);
    expect(p.last7Runs).toBe(1);
    expect(p.last28Runs).toBe(3);
    // 上周 (7–14 天) 只有 7km → 周环比为负 (减量)
    expect(p.weeklyVolumeChangePct).toBeLessThan(0);
  });

  test('上周与本周同量 → 周环比 0 (持平)', () => {
    (db.getActivities as jest.Mock).mockImplementation((params: { limit: number }) => {
      if (params.limit >= 200) {
        return { data: [act(1, 3, { distance: 10 }), act(2, 10, { distance: 10 })] };
      }
      return { data: [] };
    });
    expect(buildRunnerProfile(base).weeklyVolumeChangePct).toBe(0);
  });

  test('查询最近一条活动失败 → 不影响其他窗口 (limit=1 抛错)', () => {
    (db.getActivities as jest.Mock).mockImplementation((params: { limit: number }) => {
      if (params.limit === 1) throw new Error('first run lookup failed');
      if (params.limit >= 200) return { data: [act(1, 3, { distance: 6 })] };
      return { data: [] };
    });
    const p = buildRunnerProfile(base);
    expect(p.last7Km).toBe(6);
    expect(p.firstRunYear).toBe(today.getFullYear());
  });
});

describe('强度分布边界', () => {
  const withZones = (zones: unknown[]) => {
    (db.getActivities as jest.Mock).mockImplementation((params: { limit: number }) => {
      if (params.limit >= 200) return { data: [{ activity_id: 1, start_time_local: ymd(today), distance: 5, time_in_hr_zone: zones[0] }] };
      if (params.limit >= 100)
        return {
          data: [
            { activity_id: 2, start_time_local: ymd(today), time_in_hr_zone: zones[0] },
            { activity_id: 3, start_time_local: ymd(today), time_in_hr_zone: zones[1] },
          ],
        };
      return { data: [] };
    });
  };

  test('坏 JSON / 非数组 → 跳过该项', () => {
    withZones(['{oops', JSON.stringify({ a: 1 })]);
    expect(buildRunnerProfile(base).intensityDist).toEqual([]);
  });

  test('负值与非数字不计入; 全零 → 空数组', () => {
    withZones([JSON.stringify([-5, 'x', null]), JSON.stringify([0, 0])]);
    expect(buildRunnerProfile(base).intensityDist).toEqual([]);
  });

  test('混杂值: 只汇总有效数值并归一化 (百分比保留 1 位, 0% 被过滤)', () => {
    withZones([JSON.stringify([600, -1, 'x', 0, 400]), JSON.stringify([0, 1000])]);
    const dist = buildRunnerProfile(base).intensityDist;
    const total = dist.reduce((s, z) => s + z.pct, 0);
    expect(total).toBeCloseTo(100, 0);
    // 排序按区间序号, 且不含 0% 的区间
    expect(dist.map((z) => z.zone)).toEqual([...dist.map((z) => z.zone)].sort((a, b) => a - b));
    expect(dist.every((z) => z.pct > 0)).toBe(true);
  });
});

describe('跑力趋势与配速趋势', () => {
  test('vdotTrend: 上升 / 下降 / 持平 三种', () => {
    // 30 天前的判定读的是 `start_time` 字段 (不是 period)
    (db.getVDOTHistory as jest.Mock).mockReturnValue([
      { period: ymd(today), start_time: ymd(today), vdot_value: 50 },
      { period: ymd(daysAgo(35)), start_time: ymd(daysAgo(35)), vdot_value: 45 },
    ]);
    expect(buildRunnerProfile(base).vdotTrend).toBe('up');

    (db.getVDOTHistory as jest.Mock).mockReturnValue([
      { period: ymd(today), start_time: ymd(today), vdot_value: 44 },
      { period: ymd(daysAgo(35)), start_time: ymd(daysAgo(35)), vdot_value: 46 },
    ]);
    expect(buildRunnerProfile(base).vdotTrend).toBe('down');

    // 差值 <= 0.5 → 持平
    (db.getVDOTHistory as jest.Mock).mockReturnValue([
      { period: ymd(today), start_time: ymd(today), vdot_value: 45.2 },
      { period: ymd(daysAgo(35)), start_time: ymd(daysAgo(35)), vdot_value: 45 },
    ]);
    expect(buildRunnerProfile(base).vdotTrend).toBe('flat');
  });

  test('无 30 天前样本 → vdot30dAgo 为 null 且趋势为 null', () => {
    (db.getVDOTHistory as jest.Mock).mockReturnValue([
      { period: ymd(today), start_time: ymd(today), vdot_value: 45 },
    ]);
    const p = buildRunnerProfile(base);
    expect(p.vdotNow).toBe(45);
    expect(p.vdot30dAgo).toBeNull();
    expect(p.vdotTrend).toBeNull();
  });
});

describe('formatRunnerProfile 分区省略与 PR 行', () => {
  // 注意: 必须在使用时构建 —— beforeEach 里的 mock 才已就绪
  const fullProfile = () => buildRunnerProfile(base);

  test('仅有生涯数据 → 只输出生涯行', () => {
    const only: RunnerProfile = {
      ...fullProfile(),
      last7Km: 0,
      last7Runs: 0,
      last28Km: 0,
      last28Runs: 0,
      weeklyVolumeChangePct: null,
      intensityDist: [],
      ctl: null,
      atl: null,
      tsb: null,
      tsbLabel: null,
      vdotNow: null,
      personalBests: [],
      firstRunYear: null,
    };
    const text = formatRunnerProfile(only);
    expect(text).toContain('生涯:');
    expect(text).not.toContain('近期:');
    expect(text).not.toContain('周环比');
    expect(text).not.toContain('强度分布');
    expect(text).not.toContain('负荷:');
    expect(text).not.toContain('跑力:');
  });

  test('周环比 0 → 持平文案; 负荷带 tsbLabel; 跑力带 30 天前对比', () => {
    const text = formatRunnerProfile({
      ...fullProfile(),
      weeklyVolumeChangePct: 0,
      tsb: -8.4,
      tsbLabel: '平衡',
      vdotNow: 47,
      vdot30dAgo: 45,
      vdotTrend: 'up',
      recentPaceSec: 350,
      earlierPaceSec: 366,
    });
    expect(text).toMatch(/周环比: 本周较上周 持平/);
    expect(text).toMatch(/TSB -8\.4（平衡）/);
    expect(text).toMatch(/约30天前 45, 上升/);
    expect(text).toMatch(/配速趋势: .*变快 16s\/km/);
  });

  test('配速差 < 3 秒 → 基本持平', () => {
    const text = formatRunnerProfile({ ...fullProfile(), recentPaceSec: 350, earlierPaceSec: 352 });
    expect(text).toMatch(/基本持平/);
  });

  test('配速变慢 → 变慢 Ns/km', () => {
    const text = formatRunnerProfile({ ...fullProfile(), recentPaceSec: 370, earlierPaceSec: 350 });
    expect(text).toMatch(/变慢 20s\/km/);
  });

  test('个人最好成绩行会被输出 (label/time 字段)', () => {
    const text = formatRunnerProfile({
      ...fullProfile(),
      personalBests: [{ label: '5 km', time: '20:00', date: '2026-08-01' } as never],
    });
    expect(text).toMatch(/个人纪录: 5 km 20:00/);
  });

  test('全空画像 → 空串', () => {
    const empty: RunnerProfile = {
      lifetimeKm: 0,
      lifetimeRuns: 0,
      firstRunYear: null,
      typicalCadence: null,
      typicalHr: null,
      last7Km: 0,
      last7Runs: 0,
      last28Km: 0,
      last28Runs: 0,
      weeklyVolumeChangePct: null,
      intensityDist: [],
      ctl: null,
      atl: null,
      tsb: null,
      tsbLabel: null,
      vdotNow: null,
      vdot30dAgo: null,
      vdotTrend: null,
      recentPaceSec: null,
      earlierPaceSec: null,
      personalBests: [],
    } as unknown as RunnerProfile;
    expect(formatRunnerProfile(empty)).toBe('');
  });
});

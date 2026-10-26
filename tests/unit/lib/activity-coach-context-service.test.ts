/**
 * 活动 AI 可比上下文编排：DB 取数降级策略 + 分档同距离口径 + 环境可比性。
 */
jest.mock('@/app/lib/db', () => ({
  getActivityById: jest.fn(),
  getPeerActivities: jest.fn(),
  getActivityStartGeo: jest.fn(),
}));
jest.mock('@/app/lib/activity-insight-service', () => ({
  getActivityInsight: jest.fn(),
}));

import * as db from '@/app/lib/db';
import * as activityService from '@/app/lib/activity-insight-service';
import * as contextModule from '@/app/lib/activity-coach-context';
import { buildActivityContextBlock } from '@/app/lib/activity-coach-context-service';
import type { Activity, ActivityInsightResponse } from '@/app/lib/types';
import type { PeerActivity } from '@/app/lib/db';

const dbMock = db as unknown as {
  getActivityById: jest.Mock;
  getPeerActivities: jest.Mock;
  getActivityStartGeo: jest.Mock;
};
const serviceMock = activityService as unknown as { getActivityInsight: jest.Mock };

const activity = {
  activity_id: 7,
  name: '世纪公园 - 节奏跑',
  start_time: '2026-10-01T00:00:00.000Z',
  start_time_local: '2026-10-01T08:00:00',
  distance: 10,
  average_pace: 300,
  average_heart_rate: 160,
  average_temperature: 26,
  total_ascent: 120,
} as Activity;

const insightStub: ActivityInsightResponse = {
  activityId: 7,
  lapAnalysis: {
    laps: [],
    workLaps: 0,
    workDistanceMeters: 0,
    workAvgPaceSecPerKm: null,
    workAvgHeartRate: null,
    workHrDrift: null,
    bestPaceSecPerKm: null,
    bestLapIndex: null,
  },
  comparison: null,
  decouplingPct: null,
  hrZoneBreakdown: [],
};

const peer = (
  id: number,
  name: string,
  pace: number,
  startLat: number | null = 29.5,
  startLng: number | null = 106.5,
): PeerActivity => ({
  activityId: id,
  date: '2026-09-20T08:00:00',
  name,
  distanceKm: 10,
  paceSecPerKm: pace,
  heartRate: 158,
  temperatureC: 25.5,
  ascentM: 90,
  startLat,
  startLng,
});

beforeEach(() => {
  jest.clearAllMocks();
  dbMock.getActivityById.mockReturnValue(activity);
  dbMock.getActivityStartGeo.mockReturnValue(null);
  serviceMock.getActivityInsight.mockReturnValue(insightStub);
  dbMock.getPeerActivities.mockImplementation(
    (_id: number, routeKey: string | null) => {
      if (routeKey) {
        return {
          basis: 'route',
          activities: [peer(1, '世纪公园 - 轻松跑', 310)],
        };
      }
      return {
        basis: 'distance',
        activities: [peer(2, '滨江 - 节奏跑', 305)],
      };
    },
  );
});


  test('跨名称同位置对比注入（来自 getActivityInsight.locationComparison）', () => {
    serviceMock.getActivityInsight.mockReturnValueOnce({
      ...insightStub,
      locationComparison: {
        basis: 'location',
        label: 'GPS ≤1.5km',
        peers: [
          {
            activityId: 9,
            date: '2026-09-01',
            name: '其它 - 节奏跑',
            category: 'tempo',
            distanceKm: 10,
            paceSecPerKm: 298,
            heartRate: 159,
            paceDeltaSecPerKm: -2,
          },
        ],
        rank: { byPace: 2, total: 2 },
        paceDeltaSecPerKm: -2,
        hrDeltaBpm: -1,
        groupAvgPaceSecPerKm: 298,
        groupBestPaceSecPerKm: 298,
        bestActivityId: 9,
        currentCategory: 'tempo',
        sameCategory: null,
      },
    });
    const text = buildActivityContextBlock(activity);
    expect(text).toContain('同位置样本（GPS ≤1.5km）');
    expect(text).toContain('最近样本: 09-01 10.0km 4:58 159bpm 比本次快 2s/km');
  });

describe('buildActivityContextBlock', () => {
  test('同时注入同路线/同距离与环境可比样本', () => {
    const text = buildActivityContextBlock(activity);
    expect(text).toContain('【本次表现与可比样本】');
    expect(text).toContain('同路线/同名样本');
    expect(text).toContain('同距离样本');
    expect(text).toContain('环境可比（同距离样本 1 次）');
    expect(text).toContain('温度高 0.5°C');
    expect(text).toContain('爬升多 30m');
    expect(text).toContain('同温档 24–28°C');
    // 10km 同距离 ±10%；同路线放宽到 ±25%
    expect(dbMock.getPeerActivities).toHaveBeenNthCalledWith(1, 7, '世纪公园', 10, 0.1, 0.25);
    expect(dbMock.getPeerActivities).toHaveBeenNthCalledWith(2, 7, null, 10, 0.1);
  });

  test('活动为空 → 空串', () => {
    expect(buildActivityContextBlock(null)).toBe('');
    expect(serviceMock.getActivityInsight).not.toHaveBeenCalled();
  });

  test('传入预计算 insight → 跳过重复深挖查询', () => {
    const text = buildActivityContextBlock(activity, insightStub);
    expect(serviceMock.getActivityInsight).not.toHaveBeenCalled();
    expect(text).toContain('同距离样本');
  });

  test('无路线指纹（跑步机）→ 只查同距离', () => {
    const text = buildActivityContextBlock({ ...activity, name: '跑步机' });
    expect(text).toContain('同距离样本');
    expect(text).not.toContain('同路线/同名样本');
    expect(dbMock.getPeerActivities).toHaveBeenCalledTimes(1);
    expect(dbMock.getPeerActivities).toHaveBeenCalledWith(7, null, 10, 0.1);
  });

  test('距离为 0 → 不查同距离；路线查询返回 distance 基准则不当作路线', () => {
    dbMock.getPeerActivities.mockReturnValueOnce({
      basis: 'distance',
      activities: [peer(3, 'x', 300)],
    });
    const text = buildActivityContextBlock({ ...activity, distance: 0 });
    expect(dbMock.getPeerActivities).toHaveBeenCalledTimes(1);
    expect(dbMock.getPeerActivities).toHaveBeenCalledWith(7, '世纪公园', 0, 0, 0);
    expect(text).not.toContain('同路线/同名样本');
    expect(text).not.toContain('同距离样本');
  });

  test('当次深挖查询失败 → 仍保留横向对比', () => {
    serviceMock.getActivityInsight.mockImplementationOnce(() => {
      throw new Error('db down');
    });
    const text = buildActivityContextBlock(activity);
    expect(text).toContain('同路线/同名样本');
    expect(text).not.toContain('本次分段');
  });

  test('路线/距离查询失败 → 不阻塞，返回空串或剩余内容', () => {
    dbMock.getPeerActivities.mockImplementation(() => {
      throw new Error('db down');
    });
    expect(buildActivityContextBlock(activity)).toBe('');
  });

  test('格式化层异常 → 空串（不阻塞 AI 主流程）', () => {
    const spy = jest
      .spyOn(contextModule, 'formatActivityContext')
      .mockImplementationOnce(() => {
        throw new Error('format boom');
      });
    expect(buildActivityContextBlock(activity)).toBe('');
    spy.mockRestore();
  });

  test('GPS 同起点过滤：异地同名样本被剔除，标签标注同起点', () => {
    dbMock.getActivityStartGeo.mockReturnValue({ lat: 29.5, lng: 106.5 });
    dbMock.getPeerActivities.mockImplementation((_id: number, routeKey: string | null) => {
      if (routeKey) {
        return {
          basis: 'route',
          activities: [
            peer(1, '世纪公园 - 轻松跑', 310, 29.501, 106.501),
            peer(2, '世纪公园 - 长距离', 320, 30.5, 107.5), // 约 120km 外
          ],
        };
      }
      return { basis: 'distance', activities: [peer(3, '滨江 - 节奏跑', 305)] };
    });
    const text = buildActivityContextBlock(activity);
    expect(text).toContain('同路线/同名样本（世纪公园 · 同起点）');
    expect(text).toContain('样本 2 次（含本次）'); // 1 个同起点 + 本次
    expect(text).not.toContain('120km 外');
  });

  test('GPS 过滤后同路线为空 → 不生成同路线段，同距离仍保留', () => {
    dbMock.getActivityStartGeo.mockReturnValue({ lat: 29.5, lng: 106.5 });
    dbMock.getPeerActivities.mockImplementation((_id: number, routeKey: string | null) => {
      if (routeKey) {
        return {
          basis: 'route',
          activities: [peer(1, '世纪公园 - 轻松跑', 310, 30.5, 107.5)],
        };
      }
      return { basis: 'distance', activities: [peer(3, '滨江 - 节奏跑', 305)] };
    });
    const text = buildActivityContextBlock(activity);
    expect(text).not.toContain('同路线/同名样本');
    expect(text).toContain('同距离样本');
  });

  test('GPS 查询失败 → 降级为不校验，保留全部同名样本', () => {
    dbMock.getActivityStartGeo.mockImplementation(() => {
      throw new Error('no track');
    });
    const text = buildActivityContextBlock(activity);
    expect(text).toContain('同路线/同名样本（世纪公园）');
  });
});

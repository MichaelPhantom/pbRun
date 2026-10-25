/**
 * 活动 AI 可比上下文编排：DB 取数降级策略 + 分档同距离口径 + 环境可比性。
 */
jest.mock('@/app/lib/db', () => ({
  getActivityById: jest.fn(),
  getPeerActivities: jest.fn(),
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

const peer = (id: number, name: string, pace: number): PeerActivity => ({
  activityId: id,
  date: '2026-09-20T08:00:00',
  name,
  distanceKm: 10,
  paceSecPerKm: pace,
  heartRate: 158,
  temperatureC: 25.5,
  ascentM: 90,
});

beforeEach(() => {
  jest.clearAllMocks();
  dbMock.getActivityById.mockReturnValue(activity);
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
});

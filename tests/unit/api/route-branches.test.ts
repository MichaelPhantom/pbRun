/**
 * @jest-environment node
 *
 * 剩余 API 路由的分支补齐 (此前 75%–88%): 参数校验 400、DB 异常 500、
 * 返回体形状分支 (数组 vs 分页对象)、NO_STORE 头。
 *
 * 覆盖: /api/analysis/hr-zones、/api/analysis/pace-zones、/api/activities/months、
 *       /api/stats、/api/vdot、/api/activities、/api/activities/[id]/records
 */
import { NextRequest } from 'next/server';

const mockDb = {
  getHrZoneStats: jest.fn(),
  getPaceZoneStats: jest.fn(),
  getMonthSummaries: jest.fn(),
  getStats: jest.fn(),
  getVDOTHistory: jest.fn(),
  getActivities: jest.fn(),
  getActivityRecords: jest.fn(),
  getActivityById: jest.fn(),
};
jest.mock('@/app/lib/db', () => mockDb);

import { GET as hrZonesGET } from '@/app/api/analysis/hr-zones/route';
import { GET as paceZonesGET } from '@/app/api/analysis/pace-zones/route';
import { GET as monthsGET } from '@/app/api/activities/months/route';
import { GET as statsGET } from '@/app/api/stats/route';
import { GET as vdotGET } from '@/app/api/vdot/route';
import { GET as activitiesGET } from '@/app/api/activities/route';
import { GET as recordsGET } from '@/app/api/activities/[id]/records/route';

const req = (url: string) => new NextRequest(`http://localhost${url}`);
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

let errorSpy: jest.SpyInstance;
beforeEach(() => {
  jest.clearAllMocks();
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => errorSpy.mockRestore());

describe('/api/analysis/hr-zones', () => {
  beforeEach(() => {
    mockDb.getHrZoneStats.mockReturnValue([
      { period: '2026-W38', hr_zone: 2, activity_count: 2 },
      { period: '2026-W37', hr_zone: 4, activity_count: 1 },
    ]);
  });

  test('默认 month 聚合 + summary 去重周期 + zoneRanges', async () => {
    const res = await hrZonesGET(req('/api/analysis/hr-zones'));
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    const body = await res.json();
    expect(mockDb.getHrZoneStats).toHaveBeenCalledWith({
      startDate: undefined,
      endDate: undefined,
      groupBy: 'month',
    });
    expect(body.groupBy).toBe('month');
    expect(body.summary.total_activities).toBe(3);
    expect(body.summary.total_periods).toBe(2);
    expect(body.summary.date_range).toEqual({ start: 'all', end: 'all' });
    expect(body.zoneRanges).toBeTruthy();
  });

  test('groupBy/日期非法 → 400', async () => {
    expect((await hrZonesGET(req('/api/analysis/hr-zones?groupBy=day'))).status).toBe(400);
    expect(
      (await hrZonesGET(req('/api/analysis/hr-zones?startDate=2024-02-30'))).status,
    ).toBe(400);
    expect((await hrZonesGET(req('/api/analysis/hr-zones?endDate=oops'))).status).toBe(400);
    expect(
      (
        await hrZonesGET(
          req('/api/analysis/hr-zones?startDate=2026-09-30&endDate=2026-09-01'),
        )
      ).status,
    ).toBe(400);
    expect(mockDb.getHrZoneStats).not.toHaveBeenCalled();
  });

  test('合法区间透传 + 数据含 startDate 时回填 date_range', async () => {
    const res = await hrZonesGET(
      req('/api/analysis/hr-zones?groupBy=week&startDate=2026-09-01&endDate=2026-09-30'),
    );
    const body = await res.json();
    expect(mockDb.getHrZoneStats).toHaveBeenCalledWith({
      startDate: '2026-09-01',
      endDate: '2026-09-30',
      groupBy: 'week',
    });
    expect(body.summary.date_range).toEqual({ start: '2026-09-01', end: '2026-09-30' });
  });

  test('DB 异常 → 500 + no-store', async () => {
    mockDb.getHrZoneStats.mockImplementation(() => {
      throw new Error('db down');
    });
    const res = await hrZonesGET(req('/api/analysis/hr-zones'));
    expect(res.status).toBe(500);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(errorSpy).toHaveBeenCalled();
  });
});

describe('/api/analysis/pace-zones', () => {
  beforeEach(() => {
    mockDb.getPaceZoneStats.mockReturnValue([{ zone: 1, activity_count: 3 }]);
  });

  test('必填与范围校验', async () => {
    expect((await paceZonesGET(req('/api/analysis/pace-zones'))).status).toBe(400);
    expect(
      (await paceZonesGET(req('/api/analysis/pace-zones?startDate=2026-09-01'))).status,
    ).toBe(400);
    expect(
      (
        await paceZonesGET(
          req('/api/analysis/pace-zones?startDate=2026-09-30&endDate=2026-09-01&vdot=40'),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await paceZonesGET(
          req('/api/analysis/pace-zones?startDate=2026-09-01&endDate=2026-09-30&vdot=Infinity'),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await paceZonesGET(
          req('/api/analysis/pace-zones?startDate=2026-09-01&endDate=2026-09-30&vdot=200'),
        )
      ).status,
    ).toBe(400);
    expect(mockDb.getPaceZoneStats).not.toHaveBeenCalled();
  });

  test('合法参数 → 计算并返回 data + no-store', async () => {
    const res = await paceZonesGET(
      req('/api/analysis/pace-zones?startDate=2026-09-01&endDate=2026-09-30&vdot=46.7'),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(mockDb.getPaceZoneStats).toHaveBeenCalledWith(46.7, '2026-09-01', '2026-09-30');
    expect((await res.json()).data).toHaveLength(1);
  });

  test('DB 异常 → 500', async () => {
    mockDb.getPaceZoneStats.mockImplementation(() => {
      throw new Error('boom');
    });
    const res = await paceZonesGET(
      req('/api/analysis/pace-zones?startDate=2026-09-01&endDate=2026-09-30&vdot=40'),
    );
    expect(res.status).toBe(500);
  });
});

describe('/api/activities/months', () => {
  test('不传 limit/offset → 返回全部 (数组 → {data})', async () => {
    mockDb.getMonthSummaries.mockReturnValue([{ monthKey: '2026-09', count: 3 }]);
    const res = await monthsGET(req('/api/activities/months'));
    expect(mockDb.getMonthSummaries).toHaveBeenCalledWith(undefined, undefined);
    expect((await res.json()).data).toHaveLength(1);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  test('传 limit/offset → 透传整数; 分页对象 → 带 total', async () => {
    mockDb.getMonthSummaries.mockReturnValue({ data: [{ monthKey: '2026-09' }], total: 14 });
    const body = await (await monthsGET(req('/api/activities/months?limit=6&offset=12'))).json();
    expect(mockDb.getMonthSummaries).toHaveBeenCalledWith(6, 12);
    expect(body.total).toBe(14);
  });

  test('越界/非法参数 → 400', async () => {
    expect((await monthsGET(req('/api/activities/months?limit=0'))).status).toBe(400);
    expect((await monthsGET(req('/api/activities/months?limit=101'))).status).toBe(400);
    expect((await monthsGET(req('/api/activities/months?offset=-1'))).status).toBe(400);
    expect((await monthsGET(req('/api/activities/months?limit=abc'))).status).toBe(400);
  });

  test('DB 异常 → 500', async () => {
    mockDb.getMonthSummaries.mockImplementation(() => {
      throw new Error('x');
    });
    expect((await monthsGET(req('/api/activities/months'))).status).toBe(500);
  });
});

describe('/api/stats', () => {
  test('缺省 period → undefined 透传; 非法 → 400; 异常 → 500', async () => {
    mockDb.getStats.mockReturnValue({ totalActivities: 1 });
    await statsGET(req('/api/stats'));
    expect(mockDb.getStats).toHaveBeenCalledWith(undefined);

    await statsGET(req('/api/stats?period=month'));
    expect(mockDb.getStats).toHaveBeenLastCalledWith('month');

    expect((await statsGET(req('/api/stats?period=quarter'))).status).toBe(400);

    mockDb.getStats.mockImplementation(() => {
      throw new Error('x');
    });
    expect((await statsGET(req('/api/stats'))).status).toBe(500);
  });
});

describe('/api/vdot', () => {
  test('默认 limit=50 + count; 非法 limit → 400; 异常 → 500', async () => {
    mockDb.getVDOTHistory.mockReturnValue([{ vdot_value: 42 }, { vdot_value: 43 }]);
    const res = await vdotGET(req('/api/vdot'));
    expect(mockDb.getVDOTHistory).toHaveBeenCalledWith(50);
    expect(await res.json()).toMatchObject({ count: 2 });

    await vdotGET(req('/api/vdot?limit=5'));
    expect(mockDb.getVDOTHistory).toHaveBeenLastCalledWith(5);

    expect((await vdotGET(req('/api/vdot?limit=0'))).status).toBe(400);
    expect((await vdotGET(req('/api/vdot?limit=501'))).status).toBe(400);

    mockDb.getVDOTHistory.mockImplementation(() => {
      throw new Error('x');
    });
    expect((await vdotGET(req('/api/vdot'))).status).toBe(500);
  });
});

describe('/api/activities', () => {
  test('缺省分页 + 过滤参数透传', async () => {
    mockDb.getActivities.mockReturnValue({ data: [], total: 0 });
    await activitiesGET(
      req('/api/activities?type=跑步&startDate=2026-09-01&endDate=2026-09-30'),
    );
    expect(mockDb.getActivities).toHaveBeenCalledWith({
      page: 1,
      limit: 20,
      type: '跑步',
      startDate: '2026-09-01',
      endDate: '2026-09-30',
    });
  });

  test('参数校验 400 各分支', async () => {
    expect((await activitiesGET(req('/api/activities?page=0'))).status).toBe(400);
    expect((await activitiesGET(req('/api/activities?limit=1000'))).status).toBe(400);
    expect((await activitiesGET(req('/api/activities?startDate=2024-13-01'))).status).toBe(400);
    expect((await activitiesGET(req('/api/activities?endDate=nope'))).status).toBe(400);
    expect(
      (
        await activitiesGET(
          req('/api/activities?startDate=2026-09-30&endDate=2026-09-01'),
        )
      ).status,
    ).toBe(400);
    expect(mockDb.getActivities).not.toHaveBeenCalled();
  });

  test('DB 异常 → 500', async () => {
    mockDb.getActivities.mockImplementation(() => {
      throw new Error('x');
    });
    expect((await activitiesGET(req('/api/activities'))).status).toBe(500);
  });
});

describe('/api/activities/[id]/records', () => {
  test('非法 id → 400; 活动不存在 → 404; 正常 → records', async () => {
    expect((await recordsGET(req('/api/activities/abc/records'), ctx('abc'))).status).toBe(400);

    mockDb.getActivityById.mockReturnValueOnce(null);
    const notFoundRes = await recordsGET(req('/api/activities/999/records'), ctx('999'));
    expect(notFoundRes.status).toBe(404);
    expect(notFoundRes.headers.get('Cache-Control')).toBe('no-store');

    mockDb.getActivityById.mockReturnValueOnce({ activity_id: 1 });
    mockDb.getActivityRecords.mockReturnValueOnce([{ record_index: 0 }]);
    const ok = await recordsGET(req('/api/activities/1/records'), ctx('1'));
    const body = await ok.json();
    expect(body).toEqual({ activity_id: 1, records: [{ record_index: 0 }] });
  });

  test('无记录 → 200 空数组 (不伪装成错误)', async () => {
    mockDb.getActivityById.mockReturnValueOnce({ activity_id: 2 });
    mockDb.getActivityRecords.mockReturnValueOnce([]);
    const res = await recordsGET(req('/api/activities/2/records'), ctx('2'));
    expect(res.status).toBe(200);
    expect((await res.json()).records).toEqual([]);
  });

  test('DB 异常 → 500 (不再吞成空数组)', async () => {
    mockDb.getActivityById.mockReturnValueOnce({ activity_id: 3 });
    mockDb.getActivityRecords.mockImplementationOnce(() => {
      throw new Error('db down');
    });
    const res = await recordsGET(req('/api/activities/3/records'), ctx('3'));
    expect(res.status).toBe(500);
  });
});

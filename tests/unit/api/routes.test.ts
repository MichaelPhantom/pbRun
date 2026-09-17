/**
 * @jest-environment node
 *
 * API 路由参数校验 + 错误码回归测试。
 * 此前 12 个路由 0 覆盖; 本套件锁定:
 *  - 数字参数非法 → 400 (此前 NaN 绕过校验流入 SQLite → 500)
 *  - Infinity vdot → 400 (此前返回垃圾数据 200)
 *  - records 路由不再吞掉 DB 错误 (此前 200 [])
 *  - 一致的 no-store 缓存头
 *  - 不可能日历日 → 400
 */
import { NextRequest } from 'next/server';

jest.mock('@/app/lib/db', () => ({
  getActivities: jest.fn(() => ({ data: [], pagination: { page: 1, limit: 20, total: 0 } })),
  getActivityById: jest.fn(() => ({ activity_id: 1, name: 'x' })),
  getActivityLaps: jest.fn(() => []),
  getActivityRecords: jest.fn(() => []),
  getMonthSummaries: jest.fn(() => []),
  getVDOTHistory: jest.fn(() => []),
  getVDOTTrend: jest.fn(() => []),
  getHrZoneStats: jest.fn(() => []),
  getPaceZoneStats: jest.fn(() => []),
  getStats: jest.fn(() => ({ totalActivities: 0 })),
  getPersonalRecords: jest.fn(() => ({ records: [] })),
}));

import * as db from '@/app/lib/db';
import { GET as activitiesGET } from '@/app/api/activities/route';
import { GET as vdotGET } from '@/app/api/vdot/route';
import { GET as monthsGET } from '@/app/api/activities/months/route';
import { GET as activityGET } from '@/app/api/activities/[id]/route';
import { GET as recordsGET } from '@/app/api/activities/[id]/records/route';
import { GET as paceZonesGET } from '@/app/api/analysis/pace-zones/route';
import { GET as hrZonesGET } from '@/app/api/analysis/hr-zones/route';
import { GET as statsGET } from '@/app/api/stats/route';

function req(url: string): NextRequest {
  return new NextRequest(`http://localhost${url}`);
}
function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

describe('/api/activities', () => {
  test('合法默认参数 → 200 + no-store', async () => {
    const res = await activitiesGET(req('/api/activities'));
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  test('回归: page=abc → 400 而非 500', async () => {
    const res = await activitiesGET(req('/api/activities?page=abc'));
    expect(res.status).toBe(400);
  });

  test('回归: limit=abc → 400 而非 500', async () => {
    const res = await activitiesGET(req('/api/activities?limit=abc'));
    expect(res.status).toBe(400);
  });

  test('limit=0x10 (十六进制) → 400', async () => {
    expect((await activitiesGET(req('/api/activities?limit=0x10'))).status).toBe(400);
  });

  test('limit 超上限 501 → 400', async () => {
    expect((await activitiesGET(req('/api/activities?limit=501'))).status).toBe(400);
  });

  test('startDate 晚于 endDate → 400', async () => {
    const res = await activitiesGET(
      req('/api/activities?startDate=2026-09-10&endDate=2026-09-01'),
    );
    expect(res.status).toBe(400);
  });

  test('不可能日期 2024-02-30 → 400', async () => {
    expect((await activitiesGET(req('/api/activities?startDate=2024-02-30'))).status).toBe(400);
  });
});

describe('/api/vdot', () => {
  test('回归: limit=abc → 400 而非 500', async () => {
    expect((await vdotGET(req('/api/vdot?limit=abc'))).status).toBe(400);
  });
  test('合法 → 200 + no-store', async () => {
    const res = await vdotGET(req('/api/vdot?limit=10'));
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });
});

describe('/api/activities/months', () => {
  test('合法分页 → 200', async () => {
    expect((await monthsGET(req('/api/activities/months?limit=6&offset=0'))).status).toBe(200);
  });
  test('limit 非数字 → 400', async () => {
    expect((await monthsGET(req('/api/activities/months?limit=abc'))).status).toBe(400);
  });
});

describe('/api/activities/:id', () => {
  test('回归: 0x10 → 400 (此前命中 id=16)', async () => {
    expect((await activityGET(req('/api/activities/0x10'), ctx('0x10'))).status).toBe(400);
  });
  test('回归: 5abc → 400 (此前命中 id=5)', async () => {
    expect((await activityGET(req('/api/activities/5abc'), ctx('5abc'))).status).toBe(400);
  });
  test('合法 id 存在 → 200', async () => {
    expect((await activityGET(req('/api/activities/1'), ctx('1'))).status).toBe(200);
  });
  test('不存在 → 404', async () => {
    (db.getActivityById as jest.Mock).mockReturnValueOnce(null);
    expect((await activityGET(req('/api/activities/999'), ctx('999'))).status).toBe(404);
  });
});

describe('/api/activities/:id/records', () => {
  test('回归: DB 读取失败不再伪装成 200 [], 而是 500', async () => {
    (db.getActivityRecords as jest.Mock).mockImplementationOnce(() => {
      throw new Error('db down');
    });
    const res = await recordsGET(req('/api/activities/1/records'), ctx('1'));
    expect(res.status).toBe(500);
  });
  test('无记录 → 200 []', async () => {
    const res = await recordsGET(req('/api/activities/1/records'), ctx('1'));
    expect(res.status).toBe(200);
    expect((await res.json()).records).toEqual([]);
  });
});

describe('/api/analysis/pace-zones', () => {
  const base = '/api/analysis/pace-zones?startDate=2026-01-01&endDate=2026-12-31';

  test('回归: vdot=Infinity → 400 而非垃圾数据 200', async () => {
    expect((await paceZonesGET(req(`${base}&vdot=Infinity`))).status).toBe(400);
  });
  test('vdot=NaN → 400', async () => {
    expect((await paceZonesGET(req(`${base}&vdot=NaN`))).status).toBe(400);
  });
  test('vdot 缺失 → 400', async () => {
    expect((await paceZonesGET(req(base))).status).toBe(400);
  });
  test('合法 → 200 + no-store', async () => {
    const res = await paceZonesGET(req(`${base}&vdot=45`));
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });
});

describe('/api/analysis/hr-zones', () => {
  test('回归: 不可能日期 2024-02-30 → 400 (此前正则放过)', async () => {
    expect((await hrZonesGET(req('/api/analysis/hr-zones?startDate=2024-02-30'))).status).toBe(400);
  });
  test('合法 → 200 + no-store', async () => {
    const res = await hrZonesGET(req('/api/analysis/hr-zones'));
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });
});

describe('/api/stats', () => {
  test('非法 period → 400', async () => {
    expect((await statsGET(req('/api/stats?period=bogus'))).status).toBe(400);
  });
  test('合法 → 200 + no-store', async () => {
    const res = await statsGET(req('/api/stats?period=month'));
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });
});

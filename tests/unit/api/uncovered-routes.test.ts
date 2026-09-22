/**
 * @jest-environment node
 *
 * 补齐此前 0 覆盖的 API 路由: laps / vdot-trend / health / llm-models。
 */
import { NextRequest } from 'next/server';

jest.mock('@/app/lib/db', () => ({
  getActivityById: jest.fn(() => ({ activity_id: 1, name: 'x' })),
  getActivityLaps: jest.fn(() => [{ id: 1, activity_id: 1, lap_index: 0, distance: 1000 }]),
  getVDOTTrend: jest.fn(() => [
    { period: '2026-09', period_type: 'month', avg_vdot: 45, max_vdot: 48, min_vdot: 42, activity_count: 5, total_distance: 50000, total_duration: 18000 },
  ]),
  getVDOTHistoryTotal: jest.fn(() => 42),
}));

jest.mock('@/app/lib/llm', () => {
  const actual = jest.requireActual('@/app/lib/llm');
  return {
    ...actual,
    getFreellmConfig: jest.fn(() => ({ baseUrl: 'http://127.0.0.1:3001/v1', key: 'k' })),
    fetchModels: jest.fn(async () => [{ id: 'auto', name: 'auto', available: true, thinking: false, recommended: true }]),
  };
});

import * as llm from '@/app/lib/llm';
import { GET as lapsGET } from '@/app/api/activities/[id]/laps/route';
import { GET as vdotTrendGET } from '@/app/api/analysis/vdot-trend/route';
import { GET as healthGET } from '@/app/api/health/route';
import { GET as modelsGET } from '@/app/api/llm/models/route';

function req(url: string): NextRequest {
  return new NextRequest(`http://localhost${url}`);
}
function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

describe('/api/activities/[id]/laps', () => {
  test('合法 id → 200 + laps + no-store', async () => {
    const res = await lapsGET(req('/api/activities/1/laps'), ctx('1'));
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    const body = await res.json();
    expect(body.activity_id).toBe(1);
    expect(Array.isArray(body.laps)).toBe(true);
  });

  test('非法 id → 400', async () => {
    const res = await lapsGET(req('/api/activities/abc/laps'), ctx('abc'));
    expect(res.status).toBe(400);
  });

  test('活动不存在 → 404', async () => {
    const db = jest.requireMock('@/app/lib/db');
    (db.getActivityById as jest.Mock).mockReturnValueOnce(null);
    const res = await lapsGET(req('/api/activities/999/laps'), ctx('999'));
    expect(res.status).toBe(404);
  });
});

describe('/api/analysis/vdot-trend', () => {
  test('默认参数 → 200 + data', async () => {
    const res = await vdotTrendGET(req('/api/analysis/vdot-trend'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.count).toBe(1);
    expect(body.groupBy).toBe('month');
  });

  test('非法 groupBy → 400', async () => {
    const res = await vdotTrendGET(req('/api/analysis/vdot-trend?groupBy=day'));
    expect(res.status).toBe(400);
  });

  test('非法日期 → 400', async () => {
    const res = await vdotTrendGET(req('/api/analysis/vdot-trend?startDate=2026-13-40'));
    expect(res.status).toBe(400);
  });

  test('startDate > endDate → 400', async () => {
    const res = await vdotTrendGET(req('/api/analysis/vdot-trend?startDate=2026-09-01&endDate=2026-06-01'));
    expect(res.status).toBe(400);
  });
});

describe('/api/health', () => {
  test('浅探活 → 200 ok', async () => {
    const res = await healthGET(req('/api/health'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
    expect(body.service).toBe('pbRun');
  });

  test('深探活 → 200 + db reachable', async () => {
    const res = await healthGET(req('/api/health?deep=1'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.db).toBe('reachable');
    expect(body.vdot_rows).toBe(42);
  });

  test('深探活 DB 异常 → 503 degraded', async () => {
    const db = jest.requireMock('@/app/lib/db');
    (db.getVDOTHistoryTotal as jest.Mock).mockImplementationOnce(() => {
      throw new Error('db down');
    });
    const res = await healthGET(req('/api/health?deep=1'));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.status).toBe('degraded');
  });
});

describe('/api/llm/models', () => {
  beforeEach(() => jest.clearAllMocks());

  test('已配置 → 200 + models + configured + no-store', async () => {
    const res = await modelsGET();
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    const body = await res.json();
    expect(body.configured).toBe(true);
    expect(body.models.length).toBe(1);
  });

  test('fetchModels 抛错 → 500 + error 契约', async () => {
    (llm.fetchModels as jest.Mock).mockRejectedValueOnce(new Error('boom'));
    const res = await modelsGET();
    expect(res.status).toBe(500);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    const body = await res.json();
    expect(body.error).toBe('Internal server error');
  });

  test('未配置凭证 → configured=false', async () => {
    (llm.getFreellmConfig as jest.Mock).mockReturnValueOnce(null);
    (llm.fetchModels as jest.Mock).mockResolvedValueOnce([]);
    const res = await modelsGET();
    const body = await res.json();
    expect(body.configured).toBe(false);
  });
});

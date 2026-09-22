/**
 * @jest-environment node
 *
 * /api/insight 路由参数校验与错误码回归测试。
 */
import { NextRequest } from 'next/server';

const fakeResponse = {
  range: { startDate: '2026-06-01', endDate: '2026-09-22' },
  activityCount: 42,
  vdot: { raw: [], perMonth: [], slopePer30d: 0, intercept: 0, latest: null, mean: null, plateau: false },
  load: { weekly: [], acute: 0, chronic: 0, acwr: 0, acwrTone: 'under', zDistribution: [], lowIntensityPct: 0, highIntensityPct: 0 },
  decoupling: { points: [], meanPct: null, trendPer30d: null, sampleCount: 0 },
  form: { monthly: [] },
  paceHr: { n: 0, slope: 0, intercept: 0, r: 0, predictions: [], thresholdPaceSecPerKm: null, thresholdHr: null },
  findings: [],
};

jest.mock('@/app/lib/insight-service', () => ({
  getInsight: jest.fn(() => fakeResponse),
}));

import * as service from '@/app/lib/insight-service';
import { GET } from '@/app/api/insight/route';

function req(url: string): NextRequest {
  return new NextRequest(`http://localhost${url}`);
}

describe('/api/insight', () => {
  beforeEach(() => jest.clearAllMocks());

  test('合法默认参数 → 200 + no-store + data', async () => {
    const res = await GET(req('/api/insight'));
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    const body = await res.json();
    expect(body.data).toEqual(fakeResponse);
    expect(service.getInsight).toHaveBeenCalled();
  });

  test('days=30 → 调用 service 且区间约 30 天', async () => {
    const res = await GET(req('/api/insight?days=30'));
    expect(res.status).toBe(200);
    const call = (service.getInsight as jest.Mock).mock.calls[0][0];
    expect(call.startDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(call.endDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test('显式 startDate/endDate 优先', async () => {
    const res = await GET(req('/api/insight?startDate=2026-06-01&endDate=2026-09-01'));
    expect(res.status).toBe(200);
    expect(service.getInsight).toHaveBeenCalledWith({ startDate: '2026-06-01', endDate: '2026-09-01' });
  });

  test('非法日期 → 400', async () => {
    const res = await GET(req('/api/insight?startDate=2026-13-40&endDate=2026-09-01'));
    expect(res.status).toBe(400);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  test('startDate > endDate → 400', async () => {
    const res = await GET(req('/api/insight?startDate=2026-09-01&endDate=2026-06-01'));
    expect(res.status).toBe(400);
  });

  test('service 抛错 → 500', async () => {
    (service.getInsight as jest.Mock).mockImplementationOnce(() => {
      throw new Error('boom');
    });
    const res = await GET(req('/api/insight'));
    expect(res.status).toBe(500);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });
});

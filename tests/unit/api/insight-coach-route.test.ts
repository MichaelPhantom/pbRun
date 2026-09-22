/**
 * @jest-environment node
 *
 * /api/insight/coach 与 /api/activities/[id]/insight 路由测试。
 */
import { NextRequest } from 'next/server';

jest.mock('@/app/lib/insight-service', () => ({
  getInsight: jest.fn(() => ({
    range: { startDate: '2026-06-01', endDate: '2026-09-22' },
    activityCount: 10,
    vdot: { raw: [], perMonth: [], slopePer30d: 0.1, intercept: 0, latest: 40, mean: 39, plateau: false },
    load: { weekly: [], acute: 100, chronic: 100, acwr: 1, acwrTone: 'optimal', zDistribution: [], lowIntensityPct: 20, highIntensityPct: 30 },
    decoupling: { points: [], meanPct: 7, trendPer30d: null, sampleCount: 2 },
    form: { monthly: [] },
    paceHr: { n: 10, slope: -14, intercept: 240, r: -0.7, predictions: [], thresholdPaceSecPerKm: 300, thresholdHr: 178 },
    findings: [],
  })),
  getActivityInsight: jest.fn(),
}));

jest.mock('@/app/lib/activity-insight-service', () => ({
  getActivityInsight: jest.fn(() => null),
}));

jest.mock('@/app/lib/runner-profile', () => ({
  buildRunnerProfile: jest.fn(() => ({})),
  formatRunnerProfile: jest.fn(() => '【跑者画像】测试'),
}));

jest.mock('@/app/lib/llm', () => {
  const actual = jest.requireActual('@/app/lib/llm');
  return {
    ...actual,
    getFreellmConfig: jest.fn(() => ({ baseUrl: 'http://127.0.0.1:3001/v1', key: 'test' })),
  };
});

jest.mock('@/app/lib/db', () => ({
  getActivities: jest.fn(() => ({ data: [{ activity_id: 1, name: 'x' }], pagination: { page: 1, limit: 1, total: 1 } })),
}));

import * as activityService from '@/app/lib/activity-insight-service';
import { POST as coachPOST } from '@/app/api/insight/coach/route';
import { GET as activityInsightGET } from '@/app/api/activities/[id]/insight/route';

// 全局 fetch mock
const realFetch = global.fetch;
beforeEach(() => {
  global.fetch = jest.fn(async () =>
    new Response('data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n', {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    }),
  ) as unknown as typeof fetch;
});
afterAll(() => {
  global.fetch = realFetch;
});

function postReq(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/insight/coach', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}
function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

describe('/api/insight/coach', () => {
  test('合法请求 → SSE 响应', async () => {
    const res = await coachPOST(postReq({ model: 'auto', days: 90 }));
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/event-stream');
  });

  test('追问请求 → SSE 响应', async () => {
    const res = await coachPOST(postReq({ model: 'auto', days: 90, question: '我的短板？', history: [] }));
    expect(res.status).toBe(200);
  });

  test('无 body → 仍可工作 (默认参数)', async () => {
    const req = new NextRequest('http://localhost/api/insight/coach', { method: 'POST' });
    const res = await coachPOST(req);
    expect(res.status).toBe(200);
  });
});

describe('/api/activities/[id]/insight', () => {
  test('非法 id → 400', async () => {
    const res = await activityInsightGET(new NextRequest('http://localhost/api/activities/abc/insight'), ctx('abc'));
    expect(res.status).toBe(400);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  test('活动不存在 → 404', async () => {
    (activityService.getActivityInsight as jest.Mock).mockReturnValueOnce(null);
    const res = await activityInsightGET(new NextRequest('http://localhost/api/activities/999/insight'), ctx('999'));
    expect(res.status).toBe(404);
  });

  test('存在 → 200 + data + no-store', async () => {
    (activityService.getActivityInsight as jest.Mock).mockReturnValueOnce({ activityId: 99, lapAnalysis: {}, comparison: null, decouplingPct: 5, hrZoneBreakdown: [] });
    const res = await activityInsightGET(new NextRequest('http://localhost/api/activities/99/insight'), ctx('99'));
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    const body = await res.json();
    expect(body.data.activityId).toBe(99);
  });
});

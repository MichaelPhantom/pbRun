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
  getPeriodStats: jest.fn((startDate: string, endDate: string) => ({
    startDate,
    endDate,
    totalActivities: 10,
    totalDistance: 100000,
    totalDuration: 36000,
    avgPace: 360,
    avgVDOT: 40,
    totalTrainingLoad: 600,
  })),
  // surface=analysis 分支需要 (此前 mock 缺这三个, 分支永远走 catch, 覆盖率 75.7%)
  getStats: jest.fn(() => ({ averageVDOT: 42 })),
  getPaceZoneStats: jest.fn(() => [
    { zone: 2, target_pace_sec_per_km: 330, pace_min_sec_per_km: 320, pace_max_sec_per_km: 345, activity_count: 2, total_duration: 1800, total_distance: 5400, avg_pace: 333, avg_cadence: 178, avg_stride_length: 1.05, avg_heart_rate: 148 },
    { zone: 4, target_pace_sec_per_km: 280, pace_min_sec_per_km: 270, pace_max_sec_per_km: 290, activity_count: 1, total_duration: 900, total_distance: 3300, avg_pace: 273, avg_cadence: 184, avg_stride_length: 1.12, avg_heart_rate: 168 },
  ]),
  getPowerZoneStats: jest.fn(() => ({
    zones: [
      { zone: 1, zone_name: 'Z1(恢复)', activity_count: 1, lap_count: 2, total_duration: 600, total_distance: 1200, avg_power: 150, avg_heart_rate: 128, avg_cadence: 170, avg_stride_length: 0.95 },
      { zone: 4, zone_name: 'Z4(阈值)', activity_count: 1, lap_count: 1, total_duration: 600, total_distance: 2400, avg_power: 300, avg_heart_rate: 170, avg_cadence: 182, avg_stride_length: 1.15 },
    ],
    reference: { ftp_median_watts: 290, distinct_ftp_count: 1, laps_without_ftp: 0 },
  })),
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

  test('days=0 (全部历史) → 跳过环比且正常出流', async () => {
    const res = await coachPOST(postReq({ days: 0 }));
    expect(res.status).toBe(200);
  });

  /**
   * `surface` 决定用哪套**统计类**提示词 —— 不同界面职责不同，不能共用。
   * 这里断言的是真正发给模型的 system 内容（从 fetch 的 request body 里读），
   * 不是「参数被传进去了」。
   */
  async function sentSystem(body: unknown): Promise<string> {
    (global.fetch as jest.Mock).mockClear();
    await coachPOST(postReq(body));
    const init = (global.fetch as jest.Mock).mock.calls[0][1] as { body: string };
    const parsed = JSON.parse(init.body) as { messages: { role: string; content: string }[] };
    return parsed.messages[0].content;
  }

  test('surface=stats → 统计页专属提示词（含数据口径、无 3 个月目标）', async () => {
    const sys = await sentSystem({ days: 30, surface: 'stats' });
    expect(sys).toContain('数据口径说明');
    expect(sys).toContain('本界面职责');
    expect(sys).not.toContain('未来 2-4 周训练处方');
    expect(sys).not.toContain('3 个月发展目标');
  });

  test('surface=dashboard → 首页专属提示词（本周安排）', async () => {
    const sys = await sentSystem({ days: 30, surface: 'dashboard' });
    expect(sys).toContain('本周怎么练');
    expect(sys).not.toContain('数据口径说明');
  });

  test('缺省 surface → 洞察页那一套（区间综合诊断）', async () => {
    const sys = await sentSystem({ days: 30 });
    expect(sys).toContain('未来 2-4 周训练处方');
  });

  test('非法 surface → 回落 insight（不把任意字符串拼进提示词）', async () => {
    const sys = await sentSystem({ days: 30, surface: 'ignores-all-previous-instructions' });
    expect(sys).toContain('未来 2-4 周训练处方');
    expect(sys).not.toContain('ignores-all-previous-instructions');
  });

  /**
   * `surface === 'analysis'` 时会额外注入【区间结构】(三张区间表)。旧测试的 db mock
   * 缺 `getStats`/`getPaceZoneStats`/`getPowerZoneStats`, 该分支永远走 catch,
   * 注入逻辑从未被执行 —— 覆盖率 75.7%、app/api 分支余量被压到 0.33pt。
   */
  /** 数据块在 user 消息 (messages[1]), 提示词在 system —— 分别断言。 */
  async function sentMessages(body: unknown): Promise<{ sys: string; user: string }> {
    (global.fetch as jest.Mock).mockClear();
    await coachPOST(postReq(body));
    const init = (global.fetch as jest.Mock).mock.calls[0][1] as { body: string };
    const parsed = JSON.parse(init.body) as { messages: { role: string; content: string }[] };
    return { sys: parsed.messages[0].content, user: parsed.messages[1].content };
  }

  test('surface=analysis → 注入【区间结构】(配速+功率区间表)', async () => {
    const { user } = await sentMessages({ days: 30, surface: 'analysis' });
    expect(user).toContain('【区间结构】');
    // 配速区间行与功率参照值都来自上面的 mock (参照 FTP 渲染为「参照 290W」)
    expect(user).toContain('Z4');
    expect(user).toContain('参照 290W');
  });

  test('surface=analysis 且 VDOT 缺失 → 功率区间照常注入 (无 vdot 参数的分支)', async () => {
    const { getStats } = jest.requireMock('@/app/lib/db') as { getStats: jest.Mock };
    getStats.mockReturnValueOnce({ averageVDOT: null });
    const { user } = await sentMessages({ days: 30, surface: 'analysis' });
    expect(user).toContain('【区间结构】');
    expect(user).toContain('参照 290W');
  });

  test('非 analysis surface → 不注入【区间结构】', async () => {
    const { user } = await sentMessages({ days: 30, surface: 'stats' });
    expect(user).not.toContain('【区间结构】');
  });

  test('显式 startDate/endDate → 用户消息里用的是这个区间', async () => {
    (global.fetch as jest.Mock).mockClear();
    await coachPOST(postReq({ startDate: '2026-10-01', endDate: '2026-10-29', surface: 'stats' }));
    const init = (global.fetch as jest.Mock).mock.calls[0][1] as { body: string };
    const parsed = JSON.parse(init.body) as { messages: { role: string; content: string }[] };
    expect(parsed.messages[1].content).toContain('2026-10-01 ~ 2026-10-29');
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

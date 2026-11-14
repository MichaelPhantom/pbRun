/**
 * @jest-environment node
 *
 * AI 教练准入控制（速率 + 并发）契约测试。
 *
 * 背景（features.md §4.2 待办）：两个教练端点此前无服务端限流，前端重试
 * 循环会把 60–150s 的流式请求堆到本地网关。限流收敛在唯一出流层
 * `runCoachStream`，本文件同时验证纯函数口径与出流层接线。
 *
 * 注意：tests/setup.ts 全局把 COACH_RATE_LIMIT / COACH_MAX_CONCURRENT 置 0
 * （隔离其它流策略测试）；本文件每个用例显式设 env 并在 afterEach 还原。
 */
import {
  admitCoachRequest,
  coachLimitConfig,
  coachRateLimitKey,
  __resetCoachRateLimit,
  DEFAULT_COACH_LIMITS,
  CONCURRENT_RETRY_AFTER_SEC,
} from '@/app/lib/coach-rate-limit';
import { runCoachStream } from '@/app/lib/coach-stream';

const ENV_KEYS = ['COACH_RATE_LIMIT', 'COACH_RATE_WINDOW_SEC', 'COACH_MAX_CONCURRENT'] as const;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  __resetCoachRateLimit();
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  __resetCoachRateLimit();
  jest.restoreAllMocks();
});

const setLimits = (rate: string, concurrent: string, windowSec = '60') => {
  process.env.COACH_RATE_LIMIT = rate;
  process.env.COACH_MAX_CONCURRENT = concurrent;
  process.env.COACH_RATE_WINDOW_SEC = windowSec;
};

describe('coachLimitConfig', () => {
  test('默认值：20 次/60s、并发 2', () => {
    for (const k of ENV_KEYS) delete process.env[k];
    expect(coachLimitConfig()).toEqual(DEFAULT_COACH_LIMITS);
  });

  test('env 覆盖；非法值回落默认；0 合法（关闭闸门）', () => {
    process.env.COACH_RATE_LIMIT = '5';
    process.env.COACH_RATE_WINDOW_SEC = '30';
    process.env.COACH_MAX_CONCURRENT = '0';
    expect(coachLimitConfig()).toEqual({ maxRequests: 5, windowMs: 30_000, maxConcurrent: 0 });
    process.env.COACH_RATE_LIMIT = 'abc';
    expect(coachLimitConfig().maxRequests).toBe(DEFAULT_COACH_LIMITS.maxRequests);
  });
});

describe('速率闸门（滑动窗口）', () => {
  test('窗口内放行至上限，下一次拒绝并给 Retry-After', () => {
    setLimits('3', '0');
    const t0 = 1_000_000;
    expect(admitCoachRequest('ip1', t0).admitted).toBe(true);
    expect(admitCoachRequest('ip1', t0 + 1000).admitted).toBe(true);
    expect(admitCoachRequest('ip1', t0 + 2000).admitted).toBe(true);
    const rejected = admitCoachRequest('ip1', t0 + 3000);
    expect(rejected.admitted).toBe(false);
    if (!rejected.admitted) {
      // 最早一次在 t0，窗口 60s → 还需等 57s
      expect(rejected.retryAfterSec).toBe(57);
      expect(rejected.error).toContain('频繁');
    }
  });

  test('窗口滑动：旧请求过期后恢复放行', () => {
    setLimits('2', '0', '10');
    const t0 = 1_000_000;
    expect(admitCoachRequest('ip1', t0).admitted).toBe(true);
    expect(admitCoachRequest('ip1', t0 + 1000).admitted).toBe(true);
    expect(admitCoachRequest('ip1', t0 + 5000).admitted).toBe(false);
    // t0 的请求在 t0+10000 过期（严格大于 cutoff）
    expect(admitCoachRequest('ip1', t0 + 10_001).admitted).toBe(true);
  });

  test('不同 key 互不影响（按 IP 隔离）', () => {
    setLimits('1', '0');
    expect(admitCoachRequest('ip1', 1000).admitted).toBe(true);
    expect(admitCoachRequest('ip1', 2000).admitted).toBe(false);
    expect(admitCoachRequest('ip2', 2000).admitted).toBe(true);
  });

  test('速率设 0 → 关闭速率闸门', () => {
    setLimits('0', '0');
    for (let i = 0; i < 50; i++) expect(admitCoachRequest('ip1', 1000 + i).admitted).toBe(true);
  });
});

describe('并发闸门（全局）', () => {
  test('占满后拒绝；释放一个后恢复；释放幂等', () => {
    setLimits('0', '2');
    const a = admitCoachRequest('ip1');
    const b = admitCoachRequest('ip2'); // 不同 key 也共享并发闸
    expect(a.admitted).toBe(true);
    expect(b.admitted).toBe(true);
    const c = admitCoachRequest('ip3');
    expect(c.admitted).toBe(false);
    if (!c.admitted) {
      expect(c.retryAfterSec).toBe(CONCURRENT_RETRY_AFTER_SEC);
      expect(c.error).toContain('正在进行');
    }
    if (a.admitted) {
      a.release();
      a.release(); // 幂等：不得把计数减成负
    }
    const d = admitCoachRequest('ip3');
    expect(d.admitted).toBe(true);
    if (b.admitted) b.release();
    if (d.admitted) d.release();
    // 全部释放后可再占满 2 个（验证没有泄漏/负数）
    expect(admitCoachRequest('x').admitted).toBe(true);
    expect(admitCoachRequest('y').admitted).toBe(true);
    expect(admitCoachRequest('z').admitted).toBe(false);
  });

  test('并发设 0 → 关闭并发闸门', () => {
    setLimits('0', '0');
    const admissions = Array.from({ length: 10 }, () => admitCoachRequest('ip1'));
    expect(admissions.every((a) => a.admitted)).toBe(true);
  });
});

describe('coachRateLimitKey', () => {
  const headers = (m: Record<string, string>) => ({
    get: (k: string) => m[k.toLowerCase()] ?? null,
  });

  test('x-forwarded-for 取首跳（客户端真实 IP，不是代理链）', () => {
    expect(coachRateLimitKey(headers({ 'x-forwarded-for': '1.2.3.4, 10.0.0.1' }))).toBe('1.2.3.4');
  });
  test('无 xff 时取 x-real-ip', () => {
    expect(coachRateLimitKey(headers({ 'x-real-ip': '5.6.7.8' }))).toBe('5.6.7.8');
  });
  test('直连（无代理头）回落 local', () => {
    expect(coachRateLimitKey(headers({}))).toBe('local');
    expect(coachRateLimitKey(headers({ 'x-forwarded-for': ' , ' }))).toBe('local');
  });
});

describe('runCoachStream 接线', () => {
  const base = {
    baseUrl: 'http://upstream.test/v1',
    key: 'k',
    model: 'auto',
    messages: [{ role: 'user' as const, content: 'hi' }],
  };

  function sseResponse(): Response {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: ok\n\n'));
        controller.close();
      },
    });
    return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  }

  test('速率超限 → 429 + Retry-After，且不触达上游', async () => {
    setLimits('1', '0');
    const fetchMock = jest.fn(async () => sseResponse());
    global.fetch = fetchMock as unknown as typeof fetch;

    const first = await runCoachStream({ ...base, rateLimitKey: 'ip1' });
    expect(first.status).toBe(200);
    await first.text(); // 消费完，释放（速率计数仍占窗口）

    const second = await runCoachStream({ ...base, rateLimitKey: 'ip1' });
    expect(second.status).toBe(429);
    expect(Number(second.headers.get('Retry-After'))).toBeGreaterThan(0);
    const body = await second.json();
    expect(body.error).toContain('频繁');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('并发占满 → 第二个流被拒；第一个消费完后恢复', async () => {
    setLimits('0', '1');
    // 上游返回一个**不自动关闭**的流，占住并发槽
    let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;
    const openStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controllerRef = controller;
        controller.enqueue(new TextEncoder().encode('data: first\n\n'));
      },
    });
    global.fetch = jest.fn(async () => new Response(openStream, { status: 200 })) as unknown as typeof fetch;

    const first = await runCoachStream({ ...base, rateLimitKey: 'ip1' });
    expect(first.status).toBe(200);

    const second = await runCoachStream({ ...base, rateLimitKey: 'ip2' });
    expect(second.status).toBe(429);
    expect((await second.json()).error).toContain('正在进行');

    // 消费第一个流至结束 → 释放槽位
    controllerRef!.close();
    await first.text();

    global.fetch = jest.fn(async () => sseResponse()) as unknown as typeof fetch;
    const third = await runCoachStream({ ...base, rateLimitKey: 'ip2' });
    expect(third.status).toBe(200);
    await third.text();
  });

  test('上游失败（502）也释放并发槽 —— 失败不泄漏', async () => {
    setLimits('0', '1');
    global.fetch = jest.fn(async () => new Response('boom', { status: 500 })) as unknown as typeof fetch;
    const failed = await runCoachStream({ ...base, model: 'auto', rateLimitKey: 'ip1' });
    expect(failed.status).toBe(502);
    // 槽已释放：下一次仍可准入
    global.fetch = jest.fn(async () => sseResponse()) as unknown as typeof fetch;
    const ok = await runCoachStream({ ...base, rateLimitKey: 'ip1' });
    expect(ok.status).toBe(200);
    await ok.text();
  });

  test('客户端取消流 → 释放并发槽', async () => {
    setLimits('0', '1');
    const openStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: first\n\n'));
        // 不 close：保持流打开，取消时由级联 cancel 关闭
      },
    });
    global.fetch = jest.fn(async () => new Response(openStream, { status: 200 })) as unknown as typeof fetch;

    const res = await runCoachStream({ ...base, rateLimitKey: 'ip1' });
    const reader = res.body!.getReader();
    await reader.read(); // 首块
    await reader.cancel(); // 用户点「停止」→ 级联取消上游（上游控制器随之关闭）

    global.fetch = jest.fn(async () => sseResponse()) as unknown as typeof fetch;
    const next = await runCoachStream({ ...base, rateLimitKey: 'ip1' });
    expect(next.status).toBe(200);
    await next.text();
  });
});
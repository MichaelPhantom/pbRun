// 全局测试配置
import '@testing-library/jest-dom';

// jsdom 环境缺 Node 22 Web Streams (zip.js 依赖 ReadableStream/WritableStream/TransformStream)
if (typeof (globalThis as any).TransformStream === 'undefined') {
  const web = require('node:stream/web');
  (globalThis as any).TransformStream = web.TransformStream;
  (globalThis as any).ReadableStream = web.ReadableStream;
  (globalThis as any).WritableStream = web.WritableStream;
}

// jsdom 缺 TextEncoder/TextDecoder (SSE/流式测试需要)
if (typeof (globalThis as any).TextEncoder === 'undefined') {
  const { TextEncoder, TextDecoder } = require('node:util');
  (globalThis as any).TextEncoder = TextEncoder;
  (globalThis as any).TextDecoder = TextDecoder;
}

// jsdom 缺 Fetch Response/Headers; 便于测试 SSE/流式消费 (仅实现用到的表面)
if (typeof (globalThis as any).Headers === 'undefined') {
  (globalThis as any).Headers = class Headers {
    private m = new Map<string, string>();
    constructor(init?: Record<string, string> | [string, string][]) {
      if (Array.isArray(init)) init.forEach(([k, v]) => this.m.set(k.toLowerCase(), v));
      else if (init) Object.entries(init).forEach(([k, v]) => this.m.set(k.toLowerCase(), v));
    }
    get(k: string) {
      return this.m.get(k.toLowerCase()) ?? null;
    }
    set(k: string, v: string) {
      this.m.set(k.toLowerCase(), v);
    }
    has(k: string) {
      return this.m.has(k.toLowerCase());
    }
  };
}
if (typeof (globalThis as any).Response === 'undefined') {
  (globalThis as any).Response = class Response {
    status: number;
    ok: boolean;
    body: unknown;
    headers: any;
    private _text: string;
    constructor(
      body: unknown,
      init?: { status?: number; headers?: Record<string, string> },
    ) {
      this.status = init?.status ?? 200;
      this.ok = this.status >= 200 && this.status < 300;
      this.headers = new (globalThis as any).Headers(init?.headers);
      if (typeof body === 'string') {
        this._text = body;
        this.body = null;
      } else {
        this._text = '';
        this.body = body;
      }
    }
    static json(data: unknown, init?: { status?: number; headers?: Record<string, string> }) {
      return new (globalThis as any).Response(JSON.stringify(data), {
        status: init?.status ?? 200,
        headers: init?.headers,
      });
    }
    async json() {
      return JSON.parse(this._text);
    }
    async text() {
      return this._text;
    }
  };
}

// Mock next/navigation
jest.mock('next/navigation', () => ({
  useRouter: () => ({
    push: jest.fn(),
    replace: jest.fn(),
    prefetch: jest.fn(),
    back: jest.fn(),
    forward: jest.fn(),
    refresh: jest.fn(),
  }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/',
  redirect: jest.fn(),
}));

// Mock better-sqlite3
jest.mock('better-sqlite3', () => {
  return jest.fn().mockImplementation(() => ({
    prepare: jest.fn().mockReturnValue({
      get: jest.fn(),
      all: jest.fn().mockReturnValue([]),
      run: jest.fn(),
    }),
    close: jest.fn(),
  }));
});

// 清理测试环境
afterEach(() => {
  jest.clearAllMocks();
});

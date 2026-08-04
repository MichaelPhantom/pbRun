// 全局测试配置
import '@testing-library/jest-dom';

// jsdom 环境缺 Node 22 Web Streams (zip.js 依赖 ReadableStream/WritableStream/TransformStream)
if (typeof (globalThis as any).TransformStream === 'undefined') {
  const web = require('node:stream/web');
  (globalThis as any).TransformStream = web.TransformStream;
  (globalThis as any).ReadableStream = web.ReadableStream;
  (globalThis as any).WritableStream = web.WritableStream;
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

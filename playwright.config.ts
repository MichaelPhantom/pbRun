import { defineConfig, devices } from '@playwright/test';

/**
 * @see https://playwright.dev/docs/test-configuration
 */
// next.config.ts 的 basePath=/pbrun; e2e spec 用显式 "/pbrun/xxx" 前缀
// (2026-09-15 修: 此前 spec 用 "/list" 且 baseURL 无前缀 → 全 404 → e2e 不可运行).
// 注: 不用 baseURL+path (Playwright 对 "/xxx" 绝对路径会丢弃 baseURL 的 path)。

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'html',
  use: {
    baseURL: 'http://localhost:3000',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'firefox',
      use: { ...devices['Desktop Firefox'] },
    },
    {
      name: 'Mobile Chrome',
      use: { ...devices['Pixel 5'] },
    },
  ],
  // e2e 用「生产构建 + 夹具库」启动, 与真实产物一致且自包含:
  //  1) 无 DB 时生成夹具库 (scripts/testing/make-fixture-db.js)
  //  2) 构建到隔离目录 .next-e2e (DIST_DIR), 避免与开发/生产 .next 冲突
  //  3) DB_PATH 指向夹具库, next start 提供服务
  webServer: {
    command: [
      '[ -f tests/fixtures/activities.db ] || node scripts/testing/make-fixture-db.js',
      'bash scripts/testing/e2e-build.sh',
      'DIST_DIR=.next-e2e DB_PATH="$(pwd)/tests/fixtures/activities.db" next start -p 3000 -H 127.0.0.1',
    ].join(' && '),
    url: 'http://localhost:3000/pbrun',
    reuseExistingServer: !process.env.CI,
    timeout: 180000,
    env: {
      NEXT_TELEMETRY_DISABLED: '1',
    },
  },
});

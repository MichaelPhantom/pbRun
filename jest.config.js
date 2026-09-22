/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'jsdom',
  roots: ['<rootDir>/tests/unit', '<rootDir>/app'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/$1',
  },
  setupFiles: ['<rootDir>/tests/env.ts'],
  setupFilesAfterEnv: ['<rootDir>/tests/setup.ts'],
  coverageDirectory: '<rootDir>/coverage',
  coverageReporters: ['text', 'lcov', 'html'],
  collectCoverageFrom: [
    'app/**/*.{ts,tsx}',
    'scripts/**/*.js',
    '!app/**/*.d.ts',
    '!app/**/node_modules/**',
  ],
  // 覆盖率下限 (防回归)。整体门槛设在当前实测下方留余量;
  // 核心纯逻辑层 (app/lib 计算/服务/db) 单独设更高门槛。
  coverageThreshold: {
    // 全局门槛 (含未覆盖的页面/客户端组件) 设在实测下方留 ~3pt 余量, 防回归。
    // 注意: Jest 门槛聚合口径与 coverageReporters 摘要不同 (前者含全部
    // collectCoverageFrom 文件), 以门槛报错值为准。
    global: {
      statements: 72,
      branches: 58,
      functions: 68,
      lines: 73,
    },
    // 核心逻辑层 (计算/服务/db/ai/图表) 单独更高门槛
    './app/lib/': {
      statements: 82,
      lines: 84,
    },
  },
  testMatch: [
    '**/tests/unit/**/*.test.{ts,tsx,js}',
    '**/?(*.)+(spec|test).{ts,tsx,js}',
  ],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: 'tsconfig.json' }],
  },
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json'],
  testPathIgnorePatterns: [
    '/node_modules/',
    '/.next/',
  ],
};

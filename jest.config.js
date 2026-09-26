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
  //
  // 口径 (jest 30 实测, 见 @jest/reporters CoverageReporter._checkThreshold):
  // 命中 coverageThreshold 路径分组的文件 (./app/lib/) 只归属该分组,
  // 不再计入 global —— global 实为「除 app/lib 外的全部 collectCoverageFrom 文件」。
  // 未被任何测试加载的文件不进覆盖率映射, 既不计分子也不计分母。
  // 因此报错里的 actual% == 文本报表按同口径汇总的百分比 (可用 python 复算核对)。
  coverageThreshold: {
    // 全局门槛 (页面/客户端组件/脚本) 设在实测下方留 ~2pt 余量, 防回归。
    global: {
      statements: 72,
      branches: 61,
      functions: 70,
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

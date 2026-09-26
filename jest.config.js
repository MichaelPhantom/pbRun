/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'jsdom',
  roots: ['<rootDir>/tests/unit', '<rootDir>/app'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/$1',
    // 样式文件 stub: layout.tsx 等 import globals.css, jest 无法解析样式
    '\\.(css|scss|sass|less)$': '<rootDir>/tests/style-stub.js',
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
  // 覆盖率下限 (防回归)。门槛贴近实测值下方留 ~2pt 余量 (2026-09-27 校准):
  // global 实测 st 93.45 / br 80.84 / fn 94.54 / lines 95.26;
  // ./app/lib/ 实测 st 96.66 / lines 98.43。核心逻辑层门槛更高。
  //
  // 口径 (jest 30 实测, 见 @jest/reporters CoverageReporter._checkThreshold):
  // 命中 coverageThreshold 路径分组的文件 (./app/lib/) 只归属该分组,
  // 不再计入 global —— global 实为「除 app/lib 外的全部 collectCoverageFrom 文件」。
  // 未被任何测试加载的文件不进覆盖率映射, 既不计分子也不计分母。
  // 因此报错里的 actual% == 文本报表按同口径汇总的百分比 (可用 python 复算核对)。
  coverageThreshold: {
    // 全局门槛 (页面/客户端组件/脚本): 2026-09-27 由 72/61/70/73 提升至 91/78/92/93。
    global: {
      statements: 91,
      branches: 78,
      functions: 92,
      lines: 93,
    },
    // 核心逻辑层 (计算/服务/db/ai/图表) 更高门槛: 82/84 → 94/96
    './app/lib/': {
      statements: 94,
      lines: 96,
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

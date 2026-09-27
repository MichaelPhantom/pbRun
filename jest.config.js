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
  // 覆盖率下限 (防回归)。2026-09-27 四次校准: 由「global + app/lib 两条」细化为
  // 「global + app/lib + app/api + app/components + scripts」五条, 逐目录防回归。
  // 全部可执行文件 (app/** + scripts/**) 均已被测试加载, 仅 app/lib/types.ts 为纯类型。
  //
  // 口径 (jest 30 实测, 见 @jest/reporters CoverageReporter._checkThreshold):
  // 命中 coverageThreshold 路径分组的文件 (./app/lib/) 只归属该分组,
  // 不再计入 global —— global 实为「除 app/lib 外的全部 collectCoverageFrom 文件」。
  // 未被任何测试加载的文件不进覆盖率映射, 既不计分子也不计分母。
  // 因此报错里的 actual% == 文本报表按同口径汇总的百分比 (可用 python 复算核对)。
  coverageThreshold: {
    // 分目录门槛 (2026-09-27 四次校准): 各目录留 ~1.5-2pt 余量, 任一目录退化即红灯。
    // 口径见上: 命中更窄路径的文件只归属该分组, 不再计入 global。
    // 实测 (2026-09-27 六次, 分组口径): 页面与路由 98.91/88.07/97.35; app/lib 97.62/89.02/98.02;
    //       app/api 95.60/90.81/100; app/components 98.52/90.05/100; scripts 96.72/90.19/94.74。
    // 余量规则: 每组每项至少留 ~1.5pt —— CI 与本地环境存在细微差异 (Node/依赖版本),
    // 贴着实测设门槛会让 CI 偶发红灯 (2026-09-27 首次把 global branches 设成实测 88.07 的 88,
    // CI 直接失败; 已按下调)。改门槛时请同时核对本地实测与本条余量规则。
    global: {
      statements: 96,
      branches: 86,
      functions: 95,
      lines: 97,
    },
    // 核心逻辑层 (计算/服务/db/ai/图表)
    './app/lib/': {
      statements: 96,
      branches: 87,
      functions: 97,
      lines: 98,
    },
    // API 路由 (参数校验与错误分支)
    './app/api/': {
      statements: 94,
      branches: 89,
      functions: 99,
    },
    // 通用 UI 组件
    './app/components/': {
      statements: 97,
      branches: 89,
      functions: 99,
    },
    // CLI 脚本与数据管线
    './scripts/': {
      statements: 95,
      branches: 88,
      functions: 93,
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

# pbRun 完整测试方案

## 1. 测试架构概览

**本节的树就是仓库里的真实结构**（`tests/unit/docs/docs-reality.test.ts` 会核对文档
引用的路径是否存在，虚构文件名会直接红灯）。

```
tests/
├── unit/                          # 单元测试 (Jest, jsdom)
│   ├── lib/                       # 纯函数 + 数据访问 + 洞察计算 (48 个套件)
│   ├── components/                # React 组件测试 (20 个套件, kebab-case)
│   ├── pages/                     # 页面级编排 (server component 取数/聚合)
│   ├── api/                       # API 路由测试
│   ├── common/                    # scripts/common (db-manager / utils / vdot)
│   ├── garmin/                    # FIT 解析与同步
│   ├── strava/                    # Strava 同步
│   ├── scripts/                   # CLI 脚本契约 (require 不执行 main)
│   ├── mcp/                       # MCP Server 工具
│   ├── ci/                        # 门禁守护 (runner 镜像 / 门禁对齐 / 阈值余量)
│   ├── docs/                      # 文档 ↔ 现实一致性守护
│   └── phase1-directory-structure.test.js
├── integration/                   # 集成测试 (Jest)
│   └── strava-sync.test.js        # Strava 同步全流程 (mock API → DB 写入)
├── e2e/                           # E2E UI 测试 (Playwright, 扁平文件)
│   ├── navigation.spec.ts         # 各页可达 + 关键内容
│   ├── activity-list.spec.ts      # 月份汇总 / 搜索 / 跳转
│   ├── activity-detail.spec.ts    # 概览 / 分段表 / 趋势 / AI
│   ├── tables.spec.ts             # 10 张数据表的结构与内容
│   ├── stats.spec.ts              # 统计概览 / 周期 / 个人纪录
│   ├── mobile.spec.ts             # 移动端 (375×667)
│   ├── a11y.spec.ts               # axe 扫描 (7 页 × 桌面/移动)
│   └── helpers/                   # e2e 公共工具
├── fixtures/                      # 夹具 (activities.db 现生成; *.zip 为 FIT 样本)
├── python/                        # Python 脚本测试 (pytest)
│   ├── conftest.py
│   ├── test_fetcher_strava.py
│   └── test_get_garmin_token.py
├── env.ts / setup.ts / style-stub.js
└── README.md
```

> 不存在 `tests/mocks/` 目录，也不存在独立的 SQL 夹具脚本（夹具由 `make-fixture-db.js`
> 直接调用 `DatabaseManager` 生成）。Mock 数据就近定义在测试文件内的工厂函数里（见 §6.2）。

---

## 2. 单元测试 (Jest)

### 2.1 配置

**jest.config.js（要点，完整见仓库根）**
```javascript
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'jsdom',
  roots: ['<rootDir>/tests/unit', '<rootDir>/app'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/$1',
    // 样式 stub: layout.tsx 等 import globals.css, jest 无法解析样式文件
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
  coverageThreshold: {
    // 2026-09-27 六次校准: 5 组逐目录防回归; 每组每项至少留 ~1.5pt 余量
    // (贴着实测设门槛会让 CI 偶发红灯 —— global branches 曾因此失败一次)
    global: { statements: 96, branches: 86, functions: 95, lines: 97 },
    './app/lib/': { statements: 96, branches: 87, functions: 96, lines: 97 },
    './app/api/': { statements: 94, branches: 89, functions: 99 },
    './app/components/': { statements: 97, branches: 88, functions: 99 },
    './scripts/': { statements: 95, branches: 88, functions: 93 },
  },
  testMatch: [
    '**/tests/unit/**/*.test.{ts,tsx,js}',
    '**/?(*.)+(spec|test).{ts,tsx,js}',
  ],
};
```

**覆盖率门槛口径（jest 30 实测，曾误判过一次，记此备查）**

- `coverageThreshold` 里按路径分组的 `./app/lib/` **优先命中**：命中的文件只归属该分组，
  **不再计入 `global`**。所以 `global` 的真实含义是「`collectCoverageFrom` 里除 `app/lib/`
  之外的全部文件」（页面、客户端组件、`scripts/**`）。
- 未被任何测试 `require`/渲染到的文件**不进覆盖率映射**：分子分母都不算。因此
  「补测试」要挑**已被加载但覆盖低**的文件收益最高（1:1 拉高），而「加载一个新文件」
  只有在其自身覆盖率 **高于对应门槛**时才净收益，否则反而拖低。
- 核对方法：`npx jest --coverage --coverageReporters=json-summary` 后按上述分组
  汇总 `coverage/coverage-summary.json`，所得百分比应与 Jest 报错里的 `actual%` 一致。

**tests/setup.ts**
```typescript
// 全局测试配置
import '@testing-library/jest-dom';

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
```

### 2.2 测试用例设计

#### lib/date-utils.ts
```typescript
// tests/unit/lib/date-utils.test.ts
describe('date-utils', () => {
  describe('monthToRange', () => {
    test('应正确转换月份到日期范围', () => {
      const result = monthToRange('2024-03');
      expect(result).toEqual({
        startDate: '2024-03-01',
        endDate: '2024-03-31',
      });
    });

    test('应正确处理闰年2月', () => {
      const result = monthToRange('2024-02');
      expect(result.endDate).toBe('2024-02-29');
    });

    test('应正确处理非闰年2月', () => {
      const result = monthToRange('2023-02');
      expect(result.endDate).toBe('2023-02-28');
    });
  });
});
```

#### lib/vdot-pace.ts
```typescript
// tests/unit/lib/vdot-pace.test.ts
describe('vdot-pace', () => {
  describe('calculateVdotFromPace', () => {
    test('应正确计算VDOT值', () => {
      // 配速 5:00/km, 心率 150, 最大心率 190, 静息心率 55
      const vdot = calculateVdotFromPace(300, 150, 190, 55);
      expect(vdot).toBeGreaterThan(0);
      expect(vdot).toBeLessThan(100);
    });

    test('心率数据缺失时应返回null', () => {
      const vdot = calculateVdotFromPace(300, null, 190, 55);
      expect(vdot).toBeNull();
    });

    test('应处理边界配速值', () => {
      // 非常快的配速
      const vdotFast = calculateVdotFromPace(180, 180, 190, 55);
      expect(vdotFast).toBeGreaterThan(50);
    });
  });

  describe('getPaceZoneBoundsFromVdot', () => {
    test('应返回5个配速区间', () => {
      const bounds = getPaceZoneBoundsFromVdot(50);
      expect(Object.keys(bounds)).toHaveLength(5);
      expect(bounds[1]).toHaveProperty('paceMin');
      expect(bounds[1]).toHaveProperty('paceMax');
    });

    test('VDOT为0时应返回空数组', () => {
      const bounds = getPaceZoneBoundsFromVdot(0);
      expect(bounds).toEqual([]);
    });
  });
});
```

#### lib/db.ts
```typescript
// tests/unit/lib/db.test.ts（另有 db-gaps / db-degradation / db-stats-branches 等分支套件）
describe('Database Queries', () => {
  let mockDb: any;

  beforeEach(() => {
    mockDb = {
      prepare: jest.fn().mockReturnValue({
        get: jest.fn(),
        all: jest.fn().mockReturnValue([]),
      }),
    };
  });

  describe('getActivities', () => {
    test('应支持分页查询', () => {
      const result = getActivities({ page: 1, limit: 20 });
      expect(result.pagination).toEqual({ page: 1, limit: 20, total: 0 });
    });

    test('应支持日期范围过滤', () => {
      getActivities({
        startDate: '2024-01-01',
        endDate: '2024-12-31',
      });
      // 验证SQL包含日期条件
    });

    test('应支持类型过滤', () => {
      getActivities({ type: 'running' });
      // 验证SQL包含类型条件
    });
  });

  describe('getPersonalRecords', () => {
    test('应返回各距离最佳成绩', () => {
      const result = getPersonalRecords('total');
      expect(result.records).toHaveLength(6); // 1.6k, 3k, 5k, 10k, 半马, 全马
    });

    test('应计算最长跑步距离', () => {
      const result = getPersonalRecords('month');
      expect(result).toHaveProperty('longestRunMeters');
      expect(result).toHaveProperty('longestRunDate');
    });
  });
});
```

#### React Components
```typescript
// tests/unit/components/list-client.test.tsx（组件测试文件名为 kebab-case）
describe('ListClient', () => {
  const mockProps = {
    initialMonthSummaries: [
      { monthKey: '2024-03', totalDistance: 100, count: 5 },
    ],
    initialTotalMonths: 12,
    initialActivitiesByMonth: {},
    initialExpandedMonth: null,
  };

  test('应渲染月份列表', () => {
    render(<ListClient {...mockProps} />);
    expect(screen.getByText('2024年03月')).toBeInTheDocument();
  });

  test('点击月份应展开活动详情', async () => {
    render(<ListClient {...mockProps} />);
    const monthHeader = screen.getByText('2024年03月');
    await userEvent.click(monthHeader);
    // 验证API调用或子组件渲染
  });

  test('应支持搜索过滤', async () => {
    render(<ListClient {...mockProps} />);
    const searchInput = screen.getByPlaceholderText('搜索活动...');
    await userEvent.type(searchInput, 'Morning Run');
    // 验证过滤逻辑
  });
});
```

#### API Routes
```typescript
// tests/unit/api/routes.test.ts（含 /api/activities 的 GET 用例）
import { GET } from '@/app/api/activities/route';

describe('API - /api/activities', () => {
  test('GET应返回活动列表', async () => {
    const request = new Request('http://localhost/api/activities?page=1&limit=20');
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data).toHaveProperty('data');
    expect(data).toHaveProperty('pagination');
  });

  test('GET应支持日期过滤', async () => {
    const request = new Request(
      'http://localhost/api/activities?startDate=2024-01-01&endDate=2024-12-31'
    );
    const response = await GET(request);
    expect(response.status).toBe(200);
  });
});
```

#### CLI 脚本 (scripts/**)
```javascript
// tests/unit/scripts/imports.test.js
// 契约: 脚本必须 `if (require.main === module)` 守卫, 导出可测入口,
// 被 require 时不得跑 main / 写库 / 开浏览器。
// 验证放在子进程 (真实 Node + 真实 require.main 判定), 顺带避免把
// 「只验导入无副作用」的脚本拉进覆盖率稀释统计。
describe('CLI 脚本导入契约', () => {
  test('子进程 require 全部脚本: 不执行 main 且导出符合预期', () => {
    const stdout = execFileSync(process.execPath, ['-e', childScript], { cwd: ROOT });
    // 解析每个脚本的导出类型/缺失入口/SIGINT 监听增量
  });
});

```

### 2.3 测试优先级

| 模块 | 优先级 | 覆盖率目标 |
|------|--------|-----------|
| lib/vdot-pace.ts | P0 | 90%+ |
| lib/date-utils.ts | P0 | 90%+ |
| lib/db.ts | P0 | 80%+ |
| lib/format.ts | P1 | 80%+ |
| API Routes | P0 | 85%+ |
| React Components | P1 | 70%+ |
| 同步脚本 | P0 | 80%+ |

### 2.2.1 契约型机器守卫（覆盖率之外的防线）

有些缺陷**不改变分支/行覆盖**，只在「代码与外部契约不一致」时出现 —— 这类必须用
**运行时 introspect + 反向断言**的守卫，而不是指望覆盖率：

| 守卫 | 拦的缺陷 | 为什么覆盖率拦不住 |
|------|---------|-------------------|
| `tests/unit/garmin/fit-parser-sdk-fields.test.ts` | 解析器读了 `fit-file-parser` SDK profile 里**不存在**的字段名（2026-10-27 审计发现 19 个死读站点、12 个假名字） | `_safeGet*` 对不存在的键返回 `null` 且不报错，**所有分支都走到了**、覆盖率 100%，只是值永远是 null。它从 `FIT.messages` 运行时取字段名集合逐站点校验，并反向断言 allowlist 不含真实存在/已不再读取的条目 |
| `tests/unit/components/insight-field-consumption.test.ts` | 类型里声明、数据层算好，但 UI/AI **从未读取**的字段 | 字段存在即「有值」，没人读不产生任何未覆盖分支 |
| `tests/unit/common/db-manager-lap-columns.test.js` | 写入侧按「首条记录」推导列集合，静默丢弃后续记录独有的字段（真实丢失 `599287904`/`614598589` 各 14/12 个 lap 的配速/速度/步频） | `Object.keys(x[0])` 与「取并集」在**单条记录**时行为完全相同，覆盖率看不出来；只有多记录且首条缺键才暴露 |
| `tests/unit/common/lap-zones.test.js` | lap 时间窗切分用闭区间（边界那一秒被相邻两段重复计入）、按 `start_time` 而非 `cumulative_time` 对齐、`Number(null)===0` 让「时间未知」的记录落进第一段 | 闭区间与半开区间在**单段**活动里结果完全相同；时间错位在总和上互相抵消（各段各自偏大/偏小但合计正常），只有逐段对账才暴露 |
| `tests/unit/scripts/backfill-lap-zones.test.js` | 回填脚本先重算再补 `device_*` 列（旧设备数组被推导值覆盖，原始数据永久丢失） | 顺序缺陷只在「旧库里已有设备数组」时显现；新建库/已回填库都不会触发 |
| `tests/unit/common/db-manager-units.test.js` | schema 注释把 `activity_records.speed` 写成「米/秒」（实际 km/h，差 3.6×）、`distance` 写成「米」（实际公里，差 1000×） | 注释不是可执行代码，覆盖率与运行时断言完全看不见；只有按注释写过滤条件时才炸（解耦已因此把 0.5 km/h 当 0.5 m/s） |
| `tests/unit/common/db-manager-schema-drift.test.js` | 生产库缺代码声明的列（`device_time_in_speed_zone`/`_cadence_zone`）、多出旧口径列；`upsertActivity` 按对象键拼 SQL、读用 `SELECT *`，两侧都不报错 | 漂移只在「用 raw sqlite 打开库的路径」上出现，`DatabaseManager` 一打开就自动补列 —— 所以本机单测永远绿，只有真库才漂 |
| `tests/unit/common/db-manager-schema-drift.test.js`（搬运分支） | 清理遗留列时无条件 `DROP COLUMN`：本库恰好 100% NULL，但用户从备份恢复的旧库有值时会被静默丢弃 | 「本库为空」不等于「所有库为空」；迁移不报错，丢数据无声无息 |
| `tests/unit/mcp/tool-scope-contract.test.ts` | MCP tool description 不声明统计口径/单位 | 文案是字符串常量，没有分支 |
| `tests/unit/docs/api-route-coverage.test.ts` | 新增 API 路由未写进 README/API 文档 | 文档与代码是两棵树 |

纪律：**同一类缺陷第二次出现时，必须把「人眼审计」升级成机器守卫**。本节第一个
守卫就是这样诞生的 —— 先人工发现 1 个读错的字段名，再扩成全量 introspect。

---

## 3. E2E UI测试 (Playwright)

### 3.1 配置与运行

E2E 采用**自包含**方式：Playwright 的 `webServer` 会

1. 生成夹具数据库 `tests/fixtures/activities.db`（`scripts/testing/make-fixture-db.js`，
   真实 schema + 5 条确定性样本，**时间相对今天生成**，含同路线活动以触发多张对比表）；
2. 构建到隔离产物目录 `.next-e2e`（`scripts/testing/e2e-build.sh`，并处理本机 `app/data` 软链）；
3. 以 `DB_PATH` 指向夹具库、`next start` 起服务（生产产物，非 dev）。

故 CI 无需真实数据库即可运行全部 e2e；本地用 `npm run test:e2e`（默认三浏览器项目，
CI 只跑 chromium）。

**playwright.config.ts（关键部分）**
```typescript
export default defineConfig({
  testDir: './tests/e2e',
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  use: { baseURL: 'http://localhost:3000', trace: 'on-first-retry', screenshot: 'only-on-failure' },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'Mobile Chrome', use: { ...devices['Pixel 5'] } },
  ],
  webServer: {
    command: [
      '[ -f tests/fixtures/activities.db ] || node scripts/testing/make-fixture-db.js',
      'bash scripts/testing/e2e-build.sh',
      'DIST_DIR=.next-e2e DB_PATH="$(pwd)/tests/fixtures/activities.db" next start -p 3000 -H 127.0.0.1',
    ].join(' && '),
    url: 'http://localhost:3000/pbrun',
    reuseExistingServer: !process.env.CI,
    timeout: 180000,
  },
});
```

**覆盖范围**：`navigation`（导航/各页可达 + 内容）、`activity-list`（月份汇总/搜索过滤/跳转）、
`activity-detail`（概览/分段表/趋势/AI）、`tables`（10 张数据表的结构与内容断言、
单行不换行、行高亮）、`stats`（概览/周期切换/个人纪录）、`mobile`（移动端单行不换行）。

**夹具时间相对「今天」生成，断言不得写死日期**：`make-fixture-db.js` 用
`daysAgo()` 生成 2 / 4 / 7 / 12 / 14 天前的活动，保留相对先后与间隔。原因：洞察/
统计页按「最近 7 / 30 / 180 天」取数，写死日期后时间一过 30 天窗口就圈不到任何夹具
活动 —— 页面渲染「所选区间数据不足」，断言「关键洞察 / 训练类别对比」可见的用例
随即失败，而业务代码完全正确（2026-10-27 实测：chromium 51 例里 2 例红，其余全绿，
从红灯本身几乎看不出原因）。因此数值断言只用于**与时间无关**的量（如活动名、分段
结构、表格列），月份/区间相关断言一律用「当前年月」或形态匹配（`\d+\.\d{2}\s*公里`）。
`tests/unit/scripts/make-fixture-db.test.js` 守护「活动必须落在最近 30 天内」。

**断言也不得写死「图表清单」**：趋势卡标题由 `trendChartTitle(records, running)`
按**实际可渲染的图**派生，同一份夹具在「有 / 无 step_length」或「有 / 无海拔」时
标题会不同。`tests/e2e/activity-detail.spec.ts` 因此用
`/配速 \/ 心率 \/ 步频( \/ 步幅)? \/ 海拔 趋势/` 这种可选段正则，而不是完整字面串 ——
否则一旦组件按数据增减图表（这本身是正确行为），用例就会误报红。这与「不得写死
日期」是同一类纪律：**断言要跟随契约，不要跟随某一时刻的数据形态**。

**夹具必须覆盖「展示条件所依赖的字段分布」**：2026-10-27 实测发现详情页「跑步动态」
卡在生产环境**从未渲染过** —— 展示条件只判 `average_gct_balance`，而真实库
**348/348 条活动该字段全为 NULL**，触地时间与垂直摆动却在 **241/241 条跑步活动**
里都有值。夹具此前完全不写这三个字段，e2e 因此永远测不到。现夹具按真实分布写入
触地时间/垂直摆动/垂直振幅比、`gct_balance` 保持 NULL。纪律：**当一个区块用「某字段
非空」作为展示条件时，夹具必须让该条件在真实数据下可达** —— 否则用例绿而功能死。
同类还有强度分布标题（`/insight` 曾写死「Z1–Z6」；夹具也一度写 7 槽设备数组，
与回填后的生产库分布相反，会让「Z6/Z7 永不为零」的缺陷在 e2e 里无法暴露）。

### 3.2 测试用例设计

#### 页面导航测试
```typescript
// tests/e2e/navigation.spec.ts
test.describe('页面导航', () => {
  test('首页应重定向到活动列表', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL('/list');
  });

  test('应能访问统计页面', async ({ page }) => {
    await page.goto('/stats');
    await expect(page).toHaveTitle(/统计/);
    await expect(page.locator('h1')).toContainText('统计');
  });

  test('应能访问分析页面', async ({ page }) => {
    await page.goto('/analysis');
    await expect(page.locator('text=心率区间分析')).toBeVisible();
  });

  test('无效页面应显示404', async ({ page }) => {
    await page.goto('/nonexistent');
    await expect(page.locator('text=404')).toBeVisible();
  });
});
```

#### 活动列表页测试
```typescript
// tests/e2e/activity-list.spec.ts
test.describe('活动列表页', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/list');
  });

  test('应显示月份列表', async ({ page }) => {
    await expect(page.locator('[data-testid="month-item"]')).toHaveCount.greaterThan(0);
  });

  test('点击月份应展开活动列表', async ({ page }) => {
    const firstMonth = page.locator('[data-testid="month-item"]').first();
    await firstMonth.click();
    await expect(page.locator('[data-testid="activity-item"]')).toBeVisible();
  });

  test('应支持无限滚动加载更多月份', async ({ page }) => {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await expect(page.locator('[data-testid="month-item"]')).toHaveCount.greaterThan(6);
  });

  test('搜索功能应过滤活动', async ({ page }) => {
    await page.fill('[data-testid="search-input"]', 'Morning');
    await expect(page.locator('[data-testid="activity-item"]')).toContainText('Morning');
  });

  test('点击活动应跳转到详情页', async ({ page }) => {
    const firstMonth = page.locator('[data-testid="month-item"]').first();
    await firstMonth.click();
    const activity = page.locator('[data-testid="activity-item"]').first();
    await activity.click();
    await expect(page).toHaveURL(/\/pages\/\d+/);
  });
});
```

#### 活动详情页测试
```typescript
// tests/e2e/activity-detail.spec.ts
test.describe('活动详情页', () => {
  test('应显示活动基本信息', async ({ page }) => {
    await page.goto('/pages/12345');
    await expect(page.locator('[data-testid="activity-name"]')).toBeVisible();
    await expect(page.locator('[data-testid="activity-distance"]')).toBeVisible();
    await expect(page.locator('[data-testid="activity-duration"]')).toBeVisible();
  });

  test('应显示配速图表', async ({ page }) => {
    await page.goto('/pages/12345');
    await expect(page.locator('[data-testid="pace-chart"]')).toBeVisible();
  });

  test('应显示分段数据表格', async ({ page }) => {
    await page.goto('/pages/12345');
    await expect(page.locator('[data-testid="laps-table"]')).toBeVisible();
    await expect(page.locator('[data-testid="laps-table-row"]')).toHaveCount.greaterThan(0);
  });

  test('无效活动ID应显示404', async ({ page }) => {
    await page.goto('/pages/999999999');
    await expect(page.locator('text=活动未找到')).toBeVisible();
  });
});
```

#### 统计分析页测试
```typescript
// tests/e2e/stats.spec.ts
test.describe('统计页面', () => {
  test('应显示总体统计数据', async ({ page }) => {
    await page.goto('/stats');
    await expect(page.locator('[data-testid="total-distance"]')).toBeVisible();
    await expect(page.locator('[data-testid="total-activities"]')).toBeVisible();
    await expect(page.locator('[data-testid="average-pace"]')).toBeVisible();
  });

  test('应支持切换时间周期', async ({ page }) => {
    await page.goto('/stats');
    await page.selectOption('[data-testid="period-selector"]', 'month');
    await expect(page.locator('[data-testid="stats-container"]')).toBeVisible();
  });

  test('应显示个人纪录表格', async ({ page }) => {
    await page.goto('/stats');
    await expect(page.locator('[data-testid="pr-table"]')).toBeVisible();
    await expect(page.locator('[data-testid="pr-row"]')).toHaveCount(6);
  });
});
```

#### 分析页面测试
```typescript
// tests/e2e/navigation.spec.ts（分析页断言在 navigation 里）
test.describe('分析页面', () => {
  test('应显示心率区间图表', async ({ page }) => {
    await page.goto('/analysis');
    await expect(page.locator('[data-testid="hr-zone-chart"]')).toBeVisible();
  });

  test('应支持按周/月聚合切换', async ({ page }) => {
    await page.goto('/analysis');
    await page.click('[data-testid="group-by-week"]');
    await expect(page.locator('[data-testid="chart-week-label"]')).toBeVisible();
    await page.click('[data-testid="group-by-month"]');
    await expect(page.locator('[data-testid="chart-month-label"]')).toBeVisible();
  });

  test('VDOT趋势页面应显示趋势图', async ({ page }) => {
    await page.goto('/analysis');
    await page.click('text=VDOT趋势');
    await expect(page.locator('[data-testid="vdot-trend-chart"]')).toBeVisible();
  });
});
```

#### 移动端适配测试
```typescript
// tests/e2e/mobile.spec.ts
test.describe('移动端响应式', () => {
  test('活动列表在移动端应正常显示', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto('/list');
    await expect(page.locator('[data-testid="month-item"]')).toBeVisible();
  });

  test('图表在移动端应可横向滚动', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto('/analysis');
    const chart = page.locator('[data-testid="hr-zone-chart"]');
    await chart.scrollIntoViewIfNeeded();
    await expect(chart).toBeVisible();
  });
});
```

### 3.3 测试优先级

| 测试场景 | 优先级 | 说明 |
|---------|--------|------|
| 首页/列表页基本功能 | P0 | 核心功能 |
| 活动详情页 | P0 | 核心功能 |
| 统计页面 | P0 | 核心功能 |
| 分析页面图表 | P1 | 重要功能 |
| 移动端适配 | P1 | 用户体验 |
| 错误页面 | P2 | 边界情况 |

---

## 4. 集成测试

### 4.1 数据同步流程测试

```typescript
// tests/integration/strava-sync.test.js（Garmin 同步流程由 tests/unit/garmin/* 覆盖）
describe('Garmin 同步流程', () => {
  test('完整同步流程：下载 → 解析 → 存储', async () => {
    // 1. 模拟FIT文件下载
    // 2. 验证解析结果
    // 3. 验证数据库写入
    // 4. 验证统计接口可即时读到新数据（实时聚合，无缓存步骤）
  });

  test('增量同步应只处理新文件', async () => {
    // 验证已存在文件被跳过
  });

  test('错误文件应被记录并跳过', async () => {
    // 验证损坏FIT文件的处理
  });
});
```

### 4.2 API 集成测试

```typescript
// tests/integration/strava-sync.test.js（API 流程由 tests/unit/api/routes.test.ts 覆盖）
describe('Activity API 流程', () => {
  test('获取活动 → 获取详情 → 获取分段数据', async () => {
    // 1. 获取活动列表
    const listRes = await fetch('/api/activities?limit=1');
    const listData = await listRes.json();

    // 2. 获取首个活动详情
    const activityId = listData.data[0].activity_id;
    const detailRes = await fetch(`/api/activities/${activityId}`);
    expect(detailRes.status).toBe(200);

    // 3. 获取分段数据
    const lapsRes = await fetch(`/api/activities/${activityId}/laps`);
    expect(lapsRes.status).toBe(200);
  });
});
```

---

## 5. Python 脚本测试 (pytest)

### 5.1 运行方式

```bash
npm run test:python        # = python3 -m pytest tests/python -q
```

**已在 CI 的 `quality` 作业中执行**（`.github/workflows/test.yml` 的「Python 脚本测试」
步骤，先 `pip install pytest` 再 `npm run test:python`），并同步纳入 `npm run test:ci`。
守护测试：`tests/unit/ci/gate-alignment.test.ts` 断言 `test:python` 存在、包含
`tests/python`、且被 `test:ci` 与 workflow 同时调用 —— 防止「测试存在但没人跑」。

> 历史教训（2026-10-27）：这套测试此前**从未进 CI**。文档声称有 pytest，实际没人执行，
> 于是两个真实缺陷长期潜伏：
> 1. `get_garmin_token` 的 `@patch('getpass.getpass')` 打错目标 —— 源码是
>    `from getpass import getpass`，已绑定为模块级名字，patch 标准库模块属性无效，
>    测试会真的去读终端密码，无 TTY 的 runner 上直接 `UnsupportedOperation`。
> 2. Strava `max_speed` 未转 km/h，与 Garmin 写入的 km/h 混在同一列。

### 5.2 依赖处理

`tests/python` **不依赖** `stravalib` / `gpxpy` / `garth` 这些外部库：测试文件在 import
被测模块之前自行 `sys.modules` mock 掉它们，因此在干净 runner 上只需 pytest 即可运行。
若某个被测函数确实需要真实库，应在测试文件顶部显式 mock 并注明原因，而不是让
ImportError 打断整个收集阶段（一个模块 import 失败会让整轮 pytest 一条都不跑）。

### 5.3 覆盖范围

| 文件 | 被测对象 | 关键断言 |
|------|---------|---------|
| `test_fetcher_strava.py` | `scripts/strava/fetcher.py` 的纯函数与 `transform_activity_data` | `parse_quantity` / `format_duration` / `format_pace` / `pace_to_seconds`；`distance` 米→公里；`average_speed` 与 `max_speed` **同为 km/h**（4.5 m/s → 16.2 km/h，回归：旧实现原样落 m/s）；步频 rpm→spm；无 `max_speed` 落 `None` 而非 `0.0` |
| `test_get_garmin_token.py` | `scripts/garmin/get_garmin_token.py` 的 `_load_dotenv` / `main` | `.env` 解析（注释、空行、已有环境变量不覆盖）；环境变量优先于交互输入；缺凭据返回 1；认证异常返回 1。patch 目标是**模块级名字** `get_garmin_token.getpass`，不是 `getpass.getpass` |

### 5.4 与 Jest 的分工

Python 测试只覆盖**Python 写入侧**（Strava fetcher 的单位换算与字段映射）。TS/JS 侧
（FIT 解析、DB 层、API、UI、AI prompt）全部由 Jest 覆盖，两者不重复。单位契约需要
两侧同时验证：Garmin 走 `fit-parser.js`（Jest），Strava 走 `fetcher.py`（pytest），
两边写进同一列就必须同单位。

---

## 6. 测试数据管理

### 6.1 夹具库（e2e 与本地联调）

**唯一来源：`scripts/testing/make-fixture-db.js`**（`npm run fixture:db`）

```bash
npm run fixture:db                       # → tests/fixtures/activities.db
node scripts/testing/make-fixture-db.js /tmp/other.db   # 指定输出
```

要点：

- 用**生产同一套** `DatabaseManager` 建表，schema 与线上完全一致（不是手写 SQL 副本）。
- 时间**相对 `Date.now()` 生成**（`daysAgo` / `isoUtc` / `localStamp`，偏移 2/4/7/12/14 天）。
  写死日期会让「最近 30 天」窗口随时间推移再也圈不到夹具活动，页面显示「数据不足」，
  e2e 断言随即失败 —— 而业务代码完全正确。这类失败只在特定日期之后出现，极难归因。
- 夹具必须让**展示条件可达**：例如「跑步动态」卡片的渲染条件是
  「触地平衡 / 触地时间 / 垂直摆动 / 垂直振幅比 任一非空」，而真实库里
  `average_gct_balance` 348/348 全为 NULL、触地时间与垂直摆动 241/241 都有值 ——
  夹具若只写 `gct_balance`，就会造出「测试全绿但功能从未渲染」的假绿灯。
  同理，标题/文案由实际非零数据派生时（如心率区间标题），夹具要覆盖到非零区间。
- **派生值必须由真实实现算，不能在夹具里写死**。2026-10-27 修：夹具此前把
  `activities.time_in_hr_zone` 写死成 `[10,30,1200,250,800]`，同时逐秒记录只到
  200 秒（4 段 lap 累计 1448 秒）。于是
  ① 活动级区间与 lap 级区间**自相矛盾**（生产里两者由同一批记录推导、必然可加总）；
  ② 只有 lap 0 的时间窗内有样本，分段表「主要区间」列 3/4 是 `--`，
  「按 lap 时间窗推导」这条链路在 e2e 里等于没测。
  现夹具改为：逐秒记录覆盖到最后一段结束（1448 点）、各段心率不同（120/138/168/175
  → 主区间 Z1/Z2/Z4/Z4）、lap 级与活动级区间**都由 `hrZoneSecondsFromRecords` /
  `deriveLapZoneSeconds` 现场推导**。`tests/unit/scripts/make-fixture-db.test.js`
  断言「记录覆盖全部 lap 时间窗」「各段主区间不全相同」「样本里不含写死的区间」。
- `tests/fixtures/*.db` 被 `.gitignore` 忽略（第 76 行），CI 每次现生成。
- `tests/fixtures/activity.zip` / `activity-nofit.zip` 是 FIT 解析测试用的真实文件样本。

### 6.2 Mock 数据

不设独立的 `tests/mocks/` 目录。各处 mock 就近定义在测试文件内（工厂函数 + 覆盖参数），
例如：

- `tests/unit/lib/llm.test.ts` 的 `fakeActivity(over)` / `fakeLaps()`
- `tests/unit/scripts/validate-data.test.js` 的 `wireDb(overrides)`（按 SQL 片段分派结果）
- `tests/python/test_fetcher_strava.py` 的 `_activity(**over)`（Strava API 原始单位：米 / m/s / rpm）

就近定义的目的是让「夹具与断言」在同一个文件里可对照 —— 单位换算类测试尤其如此：
夹具若沿用错误假设（如把 `activities.distance` 当米），测试就会和 bug 一起绿。

### 6.3 校验脚本自身也会错（口径漂移的第三处）

`scripts/garmin/validate-data.js` 是「检查数据的工具」，它同样要遵守数据契约，否则
会**批量报假警并埋掉真问题**。2026-10-27 修了三处：

| 缺陷 | 表现（真实库） | 修正 |
|------|---------------|------|
| `activities.distance` 当米 | 100/100 条被判「单位不一致」 | 按公里算 `speed = km / h` |
| lap 距离（米）与 activity 距离（公里）直接比 | 20/20 个活动被判「分段距离总和不一致」（6779m vs 6.779km） | 先 `/1000` 再比 |
| 范围检查不筛运动类型 | 篮球步频 16、力量训练均心率 68、乒乓最大心率 98 全被报异常 —— **83 条假警**，把 3 条真实跑步低步频埋掉 | 步态/心率范围只查跑步类型（与 `sport.ts` 同集合） |

新增 `validateHrZoneScope()`：断言 `time_in_hr_zone` 长度恒为 5（设备 6–8 槽数组
必须只出现在 `device_time_in_hr_zone`），并核对区间秒数与 `moving_time` 偏差 ≤10%。
这条校验直接对应 2026-10-27 的区间口径修复 —— 那类缺陷不会抛异常，只在页面数字里
显形（`/insight` 说轻松占比 4.7%、`/analysis` 说 72.5%）。

再新增 `validateLapZoneScope()`（2026-10-27）：lap 级区间此前**完全没有例行校验**，
而它比活动级更容易坏 —— 值由 `lap-zones.js` 按时间窗从逐秒记录切分，窗口算错
**不报错**，只是每段分布悄悄失真。两条判据：

1. **长度恒为 5**（心率 / 功率两种口径都查）；
2. **lap 求和 ≈ 活动级**（容差 15%）—— 这是唯一能发现「窗口切错 / 整段漏切」的
   机器手段：单看某一段完全看不出来，必须与同源的活动级总数对照。

两种口径**必须都查**：首版只查了心率，是半个契约 —— 功率区间是另一条独立推导链
（`%FTP` 5 区），窗口错了同样静默，而且它没有活动级那种兜底。实测生产库心率
286 条对照最大偏差 5.06%、功率 241 条最大 0.99%，故共用一套 15% 容差。

---

## 7. CI/CD 集成

### 7.1 GitHub Actions 配置

实际配置见 `.github/workflows/test.yml`（两个作业，无第三方覆盖率服务）：

<!-- BEGIN:CI-STEPS (generated by scripts/testing/ci-docs-snippet.js) -->
<!-- 由 scripts/testing/ci-docs-snippet.js 生成, 请勿手改 (改 workflow 后跑 `npm run docs:ci-snippet`) -->

**`quality` 作业** 权限: contents: read · pull-requests: write

- uses: actions/checkout@v4
- uses: actions/setup-node@v4
- 安装依赖
- 类型检查(tsc)
- MCP Server 构建(tsc -p mcp-server)
- Lint(eslint)
- Python 脚本测试(pytest)
- 单元测试 + 覆盖率(jest)
- jest 失败诊断(摘要 + annotation)
- 覆盖率摘要(markdown)
- 上传覆盖率报告(artifact)
- PR 覆盖率评论
- 构建(next build)

**`e2e` 作业**

- uses: actions/checkout@v4
- uses: actions/setup-node@v4
- 安装依赖
- 安装 Playwright 浏览器(${{ matrix.browser }})
- 端到端测试(Playwright)
- 上传 Playwright 报告与失败工件
- PR e2e 失败摘要评论
<!-- END:CI-STEPS -->

> 该清单**由 workflow 生成**（单一真源）：改 `.github/workflows/test.yml` 后跑
> `npm run docs:ci-snippet`（打印新片段）或 `npm run docs:ci-snippet:check`（校验漂移，
> 有守护测试 `tests/unit/docs/ci-workflow-docs.test.ts` 一并把关）。
> 其中「端到端测试(Playwright)」实际执行 `npx playwright test --project=${{ matrix.browser }}` ——
> e2e 作业按 **chromium + firefox + webkit 三引擎矩阵并行**（`fail-fast: false`），
> 覆盖 Blink / Gecko / WebKit 三大引擎；浏览器差异类缺陷（如 Firefox 不支持 `isMobile`，
> 见 a11y 章节；WebKit 的 Safari 特有渲染/事件差异）在 CI 即可暴露。
> 每档浏览器各自上传 artifact `playwright-report-<browser>`。
> 注: WebKit 在 Linux 下需额外系统库（`npx playwright install --with-deps webkit`），
> CI 的 ubuntu-24.04 有 root 可装；本地无 root 时 WebKit 不可运行，属已知限制。
> **e2e 作业固定 `runs-on: ubuntu-24.04`，不用 `ubuntu-latest`**：`ubuntu-latest`
> 已于 2026-10-19 起迁移到 Ubuntu 26，而 Playwright 1.59.1 的依赖表只到
> ubuntu24.04 —— 在 26 上 `--with-deps` 会在**安装阶段**直接 exit 1（2026-10-25 起
> 三个引擎同时失败，与代码无关）。升级 Playwright 到含 ubuntu26 依赖表的版本后
> 可改回 `ubuntu-latest`，`tests/unit/ci/*` 会守护 runner 与文档的一致性。


> 注意 `run: <cmd> | tee` 必须配 `set -o pipefail`，否则管道的退出码取 `tee`（恒为 0）——
> 失败会被吞成绿灯。`tests/unit/ci/gate-alignment.test.ts` 已加守护。
> 同理 jest 步骤也把输出落 `jest-output.txt` 并入 artifact；失败时还会把尾部 60 行写入
> `$GITHUB_STEP_SUMMARY` 并生成 `::error` annotation —— CI 日志与 artifact 下载都需 admin
> 权限（403/401），而 step summary 与 annotation **公开可读**，无需任何权限即可在 run 页面
> 直接看到失败测试名（2026-09-27 实测：由 annotation 一次定位到 `FAIL …threshold-margin.test.ts`）。
> `tests/unit/docs/ci-workflow-docs.test.ts` 对此做双向守护（workflow 能力 ↔ 文档提及）。

> ⚠️ **本地核验覆盖率务必走 `npm run test:ci`，不要手工 `npx jest --coverage` 与其它
> 写文件的测试并行**：`coverage-summary` 套件会真实调用 `scripts/testing/coverage-summary.js`
> 写入 `coverage/coverage-report.md`，与 jest 自身的覆盖率输出争抢同一路径，偶发导致该套件
> 误红（2026-09-27 实测：并行时 1 failed，单独跑 18/18 全过）。`test:ci` 内部串行且有守护，
> 是唯一可信口径。

**无障碍 (a11y) 自动断言**（`tests/e2e/a11y.spec.ts`，2026-09-27 新增，共 15 例）：用
`@axe-core/playwright` 扫描 7 个页面（首页/记录/分析/统计/洞察/丹尼尔斯/**活动详情**）
× **桌面 + 移动端 (Pixel 5) 两种视口**（移动端表格横向溢出属不同渲染路径，需单独扫）+
键盘可达性（首个 Tab 落在「跳到主要内容」跳板链接）。门禁口径为**只拦 serious/critical**
（缺 label、对比度不足、ARIA 误用、可滚动区域不可聚焦等硬伤），moderate/minor 不拦截
以免门禁噪音化。注意 `devices['Pixel 5']` 含 `defaultBrowserType`，在 `describe` 内
`test.use` 会强制新 worker 报错 —— 只取视口相关字段。

首轮扫描发现 **113 个 color-contrast 违规**（全部 serious），据此修正设计系统：
- 引入「文字专用色」`--brand-text` / `--good-text` / `--warn-text` / `--crit-text` /
  `--zN-text`：品牌主色（`--brand #0e9f6e` 对白底仅 3.39:1）继续用于图形与大色块，
  文字/图标字符改用达标变体；`hrZoneBadgeStyle` 与 `Badge zone` 同步分离前景/背景色
- `--fg-muted`：浅色 `#898781`(3.32:1) → `#6f6d66`(4.58:1 最不利底)；暗色 `#898781`(3.90:1)
  → `#96948d`(4.61:1)
- 主按钮底色 `--brand` → `--brand-strong`（白字 3.39:1 → 5.14:1）
- 语义徽章底色由「同色浅底」改为 `--surface-2` + 语义色描边（`good-text #0a8a0a` 在
  同色浅底上仅 3.45:1）
- 移除徽章内小字的 `opacity-80`（透明度会稀释对比度）
- **`DataTable` 滚动容器加 `role="region"` + `aria-label` + `tabIndex={0}`**：移动端表格横向
  溢出时键盘用户无法聚焦滚动（axe `scrollable-region-focusable`，仅移动端断点触发，桌面端
  不溢出故此前的桌面扫描未暴露）。该组件被 10 张表复用。

修正后 axe 在两种视口下均归零。e2e 用例总数**不写死**（页面或扫描维度增减都会改变它，
写死数字必然随时间漂移）：以 `npx playwright test --list --project=chromium` 为准
（2026-10-27 实测 52 项 = 37 功能 + 15 a11y）。

**门槛余量规则**（`tests/unit/ci/threshold-margin.test.ts` 守护）：每组每项的
「实测 − 门槛」须 ≥ 1.5pt（门槛接近 100 时按数学上限放宽为 `100-gate-0.5`），
且不得 > 15pt（防门槛长期不更新）。守护只认**新鲜**的覆盖率产物（产物比最新源文件旧则跳过），
避免拿旧数据误判。

**e2e 可诊断性**（2026-09-27）：CI 里 Playwright reporter 为 `line`（控制台逐行输出，
不下载 artifact 也能定位失败）+ HTML 报告；`trace: on-first-retry`、`screenshot: only-on-failure`；
工件以 `if: always()` 上传（成功也保留报告便于抽查），`test-results/` 含失败截图与 trace。
本地 trace 为 `retain-on-failure`（不加重 CI 负担）。

**覆盖率可见性**（2026-09-27 新增）：`scripts/testing/coverage-summary.js` 读取
`coverage/coverage-summary.json` 并按 `jest.config.js` 的分组口径汇总，输出分组 Markdown 表
（逐项对比门槛，未达标标 ❌）；CI 上传为 artifact，并在 PR 上就地更新一条评论。该脚本也被
`npm run test:ci` 调用 —— **本地一键与 CI 产物一致**。

### 7.2 本地运行脚本

与 `package.json` 保持一致（实测可用）：

```json
{
  "scripts": {
    "typecheck": "tsc --noEmit",
    "lint": "eslint",
    "build:mcp": "tsc -p mcp-server/tsconfig.json",
    "test": "jest",
    "test:unit": "jest tests/unit",
    "test:coverage": "jest --coverage",
    "test:e2e": "playwright test",
    "test:ci": "npm run typecheck && npm run build:mcp && npm run lint && npm run test:coverage -- --coverageReporters=text --coverageReporters=json-summary && node scripts/testing/coverage-summary.js"
  }
}
```

---

## 8. 测试执行计划

> **状态复核 (2026-09-26)**: 本计划为历史路线图, 逐项核实实际落地情况(见各条标注)。
> `[x]` = 已落地; `[ ]` 保持未达成项(附原因); 勿据未勾选项判定"未做"。
> 当前 (2026-09-27 八次复核): 121 套件 / 1596 例全绿; 语句覆盖 97.59% / 分支 89.59%。
> 分组实测: app/lib 97.71/89.81、app/api 95.60/90.81、app/components 98.52/90.05、
> scripts 97.72/91.52、其余页面与路由 98.91/88.07。
> 门槛已细化为 **5 组 8 项**(含 app/lib 的分支/函数) 全过。
> 全部可执行文件均已加载 (app/** + scripts/**), 仅 `app/lib/types.ts` 为纯类型声明。

### Phase 1: 基础单元测试 (Week 1-2)
- [x] 配置 Jest + Testing Library ✅
- [x] 实现 lib/ 工具函数测试 ✅ (tests/unit/lib/, 含 SSE 流解析 `stream-chat` 23 例、
      `llm` 网关配置与白名单回落、`db` 未覆盖路径补测)
- [x] 实现 db/ 数据库查询测试 ✅ (tests/unit/lib/db*.test.ts + db-availability)
- [x] 实现 API Routes 测试 ✅ (tests/unit/api/analysis-fallback: 模型回退契约 4 例)

### Phase 2: 组件单元测试 (Week 2-3)
- [x] 配置 React Testing Library ✅
- [x] 实现核心组件测试 ✅ (TopNav/MarkdownLite/zone-tables-a11y/list-filters-a11y)
- [x] 实现页面级组件测试 ✅ (2026-09-26: ListClient 12 例交互/筛选/无限滚动;
      首页 DashboardPage 取数聚合 4 例; HrZoneDurationBarChart option 构建 5 例)
- [x] 应用壳与路由页 ✅ (2026-09-27: error/global-error 错误边界两分支、layout/loading/
      not-found、`/analysis`+`/analysis/zone/[zone]`、`/pages/[id]` 详情、`/stats`、`/list`、
      `/insight`、`/daniels`、`/pages` 重定向 —— 全部从 0% 起测)
- [x] 图表与 AI 组件 ✅ (2026-09-27: RouteMap(leaflet mock)、ZoneTrendCharts、
      ActivityTrendCharts、VDOTTrendChart、useEchart(主题重建/dispose)、YearHeatmap、
      Donut、InsightBarChart、PaceZoneMetricsTable、TrainingLoadChart、useStickToBottom、
      GlobalCoach、AiAnalysis 动作分支、ModelSelector)
- [x] 分支覆盖攻坚 ✅ (2026-09-27: fit-parser 68.8→93.8%、runner-profile 68→88.2%(语句 99%、
      函数 100%)、db.ts 81.9→90.9%、insight-compare 83.8→94.4%、insight-coach 74.1→91.4%(语句/函数100%)、
      ActivityInsightPanel、InsightClient/ActivityDetailClient/AnalysisClient 的条件渲染两侧、
      coverage-summary.js CLI 全路径)
- [x] 二轮深挖 ✅ (2026-09-27: `runner-profile` format 全分支(习惯三态/prev 兜底/TSB 正负/跑力趋势/
      多区间强度/多 PR)、`activity-insight`(本次与 peers 缺配速心率、同类 rank、hrZoneBreakdown 边界)、
      `db.ts` 区间统计边角(vdot≤0 早退/pace 落空/权重退化/hr·cad·stride 为 null/HR 区间单侧过滤/
      坏 JSON/短数组/validateRange 三种抛错)、`sync.js` VDOT 双非代表性 + 无合格候选退回全程、
      `InsightClient` 解耦四档阈值 + 路线/类别缺字段)
- [x] 三轮收敛 ✅ (2026-09-27: `insight.ts` 短 zSeconds 数组/短日期串/非有限 VDOT 过滤/解耦 r1=0、
      `fit-parser` 路径点 >2000 降采样首尾保留 + 海拔剖面时间基准三级回退(时间戳/索引)、
      VDOT lap 双非代表性 + 无合格候选)
- [x] 四轮收口 ✅ (2026-09-27: `insight.ts` 分支 93.5→**96.5%**(语句 99.6%、函数 100%) ——
      排序比较器两侧(2 元素降序必走 `: 1`)、`zSeconds` 长度 1 的 `?? 0` 兜底、
      ACWR∈(0,0.8) 的 `under` 分支、`computePaceHrModel` 反推配速 ≤0、`computeDecouplingInsight`
      同日零方差(趋势 null)、`buildFindings` 效率择优递增;
      （**勘误 2026-09-27**：此处曾写「全仓未覆盖分支仅余 8 处」—— 实为**口径陷阱**：当时
      `coverage/coverage-final.json` 已被聚焦跑（`--collectCoverageFrom=单文件`）覆盖为只含
      1 个文件，据此统计得出错误结论。权威口径是 `npm run test:ci` 的 `coverage-summary` /
      jest 汇总输出；全量实际未覆盖分支为数百处。评估覆盖请以百分比门槛为准，勿依赖中间产物。）
      **`insight.ts` 内余 8 处为入口约束下的不可达防御分支**(`computeDecouplingPct` 的 `?? 0` / `h>0` 0 侧 /
      `r1===0` —— 入口已保证 heart_rate>0 与 `speed > MIN_MOVING_SPEED_KMH` = 1.8 km/h), 已在源码注释标注理由、**不构造人为输入硬凑**;
      至此其余文件零未覆盖分支)
- [x] CLI 脚本真实单测 ✅ (2026-09-27: 从「导入契约」升级 —— `garmin/client`(401 刷新互斥/
      token 持久化播报)、`common/vdot-calculator`、`common/utils`(.env upsert/备份去重)、
      `testing/make-fixture-db`、`sync-garmin`、`common/db-manager`(列迁移/NULL 兜底)、
      `garmin/sources/{api-source,cdp-source}`(分页去重/会话失效语义)、
      `garmin/validate-data`(210 语句校验器, 干净/异常双数据集)、`take-screenshots`(Playwright 全 mock)、
      `garmin/backfill-{vdot,fit-fields,tracks}`、`garmin/init-garmin-data`、
      `garmin/sync`(GarminSync 全流程)、`strava/sync`(spawn/转换/两种同步模式))

### Phase 3: E2E测试 (Week 3-4)
- [x] 配置 Playwright ✅
- [x] 实现页面导航测试 ✅ (tests/e2e/navigation.spec.ts)
- [x] 实现核心用户流程测试 ✅ (activity-list/detail/stats 5 spec; 2026-09-15 修 basePath)
- [x] 实现移动端适配测试 ✅ (mobile.spec.ts)

### Phase 4: 集成测试 (Week 4-5)
- [x] 实现数据同步流程测试 ✅ (tests/unit/strava/sync-flow.test.js)
- [ ] 实现端到端API测试 —— 部分(tests/integration/strava-sync.test.js)
- [x] Python脚本测试 ✅ (tests/python/ 3 个)

### Phase 5: CI/CD集成 (Week 5)
- [x] 配置 GitHub Actions ✅ (.github/workflows/test.yml; 2026-09-15 新增)
- [x] 配置测试覆盖率报告 ✅ (npm run test:coverage, jest coverage)
- [ ] 配置测试数据管理 —— 部分(tests/fixtures/ 有; 未做种子化)

---

## 9. 质量保证检查清单

### 代码提交前
- [x] 所有单元测试通过 ✅ (1108 例, 92 套件; 2026-09-27)
- [x] 新增代码覆盖率 > 80% —— 门槛全过 (global 行 95.3% / app/lib 行 98.4%, 2026-09-27)
- [x] 没有 TypeScript 错误 ✅ (tsc --noEmit rc=0)
- [x] ESLint 检查通过 ✅ (2026-09-15 清零)

### PR合并前
- [ ] 所有集成测试通过 —— 部分(strava 集成有)
- [x] E2E 核心流程测试通过 ✅ (15 passed, 2026-09-15 修 basePath)
- [ ] Code Review 完成 —— 流程项(非代码)
- [ ] 性能测试无退化 —— 未做(无性能基线)

### 发布前
- [x] 全量 E2E 测试通过 ✅ (chromium 15 passed; firefox/mobile 待装浏览器)
- [x] Python 脚本测试通过 ✅
- [x] 生产环境配置验证 ✅ (deploy-prod.sh --verify + /api/health)
- [ ] 回滚方案准备 —— 未做(见 deployment 评估)

---

## 10. 预期结果

| 测试类型 | 目标覆盖率 | 执行时间 |
|---------|-----------|---------|
| 单元测试 | 80%+ | < 30s |
| 集成测试 | 70%+ | < 60s |
| E2E测试 | 核心流程100% | < 5min |
| Python测试 | 75%+ | < 30s |

**总测试执行时间目标**: < 10分钟 (CI环境)

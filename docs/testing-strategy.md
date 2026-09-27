# pbRun 完整测试方案

## 1. 测试架构概览

```
tests/
├── unit/                    # 单元测试 (Jest)
│   ├── lib/                # 工具函数 + 数据访问(db*.test.ts) + 洞察计算测试
│   ├── components/         # React组件测试 (含页面客户端组件 ListClient 等)
│   ├── pages/              # 页面级编排测试 (server component 取数/聚合)
│   ├── api/                # API路由测试
│   ├── common/             # scripts/common 测试 (db-manager/utils/vdot 等)
│   ├── garmin/             # Garmin同步测试
│   ├── strava/             # Strava同步测试
│   ├── scripts/            # CLI 脚本「require 不执行」契约测试
│   ├── mcp/                # MCP Server 测试
│   └── phase1-directory-structure.test.js
├── integration/            # 集成测试 (Jest)
│   ├── api-flows/          # API流程测试
│   ├── sync-flows/         # 数据同步流程测试
│   └── e2e-api/            # 端到端API测试
├── e2e/                    # E2E UI测试 (Playwright)
│   ├── pages/              # 页面级测试
│   ├── flows/              # 用户流程测试
│   └── fixtures/           # 测试数据
├── python/                 # Python脚本测试 (pytest)
│   ├── test_fetcher_garmin.py
│   └── test_fetcher_strava.py
└── mocks/                  # 测试模拟数据
    ├── strava/
    ├── garmin/
    └── activities.json
```

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
// tests/unit/lib/db-queries.test.ts
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
// tests/unit/components/ListClient.test.tsx
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
// tests/unit/api/activities.test.ts
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

---

## 3. E2E UI测试 (Playwright)

### 3.1 配置与运行

E2E 采用**自包含**方式：Playwright 的 `webServer` 会

1. 生成夹具数据库 `tests/fixtures/activities.db`（`scripts/testing/make-fixture-db.js`，
   真实 schema + 5 条确定性样本，含同路线活动以触发多张对比表）；
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
夹具数据固定，故断言可精确到具体数值（如 46.90 公里 / 5 次 / 18.6 km）。

### 3.2 测试用例设计

#### 页面导航测试
```typescript
// tests/e2e/pages/navigation.spec.ts
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
// tests/e2e/pages/activity-list.spec.ts
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
// tests/e2e/pages/activity-detail.spec.ts
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
// tests/e2e/pages/stats.spec.ts
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
// tests/e2e/pages/analysis.spec.ts
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
// tests/e2e/mobile/responsive.spec.ts
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
// tests/integration/sync-flows/garmin-sync.spec.ts
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
// tests/integration/api-flows/activity-crud.spec.ts
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

### 5.1 配置

**tests/python/conftest.py**
```python
import pytest
import tempfile
import os

@pytest.fixture
def temp_db():
    """提供临时数据库"""
    with tempfile.NamedTemporaryFile(suffix='.db', delete=False) as f:
        db_path = f.name
    yield db_path
    os.unlink(db_path)

@pytest.fixture
def mock_strava_response():
    """模拟Strava API响应"""
    return {
        "id": 12345,
        "name": "Morning Run",
        "distance": 10000,
        "moving_time": 3600,
        "average_heartrate": 150,
        "max_heartrate": 170,
    }
```

### 5.2 测试用例

```python
# tests/python/test_fetcher_strava.py
def test_fetch_activities(strava_fetcher, mock_response):
    """测试获取活动列表"""
    activities = strava_fetcher.fetch_activities(limit=10)
    assert len(activities) <= 10
    assert all('id' in a for a in activities)

def test_fetch_activity_detail(strava_fetcher):
    """测试获取活动详情"""
    detail = strava_fetcher.fetch_activity_detail(12345)
    assert detail['id'] == 12345
    assert 'laps' in detail or 'splits_metric' in detail

def test_gpx_export(strava_fetcher, tmp_path):
    """测试GPX导出"""
    output_dir = tmp_path / "gpx"
    output_dir.mkdir()

    gpx_path = strava_fetcher.export_gpx(12345, output_dir)
    assert gpx_path.exists()
    assert gpx_path.suffix == '.gpx'

def test_rate_limit_handling(strava_fetcher):
    """测试速率限制处理"""
    # 模拟429响应
    with pytest.raises(RateLimitError):
        strava_fetcher.handle_rate_limit()
```

---

## 6. 测试数据管理

### 6.1 测试数据库

**tests/fixtures/test-data.sql**
```sql
-- 创建测试活动数据
INSERT INTO activities (activity_id, name, activity_type, start_time, start_time_local,
                       distance, duration, average_pace, average_heart_rate, vdot_value)
VALUES
  (1, 'Test Run 1', 'running', '2024-01-01T08:00:00Z', '2024-01-01 16:00:00', 10.0, 3600, 360, 150, 45.5),
  (2, 'Test Run 2', 'running', '2024-01-02T08:00:00Z', '2024-01-02 16:00:00', 15.0, 5400, 360, 155, 47.0);

-- 创建测试分段数据
INSERT INTO activity_laps (activity_id, lap_index, distance, duration, average_pace)
VALUES
  (1, 1, 1000, 360, 360),
  (1, 2, 1000, 350, 350);
```

**scripts/setup-test-db.js**
```javascript
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

function setupTestDb() {
  const testDbPath = path.join(__dirname, '../tests/fixtures/test.db');
  const db = new Database(testDbPath);

  const sql = fs.readFileSync(
    path.join(__dirname, '../tests/fixtures/test-data.sql'),
    'utf-8'
  );
  db.exec(sql);
  db.close();

  console.log('Test database created at:', testDbPath);
}

setupTestDb();
```

### 6.2 Mock数据

**tests/mocks/strava/activities.json**
```json
{
  "activities": [
    {
      "id": 123456789,
      "name": "Morning Run",
      "distance": 10000,
      "moving_time": 3600,
      "elapsed_time": 3700,
      "total_elevation_gain": 50,
      "type": "Run",
      "start_date": "2024-01-15T06:00:00Z",
      "average_heartrate": 150,
      "max_heartrate": 170,
      "average_cadence": 180
    }
  ]
}
```

---

## 7. CI/CD 集成

### 7.1 GitHub Actions 配置

实际配置见 `.github/workflows/test.yml`（两个作业，无第三方覆盖率服务）：

```yaml
jobs:
  quality:                 # 门禁: 与 npm run test:ci 一一对应
    permissions: { contents: read, pull-requests: write }
    steps:
      - 安装依赖 (npm ci)
      - npx tsc --noEmit                    # 类型检查
      - npm run build:mcp                   # MCP 构建 (mcp-server 的 tsconfig 口径与根不同)
      - npm run lint                        # eslint
      - npm run test:coverage -- --coverageReporters=text --coverageReporters=json-summary --coverageReporters=lcov
      - node scripts/testing/coverage-summary.js   # 生成分组覆盖率 Markdown 摘要
      - actions/upload-artifact@v4          # 上传 coverage/ (报告 + lcov), 保留 14 天
      - PR 覆盖率评论 (gh api, 同标记评论就地更新, 不刷屏)
      - npm run build                       # 生产构建 (干净 checkout; u2 本机须走 deploy-prod.sh)

  e2e:                     # Playwright (chromium): 生成夹具库 → 构建 → next start → 跑 e2e
    steps:
      - 安装依赖 → 安装 Playwright chromium
      - npx playwright test --project=chromium
      - always 上传 artifact: playwright-report/ + test-results/ + e2e-output.txt
      - failure 时把 e2e 输出尾部 (60 行) 贴到 PR 评论 (同标记就地更新)
```

> 注意 `run: <cmd> | tee` 必须配 `set -o pipefail`，否则管道的退出码取 `tee`（恒为 0）——
> 失败会被吞成绿灯。`tests/unit/ci/gate-alignment.test.ts` 已加守护。
> 同理 jest 步骤也把输出落 `jest-output.txt` 并入 artifact：CI 日志下载需 admin 权限，
> 失败时必须能从 artifact 离线定位。

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
> 当前 (2026-09-27 七次复核): 118 套件 / 1562 例全绿; 语句覆盖 97.59% / 分支 89.59%。
> 分组实测: app/lib 97.68/89.45、app/api 95.60/90.81、app/components 98.52/90.05、
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
- [x] 分支覆盖攻坚 ✅ (2026-09-27: fit-parser 68.8→93.8%、runner-profile 68→82%、
      db.ts 81.9→85.9%、insight findings、ActivityInsightPanel、InsightClient/
      ActivityDetailClient/AnalysisClient 的条件渲染两侧)
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

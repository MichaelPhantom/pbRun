# 更新日志

本文件记录项目的重要变更。格式参考 [Keep a Changelog](https://keepachangelog.com/)，
版本遵循 [语义化版本](https://semver.org/)。

## [Unreleased]

### Added
- **无障碍 (a11y) e2e 断言** `tests/e2e/a11y.spec.ts`（15 例）：`@axe-core/playwright` 扫描
  7 个页面（含活动详情）× 桌面 + 移动端 (Pixel 5) 两种视口 + 键盘可达性（首个 Tab 落在
  跳板链接）；只拦 serious/critical（避免噪音化门禁）。首轮扫描暴露 113 个 color-contrast
  违规，扩展移动端后暴露 `scrollable-region-focusable` → 见下「无障碍修复」。
- **CI 步骤清单由 workflow 生成**：`scripts/testing/ci-docs-snippet.js` 从
  `.github/workflows/test.yml` 提取作业/步骤/权限，生成 `docs/testing-strategy.md` 7.1 的清单
  （标记块 `<!-- BEGIN:CI-STEPS -->`）；`npm run docs:ci-snippet[:check]` 打印或校验漂移，
  单测（8 例）与双向守护一并把关 —— 手抄漂移从「靠自觉」变成「可测事实」。

- **文档↔workflow 双向守护** `tests/unit/docs/ci-workflow-docs.test.ts`：13 项关键能力
  （类型检查/MCP 构建/覆盖率报告与评论/pipefail/失败诊断/artifact…）必须同时出现在
  `.github/workflows/test.yml` 与文档中；并断言 7.1 不残留历史遗迹（codecov/python-tests/
  node 20/develop 分支）、引用的脚本路径真实存在、权限声明一致。上线即抓到「失败诊断
  (step summary/annotation)」未写入文档并补齐。

- **单测 838 → 1522 例（65 → 116 套件）**：把 0% 覆盖的应用壳与页面（`error`/`global-error`
  两个错误边界分支、`layout`/`loading`/`not-found`、`/analysis`(+`AnalysisClient`)、
  `/analysis/zone/[zone]`、`/pages/[id]`(+`ActivityDetailClient`)、`/stats`(+`StatsClient`)、
  `/list`、`/insight`、`/daniels`、`/pages` 重定向）与图表/AI 组件（`RouteMap`、`ZoneTrendCharts`、
  `ActivityTrendCharts`、`VDOTTrendChart`、`useEchart`、`YearHeatmap`、`Donut`、`InsightBarChart`、
  `PaceZoneMetricsTable`、`TrainingLoadChart`、`useStickToBottom`、`GlobalCoach`、`AiAnalysis`
  动作分支、`ModelSelector`）补上单测；CLI 脚本从「导入契约」升级为**单片真实单测**
  （`garmin/client` 的 401 刷新互斥与 token 持久化播报、`vdot-calculator`、`common/utils`
  的 `.env` upsert 与备份去重、`make-fixture-db`、`sync-garmin`）。
  覆盖率：**global 语句 73.7 → 97.6% / 函数 72.4 → 97.5% / 分支 63.0 → 89.6%，
  `app/lib/` 语句 83.4 → 97.7%、分支 89.0%**。至此 `app/**` 与 `scripts/**` 的**全部可执行
  文件均已被测试加载**（仅 `app/lib/types.ts` 为纯类型声明）。
  第二批补齐（同日）: `AiAnalysis` 动作分支、`ModelSelector`、`useModelCatalog`、
  `app/lib/db` 未覆盖路径、`coach-stream` 失败语义、各 API 路由校验分支、
  `echarts-theme`/`StatsClient`/`ZoneTrendCharts` 等小组件，以及脚本侧
  `common/db-manager`、`garmin/sources/{api-source,cdp-source}`、
  `garmin/validate-data`（此前从未加载的 481 行校验器）、`take-screenshots`（Playwright 全 mock）。
- **单测 817 → 838 例（65 套件）**：`ListClient` 交互/筛选/无限滚动 12 例、
  首页 `DashboardPage` 取数与聚合 4 例（server component 直调 + mock db）、
  `HrZoneDurationBarChart` option 构建/tooltip/生命周期 5 例，
  以及 CLI 脚本「require 不执行」契约 3 例（子进程验证，见下）。
- **覆盖率门槛口径说明**：写入 `jest.config.js` 注释与 `docs/testing-strategy.md` ——
  命中 `./app/lib/` 路径分组的文件只归属该分组、不计入 `global`
  （`global` 实为「除 app/lib 外的全部 `collectCoverageFrom` 文件」），
  未被加载的文件分子分母均不计。此前配置里的旧注释口径有误，已更正。
- **训练洞察（动态）**：新增 `/insight` 菜单与页面，所有指标请求时实时计算（无缓存表）。
  含跑力 VDOT 趋势、训练负荷与周期（ACWR + 强度分布 + CTL/ATL/TSB）、有氧解耦、
  跑姿技术趋势、配速-心率回归模型，以及**训练类别对比 / 气温影响对比 / 常跑路线对比 / 周期化分析**。
  结论由 `findings` 引擎动态生成（严重度分级 + 可执行建议）。
- **全局 AI 综合教练**：`POST /api/insight/coach`，基于【跑者画像 + 全局洞察指标】的
  跨全部历史综合诊断（SSE 流式、模型回退、多轮追问）。
- **活动详情深挖**：`GET /api/activities/[id]/insight` + 详情页「深度分析」面板，
  含分段角色识别（热身/主课/恢复/冷身）、主课心率漂移、心率区间占比、逐秒解耦、
  同路线/同距离历史对比（配速排名 + 差值）。
- 标准工程文件：`CONTRIBUTING.md`、`SECURITY.md`、`CHANGELOG.md`、`.editorconfig`、
  `.nvmrc`、`.github/dependabot.yml`。
- e2e 夹具库生成器 `scripts/testing/make-fixture-db.js` 与 CI 的 `e2e` 作业（Playwright）。
- **e2e 内容断言**：新增 `tests/e2e/tables.spec.ts`（10 张数据表的结构/内容/单行不换行/行高亮）
  与 `tests/e2e/helpers/tables.ts`；夹具扩充至 5 条样本（含同路线）以触发多张对比表；
  重写 `activity-list`/`activity-detail`/`stats`/`navigation`/`mobile` 规格为真实内容断言。
  e2e 用例 19 → 36。
- `npm run typecheck` / `npm run test:ci` 脚本；`package.json` 增加 `engines.node >= 22`。
- **运维手册 `docs/ops.md`**：本机生产环境（systemd + Nginx `/pbrun/`）的服务管理与
  健康检查、构建陷阱（`app/data` 越界软链、单元 cgroup 1.5G 内存限额导致
  `next build`/大文件传输被 `Killed` → 用 `systemd-run --user --scope` 绕开）、
  磁盘清理白/黑名单（`.next/cache` 等可删、`.cache/fit` 等禁删）、数据库备份保留
  策略，以及 OCI 对象存储异地副本（`cft-backup/u1rescue-20260914/` 归档、校验恢复
  与免费额度说明）。FAQ 新增 #15/#16；修复 deployment.md 一处失效锚点。
- **API 文档补全 + 路由覆盖守护**：`docs/api-reference.md` 新增 15/16/17 三节
 （活动 AI 深度分析 SSE、健康检查、可用模型列表——此前只散落在 README/insight/faq），
 目录加锚点；新增 `tests/unit/docs/api-route-coverage.test.ts` 三向守护（README 覆盖
 每个 `route.ts`、api-reference ∪ insight 覆盖每个路由、api-reference 引用的
 `/api/` 路径必须真实存在，`[id]`/`{id}`/数字示例 id 归一比对），防文档虚构端点
  或新端点无文档。已用「注入幻影端点」突变验证守护会红灯。
- **文档 ↔ 现实一致性守护 `tests/unit/docs/docs-reality.test.ts`**：四断言——文档中
  `npm run <script>` 必须存在于 `package.json`、`*.yml`/`*.yaml` 文件名必须真实存在于
  仓库、`docs/*.md` 交叉引用必须存在、`docs/README.md` 索引必须覆盖 `docs/` 全部
  markdown。`docs/testing-strategy.md` 因含规划中的配置示例列入白名单（文件内注释说明）。

### Added
- **无障碍 (a11y) e2e 断言** `tests/e2e/a11y.spec.ts`（15 例）：`@axe-core/playwright` 扫描
  7 个页面（含活动详情）× 桌面 + 移动端 (Pixel 5) 两种视口 + 键盘可达性（首个 Tab 落在
  跳板链接）；只拦 serious/critical（避免噪音化门禁）。首轮扫描暴露 113 个 color-contrast
  违规，扩展移动端后暴露 `scrollable-region-focusable` → 见下「无障碍修复」。
- **CI 步骤清单由 workflow 生成**：`scripts/testing/ci-docs-snippet.js` 从
  `.github/workflows/test.yml` 提取作业/步骤/权限，生成 `docs/testing-strategy.md` 7.1 的清单
  （标记块 `<!-- BEGIN:CI-STEPS -->`）；`npm run docs:ci-snippet[:check]` 打印或校验漂移，
  单测（8 例）与双向守护一并把关 —— 手抄漂移从「靠自觉」变成「可测事实」。

- **文档↔workflow 双向守护** `tests/unit/docs/ci-workflow-docs.test.ts`：13 项关键能力
  （类型检查/MCP 构建/覆盖率报告与评论/pipefail/失败诊断/artifact…）必须同时出现在
  `.github/workflows/test.yml` 与文档中；并断言 7.1 不残留历史遗迹（codecov/python-tests/
  node 20/develop 分支）、引用的脚本路径真实存在、权限声明一致。上线即抓到「失败诊断
  (step summary/annotation)」未写入文档并补齐。

- **覆盖率可见性管线（本地 = CI）**：新增 `scripts/testing/coverage-summary.js` —— 读取
  `coverage/coverage-summary.json`，按 `jest.config.js` 的分组口径汇总成 Markdown 表
  （逐项对比门槛，未达标标 ❌），本地由 `npm run test:ci` 生成 `coverage/coverage-report.md`；
  CI 中作为 artifact 上传（14 天）并在 PR 上就地更新一条评论（同标记评论复用，不刷屏）。
  该脚本自身有 8 例单测（阈值解析、最窄分组命中、汇总、达标/未达标渲染）。
- **文档↔门槛一致性守护** `tests/unit/docs/coverage-threshold-docs.test.ts`：门槛数值散落在
  `jest.config.js` 与 `docs/testing-strategy.md` / `CHANGELOG.md`，本测试逐组逐项比对，
  改一处忘同步即红灯（已实测：故意改错文档数字会失败）。

### Added
- **无障碍 (a11y) e2e 断言** `tests/e2e/a11y.spec.ts`（15 例）：`@axe-core/playwright` 扫描
  7 个页面（含活动详情）× 桌面 + 移动端 (Pixel 5) 两种视口 + 键盘可达性（首个 Tab 落在
  跳板链接）；只拦 serious/critical（避免噪音化门禁）。首轮扫描暴露 113 个 color-contrast
  违规，扩展移动端后暴露 `scrollable-region-focusable` → 见下「无障碍修复」。
- **CI 步骤清单由 workflow 生成**：`scripts/testing/ci-docs-snippet.js` 从
  `.github/workflows/test.yml` 提取作业/步骤/权限，生成 `docs/testing-strategy.md` 7.1 的清单
  （标记块 `<!-- BEGIN:CI-STEPS -->`）；`npm run docs:ci-snippet[:check]` 打印或校验漂移，
  单测（8 例）与双向守护一并把关 —— 手抄漂移从「靠自觉」变成「可测事实」。

- **文档↔workflow 双向守护** `tests/unit/docs/ci-workflow-docs.test.ts`：13 项关键能力
  （类型检查/MCP 构建/覆盖率报告与评论/pipefail/失败诊断/artifact…）必须同时出现在
  `.github/workflows/test.yml` 与文档中；并断言 7.1 不残留历史遗迹（codecov/python-tests/
  node 20/develop 分支）、引用的脚本路径真实存在、权限声明一致。上线即抓到「失败诊断
  (step summary/annotation)」未写入文档并补齐。

- **门槛余量规则守护** `tests/unit/ci/threshold-margin.test.ts`：在存在覆盖率产物时校验
  「实测 − 门槛 ≥ 1.5pt」（门槛接近 100 时按数学上限 `100-gate-0.5` 放宽），并反向检查
  「余量 > 15pt」防门槛长期不更新；无产物则显式跳过（CI 的 `npm test` 不带 --coverage）。
  该守护上线即抓到 3 处过紧门槛（app/lib functions 97→96、lines 98→97；
  app/components branches 89→88），避免重演「本地绿、CI 红」。守护只接受**新鲜**产物
  （产物早于最新源文件即跳过），避免拿旧数据误判。
- **CI 失败可即时定位（无需任何权限）**：jest 步骤输出落 `jest-output.txt` 并入 artifact，
  且失败时把尾部 60 行写入 `$GITHUB_STEP_SUMMARY`、并用 `::error` 生成 annotation ——
  本轮 CI 红灯即由 annotation 一眼定位到 `FAIL tests/unit/ci/threshold-margin.test.ts`。
- **e2e 失败摘要入 PR 评论**：CI 的 e2e 步骤用 `set -o pipefail` + `tee e2e-output.txt`
  （否则 tee 会把失败吞成绿灯），失败时把输出尾部 60 行贴到 PR（同标记就地更新），
  `e2e-output.txt` 一并入库 artifact。
- **e2e 可诊断性**：CI 的 Playwright reporter 改为 `line`（控制台逐行定位失败）+ HTML 报告；
  工件改为 `if: always()` 上传 `playwright-report/` 与 `test-results/`（截图 / trace / 失败摘要），
  `if-no-files-found: ignore` 避免无工件时报错；`trace` 在 CI 为 `on-first-retry`、
  本地为 `retain-on-failure`。`tests/unit/ci/gate-alignment.test.ts` 增加守护，防止产物被静默移除。

### Changed
- **二轮分支覆盖深挖**：`app/lib/runner-profile.ts` 分支 82.0→88.2%（语句 99.0%、函数 100%）、
  `app/lib/db.ts` 81.9→90.9%、新增 `tests/unit/lib/db-zones-samples.test.ts`（区间统计与样本读取
  的 12 条边角）、`tests/unit/scripts/garmin-sync.test.js` +2（VDOT 双非代表性 / 无合格候选）、
  `tests/unit/components/insight-components.test.tsx` +2（解耦四档阈值 / 缺字段不崩）。
  全量 `test:ci` rc=0：123 套件 / 1631 例，5 组 8 项门槛全过。
- **三轮收敛**：`app/lib/insight.ts` +4（短 zSeconds 数组按缺失补 0 / `dayOrdinal` 短日期串 /
  `computeVdotTrend` 过滤 null·Infinity·NaN / 解耦 r1=0 防除零）、
  `scripts/garmin/fit-parser.js` +2（路径点 >2000 等步幅降采样保留首尾且不重复末点 /
  海拔剖面在无 elapsed_time 时用时间戳差、两者皆无用索引）、`sync.js` VDOT 无合格候选。
  至此**全仓未覆盖分支仅剩 `app/lib/insight.ts` 15 处（93.5%）**，其余文件零未覆盖分支。
- **四轮收口**：`app/lib/insight.ts` 分支 93.5→**96.5%**（语句 99.6%、函数 100%）——
  +6 例（排序比较器两侧 / `zSeconds` 长度 1 的 `?? 0` / ACWR∈(0,0.8) / 反推配速 ≤0 /
  同日零方差趋势 null / 效率择优递增）；余 8 处为入口约束下的**不可达防御分支**
  （`computeDecouplingPct` 内 `?? 0`、`h>0` 的 0 侧、`r1===0`），已在源码注释标注理由并**不硬凑**。
  全仓其余文件零未覆盖分支；`test:ci` rc=0（123 套件 / 1646 例）。
  全量 `test:ci` rc=0：123 套件 / 1638 例，5 组 8 项门槛全过。

- **e2e 作业改为浏览器矩阵（chromium + firefox 并行）**：`fail-fast: false`，各档独立上传
  `playwright-report-<browser>`；本地 firefox 实测 51 项全过（3.2m）。矩阵化能发现浏览器差异类
  缺陷 —— 本轮即在 firefox 下暴露 `isMobile` 不受支持（见 Fixed），并据此把移动端 a11y 的
  模拟方式从 `isMobile` 改为纯 viewport（两引擎通用，响应式断点由宽度触发）。

- **CLI 脚本可被 require 而不执行**：`backfill-vdot` / `backfill-fit-fields` / `backfill-tracks` /
  `init-garmin-data` / `take-screenshots` / `make-fixture-db` / `sync-garmin` 统一改为
  `if (require.main === module)` 守卫 + 导出可测入口（`main` / `makeFixtureDb` / `run`），
  消除「一 require 就同步真库 / 开浏览器 / 写夹具」的副作用；CLI 直跑行为不变
  （`node scripts/...`、`npm run init:cn`、`fixture:db` 均已实测）。
- **覆盖率门槛提升（防回归）**：`global` branches 58 → 61、functions 68 → 70
  （statements 72 / lines 73 维持）；`./app/lib/` 维持 82 / 84。当前实测：
  global 73.69% / 63.01% / 72.41% / 74.81%，app/lib 83.41% / 85.51%，6 项全过。
- **全站表格统一**：新增 `app/components/ui/DataTable`（对齐「分段数据」表风格：居中、紧凑、
  单位副标题、单行不换行、`overflow-x-auto` 移动端兼容），并将全部 10 张数据表迁移至该组件
  （活动详情分段表/同路线对比、分析页心率/配速区间表、洞察页 4 张表）。
- **活动详情页**：分段角色并入「分段数据」表，消除与「深度分析」的重复分段表（详见下）。
- **同路线对比表**：重做为分段表风格，新增「类别」「vs 本次」列与组均/组最佳/同类对标。
- **VDOT 模型常量统一为单一真源** `app/lib/vdot-constants.json`（TS 展示与 JS 同步脚本共用），
  消除此前两处常量分叉导致的配速区间/入库 VDOT 口径不一致。
- **`npm run test:ci` 补齐 `build:mcp`**：与 CI `quality` 作业前 4 步逐字对齐
 （`typecheck` → `build:mcp` → `lint` → 测试+覆盖率）。此前漏了 MCP 构建，本地绿灯而 CI
 在第 6 步红灯（`mcp-server/tsconfig.json` 的 `lib` 无 DOM，与根 tsconfig 口径不同）。
 `CONTRIBUTING.md` 同步更正：门禁步骤与 `test:ci` 一一对应、覆盖率门槛改为指向
 `jest.config.js` 单一真源、`npm run build` 在 u2 生产机须走 `scripts/deploy-prod.sh`。
- jest 增加 `coverageThreshold`（`global` + `./app/lib/` 分组两组下限，数值的单一真源是
  `jest.config.js`，文档不另抄数字以免漂移），防止覆盖率回归。
- **`npm run test:ci` 补齐覆盖率摘要步骤**：与 CI `quality` 作业的步骤逐条对齐（含覆盖率
  报告与摘要生成），`tests/unit/ci/gate-alignment.test.ts` 同步扩展守护（命令带参数 ` -- `
  时按主命令比对），确保「本地一键 = CI」持续为真。
- **覆盖率门槛细化为 5 组 8 项逐目录防回归**：`global` 72/61/70/73 → … → **96/86/95/97**，
  `./app/lib/` → **96/87/96/97**（新增分支与函数两项），并新增 `./app/api/` **94/89/99**、
  `./app/components/` **97/88/99**、`./scripts/` **95/88/93**。
  余量规则：每组每项至少留 ~1.5pt —— 2026-09-27 曾把 `global` branches 设成实测 88.07 的
  **88**（余量 0.07pt），CI 直接红灯（本地绿、CI 红）；已下调至 86 并写入配置注释与文档。
  细化当场暴露了「其余页面/路由」组分支仅 84.9% 的隐藏弱项 —— 补 InsightClient/
  ActivityDetailClient/AnalysisClient 条件渲染两侧后达 88.07%, 全局分支 84.9% → 88.8%。
- **两处可测性小改造（行为不变）**：`scripts/garmin/sync.js` 把 zip.js 动态 `import()` 抽为
  模块级 `zipModuleLoader` + `__setZipModuleLoader` 注入点（jest 默认 vm 环境无法执行被测
  代码里的 `import()`）；`scripts/strava/sync.js` 导出 `parseArgs` / `main`（与 garmin 侧导出
  风格一致），使 CLI 参数解析与退出码可单测。改造后 ZIP 解包三分支与 CLI 分支均被覆盖。同时 `jest.config.js` 增加样式
  `moduleNameMapper` stub，使 `app/layout.tsx`（import `globals.css`）可被单测加载。
- 洞察页/文档同步：新增 `docs/insight.md`，更新 `README.md`、`docs/api-reference.md`、
  `docs/README.md`、`docs/deployment.md`。

- **AI 教练模型选择收敛为固定白名单 + 首字节看门狗**：`app/lib/model-curation.ts`
  由「网关 298 项自动策展」改为人工白名单（默认 `deepseek-v4.1-flash-wb`，可选
  `glm-5.3-flash` / `kimi-k3` / `gemini-3.7-flash` / `gemini-3.5-flash-lite`，
  `auto` 仅作服务端回退目标），`resolveRequestedModel` 在打网关前把非法 id 清洗为
  默认模型；新增共享出流层 `app/lib/coach-stream.ts`（响应头 120s + **首字节 90s
  看门狗** → 中断卡死渠道并回退 `auto`、客户端断开传播、`X-Model-*` 契约头、统一
  错误 JSON），活动分析与全局教练两条路由改为薄封装；前端 `ModelSelector` 扁平化
  （默认徽标/🧠/不可用置灰）、`useModelCatalog` 把失效旧选择迁回默认、`AiAnalysis`
  复用共享 `streamChat`（删除重复 SSE 解析）。thinking/effort 以 2026-09-26 网关
  A/B 实测为准（仅 `glm-5.3-flash` 下发 `reasoning_effort`）。FAQ 新增 #17。

### Fixed
- **eslint 未忽略 e2e 产物目录** → 本地跑完 `npm run e2e` 后 `npm run lint` 爆 **185 errors**
  （`playwright-report/trace/` 内含打包后的第三方 JS）；CI 因干净 checkout 不触发，只有开发者会踩。
  `globalIgnores` 补齐 `playwright-report/**`、`test-results/**`，并在 `gate-alignment` 加守护
  （产物目录必须同时被 .gitignore 与 eslint 忽略）。
- **移动端可滚动区域不可键盘聚焦**（axe `scrollable-region-focusable`）：`DataTable` 的
  `overflow-x-auto` 容器无焦点，移动端表格横向溢出时键盘用户无法看到右侧列。已加
  `role="region"` + `aria-label={caption}` + `tabIndex={0}`（该组件被 10 张表复用）。
  仅移动端断点触发 —— 说明「单视口 a11y 扫描」会漏掉响应式布局类问题。
- **无障碍：对比度全线达标（axe serious 归零）**：引入文字专用色
  `--brand-text/--good-text/--warn-text/--crit-text/--zN-text`（主色继续用于图形/色块）；
  `--fg-muted` 浅色 `#898781`→`#6f6d66`、暗色 `#898781`→`#96948d`；主按钮底
  `--brand`→`--brand-strong`；语义徽章底色改 `--surface-2` + 语义色描边；
  移除徽章内小字的 `opacity-80`（透明度稀释对比度）。
- **`threshold-margin` 守护在 CI 崩整套件**：`actuals()` 原在模块顶层求值 —— `describe.skip`
  也会执行顶层代码，而 CI 的 `--coverage` 只创建 `coverage/` 目录、测试结束前不写
  `coverage-summary.json` → `ENOENT` 直接 fail 整套件（本地因残留产物而绿，属典型
  环境差异假绿）。已改为：`actuals()` 内增加存在性守卫、`isFresh()` 统一判断，
  并在 `gate-alignment` 加守护（禁止顶层求值该产物）。

- **两处文档仍引用早已改名的工作流文件**：`docs/README.md` 树状图与 `docs/deployment.md`
  Q7 写的是 `sync_garmin_data.yml`（实际为 `.github/workflows/sync_running_data.yml`），
  且 Q7 示例频率与现状不符（实际 `0 */8 * * *`，每 8 小时）。已改名并对齐频率说明，
  由 docs-reality 守护防复发。
- **`useStickToBottom` 的「回到底部」按钮曾是死代码**（由新增单测发现）：滚动监听写在
  `useEffect(..., [])` 内并读取 `ref.current`，而消息区是条件渲染的 —— 首屏无内容时
  `ref.current` 为 `null`，监听器此后**永不挂载**，`isAtBottom` 恒为 `true`。
  改为 callback ref + `setEl` 状态、监听 effect 依赖 `[el]`，元素挂载后再绑定；
  现有「回到底部」浮层随之恢复正常（`AiAnalysis`、`GlobalCoach` 共用该 hook）。
- **`api-source` 的 `sleepMs: 0` 无法关闭限速**（本轮补测发现，未改实现）：构造函数用
  `options.sleepMs || 500`，显式传 0 会被判为缺省而变成 500ms（`batchSize: 0` 同理）。
  当前以用例固化该行为；若要支持「关闭限速」应改用 `??`，届时用例会失败提醒同步。
- **`take-screenshots` 的可选页失败不计入统计**（同上，未改实现）：optional 页失败只打日志、
  既不 +success 也不 +fail，`失败: N 个` 仅统计必选页抛错。以用例固化现状。
- **`docs/testing-strategy.md` 第 7 章 CI 配置示例与实际不符**（示例里写着 `develop` 分支、
  node 20、`codecov/codecov-action@v3`、`python-tests` 作业、以及错误的 npm scripts）——
  已按 `.github/workflows/test.yml` 与 `package.json` 实况重写 7.1/7.2。
- **`scripts/testing/coverage-summary.js` 的分组匹配对 `./` 前缀失配**（初版把 `./app/lib/`
  与相对路径 `app/lib/x.ts` 直接比对，永远落到 global）—— 已在比较前归一化前缀，并由单测锁定。
- **两处统计口径现状**（本轮补测发现并固化用例, 未改实现）：`getTrainingLoads` 只校验
  `YYYY-MM-DD` 形态而不校验日历合法性（`2026-13-01` 不报错）；`computeLoadInsight` 的强度
  分布与轻松占比直接用原始区间秒数（负值会得出负百分比），仅总量分母过滤负值。
- **`sync_running_data.yml` 从未真正「跳过」过**：job 级 `if` 不允许 `secrets` 上下文，
  原 `if: ${{ secrets.STRAVA_CLIENT_ID != '' || ... }}` 使 workflow 校验直接失败——每次
  push 都显示红叉、0 个 job，而注释声称「未配置 secrets 时跳过」。改为 `preflight` 预检
  作业（step 级 env 读 secrets → 写 output），`sync` 据 `needs` 跳过，运行结论恢复 success。
- `GET /api/llm/models` 增加 try/catch，异常时返回 `{ error }` + 500（此前无错误处理）。
- 补齐此前零覆盖的 API 路由测试（laps / vdot-trend / health / llm-models）与服务层测试。

## 历史

早期开发（AI 教练体系、数据同步健壮性、可访问性、VDOT 重构等）见 `git log`。

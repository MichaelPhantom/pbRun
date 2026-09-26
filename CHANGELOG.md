# 更新日志

本文件记录项目的重要变更。格式参考 [Keep a Changelog](https://keepachangelog.com/)，
版本遵循 [语义化版本](https://semver.org/)。

## [Unreleased]

### Added
- **单测 838 → 1225 例（65 → 104 套件）**：把 0% 覆盖的应用壳与页面（`error`/`global-error`
  两个错误边界分支、`layout`/`loading`/`not-found`、`/analysis`(+`AnalysisClient`)、
  `/analysis/zone/[zone]`、`/pages/[id]`(+`ActivityDetailClient`)、`/stats`(+`StatsClient`)、
  `/list`、`/insight`、`/daniels`、`/pages` 重定向）与图表/AI 组件（`RouteMap`、`ZoneTrendCharts`、
  `ActivityTrendCharts`、`VDOTTrendChart`、`useEchart`、`YearHeatmap`、`Donut`、`InsightBarChart`、
  `PaceZoneMetricsTable`、`TrainingLoadChart`、`useStickToBottom`、`GlobalCoach`、`AiAnalysis`
  动作分支、`ModelSelector`）补上单测；CLI 脚本从「导入契约」升级为**单片真实单测**
  （`garmin/client` 的 401 刷新互斥与 token 持久化播报、`vdot-calculator`、`common/utils`
  的 `.env` upsert 与备份去重、`make-fixture-db`、`sync-garmin`）。
  覆盖率：**global 语句 73.7 → 95.8% / 函数 72.4 → 97.4% / 分支 63.0 → 82.8% / 行 97.2%，
  `app/lib/` 语句 83.4 → 97.0%、行 98.7%**。
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

### Changed
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
- **覆盖率门槛随实测两次提升**：`global` 72/61/70/73 → 91/78/92/93 → **94/81/95/95**，
  `./app/lib/` 82/84 → 94/96 → **95/97**（贴近实测下方留 ~2pt 余量：global 实测
  95.80/82.80/97.37/97.23，app/lib 97.01/98.65）。同时 `jest.config.js` 增加样式
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
- **`sync_running_data.yml` 从未真正「跳过」过**：job 级 `if` 不允许 `secrets` 上下文，
  原 `if: ${{ secrets.STRAVA_CLIENT_ID != '' || ... }}` 使 workflow 校验直接失败——每次
  push 都显示红叉、0 个 job，而注释声称「未配置 secrets 时跳过」。改为 `preflight` 预检
  作业（step 级 env 读 secrets → 写 output），`sync` 据 `needs` 跳过，运行结论恢复 success。
- `GET /api/llm/models` 增加 try/catch，异常时返回 `{ error }` + 500（此前无错误处理）。
- 补齐此前零覆盖的 API 路由测试（laps / vdot-trend / health / llm-models）与服务层测试。

## 历史

早期开发（AI 教练体系、数据同步健壮性、可访问性、VDOT 重构等）见 `git log`。

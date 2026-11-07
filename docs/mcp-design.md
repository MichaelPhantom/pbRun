# pbRun MCP Server 设计方案

> 为 AI 客户端（Claude Desktop / opencode 等）提供结构化跑步数据访问能力
> 状态: 已实施 (2026-08-08), 20 个 tools (含类型清单 + 路线轨迹 + 年度里程 + 当次可比样本 + 功率区间
> + 力量训练画像/负荷, 2026-11 新增)

## 1. 架构

```
┌──────────────┐    stdio (本地)     ┌─────────────────────┐
│  AI Client   │ ◄──────────────────►│  pbRun MCP Server   │
│  (opencode)  │                     │  @mc/sdk + sqlite3  │
└──────────────┘                     │  → activities.db    │
                                     │  (readonly)         │
┌──────────────┐    写 (cron)        └─────────────────────┘
│ cft/garmin   │ ───────────────────► activities.db
│ sync_cn_daily│
└──────────────┘                     ┌─────────────────────┐
                                     │  pbRun Next.js      │
┌──────────────┐    HTTP (:3996)     │  → activities.db    │
│  浏览器用户   │ ───────────────────►│  (readonly)         │
└──────────────┘                     └─────────────────────┘
```

- **传输**: stdio (本地 AI 客户端直连, 无需端口/认证)
- **DB**: 共享 `app/data/activities.db`, readonly 模式, 与 Next.js + cron 写入无冲突 (SQLite WAL)
- **依赖复用**: 直接 import `app/lib/{db,types,vdot-pace}.ts` (三个模块均无 Next.js 依赖)

## 2. 目录结构

```
pbRun/
├── mcp-server/
│   ├── index.ts              # MCP server 入口 (stdio transport)
│   ├── tools.ts              # 20 个 tool 定义与 handler
│   ├── analysis.ts           # 纯逻辑 (降采样/ACWR/跨期对比, 可单测)
│   ├── tsconfig.json         # 独立编译配置 (module node16, 输出 dist/)
│   ├── dist/                 # 编译产物 (已 .gitignore)
│   └── README.md             # 构建/运行/配置说明
└── app/lib/
    ├── db.ts                 # 直接复用 (新增 getPeriodStats/getTrainingLoads/getLatestVdot)
    ├── types.ts              # 直接复用 (新增 PeriodStats/TrainingLoadPoint)
    └── vdot-pace.ts          # 直接复用
```

> 部署: 无 systemd unit — stdio 进程由 AI 客户端按需拉起 (见 §6.1)。

## 3. Tools 清单 (20 个)

### 3.1 基础数据 (复用 db.ts, 15 个)

> **口径**：`list_activities` 是**全类型**（活动日志）；`get_month_summaries` 是**双口径同行**
> （`runDistance`/`runCount` 只跑步，`totalDistance`/`count` 全类型），其余统计类工具均为
> **跑步口径**（只含 `running` / `track_running` / `treadmill_running`），
> 见 `docs/features.md` §1.1。MCP 直接复用 `app/lib/db.ts`，与 Web 端完全同源，
> 不存在「MCP 数据比页面多」的口径漂移。
>
> **口径必须写进 tool description**，不能只写在本文档里：MCP 是 LLM 的唯一数据入口，
> 若 description 不声明口径，模型会把「游泳/篮球不计入」的统计当成全部运动的总量来
> 解读（例如看到 `totalDistance` 只含跑步，却推断「用户几乎不运动」）。这类缺陷不报错、
> 不让测试变红，只在模型输出里显形。`tests/unit/mcp/tool-scope-contract.test.ts`
> 逐项断言：10 个表现分析工具必须含「跑步口径」、3 个活动日志工具必须含「全类型口径」、
> 1 个合并口径工具必须同时声明「负荷合并 + 里程/次数只统计跑步」、2 个力量工具必须声明
> 数据边界（无重量/次数）、3 个活动日志工具必须声明 **distance 三态**（`null` 缺失 /
> `0` 无语义 / `>0` 正常）**且声明游泳的秒/100m 换算**（`average_pace ÷ 10` 只对秒/公里
> 成立，`average_speed` 是 km/h 要 `360 ÷ 速度`），且所有 20 个工具都有非空
> title/description。

| Tool | db.ts 函数 | 参数 | 输出 | 说明 |
|------|-----------|------|------|------|
| `list_activities` | `getActivities` | `limit`(1-100), `offset`, `type?`, `startDate?`, `endDate?` | `{data: Activity[], total: number}` | 活动列表 (**全类型口径**), 支持 limit 上限 100 (防 token 爆炸); `distance` **三态**（`null` 缺失 / `0` 无距离语义 / `>0` 正常） |
| `get_activity` | `getActivityById` | `activityId` | `Activity \| null` | 单条活动完整指标; `distance` **三态** |
| `get_activity_laps` | `getActivityLaps` | `activityId` | `{laps: ActivityLap[]}` | 分段数据; `distance`（米）**三态**; 游泳 lap 的秒/100m = `average_pace ÷ 10`（休息段为 null） |
| `get_activity_records` | `getActivityRecords` + 采样 | `activityId`, `samplingInterval?`(默认1), `maxPoints?`(默认500) | `{records: ActivityRecord[], total_original, sampled}` | 逐秒记录, 支持降采样 |
| `get_stats` | `getStats` | `period`(week/month/year/total) | `StatsResponse` | 汇总统计 (跑步口径) |
| `get_personal_records` | `getPersonalRecords` | `period` | `PersonalRecordsResponse` | PB (1.6K~全马, 跑步口径) |
| `get_vdot_history` | `getVDOTHistory` | `limit`(1-100) | `VDOTDataPoint[]` | 跑力历史 (跑步口径) |
| `get_vdot_trend` | `getVDOTTrend` | `startDate?`, `endDate?`, `groupBy` | `VDOTTrendPoint[]` | 跑力趋势 (周/月聚合) |
| `get_hr_zone_analysis` | `getHrZoneStats` | `startDate?`, `endDate?`, `groupBy` | `{data, zoneRanges, summary}` | 心率区间分析 (跑步口径) |
| `get_pace_zone_analysis` | `getPaceZoneStats` | `startDate`, `endDate`, `vdot?`(auto=取最新) | `PaceZoneStat[]` | 配速区间分析 (跑步口径) |
| `get_power_zone_analysis` | `getPowerZoneStats` | `startDate`, `endDate` | `{zones, reference, ranges, boundsLabel}` | 功率区间分析 (**%FTP 五区**, 按各活动自身 FTP 归区; 跑步口径) |
| `get_month_summaries` | `getMonthSummaries` | `limit?`, `offset?`, `type?`, `q?` | `MonthSummary[]` | 月度汇总 (**双口径同行**): `runDistance`/`runCount` 只跑步, `totalDistance`/`count` 全类型, `typeBreakdown` 给出各类型条数（降序）, `totalDuration` 全类型时长（秒, 计时器口径）; 可按类型/名称跨月过滤。**非跑步类型 `distance` 恒为 0, 读训练量要看 `totalDuration`** |
| `get_activity_types` | `getActivityTypes` | 无 | `{type, count}[]` | 全库运动类型清单 (**全类型口径**, 与 Web 记录页下拉同源); 按类型筛选前先调它拿到真实类型键 |
| `get_activity_track` | `getActivityTrack` | `activityId` | `{track: ActivityTrack \| null}` | 路线轨迹 (降采样 GPS+海拔+包围盒); 室内为 null |
| `get_daily_distances` | `getDailyDistances` | `year?`(默认当前年) | `{date, km}[]` | 年度每日里程 (热力图/连续性, 跑步口径) |

### 3.2 AI 专用 (新增, 3 个)

#### `get_activity_comparables` — 当次横向可比样本

输入 `activityId`，输出单次活动的：
- `running`：是否跑步口径（`isRunningType(activity_type)`）。为 `false` 时
  `averagePaceSecPerKm` 恒为 `null`，`insight` 里的配速派生字段（`bestPaceSecPerKm` /
  `workAvgPaceSecPerKm` / `bestLapIndex`）与 `gradeAdjusted` 也已置空 ——
  这些量的分母是「每公里」，对游泳/球类/力量训练没有可比语义；
- `insight`：分段角色/主课漂移/心率区间/逐秒解耦/同路线对比/环境可比性；
- `contextText`：可直接注入 LLM prompt 的【本次表现与可比样本】文本块。

与 Web 端活动 AI 使用同一套 `activity-insight-service` / `activity-coach-context-service`，
避免 MCP 与页面口径漂移。非跑步活动的分段角色改按**相对心率**识别强度段
（游泳 lap 常无 `average_pace`，按配速会让所有段落进 `steady`）。

#### `compare_periods` — 跨期对比

```typescript
input: {
  periodA: { startDate: string, endDate: string },
  periodB: { startDate: string, endDate: string }
}
output: {
  periodA: { totalDistance, totalDuration, totalActivities, avgPace, avgVDOT, totalTrainingLoad },
  periodB: { ... },
  delta: {
    distance_pct: number,      // B 相对 A 的变化率
    duration_pct: number,
    avg_pace_diff: number,     // 秒/km, 负值=变快
    vdot_diff: number,
    training_load_pct: number
  }
}
```

#### `get_training_load_analysis` — 训练负荷分析

```typescript
input: { days: number }  // 默认 28
output: {
  total_load: number,
  avg_daily_load: number,
  acute_load: number,          // 近 7 天负荷**总量** (与主站 LoadInsight.acute 同口径)
  chronic_load: number,        // 近 28 天**周均**负荷 (总量 ÷ 4, 与主站 chronic 同口径)
  chronic_load_days: number,   // 慢性窗实际覆盖天数 (< 28 = 历史不足, acwr 为 null)
  acwr: number | null,         // 急慢性负荷比; 训练历史不足 28 天时为 **null**
  consecutive_rest_days: number,
  consecutive_training_days: number,
  recommendation: string,      // 如 "ACWR=1.4, 负荷偏高, 建议安排 1-2 天恢复"
  daily: { date, load, distance, duration }[]
}
```

**ACWR 判定标准**（窗口恒为定长标准窗: 急性 7 天 / 慢性 28 天, 与分析窗 `days` 无关）:
- < 0.8: 欠训练 (detraining)
- 0.8–1.3: 最佳区间 (sweet spot)
- 1.3–1.5: 警戒区 (elevated risk)
- > 1.5: 危险区 (high injury risk)
- **null**: 训练历史不足 28 天 —— 缺失天数不按 0 负荷处理（否则 chronic 被压小、
  ACWR 虚高）。旧实现 `min(28, days)` 在 `days=7` 时急/慢窗重合, ACWR 恒 1.0
  （永远「最佳区间」）—— 已废弃, 见 tests/unit/mcp/analysis.test.ts。

## 3.3 力量训练工具 (2 个, 2026-11 新增)

> **背景**：生产库 51 条 `strength_training` 此前「收录了但零分析语义」——不进训练负荷、
> 没有结构化画像。`sync.js` 的 `calculateTrainingLoad` 派生分支只对跑步三类型开放，
> 于是 51 条力量课的 `training_load` 全为 NULL，每周 2 次力量课对 ACWR/CTL/TSB 的
> 贡献恒为 0。这是教练视角的盲区：身体不区分负荷来源。

| Tool | db.ts 函数 | 参数 | 输出 | 说明 |
|------|-----------|------|------|------|
| `get_strength_sessions` | `getStrengthSessions` | `limit`(1-100, 默认20), `offset`, `startDate?`, `endDate?` | `{data: StrengthSession[], total, returned, limit, offset}` | 结构化画像: 计划名/有效组数/工作休息比/结构类型/强度域/训练效应/恢复建议/派生负荷 |
| `get_strength_loads` | `getStrengthLoads` | `startDate`, `endDate` | `{date, load, duration, sessions, workingSets}[]` | 按本地日期聚合的力量负荷 |

### 数据边界（实测，不可越界）

| 想拿 | 可得性 | 依据 |
|---|---|---|
| 动作名（深蹲/卧推） | ❌ | FIT 里没有 `set` 消息；Garmin 只在云端 `exerciseSets` 提供 |
| 重量 / 次数 | ❌ | 同上（51 条本地 FIT 实测 `set`/`exercise_title` 消息数为 0） |
| 训练计划名 | ✅ 49/51 | `activities.workout_name`（如「全身循环1」「核心稳定性1」） |
| 组结构（active/rest 交替） | ✅ 49/51 | `activities.workout_steps` JSON（每步 `duration_sec` + `intensity`） |
| 时长 / 平均心率 / 卡路里 | ✅ 51/51 | 平铺列 |
| 训练效应 (TE) | ✅ 51/51 | `total_training_effect` / `total_anaerobic_training_effect` |
| 官方恢复建议 | ✅ 51/51 | `recovery_time`（**分钟**） |

两个工具**不返回**「组数 × 重量」这类容量字段 —— 硬造就是假数据。输出的是
「计划名 + 有效组数 + 工作/休息时长比 + 强度域」这套真实可推导的画像。

### 负荷口径

`时长(h) × 100 × 域系数`，域系数按**训练效应**加权（`app/lib/strength.ts` 单一真源）：
`high 1.5 / tempo 1.3 / base 1.0 / recovery 0.6 / unknown 0.8`。

- **强度域判定**：TE ≥3.5 high / ≥2.5 tempo / ≥1.5 base / >0 recovery；TE 缺失回退心率
  <100 recovery、<130 base、否则 tempo。
- **不复用跑步 HR-TRIMP 的理由**：力量心率响应滞后且峰值低（真实库 51 条平均心率
  73–129），套 Z1 系数 0.6 会让负荷趋近于零。
- **量纲**：与库内跑步 `training_load` 同量纲，但**不是** Garmin 官方
  `training_load_peak`（后者与库内值比值 1.2–2.6 倍浮动、不可换算）。

### 合并口径（`get_training_load_analysis`）

| 字段 | 规则 | 理由 |
|---|---|---|
| `load` | **相加** | 力量训练也是负荷，ACWR/CTL/TSB 必须看见它 |
| `distance` | 只取跑步 | 力量训练无距离语义（真实库 51/51 为 0） |
| `duration` | **只取跑步** | 该字段喂「当月均配速」（Σduration/Σdistance），混入力量时长会把配速拖慢（实测 369 → 989 s/km 量级） |
| `runs` | 只取跑步 | 「跑步次数」标签语义；力量课不该被算作跑步 |

真实库验证：近 28 天 ACWR 1.40 → 1.32（慢性 227.25 → 242.25），而
`distance`/`duration`/`runs` 偏差全为 0（口径零污染）。

消费方必须全部走合并入口：首页 `/`、分析页 `/analysis`、洞察页 `/insight`
（`insight-service`）、跑者画像、本工具 `get_training_load_analysis`。
漏一个就分叉（洞察页曾漏接 → 同一时期洞察页 ACWR 1.40 / 首页 1.32），
由 `tests/unit/lib/insight-services.test.ts` 守护。

### 双实现一致性守护

`scripts/garmin/sync.js` 是纯 CJS（不经 tsc），无法 import TS。故
`scripts/common/strength-load.js` 逐行镜像 `app/lib/strength.ts`，由
`tests/unit/lib/strength-sync-parity.test.ts` 穷举比对（12×12 TE×HR、11×5 时长×域、
7×7 时间基数）。任一侧改阈值而另一侧没跟上 → 红灯。没有它，同步写入的
`training_load` 会与页面/MCP 展示的负荷分叉，且**不会报错、不会让任何测试变红**。

## 4. 数据单位约定

> ⚠️ activities.distance 在 DB 中存储为 **公里**, activity_laps.distance 为 **米**
> db.ts 已在各函数中统一转换为米返回

| 字段 | 单位 | 说明 |
|------|------|------|
| `Activity.distance` | 公里 | db.ts 返回原始 DB 值 |
| `ActivityLap.distance` | 米 | |
| `StatsResponse.totalDistance` | 米 | db.ts 已转换 |
| `VDOTTrendPoint.total_distance` | 米 | db.ts 已转换 |
| `average_pace` | 秒/公里 | |
| `average_cadence` | 步/分钟 | |
| `average_stride_length` | 米 | |
| `total_ascent` | 米 | |
| `training_load` | 无单位 | Garmin 训练负荷值 |

## 5. 环境变量

| 变量 | 默认值 | 用途 |
|------|--------|------|
| `DB_PATH` | `cwd()/app/data/activities.db` | SQLite 文件路径 |
| `MAX_HR` | `190` (代码 fallback, 与 db.ts 一致) | 心率区间计算 (Z1-Z5); 生产配置 `194` |

## 6. 部署

### 6.1 部署方式: 无需 systemd

stdio 传输的 MCP server **不需要 systemd 常驻管理**:

- 进程由 AI 客户端 (opencode) 按需拉起 (`command` 启动), 生命周期与客户端绑定;
  客户端退出 → stdin EOF → 进程优雅关闭 SQLite 连接后自行退出。
- 常驻 unit 反而无意义: 无客户端连接时进程空转 (stdin 已是 EOF), 且会与客户端直接拉起的
  实例同时打开 DB。

自检/验证 (与 opencode 调用等价):

```bash
DB_PATH=/home/ubuntu/project/pbRun/app/data/activities.db MAX_HR=194 \
  node mcp-server/dist/mcp-server/index.js
```

> 仅当未来部署 §6.3 的远程 SSE 访问 (端口 3997, 常驻 HTTP 服务) 时才需要 systemd unit。

### 6.2 AI 客户端配置 (opencode)

```jsonc
// ~/.config/opencode/opencode.jsonc → mcp 字段 (已生效, 重启 opencode 后加载)
"pbRun": {
  "type": "local",
  "command": ["node", "/home/ubuntu/project/pbRun/mcp-server/dist/mcp-server/index.js"],
  "env": {
    "DB_PATH": "/home/ubuntu/project/pbRun/app/data/activities.db",
    "MAX_HR": "194"
  },
  "enabled": true
}
```

### 6.3 远程访问 (可选, 未来扩展)

如需远程 AI 客户端访问:
- 分配端口 **3997** (39xx 段, 紧邻 pbRun 3996)
- 仅监听 127.0.0.1, 经 Nginx `/pbrun-mcp` 反代 + Basic Auth
- 使用 SSE transport 替代 stdio

## 7. 实施记录

| 阶段 | 内容 | 状态 |
|------|------|------|
| 1 | 创建 mcp-server/ 骨架, tsconfig, 安装 @modelcontextprotocol/sdk | ✅ 2026-08-08 (SDK 1.30 + zod 4) |
| 2 | 实现 13 个基础 tools (含 track + daily-distances) (直接映射 db.ts 函数) | ✅ |
| 3 | 实现 records 采样逻辑 (samplingInterval + maxPoints 双参数) | ✅ |
| 4 | 实现 compare_periods (db.ts 新增 getPeriodStats) | ✅ |
| 5 | 实现 get_training_load_analysis (db.ts 新增 getTrainingLoads, ACWR) | ✅ |
| 6 | opencode 配置 (已写入 ~/.config/opencode); 确认无需 systemd (stdio 由客户端拉起) | ✅ |
| 7 | 端到端验证 (stdio 客户端逐一调用 20 个 tool) | ✅ 全部通过 |
| 8 | 打磨: 纯逻辑抽离 analysis.ts (可单测)、结构化错误、日期校验、优雅退出 | ✅ |
| 9 | 单元测试: db 新函数 10 例 + analysis 纯逻辑 18 例 | ✅ 全部通过 |
| 10 | 修复 format.ts locale 脆弱性 (toLocaleDateString → 确定性 YYYY/MM/DD) | ✅ 全量测试 271 通过 |
| 11 | 数据完整性契约: records 降采样含首末点 + truncated 标志; vdot_history 翻页 (offset) + total 元数据; 各工具 description 明示截断/取全量方式; README 契约表 | ✅ 全量测试 276 通过 |

构建: `npm run build:mcp` (tsc -p mcp-server) → `mcp-server/dist/`
测试: `npm test -- tests/unit/lib/db-mcp.test.ts tests/unit/mcp/analysis.test.ts`
说明: 当前 tool 数为 20 (15 基础 + 3 AI + 2 力量训练)。历史笔误记录: 早期设计文档写 "12 个", 实际 16。
注意: `next build` 时勿设置 `NODE_ENV=development` (Next 16 已知 bug 会使 /_global-error
prerender 崩溃, vercel/next.js#85668 等); 正常构建 (不设或 NODE_ENV=production) 无此问题。

## 8. 安全考量

- DB readonly: MCP server 以 `readonly: true` 打开 SQLite, 无写入风险
- 本地 stdio: 无端口暴露, 无需认证 (物理隔离)
- 参数校验: 所有 tool 参数用 JSON Schema 校验, limit 上限 100 防大查询
- 无 SQL 注入: db.ts 全部使用参数化查询
- records 采样: 563K 条记录按需降采样, 防 token 爆炸

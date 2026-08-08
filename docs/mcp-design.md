# pbRun MCP Server 设计方案

> 为 AI 客户端（Claude Desktop / opencode 等）提供结构化跑步数据访问能力
> 状态: 已实施 (2026-08-08), 13 个 tools

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
│   ├── tools.ts              # 13 个 tool 定义与 handler
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

## 3. Tools 清单 (13 个)

### 3.1 基础数据 (复用 db.ts, 11 个)

| Tool | db.ts 函数 | 参数 | 输出 | 说明 |
|------|-----------|------|------|------|
| `list_activities` | `getActivities` | `limit`(1-100), `offset`, `type?`, `startDate?`, `endDate?` | `{data: Activity[], total: number}` | 活动列表, 支持 limit 上限 100 (防 token 爆炸) |
| `get_activity` | `getActivityById` | `activityId` | `Activity \| null` | 单条活动完整指标 |
| `get_activity_laps` | `getActivityLaps` | `activityId` | `{laps: ActivityLap[]}` | 分段数据 |
| `get_activity_records` | `getActivityRecords` + 采样 | `activityId`, `samplingInterval?`(默认1), `maxPoints?`(默认500) | `{records: ActivityRecord[], total_original, sampled}` | 逐秒记录, 支持降采样 |
| `get_stats` | `getStats` | `period`(week/month/year/total) | `StatsResponse` | 汇总统计 |
| `get_personal_records` | `getPersonalRecords` | `period` | `PersonalRecordsResponse` | PB (1.6K~全马) |
| `get_vdot_history` | `getVDOTHistory` | `limit`(1-100) | `VDOTDataPoint[]` | 跑力历史 |
| `get_vdot_trend` | `getVDOTTrend` | `startDate?`, `endDate?`, `groupBy` | `VDOTTrendPoint[]` | 跑力趋势 (周/月聚合) |
| `get_hr_zone_analysis` | `getHrZoneStats` | `startDate?`, `endDate?`, `groupBy` | `{data, zoneRanges, summary}` | 心率区间分析 |
| `get_pace_zone_analysis` | `getPaceZoneStats` | `startDate`, `endDate`, `vdot?`(auto=取最新) | `PaceZoneStat[]` | 配速区间分析 |
| `get_month_summaries` | `getMonthSummaries` | `limit?`, `offset?` | `MonthSummary[]` | 月度汇总 |

### 3.2 AI 专用 (新增, 2 个)

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
  acute_load: number,          // 近 7 天负荷
  chronic_load: number,        // 近 28 天负荷
  acwr: number,                // 急慢性负荷比 (Acute:Chronic Workload Ratio)
  consecutive_rest_days: number,
  consecutive_training_days: number,
  recommendation: string,      // 如 "ACWR=1.4, 负荷偏高, 建议安排 1-2 天恢复"
  daily: { date, load, distance, duration }[]
}
```

**ACWR 判定标准**:
- < 0.8: 欠训练 (detraining)
- 0.8–1.3: 最佳区间 (sweet spot)
- 1.3–1.5: 警戒区 (elevated risk)
- > 1.5: 危险区 (high injury risk)

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
| 2 | 实现 11 个基础 tools (直接映射 db.ts 函数) | ✅ |
| 3 | 实现 records 采样逻辑 (samplingInterval + maxPoints 双参数) | ✅ |
| 4 | 实现 compare_periods (db.ts 新增 getPeriodStats) | ✅ |
| 5 | 实现 get_training_load_analysis (db.ts 新增 getTrainingLoads, ACWR) | ✅ |
| 6 | opencode 配置 (已写入 ~/.config/opencode); 确认无需 systemd (stdio 由客户端拉起) | ✅ |
| 7 | 端到端验证 (stdio 客户端逐一调用 13 个 tool) | ✅ 全部通过 |
| 8 | 打磨: 纯逻辑抽离 analysis.ts (可单测)、结构化错误、日期校验、优雅退出 | ✅ |
| 9 | 单元测试: db 新函数 10 例 + analysis 纯逻辑 18 例 | ✅ 全部通过 |

构建: `npm run build:mcp` (tsc -p mcp-server) → `mcp-server/dist/`
测试: `npm test -- tests/unit/lib/db-mcp.test.ts tests/unit/mcp/analysis.test.ts`
说明: 实际 tool 数为 13 (11 基础 + 2 AI), 设计文档原 "12 个" 为笔误。
注意: `/_global-error` 页面在 `next build` 时存在既有 prerender 失败 (React useContext), 与 MCP 无关。
注意: tests/unit/lib/format.test.ts 有 2 例既有 locale 相关失败 (环境无关代码)。

## 8. 安全考量

- DB readonly: MCP server 以 `readonly: true` 打开 SQLite, 无写入风险
- 本地 stdio: 无端口暴露, 无需认证 (物理隔离)
- 参数校验: 所有 tool 参数用 JSON Schema 校验, limit 上限 100 防大查询
- 无 SQL 注入: db.ts 全部使用参数化查询
- records 采样: 563K 条记录按需降采样, 防 token 爆炸

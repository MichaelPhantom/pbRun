# pbRun MCP Server

为 AI 客户端 (opencode / Claude Desktop 等) 提供结构化跑步数据访问能力。

- **传输**: stdio (本地 AI 客户端直连, 无端口/认证)
- **DB**: 只读访问 `app/data/activities.db` (SQLite WAL, 与 Next.js + cron 写入无冲突)
- **依赖复用**: 直接 import `app/lib/{db,types,vdot-pace}.ts` (无 Next.js 依赖)
- **目录**: `index.ts` 入口 / `tools.ts` 13 个 tool / `analysis.ts` 纯逻辑 (可单测)

## 构建与运行

```bash
npm run build:mcp                 # tsc -p mcp-server → mcp-server/dist/
node mcp-server/dist/mcp-server/index.js
```

环境变量:

| 变量 | 默认值 | 用途 |
|------|--------|------|
| `DB_PATH` | `<cwd>/app/data/activities.db` | SQLite 文件路径 |
| `MAX_HR` | `190` (与 db.ts 一致; 生产建议 `194`) | 心率区间计算 (Z1-Z5) |

进程生命周期: 由 AI 客户端 (opencode / hermes) 按需拉起, 客户端退出 → stdin EOF → 优雅关闭 SQLite
连接后自行退出; 无需 systemd 常驻管理。

## 响应格式

所有 tool 返回 JSON 文本。成功: 数据对象; 失败: `isError: true` 且
`{"error": {"message": "..."}}` (参数校验失败由 MCP SDK 直接返回协议级错误)。

## 测试

```bash
npm test -- tests/unit/lib/db-mcp.test.ts tests/unit/mcp/analysis.test.ts
```

- `tests/unit/lib/db-mcp.test.ts` — db.ts 新增查询函数 (mock better-sqlite3)
- `tests/unit/mcp/analysis.test.ts` — 降采样 / 日期 / 心率区间 / 跨期对比 / ACWR 纯逻辑

## 工具清单 (13 个)

基础数据 (11 个, 复用 db.ts): `list_activities`, `get_activity`, `get_activity_laps`,
`get_activity_records` (支持降采样), `get_stats`, `get_personal_records`, `get_vdot_history`,
`get_vdot_trend`, `get_hr_zone_analysis`, `get_pace_zone_analysis`, `get_month_summaries`

AI 专用 (2 个): `compare_periods` (跨期对比), `get_training_load_analysis` (ACWR 训练负荷分析)

## 数据完整性契约 (重要)

部分接口受默认上限约束, 返回的是**子集**而非全量。使用方 (LLM) 必须识别
"未取全量" 的信号, 需要全量时显式翻页 / 提高上限。聚合类接口 (统计/区间/
跨期/负荷) 内部始终基于全量计算, 无此问题。

| 接口 | 上限 | 识别信号 | 取全量方式 |
|------|------|----------|-----------|
| `list_activities` | 默认每页 20 条 | `pagination.total` 为总数, 对比 `data.length` | `offset` 翻页 (limit 最大 100) |
| `get_activity_records` | 默认最多 500 点, 超出**自动等距采样** (含首末点) | `truncated: true` (元数据 `total_original`/`sampled`/`step`) | `maxPoints` ≥ 活动时长秒数 (上限 5000, 如 60 分钟跑传 3600) |
| `get_vdot_history` | 默认最近 50 条 | `total` 为总条数, 对比 `returned` | `offset` 翻页 (limit 最大 100) |
| `get_month_summaries` | 默认最近 12 个月 | 返回月份数 < 期望范围 | `limit`/`offset` 扩展 (最大 100) |

规则: 调用方每次都要检查元数据 (pagination.total / total / truncated) 判断是否
取满; `get_activity_records` 的 `step > 1` 或 `truncated: true` 表示已非秒级全量,
基于其计算最大心率/极值时必须提高 `maxPoints`。

## 数据单位约定

| 字段 | 单位 |
|------|------|
| `Activity.distance` | 公里 (db.ts 原始值) |
| `ActivityLap.distance` / `get_activity_records` / 统计接口 distance | 米 |
| `average_pace` | 秒/公里 |
| 时长 | 秒 |
| `total_ascent` / `average_stride_length` | 米 |
| `training_load` | 无单位 (Garmin 训练负荷) |

## opencode 配置

```jsonc
// ~/.config/opencode/opencode.jsonc → mcp 字段
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

## Hermes (本机 agent gateway) 配置

```bash
# ~/.hermes/hermes-agent/venv/bin/python -m hermes_cli.main mcp add pbRun \
#   --command node \
#   --args /home/ubuntu/project/pbRun/mcp-server/dist/mcp-server/index.js \
#   --env DB_PATH=/home/ubuntu/project/pbRun/app/data/activities.db MAX_HR=194
# 注意: --args 之后的参数全部归 args, --env 需放在 --args 之前 (否则 env 会被吞进 args)
```

写入 `~/.hermes/config.yaml` 的 `mcp_servers:` 段 (推荐格式):

```yaml
mcp_servers:
  pbRun:
    command: node
    args:
      - /home/ubuntu/project/pbRun/mcp-server/dist/mcp-server/index.js
    env:
      DB_PATH: /home/ubuntu/project/pbRun/app/data/activities.db
      MAX_HR: '194'
    enabled: true
```

新会话自动加载; 验证: `hermes mcp test pbRun` (应显示 `Connected` + 13 tools)。

## 重新构建 (代码变更后)

```bash
npm run build:mcp
```

构建产物在 `mcp-server/dist/` (已被 .gitignore 排除, 不入库)。

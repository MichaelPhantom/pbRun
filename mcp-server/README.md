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

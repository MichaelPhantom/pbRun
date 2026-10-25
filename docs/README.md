# pbRun 文档中心

欢迎来到 pbRun 的文档中心。这里按**功能接口**提供完整的使用指南与技术文档。

## 快速导航

### 新手入门

1. **[快速开始](../README.md#快速开始)** - 5 分钟快速上手
2. **[部署指南](deployment.md)** - 部署到 Vercel
3. **[数据同步说明](data-sync.md)** - 配置 Garmin 数据同步

### 核心文档

- **[功能接口总览](features.md)** - 按功能/接口组织的功能矩阵、AI 上下文契约与待办
- **[运维手册](ops.md)** - 本机生产环境：构建陷阱、磁盘清理、备份与异地副本
- **[API 接口文档](api-reference.md)** - 完整的 API 参考
- **[训练洞察与 AI 教练](insight.md)** - 动态洞察指标与 AI 教练体系
- **[VDOT 计算说明](vdot-calculation.md)** - 跑力计算原理和使用
- **[常见问题](faq.md)** - 常见问题解答

---

## 文档列表

### 📖 使用指南

| 文档 | 说明 |
|------|------|
| [部署指南](deployment.md) | 如何部署到 Vercel 和配置 GitHub Actions |
| [运维手册](ops.md) | 服务器部署的服务管理、构建陷阱、磁盘清理与备份 |
| [数据同步说明](data-sync.md) | Garmin 数据同步原理和配置方法 |
| [常见问题](faq.md) | 常见问题和故障排查 |

### 📚 技术文档

| 文档 | 说明 |
|------|------|
| [功能接口总览](features.md) | 按功能/接口组织的矩阵、AI 上下文契约、已知边界与待办 |
| [API 接口文档](api-reference.md) | 完整的 RESTful API 参考 |
| [训练洞察与 AI 教练](insight.md) | 动态洞察指标体系 + AI 教练体系 (活动级/全局) |
| [VDOT 计算说明](vdot-calculation.md) | VDOT 跑力计算公式和训练建议 |
| [MCP Server 设计](mcp-design.md) | AI 客户端接入 (16 个 tools, 已实施) |
| [测试方案](testing-strategy.md) | Jest + Playwright 测试架构 |
| [Strava 集成设计](strava-integration-design.md) | Strava 数据源集成方案 |

### 📦 参考资料

| 文档 | 说明 |
|------|------|
| [环境变量示例](../.env.example) | 环境变量配置模板（含 Garmin 账号密码与 Token 说明） |

---

## 按使用场景查找

### 场景 1: 我想部署这个项目

1. 阅读 [快速开始](../README.md#快速开始) 了解基本概念
2. 跟随 [部署指南](deployment.md) 一步步部署
3. 配置 [数据同步](data-sync.md) 实现自动更新
4. 遇到问题查看 [常见问题](faq.md)

### 场景 2: 我想了解 VDOT 是什么

1. 阅读 [VDOT 计算说明](vdot-calculation.md) 了解原理
2. 查看 [API 文档 - VDOT 趋势](api-reference.md#8-获取-vdot-趋势) 了解如何获取数据
3. 根据 VDOT 制定训练计划

### 场景 3: 我想使用 API 接口

1. 阅读 [API 接口文档](api-reference.md) 了解所有可用接口
2. 查看接口示例和响应格式
3. 根据需求调用相应的 API

### 场景 4: 我遇到了问题

1. 查看 [常见问题](faq.md) 寻找解决方案
2. 使用故障排查清单诊断问题
3. 在 [GitHub Issues](https://github.com/xuandao/pbRun/issues) 提问

---

## 核心概念

### 数据流程

```
Garmin Connect → 数据同步 → SQLite 数据库 → API 服务 → Web 界面
```

1. **Garmin Connect**: 运动数据的来源
2. **数据同步**: 通过 GitHub Actions 每日自动同步
3. **SQLite 数据库**: 离线存储，随代码部署
4. **API 服务**: Next.js API Routes 提供 RESTful 接口
5. **Web 界面**: ECharts 可视化展示

### 技术栈

- **前端**: Next.js 16 + React 19 + TailwindCSS
- **后端**: Next.js API Routes + SQLite
- **数据同步**: Node.js + Garmin Connect API
- **部署**: Vercel + GitHub Actions
- **可视化**: ECharts

### 核心优势

- **完全免费**: 无需购买云数据库
- **数据离线化**: SQLite 随代码部署
- **自动同步**: GitHub Actions 每日自动运行
- **隐私安全**: 数据存储在自己的 GitHub 仓库

---

## 项目结构

```
pbRun/
├── app/                    # Next.js 应用 (App Router)
│   ├── page.tsx            # 仪表盘
│   ├── list/               # 活动列表 (月分页 + 筛选 + 无限滚动)
│   ├── pages/[id]/         # 活动详情 (地图/趋势/分段/深挖/AI 对话)
│   ├── analysis/           # 训练分析 (心率/配速/负荷/汇总 AI)
│   ├── insight/            # 训练洞察 (动态指标/对比/汇总 AI)
│   ├── stats/              # 统计 (周期统计/个人纪录/汇总 AI)
│   ├── daniels/            # 丹尼尔斯配速表
│   ├── api/                # API 路由 (activities/stats/analysis/insight/llm/health)
│   ├── components/         # 通用 UI (卡片/表格/图表容器/导航)
│   └── lib/                # 计算、服务与 AI 上下文
│       ├── db.ts                      # SQLite 数据访问 (唯一 DB 入口)
│       ├── timezone.ts / date-utils.ts # UTC 存储 + 本地墙钟契约 / 区间解析
│       ├── insight*.ts                # 洞察纯计算、对比、服务、LLM 上下文
│       ├── activity-insight*.ts       # 活动深挖计算/服务
│       ├── activity-coach-context*.ts # 单次活动 AI 可比样本上下文
│       ├── runner-profile.ts          # 跑者画像
│       ├── llm.ts / coach-stream.ts   # prompt、请求体、SSE 出流与回退
│       └── components/{ai,charts,map} # AI 对话、图表、路线图
├── mcp-server/             # MCP Server (stdio, 16 tools)
├── scripts/                # 数据同步与维护
│   ├── garmin/             # Garmin 同步/解析/校验/回填
│   ├── strava/             # Strava 同步/OAuth/GPX
│   ├── common/             # DB/VDOT/通用工具
│   └── testing/            # 夹具库、CI 文档片段生成
├── tests/                  # Jest 单测 + Playwright e2e
├── docs/                   # 文档 (功能接口总览见 features.md)
├── deploy/                 # 本机 systemd 部署单元
└── .github/workflows/      # CI / 数据同步流水线
```

---

## 数据库结构

### 主要数据表

| 表名 | 说明 |
|------|------|
| `activities` | 活动汇总数据（`distance` 为公里） |
| `activity_laps` | 分段数据（`distance` 为米） |
| `activity_records` | 逐秒记录点（心率/速度/距离等） |
| `activity_track` | 降采样 GPS 轨迹（路线图数据源） |

> 心率区间 / VDOT 趋势 / 配速区间 / 训练洞察等均由查询时实时计算，无预计算缓存表。

详细结构请参考 [数据同步说明 - 数据结构](data-sync.md#数据结构)。

---

## API 端点概览

| 端点 | 说明 | 文档 |
|------|------|------|
| `GET /api/activities` | 获取活动列表 | [API 文档](api-reference.md#1-获取活动列表) |
| `GET /api/activities/{id}` | 获取活动详情 | [API 文档](api-reference.md#3-获取活动详情) |
| `GET /api/activities/{id}/laps` | 获取分段数据 | [API 文档](api-reference.md#4-获取活动分段数据) |
| `GET /api/stats` | 获取统计数据 | [API 文档](api-reference.md#6-获取统计数据) |
| `GET /api/vdot` | 获取 VDOT 趋势 | [API 文档](api-reference.md#8-获取-vdot-趋势) |
| `GET /api/analysis/hr-zones` | 心率区间分析 | [API 文档](api-reference.md#9-心率区间分析) |
| `GET /api/analysis/pace-zones` | 配速分布分析 | [API 文档](api-reference.md#10-配速区间分析) |
| `GET /api/insight` | 训练洞察（区间 7/30/90/180/365/0） | [API 文档](api-reference.md#12-训练洞察) |
| `POST /api/insight/coach` | 汇总 AI 教练/追问（SSE） | [API 文档](api-reference.md#13-全局-ai-综合教练) |
| `GET /api/activities/{id}/insight` | 活动深挖（分段/漂移/区间/解耦/对比） | [API 文档](api-reference.md#14-活动详情深挖) |
| `POST /api/activities/{id}/analysis` | 单次活动 AI/追问（SSE） | [API 文档](api-reference.md#15-活动-ai-深度分析sse-流式) |

完整 API 文档: [api-reference.md](api-reference.md)

---

## 常用命令

### 开发环境

```bash
# 安装依赖
npm install

# 启动开发服务器
npm run dev

# 构建生产版本
npm run build

# 启动生产服务器
npm start
```

### 数据同步

```bash
# 初始化所有历史数据
npm run init:data

# 同步最近 10 条活动
node scripts/sync-garmin.js --limit 10

# 增量同步新活动
node scripts/sync-garmin.js

# 强制重新解析所有活动
node scripts/sync-garmin.js --force
```

### 数据库管理

```bash
# 验证数据完整性
node scripts/garmin/validate-data.js

# 清理旧数据（保留最近 1 年）
node scripts/common/db-manager.js --clean --keep-days 365

# 压缩数据库
node scripts/common/db-manager.js --vacuum
```

---

## 学习资源

### 跑步训练理论

- **Jack Daniels' Running Formula** - VDOT 理论的权威著作
- **80/20 Running** - 80/20 训练法则
- **Training and Racing with a Power Meter** - 跑步功率训练

### 技术文档

- [Next.js 文档](https://nextjs.org/docs)
- [SQLite 文档](https://www.sqlite.org/docs.html)
- [Garmin FIT SDK](https://developer.garmin.com/fit/overview/)
- [ECharts 文档](https://echarts.apache.org/zh/index.html)

### 社区资源

- [GitHub Discussions](https://github.com/xuandao/pbRun/discussions) - 讨论和交流
- [GitHub Issues](https://github.com/xuandao/pbRun/issues) - 问题反馈
- [Changelog](https://github.com/xuandao/pbRun/releases) - 版本更新日志

---

## 贡献指南

欢迎贡献代码、文档或建议！

### 如何贡献

1. **报告 Bug**: 在 [Issues](https://github.com/xuandao/pbRun/issues) 中提交
2. **建议新功能**: 在 [Discussions](https://github.com/xuandao/pbRun/discussions) 中讨论
3. **提交代码**: 创建 Pull Request
4. **改进文档**: 直接编辑 Markdown 文件

### 参考与致谢

本项目实现参考了 [yihong0618/running_page](https://github.com/yihong0618/running_page)（Make your own running home page），特此致谢。

### 贡献者

感谢所有为本项目做出贡献的开发者！

查看完整的 [贡献者列表](https://github.com/xuandao/pbRun/graphs/contributors)。

---

## 许可证

本项目采用 [MIT License](../LICENSE) 开源。

---

## 联系方式

- **GitHub**: [@xuandao](https://github.com/xuandao)
- **Email**: your-email@example.com
- **项目主页**: [GitHub](https://github.com/xuandao/pbRun)
- **在线演示**: [Demo](https://your-demo.vercel.app)

---

## 功能索引与变更

- **功能接口与 AI 上下文契约**：[features.md](features.md)
- **版本变更记录**：[CHANGELOG.md](../CHANGELOG.md)
- **在线演示**：[pbrun.vercel.app](https://pbrun.vercel.app)

> 本文档按功能/接口组织；不再维护按发布日期罗列的「最近更新」清单，避免与 CHANGELOG 重复漂移。

---

如有任何问题或建议，欢迎在 [GitHub Issues](https://github.com/xuandao/pbRun/issues) 中反馈！

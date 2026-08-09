# 文档中心

欢迎来到 Garmin Running Data Analytics 的文档中心。这里提供了完整的使用指南和技术文档。

## 快速导航

### 新手入门

1. **[快速开始](../README.md#快速开始)** - 5 分钟快速上手
2. **[部署指南](deployment.md)** - 部署到 Vercel
3. **[数据同步说明](data-sync.md)** - 配置 Garmin 数据同步

### 核心文档

- **[API 接口文档](api-reference.md)** - 完整的 API 参考
- **[VDOT 计算说明](vdot-calculation.md)** - 跑力计算原理和使用
- **[常见问题](faq.md)** - 常见问题解答

---

## 文档列表

### 📖 使用指南

| 文档 | 说明 |
|------|------|
| [部署指南](deployment.md) | 如何部署到 Vercel 和配置 GitHub Actions |
| [数据同步说明](data-sync.md) | Garmin 数据同步原理和配置方法 |
| [常见问题](faq.md) | 常见问题和故障排查 |

### 📚 技术文档

| 文档 | 说明 |
|------|------|
| [API 接口文档](api-reference.md) | 完整的 RESTful API 参考 |
| [VDOT 计算说明](vdot-calculation.md) | VDOT 跑力计算公式和训练建议 |
| [MCP Server 设计](mcp-design.md) | AI 客户端接入 (13 个 tools, 已实施) |
| [测试方案](testing-strategy.md) | Jest + Playwright 测试架构 |
| [Strava 集成设计](strava-integration-design.md) | Strava 数据源集成方案 |

### 📦 参考资料

| 文档 | 说明 |
|------|------|
| [环境变量示例](.env.example) | 环境变量配置模板（含 Garmin 账号密码与 Token 说明） |

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
garmin_data/
├── app/                    # Next.js 应用
│   ├── api/               # API 路由
│   │   ├── activities/   # 活动相关接口
│   │   ├── stats/        # 统计相关接口
│   │   ├── analysis/     # 分析相关接口
│   │   └── vdot/         # VDOT 接口
│   ├── list/              # 活动列表页面
│   ├── analysis/          # 数据分析页面
│   ├── stats/             # 统计页面
│   ├── lib/               # 工具库
│   │   ├── db.ts         # 数据库访问
│   │   ├── types.ts      # 类型定义
│   │   └── format.ts     # 格式化工具
│   └── data/              # SQLite 数据库
│       └── activities.db
├── scripts/               # 数据同步脚本
│   ├── sync-garmin.js     # 主同步脚本
│   ├── garmin-client.js   # Garmin API 客户端
│   ├── fit-parser.js      # FIT 文件解析
│   ├── vdot-calculator.js # VDOT 计算
│   └── db-manager.js      # 数据库管理
├── .github/workflows/     # GitHub Actions
│   └── sync_garmin_data.yml
└── docs/                  # 文档
    ├── README.md          # 文档索引（本文件）
    ├── deployment.md      # 部署指南
    ├── data-sync.md       # 数据同步说明
    ├── api-reference.md   # API 文档
    ├── vdot-calculation.md # VDOT 说明
    └── faq.md             # 常见问题
```

---

## 数据库结构

### 主要数据表

| 表名 | 说明 | 记录数（示例） |
|------|------|----------------|
| `activities` | 活动汇总数据 | 150+ |
| `laps` | 分段数据 | 1500+ |
| `records` | 记录点数据 | 450000+ |
| `hr_zones` | 心率区间统计（缓存） | 150+ |
| `vdot_trend` | VDOT 趋势数据（缓存） | 150+ |

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
# 更新统计缓存
node scripts/preprocess-stats-cache.js --mode full

# 验证数据完整性
node scripts/validate-data.js

# 清理旧数据（保留最近 1 年）
node scripts/db-manager.js --clean --keep-days 365

# 压缩数据库
node scripts/db-manager.js --vacuum
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

## 更新日志

查看 [Releases](https://github.com/xuandao/pbRun/releases) 了解最新更新。

### 最近更新

- **v1.0.0** (2026-02-14): 首次发布
  - 完整的 Garmin 数据同步功能
  - VDOT 计算和趋势分析
  - 心率区间和配速分布分析
  - Vercel 一键部署

---

如有任何问题或建议，欢迎在 [GitHub Issues](https://github.com/xuandao/pbRun/issues) 中反馈！

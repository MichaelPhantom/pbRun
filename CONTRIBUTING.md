# 贡献指南

感谢参与 pbRun！本文说明开发流程、质量门禁与提交规范。

## 环境要求

- **Node.js ≥ 22**（见 `.nvmrc` / `package.json` 的 `engines`；`better-sqlite3` 原生模块对版本敏感）
- Python ≥ 3.10（仅数据同步 / Strava OAuth 需要）

```bash
nvm use            # 读取 .nvmrc (22)
npm ci             # 安装依赖
cp .env.example .env
```

## 开发命令

| 命令 | 说明 |
|------|------|
| `npm run dev` | 开发服务器（webpack，端口 3000） |
| `npm run typecheck` | `tsc --noEmit` 类型检查 |
| `npm run lint` | ESLint |
| `npm run test:unit` | Jest 单元测试 |
| `npm run test:coverage` | 带覆盖率（含门槛校验） |
| `npm run test:e2e` | Playwright 端到端（自动构建夹具库 + 隔离产物目录） |
| `npm run test:ci` | 本地一键跑齐 CI 门禁 |
| `npm run build` | 生产构建 |

## 质量门禁（CI）

`.github/workflows/test.yml` 在 push/PR 到 `main` 时运行：

- `quality` 作业：`typecheck` → `build:mcp` → `lint` → `jest` → `next build`
- `e2e` 作业：Playwright（chromium，生产构建 + 夹具库）

**本地提交前请至少跑通 `npm run test:ci`。**

### 覆盖率门槛

`jest.config.js` 设定了下限（`coverageThreshold`）：
全局 statements ≥ 67%、核心 `app/lib/` statements ≥ 74%。新增代码请配套测试，勿拉低门槛。

## 架构约定

- **纯计算层**：`app/lib/insight*.ts`、`activity-insight.ts` 为无副作用纯函数，务必可单测。
- **数据访问**：SQL 集中在 `app/lib/db.ts`（只读）；写入在 `scripts/common/db-manager.js`。
- **单位约定**：`activities.distance` 为公里；`activity_laps.distance` 为米；聚合接口距离返回米。
- **单一真源**：VDOT 模型常量在 `app/lib/vdot-constants.json`（TS 与同步脚本共用，勿各自硬编码）。
- **缓存**：洞察/统计类分析**不写缓存表**，请求时实时计算（见 `docs/insight.md`）。

## 提交规范

采用 [Conventional Commits](https://www.conventionalcommits.org/) 前缀：

```
feat(scope): 新功能
fix(scope): 修复
docs(scope): 文档
test(scope): 测试
refactor(scope): 重构
chore(scope): 杂项
```

提交前请确认：

1. `npm run test:ci` 通过
2. `git status` 不含 `.env` / `*.db` / 备份文件
3. 文档与实际一致（新增 API/功能请同步 `README.md` 与 `docs/`）

## 依赖升级

- 常规依赖由 Dependabot 每周开 PR；合并前需 CI 通过。
- **大版本升级需人工验证**：`better-sqlite3`（原生 ABI）、`fit-file-parser`（解析契约）已配置忽略自动大版本，请先在本地跑通同步链路（`npm run sync:garmin:*`）再升级。

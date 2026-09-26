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
| `npm run build:mcp` | `tsc -p mcp-server` MCP 构建（改 `mcp-server/` 或被其引用的 `app/lib/` 后必跑） |
| `npm run test:unit` | Jest 单元测试 |
| `npm run test:coverage` | 带覆盖率（含门槛校验） |
| `npm run test:e2e` | Playwright 端到端（自动构建夹具库 + 隔离产物目录） |
| `npm run test:ci` | 本地一键跑齐 CI quality 作业前 4 步：`typecheck` → `build:mcp` → `lint` → 测试+覆盖率 |
| `npm run build` | 生产构建。CI/clean checkout 直接可用；u2 生产机因 `app/data` 指向块存储的软链会构建失败，须用 `scripts/deploy-prod.sh`（暂存软链 → 构建 → 恢复 → 重启 → 健康检查，见 `docs/ops.md`） |

## 质量门禁（CI）

`.github/workflows/test.yml` 在 push/PR 到 `main` 时运行：

- `quality` 作业：`typecheck` → `build:mcp` → `lint` → `jest` → `next build`
- `e2e` 作业：Playwright（chromium，生产构建 + 夹具库）

**本地提交前请至少跑通 `npm run test:ci`**（= 上表前 4 步 + 覆盖率门槛；第 5 步 `next build`
由 CI 在干净 checkout 上执行，本机 u2 请以 `scripts/deploy-prod.sh` 的构建结果为准）。

> 历史教训（2026-09-26）：`test:ci` 曾漏掉 `build:mcp`，本地绿灯而 CI 在 MCP 构建步红灯，
> 原因是 `mcp-server/tsconfig.json` 的 `lib` 无 DOM、与根 tsconfig 口径不同。任何新增门禁
> 步骤必须同步补进 `test:ci`，让「本地一键 = CI」这句话始终为真。

### 覆盖率门槛

门槛数值的**单一真源是 `jest.config.js` 的 `coverageThreshold`**（`global` 与 `./app/lib/` 两个
分组各自的 statements/branches/functions/lines 下限），文档不另抄数字以免漂移。新增代码请配套
测试，勿拉低门槛；调整门槛须在 `CHANGELOG.md` 记录。

## 架构约定

- **纯计算层**：`app/lib/insight*.ts`、`activity-insight.ts` 为无副作用纯函数，务必可单测。
- **数据访问**：SQL 集中在 `app/lib/db.ts`（只读）；写入在 `scripts/common/db-manager.js`。
- **单位约定**：`activities.distance` 为公里；`activity_laps.distance` 为米；聚合接口距离返回米。
- **单一真源**：VDOT 模型常量在 `app/lib/vdot-constants.json`（TS 与同步脚本共用，勿各自硬编码）。
- **缓存**：洞察/统计类分析**不写缓存表**，请求时实时计算（见 `docs/insight.md`）。
- **表格统一**：所有数据表一律用 `app/components/ui/DataTable`（对齐「分段数据」表风格：居中、紧凑、
  单位副标题、`whitespace-nowrap` 保证单行不换行、`overflow-x-auto` 兼容移动端），勿手写 `<table>`；
  列定义见 `DataTableColumn`，行定义见 `DataTableRow`。
- **UI 原语**：卡片/数字/徽章/分段控件统一用 `app/components/ui/{SectionCard,StatCard,Badge,Segmented}`。

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

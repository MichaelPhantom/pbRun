# 更新日志

本文件记录项目的重要变更。格式参考 [Keep a Changelog](https://keepachangelog.com/)，
版本遵循 [语义化版本](https://semver.org/)。

## [Unreleased]

### Added
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
- `npm run typecheck` / `npm run test:ci` 脚本；`package.json` 增加 `engines.node >= 22`。

### Changed
- **全站表格统一**：新增 `app/components/ui/DataTable`（对齐「分段数据」表风格：居中、紧凑、
  单位副标题、单行不换行、`overflow-x-auto` 移动端兼容），并将全部 10 张数据表迁移至该组件
  （活动详情分段表/同路线对比、分析页心率/配速区间表、洞察页 4 张表）。
- **活动详情页**：分段角色并入「分段数据」表，消除与「深度分析」的重复分段表（详见下）。
- **同路线对比表**：重做为分段表风格，新增「类别」「vs 本次」列与组均/组最佳/同类对标。
- **VDOT 模型常量统一为单一真源** `app/lib/vdot-constants.json`（TS 展示与 JS 同步脚本共用），
  消除此前两处常量分叉导致的配速区间/入库 VDOT 口径不一致。
- jest 增加 `coverageThreshold`（全局 statements ≥ 67%、`app/lib/` ≥ 74%），防止覆盖率回归。
- 洞察页/文档同步：新增 `docs/insight.md`，更新 `README.md`、`docs/api-reference.md`、
  `docs/README.md`、`docs/deployment.md`。

### Fixed
- `GET /api/llm/models` 增加 try/catch，异常时返回 `{ error }` + 500（此前无错误处理）。
- 补齐此前零覆盖的 API 路由测试（laps / vdot-trend / health / llm-models）与服务层测试。

## 历史

早期开发（AI 教练体系、数据同步健壮性、可访问性、VDOT 重构等）见 `git log`。

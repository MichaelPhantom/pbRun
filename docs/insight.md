# 训练洞察与 AI 教练

本文档介绍 pbRun 的**动态训练洞察**与 **AI 教练体系**（活动级 + 全局综合）的原理、指标定义与实现结构。

## 目录

- [设计原则](#设计原则)
- [指标体系](#指标体系)
- [数据流与模块](#数据流与模块)
- [AI 教练体系](#ai-教练体系)
- [活动详情深挖](#活动详情深挖)
- [测试](#测试)

---

## 设计原则

1. **实时计算，无缓存表**：所有洞察指标在请求时由 `app/lib/insight*.ts` 从 `activities` / `activity_laps` / `activity_records` 实时聚合。历史版本的 `hr_zone_stats_cache` / `vdot_trend_cache` 缓存表已废弃。数据同步入库后分析页即刻更新，无需重建缓存。
2. **纯函数计算层**：`insight.ts` / `insight-compare.ts` / `activity-insight.ts` 为无副作用纯函数（仅依赖输入），便于单测与复用；DB 读取集中在 `db.ts`。
3. **动态建议引擎**：`buildFindings()` 依据实时指标生成带严重度分级（`positive` / `info` / `warn` / `critical`）与可执行动作的结论，避免硬编码报告。
4. **服务层编排**：`insight-service.ts` / `activity-insight-service.ts` 负责"DB 读取 → 计算 → 响应"，使 API 路由与页面（server component）共享同一实现。

---

## 指标体系

| 维度 | 指标 | 定义 / 口径 |
|------|------|-------------|
| 跑力 | VDOT 趋势 | 每次活动的 `vdot_value`；按月聚合 + 最小二乘线性拟合（`slopePer30d`）；近 60 天斜率 \|·\|<0.15 判定平台期 |
| 负荷 | ACWR | 急性(近 7 天负荷) / 慢性(近 28 天周均负荷)；`optimal` 0.8–1.3、`caution` 1.3–1.5、`risk` >1.5 |
| 负荷 | 强度分布 | 各活动 `time_in_hr_zone` 汇总 Z1–Z6 秒数占比；`lowIntensityPct` = Z1+Z2 |
| 周期 | 周 CTL/ATL/TSB | 由逐日负荷经 Banister EWMA（τ=42 / 7）计算，取每周期末值 |
| 有氧 | 解耦 Pa:HR | 对 ≥10km 活动，用逐秒记录比较前后半段「速度/心率」比值相对变化；越低越强（优秀 <5%） |
| 跑姿 | 步频/触地/垂直比 | 按月均值 |
| 配速-心率 | 回归 | 稳态跑（≥8km）样本线性回归 `HR = intercept + slope × 配速(分/km)`；用阈值心率反推阈值配速 |
| 类别 | 类别对比 | 由活动名称/距离推断类别；配速/心率为**时长加权**；有氧效率 = 速度(m/s)/心率(bpm) |
| 气温 | 分档对比 | 温度分档 `<10 / 10–18 / 18–24 / 24–28 / ≥28°C`，比较心率/配速/效率 |
| 路线 | 路线对比 | 以活动名称"地点前缀"（` - ` 之前）为路线指纹，聚合次数/最佳/均值/配速趋势 |

> 单位约定：`activities.distance` 为**公里**；`activity_laps.distance` 为**米**；聚合接口返回距离统一为**米**（见 `db.ts` 各函数与 `types.ts`）。

---

## 数据流与模块

```
activities / activity_laps / activity_records (SQLite)
        │
        ▼  app/lib/db.ts  (getVdotSamples / getDailyLoads / getActivityRecordSamples / getLongRuns / ...)
        │
        ▼  app/lib/insight.ts            (纯计算: VDOT/负荷/解耦/跑姿/配速-HR + buildFindings)
           app/lib/insight-compare.ts    (纯计算: 类别/气温/路线/周期化)
           app/lib/activity-insight.ts   (纯计算: 分段角色/漂移/同路线对比)
        │
        ▼  app/lib/insight-service.ts / activity-insight-service.ts  (编排)
        │
        ├──▶ app/api/insight/route.ts                  (GET 洞察)
        ├──▶ app/api/insight/coach/route.ts            (POST 全局 AI 教练, SSE)
        ├──▶ app/api/activities/[id]/insight/route.ts  (GET 活动深挖)
        ├──▶ app/insight/page.tsx                      (server component → InsightClient)
        └──▶ app/pages/[id]/ActivityDetailClient.tsx   (嵌入 ActivityInsightPanel)
```

关键类型定义见 `app/lib/types.ts`：`InsightResponse` / `CategoryComparison` / `WeatherComparison` / `RouteComparison` / `PeriodizationInsight` / `ActivityInsightResponse` 等。

---

## AI 教练体系

两者共享底层：`app/lib/components/ai/stream-chat.ts`（SSE 解析）、`ModelSelector`、`MarkdownLite`、`ThinkingBlock`、`useStickToBottom`、`useModelCatalog`。

### 1. 活动级 AI 教练（已有）

- 端点：`POST /api/activities/[id]/analysis`
- 上下文：【跑者画像】(`runner-profile.ts`) + 单次活动数据 + 分段
- Prompt：`llm.ts` 的 `SYSTEM_PROMPT`（6 大分析框架）
- UI：`app/lib/components/ai/AiAnalysis.tsx`（嵌入活动详情页）

### 2. 全局 AI 综合教练（本功能）

- 端点：`POST /api/insight/coach`
- 上下文：【跑者画像】+【全局洞察指标】（`insight-coach.ts` 的 `formatInsightForCoach` 把 `InsightResponse` 序列化为文本块）
- Prompt：`llm.ts` 的 `GLOBAL_COACH_PROMPT`（总体诊断/能力演进/结构评估/多维洞察/优势短板/未来处方）
- 消息构造：`buildGlobalCoachMessages` / `buildGlobalCoachFollowupMessages`
- UI：`app/lib/components/ai/GlobalCoach.tsx`（嵌入洞察页）
- 端点行为与活动级一致：SSE 流式、主模型 5xx/超时/429 自动回退 `auto`、回退响应头；
  出流策略收敛在 `app/lib/coach-stream.ts`（响应头 120s 上限 + **首字节 90s 看门狗**，
  超时即中断主模型改走 `auto`），模型 id 由白名单清洗后下发。

> 凭证：`.env` 的 `FREELLMAPI_BASE_URL` / `FREELLMAPI_KEY`（本机 freellm 网关）。未配置时 `GET /api/llm/models` 返回 `configured:false`，教练端点返回 `503`。故障排查见 [faq.md#11](faq.md)。

---

## 活动详情深挖

`GET /api/activities/[id]/insight`（UI: `ActivityInsightPanel`）提供：

- **分段角色识别**（`analyzeLaps`）：以整体配速为基准，将每段标记为 热身/主课/恢复/冷身/匀速；主课段（明显快于基准）聚合出段数、距离、时长加权配速、心率漂移。
- **心率区间占比**（`hrZoneBreakdown`）：解析活动 `time_in_hr_zone` JSON。
- **逐秒有氧解耦**：复用 `computeDecouplingPct`。
- **同路线对比**（`db.getPeerActivities` + `computeComparison`）：优先按路线指纹找同行历史，否则按相近距离（±25%）；输出配速排名与相对均值的差值。

---

## 测试

| 模块 | 测试文件 |
|------|----------|
| 洞察计算 | `tests/unit/lib/insight.test.ts` |
| 类别/气温/路线/周期化 | `tests/unit/lib/insight-compare.test.ts` |
| 活动深挖计算 | `tests/unit/lib/activity-insight.test.ts` |
| 洞察→教练上下文 + 全局消息 | `tests/unit/lib/insight-coach.test.ts` |
| 洞察 API | `tests/unit/api/insight-route.test.ts` |
| 教练/活动深挖 API | `tests/unit/api/insight-coach-route.test.ts` |
| 组件渲染 | `tests/unit/components/insight-components.test.tsx` |
| 导航菜单 | `tests/unit/components/TopNav.test.tsx` |
| e2e 导航 | `tests/e2e/navigation.spec.ts` |

运行：`npm run test:unit`。

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
5. **单次活动看横向、汇总页看区间**：活动级 AI 以「当次 + 同路线/同距离/同类」的可比样本为主；
   汇总级 AI 以所选区间（近一周/近一月/近三月/近半年/全部）的指标与趋势为主，二者不互相替代。

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

> 单位约定：`activities.distance` 为**公里**；`activity_laps.distance` 为**米**；
> `activity_records.distance` 为**公里**、`speed` 为 **km/h**（fit-parser `lengthUnit=km`）；
> 聚合接口返回距离统一为**米**（见 `db.ts` 各函数与 `types.ts`）。

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

### 1. 活动级 AI 教练

- 端点：`POST /api/activities/[id]/analysis`
- 上下文：【跑者画像】(`runner-profile.ts`) + 单次活动数据 + 分段 +
  **【本次表现与可比样本】**(`activity-coach-context.ts`)
  - 当次：分段角色（热身/主课/恢复/冷身）、主课配速/心率/心率漂移、最快段、
    心率区间占比、逐秒有氧解耦；
  - 同路线/同名：以活动名称「地点前缀」为指纹的历史样本，按路线距离带过滤
    （`<5km ±35%` / `5–12km ±25%` / `>12km ±23%`），再用 GPS 首点做 **≤2km 同起点校验**
    （无轨迹保留），输出排名、组均/组最佳、心率差；
  - 同位置（跨名称）：双通道召回 —— ① `start_lat/start_lng` 索引取 GPS 首点 ≤1.5km
    候选（Haversine 精筛）；② 持久化的 `route_cells`（geohash-7）+ `route_km` 索引按
    长度比/距离档预筛、网格 Jaccard ≥0.2 并入 —— 补上「同一条环线从不同入口起跑」
    （起点 >1.5km）。合并去重后统一做轨迹形状相似度校验（起点对齐 DTW + 网格 Jaccard
    + 抗尖峰包围盒 + 质心 + 长度比，阈值 0.55）；即使名称不同，同一公园/田径场/起点
    的同类路线也能进入可比组；
  - 同距离：按距离分档独立查询（`<5km ±20%` / `5–12km ±10%` / `>12km ±8%`），
    与 UI 深挖面板同一容差；
  - 同类训练：名称 + 距离推断类别（轻松/节奏/阈值/间歇/长距离/比赛），样本 ≥2 才输出；
  - 环境可比：同距离样本的平均温度/爬升、本次与样本的差值，以及同温档
    （`<10 / 10–18 / 18–24 / 24–28 / ≥28°C`）的排名/配速差/心率差；
  - 海拔修正：Minetti 2002 估算的等价平路配速（实际 vs 等价、爬升/公里）；
  - 温度漂移：逐秒温度前后 10% 均值（起跑 → 结束）。
- Prompt：`llm.ts` 的 `SYSTEM_PROMPT`（6 大分析框架）；第 6 项明确要求「横向定位优先，
  长期趋势仅作背景」。
- UI：`app/lib/components/ai/AiAnalysis.tsx`（嵌入活动详情页，锚点 `#ai-coach`）
- 降级：`activity-coach-context-service.ts` 中任一查询失败只丢失对应段落，返回空串也不阻塞。

### 2. 全局 AI 综合教练

- 端点：`POST /api/insight/coach`
- 区间：`days=7/30/90/180/365/0`（`0`/`all` = 全部历史），页面入口：
  - `/`：全部历史（首页整体 AI）；
  - `/insight?days=` 与 `/analysis?days=`：近一周 / 近一月 / 近三月 / 近半年 / 全部；
  - `/stats?period=`：周→7、月→30、年→365、总→0。
- 上下文：【跑者画像】+【全局洞察指标】（`insight-coach.ts` 的 `formatInsightForCoach`
  把该区间的 `InsightResponse` 序列化为文本块）+【区间环比】（`period-comparison.ts`
  对比当前区间与上一个等长区间的跑量/次数/时长/配速/跑力/负荷；无基线或全部历史时省略）
- Prompt：`llm.ts` 的 `GLOBAL_COACH_PROMPT`（总体诊断/能力演进/结构评估/多维洞察/优势短板/未来处方）
- 消息构造：`buildGlobalCoachMessages` / `buildGlobalCoachFollowupMessages`
- UI：`app/lib/components/ai/GlobalCoach.tsx`（洞察页、分析页、统计页复用）
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
- **同路线对比**（`db.getPeerActivities` + `computeComparison`）：优先按路线指纹找同行历史，否则按距离分档回退；输出配速排名与相对均值的差值。
- **同位置对比**（`getLocationPeerActivities` / `getRouteShapePeerActivities` + `route-shape.ts`）：
  起点通道（GPS 首点 ≤1.5km）与网格通道（`route_cells` 网格 Jaccard + `route_km` 长度比）
  并行召回，合并去重后按距离分档 + 轨迹形状相似度（阈值 0.55）精判，跨名称匹配同一路线。
- **环境可比性**（`summarizeActivityEnvironment`）：同组样本的温度/爬升均值、本次差值，以及同温档排名/配速差/心率差；详情面板同步展示，保证用户能看到 AI 使用的参照系。
- **海拔修正 / 温度漂移**：`gradeAdjustedPace`（Minetti 2002）与 `computeTemperatureDrift`；详情面板展示等价平路配速与起止温度。

---

## 测试

| 模块 | 测试文件 |
|------|----------|
| 洞察计算 | `tests/unit/lib/insight.test.ts` |
| 类别/气温/路线/周期化 | `tests/unit/lib/insight-compare.test.ts` |
| 活动深挖计算 | `tests/unit/lib/activity-insight.test.ts` |
| 活动 AI 可比样本格式 | `tests/unit/lib/activity-coach-context.test.ts` |
| 活动 AI 可比样本取数与降级 | `tests/unit/lib/activity-coach-context-service.test.ts` |
| 温度/爬升/同温档可比性 | `tests/unit/lib/activity-environment.test.ts` |
| 海拔修正（等价平路配速） | `tests/unit/lib/grade-adjust.test.ts` |
| 逐秒温度漂移 | `tests/unit/lib/activity-temperature.test.ts` |
| GPS 同起点校验 | `tests/unit/lib/geo.test.ts` |
| 路线形状相似度（DTW/网格/清洗/环线入口） | `tests/unit/lib/route-shape.test.ts` |
| 签名复用（`routeSignatureOf` 与 `deriveRouteSignature` 等值） | `tests/unit/lib/route-shape.test.ts` |
| 路线签名 TS↔CJS 一致性 | `tests/unit/lib/route-signature-parity.test.ts` |
| 路线签名回填脚本 | `tests/unit/scripts/backfill-route-signatures.test.js` |
| 洞察→教练上下文 + 全局消息 | `tests/unit/lib/insight-coach.test.ts` |
| Prompt 注入顺序 | `tests/unit/lib/llm.test.ts` |
| 区间参数（7/30/90/180/365/0/all） | `tests/unit/lib/date-utils.test.ts` |
| 区间环比 | `tests/unit/lib/period-comparison.test.ts` |
| 洞察 API | `tests/unit/api/insight-route.test.ts` |
| 教练/活动深挖 API | `tests/unit/api/insight-coach-route.test.ts` |
| 活动 AI 路由校验/追问/降级 | `tests/unit/api/analysis-*.test.ts` |
| 组件渲染 | `tests/unit/components/insight-components.test.tsx` |
| 导航菜单 | `tests/unit/components/TopNav.test.tsx` |
| e2e 导航 | `tests/e2e/navigation.spec.ts` |

运行：`npm run test:unit`。

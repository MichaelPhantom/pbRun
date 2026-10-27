# 功能接口总览

本文档按**功能接口**组织（而不是按发布时间或开发轮次），用于回答三个问题：

1. 这个功能对用户暴露的入口是什么？
2. 它读取哪些数据、由哪个计算层负责？
3. 它的 AI 上下文口径是什么、由哪些测试守护？

> 约定：`activities.distance` 为公里；`activity_laps.distance` / 逐秒记录 / MCP 统计接口为米；
> 配速为秒/公里，时长为秒。详见 [API 文档](api-reference.md)。

---

## 1. 功能矩阵

| 功能接口 | 用户入口 | 数据与计算 | AI 上下文 | 状态 |
|---------|---------|-----------|----------|------|
| 仪表盘 | `/` | `getLatestVdot` / `getTrainingLoads` / `getDailyDistances` | 整体 AI（全部历史） | ✅ |
| 活动列表 | `/list` | `getMonthSummaries` / `getActivities`（月分页 + 筛选，全类型口径） | 每张卡片直达详情 AI 复盘 | ✅ |
| 活动详情 | `/pages/[id]` | `getActivityById/Laps/Records/Track` | 单次活动 AI（见 §2） | ✅ |
| 活动深挖 | `GET /api/activities/[id]/insight` | `activity-insight.ts`：分段角色 / 主课漂移 / 区间 / 解耦 / 同路线对比 / 环境可比性 | 作为活动 AI 的当次指标来源 | ✅ |
| 活动 AI 对话 | `POST /api/activities/[id]/analysis` | `llm.ts` + `coach-stream.ts` + `runner-profile.ts` + `activity-coach-context.ts` | 当次 + 同路线/同名 + 同距离 ±10% + 同类 | ✅ |
| 训练分析 | `/analysis?days=` | 心率区间 / 配速区间 / VDOT / CTL-ATL-TSB | 汇总 AI，跟随页面时间窗 | ✅ |
| 训练洞察 | `/insight?days=` | `insight.ts` / `insight-compare.ts` 实时聚合 + `findings` | 汇总 AI，跟随页面时间窗 | ✅ |
| 统计 | `/stats?period=` | `getStats` / `getPersonalRecords`（跑步口径，见 §1.1） | 汇总 AI，周/月/年/全部映射 | ✅ |
| 汇总 AI 对话 | `POST /api/insight/coach` | `insight-service.ts` → `formatInsightForCoach` | 区间指标 + 跑者画像 + 趋势 | ✅ |
| 模型目录 | `GET /api/llm/models` | `model-curation.ts` 固定白名单 | — | ✅ |
| MCP Server | `mcp-server/`（stdio） | 16 个 tools 复用 `app/lib/db.ts` 与活动深挖服务 | `get_activity_comparables` 直接返回当次可比 `contextText` | ✅ |
| 数据同步 | `scripts/garmin` / `scripts/strava` | FIT/GPX → SQLite，VDOT 计算 | — | ✅ |

---

## 1.1 统计口径：两种口径必须显式区分

pbRun 是跑步分析工具，但 Garmin 同步会把篮球/游泳/力量训练等一并写入同一张
`activities` 表。生产库实测 348 条活动里只有 241 条是跑步，其余 107 条的距离、
配速、步频、心率区间语义完全不同（泳池游泳 1670s/km、乒乓球 30826s/km、篮球步频 16）。

因此所有读取都归入两种口径之一，**不允许隐式混用**：

| 口径 | 语义 | 覆盖接口 |
|------|------|---------|
| **表现分析（只取跑步）** | 配速/心率/步频/VDOT/区间/纪录/负荷/对比只在跑步内部有意义 | `getStats`、`getPeriodStats`、`getPersonalRecords`、`getPaceZoneStats`、`getHrZoneStats`、`getHrZoneTotals`、`getVDOTHistory(+Total)`、`getVDOTTrend`、`getVdotSamples`、`getLatestVdot`、`getLatestThresholdHr`、`getFormSamples`、`getPaceHrSamples`、`getLongRuns`、`getTrainingLoads`、`getDailyDistances`、`getInsightActivityRows`、`getActivityCountInRange`、同路线/同距离/同位置对比 |
| **活动日志（全类型）** | 用户明确要在列表里看到所有运动，且带 `activity_type` 筛选器 | `getActivities`、`getMonthSummaries` |

跑步类型集合为 `running` / `track_running` / `treadmill_running`（`db.runningTypeClause`
与 `db.isRunningType` 单点定义）；缺 `activity_type` 列或值为空时按跑步处理（旧库兼容）。

**写入侧也必须同口径**：不只是查询要筛跑步，**回填脚本写入 `vdot_value` /
`training_load` 时同样只处理跑步类型**（`scripts/garmin/backfill-vdot.js` 的
`isRunningActivity`）。否则只要非跑步活动存在「距离 >400m + 带心率/配速」的 lap
（真实库篮球 lap 1665m/2604m 就有），Daniels 公式会把「每公里打球时间」当成跑步
速度算出**伪 VDOT**，而 `vdot_value` 在 UI / AI / MCP 里全被当作跑力展示 ——
查询侧再严也挡不住脏数据。当前真实库 107 条非跑步活动 `vdot_value` 全为 null
（0/107，因为非跑步最高心率 131 达不到 Z3+ 门槛），但这是**尚未触发**而非安全。

**为什么必须隔离**（真实库 348 条活动实测）：

| 指标 | 混类型 | 仅跑步 | 后果 |
|------|--------|--------|------|
| 平均配速 | 989 s/km | 369 s/km | 「16:29/km」把跑者说成快走 |
| 心率 Z1 总时长 | 91221 s | 698 s | 轻松跑占比 66% vs 实际 4% |
| 跑姿步频区间 | 8–190 | 100–190 | 跳绳/篮球拉低步频趋势 |
| 训练负荷里程 | 2152 km | 2140 km | 12km 非跑步混入 CTL/ATL |
| 个人纪录 5K | 8353 s（游泳按比例） | 1229 s | 8.2km 游泳伪造「纪录」 |
| 配速区间 activity_count | +5 条非跑步 lap | — | 篮球/乒乓污染配速区间 |
| 跑者画像近 28 天 Z1 占比 | 7.6% | 0.6% | 7 条力量训练占满 Z1 |

`/insight` 的「共 N 次活动」与 `/stats` 的「共计跑步 N 次」均按跑步口径计数，与下方
配速/心率/区间完全一致；`/list` 的月度「N 公里 / N 次」保留全类型，与展开后的卡片
严格一致（含 1 条游泳的月份显示 4 次，展开也是 4 张卡片）。

**展示与 AI 也必须分口径**（否则修复了统计却仍在误导用户）：

| 位置 | 非跑步活动的处理 |
|------|-----------------|
| `/list` 类型下拉 | 值仍是原始 `activity_type`，文案走 `activityTypeLabel` 中文名（按拼音排序）；空 `activity_type` 归一成 `running` 键，不再与真实 `running` 分裂成两个同名选项 |
| 活动卡片 / 仪表盘「最近活动」 | 隐藏配速（泳池 1670s/km、乒乓 30826s/km 不是跑步配速）与「即时跑力 / VDOT」（跑步跑力指标），改显示类型徽标；无名称时按类型兜底命名。训练负荷与心率与运动类型无关，照常展示 |
| 活动详情页概览 | 隐藏「即时跑力 / 平均配速 / 步频 / 步幅」整列（不是显示 `--`，那会让人以为数据缺失）；「平均功率」同样按字段存在性渲染 —— 真实库 107 条非跑步活动功率全为 NULL（0/107），旧实现无条件渲染会永远显示 `--` |
| 仪表盘「本月概览」 | 「跑步天数」而非「活动天数」—— 数据源 `getTrainingLoads` 是跑步口径，真实库 2026-10 有 16 个活动日但只有 15 个跑步日（多出力量训练/爬楼）；旧标签会让人以为漏了一天 |
| 仪表盘「VDOT 趋势」 | 副标题「近 N 次跑步」而非「次活动」—— `getVDOTHistory` 只含跑步（`vdot_value` 只对跑步计算） |
| `/insight` 类别分布图 | aria-label「训练类别跑步次数分布」而非「活动数分布」—— `getInsightActivityRows` 是跑步口径，分类里的 `count` 是跑步次数 |
| `/insight` 强度分布标题 | 由**实际非零区间**派生（`zoneRangeLabel`：Z1–Z5 / Z3–Z4 / Z1, Z2, Z4），旧文案写死「Z1–Z6」—— 真实库 140 条活动 `time_in_hr_zone` 的 Z6/Z7 **0/140 全为 0**，配色也只有 `--z1..--z5`，标题承诺了永远画不出来的区间 |
| 分析页「当前跑力」副标题 | 「近一周跑步平均」而非「近一周活动平均」—— `currentVdot` 来自 `getStats('week').averageVDOT`，是跑步口径 |
| 丹尼尔斯页「当前跑力」说明 | 「近一周跑步活动的 VDOT 平均值」并注明「只含跑步，游泳/球类不参与」—— 同源 `getStats('week')` |
| `/stats` 个人纪录「单次最长距离」 | 「单次跑步最长距离」而非「单次训练最长距离」—— `getPersonalRecords` 带 `runningTypeClause`，游泳/球类不计入 |
| 全局教练【区间环比】次数行 | 「跑步次数」而非「次数」—— `getPeriodStats` 是跑步口径，模型若读成全部活动数会误判训练频率 |
| 活动详情页分段表 | 隐藏配速与步频列，不给「最快 K」徽章 |
| `/analysis` 区间表（配速/心率） | 展示「时长 / 距离 / 次数」三列。数据层算好的 `activity_count` / `total_duration` / `total_distance` 此前**从未露出** —— 心率区间表只给「Z2 平均配速 5:40」，用户看不到这个区间到底占了多少训练量。距离由**米**换算成公里（`total_distance` 是 lap 距离累加），时长走 `formatDuration`，空区间显示 `--` 而非 `0:00` |
| 活动详情页「跑步动态」 | 展示条件为**触地平衡 / 触地时间 / 垂直摆动 / 垂直振幅比 四项任一非空且为跑步**。垂直振幅比（= 垂直摆动/步幅）在真实库 **241/241** 条跑步活动都有值（6.69–10.48%），此前 UI 与活动 AI prompt 都未使用 —— 数据在库里却拿不到。旧实现只判 `average_gct_balance`，而真实库 **348/348 条活动该字段全为 NULL**（Garmin 仅部分高阶手表/双传感器配置写入），触地时间与垂直摆动却在 **241/241 条跑步活动**里都有值 —— 结果这张卡片在生产环境**从未渲染过**，已有的跑姿数据用户永远看不到。非跑步活动四项全 NULL（0/107），且额外按 `running` 门控（步态指标对游泳/球类无语义） |
| 活动详情页趋势图 | 不渲染配速/步频/步幅三图（非跑步记录的 `cadence` 是划水/踏频/移动步频，真实库篮球最高 250、乒乓 214、羽毛球 154，套进「步频 100–220 步/分」区间毫无意义）；卡片标题由 `trendChartTitle` **按实际可渲染的图派生**，不再写死 —— 真实库 107 条非跑步活动 `altitude` 全为 0/null（0/107），旧标题「心率 / 海拔 趋势」是空承诺 |
| 活动详情页「深度分析」面板 | 不渲染「最快分段 / 主课均配速」两张卡片（泳池 1670s/km 显示成配速会被读成「慢得离谱」）；主课段数与心率漂移照常展示。分段角色改按**相对心率**识别 —— 游泳 lap 常无 `average_pace`，按配速做基准会让所有段落进 `steady`、永远识别不出主课 |
| 活动 AI prompt | 换用 `NON_RUNNING_SYSTEM_PROMPT`（综合体能教练 + 交叉训练视角）；活动数据段不输出配速/步频/步幅/触地/跑力行，分段改用时长 |
| 活动 AI 可比样本块 | 不输出「主课配速 / 最快分段 / 等价平路」；标题改「本次分段（按相对快慢划分, 不比配速）」，口径说明明确「不比较配速/步频/跑力」 |

**区间表必须展示训练量，不只是均值**：`/analysis` 的配速区间表与心率区间表此前只显示
心率/步频/步幅（配速区间表）或配速/步频/步幅（心率区间表），而数据层早已算好的
`activity_count` / `total_duration` / `total_distance` **从未露出**。对心率区间表来说
「Z2 累计跑了多久」恰恰是最核心的指标 —— 用户只能看到「Z2 平均配速 5:40」，
却不知道这个区间到底占了多少训练量。两张表现已展示「时长 / 距离 / 次数」三列：

- 时长用 `formatDuration`（`3:00:00`），区间无数据时 `--`（不是 `0:00`）
- 距离由 **米** 换算成公里（`total_distance` 是 lap 距离累加，单位为米）
- 次数用去重后的 `activity_count`（同一活动的多个 lap 不重复计）

守护：`tests/unit/components/zone-tables-a11y.test.tsx` 断言三列表头存在、时长/距离/次数
的实际文本（含「30000 米 → 30.0 km」的换算与「无数据显示 `--`」）。

跑步类型判定单点定义在纯模块 `app/lib/sport.ts`（`RUNNING_ACTIVITY_TYPES` /
`isRunningType` / `activityTypeLabel` / `activityTypeIcon`）：`db.ts` 的 SQL 片段由该
常量派生，客户端组件直接用同一份判定，因此不存在「SQL 与 UI 两套列表漂移」。

---

## 2. AI 上下文口径（核心契约）

### 2.1 单次活动：横向可比优先

`app/lib/activity-coach-context.ts`（纯函数）+ `activity-coach-context-service.ts`（DB 编排）
在活动数据之后注入【本次表现与可比样本】：

```
【本次表现与可比样本】
本次分段: 8 段 | 主课 2 段 / 3.00km | 主课配速 4:05/km | 主课心率 172bpm | 主课心率漂移 +4bpm | 最快分段 3:58/km
心率区间: Z1 10.0% / Z2 45.0% / Z3 30.0% / Z4 15.0%
有氧解耦: 4.2%（优秀）
海拔修正: 实际 5:36/km → 等价平路 5:31/km（快 6s/km；爬升 8.4m/km，Minetti 估算）
温度漂移: 24.0°C → 26.5°C（+2.5°C）
同位置样本（GPS ≤1.5km）: 样本 4 次（含本次） | 本次排名 2/4 | 组均 5:42/km（快 6s/km）
同路线/同名样本（两江新区 · 同起点）: 样本 13 次（含本次） | 本次排名 3/13 | 组均 4:18/km（快 5s/km） | 组最佳 3:59/km | 心率高 3bpm
  最近样本: 09-20 10.0km 4:12 168bpm 比本次快 6s/km；...
同距离样本（±8% · 13.9–16.3km）: 样本 19 次（含本次） | 本次排名 7/19 | ...
同类训练「节奏跑」: 样本 6 次（含本次） | 排名 2/7 | 同类均 4:15/km（慢 2s/km）
环境可比（同距离样本 12 次）: 本次 26.0°C / 爬升 120m | 样本 均 23.5°C / 均爬升 95m（温度高 2.5°C，爬升多 25m）
同温档 24–28°C: 样本 6 次（含本次） | 本次排名 2/6 | 档内均 5:10/km（快 10s/km） | 均心率 156bpm（心率高 4bpm）
```

规则：

- **同路线/同名**：以活动名称的「地点前缀」（` - ` 之前）为指纹；无指纹（如「跑步机」）时跳过。
- **同位置（跨名称）**：双通道召回，再统一做形状精判：
  1. **起点通道**：用 `start_lat/start_lng` 索引取 GPS 首点 ≤1.5km 候选，Haversine 精筛；
  2. **网格通道**：用持久化的 `route_cells`（geohash-7 签名）+ `route_km` 索引按长度比
     （≤1.35）与距离分档预筛，JS 层算网格 Jaccard（≥0.2）后并入候选 —— 补上「同一条
     环线从不同入口起跑」这类起点 >1.5km 的活动。

  两路候选合并去重后，用**轨迹形状相似度**（阈值 0.55）剔除同起点但不同环线/折返方向
  的活动。形状相似度以**路面重叠**为主信号（0.45，双向平均垂直距离，归零尺度 300m），
  再叠加 geohash-7 网格 Jaccard（0.20）、抗尖峰包围盒 IoU（0.12）、质心距离（0.08）、
  长度比（0.10）与环线一致性（0.05）。另有两条硬门禁：起点 >2.5km（环线入口变体除外）、
  长度比 >1.8。即使名称不同，同一公园/田径场/起点的同类路线也能进入「同位置样本」。

  **为什么主信号是垂直距离而不是 DTW**：起点对齐 DTW 有两个结构性缺陷 ——
  (1) 把「沿路线的进度错位」算成形状差异：同一条 10km 环线，配速 5:00 与 6:30 的
  累计里程进度可差数百米，DTW 强制逐点顺序对齐，这部分错位被记成 0.29–0.38km 平均
  偏差，`shapeScore` 直接归零（生产库实测 152 对同名同起点环线几何偏差仅 11–43m 却
  被判为不同路线）；(2) 对平移不变：两条形状相同但相隔 700m 的环线，各自平移到起点
  后完全重合，DTW 接近 0（实测 6 对 `grid=0、bboxIoU=0` 的轨迹拿到 0.55–0.64 分）。
  垂直距离与配速/采样密度/进度错位全都无关，只回答「是不是同一片路面」，且天然位置
  敏感。实测区分度：真实同路 p50 18m / p90 73m / p99 143m，完全异地 640–720m。
  DTW 保留为**诊断量**（`dtwKm`，需显式 `includeDtw` 才计算），不参与打分。
- **同距离**：按距离分档取独立样本，避免拿 5K 与全马直接比较：
  `<5km ±20%`、`5–12km ±10%`、`>12km ±8%`（UI 深挖面板与 AI 使用同一组容差）。
- **同路线距离带**：在同一组容差上放宽 15pt（`<5km ±35%`、`5–12km ±25%`、`>12km ±23%`），
  既保留「同地点」语义，又避免同路线 5K 与 30K 直接对比。
- **GPS 同起点校验**：名称前缀只能证明「同区域」。对同路线样本再用 GPS 首点做
  Haversine 距离校验（默认 ≤2km），剔除同名不同起点的活动；无轨迹/室内活动保留
  （无法校验，不误删）。当前活动无 GPS 时跳过校验。
- **同类训练**：由活动名称 + 距离推断训练类别（轻松/节奏/阈值/间歇/长距离/比赛），样本 ≥2 才输出。
- **环境可比**：汇总同距离样本的平均温度/爬升，量化本次的温度差、爬升差；再按
  `<10 / 10–18 / 18–24 / 24–28 / ≥28°C` 同温档给出档内排名、配速差与心率差，
  避免把「天气更热」误判为「能力下降」。
- **海拔修正（GAP）**：用逐秒海拔/距离 + Minetti 2002 能量成本模型估算**等价平路配速**；
  横向比较优先看等价配速，而非被爬升污染的原始配速。
- **温度漂移**：逐秒温度前后 10% 均值 → `起跑温度 → 结束温度`；后程升温会单独标注。
  历史逐秒温度已用 `npm run backfill:temp` 从 FIT 缓存回填（仅补 NULL，幂等），新活动随
  每日同步写入。
- **当次指标**：分段角色、主课配速/心率/漂移、最快段、心率区间占比、逐秒解耦。
- **降级纪律**：任何一步查询失败只丢失对应段落，返回空串也不阻塞 AI 主流程。
- **不做**：不用跨全历史的宏观趋势替代对当次的解读；趋势只作为解释当次状态的背景。

#### 活动数据块的「缺失」分两类（2026-10-27）

真实库 348 条活动逐字段审计后，两类缺失必须区别处理 —— 统一写成 `--` 会制造噪音：

| 类别 | 判定 | 输出 | 实例（真实库） |
|------|------|------|---------------|
| **该运动不产出** | 写入口就限定运动类型，或设备/平台根本不写 | **整项不输出**（连标签） | `training_stress_score` / `intensity_factor` / `average_power_to_weight` / `avg_grade` **0/348**；非跑步的 `average_power` / `normalized_power` / `training_load` / `avg_altitude` / `average_temperature` **0/107** |
| **该活动没测到** | 数据源支持，只是这次没有 | 保留标签 + `--` | `vdot_value` 120/241 为空、`time_in_hr_zone` 208/348 为空、非跑步的 `average_speed` 97/107 为空 |

实现：`fmtNumIf()` 值为空返回 `null`，`statRow()` 把 `null` 项整项略去、全空则整行丢弃。
守护：`tests/unit/lib/llm-gateway.test.ts`（「数据源从不产出的字段整项不出现」/「有值时照常
输出」/「不存在只剩标签的空行」）+ `tests/unit/lib/llm.test.ts`（非跑步 prompt 不得引用
数据里不存在的指标）。

**为什么非跑步 prompt 也要改**：`NON_RUNNING_SYSTEM_PROMPT` 曾要求「用训练负荷（TL）评估
强度」并把负荷列为「所有运动都有的指标」，但非跑步 `training_load` **0/107** 有值
（`sync.js` 的 `runnableTypes2` 限定跑步类型）—— prompt 与数据源直接矛盾，模型只能编造
或抱怨缺数据。现已改为「心率区间时长 × 心率水平」估算强度，并显式禁止引用 TL/TSS/IF。

**`max_speed` 的双层缺陷**（单位之外）：

1. 库里已是 km/h（`fit-parser` 用 `speedUnit:'km/h'`），旧代码又乘 3.6 —— 20.76 报成 74.7；
2. 修好单位后仍有第二层：它是**设备瞬时峰值**，不是可持续速度。实测 `653862644` 峰值
   20.8 km/h（2:53/km）那一刻心率只有 **102bpm**、前两秒 `cadence: 0`（人在停步）——
   GPS 重捕抖动；33 条有该字段的跑步活动里 9 条超过最快分段速度 1.5 倍（最高 2.6 倍）。

故跑步分支输出时附「（设备瞬时峰值, 不代表持续能力）」限定语，缺值时整行不输出
（真实库仅 33/241 跑步活动有值，86% 是 `--`）；非跑步分支整项不输出 —— 乒乓球
8.03 km/h 是挥拍抖动（均速 0.12），羽毛球 4.23 km/h（均速 0.08）。两个 prompt 的分析
框架都**没有**最大速度这一维度，模型却会主动拿它下「冲刺能力」结论。

### 2.2 汇总页：区间与趋势优先

`GlobalCoach` 的 `days` 由页面决定，服务端用**同一区间**重新计算洞察指标：

| 页面 | 页面参数 | `days` | 口径 |
|------|---------|--------|------|
| `/` | 无 | `0` | 全部历史 + 近期趋势 |
| `/insight` | `?days=7/30/90/180/0` | 原样 | 近一周 / 近一月 / 近三月 / 近半年 / 全部 |
| `/analysis` | `?days=7/30/90/180/0` | 原样 | 同上 |
| `/stats` | `?period=week/month/year/total` | `7/30/365/0` | 周 / 月 / 年 / 全部 |

> 口径提示：`/stats` 的统计表是**自然周/自然月/自然年**，其 AI 教练使用**滚动 7/30/365 天**窗口
> （与「近一周/近一月/近一年」文案一致）；如需严格自然周期，可改用显式 `startDate/endDate`
> 调用 `/api/insight/coach`。这是为避免前端重复计算日历边界而保留的已知差异。
| 直接调用 API | body `days` | `7/30/90/180/365/0` 或 `all` | 非法值回落 30 |

上下文 =【跑者画像】+【全局洞察指标】（VDOT 趋势 / ACWR / 强度分布 / 周期化 / 有氧解耦 /
类别·气温·路线对比 / 配速-心率模型 / findings）+【区间环比】，并由 `formatInsightForCoach`
与 `formatPeriodComparison` 序列化为文本块。

**区间环比**（`period-comparison.ts`）：当前区间 vs **上一个等长区间**，输出跑量/跑步次数/时长/
平均配速/平均跑力/训练负荷的绝对值与变化率。所有指标都是**跑步口径**（`getPeriodStats` 带
`runningTypeClause`），故次数行写「跑步次数」而非「次数」—— 否则模型会以为含游泳/球类。
无上一区间活动时整段省略（不做虚假基线）；`days=0`（全部历史）无「上一区间」，自动跳过。
追问复用同一上下文（`buildGlobalCoachFollowupMessages`），前端回传 history。

---

## 3. 接口契约与测试守护

| 契约 | 实现 | 测试 |
|------|------|------|
| 活动 AI 可比样本格式 | `activity-coach-context.ts` | `tests/unit/lib/activity-coach-context.test.ts` |
| 活动 AI 取数与降级 | `activity-coach-context-service.ts` | `tests/unit/lib/activity-coach-context-service.test.ts` |
| prompt 注入顺序（画像 → 活动 → 可比样本） | `llm.ts` | `tests/unit/lib/llm.test.ts` |
| 活动 AI 路由（校验/追问/降级） | `api/activities/[id]/analysis` | `tests/unit/api/analysis-*.test.ts` |
| 汇总 AI 路由（区间/追问/回退） | `api/insight/coach` | `tests/unit/api/insight-coach-route.test.ts` |
| 区间参数（7/30/90/180/365/0/all） | `date-utils.ts` | `tests/unit/lib/date-utils.test.ts` |
| 区间环比（当前 vs 上一等长区间） | `period-comparison.ts` | `tests/unit/lib/period-comparison.test.ts` |
| 汇总 AI 页面映射 | `InsightClient` / `AnalysisClient` / `StatsClient` | `tests/unit/components|pages` |
| CI 门槛与文档漂移 | `.github/workflows/test.yml` | `tests/unit/ci/*` / `tests/unit/docs/*` |
| **统计口径：表现分析只取跑步** | `db.runningTypeClause` / `db.isRunningType`（19 处查询） | `tests/unit/lib/db-insight-integration.test.ts`（真实 SQL：趋势/区间/纪录/负荷全部排除非跑步） |
| **统计口径：活动日志保留全类型** | `getActivities` / `getMonthSummaries` | `tests/unit/lib/db-insight-integration.test.ts`（月度汇总 count 与列表 total 严格相等） |
| **统计口径：写入侧也必须筛跑步** | `scripts/garmin/backfill-vdot.js` 的 `isRunningActivity`（VDOT 与 training_load 同口径） | `tests/unit/scripts/backfill-vdot.test.js`（非跑步即便有代表性心率与 >400m lap 也不写 VDOT、旧伪值被清空；缺类型视为跑步；track/treadmill 正常计算） |
| **跑步类型判定单一来源** | `app/lib/sport.ts`（`RUNNING_ACTIVITY_TYPES` 派生 SQL + 客户端判定） | `tests/unit/lib/sport.test.ts`（类型集合/旧库空值/展示名/图标回落） |
| **MCP tool description 必须声明统计口径** | `mcp-server/tools.ts`（9 个表现分析工具写「跑步口径」、2 个活动日志工具写「全类型口径」） | `tests/unit/mcp/tool-scope-contract.test.ts`（逐项断言口径措辞、`list_activities` 不再自称「列出跑步活动」、`get_activity_comparables` 声明 `running=false` 时配速派生字段为 `null`、16 个工具均有非空 title/description） |
| **UI 不把非跑步指标当跑步指标** | `ListClient` / `ActivityDetailClient` / `RecentActivityCard` / `ActivityInsightPanel` / `ActivityTrendCharts` | `tests/unit/components/list-client.test.tsx` / `tests/unit/pages/activity-detail.test.tsx` / `tests/unit/components/recent-activity-card.test.tsx` / `tests/unit/components/activity-insight-panel.test.tsx`（非跑步不渲染「最快分段/主课均配速」卡片） / `tests/unit/components/activity-trend-charts.test.tsx`（非跑步不渲染配速/步频/步幅图） |
| **趋势卡标题不得空承诺** | `ActivityTrendCharts.trendChartTitle` / `trendChartKinds`（组件与标题共用同一判定） | `tests/unit/components/activity-trend-charts.test.tsx`（标题只列出真的会渲染的图；无海拔数据不说「海拔 趋势」） |
| **区块展示条件不得依赖单一罕见字段** | `ActivityDetailClient` 跑步动态卡（三项任一非空 + `running`） | `tests/unit/pages/activity-detail.test.tsx`（`gct_balance` 为 NULL 但触地时间/垂直摆动有值时仍渲染；非跑步即便有值也不渲染）；`tests/e2e/activity-detail.spec.ts` + 夹具按真实分布只写触地时间/垂直摆动 |
| **UI 标签必须与实际统计口径一致** | `app/page.tsx` 的「跑步天数」（数据源 `getTrainingLoads` 为跑步口径） | `tests/unit/pages/home-page.test.tsx`（标签为「跑步天数」，不得写「活动天数」——真实库 2026-10 有 16 个活动日但仅 15 个跑步日） |
| **深挖响应显式声明运动口径** | `ActivityInsightResponse.running` + `activity-insight.ts` 的 `analyzeLaps({running})` | `tests/unit/lib/activity-insight.test.ts`（非跑步不外传 `bestPaceSecPerKm`/`workAvgPaceSecPerKm`/`gradeAdjusted`；按相对心率识别强度段） |
| **AI prompt 按运动类型分流** | `llm.ts` 的 `SYSTEM_PROMPT` / `NON_RUNNING_SYSTEM_PROMPT` | `tests/unit/lib/llm.test.ts`（非跑步不出现跑步术语与配速行；prompt 不引用非跑步数据里不存在的指标） |
| **活动数据块的两类缺失** | `llm.ts` 的 `fmtNumIf` / `statRow` | `tests/unit/lib/llm-gateway.test.ts`（「该运动不产出」整项不输出、「该活动没测到」保留 `--`、有值时照常输出、无只剩标签的空行） |
| **`max_speed` 单位契约：全链路 km/h** | `fit-parser.js`（`speedUnit:'km/h'`，`enhanced_max_speed` 原样落库）/ `fetcher.py`（Strava m/s → km/h `*3.6`）/ `llm.ts`（直接 `toFixed(1)`）/ `validate-data.js`（阈值按 km/h） | `tests/unit/lib/llm.test.ts`（20.76 km/h 渲染为 `20.8 km/h`，且不含 74.7；非跑步分支同样不乘 3.6；缺值为 `--`）；`tests/python/test_fetcher_strava.py`（4.5 m/s → 16.2 km/h，与 `average_speed` 同单位）；`tests/unit/scripts/validate-data.test.js`（`distance` 按公里解释，干净数据零误报；103.5 = 28.8×3.6 被抓） |
| **AI 可比样本块按运动口径收敛** | `activity-coach-context.ts` 的 `performanceLines`（按 `insight.running` 二次把关） | `tests/unit/lib/activity-coach-context.test.ts`（非跑步不出现配速/等价平路行，口径说明改非跑步语义） |
| **同路径几何质量只统计可校验的同伴** | `activity-insight-service.ts` 的 `summarizeRouteQuality` | `tests/unit/lib/insight-services.test.ts`（无轨迹同伴不计入 `verifiedPeers`；未校验时 `routeQuality` 显式 `null`） |
| **旧库 / 坏数据一律降级不崩页** | `db.ts` 的列探测与 `getActivityTracks` / `getActivityStartGeo` / 网格通道 | `tests/unit/lib/db-degradation.test.ts`（缺列、畸形 JSON、非法坐标、非法 id 全部返回空/`null`） |
| **AI 出流回退契约头** | `coach-stream.ts`（`X-Model-Fallback` / `-Requested` / `-Used`） | `tests/unit/api/coach-stream-gaps.test.ts`（回退成功、两个断开时机、错误体读取失败） |
| **覆盖率门槛留有余量** | `jest.config.js` + `threshold-margin.test.ts` | `tests/unit/ci/threshold-margin.test.ts`（每组每项 ≥1.5pt，且不可用降门槛来满足） |

---

## 4. 已知边界与待办（按功能归类）

> 这里只记录**尚未满足的接口能力**，不按日期或开发轮次归档。

### 4.1 活动横向对比

- **位置/形状聚类已具备网格 + 路面重叠，仍有少量边界**：
  - 已实现：geohash-7 网格签名（25m 里程等距采样，最多 1200 点）、**路面重叠**主信号
    （见下）、p2–p98 抗尖峰包围盒、尺度自适应尖峰清洗（p25 段长为基准）、
    弱轨迹（<250m）保留不判定。DTW 仅作诊断量（`includeDtw` 默认关闭）。
  - **清洗顺序：先去重再判尖峰**。GPS 冻结/信号丢失会产出连续重复点；若直接在
    原始序列上判尖峰，冻结点的直接邻居就是它自己的副本（段长 0），永远不满足
    「前后两段都很长」，冻结段完全逃过清洗并把轨迹长度虚增数倍。去重后冻结段
    坍缩为一点，前后邻居变成正常点，尖峰规则才能识别。实测 2%×300m 的冻结段
    清洗后与原轨迹相似度仍 1.0、长度精确恢复。
  - **主信号：路面重叠（双向平均垂直距离）**。与配速/进度错位/采样密度无关，
    且位置敏感；归零尺度 300m。DTW 降级为诊断量（占单对开销 92% 却曾造成两类误判）。
  - 实测（348 条真实活动 / 2231 对同档候选）：同名同起点同环线 **382 对全部通过
    （100%）**；`grid=0 且 bboxIoU=0` 的假阳性从 6 对降到 **0**；总体通过率
    56.7% → 65.6%（找回的都是几何偏差 11–43m 的真实同路）。
  - 仍可能误判：两条不同环线但共享大部分路段（如绕同一公园的南北两条环线，网格
    0.2–0.3、路面偏差 150–250m）会被判为不同路线（保守方向，可接受）。
  - **同一路面但长度比 >1.8 仍会被剔除**（如单程 2.2km vs 往返 4.4km，垂直距离 0
    但距离差 2 倍）—— 由长度比硬门禁兜底，与 `filterByRouteShape` 快速剔除线同口径。
  - **成片漂移（>5% 的点连续偏移 >300m）仍无法完全区分**：这类漂移既不是孤立尖峰
    （尖峰规则按定义只删单点），也不是噪声（段长真实变长），会让长度比与 DTW 同时
    劣化（实测 10%×600m 平移 → 0.435、10%×800m 冻结 → 0.477，均低于阈值 0.55）。
    现实中 1Hz 采样下「连续 60 秒偏移 600m」意味着 GPS 完全失去定位，Garmin 通常
    直接中断轨迹；因此按保守策略不额外放宽阈值，避免把真实不同路线判成同路。
  - 旧行未回填 `route_cells` 时自动回退到起点通道；`npm run backfill:routes` 可一次性补齐。
  - **性能**（348 活动 / 237 有轨迹的生产库实测）：`buildRouteShape` 3.6ms/条、
    单对形状相似度 **0.23ms**、洞察接口 cold 290ms / 中位 191ms / p90 272ms。
    关键手段：轨迹距离用等距圆柱平面近似（真实轨迹相对偏差 p95 0.0036%）、
    `cleanTrackCoords` 直接产出相邻距离供下游复用、同一条轨迹只算一次累计里程、
    洞察服务用 `routeSignatureOf(shape)` 复用已构建形状（不再二次清洗）、
    DTW 改为按需计算（默认关闭，省掉单对 92% 开销）。
- **湿度/风/体感温度：已实测确认 FIT 无数据源（定案，不再作为待办）**。
  扫描 `/mnt/oci-block/garmin/fit` + `/home/ubuntu/project/dailysync/export/fit` 全部
  **625 个真实 FIT 文件**：`weather_conditions` 消息 **0** 个、含 `humidity` 的记录 **0** 条、
  含 `wind_speed`/`wind_direction` 的记录 **0** 条（`fit-file-parser` 认识该消息名，
  但 Garmin 设备并不写入）。`average_temperature` 可用，故已实现**温度漂移**与
  **等价平路配速**。体感温度只能接入外部天气 API（按 GPS + 时间回查），
  **当前不做伪估算** —— 用温度反推湿度会产出看似精确的假数据。
- **GAP 是估算模型**：Minetti 2002 对陡坡/越野/极端下坡误差较大；用于横向可比，
  不替代功率计/实测。坡度截断 ±30%，记录不足时返回 null。

### 4.2 AI 对话

- **对话仅存 localStorage**：换设备/清缓存即丢失。若要跨端同步，需要新增 `ai_conversations`
  表与鉴权；当前单用户场景优先级较低。
- **无服务端限流/配额**：依赖本机网关与模型回退。多用户部署前需加按 IP/会话的速率限制。
- **MCP 不提供 AI 工具**：MCP 只暴露结构化数据，AI 对话在 Web 端完成；若要让 AI 客户端
  直接调用教练，需要新增 tool 并把 LLM 凭证放在服务端，会改变当前「MCP 只读数据」的安全边界。

### 4.3 文档与工程

- `docs/README.md` 的历史项目结构章节曾长期滞后；现已按当前目录更新，后续新增模块需同步本表。
- `docs/faq.md` 的部分日期化经验条目保留（用于复盘），但**功能契约以本文档为准**。
- e2e 对 AI 流式对话仍以 mock 为主；真实网关的端到端验证依赖本机凭证，未纳入 CI。

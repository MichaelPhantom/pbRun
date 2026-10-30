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
| 训练分析 | `/analysis?days=` | 心率区间 / 配速区间 / **功率区间** / VDOT / CTL-ATL-TSB | 汇总 AI，跟随页面时间窗 | ✅ |
| 训练洞察 | `/insight?days=` | `insight.ts` / `insight-compare.ts` 实时聚合 + `findings` | 汇总 AI，跟随页面时间窗 | ✅ |
| 统计 | `/stats?period=` | `getStats` / `getPersonalRecords`（跑步口径，见 §1.1） | 汇总 AI，周/月/年/全部映射 | ✅ |
| 汇总 AI 对话 | `POST /api/insight/coach` | `insight-service.ts` → `formatInsightForCoach` | 区间指标 + 跑者画像 + 趋势 | ✅ |
| 模型目录 | `GET /api/llm/models` | `model-curation.ts` 固定白名单 | — | ✅ |
| MCP Server | `mcp-server/`（stdio） | 17 个 tools 复用 `app/lib/db.ts` 与活动深挖服务 | `get_activity_comparables` 直接返回当次可比 `contextText` | ✅ |
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
| **类型名（AI 数据块 + 详情页徽标）** | 走 `activityTypeName` 单一来源：真实库 **269/348** 条活动 `sub_sport_type='通用'`（227 跑步 + 篮球/爬楼/HIIT/跳绳/乒乓/羽毛球 42 条），旧实现 `sub_sport_type \|\| sport_type \|\| label` 让它 truthy 胜出 —— AI 数据块对 **77%** 的活动输出「类型: 通用」，详情页则并列渲染「通用」「训练」两个零信息徽标。见下方 §1.3 |
| 活动详情页概览 | 隐藏「即时跑力 / 平均配速 / 步频 / 步幅」整列（不是显示 `--`，那会让人以为数据缺失）；「平均功率」同样按字段存在性渲染 —— 真实库 107 条非跑步活动功率全为 NULL（0/107），旧实现无条件渲染会永远显示 `--` |
| 仪表盘「本月概览」 | 「跑步天数」而非「活动天数」—— 数据源 `getTrainingLoads` 是跑步口径，真实库 2026-10 有 16 个活动日但只有 15 个跑步日（多出力量训练/爬楼）；旧标签会让人以为漏了一天 |
| 仪表盘「VDOT 趋势」 | 副标题「近 N 次跑步」而非「次活动」—— `getVDOTHistory` 只含跑步（`vdot_value` 只对跑步计算） |
| `/insight` 类别分布图 | aria-label「训练类别跑步次数分布」而非「活动数分布」—— `getInsightActivityRows` 是跑步口径，分类里的 `count` 是跑步次数 |
| `/insight` 强度分布标题 | 由**实际非零区间**派生（`zoneRangeLabel`：Z1–Z5 / Z3–Z4 / Z1, Z2, Z4），旧文案写死「Z1–Z6」是空承诺；配色只有 `--z1..--z5` |
| 分析页「当前跑力」副标题 | 「近一周跑步平均」而非「近一周活动平均」—— `currentVdot` 来自 `getStats('week').averageVDOT`，是跑步口径 |
| 丹尼尔斯页「当前跑力」说明 | 「近一周跑步活动的 VDOT 平均值」并注明「只含跑步，游泳/球类不参与」—— 同源 `getStats('week')` |
| `/stats` 个人纪录「单次最长距离」 | 「单次跑步最长距离」而非「单次训练最长距离」—— `getPersonalRecords` 带 `runningTypeClause`，游泳/球类不计入 |
| 全局教练【区间环比】次数行 | 「跑步次数」而非「次数」—— `getPeriodStats` 是跑步口径，模型若读成全部活动数会误判训练频率 |
| 活动详情页分段表 | 隐藏配速与步频列，不给「最快段」徽章 |
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

#### 功率区间表：分母是「逐活动不同的 FTP」，必须显式披露参照值

`/analysis` 的第三张区间表（`PowerZoneMetricsTable` + `getPowerZoneStats`）与配速/心率
区间表**在数学上不同构**，这是设计上最容易出错的地方：

| 区间表 | 分母 | 在用户范围内唯一？ | 跨活动聚合的合法性 |
|--------|------|-------------------|-------------------|
| 配速区间 | VDOT | ✅ 单一 VDOT | 直接按区间聚合，配速可直接比较 |
| 心率区间 | MAX_HR | ✅ 单一 MAX_HR | 直接按区间聚合，BPM 可直接比较 |
| **功率区间** | **FTP** | ❌ **真实库 241 条活动 14 个不同值（338–379W）** | **只能按 %FTP 归区后聚合** |

若按绝对瓦数分桶（例如「>300W 算高强度」），同一段 320W 在 FTP 338 的活动里是 Z4
（94.7%），在 FTP 379 的活动里是 Z3（84.4%）—— 跨活动相加得到的「Z3 时长」没有物理
含义。这与心率区间当年 19 套边界、设备功率数组 16 套边界是**同一个陷阱**。

实现要点：

1. **归区用每个活动自己的 FTP**：`getPowerZoneStats` 逐 lap 调
   `resolveFtp({functional_threshold_power, power_zone_boundaries})` → `powerZoneOf(lap.average_power, ftp.watts)`。
   无 FTP 的 lap **不猜默认值**，跳过并计入 `reference.laps_without_ftp`（猜一个分母会让
   该 lap 的区间归属与 IF/TSS 全错）。
2. **聚合单位是 lap，不是逐秒**：`activity_laps.average_power` 真实库 **2943/2962** 条跑步
   lap 有值（241/241 活动），而 `activity_laps.time_in_power_zone` **0/3082 全 NULL**。
   lap 级聚合回答「Z3 跑了多少公里/多久」，逐秒推导只给占比（已在详情页
   `powerZoneBreakdown`）—— 两者互补，不重复。
3. **参照 FTP 必须标成参照**：`reference.ftp_median_watts` 是参与活动 FTP 的中位数，
   UI 列名写「参照瓦数」，表下明确「这 N 次活动共 M 个不同 FTP，350W 只是参照值」；
   否则读者会把「Z2 = 228–279W」当成所有活动通用的定义域。
4. **瓦数范围由参照 FTP 派生**（`powerZoneRanges`，下界 `ceil`）：`ceil(350×65%)=228`，
   保证「表说 Z2 从 228W 开始」与 `powerZoneOf(228, 350) === 2` 永远一致。

真实库实测（2025-01-01 ~ 2026-12-31）聚合结果生理上自洽 —— 这是「按 %FTP 归区」正确
的最强证据：平均功率 **174 → 260 → 294 → 330 → 374 W**、平均心率 **130 → 144 → 154 → 170**、
步频 **147 → 184** 全部随区间单调上升。若按绝对瓦数分桶，这四条曲线都会变平甚至倒挂。

守护：`tests/unit/lib/db-power-zone-stats.test.ts`（真实 SQL，两个 FTP 差 2 倍的活动里
**同样的 150W 分属 Z2 与 Z1** —— 按绝对瓦数分桶会立刻转红；无 FTP 的 lap 被跳过并计数；
非跑步排除；时长加权；距离米口径）、`tests/unit/api/power-zones-route.test.ts`
（缺参/格式错/起止颠倒 → 400；`ranges` 由参照 FTP 派生；参照为 null 时不编造区间表）、
`tests/unit/components/zone-tables-a11y.test.tsx`（caption/scope/徽章单行 + 参照 FTP 披露 +
「共 14 个不同 FTP」出现、单套 FTP 时不出现噪音）、`tests/unit/mcp/tool-scope-contract.test.ts`
（`get_power_zone_analysis` 必须声明「按各活动自身 FTP」「不是任何一次活动的 FTP」）。

跑步类型判定单点定义在纯模块 `app/lib/sport.ts`（`RUNNING_ACTIVITY_TYPES` /
`isRunningType` / `activityTypeLabel` / `activityTypeIcon` / `activityTypeName`）：
`db.ts` 的 SQL 片段由该常量派生，客户端组件直接用同一份判定，因此不存在
「SQL 与 UI 两套列表漂移」。

**类型名也必须单点派生**（`activityTypeName`，2026-10-27）：设备的 `sub_sport_type`
在真实库 **269/348** 条活动里是「通用」（227 跑步 + 篮球 3 / 爬楼 30 / HIIT 3 /
跳绳 3 / 乒乓 2 / 羽毛球 1），`sport_type` 里还有 `basketball` / `floor_climbing` /
`tennis` 这类**未翻译的原始枚举**和 `训练` 这类退化值。旧实现按
`sub_sport_type || sport_type || activityTypeLabel(...)` 取值，truthy 的「通用」压过
`activity_type`：

| 位置 | 旧输出 | 后果 |
|------|-------|------|
| 活动 AI 数据块「类型:」 | **269/348 条 = 通用** | 非跑步 prompt 第 3 条要求「按运动专项解读：游泳看每 100m 配速 / 力量训练看组数 / 球类看间歇密度」，类型名失效后模型只能靠活动名称猜运动 |
| 详情页徽标 | 并列渲染「通用」+「训练」两个零信息标签 | 用户看到两个不说明任何事的标签，真正有意义的「田径场」反而被淹没 |

规则（三重过滤）：`activity_type` 是**规范身份**，`sub_sport_type` / `sport_type`
只作补充细节，且必须 ① 不是退化值（通用/训练/其他/未知）；② 不是设备原始枚举
（纯 ASCII 未翻译）；③ 不是已被规范名包含的冗余（`田径场跑`+`田径场`）或上一级大类
（`track_running` + `sport_type='跑步'` → 不能得到「田径场跑（跑步）」）。
守护：`tests/unit/lib/sport.test.ts`（退化值回落 / 细节拼接 / 冗余去重 / 父类过滤）+
`tests/unit/lib/llm.test.ts`（7 种类型的数据块断言 + 「不含『类型: 通用』」）+
`tests/unit/pages/activity-detail.test.tsx`（徽标过滤退化值 + 保留「田径场」）。

### 1.2 区间只有一个口径（心率 `time_in_hr_zone` / 功率 `time_in_power_zone`）

`time_in_hr_zone` 存**本地 5 区模型**（`app/lib/hr-zones.ts`：Z1<70% / Z2<80% /
Z3<87% / Z4<93% / Z5≥93% × `MAX_HR`）下各区间停留秒数，JSON 数组长度恒为 **5**，
由 `activity_records` 的**逐秒心率**推导（`hrZoneSecondsFromSamples`），覆盖全部活动
（真实库 **348/348**）。写入侧：`scripts/garmin/fit-parser.js` 调
`scripts/common/hr-zones.js`（TS 的 CJS 镜像，parity 由
`tests/unit/scripts/hr-zones-parity.test.ts` 守护）；历史数据用
`npm run backfill:hr-zones` 回填。

**为什么不能用设备原始数组**（2026-10-27 修复的三层缺陷）：

| 缺陷 | 证据 | 后果 |
|------|------|------|
| 覆盖不全 | FIT `time_in_zone` 的 `time_in_hr_zone` 只有 **140/348** 条有值；`activity_records` 逐秒心率 **348/348** 全有 | `/insight` 强度分布只统计 33/241 条跑步活动，其余显示为空 |
| 跨活动不可聚合 | 生产库 **19 套**不同边界方案（`50/60/70/80/90/100%`、`52/62/72/82/92%`、`59/73/82/87/92%` of maxHR） | 索引 2 在一套里是「70–80%」在另一套里是「73–82%」，按索引相加的「Z3 占比」无物理含义 |
| 与 UI 口径冲突 | 同一活动同一时段：设备 7 槽给出 Z3 **49.7%**，app 5 区给出 Z3 **40.3%**（活动 653862644） | `/insight` 说「Z1–Z2 轻松 4.7%」，`/analysis` 说 72.5% —— 同一指标两个答案 |

修复后 `getHrZoneTotals` 固定返回 5 元素、`computeLoadInsight` 的
`lowIntensityPct`=Z1+Z2、`highIntensityPct`=Z4+Z5（不再把 Z6/Z7 算进高强度），
`hrZoneBreakdown`、`runner-profile` 的 28 天强度分布同源。设备原始数组保留在
`activities.device_time_in_hr_zone` 仅供追溯，任何统计/展示都不读它。

推导可靠性：推导总秒数与 `moving_time` 偏差 <10% 的活动占 **241/241**（跑步）与
**107/107**（非跑步）；暂停空档按 `HR_SAMPLE_MAX_GAP_SEC = 5s` 截断，避免暂停时间
被算进最后一个区间。真实库回填后 `/insight` 全区间强度分布为
Z1 19.5% / Z2 53.0% / Z3 16.1% / Z4 9.2% / Z5 2.2%（低 72.5% / 高 11.4%）。

> **与 §9 区间表（`/analysis`）的差异是采样粒度，不是模型**：`getHrZoneStats` 把
> **每个 lap 的整段时长**归入其平均心率所在的区间（因此能看到「Z2 平均配速 5:40」），
> 而 `/insight` 与活动详情用**逐秒心率**归区。同一批真实数据下 Z1 分别为 20.3% 与
> 19.5% —— 差异来自「一段配速不均的 lap 只能落一个区间」vs「每秒各归其区」，
> 两者都建立在同一套 `HR_ZONE_BOUNDS` 之上。不要把这两个数字「对齐」成同一个值，
> 那会牺牲区间表的 lap 级明细。

#### 功率区间同构修复（`activities.time_in_power_zone`）

功率区间是**同一个缺陷族**，数值更隐蔽：`time_in_power_zone` 原先直接存 FIT
`time_in_zone` 的原始数组，真实库只有 **33/348** 条有值（全部跑步），且数组是
**绝对瓦数**上限 —— 实测 16 套方案随 FTP 变化（`[218,267,307,338,390,4000,…]` 与
`[229,282,318,353,406,…]`），按索引跨活动相加得到的「Z3 秒数」没有物理含义。
而 `activity_records.power` 的逐秒功率在 **241/241** 条跑步活动里全有。

统一口径：`app/lib/power-zones.ts` 的 **5 区 %FTP 模型**（Z1<65% / Z2<80% /
Z3<90% / Z4<100% / Z5≥100%），JSON 数组长度恒为 **5**，由逐秒功率推导，覆盖
**241/241** 有功率的活动。写入侧 `fit-parser.js` 调
`scripts/common/power-zones.js`（TS 的 CJS 镜像，parity 由
`tests/unit/scripts/power-zones-parity.test.ts` 逐值守护）；历史数据用
`npm run backfill:power-zones` 回填（顺序纪律同心率：**先 `ALTER` 再迁移再重算**，
否则设备原始数组会被直接覆盖）。

**为什么 5 区而不是 6 区**：归一后的设备方案是 `65/80/90/100/115 %FTP`，第 5 个上界
即设备 Z6 的下界。设备 Z5（100–115%）与 Z6（>115%）都属于「阈值以上」，合并进 app
Z5；这样与 `--z1..--z5` 五个配色 token 一一对应，不引入没有颜色的第 6 区。实测 33 条
同时有设备数组的活动，按本口径推导的 5 区占比与设备数组（Z5+Z6 合并）**逐槽偏差
<5 个百分点的有 32/33** —— 即推导不是另一套语义。

**区间范围表与判定函数必须同源**：`powerZoneRanges` 的下界用 **`ceil`** 而非 `round`。
FTP 371 的 65% 是 241.15，若 round 会得到 241W，而判定函数 `powerZoneOf(241, 371)`
算出 64.96% < 65% 仍属 Z1 —— 范围表与判定函数就会自相矛盾。`ceil` 使两者恒等，
测试逐边界瓦数反查。

**读路径与写路径同源**：`powerZoneBreakdown` 首选从 `activity_records.power` 现场推导
（原始输入最新），逐秒记录缺失时才回退到落库的 `time_in_power_zone` —— 两者是同一
模型、同一长度，不会出现「库里的列」与「界面上的图」两个答案。这个回退是必要的：
同步时已经算好的结果，不该因为旧库未迁移或记录被清理就让整块从页面上消失。
设备原始数组保留在 `activities.device_time_in_power_zone`（33 条）仅供追溯，任何
统计/展示都不读它 —— 与 `device_time_in_hr_zone` 同一纪律。

推导可靠性：推导总秒数与 `moving_time` 的比值实测 min 0.86 / p50 1.00 / max 1.00；
暂停空档按 `POWER_SAMPLE_MAX_GAP_SEC = 5s` 截断（实测样本间隔 p90 158s、最大 7847s）。
真实库回填后全区间分布为 Z1 7.5% / Z2 32.0% / Z3 44.2% / Z4 13.4% / Z5 3.0%。

**展示侧两条纪律**（与心率区间同构）：标题由**实际非零区间**派生
（`powerZoneRangeLabelOfZones`，缺 Z1 的活动不写「Z1–Z5」）；FTP 必须同时可见 ——
「Z3 44%」没有分母时读者无法换算成瓦数。AI 数据块同样带 FTP
（`功率区间（FTP 371W）: …`），且非跑步按 `running` 二次把关整项吞掉。

---

### 1.3 课表（`workout_steps`）的三层解析缺陷

`workout_steps` 存 FIT `workout_step` 消息，是「这堂课本来该怎么跑」的唯一来源：
真实库 **285/348** 条活动有课表，其中 **225 条跑步活动全部**带
`target_type='speed'` 的目标配速区间。`SYSTEM_PROMPT` §2 要求「评估实际执行与
预期目标的匹配度」，而数据块与详情页此前**从未提供任何目标** —— 模型只能凭
「配速看着像节奏跑」猜计划意图。

| 层 | 缺陷 | 证据 | 后果 |
|----|------|------|------|
| ① 数据丢失 | `fit-file-parser@2.3.3` 对 `workout_step` 走 `default:` 分支（`fitObj[type] = message` 每次覆盖，不像 lap/record 那样 push） | **120/285** 条是多步课表（3/5/6/7/13/15/17/21 步），全部只剩最后一步；其中 **60 条**最后一步恰是 `cooldown` | 「节奏」课表只剩冷身步：热身与主课目标配速全丢。拿冷身目标（5:46-5:08）去比整体均速，结论必然是「区间内」，而主课 4:44-4:23 根本没跑出来 |
| ② 时间单位 | `duration_value` 在 `duration_type='time'` 时是 **毫秒**（FIT scale 1000） | 活动 536624700 落库 `duration_sec = 2400000`（≈ 27.8 天），该活动实际只有 2404 秒；**1083/1083** 个 `time` 步骤全部错 1000 倍 | 课表显示「间歇 666:40:00」 |
| ③ 速度单位 | `custom_target_value_*` 在 `target_type='speed'` 时是 **mm/s** | 落库 2944/3361 被读成「每秒 2.9 公里」，按秒/公里解释则是 **49 分钟/公里** | 目标区间完全不可读，与 `average_pace`（秒/公里）不可比 |

**修复**：

- `scripts/garmin/fit-workout.js`（新模块）用 `fit-file-parser` 内部的
  `binary.readRecord` **逐条重扫原始字节流**，拿回全部 `workout_step`。内部路径不在
  `exports` 白名单里，故 `require.resolve` 定位包入口再取同目录 `binary.js`；任何
  一步失败返回 `null`，调用方回退旧路径 —— **课表解析失败绝不影响活动主数据**。
- 单位按 FIT SDK 定义归一：时间 `÷1000` → 秒、距离 `÷100` → 米、速度 `÷1000` →
  m/s 再 `1000/v` → 秒/公里（**速度越低配速数值越大**，故 `fast` 取 `min`）。
- `fit-parser._extractWorkout(fitData, rawBuffer)` 接原始 buffer；`fit-parser` 的
  回退路径同样修正单位（旧库/坏文件也不会再落毫秒）。
- 历史行用 `npm run backfill:workout` 刷新（只 UPDATE 两列，不重写逐秒记录）。
  回填后：**285 行 / 1210 步 / 120 条多步 / 384 步带目标配速**，
  无一条 `duration_sec > 36000`（毫秒残留会立刻暴露）。

**读取端必须自己分辨代际**（`app/lib/workout.ts`）：旧格式没有
`duration_type_label`、`duration_sec` 是毫秒、只有 `target_low/high`（mm/s）；
新格式有标签与 `target_pace_sec_per_km`。判别依据是**字段存在性**而非数值猜测
（`2400` 与 `2400000` 都是合法数字，靠大小猜会误判长课表）。

**整体目标必须按步骤时长加权**（`workoutTargetRange`）：多步课表里热身/主课/冷身
目标完全不同，用任何单步当整体目标都是口径错误。加权后与「整体均配速」同口径可比，
且 `multiStep` 为真时文案显式提示「整体均速为混合强度，判定仅作参考」。

**呈现口径**：

| 位置 | 内容 |
|------|------|
| AI 数据块 | `课表: 节奏 — 热身 10:00 @ 5:46-5:08/km → 间歇 22:00 @ 4:44-4:23/km → 冷身 …` + `课表执行: 计划 5:14-4:44/km，实际 5:18 → 偏慢 4s/km` |
| 详情页「训练课表」卡 | 课表名 + 执行判定徽标（区间内 / 偏快 Ns/km / 偏慢 Ns/km）+ 逐步计划 + 实际均配速 |
| 渲染条件 | 「有**可执行步**」（有时长/距离/次数），不是「有 `workout_name`」—— 真实库 **63 条**有课表名但只有循环控制消息 |
| 非跑步 | 课表照常展示（60 条非跑步课表），但**不做配速执行判定**：0/60 有 speed 目标，且 `average_pace` 语义不同（泳池 1670s/km、乒乓 30826s/km） |
| 连续相同步 | 折叠为 `×N`（真实库大量「主课 1:00 ×5」），折叠依据是**连续且参数完全相同**，不是猜测 |

守护：`tests/unit/lib/workout.test.ts`（旧/新格式单位、多步不丢失、加权区间不等于
任何单步、三态判定、折叠、防御性）、`tests/unit/scripts/fit-workout.test.js`
（重扫字节流、单位换算、占位步过滤、文案）、
`tests/unit/garmin/fit-parser-branches.test.js`（`_extractWorkout` 有/无 raw buffer、
**调用点确实传 buffer** 的完整 `parseFitFile` 链路）、
`tests/unit/lib/llm.test.ts`（课表进数据块 / 非跑步不判定 / 空课表不输出空壳）、
`tests/unit/pages/activity-detail.test.tsx`（卡片渲染条件、三态徽标、非跑步不判定）。

### 1.4 「算出来却从不展示」缺陷族（2026-10-27）

`InsightResponse` / `ActivityInsightResponse` 的字段由服务端**全部计算出来**，但 UI
只挑了其中一部分渲染。这类缺陷的特殊之处：**类型检查通过**（字段有声明）、
**覆盖率很高**（计算分支被测过）、**页面正常渲染** —— 唯一显形的地方是「模型与用户
手上少了这个数」，因此长期靠人工审计发现。

一次全量审计（真实库全历史窗口）找出 **12 个有真实值却从未展示的字段**：

| 字段 | 真实库值域 | 后果 |
|------|-----------|------|
| `form.monthly[].strideLength` | 0.887–1.019 m | SYSTEM_PROMPT §5 要求「步频×步幅经济性」，数据块只有步频 |
| `form.monthly[].verticalOscillation` | 7.12–7.92 cm | 同 §5「垂直摆动过大 = 能量浪费」无法评估 |
| `categories.stats[].avgCadence` | 178.7 spm | 「轻松跑步频比节奏跑低多少」看不到 |
| `categories.stats[].avgTrainingLoad` | 61.0 TL | 各类课的平均负荷强度不可比 |
| `categories.totalActivities` | 241 | 类别表未声明覆盖了多少次跑步 |
| `weather.buckets[].avgCadence` | 175.2–181.8 spm | 高温代价只讲心率/配速，漏掉「步频下降」这第三个信号 |
| `routes.stravaLikeCount` | 239 | 无法判断 6 条路线榜单覆盖了多少样本 |
| `vdot.raw` | 121 个散点 | 趋势线可信度（3 点 vs 121 点）无从判断 |
| `routes[].best` | 含 `activityId` | 「最佳 5:14/km」点不到那一次 |
| `routes[].recent` | 每条路线最近 5 次 | 单看斜率无法判断是否被某次异常拉偏 |
| `gradeAdjusted.distanceMeters` / `sampleCount` | 4971 点 / 15.06km | 等价平路配速不给样本量就无法跨活动比较 |
| `temperatureDrift.minC` / `maxC` / `sampleCount` | 19–27°C | 只看首尾会漏掉中途极端值 |

**呈现口径（不得歪曲量纲）**：步幅(m)/垂直摆动(cm) 与步频(spm)/触地(ms) 差 2 个数量级，
同轴作图会把厘米级曲线压成直线 —— 故走**月度明细表**，趋势图仍只画步频与触地。
类别表新增「均步频 / 均负荷」两列，气温卡片新增步频一行，路线卡新增「N 次有地点轨迹」
徽章 + 最佳可达链接 + 最近 5 次配速链接，VDOT 卡新增「N 个样本」徽章。

**机器守卫替代人工审计**：`tests/unit/components/insight-field-consumption.test.ts`
递归展开 `InsightResponse` / `ActivityInsightResponse` 引用的全部 interface，收集
所有叶子字段名，逐个断言它作为**代码标识符**出现在消费方（UI + 教练上下文 + AI
数据块 + MCP）里。要点：

- **必须剥离注释再比对** —— 否则「注释里提过字段名」就能骗过守卫（本测试第一版
  正是被自己的注释骗过，注入验证时才暴露）；
- `ALLOWLIST` 是显式技术债账本，每条必须写理由，且反向断言「已消费的字段不得
  留在 allowlist 里」，防止账本腐化；
- 递归展开本身也要断言（`leaves.size > 50` + 抽查嵌套字段），否则解析器坏掉时
  只剩顶层 13 个字段、测试会假绿。

守护：`tests/unit/components/insight-field-consumption.test.ts`（6 例）、
`tests/unit/components/insight-components.test.tsx`（跑姿明细表 / 类别表新列 /
气温步频 / 路线可识别数 / 缺字段不编造）、`tests/unit/lib/insight-coach.test.ts`
（跑姿含步幅与垂直摆动、类别含总次数/步频/负荷、气温含步频、路线声明样本量）、
`tests/unit/components/activity-insight-panel.test.tsx`（GAP 样本量 / 温度全段极值）、
`tests/unit/pages/activity-detail.test.tsx`（分段功率列 + 非跑步不展示功率）、
`tests/unit/lib/llm.test.ts`（分段功率进 AI 数据块 + 非跑步不输出）。

### 1.5 「可推算却从未推算」缺陷族（2026-10-27）

与 1.4 是同一族缺陷的更隐蔽变体：字段**不仅没展示，连计算都没做**。库里那一列
**0/348 全为 NULL**，于是代码按「数据源从不产出」把它整项略去（这是 1.2 那条
`fmtNumIf` 纪律的正确用法）—— 但**输入其实全都在**，一算就有值。

| 字段 | DB 覆盖 | 推算依据（真实库实测） |
|------|---------|----------------------|
| `intensity_factor` | **0/348** | `normalized_power ÷ FTP`，NP **241/241**、FTP **241/241** |
| `training_stress_score` | **0/348** | `秒/3600 × IF² × 100` |
| `average_power_to_weight` | **0/348** | `average_power ÷ user_weight`，体重 **241/241** |
| `functional_threshold_power` | 33/348 | `power_zone_boundaries[3]` **恒等于** FTP（33/33 逐条相等） |
| `max_altitude` / `min_altitude` | 234/348 | 直接有值，但**零消费** |
| `max_cadence` | 247/348 | 直接有值，但**零消费** |
| `max_power` | 241/241 | 直接有值，但**零消费**（且是瞬时尖峰，需过滤） |

#### FTP 覆盖率 33 → 241 的依据

Garmin 功率区间数组形如 `[218,267,307,338,390,4000,null,null]`。实测 **241 条**活动的
前 5 个上界归一为 %FTP 后**只有一套方案**：`64–65 / 79–80 / 90–91 / 100 / 115`（差异
全在整数取整），索引 3 **恒为 1.000** —— 即 Z4 上界就是阈值功率本身。33 条同时有
`functional_threshold_power` 的活动里两者**逐条完全相等**。故缺失时回退索引 3，并把
来源标记为 `zone-boundary`（展示时不得声称「设备口径」）。

#### 三条不得越界的纪律

1. **`max_power` 不参与任何派生**。它是**逐秒瞬时峰值**：`548397123` 平均 306W、峰值
   3866W（**12.6 倍**），67kg 体重即 **57.7 W/kg** —— 世界级场地车手冲刺也只有
   20–25 W/kg。拿它算「最大功率体重比」会直接产出一个不存在的怪物数据。展示时
   `peakPower()` 过滤 >3 倍均值的传感器尖峰（241 条里 7 条被剔除），标签必须带「瞬时」。
   同一陷阱已在 `max_speed` 上踩过一次（见 §2.1）。
2. **TSS 的时间基数是 `moving_time`（timer time），不是 `duration`**。库里 `duration`
   存的是 FIT `total_elapsed_time`（含暂停），`moving_time` 才是 `total_timer_time`；
   110/348 条活动两者最多差 7845 秒。用 `duration` 会把暂停算成训练负荷。
3. **推算值必须落在生理合理区间，越界宁可不给**。241 条跑步活动实测 IF 0.42–1.06、
   TSS 5–138、W/kg 1.42–5.41，全部符合训练学常识；一旦越界说明 FTP 取错或 NP 异常，
   此时返回 `null`（`IF_MIN 0.3 / IF_MAX 1.5 / TSS_MAX 500 / W_PER_KG 0.5–15`）。

#### TSS 与 TL 是两套口径，必须同时声明

`training_load`（库内派生的无量纲负荷分，241/241）与派生的 `TSS` 并存时会出现
「TSS 41 但 TL 65」—— 不解释的话模型会当成数据矛盾并浪费篇幅核对。故数据块在
IF/TSS 行后追加固定说明：「与训练负荷 TL 是两套口径：TL 由时长×心率区间派生,
TSS 是阈值功率派生量」。

> **勘误（2026-10-27）**：`training_load` 此前被描述为「Garmin 官方负荷分」，
> 但 **FIT profile 里根本没有 `training_load` 字段**（详见下方「FIT 字段名必须
> 存在于 SDK profile」一节）。库内 241/241 的值全部来自 `sync.js` 的
> `calculateTrainingLoad` 派生，与设备无关。

#### 海拔净高差 ≠ 累计爬升

真实库 **191/234** 条活动的 `max_altitude - min_altitude` **小于** `total_ascent`。
这不是数据错误：

- `max - min` = **净高差**（最高点减最低点；环形路线回到起点就只有几十米）
- `total_ascent` = **累计爬升**（每次上坡都累加；折返路线远大于净高差）

实测 `538279608`：min 435m / max 511m（净高差 **76m**）而累计爬升 **194m** —— 一条在
435–511m 之间反复上下的小环路，两个数都对。UI 用「累计爬升」+「海拔净高差」两个
**不同标签**分格展示；AI 数据块输出 `累计爬升 ÷ 净高差` 比值（实测 0.07–5.95），
≥2 判为「短坡反复上下」，否则「单向爬升」—— 否则模型会判定数据自相矛盾。

同一字段在同一个数据块里**只能出现一次**：海拔跨度行（`海拔跨度: 最低 … / 最高 … /
净高差 …`）刻意**不写平均海拔**，平均值由下方公共行的 `平均海拔:` 单独提供。此前
两处都写「均 470m」，模型会以为存在两个不同的平均值。守护：
`tests/unit/lib/llm-gateway.test.ts` 断言 `平均海拔` 在整块里恰好出现 1 次。

实现：`app/lib/power.ts`（`resolveFtp` / `intensityFactor` / `trainingStressScore` /
`powerToWeight` / `peakPower` / `powerIntensity`）、`app/lib/elevation.ts`
（`elevationSpan` / `ascentToSpanRatio`）。两者都是**纯函数**，详情页与 AI 数据块
共用同一份数字 —— 避免「UI 一个 TSS、模型另一个 TSS」。

守护：`tests/unit/lib/power.test.ts`（28 例）、`tests/unit/lib/elevation.test.ts`（12 例）、
`tests/unit/lib/llm-gateway.test.ts`（推算进数据块 / 两套口径声明 / 非跑步不输出 /
FTP 缺失不猜 / 海拔比值 / 尖峰过滤）、`tests/unit/pages/activity-detail.test.tsx`
（概览 IF·TSS·W/kg·瞬时峰值 / 尖峰不展示 / 净高差与累计爬升分开 / 最高步频 /
渲染条件不依赖单一罕见字段 / 非跑步不展示）。

#### 覆盖率「余量」必须在门禁流程内自查（2026-10-30）

门槛（`coverageThreshold`）只保证「不低于」，**不保证有安全边际**。曾把 global branches
门槛设 88 而实测 88.07（余量 0.07pt），本地绿 CI 红。规则：每组每项余量 ≥
`min(1.5, 100-gate-0.5)`pt（`tests/unit/ci/threshold-margin.test.ts`）。

但这道守护有个**流程盲区**：`npm run test:ci` 先删 `coverage/` 再跑测试，Jest 的
门槛检查执行时产物尚不存在，threshold-margin 测试因「产物不新鲜」被 skip ——
**门槛守住了，余量侵蚀无人报告**。app/api branches 就这样滑到 0.33pt
（`insight/coach/route.ts` 加了 `surface` 分支但 mock 缺三个 db 函数，
`surface==='analysis'` 注入逻辑从未被执行）。

修法（两层）：
1. 摘要脚本 `scripts/testing/coverage-summary.js` 内建 `checkMargins`：余量不足标
   `⚠`（达标但不安全）并输出明细行 —— 门禁流程内每轮必查，不依赖运行方式。
2. 补齐真实缺口：`insight-coach-route.test.ts` 的 db mock 补 `getStats`/
   `getPaceZoneStats`/`getPowerZoneStats`，新增 `surface=analysis` 用例断言
   【区间结构】真的进入 user 消息（app/api branches 0.33pt → 4.33pt）。

#### 守卫升级：`Activity` 的 71 个字段也要机器审计

`Activity` 是数据库原始行，比 `InsightResponse` 更容易藏「有值但从不展示」。守卫扩展
到它时踩到三个真实的坑，都已写进测试注释：

1. **裸标识符匹配会互相误伤** —— `power` 会被 `power.powerToWeight`（另一个对象的
   变量名）命中。正向（必须被消费）用宽松谓词避免假红，反向（allowlist 必须保持真实）
   必须用严格谓词 `isFieldAccessed`（`.field` / `field:` / `'field'`）。
2. **反向断言必须排除 `db.ts`** —— 它把 `route_cells` / `start_lat` 写进 SQL（查询用途），
   若计入则「仅用于聚类的索引列」全被误判为「已消费」，allowlist 立刻失效。
3. **「被引用」≠「被展示」** —— `app/lib/elevation.ts` 里有 `activity.max_altitude`，
   若没人 import 它就是死代码。故消费方 = 从**展示入口**（页面/接口/组件/MCP）出发、
   沿 `@/app/...` import 做**传递闭包**能到达的文件；`types.ts` 必须排除（否则每个
   字段都自动「已消费」）。前两版守卫正是被这一点骗过（缺陷注入删掉 import 后仍全绿）。

`ACTIVITY_FIELD_ALLOWLIST` 是显式技术债账本，每条写明理由，分四类：内部记账列
（`created_at` / `updated_at` / `start_tz_offset_min` / `elapsed_time` 恒等于 duration）、
聚类索引列（`route_cells` / `route_bounds` / `route_km` / `start_lat` / `start_lng`）、
语义陷阱（`max_heart_rate_fit` 是**设备配置值**不是本次峰值；`devices` 已脱敏）、
真实库 0/348 从不产出（`average_step_rate_loss*` / `max_power_to_weight` /
`avg_pos_grade` 等 4 项）、
以及仅追溯用的设备原始区间数组（`device_time_in_hr_zone` / `device_time_in_power_zone`
/ `device_time_in_speed_zone` / `device_time_in_cadence_zone` —— 统一口径列
`time_in_hr_zone` / `time_in_power_zone` 已分别被 `hrZoneBreakdown` /
`powerZoneBreakdown` 消费，见 §1.2）。

**账本本身也要被守卫**（2026-10-27 修）。原守卫只校验一个方向：「账本里的字段不得
已被消费」。缺了「账本里的字段**是否还存在**」—— 于是 `_initDatabase` 把
`time_in_speed_zone` / `time_in_cadence_zone` 从 schema 里 DROP 之后，账本里仍留着
这两条豁免。**账本失真比缺条目更危险**：下一个人读到「这两列设备从不写入」会以为
库里还有这两列、只是没展示，而实际上它们已经不存在了。现在补三条：

- **账本的每个键都必须是真实列**（真值来源 `DatabaseManager.declaredColumns()`，
  不是再抄一遍列名）；
- **schema 的每一列都必须「被声明 或 被记账 或 被消费」** —— 不允许有列三头都不在。
  注意 `track` 属于第三类：它在 `Activity` 里没声明，但经 `getActivityTrack` 单独取
  供详情页地图/`route-shape` 使用，是**真的被消费**，不能塞进豁免账本（「被剥离」
  不等于「不展示」）。
- 反例已排除：`start_tz_offset_min` 等 6 个聚类/记账列确实不在 `Activity` 里，
  但仍在 schema 里 —— 它们留在账本里是对的。

#### `ActivityLap` 的 44 个字段也要机器审计（2026-10-27 补齐）

`Activity` 有完整守卫，但 `ActivityLap`（44 字段）**一直没有** —— lap 层可以安静地积累
同类缺陷。补守卫时一次审计就找出 **14 个零消费字段**，其中三个有真实数据：

| 字段 | 真实库 | 缺陷性质 |
|------|--------|----------|
| `cumulative_time` | 3082/3082 | 只被 `scripts/common/lap-zones.js` 用于切时间窗，UI/AI 零消费 |
| `lap_trigger` | 3082/3082 | 完全零消费（`distance` 1706 / `time` 870 / `session_end` 279 / `manual` 224 / `'15'` 3） |
| `average_moving_pace` | 2972/3082 | 零消费；**且修复时间基数后与 `average_pace` 逐条相等（2972/2972）** |

`average_moving_pace` 那条最值得记：它原本是**正确口径**（计时器时间）却从未被读，
而 `average_pace` 是**错误口径**（经过时间）却到处被读。修好 `average_pace` 之后两列
完全等价 —— 一个「正确但没人用」的列，正是「口径读错了」的化石证据。故账本写明
「历史冗余列，展示重复值无增量信息」，并有一条断言守护两条推导链仍走同一时间基数
（若哪天有人只改回其中一条，两列会重新分叉，账本里那句话就成了谎话）。

判据与 `Activity` 那份**完全一致**（同一个概念不写两套实现）：字段数精确 `toBe(44)`、
未消费必须进账本、账本必须保持真实、账本键必须是真实列、schema 每列三头必须落一头。
四个方向都做过缺陷注入验证（删账本条目 / 塞已消费字段 / 塞幻影列 / 改字段数）。

#### 配速与统计的时间基数：计时器时间，不是经过时间（2026-10-27）

这是本仓库最典型的一类缺陷：**数据都在，只是读错了列**。

`average_pace` / `average_speed` 一直由 `duration` 推导，而 `duration` 存的是 FIT
`total_elapsed_time`（**含暂停**）。于是同一个活动卡片会自相矛盾：

| 活动 | 距离 | 卡片「时长」(`moving_time`) | 卡片「平均配速」 | 配速×距离 |
|------|------|------------------------------|------------------|-----------|
| `582132079` | 6.63 km | 43.7 分 | **26:19/km** | 174.4 分 |
| `632595826` | 7.17 km | 45.8 分 | **11:17/km** | 80.8 分 |
| `621669611` | 5.24 km | 35.5 分 | **9:14/km** | 48.4 分 |
| `598287817` | 6.10 km | 45.8 分 | **9:07/km** | 55.6 分 |

**规模**：活动级 251 条有配速的里 `average_pace` **251/251 严格等于
`duration/distance`**，只有 158 条同时等于 `moving_time/distance` —— 跑步子集 19 条
偏差 >10%、4 条 >25%、2 条 >50%。lap 级更彻底：3082 个 lap 里 `average_pace`
**2972/2972** 等于经过时间口径，而 `average_moving_pace` **2972/2972** 等于计时器口径。

**证据不是「两种口径都行」**：

- 设备自己算的 `enhanced_avg_speed`（345/348 活动、3079/3082 lap 有值）是计时器口径：
  251 条里 **248 条**与 `distance/moving_time` 偏差 <2%（另 3 条是游泳，设备按划水时段
  加权）；
- Strava / Garmin Connect 展示的配速同样是计时器口径；
- 详情页「时长」格本身显示的就是 `moving_time` —— 同一张卡片里两个数必须自洽。

**修法**：口径唯一实现 `app/lib/pace.ts`（CJS 镜像 `scripts/common/pace.js`，与
`hr-zones` / `power-zones` 同一模式，一致性由 `tests/unit/scripts/pace-parity.test.ts`
逐值比对守护）。`effectiveTimeSec()` = `moving_time` 若 > 0，否则回退 `duration`
（只有没写 timer time 才发生）。同一个模块同时给出 `paceSecPerKm` 与 `speedKmh`，
两者**永远互为倒数**，不会再出现「配速按经过时间、速度按计时器」的分叉。

写入口（`fit-parser` 活动级 + lap 级、`backfill-vdot`、`sync.js`、`scripts/strava/sync.js`）
与读取侧（`db.ts` 的个人纪录 / 长跑解耦 / 配速-心率回归、`validate-data.js`）全部改走它。

**顺带修掉的同源缺陷**（同一批查询里还在用经过时间）：

| 位置 | 旧口径 | 症状 |
|------|--------|------|
| `getStats().totalDuration` | `SUM(duration)` | 「生涯总时长」把等人的时间算成训练 |
| `getPeriodStats().totalDuration` | `SUM(duration)` | 周期对比虚高 |
| `getPaceZoneStats().total_duration` + 加权权重 | `Σ lap.duration` | 同一行里区间秒数按 `moving_time` 推、总时长按经过时间累 |
| `getPowerZoneStats().total_duration` + 加权权重 | 同上 | 同上 |
| `getHrZoneStats().total_duration` | 同上 | 同上 |
| `getVDOTTrend().total_duration` | `Σ activity.duration` | 同上 |
| `getTrainingLoads().duration` | `SUM(duration)` | 首页「当月平均配速」= Σduration/Σdistance 被系统性拖慢（真实库 2026-08 偏差 **3.78%**、2026-05 3.07%），看起来像退步；周训练时长同样虚高 |
| `getInsightActivityRows().durationSeconds` | `r.duration` | 它是类别/气温分档的**心率·步频时间权重** —— 暂停多的类别（越野/含等待的团跑）会被过度加权 |
| `activity-insight` 的 `lap.durationSec` | `l.duration` | 它是 `MIN_RELIABLE_LAP_SEC` 的判据。碎片实际只跑 4 秒、停表后记 60 秒 → 60 ≥ 10 判「可信」，于是 14 m 碎片的 279 s/km 成为「最快段」，门槛形同虚设 |
| `getPersonalRecords` 的 5K/10K 插值 | `lap.duration` | 带暂停的跑会「跑出」假的慢成绩，**本该破纪录判成没破** |
| VDOT 代表段 / `training_load` | `duration` | `582132079` 按经过时间得 TL 174、按计时器得 44（4 倍） |

最硬的一条证据：`validate-data.js` 校验「区间秒数之和」时用的基准**本来就是
`moving_time`**（348 条里仅 1 条偏差 >10%）。也就是说同一行数据里「区间秒数」与
「total_duration」用的**不是同一个时间基数** —— 真实库 2958 个 lap 里 **88 个偏差
>10%**，任何「Z4 占比 = Z4 秒 / total_duration」式的内部分析都会算出 >100% 或 <0%。

**校验器本身也是缺陷的一部分**：旧 `validate-data.js` 断言
`average_pace === duration/distance` 且 `average_speed === distance/duration` —— 它把
错误口径**锁死**了，每次运行都报「251/251 正确」。**一个不可能失败的校验器比没有校验器
更糟**：它让人相信已经验证过。这与 §4.3.4 的退出码契约是同一纪律。

**回填**：`npm run backfill:pace`（`scripts/garmin/backfill-pace.js`）纯 DB 重算，
不依赖 `.cache/fit`，幂等、可 `--dry-run`。生产实测变更活动 **93** 行、lap **162** 行；
回填后跑步活动 `|配速×距离 − moving_time| / moving_time` 最大偏差 **0.0000%**
（此前 19 条 >10%），跑步 lap 的 `average_pace` 与 `average_moving_pace` **2957/2957
逐条相等**。

**夹具纪律**：`make-fixture-db.js` 原来把 `average_pace` 写成
`duration / distance`（活动 1 = 350），等于让 e2e **绕过被测代码** —— 夹具自己复刻了
那个缺陷，端到端测试永远暴露不了「读错列」。现在夹具只给输入
（`distance` / `moving_time` / `duration`），派生值一律用真实实现现场算；并刻意让
活动 1 与 lap 2 的 `moving_time ≠ duration`，否则「读哪一列」在 e2e 里测不出来。

#### 标签也必须由数据派生：`lap_index` 不是「第几公里」（2026-10-28）

上一节是「读错列」，本节是「**把存储键当成展示量**」。`activity_laps.lap_index`
是从 **0 开始的存储键**（生产库 287/287 个活动都是 `0..N-1` 连续），它只保证同一
活动内可排序，不携带任何距离含义。但旧实现把它当展示量用了四处：

| 位置 | 旧文案 | 真实库后果 |
|------|--------|-----------|
| 分段表 `#` 列 | `lap.lap_index` | 表格第一行显示 **0**，读起来像「第 0 段」 |
| 分段表徽章 | `最快 K{bestLapIndex}` | **18/242** 条跑步活动渲染成 `最快 K0` |
| 深度分析 hint | `第 ${bestLapIndex} 段` | 同上（`ActivityInsightPanel`） |
| AI 数据块 | `K${lapIndex}=Z2` | 模型收到 `K0=Z2`，当成「第 0 公里」 |

更严重的是 **`K` 这个字母本身在撒谎**。它宣称「第 N 公里」，而真实库跑步 lap 只有
**57.8%**（1714/2967）落在 950–1050 m：间歇课的 lap 是手表按**时间**切的
（`lap_trigger='time'`，870/2967 段），长度可以是 0.48 km / 0.08 km。于是：

| 活动 | 距离 / 段数 | 旧徽章 | 该段真实位置 |
|------|------------|--------|-------------|
| `650375691` | 8.31 km / 16 段 | `最快 K11` | **5.81–6.81 km**（差 5 公里，且这次跑根本没有「第 11 公里」） |
| `651707081` | 5.04 km / 14 段 | `最快 K9` | **3.63–3.72 km**（90 m 短段） |

而「每段都约 1 公里」这个前提在真实库里**几乎从不成立**：242 条跑步活动里严格
全 1 km 的只有 **1 条**（几乎每次跑都有不满整段的收尾段 —— 242 个 `session_end`
段里 237 个 < 950 m）。所以表名 `每公里分段数据`、AI 标题 `【每公里分段】`
在绝大多数活动上都是假话。

**修法**：单一实现 `app/lib/lap-label.ts`（UI 徽章 / 深度分析 hint / AI 数据块 /
表名 / AI 标题全部走它）：

1. **展示序号 = 有序列表中的位置 + 1**（`lapOrdinalAt`），由位置推导，不由
   `lap_index` 推导 —— 存储键无论是 0 基还是 1 基（历史夹具用过 1 基）都不会错位；
2. **只有每段都约 1 公里**（`isOneKmLap`，容差 ±50 m）才允许出现「每公里」/`K{n}`；
   否则表名中性化为 `分段明细数据`、徽章改写成累计区间 `最快段 5.8-6.8km`；
3. **默认用累计距离区间**（`5.8-6.8km`）—— 它与表里的「距离」列、与活动总距离
   都能自证；这也是 `llm.ts` 早就采用的写法（注释写明「K1..Kn 会误导模型以为每段
   恰为 1 公里」），此前只是 UI 侧没跟进。

区间标签本身也有**精度陷阱**（实现时被真实数据抓到）：固定一位小数在短段上会
**零宽** —— 真实库有 **7** 条活动的最快段是 45–92 m（如 `633654536` 的 45.34 m
落在 8.0–8.05 km），渲染成 `8.0-8.0km`，读起来像「零距离」。直接加位又会**虚胖**：
74 m 的段在两位小数下变成 `3.2-3.3km`（看似 100 m，放大 35%）。故判据是
「**打印宽度 ≤ 真实宽度 × 1.2**」，从一位小数起逐级加位取第一个满足者；
三位仍不满足（< 0.5 m）返回 `null`（不打印自我矛盾的区间）。实测 241 条需要区间
样式的活动：**0 条零宽、0 条虚胖**。

**为什么表名不是「分段数据」**：那与区块标题 `SectionCard title="分段数据"` 完全相同，
读屏会连念两遍，测试里 `getByText` 也会撞到两个节点 —— 表名必须能与标题区分。

**夹具掩盖了它**：单测夹具用 `lap_index: 1/2`（1 基）且每段 1000 m，恰好既看不出
0 基错位、也看不出「每公里」的假话。这与 §1.6 的 `average_pace` 夹具是同一类问题：
**夹具比生产数据「干净」时，缺陷在测试里被合法化**。故新增的断言一律用 0 基存储键
（`lap_index: 0/1/2`）+ 含残段的活动。

守护：`tests/unit/lib/lap-label.test.ts`（28 例：容差边界、空列表、两种距离字段名、
1 基/0 基定位、区间标签、越界返回 `null`、`650375691` 形态复刻）、
`tests/unit/pages/activity-detail.test.tsx`（`#` 列首行为 1 且不出现 0、每段 1 km
时徽章 `最快 K2`、有残段时徽章改成 `最快段 1.6-2.6km` 且不出现 `最快 K\d`、表名
中性化）、`tests/unit/components/activity-insight-panel.test.tsx`（hint 由 lap 位置
派生；夹具必须自洽 —— `bestLapIndex` 指向真实存在的段）、
`tests/unit/lib/activity-coach-context.test.ts`（分段主区间标签用累计区间、旧
`K0=Z2` 不得回归）、`tests/unit/lib/llm.test.ts`（AI 标题由 `lapSectionTitle` 派生）、
`tests/e2e/tables.spec.ts`（`#` 列 1 基且与行数一致，不写死具体数字）。

#### 周聚合的窗口口径：四个独立错误共用一个「周」（2026-10-28）

上一节是「把存储键当展示量」，本节是「**把窗口当数据**」。周聚合在页面上有两张
卡（「训练负荷」的周跑量趋势 + 「周期化分析」的周维度表），它们各自实现了一遍
聚合，于是同一周在两个位置可以有四个不同的答案：

| 子缺陷 | 旧实现 | 真实库后果 |
|--------|--------|-----------|
| **窗口过滤失效** | `w.week >= startDate.slice(0,7)` | `'2026-W43' >= '2026-10'` 恒为真（`W` > `1`）→ 预热窗口 28 天全混入。「近一周」显示 **6 周 / 191.6 km**，该窗口真实 **2 周 / 33.1 km**（峰值卡 54.4 vs 28.3） |
| **周量从不累加** | `byWeek.set(key, { km: 0, tl: 0, activities: 0, … })` | `periodization.weeks[].km/tl/activities` 恒为 0 → 周期化图全是 0、周表跑量/负荷/次数全是 0、峰值周/周均/增幅全部退化为 0 |
| **「次数」其实是天数** | `w.n += 1`（每个日行 +1） | 238 个跑步日里有 3 天跑了不止一次（`2026-06-11` ×3、`2026-03-11` ×2、`2025-11-18` ×2），全历史真实 242 次而页面给 **238** |
| **截断周当完整周** | 区间首尾的半周直接进峰值/周均/波动 | 30 天窗口末周只含 1 天（4.8 km）：周均 38.9 → **32.1**、周波动 σ 29.2% → **41.2%**、周均增幅 -6.85 → **-10.26**（指向一个不存在的「断崖式减量」） |

还有第五个，是修窗口时才会暴露的：**两张卡各自裁窗口**。`load.weekly` 按整周聚合、
`periodization` 只算区间内的日，于是「近一周」的 W43 在负荷卡是 **28.3 km**、在
周期化卡是 **21.6 km** —— 同一页面上同一周两个跑量，两张卡看起来都自洽。

**修法**（四条纪律）：

1. **周键只有一个实现**：`app/lib/date-utils.isoWeekKey`。此前四份拷贝分别住在
   `insight.ts` / `insight-compare.ts` / `insight-service.ts` / `date-utils.ts`，
   各自维护「同一活动属于哪一周」。其余三处改为 re-export。
2. **窗口判定必须比较日期，不能比较字符串**：`isoWeekBounds(weekKey)` 给出周一/周日，
   `isoWeeksBetween(startDate, endDate)` 给出与区间相交的全部周。任何调用方都不得
   自己写 `week >= startDate.slice(0,7)`。
3. **周聚合只有一个实现**：`insight.aggregateWeeklyLoad(daily)`。两张卡都走它，
   `computeLoadInsight` 与 `computePeriodization` 因此对同一周必然给出同一组数字
   （真实库 7/30/90/180/365 天窗口实测 **0 处不一致**）。
4. **次数与天数分离**：`DailyLoad.runs` / `TrainingLoadPoint.runs` 由 SQL 的
   `COUNT(*)` 提供，聚合层只做加法。日聚合行存在即意味着当天至少跑了一次，故
   `d.runs ?? 1` 兜底（兜底成 0 会凭空产生「有跑量、0 次」的怪行）。

**区间内的每一个 ISO 周都必须出现**，零跑量周也不例外。旧实现只列「有数据的周」，
休息周直接从图和表里消失：跑量曲线看似连续、周均偏高（全年含零周 40.48 km vs 仅
出现周 41.25 km），而「掉到 0 又爬回来」这段最该被看见的断崖被抹平了。休息周是
训练结构的一部分，不能被聚合悄悄抹掉。

**但「数据存在之前」的周不是休息周，必须夹紧**（2026-10-30）。`days=0`（全部历史）的
区间起点是合成值 `2000-01-01` —— 直接枚举 ISO 周会得到 **1401 个周**，其中 1349 个是
数据尚未产生的空周。后果不是「图更长」，而是**统计量被稀释**：

| 窗口 | 周均跑量 | `statsWeekCount` | AI 指标块 |
|------|---------|------------------|-----------|
| 全部历史（未夹紧） | **1.5 km** | 1399 | **41,066 字符**（其中周训练量一行 38,151） |
| 全部历史（夹紧后） | **42.0 km** | 51 | 4,640 字符 |
| 近一年 | 42.0 km | 51 | 4,640 字符 |

同一页面上「全部历史」把周均从 42 km 砍到 1.5 km，而卡片看起来完全自洽（有基数、
有 μ 与 σ）。夹紧实现是 `insight.effectiveWeeklyStart(daily, startDate)`：取
`max(区间起点, 首个有数据的日期)`，两张周表共用。

夹紧**不违反**「零跑量周也要出现」——那条规则针对的是训练区间内的休息周；数据存在
之前的周不是「休息」，而是「没有数据」。区间内的零周照常出现（有专门用例）。

另外 AI 上下文的「周训练量」**限长**：26 周以内全列（近期节奏要完整），超过 30 周
才折成「最近 26 周逐周 + 更早的合计/周均/零跑量周数」（避免「27 周 → 26+1」这种
只折一周的噪音）。

**「全部历史」的区间标签也要改写**：`2000-01-01` 是合成起点，直接进 prompt 会让模型
以为这是 26 年训练史（进而说「你训练了二十多年」）。`formatInsightForCoach` 对合成起点
输出「数据区间: 全部历史（至 YYYY-MM-DD）」。


**截断周必须显式标记**：`PeriodizationWeek.partial` 为真时周键后加 `*`、表格行
`title` 说明「该周被所选区间截断」。峰值/周均/增幅/波动 σ 只在**完整周 ≥ 2 个**时
用完整周计算（`statsBasis: 'complete'`）；不足 2 个完整周（如「近一周」）退化为
全部周，并把口径写进 `statsBasis: 'all'` + `statsWeekCount` —— UI 卡片 hint 与教练
上下文都必须声明「按 N 个（含截断）周统计，截断周跑量偏低」。模型若不知道这一点，
会把「末周只有 1 天」读成「断崖式减量」并建议加量。

**「峰值周」只有一个答案，且两条周序列的截断标记必须同源**。页面上有两处显示
峰值：训练负荷卡的「峰值周跑量」与周期化卡的「峰值周」。旧实现里前者自行对
`load.weekly` 取 max（含截断周），后者用 `periodization.peakWeekKm`（只用完整周）——
真实库 **4 个窗口**两卡给出不同数字（`2026-04-28..2026-05-27`：49.6 vs 46.9，
差的正是被截断的 W18）。现在峰值由服务端单点派生 `PeriodizationInsight.peakWeek`
（与 `peakWeekKm` 同一个 reduce 选出），两卡都读它。

同一张卡内部还有第二个矛盾：**趋势图最高的柱可能来自截断周**，而峰值卡片只统计
完整周 —— 用户看到「图最高柱 ≠ 卡片峰值」却无从判断。故 `LoadInsight.weekly[].partial`
与 `PeriodizationWeek.partial` 同一判定、同一取值，图表 x 轴标签后加 `*` 并渲染一行
图例说明；教练上下文的「周训练量」块同样输出 `(截断)`。真实库扫描 **540 个窗口**
（10 个月 × 9 个起点 × 6 种跨度）：`peakWeek.km ≡ peakWeekKm` 且两条序列的 `partial`
逐周一致，**0 处不一致**。

守护：`tests/unit/lib/date-utils.test.ts`（`isoWeekKey` 与 `periodKeyOf(week)` 同源、
`isoWeekBounds` 跨年周/非法键、`isoWeeksBetween` 含首尾截断周/逆序空数组、旧字符串
过滤必然多算周的判别式）、`tests/unit/lib/insight-compare.test.ts`（预热隔离、零跑量周、
截断周标记、完整周统计基础、次数≠天数、缺省 range 退化）、
`tests/unit/lib/insight-branches.test.ts`（一天两练不被压成一次、缺 `runs` 兜底 1）、
`tests/unit/lib/insight-services.test.ts`（`load.weekly` 只含相交周、周期化不吃预热、
两张卡逐周一致）、`tests/unit/components/insight-components.test.tsx`（截断周标 `*`、
`statsBasis='all'` 的口径注脚、`complete` 时不制造噪音）、
`tests/unit/lib/insight-coach.test.ts`（逐周序列含休息周与截断标记、口径声明、
周训练量块的 `(截断)` 后缀）。
9 处缺陷注入全部转红（窗口过滤 / 周期化丢 range / 次数改回天数 / 丢零跑量周 /
截断周进统计 / 只保留完整周 / 周边界少一天 / UI 自行取 max / peakWeek 不同源 /
图表漏标 `*` / 图例缺失）。

**夹具掩盖了它**：`insight-components.test.tsx` 手工喂 `periodization` 的
56.8/46/0.8/12，而真实服务的 `km` 恒为 0 —— 夹具比服务「干净」，缺陷在测试里被
合法化。这与上一节 `lap_index` 的 1 基夹具、以及 §1.6 的 `average_pace` 夹具是
同一个机制（见 `docs/testing-strategy.md` §6.5）。

#### CTL/ATL/TSB 的预热窗口与参考日：同一个「体能」有四个答案（2026-10-28）

上一节是「同一周在不同卡上两个跑量」，本节是「**同一天在不同页面四个体能**」。
CTL/ATL/TSB 是 EWMA（τ = 42 / 7），而 EWMA **从 0 起递推**，n 天后初始值残留的
误差约为 `e^{-n/τ}`。旧实现里每个消费方各自决定预热多久：

| 消费方 | 旧预热 | 残差 | 真实库 CTL@2026-10-28（收敛值 48.9） |
|--------|--------|------|--------------------------------------|
| `/insight` 周期化（为 ACWR 定的 28 天） | 28 天 = 0.67τ | **51%** | **24.3** |
| `/analysis` 训练负荷卡 | 90 天 = 2.1τ | 11% | **42.3** |
| 首页 Fitness 卡 | 120 天 = 2.9τ | 5.5% | **44.9** |
| 跑者画像（注入 AI） | 120 天 = 2.9τ | 5.5% | **44.9** |

同一天、同一概念（「我的体能是多少」），四个页面给出 24.3 / 42.3 / 44.9 / 44.9。
更糟的是**曲线形状**：预热不足时 EWMA 从 0 爬升，于是任何窗口的前几周都会被画成
一条陡峭的「体能上涨」。90 天窗口实测：

| | 首周 CTL | 末周 CTL | 涨幅 |
|---|---|---|---|
| 旧实现（图上看到的） | 32.7 | 51.1 | **+18.4（+56%）** |
| 收敛值（真实的） | 48.6 | 55.3 | +6.7（+14%） |
| 修后 | 48.4 | 46.3 | **−2.1** |

模型读到的是一条不存在的「体能大幅提升」，据此建议加量 —— 而真实体能其实在缓慢
下降。**这不是精度问题，是幻觉来源。**

第二个子缺陷：**序列终点是最后一个训练日，不是参考日**。休息日没有训练行，
`toContinuousDays` 就停在最后一个训练日，于是卡片显示的是**昨天的疲劳**。真实库
2026-10-27 之后休一天：停在训练日 → ATL 30.2 / TSB +17.3；算到今天 → ATL 26.2 /
TSB +20.2。TSB 是「今天有多新鲜」，差一天就已是另一个结论；连休一周时卡片会整整
落后一周，还显示「疲劳」而人早已恢复。

**修法**（三条纪律）：

1. **预热天数只有一个常量**：`training-load.TRAINING_LOAD_WARMUP_DAYS = ceil(5·CTL_TAU) = 210`
   （残差 0.67%），取数起点只有一个实现 `trainingLoadFetchStart(startDate)`。任何页面
   都不得自己写 `subDays(start, 90)` / `-120` / `-28`。ACWR 需要的 28 天是**另一个**
   窗口，两者取更长者，不得混用（`computeLoadInsight` 按年龄回溯，多余历史无影响）。
2. **序列必须补零到参考日**：`computeTrainingLoads(points, endDate)` 把序列延伸到
   `endDate`，返回的 `ctl/atl/tsb` 即**该日**的值。所有调用方都要传参考日
   （首页 `todayLocalDate()`、分析页 `endDate`、洞察服务 `endDate`、跑者画像活动日）。
3. **参考日本身必须是本地日期**：首页旧实现用 `ymd(now)`（UTC）而月份用本地
   `getMonth()` —— 本地 00:00–08:00 之间两者不是同一个日历，参考日会退到前一天。

修后真实库四处一致（3 年基线 46.34）：首页 46.01 / 分析页 46.17 / 跑者画像 46.01 /
洞察周期化末周 46.1，**最大误差 0.72%**；4 种窗口（7/30/90/180 天）的周期化周 CTL
最大误差 0.66%。

**顺带补上 AI 消费**：`PeriodizationWeek.ctl/atl/tsb` 此前只在 UI 周表里出现，从未
进入教练上下文 —— 而「我是变强了还是疲劳了 / 什么时候能比赛」只能由它们回答
（ACWR 是负荷**比**，不是体能/疲劳的**绝对量**）。现输出一行
`训练负荷(EWMA): CTL 46.3 ATL 26.2 TSB +20.1（新鲜） 截至 2026-W43(截断)`。

守护：`tests/unit/lib/training-load.test.ts`（`TRAINING_LOAD_WARMUP_DAYS ≥ 5τ`、
`trainingLoadFetchStart` 逐值、28 天预热会画出假上涨而 210 天平、210 天与 700 天基线
CTL 差 < 1%、`endDate` 补零/不截断/缺省三种形态）、`tests/unit/lib/insight-services.test.ts`
（取数起点 ≡ `trainingLoadFetchStart`、长历史恒定负荷下显示首周 CTL 已收敛到 ~50）、
`tests/unit/pages/analysis-page.test.tsx`（预热 ≡ 常量 且 ≠ 90、休息 3 天后曲线与卡片
都算到参考日）、`tests/unit/pages/home-page.test.tsx`（参考日 = `todayLocalDate()`、
预热 ≡ 常量 且 ≠ 120）、`tests/unit/lib/runner-profile.test.ts`（活动日为参考日、
预热 ≡ 常量 且 ≠ 120）、`tests/unit/lib/insight-coach.test.ts`（EWMA 行取末周值、
截断标记、不得取首周）。5 处缺陷注入全部转红（预热 210→90 / 洞察服务回到 28 天 /
序列停在训练日 / 教练上下文取首周 / 首页回到 120 天）。

#### 「均配速」不是一个平均值：比值的平均 ≠ 总量之比（2026-10-29）

上一节是「窗口取错了」，本节是「**权重用错了**」。全站有 9 处要算「一组活动的
平均配速/心率/步频/步幅」，其中 6 处用的是 `AVG(列)`（各次活动该列的平均）。
这是 *mean of ratios*，只有当每次跑的距离/时长完全相同时才等于这段时期的配速。

真实库的形态让这个假设彻底失效 —— 近 7 天只有两次跑：

| 活动 | 距离 | 配速 |
|------|------|------|
| `655766038` 恢复跑 | 4.76 km | 7:26/km |
| 常规跑 | 15.06 km | 5:31/km |

- 「各次配速的平均」= **6:28/km**
- 这两次合起来：19.82 km / 7100 s = **5:58/km**

差 **30 s/km（8.4%）**，方向永远偏向「你比实际更慢」（Jensen：`mean(1/v) ≥ 1/mean(v)`）。
全窗口实测：

| 窗口 | `AVG(average_pace)` | `Σt/Σd` | 偏差 |
|------|--------------------|---------|------|
| 近 7 天 | 388.3（6:28） | 358.3（5:58） | **+30.0 s/km（+8.4%）** |
| 近 30 天 | 365.0（6:05） | 358.6（5:59） | +6.4 s/km（+1.8%） |
| 2026-06 | 388.5 | 365.5 | +23.0 s/km（+6.3%） |
| 2026-03 | 358.1 | 344.9 | +13.2 s/km（+3.8%） |
| 近一年 | 355.8（5:56） | 350.6（5:51） | +5.3 s/km（+1.5%） |

同一族还有三个：

| 量 | 错误权重 | 正确权重 | 真实库近 7 天 |
|----|---------|---------|--------------|
| 心率 | 等权（`AVG`） | 时间 | 135.0 → **139.8 bpm** |
| 步频 | 等权 | 时间 | 177.0 → **181.4 spm** |
| 步幅 | 等权 | 步数（Σ距离/Σ步数） | 0.890 → **0.918 m** |

短间歇的心率/步频更高、步幅更小，等权会把它们当成常态 —— 而近 7 天正是教练最
常看的窗口。这四类量在 9 处消费方里口径各不相同：`getStats` / `getPeriodStats`
（SQL `AVG`）、`computeCategoryComparison`（时长加权）、`computeWeatherComparison`
与 `computeRouteComparison`（等权 `mean`）、`runner-profile`（等权）、
`activity-insight` 的组均/同类均值（等权）、`activity-environment` 的同温档均值（等权）。
于是**同一个概念最多有四种答案**。

**修法**：`app/lib/pace.ts` 新增四个唯一实现 —— `groupPaceSecPerKm`（Σt/Σd）、
`groupHeartRate`（Σhr·t/Σt）、`groupCadence`（Σc·t/Σt）、`sampleSeconds`
（秒数：显式值优先，否则由 `配速 × 距离` 精确还原）。选 Σt/Σd 而不是「距离加权
平均配速」不是口味问题，它有两个别的口径没有的性质：

1. **可从展示出来的数字自证**：均配速 ≡ 总时长 / 总距离。用户拿卡片上另外两个
   数字就能验算 —— 这条不变式现在是测试断言。
2. **可组合**：把窗口切成子区间，再由子区间的 (Σt, Σd) 合并，结果不变。
   时长加权平均配速不满足（父区间无法由子区间还原）。

**区间表还多一层自相矛盾**：心率/配速/功率三张表都把 `total_duration`、
`total_distance`、`avg_pace` 并排展示，但 `avg_pace` 是**逐 lap 加权均值**，
与该行自己的总量无关。真实库心率区间 Z1 行：表里写 406.0，而 12.34 小时 / 114.4 km
= **388.1** —— 差 18 s/km，同一行两个答案。现在 `avg_pace` 直接由该行的
`total_duration / total_distance` 推出（配速表同样），实测 60 行心率区间 + 5 行配速
区间的最大偏差 **0.000000**。

顺带发现并修掉：`getHrZoneStats` 的步频/步幅/心率原本是**逐 lap 简单平均**
（连时长加权都不是）；改成时间加权后先用行为断言抓出一个真 bug —— 三个量共用
一个权重分母，导致步频 161.4 被算成 53.8。

守护：`tests/unit/lib/pace-group.test.ts`（14 例：判别式 ≠ 算术平均、可组合性、
算术平均不可组合、`seconds` 缺失由 pace×distance 还原、显式 seconds 优先、非法样本跳过）、
`tests/unit/lib/db-group-avg.test.ts`（真实 SQLite：7 例统计聚合 + 2 例区间表行内自洽，
夹具刻意让 20 km 与 4 km 悬殊）、`tests/unit/lib/insight-compare.test.ts`（类别/气温/路线
三处都断言 Σt/Σd 且 `not.toBeCloseTo(等权平均)`）、`tests/unit/lib/insight-compare-branches.test.ts`
（`average_pace` 缺失但距离/时长存在 → 仍可算；距离缺失 → null）、
`tests/unit/lib/activity-environment.test.ts`（同温档 5 km vs 15 km 的判别式）、
`tests/unit/lib/runner-profile.test.ts`（4 km/420 + 20 km/340 → 350 而非 380）、
`tests/unit/lib/pace-zone-stats.test.ts`（行内自洽 + 计时器列全缺时由配速还原）。

**顺带补齐两处残留**（同一族，2026-10-29）：

1. `analyzeLaps` 的**主课平均心率**原本是逐 lap 简单平均 —— 200 m 的冲刺段与
   3 km 的阈值段等权。真实库 213 条有主课的跑步活动里 **55 条**相差 ≥0.5bpm，
   最大 **20.7bpm**（活动 `568320983`）。现按 lap 计时器时长加权（缺失时由
   `配速 × 距离` 还原），与心率区间表/类别对比同一口径。
2. **区间平均跑力（VDOT）刻意保持算术平均**，并在代码里写明理由与实测：
   30/90/365 天窗口下等权 41.40/39.77/39.35 vs 距离加权 41.12/39.58/39.39，
   最大差 0.37（<1%）—— VDOT 是「每次跑等价能力」的**估计值**而不是速率，
   合并估计值的标准做法就是算术平均；按距离加权会让长距离跑主导（其 VDOT
   天然偏低），把「当前跑力」系统性压低。真正的契约是**两处实现必须相等**：
   `getStats().averageVDOT` ≡ `getPeriodStats().avgVDOT` ≡ `insight.vdot.mean`。

**夹具又一次掩盖了它**：`insight-compare.test.ts` 里 `{ distanceKm: 7, durationSeconds: 2520,
avgPaceSecPerKm: 350 }` 三个数互相矛盾（350×7=2450≠2520），而 `WeatherSample` 的夹具
干脆没有 `distanceKm` —— 改完口径后那些字段算出 `null`，测试**照样全绿**（因为没人
断言它们）。这与 §1.6 的 `lap_index` 1 基夹具、`periodization` 手写 km 是同一个机制
（见 `docs/testing-strategy.md` §6.5）。

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

#### 追问建议必须与所在能力同域（2026-10-30）

单次活动页在分析完成后会给出 3–5 条**一键追问**（`followup-suggestions.ts`）。这些建议
会被直接发给**单次活动**教练，而该教练的提示词写着「你只负责这一次训练；跨多次活动的
统计与周期化不在这里做，越界问题请指向汇总页/洞察页教练」。旧实现却在推荐统计类问题：

| 旧建议 | 越界原因 |
|--------|---------|
| 「我的训练强度结构是否合理？需要增加轻松跑吗？」 | Z4+Z5 占比是**近 28 天聚合**，不是这一次的 |
| 「以我目前的进步速度，下一个目标应该定多少？多久能达成？」 | 目标设定 / 周期化 |
| 「我距离下一个 PB 还有多远？」 | PB 是历史最好成绩，属于统计页 |

用户点了系统推荐的问题，教练要么违反自己的边界（口径不一致），要么拒绝（体验荒谬）。

修法：建议**只覆盖这一次的执行、这一次的代价、下一次怎么练**；同时把
`intensityZ45Pct`（近 28 天区间占比）从输入里删掉 —— 没有这个信号就生成不出越界问题。
另：**安全兜底（伤病风险）永远保留**，不再被上下文建议挤掉（旧实现最后统一 `slice(0,4)`）。

守护：`tests/unit/components/followup-suggestions.test.ts` —— 一条反向断言遍历 5 种场景，
禁止任何建议出现 `PB / 下一个目标 / 多久能达成 / 赛季 / 3 个月 / 长期规划 / 月跑量 / 周均 /
训练结构是否合理`。

#### 「最快段 / 主课」只认配速可信的分段（`MIN_RELIABLE_LAP_SEC`，2026-10-27）

`average_pace = 计时器时间 / (distance/1000)`（口径见 §1.6「配速的时间基数」）。分母很小时
**秒级取整**就把结果推得离谱：真实库 `540880879` 的收尾段是 `14.32 m / 4 s` →
**279 s/km**，而同一次跑其余每公里都在 318–331 s/km。这不是「这一段跑得快」，是
`duration` 只有 4 个整数刻度、`distance` 只有 2 位小数带来的量化噪声。

后果不止一个数字错 —— 它会**污染结论**：

| 表现 | 真实库规模 |
|------|-----------|
| 分段表「最快段」徽章指到一个 4 秒碎片 | 8/241 条跑步活动 |
| 「快于基准 8%」判 `work`，碎片被当成**主课** → UI/AI 被告知「主课 1 段 / 主课均配速 4:39」，而实际是一次匀速 5:18 慢跑 | 4 条（`540880879` / `545577281` / `555458865` / `586992075`） |

修法是**按时长设门槛**（`MIN_RELIABLE_LAP_SEC = 10` 秒），而不是按距离：

- 距离门槛会误伤真实短间歇 —— 库里有一批 **15 秒 / 74 m** 的间歇（`543401371` 等），
  配速 216 s/km 是**真的**，用 100 m / 200 m 门槛会把它们整段剔除，主课反而识别不出来。
- 误差与**时长**直接相关：4 s ≈ ±25%，15 s ≈ ±7%，10 s 正好在「排除尾段碎片」
  与「保留真实短间歇」之间。

门槛作用于三处（同一常量，避免各写一遍）：`work` 角色判定、最快段挑选、角色基准
`baseline` 的均值（否则碎片会把基准拉低，正常段反被判成「慢」，整张表角色都偏）。
实测 241 条跑步活动：8 条最快段修正、8 条主课段数修正、**0 条失去徽章**（总有可靠段
可选）。时长缺失时按「可信」处理 —— 宁可保留，不因字段没传就把整张表判成无最快段。

**同一概念只能有一份实现**：详情页曾用 `laps.forEach` 自己再算一遍「最小
`average_pace`」，与 `analyzeLaps` 并存 —— 徽章走本地口径、下方「深度分析」面板走
服务端口径。两套当时恰好一致，但任一侧加了过滤就会**同页自相矛盾**。现页面以
`lapAnalysis.bestLapIndex` 为准，仅在 insight 拉取失败时退回本地口径（保证渐进增强
失败时徽章不消失）。

#### 活动数据块的「缺失」分两类（2026-10-27）

真实库 348 条活动逐字段审计后，两类缺失必须区别处理 —— 统一写成 `--` 会制造噪音：

| 类别 | 判定 | 输出 | 实例（真实库） |
|------|------|------|---------------|
| **该运动不产出** | 写入口就限定运动类型，或设备/平台根本不写 | **整项不输出**（连标签） | `training_stress_score` / `intensity_factor` / `average_power_to_weight` / `avg_grade` **0/348**；非跑步的 `average_power` / `normalized_power` / `training_load` / `avg_altitude` / `average_temperature` **0/107** |
| **该活动没测到** | 数据源支持，只是这次没有 | 保留标签 + `--` | `vdot_value` 120/241 为空、`max_speed` 305/348 为空、非跑步的 `average_speed` 97/107 为空 |

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

**`RecordSample.speed` 的同一陷阱**（2026-10-27）：逐秒 `speed` 的存储单位是 **km/h**
（`activity_records.speed`，`fit-parser` `lengthUnit='km'`；实测 `average_pace` 313.7 s/km
的活动，逐秒 speed 落在 9–15），但 `computeDecouplingPct` 的有效样本过滤写的是
`speed > 0.5`，注释却写 `0.5 m/s`。实际生效的是 **0.5 km/h ≈ 0.14 m/s** —— 等红灯的
GPS 漂移、起终点的静止采样都被判为「有效移动」，混进前后半段的 Pa:HR 均值。

真实库 241 条跑步活动逐秒 speed 范围 0.806–37.3 km/h，其中落在 0.5–1.8 km/h
（起跑/步行段）的样本 **335 条**，正是旧阈值会误收的部分。修复：导出
`MIN_MOVING_SPEED_MS = 0.5` 与 `MIN_MOVING_SPEED_KMH = 0.5 × 3.6 = 1.8`，
**换算只发生一次**，调用方只用 km/h。守护：`tests/unit/lib/insight.test.ts`
（静止样本 1.0 km/h 不计入 → 返回 null；1.79 km/h 排除、1.81 km/h 收下；
两个常量 3.6 同步）。这条与 `max_speed` 同一纪律：**数字必须带单位名**，
否则「0.5」在两个文件里可以指两种量。

**schema 注释也是契约的一部分**（2026-10-27 修）。`scripts/common/db-manager.js`
的建表注释曾写 `speed REAL -- 速度（米/秒）` / `distance REAL -- 累计距离（米）`，
而 `fit-parser` 用 `lengthUnit='km'` / `speedUnit='km/h'` **原样**写入 —— 注释与
真实数据差 **3.6× / 1000×**。这不是无害笔误：注释是下一位读者唯一的单位来源，
解耦 `computeDecouplingPct` 就曾按注释写 `speed > 0.5`（以为 m/s），实际生效的是
**0.5 km/h ≈ 0.14 m/s**，把等红灯的样本当成「在跑」。现注释改为
「速度（公里/小时）」/「累计距离（公里）」，并注明单位由 `fit-parser` 的
`lengthUnit`/`speedUnit` 决定。守护：`tests/unit/common/db-manager-units.test.js`
（三向对账：解析器配置 = 注释表述、旧错位表述不得回归、模块可加载 —— 注释写在
模板字符串里，写进反引号会直接语法错误、整张表都建不出来）。

**`pace` 与 `speed` 是两个独立派生量，不是同一数据的两种写法**（2026-10-27 审计确认）：

`activity_records` 同时有 `pace` 与 `speed` 两列，两者对同一秒常不相等（720,901 条
同时有值的记录里，中位差 **0.40 s/km**、p90 **4.5**、p99 **11.8**，6.2% 超过 5 s/km）。
这不是数据错误，而是**两条不同的推导链**：

| 列 | 来源 | 公式 | 语义 |
|----|------|------|------|
| `pace` | 步频 × 步幅 | `60000 / (cadence × step_length)`，窗口 180–900 s/km | 由**跑姿**反推的「步幅效率配速」 |
| `speed` | GPS / 加速度计 | `enhanced_speed` 原样（km/h） | **实际地面速度** |

实测 `pace` 与 `60000/(cadence×step_length)` 在 20000/20000 条采样里**完全相等**
（误差 <0.15 s/km），证明 `pace` 确实只由跑姿派生；而 `speed` 与 `3600/pace` 的差
正是「步幅推算」与「GPS 实测」的差（GPS 漂移、弯道、坡度、步幅传感器误差）。

因此：**不要「修」这个差异**，也不要拿 `pace` 去校验 `speed`。选择纪律：

- 需要「实际移动速度」→ 用 `speed`（解耦 `computeDecouplingPct`、等价平路 `gradeAdjustedPace`）；
- 需要「跑姿效率」→ 用 `pace`（趋势图配速曲线、分段配速）；
- 需要「配速」的人类可读值 → 用活动级 `average_pace`（秒/公里），它不是逐秒 `speed` 的均值。

还有 43,681 条记录只有 `speed` 没有 `pace`（236 条活动，其中 225 条是跑步）——
原因同上：这些秒里 `cadence` 为 0 或 `step_length` 缺失（走/停/传感器缺项），
`pace` 的派生前置条件不满足，而 GPS 仍在记录速度。这是**正确的缺失**，不是漏洞。

#### FIT 字段名必须存在于 SDK profile（2026-10-27 审计，19 个死读站点）

前两节讲的是「同一数据的两种口径」。这一节讲更底层的一类：**解析器读的字段名
在 `fit-file-parser` 的 profile 里根本不存在**。

`_safeGet*(msg, 'field')` 对不存在的键返回 `null`，**不抛错、不打日志**。于是：
多数站点都写了 `?? this._safeGet*(msg, '<正确名>')` 兜底，看起来在工作（值确实进了库），
缺陷完全静默；少数站点没有正确兜底，那列就永久 NULL —— 而 UI/AI 以为是「设备不写」。

审计方法：从 SDK 的 `FIT.messages` 运行时 introspect 每个 message 的字段名集合，
按解析器的局部变量映射回 message，逐站点校验。共发现 **19 个死读站点、12 个不存在的字段名**：

| 读的字段名 | SDK 里的正确名字 | 真实库后果 | 处理 |
|-----------|-----------------|-----------|------|
| `avg_stride_length`（活动+lap） | `avg_step_length` | 有正确兜底，348/348 走兜底 | 删除死名 |
| `avg_ground_contact_time`（活动+lap） | `avg_stance_time` | 有正确兜底，348/348 走兜底 | 删除死名 |
| `avg_gct_balance`（活动+lap） | `avg_stance_time_balance` | 兜底存在但**设备 348/348 不写** → 列恒 NULL | 删除死名，保留正确名读取 |
| `avg_power_to_weight` / `max_power_to_weight`（活动+lap） | 无 | 0/348、0/3082；已由 `app/lib/power.ts` 派生 | 删除死名 |
| `avg_step_rate_loss` / `_percent`（活动+lap） | **无任何对应字段** | 0/348、0/3082 | 删除死读 |
| `avg_pace_gap`（lap） | **profile 里没有任何 pace/gap 字段** | `activity_laps.average_pace_gap` 0/3082 | 删除死读 |
| `best_lap_time`（lap） | 只有 `best_lap_index`（**索引不是时间**） | `activity_laps.best_pace` 0/3082 | 删除死读 |
| `training_load` / `training_load_score` / `acute_training_load` | 无；真实存在 `training_load_peak` | `training_load` 241/241 全部来自 `calculateTrainingLoad` 派生 | 删除死读，见下 |

**为什么 `training_load_peak` 不能接线**（这是本节最容易犯的错）：它确实在真实 FIT 里
（348/348 有值，如 `2918977`），但**与库内 `training_load` 不是同一个量**：

- 量级差 5 个数量级（`2918977` vs `~50`），且 `scale: 1` 表示**没有小数缩放**；
- 除以 65536 后与 TL 的比值仍在 **1.2–2.6 倍之间浮动**（p10 1.21 / p90 2.60），
  相关系数仅 **0.72**，`round(peak/65536) === tl` 在 241 条里 **0 条**成立；
- 按 float32 重新解释得到的是 denormal（`4e-39` 量级），也不是浮点编码。

结论：它是另一个指标（疑似 EPOC/峰值负荷），语义未确认前**不得**当作 `training_load`。
库内 `training_load` 由 `sync.js` 的 `calculateTrainingLoad`（时长 × 心率区间因子）派生，
实测与 241 条中的 **237** 条一致（另 4 条是早期公式版本遗留，差异在 ±10 以内）。

**机器守卫**（防止 SDK 升级改名后静默变 NULL）：`tests/unit/garmin/fit-parser-sdk-fields.test.ts`
运行时 introspect `FIT.messages`，逐站点校验字段名，失败信息直接给出
`L564 lap.'best_lap_time'` 这样的行号定位；并有三条反向断言 ——
① 变量→message 映射必须覆盖所有读站点（漏配会让该站点不被校验）；
② allowlist 不得包含**真实存在**的字段（否则掩盖「其实能读了」）；
③ allowlist 不得留**已不再读取**的僵尸条目。当前 allowlist 为空。

#### 第三类缺陷：prompt 承诺 ⇒ 数据块必须供给（2026-10-27）

前两类讲的是「数据有值但输出方式不对」。第三类是**数据有值、prompt 也明确要求，
但中间那一层从来没接上**：

| 字段 | 真实库覆盖 | 缺陷 | 后果 |
|------|-----------|------|------|
| `recovery_time` | **348/348**（0–5020 分钟，13 条为 0） | `SYSTEM_PROMPT` §5 要求「本次后需要多少恢复时间？」，数据块从未提供 | 模型只能凭空估算恢复时长，或绕开不答 |
| `primary_benefit` | **348/348**（8 类：有氧效率 136 / 通用 64 / 有氧阈值 58 / VO2max 28 / 有氧基础 23 / 无氧爆发力 16 / 有氧高负荷 14 / 无氧耐力 9） | 同上，Garmin 官方训练收益从未进入上下文 | 模型靠配速心率猜训练目的，与设备判定可能相反 |
| `garmin_vo2max` | **235/348**，但**仅跑步**产出（非跑步 0/107；`treadmill_running` 0/6） | prompt 有「跑力」维度，数据块只给本地推算的 `vdot_value`（仅 121/241 有值） | 官方 VO2max 有值却缺席，模型拿不到最权威的跑力参考 |

修复：数据块新增 `建议恢复 / 训练收益`（不分运动类型 —— 力量训练/爬楼同样有官方恢复
建议）与 `Garmin VO2max`（`running` 门禁，非跑步整项不输出）；详情页概览新增「建议恢复」。
恢复时间的单位由 `formatRecoveryTime` 单点判定（`<60 分` / `<1440 小时` / `≥1440 天`），
**AI 数据块与详情页共用同一份判定** —— 真实库 180/348 条 ≥24 小时（最长 5020 分钟
≈ 3.5 天），若 AI 写「5020 分钟」而 UI 写「3.5 天」，同一字段就变成两个答案。

纪律：**凡是 prompt 点名要求的指标，数据块必须有对应字段**，否则 prompt 与数据直接
矛盾，模型只能编。守护：`tests/unit/lib/llm.test.ts`（三个字段进入数据块 / 0 值照常输出 /
非跑步不输出 Garmin VO2max / 全缺整行不输出）+ `tests/unit/lib/format.test.ts`
（单位三档边界）+ `tests/unit/pages/activity-detail.test.tsx`（概览「建议恢复」及「天」单位）。

### 2.2 汇总页：区间与趋势优先

#### 提示词按「能力维度 × 界面」分档（2026-10-29）

AI 教练有两种**能力维度**，它们的数据单位与结论都不同，**绝不能共用一套提示词**：

| 能力 | 数据 | 能回答 | 不能回答 |
|------|------|--------|---------|
| **单次活动**（活动详情页） | 一次活动的分段/配速/心率/步频/功率 + 可比样本 | 执行质量、当次强度与代价、横向定位、**下一次**怎么练 | 跨多次活动的统计与周期化（月跑量、趋势排名、阶段划分、赛季规划） |
| **统计类**（首页/洞察/分析/统计） | 一段时间的聚合指标 | 趋势、训练结构、负荷管理（CTL/ATL/TSB、ACWR）、周期化、类别/气温/路线对比 | 某一次训练的分段执行、步频步幅细节、触地时间等技术动作 |

**修复前**：同一套 `GLOBAL_COACH_PROMPT` 被四个页面共用，而它要求「训练结构评估 +
未来 2-4 周处方 + 3 个月目标」；单次活动分析的两套 prompt 也各自带「3 个月发展目标 /
长期视角」。于是模型被**逼着在缺依据时编造**：一次跑的明细里没有跨月结构却要它给
三个月目标；一个月的总量里没有分段却要它诊断「本次配速策略」。用户在两个界面拿到
同类内容，也分不清该问谁。

**修复后**（`app/lib/coach-prompts.ts` 是唯一来源）：

| 能力 | 界面 | 提示词 | 职责 | 篇幅 |
|------|------|--------|------|------|
| 单次活动 | 活动详情 | `SINGLE_RUNNING_PROMPT` | 执行质量 / 当次代价 / 横向定位 / 下一次怎么练 | ≤1200 字 |
| 单次活动 | 活动详情（非跑步） | `SINGLE_NON_RUNNING_PROMPT` | 专项指标 / 交叉负荷 / 对跑步的影响 | ≤800 字 |
| 统计类 | 首页 | `statisticsSystemPrompt('dashboard')` | 当前状态快照 + **本周**怎么练 | ≤700 字 |
| 统计类 | 洞察页 | `statisticsSystemPrompt('insight')` | 区间综合诊断 + 周期化 + 2-4 周 + 3 个月 | ≤1800 字 |
| 统计类 | 分析页 | `statisticsSystemPrompt('analysis')` | 强度结构 / CTL-ATL-TSB / ACWR / 区间配比 | ≤1200 字 |
| 统计类 | 统计页 | `statisticsSystemPrompt('stats')` | 自然周期总量与纪录 + **数据口径陷阱** | ≤900 字 |

关键机制是 **`CAPABILITY_BOUNDARY`**：两个维度各自声明「我不回答什么、该找谁」。
单次活动被问到周期化时指向「汇总页/洞察页教练」；统计类被问到某次训练时指向
「活动详情页的 AI 分析」。**只有洞察页**允许做多月规划与赛季目标（它确实有区间数据）。

#### 提示词 ↔ 数据块的「对齐契约」（2026-10-29 全面核对）

提示词最隐蔽的失败不是「写得不好」，而是**要求模型分析数据里没有的东西** —— 模型只能
二选一：编造，或写「数据缺失」，两者都在伤害可信度。全面核对发现三类：

| 类型 | 实例 | 真相 |
|------|------|------|
| **幽灵指标** | 跑步 prompt 要求「触地平衡（理想 50/50）」，输出示例还给了 `52/48%` | `activities.average_gct_balance` **348/348 全 NULL**（设备用哨兵 16383 表示「未测量」，见 §4.3.1） |
| **幽灵指标** | 「恢复评估：心率恢复速率（如有数据）」 | 数据源没有心率恢复字段，永远不会有值 |
| **幽灵表格** | 分析页 prompt 要求「必须说明三张区间表的分母不同」 | 教练上下文里**只有**心率区的「强度分布」，配速/功率区间从未注入 |
| **不存在的公式** | 非跑步 prompt：「用心率区间时长 × 心率水平估算强度」 | 秒 × bpm 没有量纲意义；数据里其实有 Garmin 训练效果（有氧/无氧 TE） |

修补：

1. **删掉幽灵项**：触地平衡/心率恢复速率从分析框架与输出示例里移除，并在「数据纪律」里
   显式列出「设备不写的字段，不要索要、不要写『建议补齐』」。
2. **补上缺失的块**：新增 `insight-coach.formatZoneStructureForCoach` 产出【区间结构】
   （配速区间按当前 VDOT、功率区间按各活动自身 FTP + 参照 FTP + 「不可按绝对瓦数横向比」），
   只在 `surface === 'analysis'` 时注入 —— 其余界面不需要，也不该把所有块都塞进去。
3. **换成真实公式**：非跑步改用「训练效果（TE）+ 心率区间分布 + 热量」量化强度。
4. **补齐两个被要求却没提供的量**：`getPeriodStats().avgHeartRate`（时长加权）与
   【区间环比】的「平均心率」行 —— 统计页 prompt 要求引用均心率，此前上下文里没有。
5. **补上三条「数据里有、提示词却没让它用」的纪律**：
   - **课表是执行质量的唯一客观基准**（285 条带课表活动全有目标配速区间，旧 prompt 只让它
     「评估匹配度」却不指向【课表】【课表执行】）；
   - **官方恢复建议优先**（`recovery_time` / `primary_benefit` 348/348 有值，旧 prompt 让它
     「给出恢复时间」而不引用设备结论，容易与详情页的「3.5 天」打架）；
   - **两个跑力不能互算**（`VDOT` 本地推算 vs `Garmin VO2max` 设备估算，量纲算法不同，
     不要求吻合）；**瞬时值不是能力**（`最大速度`/`瞬时峰值功率` 是逐秒尖峰）。

守护：`tests/unit/lib/coach-prompt-data-alignment.test.ts` ——
「提示词提到的每个块，必须由对应构造器产出」＋「幽灵指标不得以『要你分析』的形式出现」
＋ `formatZoneStructureForCoach` 的行为用例（分布/明细/参照 FTP/无 FTP 段/空输入）。

#### 教练分析的时间窗 = 页面显示的时间窗

`GlobalCoach` 由页面决定分析区间。2026-10-29 之前页面只传 `days`，于是
**统计页按自然月显示、教练却按滚动 30 天分析** —— 同一个「本月」有两个数字。

现在页面传**显式区间**，且区间来源单点化：

| 页面 | 页面参数 | 传给教练的区间 | 口径 |
|------|---------|---------------|------|
| `/` | 无 | `${monthStr}-01` ~ 今天 | 本月（页面写「本月概览」） |
| `/insight` | `?days=7/30/90/180/0` | `insight.range`（服务端算出的实际区间） | 近一周 / 近一月 / 近三月 / 近半年 / 全部 |
| `/analysis` | `?days=…` | 页面 `startDate`/`endDate` | 同上 |
| `/stats` | `?period=week/month/year/total` | `date-utils.statsPeriodRange(period)` | **自然周/月/年**（与统计表的 SQL 过滤同一个函数） |

`statsPeriodRange` 同时供 `getStats(period)` 的 SQL 过滤、页面文案与教练区间 ——
三者不可能再漂移。原来文档里那条「已知差异」不复存在。

| 直接调用 API | body `days` | `7/30/90/180/365/0` 或 `all` | 非法值回落 30 |
| 直接调用 API | body `surface` | `dashboard/insight/analysis/stats` | 非法值回落 `insight`（白名单，防止任意字符串注入提示词） |

上下文 =【跑者画像】+【全局洞察指标】（VDOT 趋势 / ACWR / 强度分布 / 周期化 / 有氧解耦 /
类别·气温·路线对比 / 配速-心率模型 / findings）+【区间环比】，并由 `formatInsightForCoach`
与 `formatPeriodComparison` 序列化为文本块。

**区间环比**（`period-comparison.ts`）：当前区间 vs **上一个等长区间**，输出跑量/跑步次数/时长/
平均配速/平均跑力/训练负荷的绝对值与变化率。所有指标都是**跑步口径**（`getPeriodStats` 带
`runningTypeClause`），故次数行写「跑步次数」而非「次数」—— 否则模型会以为含游泳/球类。
无上一区间活动时整段省略（不做虚假基线）；`days=0`（全部历史）无「上一区间」，自动跳过。
追问复用同一上下文（`buildGlobalCoachFollowupMessages`），前端回传 history。
界面（`surface`）只影响 **system 提示词与任务句**，上下文块（画像/洞察/环比）四个界面共用 ——
分档的是**能力与交付物**，不是数据源。

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
| 汇总 AI 页面映射 | `InsightClient` / `AnalysisClient` / `StatsClient` / `app/page.tsx` | `tests/unit/components|pages` |
| **提示词按能力维度分档** | `coach-prompts.ts`（`CAPABILITY_BOUNDARY` + 2 套单次 + 4 套统计） | `tests/unit/lib/coach-prompts.test.ts`（17 例：边界互相指向、单次无 📅 长期板块、四界面两两不等且各自独有标记、只有洞察页可做多月规划、surface 白名单） |
| **提示词引用的每个数据块必须真实产出** | 提示词 → 构造器一一对应：【跑者画像】`formatRunnerProfile`、【全局训练指标】`formatInsightForCoach`、【区间环比】`formatPeriodComparison`、【区间结构】`formatZoneStructureForCoach`（仅 analysis surface） | `tests/unit/lib/coach-prompt-data-alignment.test.ts`（块标题存在性 + 幽灵指标反向断言 + @ 区间结构行为 4 例） |
| **不存在的指标不得要求模型分析** | 触地平衡 / 心率恢复速率 → 从框架与示例移除，改为「设备不写，不要索要」；非跑步的「区间时长×心率」→ 训练效果(TE) | 同上（`not.toContain('触地平衡 52/48')` 等 4 条反向断言） |
| **统计页的均心率必须真在上下文里** | `getPeriodStats().avgHeartRate`（时长加权，与统计页卡片同源）+ 【区间环比】的平均心率行 | `tests/unit/lib/db-group-avg.test.ts`（153.64 而非 160）+ `coach-prompt-data-alignment.test.ts`（环比行逐字） |
| **教练分析区间 ≡ 页面显示区间** | 页面传显式 `startDate/endDate`；`date-utils.statsPeriodRange` 同时供 `getStats` SQL、页面文案与教练 | `tests/unit/api/insight-coach-route.test.ts`（真实读发给模型的 system 与 user 消息）、`tests/unit/components/global-coach.test.tsx`（显式区间优先于 days） |
| CI 门槛与文档漂移 | `.github/workflows/test.yml` | `tests/unit/ci/*` / `tests/unit/docs/*` |
| **统计口径：表现分析只取跑步** | `db.runningTypeClause` / `db.isRunningType`（19 处查询） | `tests/unit/lib/db-insight-integration.test.ts`（真实 SQL：趋势/区间/纪录/负荷全部排除非跑步） |
| **统计口径：活动日志保留全类型** | `getActivities` / `getMonthSummaries` | `tests/unit/lib/db-insight-integration.test.ts`（月度汇总 count 与列表 total 严格相等） |
| **统计口径：写入侧也必须筛跑步** | `scripts/garmin/backfill-vdot.js` 的 `isRunningActivity`（VDOT 与 training_load 同口径） | `tests/unit/scripts/backfill-vdot.test.js`（非跑步即便有代表性心率与 >400m lap 也不写 VDOT、旧伪值被清空；缺类型视为跑步；track/treadmill 正常计算） |
| **跑步类型判定单一来源** | `app/lib/sport.ts`（`RUNNING_ACTIVITY_TYPES` 派生 SQL + 客户端判定） | `tests/unit/lib/sport.test.ts`（类型集合/旧库空值/展示名/图标回落） |
| **MCP tool description 必须声明统计口径** | `mcp-server/tools.ts`（10 个表现分析工具写「跑步口径」、2 个活动日志工具写「全类型口径」） | `tests/unit/mcp/tool-scope-contract.test.ts`（逐项断言口径措辞、`list_activities` 不再自称「列出跑步活动」、`get_activity_comparables` 声明 `running=false` 时配速派生字段为 `null`、17 个工具均有非空 title/description） |
| **UI 不把非跑步指标当跑步指标** | `ListClient` / `ActivityDetailClient` / `RecentActivityCard` / `ActivityInsightPanel` / `ActivityTrendCharts` | `tests/unit/components/list-client.test.tsx` / `tests/unit/pages/activity-detail.test.tsx` / `tests/unit/components/recent-activity-card.test.tsx` / `tests/unit/components/activity-insight-panel.test.tsx`（非跑步不渲染「最快分段/主课均配速」卡片） / `tests/unit/components/activity-trend-charts.test.tsx`（非跑步不渲染配速/步频/步幅图） |
| **趋势卡标题不得空承诺** | `ActivityTrendCharts.trendChartTitle` / `trendChartKinds`（组件与标题共用同一判定） | `tests/unit/components/activity-trend-charts.test.tsx`（标题只列出真的会渲染的图；无海拔数据不说「海拔 趋势」） |
| **区块展示条件不得依赖单一罕见字段** | `ActivityDetailClient` 跑步动态卡（三项任一非空 + `running`） | `tests/unit/pages/activity-detail.test.tsx`（`gct_balance` 为 NULL 但触地时间/垂直摆动有值时仍渲染；非跑步即便有值也不渲染）；`tests/e2e/activity-detail.spec.ts` + 夹具按真实分布只写触地时间/垂直摆动 |
| **UI 标签必须与实际统计口径一致** | `app/page.tsx` 的「跑步天数」（数据源 `getTrainingLoads` 为跑步口径） | `tests/unit/pages/home-page.test.tsx`（标签为「跑步天数」，不得写「活动天数」——真实库 2026-10 有 16 个活动日但仅 15 个跑步日） |
| **深挖响应显式声明运动口径** | `ActivityInsightResponse.running` + `activity-insight.ts` 的 `analyzeLaps({running})` | `tests/unit/lib/activity-insight.test.ts`（非跑步不外传 `bestPaceSecPerKm`/`workAvgPaceSecPerKm`/`gradeAdjusted`；按相对心率识别强度段） |
| **AI prompt 按运动类型分流** | `llm.ts` 的 `SYSTEM_PROMPT` / `NON_RUNNING_SYSTEM_PROMPT` | `tests/unit/lib/llm.test.ts`（非跑步不出现跑步术语与配速行；prompt 不引用非跑步数据里不存在的指标） |
| **活动数据块的两类缺失** | `llm.ts` 的 `fmtNumIf` / `statRow` | `tests/unit/lib/llm-gateway.test.ts`（「该运动不产出」整项不输出、「该活动没测到」保留 `--`、有值时照常输出、无只剩标签的空行） |
| **`max_speed` 单位契约：全链路 km/h** | `fit-parser.js`（`speedUnit:'km/h'`，`enhanced_max_speed` 原样落库）/ `fetcher.py`（Strava m/s → km/h `*3.6`）/ `llm.ts`（直接 `toFixed(1)`）/ `validate-data.js`（阈值按 km/h） | `tests/unit/lib/llm.test.ts`（20.76 km/h 渲染为 `20.8 km/h`，且不含 74.7；非跑步分支同样不乘 3.6；缺值为 `--`）；`tests/python/test_fetcher_strava.py`（4.5 m/s → 16.2 km/h，与 `average_speed` 同单位）；`tests/unit/scripts/validate-data.test.js`（`distance` 按公里解释，干净数据零误报；103.5 = 28.8×3.6 被抓） |
| **逐秒 `speed` 单位契约：库内 km/h，阈值必须换算** | `app/lib/insight.ts` 的 `MIN_MOVING_SPEED_MS` / `MIN_MOVING_SPEED_KMH`（换算只此一处）/ `computeDecouplingPct` | `tests/unit/lib/insight.test.ts`（静止 1.0 km/h 不计入 → `null`；1.79 km/h 排除、1.81 km/h 收下；`MIN_MOVING_SPEED_KMH === MS × 3.6`） |
| **功率区间聚合必须按 %FTP，不能按绝对瓦数** | `app/lib/db.ts` 的 `getPowerZoneStats`（逐 lap `resolveFtp` → `powerZoneOf`）/ `app/api/analysis/power-zones/route.ts` / `PowerZoneMetricsTable` / `mcp-server/tools.ts` 的 `get_power_zone_analysis` | `tests/unit/lib/db-power-zone-stats.test.ts`（两个 FTP 差 2 倍的活动里同样的 150W 分属 Z2 与 Z1；无 FTP 的 lap 跳过并计入 `laps_without_ftp`；非跑步排除；时长加权；距离米）；`tests/unit/api/power-zones-route.test.ts`（400/200、`ranges` 由参照 FTP 派生）；`tests/unit/components/zone-tables-a11y.test.tsx`（参照 FTP 披露 + 「共 14 个不同 FTP」）；`tests/unit/mcp/tool-scope-contract.test.ts`（声明「按各活动自身 FTP」「不是任何一次活动的 FTP」） |
| **参照 FTP 是参照值，不是区间定义域** | `PowerZoneReference.ftp_median_watts` + UI 列名「参照瓦数」+ 表下说明 | `tests/unit/components/zone-tables-a11y.test.tsx`（`distinct_ftp_count > 1` 时必须出现「共 N 个不同 FTP」；单套 FTP 时不出现该噪音；无参照 FTP 时不编造 `0W+`）；`tests/unit/pages/analysis-page.test.tsx`（`228-279W` 与「共 14 个不同 FTP」同时出现） |
| **`pace` 与 `speed` 不得互相校验（两条独立推导链）** | `app/lib/insight.ts` 的 `computeDecouplingPct` / `grade-adjust.ts` 用 `speed`（实际移动）；`ActivityTrendCharts` / 分段表用 `pace`（跑姿效率） | `tests/unit/lib/insight.test.ts`（解耦只用 `speed`）；`tests/unit/components/activity-trend-charts.test.tsx`（趋势图配速轴用 `pace`，缺失时按 `cadence×step_length` 派生） |
| **FIT 解析器读的字段名必须在 SDK profile 里存在** | `scripts/garmin/fit-parser.js` 的全部 `_safeGet*(msg, 'field')` 站点（2026-10-27 清掉 19 个死读站点、12 个不存在的名字） | `tests/unit/garmin/fit-parser-sdk-fields.test.ts`（运行时 introspect `FIT.messages` 逐站点校验，失败信息给出行号；三条反向断言：映射覆盖、allowlist 不含真实存在字段、不含僵尸条目）；`tests/unit/garmin/fit-parser-branches.test.js`（`training_load` 不由解析器提供，连 `training_load_peak` 也不得当作 TL） |
| **校验器必须真的能失败** | `scripts/garmin/validate-data.js` 的 `main()` 退出码：`issues`→1、仅 `warnings`→0（设备不写是常态）、`--strict`→1；退出调用写在 `try/catch` 之外 | `tests/unit/scripts/validate-data.test.js` 的 `main() 退出码契约` 5 例（含「仅 warning 不得卡 CI」与「有 issue 必须失败」两个反向断言） |
| **生产库列集合必须与代码声明一致** | `DatabaseManager.declaredColumns(table)`（内存库走真实建表+迁移路径得到声明列集合）；`_initDatabase` 幂等补 `device_*` 列并清理旧口径 `time_in_speed_zone`/`time_in_cadence_zone`（全 NULL 直接 DROP，有值先 `COALESCE` 搬到 `device_*` 再 DROP） | `tests/unit/common/db-manager-schema-drift.test.js`（声明自洽、旧库遗留列被清理且**有值时不丢数据**、`COALESCE` 不覆盖新值、生产库与声明完全一致）+ `validate-data.js` 的 `validateSchemaDrift`（缺列判错、多列告警，两表独立） |
| **schema 单位注释必须与解析器一致** | `scripts/common/db-manager.js` 的 `activity_records.speed`/`distance` 注释（公里/小时、公里），真值来源是 `fit-parser` 的 `lengthUnit='km'` / `speedUnit='km/h'` | `tests/unit/common/db-manager-units.test.js`（注释表述 = 解析器配置、旧「米/秒」表述不得回归、模块可加载防模板字符串语法错误） |
| **分段标签由位置/距离派生，不得直接用 `lap_index`** | `app/lib/lap-label.ts`（`lapOrdinalAt` 位置→1 基序号 / `isOneKmLap` ±50m / `allLapsOneKm` / `lapTableCaption` / `lapSectionTitle` / `lapBestBadgeLabel` / `lapBestHintLabel` / `lapZoneSpreadLabel` / `lapStartDistancesMeters`）；消费方：`ActivityDetailClient`（`#` 列、徽章、表名）、`ActivityInsightPanel`（hint）、`activity-coach-context`（最快段 + 分段主区间）、`llm.ts`（标题 + 分段行） | `tests/unit/lib/lap-label.test.ts`（28 例：容差边界 / 空列表 / 两种距离字段名 / 0 基与 1 基定位 / 区间标签 / 越界 null / `650375691` 形态复刻）；`tests/unit/pages/activity-detail.test.tsx`（`#` 首行必须为 1 且不得出现 0；每段 1km → `最快 K2`；有残段 → `最快段 1.6-2.6km` 且不得出现 `最快 K\d`；表名中性化）；`tests/unit/components/activity-insight-panel.test.tsx`（hint 由 lap 位置派生）；`tests/unit/lib/activity-coach-context.test.ts`（分段主区间用累计区间，`K0=Z2` 不得回归）；`tests/unit/lib/llm.test.ts`（标题由 `lapSectionTitle` 派生）；`tests/e2e/tables.spec.ts`（`#` 列 1 基且与行数一致） |
| **「最快段 / 主课」只认配速可信的分段** | `app/lib/activity-insight.ts` 的 `MIN_RELIABLE_LAP_SEC = 10` + `isReliableLapPace()`：`work` 角色、最快段、角色基准均值三处共用同一常量（4 秒碎片 → 279 s/km 是量化噪声，非真实配速）；详情页以服务端 `lapAnalysis.bestLapIndex` 为权威，仅在 insight 失败时本地兜底 | `tests/unit/lib/activity-insight.test.ts`（8 例：4s 尾段不得成最快段 / 不得判主课 / 15s 真实间歇不误伤 / 时长缺失按可信 / 基准不被拉偏 / 非跑步不受影响 / 边界 10s vs 9s）；`tests/unit/pages/activity-detail.test.tsx`（服务端优先于本地重算 / insight 失败退回本地兜底） |
| **lap 级区间必须有例行校验（两种口径都查）** | `validate-data.js` 的 `validateLapZoneScope()`：lap `time_in_hr_zone`/`time_in_power_zone` 长度恒为 5；lap 求和 vs 活动级偏差 ≤15%（共用 `_checkLapZoneSum`，心率/功率同一实现） | `tests/unit/scripts/validate-data.test.js`（8 例：无分段不判错、干净数据双 ✓、长度非 5→issue、坏 JSON→issue、求和 >15%→warning 带样例、5.06% 天然错位不误报、无可对照不误判、零长 lap 不算缺陷）+ 专锁「功率同样受检」1 例（只查心率会红） |
| **lap 窗口切分只能有一份实现** | `scripts/common/lap-zones.js`（`lapWindowSamples` / `deriveLapZoneSeconds` / `applyLapZoneSeconds`）；`fit-parser._assignLapZoneSeconds` 与 `backfill-lap-zones.js` 都 require 它 | `tests/unit/common/lap-zones.test.js`（半开区间不重不漏、按 `cumulative_time` 而非 `start_time`、长度恒 5、无 FTP/无心率不造全 0、`cumulative_time` 缺失/倒退/零长跳过、`Number(null)===0` 陷阱） |
| **回填必须先补列再迁移, 最后才重算** | `scripts/garmin/backfill-lap-zones.js`（4 个 `device_*` 列幂等补上 → 旧设备数组迁 `device_*` → 全量重算；无时间窗的 lap 写 NULL 而非保留陈旧值） | `tests/unit/scripts/backfill-lap-zones.test.js`（15 例：顺序缺陷注入转红、幂等不二次覆盖、损坏 JSON 不迁移、无 FTP/无记录/无时间窗不猜、dry-run 不改 schema、求和偏离告警） |
| **lap 级区间秒数只由 app 5 区模型推导** | `scripts/garmin/fit-parser.js` 的 `_assignLapZoneSeconds`（按 `cumulative_time` 半开窗口切分逐秒样本，长度恒 5）；设备原始数组一律进 `device_time_in_*_zone` | `tests/unit/garmin/lap-zone-scope.test.js`（设备 7/8 槽数组不得进统一列；推导长度恒 5；各 lap 求和 ≈ 活动级；无 FTP/无心率时不写列；`cumulative_time` 缺失/倒退时跳过） |
| **`insertLaps` 的列集合必须取所有 lap 的键并集** | `scripts/common/db-manager.js`（旧实现只看 `lapsData[0]`，真实丢弃 `599287904`/`614598589` 各 14/12 个 lap 的配速/速度/步频） | `tests/unit/common/db-manager-lap-columns.test.js`（首段缺键时后续 lap 的值必须进库；反向缺键绑 NULL；三 lap 各有独有字段；整体替换语义不变） |
| **lap 级区间必须有消费方** | `ActivityDetailClient` 分段表「主要区间」列（`dominantZone`）；`activity-coach-context` 的「分段主区间 0.0-1.0km=Z2…」（累计距离区间，非 0 基序号；功率区间另受 `running` 门控） | `tests/unit/pages/activity-detail.test.tsx`（列头恒在、有数据展示 Z 徽章、无数据 `--`、非跑步同样展示）；`tests/unit/lib/activity-coach-context.test.ts`（单段不输出、全空不输出、非跑步不出功率区间） |
| **`training_load` 不是 FIT 官方字段** | `scripts/garmin/sync.js` 的 `calculateTrainingLoad` 派生（时长 × 心率区间因子）；`app/lib/types.ts` / `app/lib/llm.ts` 注释同步勘误 | `tests/unit/garmin/fit-parser-branches.test.js`（四个历史字段名 + `training_load_peak` 均不得产出 `training_load`） |
| **字段必须被消费（算出来 ≠ 展示）** | `InsightClient.tsx` / `insight-coach.ts` / `ActivityInsightPanel.tsx` / `llm.ts` | `tests/unit/components/insight-field-consumption.test.ts`（递归展开 `InsightResponse` / `ActivityInsightResponse` / `Activity` 全部叶子字段, 剥离注释后逐个断言被消费; 消费方 = 展示入口的 import 传递闭包, 死代码模块不算; allowlist 反查腐化） |
| **可推算字段必须真的推算** | `app/lib/power.ts`（FTP 回退 / IF / TSS / W·kg⁻¹ / 峰值过滤）/ `app/lib/elevation.ts`（净高差 / 爬升比） | `tests/unit/lib/power.test.ts`（28 例: 33→241 FTP 回退、TSS 用 moving_time、尖峰过滤、显式值优先）+ `tests/unit/lib/elevation.test.ts`（12 例: 净高差 ≠ 累计爬升、越界拒绝） |
| **IF/TSS 与 TL 是两套口径** | `llm.ts` 的 `powerNote` | `tests/unit/lib/llm-gateway.test.ts`（TSS 与 TL 并存时必须声明「两套口径」, 否则模型当矛盾） |
| **功率区间只有一个口径** | `app/lib/power-zones.ts`（5 区 %FTP 判定 / 逐秒累加 / 区间范围 `ceil` 同源）+ `scripts/common/power-zones.js` CJS 镜像 + `ActivityInsightPanel` 的 `powerZoneTitle`（标题由实际非零区间派生） | `tests/unit/lib/power-zones.test.ts`（22 例: 边界瓦数逐瓦、暂停空档截断、乱序自排、无 FTP 返回全 0、范围表与判定函数逐边界一致、Z6 落到 Z5 配色）+ `tests/unit/scripts/power-zones-parity.test.ts`（5 例: 常量/逐瓦/样本/FTP 解析逐值比对）+ `tests/unit/components/insight-components.test.tsx`（标题派生、FTP 可见、空数组不渲染、非跑步吞掉）+ `tests/unit/lib/activity-insight.test.ts`（`powerZoneBreakdown` 由逐秒功率推导、设备显式 FTP 优先、无 FTP 不猜、非跑步为空） |
| **区间回填必须先迁移再重算** | `scripts/garmin/backfill-power-zones.js`（`hasDeviceCol` 在 `ALTER TABLE` 之后重新赋值） | `tests/unit/scripts/backfill-power-zones.test.js`（10 例: 顺序缺陷注入转红、幂等不二次覆盖、损坏 JSON 不迁移、无 FTP/无功率不写库、dry-run 不写库、偏离 >10% 告警） |
| **海拔净高差 ≠ 累计爬升** | `ActivityDetailClient` 概览「累计爬升」+「海拔净高差」分格 / `llm.ts` 的 `elevationLine` | `tests/unit/pages/activity-detail.test.tsx`（两个不同标签同时出现）+ `tests/unit/lib/llm-gateway.test.ts`（输出 `累计爬升 ÷ 净高差` 比值与「短坡反复 / 单向爬升」判定） |
| **课表单位与步数完整性** | `scripts/garmin/fit-workout.js`（重扫原始字节 + 毫秒/mm-s 归一）/ `fit-parser._extractWorkout(fitData, rawBuffer)` / `app/lib/workout.ts`（读取端代际判别 + 加权区间） | `tests/unit/scripts/fit-workout.test.js`（多步重扫、单位换算、占位步过滤）+ `tests/unit/garmin/fit-parser-branches.test.js`（调用点确实传 buffer 的完整 `parseFitFile` 链路）+ `tests/unit/lib/workout.test.ts`（旧/新格式、加权区间、三态判定）+ `tests/unit/lib/llm.test.ts` + `tests/unit/pages/activity-detail.test.tsx` |
| **AI 可比样本块按运动口径收敛** | `activity-coach-context.ts` 的 `performanceLines`（按 `insight.running` 二次把关） | `tests/unit/lib/activity-coach-context.test.ts`（非跑步不出现配速/等价平路行，口径说明改非跑步语义） |
| **同路径几何质量只统计可校验的同伴** | `activity-insight-service.ts` 的 `summarizeRouteQuality` | `tests/unit/lib/insight-services.test.ts`（无轨迹同伴不计入 `verifiedPeers`；未校验时 `routeQuality` 显式 `null`） |
| **旧库 / 坏数据一律降级不崩页** | `db.ts` 的列探测与 `getActivityTracks` / `getActivityStartGeo` / 网格通道 | `tests/unit/lib/db-degradation.test.ts`（缺列、畸形 JSON、非法坐标、非法 id 全部返回空/`null`） |
| **AI 出流回退契约头** | `coach-stream.ts`（`X-Model-Fallback` / `-Requested` / `-Used`） | `tests/unit/api/coach-stream-gaps.test.ts`（回退成功、两个断开时机、错误体读取失败） |
| **覆盖率门槛留有余量** | `jest.config.js` + `threshold-margin.test.ts` | `tests/unit/ci/threshold-margin.test.ts`（每组每项 ≥1.5pt，且不可用降门槛来满足） |
| **配速/速度的时间基数 = 计时器时间 `moving_time`** | `app/lib/pace.ts`（`effectiveTimeSec` / `paceSecPerKm` / `speedKmh`）+ CJS 镜像 `scripts/common/pace.js`；写入侧 `fit-parser.js`（活动级 + lap 级）、`backfill-vdot.js`、`sync.js`、`scripts/strava/sync.js`；读取侧 `db.ts`、`validate-data.js` | `tests/unit/scripts/pace-parity.test.ts`（14 种时间形态逐值比对 + 真实库锚点：`582132079` 6:35 而非 26:19、`598287817` lap 7 从 60792 降到 24500）+ `tests/unit/garmin/fit-parser-branches.test.js`（活动级与 lap 级都断言 `average_pace` 更接近计时器口径、`average_speed × average_pace = 3600`）+ `tests/unit/scripts/backfill-pace.test.js`（18 例：单位差、幂等、dry-run、极端段、退出码 1）+ `tests/e2e/activity-detail.spec.ts`（判别式：`distToTimer < distToElapsed`） |
| **所有时长聚合与配速同基数** | `db.ts` 的 `getStats` / `getPeriodStats` 的 `totalDuration`、`getPaceZoneStats` / `getPowerZoneStats` / `getHrZoneStats` 的 `total_duration` 与加权权重、`getVDOTTrend().total_duration`、`getPersonalRecords` 插值、`getTrainingLoads().duration`、`getInsightActivityRows().durationSeconds`、`activity-insight.ts` 的 `lap.durationSec`、`llm.ts` 的 `dur` 与非跑步分段时长 | `tests/unit/lib/db-time-base.test.ts`（14 例真实 SQL：每条聚合路径都断言具体数字 3900 而非 5100 / 260 而非 340 s/km；七条注入路径逐一验证转红）+ `tests/unit/lib/db-insight-integration.test.ts`（5K PR 1786 而非 1800）+ `tests/unit/lib/activity-insight.test.ts`（`moving_time` 4s vs `duration` 60s → 无最快段，注入后转红） |
| **`ActivityLap` 的 44 个字段必须被消费或记账** | 账本 `LAP_FIELD_ALLOWLIST`（`tests/unit/components/lap-field-consumption.test.ts`）+ 两条推导链同基数断言 | 字段数精确 `toBe(44)`、正向未消费为空、反向账本无已消费项、账本键必须是真实列、schema 每列三头必须落一头；四个方向均做过缺陷注入 |
| **校验器必须能失败（时间基数）** | `validate-data.js` 的活动级/lap 级配速断言、区间秒数基准、`backfill-hr-zones.js` / `backfill-power-zones.js` / `backfill-lap-zones.js` 的 `expected` 基准全部改用 `effectiveTimeSec` / `speedKmh` / `paceSecPerKm` | `tests/unit/scripts/validate-data.test.js`（旧断言 `average_pace === duration/distance` 已删除 —— 它把错误口径锁死；问题数据用例必须命中） |
| **UI 时长格与配速同口径，且 `moving_time = 0` 必须回退** | `ListClient.tsx` / `RecentActivityCard.tsx` / `ActivityDetailClient.tsx`（概览 + 分段表）/ `powerIntensity` 全部 import `effectiveTimeSec`，不写 `moving_time ?? duration` 或 `moving_time \|\| duration` | `tests/unit/components/list-client.test.tsx` + `tests/unit/components/recent-activity-card.test.tsx`（`moving_time: 0` / `duration: 2800` → 必须显示 46:40；`??` 实现显示 0:00，注入后两条同时转红）+ `tests/unit/pages/activity-detail.test.tsx` + `tests/unit/lib/power.test.ts`（TSS 2201s 而非 5000s） |
| **`LoadInsight.weekly` 的 `n`/`seconds` 必须进教练上下文** | `insight-coach.ts` 的「周训练量」块（`week km/时长/次数/TL`） | `tests/unit/lib/insight-coach.test.ts`（两个 ISO 周必须逐字输出 `49.7km/5:16:40/5次/430TL`；删掉整块立即转红）+ `tests/unit/components/insight-field-consumption.test.ts`（内联对象字面量字段必须进入字段集合 —— 旧解析器只收多行 interface，`weekly` 整块漏掉，该字段族**永远绿**） |
| **表格「单位」副标题必须与单元格渲染格式一致** | `DataTable` 的 `unit`（`ActivityDetailClient` 分段表 `h:mm:ss`；三个区间表同为 `h:mm:ss`） | `tests/unit/pages/activity-detail.test.tsx`（分段表「时长」表头必须是 `h:mm:ss` 且不含 `min`，单元格是 `5:40` 形态；改回 `min` 立即转红） |
| **周键只有一个实现，周窗口只能按日期判定** | `app/lib/date-utils.ts` 的 `isoWeekKey` / `isoWeekBounds` / `isoWeeksBetween`；`insight.ts` / `insight-compare.ts` / `insight-service.ts` 只做 re-export，不得自带拷贝 | `tests/unit/lib/date-utils.test.ts`（`isoWeekKey` ≡ `periodKeyOf(week)`、跨年周边界、非法键 `null`、含首尾截断周、旧字符串过滤必然多算周的判别式） |
| **周聚合的起点必须夹到「首个有数据的那一周」** | `insight.effectiveWeeklyStart(daily, range.startDate)`；`computeLoadInsight` 与 `computePeriodization` 共用 | `tests/unit/lib/insight.test.ts`（4 例：夹紧/不夹紧/跳过零负荷日行/非法日期）+ `tests/unit/lib/insight-compare.test.ts`（区间起点 2000-01-01 时周均仍 10、`statsWeekCount` < 10） |
| **AI 周序列限长 26 周 + 汇总行** | `formatInsightForCoach`（超过 26 周只列最近半年，更早折成「合计/周均/零跑量周数」） | `tests/unit/lib/insight-coach.test.ts`（60 周 → 逐周条目恰好 26 条、含「更早 34 周汇总」、该行 < 1500 字符） |
| **ACWR 的慢性窗恒为标准 28 天，历史不足时为 null** | 主站 `computeLoadInsight`（`acwr: number \| null` + `chronicLoadDays` + tone `insufficient`）；MCP `computeTrainingLoadAnalysis`（`min(28, days)` 截断已废弃；`days<28` 时工具层补取慢性窗数据）；MCP 工具 description 必须写明 null 语义（模型会读它决定怎么用数据） | `tests/unit/lib/insight.test.ts`（7/27 天历史 → null + insufficient）+ `tests/unit/mcp/analysis.test.ts`（days=7 爆量不再恒 1.0；补齐慢性窗后正常计算；单位与主站一致） |
| **周聚合只有一个实现，两张周表必须逐周一致** | `insight.aggregateWeeklyLoad` 同时供 `computeLoadInsight`（`load.weekly`）与 `computePeriodization`（`periodization.weeks`）；两者的 range 都由 `isoWeeksBetween` 决定 | `tests/unit/lib/insight-services.test.ts`（`load.weekly` 与 `periodization.weeks` 逐周 `km`/`n` 相等、周集合相同；丢 range 或改回字符串过滤立即转红）+ 真实库 7/30/90/180/365 天窗口 0 处不一致 |
| **CTL/ATL/TSB 的预热天数只有一个常量，取数起点只有一个实现** | `training-load.TRAINING_LOAD_WARMUP_DAYS = ceil(5·CTL_TAU)` + `trainingLoadFetchStart(startDate)`；首页 / 分析页 / 洞察服务 / 跑者画像四处都走它（不得自写 28 / 90 / 120） | `tests/unit/lib/training-load.test.ts`（常量 ≥5τ、`trainingLoadFetchStart` 逐值、28 天预热画出假上涨而 210 天平、210 天 vs 700 天基线差 <1%）+ 三个页面测试各断言「预热 ≡ 常量 且 ≠ 旧值」+ 真实库四处 CTL 最大误差 0.72% |
| **CTL/ATL/TSB 必须算到参考日（含休息日），不能停在最后一个训练日** | `computeTrainingLoads(points, endDate)`；调用方传 `todayLocalDate()` / 区间 `endDate` / 活动日 | `tests/unit/lib/training-load.test.ts`（`endDate` 晚于最后训练日 → 补零延伸、早于 → 不截断、缺省 → 停训练日）+ `tests/unit/pages/analysis-page.test.tsx`（休息 3 天后曲线末点仍是参考日且 ATL 已衰减）+ 真实库 ATL 26.2 vs 30.2 |
| **参考日必须是本地日期** | `timezone.todayLocalDate()`（首页旧 `ymd(now)` 是 UTC 日期，本地 00:00–08:00 会退一天） | `tests/unit/pages/home-page.test.tsx`（`getTrainingLoads` 的 end ≡ `todayLocalDate()`） |
| **「均配速」= Σt/Σd，不是各次配速的平均** | `app/lib/pace.ts` 的 `groupPaceSecPerKm`（唯一实现）；`getStats` / `getPeriodStats`（SQL `SUM(time)/SUM(distance)`）、`computeCategoryComparison` / `computeWeatherComparison` / `computeRouteComparison`、`runner-profile`、`activity-insight` 组均/同类均值、`activity-environment` 同温档均值全部走它 | `tests/unit/lib/pace-group.test.ts`（14 例：≠ 算术平均、可组合、算术平均不可组合、seconds 由 pace×distance 还原）+ `tests/unit/lib/db-group-avg.test.ts`（真实 SQLite：20 km 与 4 km 悬殊夹具，配速 366.67 而 `AVG` 为 380）+ `tests/unit/lib/insight-compare.test.ts`（类别/气温/路线三处 `not.toBeCloseTo(等权)`）+ `tests/unit/lib/runner-profile.test.ts`（350 而非 380）+ `tests/unit/lib/activity-environment.test.ts`（5 km vs 15 km） |
| **均心率/步频按时间加权，均步幅 = Σ距离/Σ步数** | `pace.groupHeartRate` / `groupCadence`；`getStats` 的 SQL 与 `getHrZoneStats` 的 lap 累加器同口径 | `tests/unit/lib/db-group-avg.test.ts`（心率 153.64 而非 160、步频 173.64 而非 180、步幅 0.9714 而非 0.925）+ `tests/unit/lib/pace-group.test.ts` |
| **区间表同一行的 `avg_pace` ≡ `total_duration / total_distance`** | `getPaceZoneStats` / `getHrZoneStats`（真实库 Z1 行旧值 406.0，而该行总量 388.1） | `tests/unit/lib/db-group-avg.test.ts`（真实 lap：区间表每行自洽，偏差 0）+ `tests/unit/lib/pace-zone-stats.test.ts`（Σt/Σd = 435、计时器列全缺时由配速还原为 330s） |
| **主课平均心率按 lap 计时器时长加权** | `analyzeLaps` 的 `workAvgHeartRate`（`pace.groupHeartRate` + `LapInput.durationSec`，缺失由 `配速×距离` 还原） | `tests/unit/lib/activity-insight.test.ts`（1000 m/300s 与 8000 m/2480s → 183.38 而非 177.5；`durationSec` 缺失时同值；非跑步泳池样本 154.46 而非 152.5） |
| **区间平均跑力取算术平均，且三处实现必须相等** | `getStats().averageVDOT` / `getPeriodStats().avgVDOT` / `insight.computeVdotTrend().mean`（刻意不按距离/时间加权：VDOT 是估计值不是速率，实测三种权重差 <1%） | `tests/unit/lib/db-group-avg.test.ts`（`getPeriodStats().avgVDOT ≡ insight.vdot.mean`，9 位小数） |
| **SQL 注释里不得出现反引号** | `app/lib/db.ts` / `scripts/common/db-manager.js` 的模板字符串（2026-10-27～29 踩了 5 次，每次都是整站编译不过） | `tests/unit/ci/sql-template-hygiene.test.ts`（扫描 `^\s*--` 行；含一条自测确认守卫本身会转红） |
| **计时器列全缺时，秒数由 `配速 × 距离` 还原** | `pace.sampleSeconds`（`seconds` 优先，否则 `pace × distance`）；区间表用它算 lap 秒数 | `tests/unit/lib/db-zones-samples.test.ts`（`duration=0` 的 lap → `total_duration` 330s 而非 0） |
| **覆盖率余量必须在门禁流程内自查** | `scripts/testing/coverage-summary.js` 的 `checkMargins`（摘要表标 ⚠ + 明细行）；`tests/unit/ci/threshold-margin.test.ts` 在有新鲜产物时同样校验 | `tests/unit/scripts/coverage-summary.test.js`（requiredMargin 公式 / 余量不足被报告 / ⚠ 不算失败）+ `tests/unit/api/insight-coach-route.test.ts`（`surface=analysis` 注入断言, app/api branches 余量 0.33 → 4.33pt） |
| **追问建议必须与所在界面的能力同域** | `followup-suggestions.ts`：只输出「这一次的执行 / 这一次的代价 / 下一次怎么练」；输入只含 `tsb`/`weeklyVolumeChangePct`/`vdotTrend`，**不含近 28 天区间占比** | `tests/unit/components/followup-suggestions.test.ts`（反向断言：5 种场景下任何建议都不得出现 PB / 目标 / 赛季 / 月跑量 / 训练结构是否合理；安全兜底恒为最后一条） |
| **周维度 CTL/ATL/TSB 必须进入教练上下文** | `insight-coach.ts` 的「训练负荷(EWMA)」行（取末周期末值 + TSB 状态词 + 截至周/截断标记） | `tests/unit/lib/insight-coach.test.ts`（逐字 `CTL 46.3 / ATL 26.2 / TSB +20.1（新鲜） / 截至 2026-W43(截断)`；取首周立即转红） |
| **「次数」是跑步次数，不是天数** | `DailyLoad.runs` / `TrainingLoadPoint.runs` 由 SQL `COUNT(*)` 提供；聚合层只做加法（`d.runs ?? 1`） | `tests/unit/lib/insight-branches.test.ts`（一天三练 → 3 次而非 1 次）+ `tests/unit/lib/insight-compare.test.ts`（同一天两练 → 周 `activities` 为 3 而非 2；改回 `n += 1` 立即转红） |
| **区间内每个 ISO 周都出现，截断周必须标记** | `PeriodizationWeek.partial` + `LoadInsight.weekly[].partial`（同一判定）；`PeriodizationInsight.statsBasis` / `statsWeekCount`；UI 周表与趋势图 x 轴都加 `*` + 图例；教练上下文「按 N 个（含截断）周统计」+ 周训练量块 `(截断)` | `tests/unit/lib/insight-compare.test.ts`（零跑量周出现且进分母、截断周标记、完整周 ≥2 时只用完整周）+ `tests/unit/components/insight-components.test.tsx`（`2026-W43 *` 且旧的无标记文案不得出现、`statsBasis='all'` 的口径注脚、`complete` 时不制造噪音、图表 x 轴 `2026-W39 *`、`*` 图例有/无两侧）+ `tests/unit/lib/insight-coach.test.ts`（逐周序列含 `0.0km/0次` 与 `(截断)`、周训练量块 `(截断)` 后缀） |
| **「峰值周」只有一个答案** | `PeriodizationInsight.peakWeek`（与 `peakWeekKm` 同一个 reduce 选出）；训练负荷卡与周期化卡都读它，不得各自取 max | `tests/unit/lib/insight-compare.test.ts`（截断周跑量 40km > 完整周 10km 时峰值仍取 10km、`peakWeek.km ≡ peakWeekKm`、`statsBasis='all'` 时同源、空输入为 `null`）+ `tests/unit/components/insight-components.test.tsx`（两卡都显示 51.3 且 `60.0` 只出现在表里、缺 `peakWeek` 时显示 `--`）+ 真实库 540 个窗口 0 处不一致 |

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

- **追问建议与能力边界绑定**（2026-10-30 修）：建议由前端 `followup-suggestions.ts` 生成，
  与所在界面的能力同域；**新增建议时必须同步检查是否越界**（单次活动不得推荐周期化/PB/
  目标设定类问题）。统计类界面的追问靠用户自由输入，暂不做建议。
- **对话仅存 localStorage**：换设备/清缓存即丢失。若要跨端同步，需要新增 `ai_conversations`
  表与鉴权；当前单用户场景优先级较低。
- **无服务端限流/配额**：依赖本机网关与模型回退。多用户部署前需加按 IP/会话的速率限制。
- **MCP 不提供 AI 工具**：MCP 只暴露结构化数据，AI 对话在 Web 端完成；若要让 AI 客户端
  直接调用教练，需要新增 tool 并把 LLM 凭证放在服务端，会改变当前「MCP 只读数据」的安全边界。

### 4.3 功率区间的剩余边界

口径本身已在 §1.2 解决（`time_in_power_zone` = app 5 区 %FTP、由逐秒功率推导、
241/241 覆盖）。仍存在的边界：

- **只有 5 区，没有第 6 区**。设备方案是 `65/80/90/100/115 %FTP`（Z6 = >115%），
  app 把设备 Z5+Z6 合并进 Z5，因为 UI 只有 `--z1..--z5` 五个配色 token。若将来要
  区分「阈值以上」与「无氧冲刺」，需要同时新增配色 token、改 5 处区间表与 AI 数据块，
  是一次跨层改动，不在单点修补范围内。
- **设备原始数组只做追溯**。`device_time_in_power_zone`（33 条）保留在库里但不被任何
  统计/展示读取 —— 它是「设备当时怎么算的」的取证材料，不是指标。
- **分段级区间秒数已实现**（2026-10-27 补齐，含生产回填）。`activity_laps.time_in_hr_zone` /
  `time_in_power_zone` 历来 **0/3082 全为 NULL** —— 但原因不是「设备不写就没法算」：
  设备确实不写 lap 级区间数组（实测 3082/3082 lap、348/348 session 全空），可是
  **逐秒记录 + lap 的 `cumulative_time`（3082/3082 有值）就足够推导**。
  实现放在 `scripts/common/lap-zones.js`（纯函数），被**两条生产路径**共用：
  - 同步：`fit-parser._assignLapZoneSeconds`
  - 回填：`scripts/garmin/backfill-lap-zones.js`（`npm run backfill:lap-zones`）

  窗口 = `[前一段累计, 本段累计)` 半开区间，按**逐秒样本的 `elapsed_sec`** 对齐（不用
  lap 的 `start_time`：实测与记录时长最大错位 19 秒，是 lap 边界与采样时刻的固有
  错位，不是数据损坏）。口径与活动级**同一套** 5 区模型，长度恒为 5。
  生产回填实测：**3081/3082** lap 有心率区间、**2955** lap 有功率区间，各 lap 求和
  与活动级总数中位偏差 **0.17%**（p90 0.27%，最大 5.06%）—— 口径可加总。
  唯一没值的那 1 个 lap 是 `550530240` 的 `duration: 0` 零长段（无时间窗，不猜）。
  消费方：分段表「主要区间」列（`dominantZone` 取占比最高区间）+ AI 上下文
  「分段主区间 0.0-1.0km=Z2 1.0-2.0km=Z3」（与分段行同一写法，`running` 门控下另给
  「分段主功率区间」）。
- **lap 级口径必须有例行校验**。活动级有 `validateHrZoneScope` 守着，lap 级此前
  **完全没有** —— 而它更容易坏：值由时间窗从逐秒记录切分，窗口算错不报错，只是
  每段分布静默失真（页面照常渲染）。`validate-data.js` 的 `validateLapZoneScope()`
  查两条：长度恒为 5、lap 求和 ≈ 活动级（容差 15%）。后者是唯一能发现「窗口切错 /
  整段漏切」的机器手段 —— 单看某一段看不出来，必须与同源的活动级总数对照。
  **心率与功率两种口径都要查**：只查心率是半个契约，功率是另一条独立推导链
  （`%FTP` 5 区），没有活动级兜底。
- **窗口逻辑只能有一份实现**。若解析器与回填脚本各写一份，同步写入的 lap 行与
  回填写入的 lap 行就会不可加总 —— 而且**不报错**，只是「Z4 那几段配速掉了没」
  这类判断悄悄失真。故 `scripts/common/lap-zones.js` 是唯一实现，两侧都 require 它
  （与 `route-signature.js` / `fit-workout.js` 同一模式）。
- **lap 级设备数组必须走 `device_` 前缀**。`_extractLapsData` 此前把设备原始
  `time_in_hr_zone` / `time_in_power_zone` 直接写进统一列 —— 潜伏缺陷：设备数组长度是
  7/8 槽（不是 5），一旦有固件写入就会让「长度恒为 5」的契约失效、且按索引跨 lap
  聚合失去意义。现改为与活动级同样的分流（`device_time_in_hr_zone` /
  `device_time_in_power_zone`）。速度/步频区间 app 无对应 5 区模型，设备值一律进
  `device_time_in_speed_zone` / `device_time_in_cadence_zone`（活动级同此处理）。
- **非跑步活动不产出**。逐秒功率在 107 条非跑步活动里 0/107 —— 不是缺陷，而是设备
  不记录；UI 与 AI 都按 `running` 门控整项不渲染，而不是给出「全是 Z1」的假分布。

### 4.3.1 全 NULL 的列：区分「设备不写」与「我们读错了名字」

`activity_laps` 曾有 **16 列 100% NULL**；回填 lap 区间后 `time_in_hr_zone` /
`time_in_power_zone` 两列已有值（3081 / 2955 条），同时新增 4 个 `device_*` 列
（设备从不写 lap 级数组，故这 4 列恒 NULL）—— 现为 **18 列 100% NULL**。
`activities` 另有 14 列零覆盖。这些列长期被
统一归因为「设备不写」，但 2026-10-27 审计发现原因有三类（不是两类）：
**读错字段名**、**设备真的不写**、以及**写入侧把数据丢了**（见 §4.3.2）。
第一类见 §2.1「FIT 字段名必须存在于 SDK profile」：

| 列 | 真实原因 | 归属 |
|----|---------|------|
| `best_pace`（lap） | 读 `best_lap_time`，SDK 只有 `best_lap_index`（索引） | **读错名字**（已删除死读） |
| `average_pace_gap`（lap） | 读 `avg_pace_gap`，profile 里没有任何 pace/gap 字段 | **读错名字**（已删除死读） |
| `average_step_rate_loss` / `_percent` | 读同名字段，profile 无此概念 | **读错名字**（已删除死读） |
| `average_power_to_weight` / `max_power_to_weight` | 读同名字段，profile 无此字段 | **读错名字**（已删除；改由 `app/lib/power.ts` 派生） |
| `average_gct_balance` | 正确名 `avg_stance_time_balance` 已读取，但设备确实不写（见下方证据） | **设备不写**（348/348 实测） |
| `avg_grade` / `avg_pos_grade` / `avg_neg_grade` / `max_pos_grade` / `max_neg_grade` | profile 有这些字段，但真实设备 348/348 不写 | **设备不写** |
| `time_in_speed_zone` / `time_in_cadence_zone`（活动+lap） | profile 有字段，设备不写；app 亦无对应 5 区模型 → 一律进 `device_time_in_speed_zone` / `device_time_in_cadence_zone` | **设备不写**（列已带 device_ 前缀） |
| `time_in_hr_zone` / `time_in_power_zone`（lap） | profile 有字段，但设备**从不写 lap 级**区间数组（3082/3082 空） | **已改为推导**（不再依赖设备）：逐秒记录按 `cumulative_time` 时间窗切分。回填后 **3081/3082** / **2955/3082** 有值（见 §4.3） |

纪律：**遇到全 NULL 列必须先分辨这两类**。若归因为「设备不写」却其实是读错名字，
那列会永远为空且没人再查 —— 这正是本次 19 个死读站点能潜伏这么久的机制。
`tests/unit/garmin/fit-parser-sdk-fields.test.ts` 让这类缺陷在**写入任何数据之前**
（CI 阶段）就转红。

#### `average_gct_balance` 的证据链：「设备不写」而非「读错名字」

这一列是唯一一个**「读错名字」假设已被证伪**的案例，值得单独记录证据，否则
下一次审计还会重复怀疑它：

1. **SDK profile 定义了正确的字段名**：`fit-file-parser` 的
   `left_right_balance_100` 枚举含 `16383: 'mask'` —— 即设备用 16383 表示
   「平衡未测量」的哨兵值。
2. **读取的字段名是对的**：`fit-parser` 读 `avg_stance_time_balance`，
   该名字存在于 profile；同一族里 `average_gct_balance` 只是它在我们 schema 中的
   列名，不是读错的字段。
3. **真实数据全是哨兵**：349/349 个 session + 3087/3087 个 lap 的
   `avg_stance_time_balance` 都恰好是 `{"0":false,"value":16383,"right":true}`；
   记录级 `left_right_balance` 出现 **0 次**。

结论：设备从不写这项测量，不是我们读错了名字。因此保留 `avg_stance_time_balance`
的读法，`average_gct_balance` 继续为 NULL 并归入「设备不写」。若哪天设备开始写，
写入侧已经就位，不需要改代码。

还有第三类，比前两类更隐蔽：**列能算，但写入侧把数据丢了**。

#### 4.3.2 写入侧的列集合必须取并集（真实数据丢失）

`DatabaseManager.insertLaps` 旧实现用 `Object.keys(lapsData[0])` 拼 INSERT 列名。
但解析器对每个 lap 只写「该 lap 有值的字段」——首个 lap 常常缺键：

| 活动 | lap 0 形态 | 被静默丢弃的字段 |
|------|-----------|-----------------|
| `599287904`（28 段） | 26.6 秒起步碎片，`avg_cadence: 0`、`total_distance: 0` | 后续 **14 个 lap** 的 `average_cadence` / `average_speed` / `average_pace` / `average_moving_pace` |
| `614598589`（26 段） | 0.6 秒碎片 | 后续 **12 个 lap** 的同样四列 |

这两条活动在库里这些列 100% NULL，而解析器其实算出了值（如 `599287904` 的 lap 1
`cadence 50 / pace 1940 秒/公里`）。**缺陷不报错、不影响覆盖率，只是数据悄悄消失**。
现改为取所有 lap 的键并集；反向（lap 0 有、后续 lap 缺）在 bind 时得到 `undefined`
→ better-sqlite3 绑成 NULL，语义正确（实测 69 条活动存在这种情形）。
守护：`tests/unit/common/db-manager-lap-columns.test.js`（注入旧实现 → 2 条转红）。

#### 4.3.3 生产库的列集合可能落后于代码（schema 漂移）

`_initDatabase` 只在 **`DatabaseManager` 打开库时**补列。但有些路径直接用
`better-sqlite3` 打开同一个库（回填脚本、只读查询、外部工具），那些路径永远不
触发迁移。于是会出现「代码声明了列、库里没有」的漂移，而**读写两侧都不报错**：

- **写**：`upsertActivity` 按对象键拼 SQL —— 没写到的列只是静默缺失；
- **读**：`SELECT *` 少两列，`Activity` 里对应字段永远是 `undefined`。

2026-10-27 真实事故：新增 `activities.device_time_in_speed_zone` /
`device_time_in_cadence_zone` 后，生产库仍是 **78 列**、缺这两列，却多出两个旧口径的
`time_in_speed_zone` / `time_in_cadence_zone`（`activity_laps` 同样）。后果是「设备
原始速度/步频区间」这条数据**在库里根本没有落点**，而没人会发现。

判据与处置：

| 方向 | 含义 | 处置 |
|------|------|------|
| **缺列**（代码有、库无） | 写入这些列会抛错或静默跳过 | **判错**。用 `DatabaseManager` 打开库即自动补列 |
| **多列**（库有、代码无） | 历史遗留列本身无害，但说明迁移没清理 | **告警**。若是旧口径的统一列则是陷阱，应 `DROP COLUMN` |

旧口径遗留列为什么必须删：`time_in_speed_zone` / `time_in_cadence_zone` 这两列在
app 侧**没有** 5 区模型，正确落点是 `device_*` 前缀列。留着不带前缀的名字，下一个人
就会以为它是统一口径、按索引跨活动聚合 —— 而设备边界方案随固件而变，聚合结果没有
物理意义（与心率/功率踩过的坑同源）。

**但清理不能无条件 DROP**。`_initDatabase` 会对**任何**打开的库执行，包括用户从备份
恢复的旧库、别人的库。生产库那 4 列（两表各 2）实测 **100% NULL**（已核对全部 9 个
历史备份），但「本库恰好为空」不能当成「所有库都为空」的许可证 —— 无条件 `DROP
COLUMN` 等于「凡是有值的旧库都静默丢数据」，而迁移本身不报错、没人会发现。故按数据
决定动作：

| 遗留列状态 | 动作 |
|-----------|------|
| 全 NULL | 直接 `DROP COLUMN`（无数据可丢） |
| 有值 | 先 `UPDATE ... SET device_x = COALESCE(device_x, x)`，再 `DROP COLUMN` |

`COALESCE` 是必须的：目标 `device_*` 列可能已被回填脚本按新口径写过，用旧方案的值
覆盖它等于把「新口径」静默污染成「旧口径」。`_initDatabase` 对每列做 try/catch
（列不存在 / SQLite < 3.35 / 有约束引用时跳过，不阻断建库）。

守护：

- `tests/unit/common/db-manager-schema-drift.test.js` —— 真值来源是
  `DatabaseManager.declaredColumns()`（**内存库走同一条建表+迁移路径**得到，不是把
  列名再抄一遍），断言：声明里必须有 6 个 `device_*` 列、旧口径列不得出现、旧库打开
  后遗留列被清理、生产库（存在时）与声明完全一致。
- `scripts/garmin/validate-data.js` 的 `validateSchemaDrift()` —— 例行校验也报这项，
  缺列进 `issues`、多列进 `warnings`，两表各自独立上报。
  `tests/unit/scripts/validate-data.test.js` 5 例覆盖四种组合。

#### 4.3.4 校验器必须真的能失败（退出码契约）

`validate-data.js` 有 20 处 `addIssue`，但 `main()` 旧实现**只在抛异常时** `exit(1)`
—— 「发现 N 个问题」是正常返回的。于是一个看起来完备的校验器**永远不会失败**：
接进 CI 也永远绿灯，等于没有校验。这类缺陷最阴：脚本存在、能跑、有输出，唯独
不能拦任何东西。2026-10-27 实测生产库跑出 3 个 warning、退出码仍是 **0**。

现按发现内容决定退出码（`npm run validate:data` / `--strict`）：

| 情况 | 退出码 | 理由 |
|------|--------|------|
| `issues` 非空 | **1** | 硬错误，必须修 |
| 只有 `warnings` | **0** | 真实库长期有警告（`average_gct_balance` 348/348 全 NULL 是**设备不写**，不是缺陷）。拿常态卡 CI 会让 CI 永久红，守卫随即被关掉 —— 那才是真的失去保护 |
| `--strict` | warnings 也算失败 | 人工排查时用 |

**退出必须写在 `try/catch` 之外**：写在 `try` 里时，任何把 `process.exit` 变成抛错的
场景（单测 mock、某些封装）都会让这条 `exit(1)` 被自己的 `catch` 接住 —— 同一个失败
被记两次，错误信息还变成「验证失败」而非「发现问题」。这条是修的时候真踩到的。

守护：`tests/unit/scripts/validate-data.test.js` 的 `main() 退出码契约` 5 例
（无发现→不 exit / 仅 warning→0 / 有 issue→1 / `--strict`→1 / 抛异常→1）。

### 4.4 文档与工程

- `docs/README.md` 的历史项目结构章节曾长期滞后；现已按当前目录更新，后续新增模块需同步本表。
- `docs/faq.md` 的部分日期化经验条目保留（用于复盘），但**功能契约以本文档为准**。
- e2e 对 AI 流式对话仍以 mock 为主；真实网关的端到端验证依赖本机凭证，未纳入 CI。

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

`training_load`（Garmin 官方负荷分，241/241）与派生的 `TSS` 并存时会出现
「TSS 41 但 TL 65」—— 不解释的话模型会当成数据矛盾并浪费篇幅核对。故数据块在
IF/TSS 行后追加固定说明：「与训练负荷 TL 是两套口径：TL 是 Garmin 官方负荷分,
TSS 是阈值功率派生量」。

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
`avg_pos_grade` 等 4 项 / `time_in_speed_zone` / `time_in_cadence_zone`）、
以及仅追溯用的设备原始区间数组（`device_time_in_hr_zone` / `device_time_in_power_zone`
—— 统一口径列 `time_in_hr_zone` / `time_in_power_zone` 已分别被
`hrZoneBreakdown` / `powerZoneBreakdown` 消费，见 §1.2）。

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

### 4.3 功率区间的剩余边界

口径本身已在 §1.2 解决（`time_in_power_zone` = app 5 区 %FTP、由逐秒功率推导、
241/241 覆盖）。仍存在的边界：

- **只有 5 区，没有第 6 区**。设备方案是 `65/80/90/100/115 %FTP`（Z6 = >115%），
  app 把设备 Z5+Z6 合并进 Z5，因为 UI 只有 `--z1..--z5` 五个配色 token。若将来要
  区分「阈值以上」与「无氧冲刺」，需要同时新增配色 token、改 5 处区间表与 AI 数据块，
  是一次跨层改动，不在单点修补范围内。
- **设备原始数组只做追溯**。`device_time_in_power_zone`（33 条）保留在库里但不被任何
  统计/展示读取 —— 它是「设备当时怎么算的」的取证材料，不是指标。
- **分段级（lap）功率区间为空**。`activity_laps.time_in_power_zone` 真实库
  **0/3082 全为 NULL**（`time_in_hr_zone` 同样全 NULL），故功率区间只能到活动级；
  要做分段级需要从逐秒记录按 lap 时间窗切分，属新增能力。
- **非跑步活动不产出**。逐秒功率在 107 条非跑步活动里 0/107 —— 不是缺陷，而是设备
  不记录；UI 与 AI 都按 `running` 门控整项不渲染，而不是给出「全是 Z1」的假分布。

### 4.4 文档与工程

- `docs/README.md` 的历史项目结构章节曾长期滞后；现已按当前目录更新，后续新增模块需同步本表。
- `docs/faq.md` 的部分日期化经验条目保留（用于复盘），但**功能契约以本文档为准**。
- e2e 对 AI 流式对话仍以 mock 为主；真实网关的端到端验证依赖本机凭证，未纳入 CI。

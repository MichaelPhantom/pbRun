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
| 活动列表 | `/list` | `getMonthSummaries`（双口径 + 跨月筛选）/ `getActivities` / `getActivityTypes`（全库类型清单驱动下拉） | 每张卡片直达详情 AI 复盘 | ✅ |
| 活动详情 | `/pages/[id]` | `getActivityById/Laps/Records/Track` | 单次活动 AI（见 §2） | ✅ |
| 活动深挖 | `GET /api/activities/[id]/insight` | `activity-insight.ts`：分段角色 / 主课漂移 / 区间 / 解耦 / 同路线对比 / 环境可比性 | 作为活动 AI 的当次指标来源 | ✅ |
| 活动 AI 对话 | `POST /api/activities/[id]/analysis` | `llm.ts` + `coach-stream.ts` + `runner-profile.ts` + `activity-coach-context.ts` | 当次 + 同路线/同名 + 同距离 ±10% + 同类 | ✅ |
| 训练分析 | `/analysis?days=` | 心率区间 / 配速区间 / **功率区间** / VDOT / CTL-ATL-TSB | 汇总 AI，跟随页面时间窗 | ✅ |
| 训练洞察 | `/insight?days=` | `insight.ts` / `insight-compare.ts` 实时聚合 + `findings` | 汇总 AI，跟随页面时间窗 | ✅ |
| 统计 | `/stats?period=` | `getStats` / `getPersonalRecords`（跑步口径，见 §1.1） | 汇总 AI，周/月/年/全部映射 | ✅ |
| 汇总 AI 对话 | `POST /api/insight/coach` | `insight-service.ts` → `formatInsightForCoach` | 区间指标 + 跑者画像 + 趋势 | ✅ |
| 模型目录 | `GET /api/llm/models` | `model-curation.ts` 固定白名单 | — | ✅ |
| MCP Server | `mcp-server/`（stdio） | 20 个 tools 复用 `app/lib/db.ts` 与活动深挖服务 | `get_activity_comparables` 直接返回当次可比 `contextText` | ✅ |
| 力量训练 | 首页卡片 / 分析页卡片 / 活动详情「力量训练分析」/ MCP `get_strength_sessions`·`get_strength_loads` | `app/lib/strength.ts`（纯函数：画像 + 负荷 + 合并），`db.getStrengthLoads/getStrengthSessions/getCombinedTrainingLoads` | 结构化画像（计划名/组数/工作休息比/强度域） | ✅ |
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
| **活动日志（全类型）** | 用户明确要在列表里看到所有运动，且带 `activity_type` 筛选器 | `getActivities`、`getMonthSummaries`、`getActivityTypes` |
| **力量训练（第三套）** | 力量课有独立分析语义（组结构/训练效应/恢复建议），但不含距离语义 | `getStrengthLoads`、`getStrengthSessions` |
| **合并负荷（跨口径）** | 负荷是「身体总消耗」，力量课必须进入 ACWR/CTL/TSB；但里程/时长/次数仍只取跑步 | `getCombinedTrainingLoads`（= 跑步负荷 + 力量负荷，`load` 相加，其余字段只取跑步） |

跑步类型集合为 `running` / `track_running` / `treadmill_running`（`db.runningTypeClause`
与 `db.isRunningType` 单点定义）；缺 `activity_type` 列或值为空时按跑步处理（旧库兼容）。

**「按跑步处理」必须同时体现在 JS 与 SQL 两侧**：`isRunningType(null) === true`，因此
`runningTypeClause` 写成 `(activity_type IN (...) OR activity_type IS NULL OR activity_type = '')`，
而不是裸 `IN (...)` —— 后者会把 NULL/空串行排除在跑步统计之外，同一个判定在 JS 里说
「是跑步」、在 SQL 里说「不是」，于是详情页显示跑步卡片、`/stats` 却不统计它。
同理「筛某个类型」用 `COALESCE(NULLIF(activity_type,''),'running') = ?`（下拉清单、
月度筛选、活动列表三处同一表达式）。

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
配速/心率/区间完全一致；`/list` 的月度「N 公里 / N 次」拆**双口径**：里程只算跑步
（`runDistance`），次数给全类型（`count`，与展开后的卡片严格一致），另标「含 N 次其他」。
真实库 2026-08 全类型 199.60km 而跑步 197.55km（差 2.05km 来自 1 条泳池游泳），
若里程也用全类型，跑量会虚高；而 2026-09 若次数只用跑步会显示 3 次却列出 4 张卡片。

**展示与 AI 也必须分口径**（否则修复了统计却仍在误导用户）：

| 位置 | 非跑步活动的处理 |
|------|-----------------|
| `/list` 类型下拉 | **数据源是全库类型清单**（`getActivityTypes`，按条数降序），不是「已加载月份里出现过的类型」—— 页面默认只预取最近 1 个月，该月只有跑步时下拉就只剩「跑步」（真实库 353 条里 120 条非跑步）。选项带全库条数（「力量训练 (51)」），值仍是原始 `activity_type`，文案走 `activityTypeLabel` 中文名（按拼音排序）；空 `activity_type` 归一成 `running` 键，不再与真实 `running` 分裂成两个同名选项 |
| `/list` 「本月只有跑步」快捷入口 | **第三层提示**。前两层（下拉带全库条数、顶部「全库共 N 次活动 · M 种运动」摘要）都要求用户主动去看别处；而用户报「记录栏目还是只有跑步类型」时只看主体内容就下结论 —— 默认展开的 2026-11 恰好只有 3 条跑步。故当「本月已加载且**全部是跑步**」+「无类型筛选」+「有全库清单」三个条件同时成立时，在该月上方渲染一条可点击的 chip 行（「这个月只有跑步。库里还有 N 种运动：力量训练 51 / 爬楼 30 / …」），点击即 `onTypeChange(type)`（服务端过滤 + 首个匹配月自动展开）。**三个条件缺一不可**：有非跑步活动的月份用户自己就能看见（渲染是噪音）；已筛选时用户已经知道有别的运动；无全库清单时不知道还有哪些类型。判定走 `sport.isRunningType` 单一来源（`treadmill_running`/`track_running` 也算跑步，不会被误列进「其他」） |
| `/list` 筛选与搜索 | **跨月生效**：条件作为 SQL `WHERE` 作用在月度汇总本身（`getMonthSummaries(limit, offset, {type, q})`），不匹配的月份不出现，首个匹配月自动展开并取数。只在展开的单月里过滤会让用户选「力量训练」时当月没有力量课就只看到「无匹配」，必须逐月点开找。**搜索同时匹配名称与运动类型中文名**（`q=力量` 命中 51 条「全身循环2」这类名称不含「力量」的力量课），且**大小写不敏感**（`q=hiit` 命中 `HIIT`，与 SQL `LIKE` 同语义）—— 本地即时过滤与服务端 SQL 必须同一口径，否则服务端返回该月、本地却显示「无匹配」 |
| `/list` 类型归一 | 空 `activity_type` 视为 `running`，**四处必须同表达式**：下拉清单 `getActivityTypes`、月度筛选 `COALESCE(NULLIF(activity_type,''),'running') = ?`、活动列表 `getActivities({type})`、UI `typeKeyOf`。任一处写成 `activity_type = ?` 都会让「下拉里有跑步选项、选中后少几条」 |
| `/list` 的 `type=all` | UI 的「所有类型」选项值是字面量 `all`，**不是库里的类型键**（生产库 353 条无一条叫 `all`）。归一收在 `db.normalizeTypeFilter` 单一来源（`all`/空串/纯空白 → `undefined` = 不过滤），`getActivities` 与 `getMonthSummaries` 都经过它，因此 Web 两个端点与 MCP 两个工具语义自动一致。曾经只有 months 端点做了归一，用户选「所有类型」后月份列表正常、展开的卡片全部消失（`activity_type = 'all'` 命中 0 行） |
| `/list` 的搜索词归一 | 与上一行同一纪律：**纯空白等于没有输入**。归一收在 `db.normalizeQueryFilter`（`''` / `' '` / `'\t'` → `undefined`），`getMonthSummaries` 的 `q` 经过它。旧实现 `if (filter?.q)` 会让 `q=' '` 变成一个 `name LIKE '% %'` 的有效过滤 —— 生产库实测 `months?q=%20` 返回 13 个月、每月只剩名称里恰好带空格的 2~21 条活动（真实库名称多为「两江新区 - 基础训练」），是一个既非全部、也非空的静默错位结果。UI 自己 trim 过，所以缺陷只在直连 API / MCP 时显形 |
| `/list` 月卡 | 里程口径**跟着筛选走**（`type` 与 `q` **都算筛选**）：无筛选用 `runDistance`（只跑步，`0` 时不渲染 —— 全类型会把游泳距离加进跑量，真实库 2026-08 多 2.05km）；有任一筛选改用 `totalDistance`（此时它就是匹配活动的里程，仍用 `runDistance` 会让游泳/篮球/爬楼的里程整块消失 —— 真实库 `months?type=lap_swimming` 与 `months?q=游泳` 的 totalDistance 都是 2.05 / 3.28 / 0.78km 而 runDistance 全 0）；「含 力量训练 2 · 爬楼 1」徽标只在**完全无筛选**时显示（筛选后这些活动不是「其他」—— `months?q=力量` 每个月 count 2~7 / runCount 0，会渲染成「2 次 含 2 次其他」）。口径判定读**已生效**的 `appliedFilter` 而非输入框即时值（搜索防抖 300ms 内两者不同）。**徽标必须说出具体运动类型**：旧实现只写「含 4 次其他」—— 用户知道还有别的运动但不知道是什么，这与「记录栏目只有跑步类型」是同一类观感来源。构成来自 `getMonthSummaries` 新增的 `typeBreakdown`（月 × 类型二维聚合，单独一条查询，按 `count DESC, type ASC`）；跑步自身不计入；**最多列 3 种**（真实库 2026-01 有 7 种，全列会把单行头部撑爆），其余合并成「等 N 种」；`typeBreakdown` 缺失（旧 API 响应）时回落到旧的「含 N 次其他」，构成全是跑步时**不显示任何徽标** |
| `/list` 月卡 · 次数口径 | 同一张月卡里**里程是跑步口径、次数是全类型口径**（第二十二类缺陷）：真实库 2026-09 显示「200.84 公里 · 25 次」—— 200.84km 只来自 21 次跑步，25 次是全部活动（21 跑步 + 2 力量 + 1 爬楼 + 1 游泳）。两个数字并列，读者自然算出「平均 8.03 km/次」，而真实跑步均距 9.56 km（差 19%）；2026-02 更极端（「219.30 公里 · 37 次」里 16 条是爬楼，均距 5.9km/次）。次数给全类型是**对的**（必须与展开后的卡片数严格一致，否则用户以为漏了），错的是没说清这 25 次里有几次有里程。现在次数后直接标出跑步那部分「25 次（跑步 21）」—— 用户一眼就能对上「里程 ÷ 跑步次数」；**全是跑步时不标**（`4 次` 已足够，`4 次（跑步 4）` 是噪音）。`db.ts` 的 `getMonthSummaries` 早已注释承认「两个数字互相矛盾」，但 UI 一直没有把 `runCount` 显示出来 |
| `/list` 月卡 · 时长兜底 | **没有距离语义的运动，时长就是训练量**。里程为 0 时按纪律不渲染距离块（那是正确的 —— 力量课本来没有距离语义），但**必须有替代指标**，否则筛到「力量训练」的月卡只剩一行「4 次」。而计数不表达训练量：4 次 20 分钟和 4 次 200 分钟在月卡上长得一模一样。真实库实证（修复前月卡只有计数）：力量训练 2026-09 共 120 分钟、爬楼 2026-01 共 306 分钟、HIIT 2025-11 共 33 分钟、跳绳 2025-12 共 4 分钟。故 `MonthSummary` 新增 `totalDuration`（秒，**计时器时间**：`moving_time > 0` 用它，否则回落 `duration` —— 与 `pace.effectiveTimeSec` / `getStats().totalDuration` 同源，用经过时间会让同一批数据在月卡与统计页差 2 小时 11 分），月卡在「里程为 0 且时长 > 0」时渲染时长。**有里程时不同时挤时长**（距离已是训练量，头部单行会溢出）。时长**不拆双口径**：与 `count` 同口径（全类型），因为不存在「游泳时长混进跑量」那类语义冲突 —— 时长在任何运动里都是真实训练时间 |
| `/list` 活动卡片 | 零距离活动（真实库 97/353 条：力量训练 51、爬楼 30、室内有氧 9、HIIT/跳绳/室内骑行各 3/3/1）**不渲染距离块**，只留时长 + 类型徽标 —— `distance = 0` 是「该运动没有距离语义」，`distance = null` 才是数据缺失（仍显示 `--`） |
| 活动卡片 / 仪表盘「最近活动」 | 隐藏配速（泳池 1670s/km、乒乓 30826s/km 不是跑步配速）与「即时跑力 / VDOT」（跑步跑力指标），改显示类型徽标；无名称时按类型兜底命名。**训练负荷、平均心率与训练效果（TE）都与运动类型无关，三处卡片（`/list` 卡片 / 首页 `RecentActivityCard` / 详情页概览）一律照常展示** —— 这句话在 2026-11 之前对 `/list` 卡片是**假的**：那张卡片从未渲染过 `average_heart_rate`，于是真实库 19 条非跑步活动（篮球 3 / 乒乓 2 / 羽毛球 1 / HIIT 3 / 室内有氧 9 / 室内骑行 1）在列表页是纯空壳（`training_load` 全 NULL、又无语义已确认的次数/楼层/组数），而它们 **19/19 都有心率**（76–127bpm）。详见 `docs/faq.md` 第 26 条。补完心率后这批卡片仍缺强度量化 —— **19/19 都有 TE**（0–1.2），见第 30 条与下方「三处卡片 · 训练效果（TE）」行。零距离活动不渲染距离块（见上方 `/list` 活动卡片行） |
| 三处卡片 · 非跑步核心指标 | **只隐藏跑步指标是不够的，还得补上该运动自己的指标**。派生规则唯一来源 `app/lib/type-metrics.ts`（`typeMetricsOf()`），`/list` 卡片 / 首页「最近活动」卡片 / 详情页概览三处共用，不各写一遍。真实库 354 条里 120 条非跑步，而爬楼 30 条（`distance` 全 0、`training_load` 全 null）在卡片上原本只有「时长 + 类型徽标」—— 用户看到的是空壳，自然觉得「这些活动没什么内容」。这是「记录栏目只有跑步」的另一面：不是筛选不到，而是**筛到了也看不出什么**。故卡片补两格：① **楼层**（仅 `floor_climbing`，走 `floorsFromAscent` 唯一换算 `total_ascent ÷ 3.048`，46m → 「约 15 层」；**跑步即使带 300m 爬升也不派生** —— 山地跑的爬升是「爬了多少层楼的高度」，不是「爬了多少层楼」）；② **总次数**（走 `cycleCountLabel` 唯一语义白名单：游泳「次划水」/跳绳「次跳跃」/爬楼「步」）。**语义未确认类型整格不渲染**：力量课 51 条都有 `total_cycles`（51/51）但 `r(cyc, 时长) = −0.118` 否掉了「次数」假设，把 73 写成「73 次」是编造；跑步的步幅周期数对用户无意义，同样不渲染。**三处展示位置**：`/list` 卡片指标行、首页 `RecentActivityCard` 指标行、详情页概览格（后者要数值 + 单位分开排版，故模块同时给 `floors`（数值）/ `floorsText`（「约 15 层」）/ `cycles` / `cyclesLabel`）。**第三格：力量有效组数**（`workingSets`）—— 力量课 51 条是第二大类，`total_cycles` 虽被否掉，但**有效组数来自完全不同的字段**（`workout_steps` 组结构里 active/interval 的步数，详情页「有效组数」与 AI 数据块都在用），49/51 可算。**「一个字段被否掉 ≠ 整类没有可展示指标」** —— 因为 `total_cycles` 语义未确认就把力量课当成空壳，是同一个错误的反面。没有课表的 2 条给 `null` 而不是「0 组」（没课表 ≠ 没做组）|
| 三处卡片 · 训练效果（TE） | **非跑步活动唯一的强度量化手段**。真实库 **354/354** 条活动都有 Garmin 官方 `total_training_effect`（0–5），详情页「有氧训练效果」与 AI 数据块「训练效果」一直在用，但两张卡片从未渲染 —— 补了心率之后，19 条非跑步活动（篮球 3 / 乒乓 2 / 羽毛球 1 / HIIT 3 / 室内有氧 9 / 室内骑行 1）在卡片上仍只有「时长 + 心率 + 徽标」，而它们 `training_load` 全 NULL。格式化与门控唯一来源 `app/lib/training-effect.ts`（`formatTrainingEffect` / `TRAINING_EFFECT_LABEL` / `TRAINING_EFFECT_DETAIL_LABEL`），三处消费面共用。**`TE = 0` 是有效值**（羽毛球 `560273729` 精确为 0、跳绳 3 条 0–0.1），判空必须 `!= null` —— 用真值判断会把这 4 条「这课基本没有训练刺激」的唯一证据静默吞掉。**TE 不做运动类型门控**（与 `training_load` 相反）：设备对 13 类全写，加白名单就等于第三份「哪些类型有 TE」的判断。标签两套：卡片「训练效果」（短），详情页「有氧训练效果」（与相邻「无氧训练效果」区分）。详见 `docs/faq.md` 第 30 条 |
| 游泳「每 100m 配速」 | 游泳的行业口径是**秒/100m**（池长 25/50m），而全站其它运动是秒/公里 —— 直接把泳池 `average_pace`（真实库 1670 s/km）当配速展示，量级差 10 倍且不是游泳者的语言。换算收进 `pace.paceSecPer100m`（`360 ÷ 速度(km/h)`）+ `formatPacePer100m`（`2:22` 风格）唯一实现，判定走 `sport.isSwimmingType` 单一来源。**四处展示**：详情页概览「每 100m 配速」格、详情页分段表「配速 /100m」列（`distance = 0` 的休息段为 `--`）、`/list` 活动卡片、首页「最近活动」卡；AI 数据块非跑步分支新增「每 100m 配速: 2:22/100m」行。真实库验算：2.535 km/h → 142.0 s/100m、1.336 → 269.4、3.322 → 108.4、1.602 → 224.7，与 `average_pace ÷ 10` 完全一致 |
| MCP 游泳单位声明 | `get_activity` / `get_activity_laps` / `get_activity_comparables` 三个活动日志工具的 description 声明「游泳看秒/100m：`average_pace ÷ 10`（÷10 只对秒/公里成立），`average_speed` 是 km/h 要 `360 ÷ 速度`」—— 不写这句，模型会拿 km/h 做 ÷10 得 0.25，输出「每 100 米 0.25 秒」 |
| 活动详情页概览 · 距离 | `distance = 0` 时**整格不渲染**（力量训练按组、爬楼按层、HIIT/跳绳按次，恒为 0 的格子显示 `--` 像同步失败，与「平均功率」同一原则）；`distance = null`（数据缺失）仍显示 `--` |
| 详情页「深度分析」· 主课段数 | hint 是主课总距离，`workDistanceMeters = 0` 时**不渲染 hint**（零距离运动 lap 距离全为 0，旧实现写「0 段 · 0.00 km」像同步失败）。生产实证爬楼活动 551500889 返回 `workLaps 0 / workDistanceMeters 0` |
| AI 可比上下文 · 主课行 | `主课 N 段 / 0.00km` 改为 `主课 N 段`（`workDistanceMeters = 0` 时不写 km 数）—— 模型会把 0.00km 读成「主课几乎没移动」，与该运动按层/按次计时的真实语义相反 |
| **类型名（AI 数据块 + 详情页徽标）** | 走 `activityTypeName` 单一来源：真实库 **269/348** 条活动 `sub_sport_type='通用'`（227 跑步 + 篮球/爬楼/HIIT/跳绳/乒乓/羽毛球 42 条），旧实现 `sub_sport_type \|\| sport_type \|\| label` 让它 truthy 胜出 —— AI 数据块对 **77%** 的活动输出「类型: 通用」，详情页则并列渲染「通用」「训练」两个零信息徽标。见下方 §1.3 |
| 活动详情页概览 | 隐藏「即时跑力 / 平均配速 / 步频 / 步幅」整列（不是显示 `--`，那会让人以为数据缺失）；「平均功率」同样按字段存在性渲染 —— 真实库 107 条非跑步活动功率全为 NULL（0/107），旧实现无条件渲染会永远显示 `--`。**「训练负荷」按「该运动是否产出」门控**（`producesTrainingLoad` 单一来源：跑步三类型 + 力量训练）：真实库 354 条里跑步 247/247、力量 51/51 有值，**其余 9 类 0/56 全 NULL**（爬楼 30 / 室内有氧 9 / 游泳 4 / 篮球 3 / HIIT 3 / 跳绳 3 / 乒乓 2 / 羽毛球 1 / 室内骑行 1）—— 旧实现无条件渲染，这 56 条详情页永远挂着一个「-- 训练负荷」，与「平均功率」同一类噪音。判定必须走数据管线事实（`sync.js` 的 `runnableTypes2` + 力量派生），页面不许自己写 `!running && !== 'strength_training'`。**同一形态第二处**：`累计爬升` 也曾无条件渲染 `--`，而同页 `累计下降` 早已按字段门控 —— 两字段真实库 **85 条完全成对缺失**（`mismatch = 0`），现同口径按 `!= null` 渲染（不按类型白名单，否则就成了第三份「哪些类型有海拔」的判断）。通用判别式已机器化：`activity-detail-overview-real-db.test.tsx` 断言「没有任何整类恒为 `--` 的概览格」，唯一例外 `即时跑力` 自带守卫（116 条 `--` 的跑步 116/116 有 Garmin 官方 VO2max 同屏） |
| 仪表盘「本月概览」 | 「跑步天数」而非「活动天数」—— 数据源 `getTrainingLoads` 是跑步口径，真实库 2026-10 有 16 个活动日但只有 15 个跑步日（多出力量训练/爬楼）；旧标签会让人以为漏了一天。**同一行四格却是两种口径**（第十八类缺陷）：`本月距离`/`跑步天数`/`平均配速` 来自跑步口径，`训练负荷` 来自 `getCombinedTrainingLoads`（跑步 + 力量）—— 四格并列时没人会怀疑第四个。故「训练负荷」补 hint（`app/lib/load-scope.ts` 的 `monthLoadScopeHint`，唯一来源）：有力量负荷时写「跑步 + 力量合并（力量负荷 N）」，N 与下方力量卡「本月负荷」**同源同值**（用户可当场自证 `合并值 − 力量值 = /stats 上的跑步值`）；本月无力量负荷时写「跑步口径（本月无力量负荷）」—— 此时合并值 ≡ 跑步值，继续挂「合并」反而制造怀疑。「本月距离」同样补 hint「跑步口径（不含游泳/球类）」：真实库 2026 年跑步 1893.3km vs 全类型 1903.53km，差的 10.23km 全来自游泳 4 条 + 球类 6 条，**力量距离恒为 0**，措辞点错类型用户会去力量卡里找 |
| 统计页 `/stats` 九格 | 九格**全部**是跑步口径（`getStats()` 的 SQL 带 `runningTypeClause`，`db.ts:595`），旧实现一个字都没说 —— 而首页「训练负荷」是合并口径，真实库 2026-08 两处分别是 **1715 与 2004（差 289 / 17%）**、2026 全年 15668 vs 17171（差 1503；全历史 18122 vs 19788 差 1666），却共用一个名字。现用一句话覆盖九格（`STATS_SCOPE_HINT`）：「跑步口径：距离/配速/负荷/心率/步频等均只统计跑步（不含力量训练、爬楼、游泳、球类）」。**限定语必须点对全部类型**（第二十类缺陷）：旧文案只写「不含力量训练」，但九格的差值来源并不相同 —— 训练负荷差 1666 全来自力量（爬楼 0），**累计爬升差 1312m 却全来自爬楼**（力量 51 条爬升合计恒为 0），距离差 11.9km 来自游泳/球类。用户拿 Garmin 总爬升减 `/stats` 爬升，差的 1312m 去力量卡永远找不到。多列一个类型不会让人困惑，少列一个会让人找错地方。**不是把 `/stats` 改成合并**（那会让「跑步数据统计」名不副实），而是给同一个词加限定语。**同一页还有一处「不跟随周期」**：「当前跑力」固定取 `getStats('week').averageVDOT`（页面二次取数），另八格跟随 `period` —— 切到「年」时八格变全年、唯独跑力还是最近 7 天，旧实现没标注。真实库近 7 天 40.3（1 条）/ 2026 全年均值 39.6（106 条）/ 全历史 39.3（123 条）。口径本身对（「当前跑力」就该是最新的，跟随周期会退化成历史均值），故补 `CURRENT_VDOT_SCOPE_HINT`「近一周」 |
| 洞察页「训练负荷与周期」 | 三格里**两种口径**：急性负荷 (7天) / 慢性负荷 (28天周均) 来自 `getCombinedTrainingLoads`（跑步 + 力量），而峰值周跑量来自 `periodization`（`getInsightActivityRows` 带 `runningTypeClause`，**纯跑步**）。真实库近 28 天合并 1047 vs 跑步 987（力量 60）。旧实现一个字都没标 —— 这是第十八类（同一个词两个口径）漏掉的**第三处消费面**。现补 `INSIGHT_LOAD_SCOPE_HINT`：「跑步 + 力量合并（急性/慢性负荷含力量训练）；峰值周跑量为跑步口径（不含力量训练）」。**不复用** `combinedLoadScopeHint`：后者需要「力量负荷 N」算占比，而 `LoadInsight` 只带合并后的 `acute`/`chronic`、没有力量分量 —— 硬凑会引入第四份「力量负荷怎么算」的实现，宁可只说明口径不编数 |
| 区间环比 · 口径 | `formatPeriodComparison` 的【区间环比】块吃 `getPeriodStats`（SQL 带 `runningTypeClause`），整块自洽 —— 跑量/次数/时长/配速/心率/跑力/负荷**全部**是纯跑步口径。问题不在块内，而在**同一个 prompt 的另一个块**：`formatInsightForCoach` 的【全局训练指标】里负荷是跑步 + 力量合并（第二十五类刚标注「含力量训练」）。第二十六类缺陷：两个「训练负荷」在同一段 user 消息里口径相反，模型无法判断该信哪个。真实库近 90 天（2026-08-11 ~ 11-08）：跑步负荷 **4550** / 合并 **4958**（差 **408**，8.2%）。现于负荷行尾加 `PERIOD_COMPARISON_LOAD_SCOPE_HINT`：「跑步口径，不含力量训练」，与另一块形成对照而非矛盾 |
| 洞察页 · 活动链接路由 | 第二十八类缺陷：`/insight` 的常跑路线卡两处活动链接写成 `/${activityId}`，而详情页路由是 `app/pages/[id]/page.tsx` → `/pages/{id}`。生产实测 `/pbrun/659795962` → **404**、`/pbrun/pages/659795962` → 200；近 90 天洞察页有 **24 个**死链（6 条路线 × (1 最佳 + ≤5 最近)）。用户点「最佳 5:14/km」想看是哪一次跑，得到 404 页。现抽出 `app/lib/routes.ts` 的 `activityDetailPath()` 作为**站内活动链接唯一来源**，`/insight` / `/list` / 首页卡片三处全部改走它；新增静态守卫 `tests/unit/ci/route-hygiene.test.ts`（`app/**` 下出现 `href={`/${…}`}` 或 `router.push(`/${…}`)` 即红） |
| 页面正文 · Markdown 残留 | 第二十九类缺陷：JSX 文本节点**不解析 Markdown**，而项目里写 prompt/文档习惯用 `**加粗**`，顺手写进正文就会原样显示星号。两处同源：`app/daniels/page.tsx:54` 的「表格按该配速区间归集**跑步分段（laps）**」（生产页面实测原样显示 `归集**跑步分段（laps）**`）、`app/lib/components/ai/AiAnalysis.tsx:391` 的「本界面只回答**这一次训练**」。**为什么测试拦不住**：断言用的是正则**子串**匹配（`getByText(/平均心率、步频与步幅/)`），星号夹在句子中间完全不影响匹配 —— 测试通过、缺陷照旧；子串断言天生看不见「同一段文字里多出来的字符」。现改为真正的语义标签（`<strong className="text-fg">` / `<span className="font-medium">`），新增静态守卫 `tests/unit/ci/jsx-markdown-hygiene.test.ts`（`app` 下 `.tsx` 注释外出现成对星号即红，剥注释后才扫），并在页面测试里断言「整段文本不含星号」+ 自证该段确实渲染（防止退化成空断言） |
| 洞察教练上下文 · 口径 | `formatInsightForCoach` 生成的【全局训练指标】直接进洞察页/汇总页 AI 教练的 prompt（`llm.ts` 的 `insightBlock`）。第二十五类缺陷：同一段里两种口径并存 —— `周训练量` 的 km/时长/次数是**纯跑步**（`mergeStrengthIntoTrainingLoads` 只加 `load`），而 `TL`、`负荷: 急性/慢性/ACWR`、`训练负荷(EWMA): CTL/ATL/TSB` 都是**跑步 + 力量**。真实库 ISO 周 2026-W43：合并负荷 **256** / 跑步 **196**（差 60，全来自力量），而同一周跑量 **28.32km**、次数 **3** 只算跑步。不标注时模型会把 `28.3km/2:46:46/3次/256TL` 当成同一件事的三个侧面，算出「85 TL/km」这种无意义密度再据此建议加量。现在负荷行后追加「（负荷/TL/CTL/ATL/TSB 为跑步 + 力量合并，含力量训练；km/时长/次数只统计跑步）」，**只在真有负荷数据时输出**（无负荷时是噪音，还会让模型以为 km 也含力量） |
| 跑者画像（注入 AI）· 口径 | `formatRunnerProfile` 的文本会进入**每一次**活动分析的 prompt（`llm.ts` 的 `profileBlock`），而同一段文本里两种口径并存：生涯/近期跑量、次数、周环比、配速趋势走 `getStats` + `getActivities(runningOnly)`（**纯跑步**），负荷 CTL/ATL/TSB 走 `getCombinedTrainingLoads`（**跑步 + 力量**）。真实库全历史跑步负荷 **18122** / 合并 **19788**（差 **1666**，全来自力量训练）。第二十四类缺陷：整段没有一个字说明。危害比网页更严重 —— 模型会拿「近 28 天 8 次跑步」去解释一个含力量课的 CTL，然后在回答里编造「你的负荷主要来自跑量」这类因果（真实库近 28 天跑步 1030 / 合并 1090，力量贡献 5.8%）。现于负荷行后追加一句「（负荷为跑步 + 力量合并，含力量训练；上面的跑量/次数/配速只统计跑步）」，**只在有负荷行时输出**（无负荷时留着是噪音，还会让模型以为跑量也含力量） |
| 洞察页「周期化分析」 | 这张表**同一行两种口径**（第二十三类缺陷）：`computePeriodization` 吃的 `dailyLoads` 来自 `getCombinedTrainingLoads`（跑步 + 力量），但 `aggregateWeeklyLoad` 四个列各取不同字段 —— 跑量 `distanceMeters` 与次数 `runs` 是**纯跑步**（合并规则只加 `load`，这两个字段保留跑步值），而负荷 `tl` 与 CTL/ATL/TSB 是**跑步 + 力量**。真实库 ISO 周 2026-W43（10-19..10-25）：合并负荷 **256** / 跑步 **196**（差 60，全来自力量训练），而同一行跑量 **28.32km**、次数 **3** 都只算跑步。更危险的是**趋势图把两个口径画在同一坐标系**：「周跑量 (km)」是跑步口径、「TSB」是合并口径，用户会以为二者能互相解释（「跑量没变，为什么 TSB 掉了」的答案可能是力量课）。现补 `PERIODIZATION_SCOPE_HINT`：「负荷与 CTL/ATL/TSB 为跑步 + 力量合并（含力量训练）；跑量与次数为跑步口径（只统计跑步）」。**不能与上方负荷卡共用 `INSIGHT_LOAD_SCOPE_HINT`**：那张卡是「急性/慢性合并、峰值周跑量跑步」，与这张卡恰好相反，共用一句必然有一处说错 |
| 分析页「训练负荷 (Fitness / Freshness)」 | CTL/ATL/TSB 与负荷图都是**合并口径**（跑步 + 力量），力量卡在页面下方 —— 不在这里说明占比，用户看到 ACWR 变化找不到原因。卡片顶部补 `combinedLoadScopeHint`：有力量负荷时写「合并口径：含力量负荷 N（占 X%）」，无则写「跑步口径（区间内无力量负荷）」 |
| 仪表盘「年度里程」热力图 | 标题写「**年度跑步里程**」而非「年度里程」—— 数据源 `getDailyDistances` 带 `runningTypeClause`，真实库 2026 年比全类型少 10.23km（游泳 4 条 + 球类 6 条有距离）。只写「年度里程」会让用户以为那是全部运动的总里程 |
| 仪表盘「VDOT 趋势」 | 副标题「近 N 次跑步」而非「次活动」—— `getVDOTHistory` 只含跑步（`vdot_value` 只对跑步计算） |
| `/insight` 类别分布图 | aria-label「训练类别跑步次数分布」而非「活动数分布」—— `getInsightActivityRows` 是跑步口径，分类里的 `count` 是跑步次数 |
| `/insight` 强度分布标题 | 由**实际非零区间**派生（`zoneRangeLabel`：Z1–Z5 / Z3–Z4 / Z1, Z2, Z4），旧文案写死「Z1–Z6」是空承诺；配色只有 `--z1..--z5` |
| 分析页「当前跑力」副标题 | 「近一周跑步平均」而非「近一周活动平均」—— `currentVdot` 来自 `getStats('week').averageVDOT`，是跑步口径 |
| 丹尼尔斯页「当前跑力」说明 | 「近一周跑步活动的 VDOT 平均值」并注明「只含跑步，游泳/球类不参与」—— 同源 `getStats('week')` |
| `/stats` 个人纪录 · 日期时区 | 第二十七类缺陷：`RecordRow` 与「单次跑步最长距离」两处用 `new Date(iso).toLocaleDateString('zh-CN', …)` 渲染达成日期 —— 它读的是**进程/浏览器时区**，不是项目的固定 +480 业务时区。真实库 `longestRunDate = 2026-10-31T23:38:57.000Z`（那场半马）的业务时区是 **2026-11-01 07:38**，而 CI 的 `TZ=UTC` 腿渲染成 **2026/10/31** —— 同一个 PR 在两条腿上显示不同日期，用户手机时区一变记录日期也跟着漂。现改走 `formatDate`（`toBusinessWallClock`，与 `formatDateTime`/`formatListDateTime` 同一契约）。新增静态守卫 `tests/unit/ci/timezone-display-hygiene.test.ts`：`app/**` 下不得出现 `toLocaleDateString`/`toLocaleString`/`toLocaleTimeString`（剥注释后匹配） |
| `/stats` 个人纪录「单次最长距离」 | 「单次跑步最长距离」而非「单次训练最长距离」—— `getPersonalRecords` 带 `runningTypeClause`，游泳/球类不计入 |
| 全局教练【区间环比】次数行 | 「跑步次数」而非「次数」—— `getPeriodStats` 是跑步口径，模型若读成全部活动数会误判训练频率 |
| 活动详情页分段表 | 隐藏配速与步频列，不给「最快段」徽章；游泳改展示「配速 /100m」列（`distance = 0` 的休息段为 `--`） |
| 活动详情页分段表 · 计数列头 | **列头单位与卡片散文单位不是同一套**。`DataTable` 把 `unit` 渲染成标签下方的独立一行小字，而 `cycleCountLabel().unit` 是为散文设计的（「189 次跳跃」「307 步」「518 次划水」—— 散文里没有标签，单位必须自带名词）。直接搬进表格就读成「跳跃次数 / **次跳跃**」，同一个名词说两遍。故 `cycles.ts` 的 `CycleSemantic` 同时给两套形态：`label`/`unit`（散文）与 `lapLabel`/`lapUnit`（表格），经 `typeMetricsOf().cyclesLapLabel` 下发。真实库实测：跳绳「跳跃次数 / 次」、爬楼「步数 / 步」、游泳「划水次数 / 次」。**旧实现靠 `swimming ? '划水次数' : ...` + `swimming ? '次' : unit` 两条硬编码特例让游泳那格碰巧正确** —— 新增一种计数运动就必然出错（`type-metrics-call-sites.test.ts` 已锁死：调用方不得出现 `swimming ?` 分支） |
| 活动详情页概览 · 划频 | 游泳展示「划频（次/分）」而不是隐藏 —— 真实库 **4/4** 条游泳有 `average_cadence`（44/48/48/46），是划水频率；旧 `running` 门控把「步频」整格藏掉，连划频也一起消失。跑步仍走「步频（spm）」，两者单位与语义不同 |
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

#### 守卫升级：`Activity` 的 78 个字段也要机器审计

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

`ACTIVITY_FIELD_ALLOWLIST` 是显式技术债账本，每条写明理由，分五类：内部记账列
（`created_at` / `updated_at` / `start_tz_offset_min` / `elapsed_time` 恒等于 duration）、
聚类索引列（`route_cells` / `route_bounds` / `route_km` / `start_lat` / `start_lng`）、
语义陷阱（`max_heart_rate_fit` 是**设备配置值**不是本次峰值；`devices` 已脱敏）、
设备配置快照（`hr_zone_boundaries` / `user_height` / `resting_heart_rate_fit` /
`hrv_rmssd` / `hrv_rmssd_ratio` —— 见第六、七类缺陷）、
真实库 0/348 从不产出（`average_step_rate_loss*` / `max_power_to_weight` /
`avg_pos_grade` 等 4 项）、
以及仅追溯用的设备原始区间数组（`device_time_in_hr_zone` / `device_time_in_power_zone`
/ `device_time_in_speed_zone` / `device_time_in_cadence_zone` —— 统一口径列
`time_in_hr_zone` / `time_in_power_zone` 已分别被 `hrZoneBreakdown` /
`powerZoneBreakdown` 消费，见 §1.2）。

**正向谓词必须能区分「取值」与「被提及」**（2026-11-07 修，第六类缺陷）：
`isConsumed` 原来只剥注释，于是 tool description 里写一句字段名就骗过守卫。
现在多一步 `stripProseStrings()`（剥单/双引号字符串，保留模板字面量 —— SQL 列名
在反引号里）。守卫自身有 3 条缺陷注入测试钉住这个判别力。

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

#### `ActivityLap` 的 44 个字段也要机器审计（2026-10-27 补齐，2026-11-07 扩到 47）

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

> 字段数此后随第十/十一/十二/十三类缺陷增长：`total_cycles`（第十类）→ 45、
> `intensity`（第十二类）→ 46、`swim_stroke`（第十三类）→ 47。守卫里的等号是**有意的**：每加一列都必须显式
> 确认「它要么被消费、要么进账本并写明理由」，否则守卫会随 `types.ts` 扩张悄悄放宽。

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
0 基错位、也看不出「每公里」的假话。这与 `docs/testing-strategy.md` §6.5 的 `average_pace` 夹具是同一类问题：
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
合法化。这与上一节 `lap_index` 的 1 基夹具、以及 `docs/testing-strategy.md` §6.5 的 `average_pace` 夹具是
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

#### 「本地日期」必须出自固定业务时区，不得读进程/设备时区分量（2026-11-06）

上面第 3 条只修了 `ymd(now)`（UTC 日期），但「月份/今天」仍散落着
`new Date()` + `getFullYear()/getMonth()/getDate()`（**进程时区**分量）与
`new Date(dateOnly)`（设备时区解析 date-only 串）两种写法。本机 TZ=Asia/Shanghai
时碰巧全对，掩盖了问题；TZ=UTC 的环境（GitHub Runner、多数 Linux 服务器）
在 16:00Z 后「本月/今天」会差一个月/一天。缺陷注入方式：jest fake timers 定格
在 `2026-11-30T17:00Z`（+480 已是 12-01），旧实现读到 11 月 → 红。

**修复面（8 处，全部收敛到 timezone 模块）**：

| 位置 | 旧实现 | 新实现 |
|---|---|---|
| `getPersonalRecords` 周期窗口 | `new Date()` + 进程分量 + 私有 `localDateYmd` | `todayLocalDate()` / `localDateMinusDays` / `localDateMinusMonths`（月末钳制保留） |
| 首页本月/上月 | `getFullYear()/getMonth()` + `new Date(y, m-1, 1)` | `localMonthKeyOf` / `localMonthKeyMinusMonths` |
| zone 页默认半年窗 | `toISOString().split('T')[0]`（UTC 日期）+ `setMonth` | `todayLocalDate()` / `localDateMinusMonths` |
| MCP 训练负荷 / 每日里程 | `localDateStr(new Date())`（进程分量） | `todayLocalDate()` / `localDateMinusDays` |
| MCP `eachDay` | `new Date(start+'T00:00:00')` + `setDate` 链 | 纯字符串 + `localDateMinusDays` |
| 跑者画像兜底日 | `ymd(new Date())`（UTC 日期） | `todayLocalDate()` |
| `format.ts` 三个展示函数 | `new Date(iso).getHours()`（设备/进程时区） | `toBusinessWallClock`：带时区标记换算 +480，无标记（本地墙钟契约）透传 |
| StatsClient 期间标签 | `new Date(dateOnly)`（UTC− 设备差一天） | 字符串分量直接拼装 |

新增 helper：`localMonthKeyOf` / `localMonthKeyMinusMonths` /
`localDateMinusMonths`（日越界钳制到月末）/ `toBusinessWallClock`。
`db.ts` 的私有 `localDateYmd`（进程分量拼装）随之删除。

守护：`tests/unit/lib/db-gaps.test.ts`（fake timers 跨月时刻，四个周期窗口逐一断言，
TZ=UTC 必红于旧实现）、`tests/unit/lib/timezone.test.ts`（新 helper + TZ 无关穷举）、
`tests/unit/lib/format.test.ts`（TZ=UTC/America/New_York 下输出一致）。
全量 `TZ=UTC` 与本地双绿（174 套件 / 2819）—— 此前只对 `db-stats-branches` 单文件
做过 TZ=UTC 验证，本次起全量口径也过一遍。

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
断言它们）。这与 `docs/testing-strategy.md` §6.5 的 `lap_index` 1 基夹具、`periodization` 手写 km 是同一个机制
（见 `docs/testing-strategy.md` §6.5）。

---

### 1.6 力量训练：第三套口径（2026-11 新增）

生产库 51 条 `strength_training`（2025-12 ~ 2026-10）此前**「收录了但零分析语义」**：
不进训练负荷、没有结构化画像、UI 与 AI 都看不到。根因是 `scripts/garmin/sync.js` 的
`calculateTrainingLoad` 派生分支只对跑步三类型开放（`runnableTypes2`），于是 51 条
力量课的 `training_load` **全为 NULL** —— 每周 2 次力量课对 ACWR/CTL/TSB 的贡献恒为 0。
身体不区分负荷来源，这是教练视角的盲区。

#### 数据边界（实测，不要越界造假）

| 想拿 | 可得性 | 依据 |
|---|---|---|
| 动作名（深蹲/卧推） | ❌ | FIT 里没有 `set` 消息；Garmin 只在云端 `exerciseSets` 提供 |
| 重量 / 次数 | ❌ | 同上（**51 条本地 FIT 实测 `set`/`exercise_title` 消息数为 0**） |
| 训练计划名 | ✅ 49/51 | `activities.workout_name`（「全身循环1」「核心稳定性4」等） |
| 组结构（active/rest 交替） | ✅ 49/51 | `activities.workout_steps` JSON（每步 `duration_sec` + `intensity`） |
| 时长 / 平均心率 / 卡路里 | ✅ 51/51 | 平铺列（平均心率 73–129） |
| 训练效应 (TE) | ✅ 51/51 | `total_training_effect` / `total_anaerobic_training_effect` |
| 官方恢复建议 | ✅ 51/51 | `recovery_time`（**分钟**） |

**结论：不做容量（组数 × 重量）指标。** 硬造就是假数据。输出的是「计划名 + 有效组数
+ 工作/休息时长比 + 强度域」这套真实可推导的画像。

#### 为什么**不**把 `strength_training` 并入 `RUNNING_ACTIVITY_TYPES`

零距离活动混入跑步口径会把指标系统性污染：均配速 369 → 989 s/km（实测量级）、
心率 Z1 时长从 698s 变 91221s、配速区间 `activity_count` 凭空 +51。力量训练有**自己
的语义**（组结构 + 训练效应），不是「跑得慢的跑步」。

#### 负荷口径（不复用跑步的 HR-TRIMP）

`时长(h) × 100 × 域系数`，系数按**训练效应**加权：

| 强度域 | 判定（TE 优先，心率兜底） | 系数 |
|---|---|---|
| high | TE ≥ 3.5 | 1.5 |
| tempo | TE ≥ 2.5 | 1.3 |
| base | TE ≥ 1.5 | 1.0 |
| recovery | TE > 0 | 0.6 |
| unknown | TE/HR 均缺失 | 0.8 |

心率兜底：<100 recovery、<130 base、否则 tempo。

**为什么不用跑步的 HR 区间系数**：力量心率响应滞后且峰值低（51 条平均心率 73–129，
多在 Z1/Z2），套 Z1 系数 0.6 会让 32 分钟力量课的负荷趋近于零 —— 等于没接。真实库
回填后力量负荷均值 **32.7**（跑步 73.2），量级合理。

**量纲**：与库内跑步 `training_load` 同量纲，但**不是** Garmin 官方
`training_load_peak`（后者与库内值比值 1.2–2.6 倍浮动、不可换算）。

#### 合并规则：负荷相加，里程/时长/次数不合并

| 字段 | 规则 | 理由 |
|---|---|---|
| `load` | **相加** | 力量训练也是负荷，ACWR/CTL/TSB 必须看见它 |
| `distance` | 只取跑步 | 力量训练无距离语义（51/51 为 0） |
| `duration` | **只取跑步** | 该字段喂「当月均配速」（Σduration/Σdistance），混入力量时长会把配速拖慢 |
| `runs` | 只取跑步 | 「跑步次数」标签语义；力量课不该被算作跑步 |

**为什么不在 `getTrainingLoads` 里原地合并**：该函数有 10+ 消费方（含首页「跑步天数」
标签、月度里程、跑者画像）都假设「只有跑步」。原地改语义会让所有调用方在无声中变味。
故新增显式入口 `getCombinedTrainingLoads`，口径可见、可单测。

**真实库验证**（近 28 天）：ACWR 1.40 → 1.32（慢性 227.25 → 242.25），而
`distance`/`duration`/`runs` 偏差**全为 0**（口径零污染）。

#### 边界：其余 56 条非跑步活动**不纳入**合并负荷（已明确声明）

合并负荷只并 `strength_training` 一类，**不并**游泳/球类/爬楼/HIIT/跳绳/室内有氧/骑行。
真实库这 56 条共 18.6 小时（爬楼 30 条 519 分、游泳 4 条 178 分、篮球 3 条 166 分、
室内有氧 9 条 125 分、乒乓 2 条 63 分、HIIT 3 条 35 分、骑行 1 条 18 分、羽毛球 1 条 9 分、
跳绳 3 条 4 分），`training_load` **0/56 有值**（Garmin 只在跑步与力量课写该字段）。

不纳入的理由（不是遗漏，是刻意的口径决定）：

1. **无负荷字段可并**：`training_load` 全为空，若按「时长 × 心率」自行估算，得到的数
   与 Garmin 官方口径不可比 —— ACWR 会变成「一半官方值 + 一半自制值」的混合物。
2. **量级不成比例**：56 条合计 18.6 小时 vs 跑步 219.9 小时（7.8%）。真正需要「看见」
   的交叉训练影响（篮球 55 分/次、游泳 45 分/次）在近 28 天窗口内往往一次都没有，
   并入与否对 ACWR 的影响小于其估计误差。
3. **力量训练是例外而非同类**：力量课有**可复现的派生负荷算法**
   （`strengthLoadOf` = 时间基数 × 强度域系数，由 TE 判定强度域），与跑步
   `training_load` 同量纲、可逐项验证；游泳/球类的强度无法从现有字段稳定推导
   （球类间歇密度无法从逐秒记录稳定切分 —— 注意**划频与总划水次数都可得**：
   真实库 4/4 条游泳都有 `average_cadence` 44/48/48/46 次/分，
   `total_cycles` 518/798/923/695 即总划水次数，见第十类缺陷）。

**用户可见性**：这些活动在 `/list` 全类型日志、详情页、AI 单次复盘里都完整可见
（AI 走 `SINGLE_NON_RUNNING_PROMPT` 按各运动专项解读），只是不进入 ACWR/CTL/TSB
这条**负荷时间序列**。MCP `get_training_load_analysis` 的 description 已声明
「负荷合并含力量训练」，不声称含全部运动。守护：
`tests/unit/mcp/tool-scope-contract.test.ts` 的 `COMBINED_SCOPED` 断言。

若将来要纳入游泳/球类，必须先解决「强度从哪来」—— 在 FIT 补上泳姿/球类
间歇数据之前，自制系数只会让 ACWR 失去可比性。（泳姿**已在 lap 级 FIT 里**
（`swim_stroke`：freestyle/backstroke/breaststroke/mixed，见「第十三类缺陷」），
并已入库（35/3153 段）；总划水次数也已入库（`total_cycles`）。但**泳姿与划水次数
都不足以给出强度系数** —— 缺的是「每段用了多大力」，那需要功率或阈值泳速，
FIT 里没有。）

**消费方清单（必须全部走合并入口，漏一个就分叉）**：首页 `/`、分析页 `/analysis`、
洞察页 `/insight`（`insight-service.getInsight` 的 `getCombinedTrainingLoads`）、
跑者画像 `runner-profile.ts`、MCP `get_training_load_analysis`。
洞察页曾漏接（仍走跑步口径的 `getDailyLoads`），导致同一时期洞察页 ACWR 1.40
而首页 1.32 —— 两张卡都自洽、无法判断谁对。守护：
`tests/unit/lib/insight-services.test.ts`（断言 `getCombinedTrainingLoads` 被调用
且 `getDailyLoads` **未**被调用 + 预热窗口不变）。

#### 首页「跑步天数」的陷阱（已修）

`thisMonthRuns` 原用 `(p.load ?? 0) > 0` 判定。负荷合并后，「只做力量、没跑步」的日子
`load > 0` 但 `runs = 0` —— 用 load 判定会把它算成跑步日。已改为 `(p.runs ?? 0) > 0`，
并在代码里写明理由。这是**合并口径**接入时最容易漏的一处语义漂移。

#### 同步层与双实现一致性守护

`scripts/garmin/sync.js` 是纯 CJS（不经 tsc），无法 import TS。故
`scripts/common/strength-load.js` **逐行镜像** `app/lib/strength.ts`，由
`tests/unit/lib/strength-sync-parity.test.ts` 穷举比对：

- 12×12 TE×心率组合（`strengthIntensityDomain`）
- 11×5 时长×强度域（`estimateStrengthLoad`）
- 7×7 时间基数（`strengthLoadBaseSeconds`）

任一侧改阈值而另一侧没跟上 → 红灯。没有这份测试，同步写入的 `training_load` 会与
页面/MCP 展示的负荷分叉，且**不会报错、不会让任何测试变红**，只在 ACWR 数字对不上时
显形。历史 51 条由 `scripts/garmin/backfill-strength-load.js` 回填（幂等，
支持 `--dry-run`/`--limit`），回填后 NULL 为 0 条。

#### 组结构的真实形态（不要推断轮数）

`workout_steps` 每步含 `duration_sec` + `intensity`（`active`/`interval` = 工作段，
`rest`/`recovery` = 休息段）。真实库最常见形态是 14 步（7 个 40s 工作段 + 6 个 20s 休息段
+ 1 个 `open` 尾段休息），计划时长合计 **400s**；`describeStrengthStructure` 把它压缩成
「40s 做 / 20s 歇 × 6 → 40s 连续」。**不要写成 ×7** —— 末段休息没有时长，不是完整的一组。

**关键事实**：计划时长（真实库「核心稳定性1」为 **400s**，末段 rest 是 `open` 无时长）远小于
实际时长（3609s）—— 课表是**「一轮」模板**，
用户做了多轮。FIT 无 `set` 消息，**真实轮数不可得**，因此画像只报课表结构本身
（`describeStrengthStructure` 输出「40s 做 / 20s 歇 × 6 → 40s 连续」—— 末段休息是 `open`
无时长，故不是整齐的 ×7），**不推断「做了 8 轮」**。

#### `repeat_until_*` 是循环控制步，不是训练段

FIT 用 `duration_type` 为 `repeat_until_*` 的步骤表达「回跳到前面第 N 步，直到满足条件」，
它**本身不是训练段**：`duration_sec` 恒为 `null`。真实库有 **3 条**课表末尾带
`repeat_until_steps_cmplt`（「全身肌群循环式训练 3」×2、「核心肌群稳定性训练 4」×1）。

旧实现只按 `intensity === 'active'` 判工作段，于是这 3 条被算成第 8 个（虚构的）工作段：

| 指标 | 正确值 | 旧实现 | 后果 |
|---|---|---|---|
| `workingSets` | 7 | **8** | 「本月有效组数」虚高（给用户看的数字） |
| `restSets` | 7 | **8** | 同上 |
| 结构描述 | `40s 做 / 20s 歇 × 6 → 40s 连续` | 末尾多出 `→ ? 连续` | 页面出现 `?` 噪音 |

修复用**前缀匹配** `duration_type.startsWith('repeat_until_')`，而不是写死
`repeat_until_steps_cmplt` —— FIT 有 8 种 `repeat_until_*` 变体（time/distance/calories/
hr_less_than/hr_greater_than/power_less_than/power_greater_than/steps_cmplt），写死必然漏掉其余。
真实库复验：51 条课表工作段总数 **352 → 349**（正是那 3 条虚高）。

守护：`tests/unit/lib/strength.test.ts`（真实课表 + 5 种 `repeat_until_*` 变体）、
`tests/unit/lib/db-strength.test.ts`（聚合层组数不虚高）。

#### AI 上下文（力量课不走「非跑步」通用分支的默认值）

力量课在 `buildAnalysisMessages` 里走「非跑步」分支，但**必须**额外注入四项专属数据，
否则模型只能凭时长和心率编故事：

| 注入项 | 值 | 为什么必须有 |
|---|---|---|
| `力量训练计划` | `workout_name` | 模型要能说「这堂课是核心稳定性1」 |
| `组结构` | `describeStrengthStructure` 输出「40s 做 / 20s 歇 × 6 → 40s 连续」 | 唯一能描述课表形态的真实数据 |
| `有效组数 / 休息段 / 工作:休息` | 画像派生 | 判断课表类型与刺激性质 |
| `计划时长 / 实际时长`（**分两行**） | 6:40 vs 1:00:09 | 混成一行会让模型把 6 分 40 秒当成本次训练量 |
| `强度域`（按 TE 判定） | `recovery/base/tempo/high` | 力量心率滞后，判强度必须看 TE |
| 数据边界句 | 「重量与次数不可得」 | 不写，模型会「合理推断」出深蹲 80kg×5 |

同时 `SINGLE_NON_RUNNING_PROMPT` 已修正一处**新旧矛盾**：旧文案写「非跑步活动不计算
训练负荷，数据里也不会出现」，而力量课现在**有**派生负荷。现文案区分「只有力量训练
有派生负荷（不可与 Garmin 官方 training_load_peak 直接比）」与「游泳/球类/爬楼/跳绳
不计算负荷」。守护：`tests/unit/lib/coach-prompt-data-alignment.test.ts`（4 例）。

追问建议也按类型分流（`followup-suggestions.ts` 的 `strength` 标志）：力量课不再问
「心率漂移说明了什么？有氧能力如何？」（错的维度），改问组结构合理性 / 强度域与恢复
预算 / 与跑步的负荷竞争。守护：`tests/unit/components/followup-suggestions.test.ts`（6 例）。

守护：`tests/unit/lib/strength.test.ts`（32 例）、`strength-merge.test.ts`（9 例）、
`strength-summary.test.ts`（10 例）、`db-strength.test.ts`（12 例）、
`strength-sync-parity.test.ts`（5 例）、`llm.test.ts`（力量数据块 5 例）、
页面测试（首页 11 / 分析 15 / 详情 54）。

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

`average_pace = 计时器时间 / (distance/1000)`（口径见 `docs/testing-strategy.md`「配速的时间基数」）。分母很小时
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

#### 第四类缺陷：AI 拿得到、用户在页面上看不到（2026-11-07）

第三类修完「prompt 要求 → 数据块供给」之后，仍有反向缺口：**数据块给了模型、
详情页概览却从不渲染**。用户在 AI 复盘里读到「训练效果 3.6、消耗 542 kcal」，
回到概览找不到任何出处 —— 无法判断模型是引用还是编造。

| 字段 | 真实库覆盖 | 缺陷 | 后果 |
|------|-----------|------|------|
| `max_heart_rate` | **353/353**（含全部 107 条非跑步） | 概览只给平均值 | 「平均 158 / 最高 176」是判断「有没有顶到极限」的唯一组合，只给均值会让人以为整堂课都是均速均强 |
| `total_training_effect` | **353/353**（有氧 1.5–5.0） | 零展示 | 非跑步提示词明确要求「改用 TE + 心率区间 + 热量量化强度」，三项一个都不在页面上 |
| `calories` | **353/353** | 零展示 | 同上 |
| `primary_benefit` | **353/353**（8 类） | 零展示 | Garmin 对「这次练到了什么」的官方结论，比任何派生指标都直接 |
| `total_descent` | **268/353**（跑步 238 + 爬楼 30） | 零展示 | 只给爬升会漏掉下坡的离心负荷（DOMS 来源），也分不清「折返（升降相等）」与「单向爬升」 |
| `garmin_vo2max` | **238/246 跑步** | 零展示 | 本地 `vdot_value` 只有 122/246 —— **116 条跑步活动「即时跑力」显示 `--` 而官方值就在库里** |
| `normalized_power` / FTP | **246/246** | 零展示 | 概览给了 IF 0.82 与 TSS 41，但 IF = NP ÷ FTP 的两个输入都不在页面上，无法自证 |
| `avg_altitude` | **238/353**（非跑步 0/107） | 只在注释里提过 | 提示词要求「引用环境可比段」，数据块给「平均海拔」，页面没有出处 |
| `average_temperature` | **231/353**（非跑步 0/107） | 零展示 | 同上；且容易与深挖面板的「温度漂移」（首尾温差）混淆，标签必须写「平均温度」 |
| `max_speed` | **48/353**（跑步 37） | 零展示 | 数据块给「最大速度 28.8 km/h」，页面无出处；且游泳/球类比值可达 85 倍，必须跑步门禁 + 「瞬时」标签 |

修复：概览新增 `最大心率 / 有氧训练效果 / 无氧训练效果（>0 才渲染）/ 热量 / 累计下降 /
训练收益 / Garmin VO2max（running 门禁）/ FTP / 标准化功率 / 平均海拔 / 平均温度 /
瞬时最大速度（running 门禁）`，
全部按**字段存在性**渲染（`0` 与 `null` 不是一回事：无氧 TE = 0 是「纯有氧课」的
正常形态，显示 `0.0` 像缺数据；`avg_altitude` / `average_temperature` 在 107 条
非跑步活动上全为 NULL —— 室内/球类没有 GPS 海拔与环境温度，整格不渲染）。

#### 第五类缺陷：跑步口径内部的类型差异被吞掉（2026-11-07）

第四类修完后继续查「哪些活动在页面上没有身份」，发现一个更隐蔽的：**跑步不是
一种运动**。跑步口径是三个类型（`running` / `track_running` / `treadmill_running`），
而三处徽标判定都写 `!isRunningType(...)` —— 于是后两者被判为「普通路跑」，
**真实库 13 条活动（田径场 6 + 跑步机 7）在详情页 / `/list` 卡片 / 首页最近活动
上完全没有类型标识**。

为什么这不是「细节」：

| 类型 | 差异 | 后果 |
|------|------|------|
| `treadmill_running` | `avg_altitude` / `total_ascent` / GPS 轨迹全为 NULL；配速不含风阻与坡度 | 用户拿跑步机配速对比路跑配速，会误判自己「变快了」 |
| `track_running` | 每圈 400m，配速可精确对标；无 GPS 漂移 | 与路跑配速混在一起统计，会稀释田径场的精确性 |
| `running` | 含风阻/坡度/GPS 漂移 | —— |

修复：`sport.needsTypeBadge()` 单一判定 —— 非跑步恒 true，跑步里只有 `running`
为 false，空值 false（旧库兼容按跑步处理，但没有信息量）。三处徽标全部改用它。

纪律：**「同一口径」不等于「同一身份」**。把三个类型合并成「跑步」做统计是对的
（可比性），但在**展示层**必须保留区分 —— 否则用户无法解释「为什么这次没有海拔」。
守护：`tests/unit/lib/sport.test.ts`（13 个类型逐条断言 + 与 `isRunningType` 的同源
不变式）+ 详情页 3 例（田径场/跑步机显示徽标、普通路跑不显示）+ `/list` 2 例 +
首页卡片 2 例。

纪律：**凡是数据块给了模型的数字，详情页必须能找到出处**。守护：
`tests/unit/pages/activity-detail.test.tsx`（「高覆盖官方字段必须展示」逐字段断言 +
「无氧 TE = 0 不渲染」+「缺 Garmin VO2max 仍给即时跑力」+「非跑步不渲染 Garmin VO2max」+
「IF/TSS 的分子分母同屏」+「非跑步不渲染 FTP/NP 整块」+「非跑步不渲染平均海拔/平均温度」+「非跑步不渲染瞬时最大速度」）。

#### 第六类缺陷：消费守卫被「说明文字」骗过（2026-11-07）

前五类缺陷都是「数据在库里但没到用户手上」。查这一类时依赖的核心工具是
`tests/unit/components/insight-field-consumption.test.ts` —— 它把 `types.ts` 的每个
字段逐个断言「出现在某个消费方源码里」。这个守卫本身有一个致命盲区：

**它只剥注释，不剥字符串字面量。** 于是下面这种「在 tool description 里提了一句」
就能把字段判成「已消费」：

```ts
// mcp-server/tools.ts —— get_activity 的 description
'devices(设备列表 JSON, 已脱敏)、user_weight/user_height/resting_heart_rate_fit(用户档案)、'
'hrv_rmssd(HRV 毫秒, 仅部分活动有)。'
```

实测：把单/双引号字符串剥掉后，这 4 个字段立刻显形为**完全未被取值**：

| 字段 | 真实库覆盖 | 真相 |
|------|-----------|------|
| `hr_zone_boundaries` | 353/353 | 设备原始边界（21 套方案），app 5 区走 `resolveMaxHr()` 本地重算 |
| `user_height` | 352/353 | 全站仅 4 个取值，无任何 BMI/体表面积计算引用 |
| `resting_heart_rate_fit` | 210/353 | **手表日级配置值**，仅 7 个取值（42–48），同日多活动同值 |
| `hrv_rmssd` | 20/353 | 见下方第七类缺陷 |

这 4 个字段的「消费」全都只发生在 description 字符串里，UI 与 AI 数据块一次都没读过。
同类「仅被提及未取值」的还有已在 allowlist 的 `device_time_in_hr_zone` /
`device_time_in_power_zone` / `devices`。

**为什么这个缺陷比单个字段漏展示更严重**：守卫是「防同类缺陷再发生」的唯一机器闸门。
一旦它被说明文字骗过，**整个字段族都可以安静地永不展示而全绿** —— 它失效的方式
恰好是「看起来在工作」。

修法：

1. `isConsumed` 增加一步 `stripProseStrings()`（剥单/双引号字符串），
   **但保留模板字面量** —— `db.ts` 的 SQL 列名写在反引号里
   （`` db.prepare(`SELECT ${col} FROM ...`) ``），剥掉会让大量真实消费误判为未消费。
2. 新增 `describe('消费守卫自身的判别力（缺陷注入）')` 三条：说明文字里提到 → 不算消费；
   真正取值/对象键/模板字面量列名 → 算消费；注释里提到 → 不算消费（原有纪律不回退）。
3. 把这 4 个字段写进 `ACTIVITY_FIELD_ALLOWLIST`，每条写明**为什么不是单次训练指标**
   （而不是「还没做」）。

守卫修好后**立刻抓到一个真实遗漏**：`VdotTrendFit.perMonth[].min`（月度最低 VDOT）
在 `insight.ts` 算了、`InsightClient` 只画了 avg/max、AI 数据块也只给月均值。
补进 VDOT 趋势图第三条序列 + AI 数据块「均/高/低」三值同行 ——
**只给均值会把「这个月掉得很惨但均值还行」的形态抹平**，而最低值才是疲劳的第一信号。

#### 第七类缺陷：`hrv_rmssd` 是伪指标，且已被写进 MCP description 供模型引用（2026-11-07）

修第六类时发现 `hrv_rmssd` 不只是「没展示」，而是**算错了**。

## 自证性检验

RMSSD = 相邻 RR 差值的均方根，因此**必然 ≤ 全程 RR 极差**。真实库 20 条有值的活动里
**4 条物理不可能**：

| 活动 | RMSSD | RR 极差（由逐秒心率算） | 比值 |
|------|-------|----------------------|------|
| `585811407` | 163.59 ms | 108.3 ms | **1.51** |
| `657456825` | 154.64 ms | 113.9 ms | **1.36** |
| `573740964` | 133.68 ms | 85.5 ms | **1.56** |
| `563735336` | 128.67 ms | 107.7 ms | **1.19** |

两个旁证同样致命：`RMSSD/meanRR` 中位数 **0.324**（运动中该 < 0.10），
`r(平均心率, RMSSD) = +0.723`（生理上应为**负**相关 —— 运动越猛 HRV 越低）。

## 根因：FIT `hrv.time` 里的「漏拍合并值」

`hrv.time` 确实是逐个 RR 间期长度（不是时间戳），但设备在**心搏漏检**时会把 2~3 个
真实间期合并成一条记录。真实 FIT 抽样（`585811407`，6877 条 hrv 消息）：

```
[0.424,0.424,0.424,null,null]   ← 一条消息最多 5 个 RR，尾部 null 补齐
[0.693,1.042,null,null,null]    ← 1.042 ≈ 3 × 0.347（漏拍合并）
[0.725,0.363,null,null,null]    ← 0.725 ≈ 2 × 0.363（漏拍合并）
```

旧实现把「合并值 + 正常值」序列直接求相邻差，等于把每次漏拍当成一次巨大 RR 跳变，
RMSSD 被伪迹主导。伪迹占比 5.7%–10.8%，但贡献了绝大部分方差。

## 修法：滑动中位数识别倍频后拆分

对每个 RR 取 ±31 拍窗口的中位数 `m`，若 `v ≈ k·m`（k∈[2,4]，容差 35%）就拆成
k 个 `v/k`。用**滑动**窗口而不是全局中位数，是因为运动中 RR 会随强度缓慢漂移
（同一活动内 0.34→0.46 s），全局基准会把漂移误判成倍频。

同时新增 `hrv_rmssd_ratio`（`RMSSD/meanRR`，无量纲）作为**自证性字段** ——
它可以直接和生理区间比对，不依赖具体心率水平。

## 修复后实测（20 条全量重算）

| 指标 | 修复前 | 修复后 |
|------|--------|--------|
| `RMSSD/meanRR` 中位数 | 0.324 | **0.037** |
| 取值范围 | 0.259–0.458 | **0.004–0.085**（运动中正常区间） |
| RMSSD > RR 极差 | **4 条** | **0 条** |
| `r(平均心率, RMSSD)` | +0.723 | **−0.254**（生理正确的负相关） |

`564586771`（爬楼，RMSSD 23.67）原本就是唯一合理的，修复后不变。

## 纪律：修好不等于该展示

算法修好后 `hrv_rmssd` 仍然**不进 UI/AI 数据块**，理由写在 allowlist 里：覆盖仅
20/353（5.7%），运动中 HRV 受呼吸/伪迹影响大，**不是可靠的单次训练指标**；
Garmin 官方 HRV Status 是**隔夜**测量，不能用本值替代或类比。保留在库里供未来
「HRV 趋势」专项使用。

MCP `get_activity` 的 description 也同步改写：删掉「`user_height`/`resting_heart_rate_fit`
（用户档案）」这类把配置值当个人指标的措辞，`hrv_rmssd` 明确标注「已拆分设备漏拍合并值、
仅 20/353 条有值、不做跨活动对比」，并新增 `hrv_rmssd_ratio` 的解读边界。

守护：`tests/unit/garmin/fit-parser-branches.test.js` 新增 4 例 ——
漏拍合并值必须拆分（对照未拆分的 >100ms）、3 倍漏拍、消息尾部 null 不得当 0ms、
RMSSD 恒不超过 RR 极差（自证性不变式）。

#### 第八类缺陷：第三个交付面（hermes skill）不在版本控制里，也没有守卫（2026-11-07）

前七类缺陷都在查 **Web 站与 MCP server 的数据对不对**。pbRun 实际有**三个交付面**：

| 交付面 | 用户看到什么 | 守护 |
|--------|------------|------|
| Web 站 | 页面上的数字与图表 | `tests/unit/pages/`、`tests/unit/components/` |
| MCP server | 模型拿到的工具返回值 | `tests/unit/mcp/tool-scope-contract.test.ts` |
| **hermes skill** | **模型读的训练提示词** | **无**（2026-11 之前） |

`~/.hermes/skills/leisure/pbrun-coaching/` 是一份 300 行的教练提示词，模型据此判断
「HRV 低不低」「区间怎么分」「跑步口径是什么」。它**只存在于家目录、不在 git、
没有任何测试** —— 于是它可以长期与代码漂移，而**没有任何信号**。

实测已漂移出四处，每一处都会直接污染 AI 给出的训练建议：

| 断言 | skill 原文 | 真实情况 | 后果 |
|------|-----------|---------|------|
| HRV 阈值 | `>100ms` 恢复好 / `<60ms` 需减载 | `>100` 命中 **0/20**、`<60` 命中 **20/20** | **每一次活动都被判「需减载」** |
| 区间数组 | `[低于Z1, Z1..Z5]` 共 6 项 | **5 项，索引 0 = Z1** | 所有区间占比错位一格 |
| Z3/Z4 边界 | `~85-90%` / `~90-95%` maxHR | `Z3 <87%` / `Z4 <93%` | 与页面显示的区间对不上 |
| 力量课平均心率 | `73–129` | **68–129** | 漏掉最低值那条 |

**为什么这类缺陷最危险**：代码里的错数字会被测试、类型、运行时异常中的某一环挡住；
**提示词里的错数字不会让任何测试变红**，它只会让模型「自信地」给出错误建议 —— 而且
看起来和正确输出一模一样。HRV 那一条尤其致命：它不是偶尔误判，而是**对每一条活动都
误判**，因为运动中 RMSSD 的真实区间（1.2–34.0ms）与跑步圈流传的静息 HRV 区间
（60–100ms）根本不是一个尺度。

修法：

1. **单一来源**：skill 移进仓库 `skills/pbrun-coaching/`，
   `~/.hermes/skills/leisure/pbrun-coaching` 改为**软链**指向它。重建方法写进
   `docs/ops.md`（重装 hermes / 换机后必做）。
2. **机器守卫** `tests/unit/docs/skill-doc-contract.test.ts`（20 例）。真值来源分三类，
   **都不允许把数字再抄一遍**（抄一遍只是把漂移换个地方发生）：
   - 代码常量 → 直接 `import { HR_ZONE_BOUNDS } from app/lib/hr-zones`、
     `import { RUNNING_ACTIVITY_TYPES } from app/lib/sport` 对撞；
   - 真实库覆盖 → 力量课 `workout_name` 覆盖率、平均心率区间、游泳 `training_load`
     覆盖率、划频取值逐项查询；
   - 结构性断言 → 「不得再出现 `>100ms = 副交感活跃` 这类正向判读规则」。
3. **不允许静默跳过**：skill 被移出仓库时 `SKILL_PATH` 不存在 → 测试直接失败，
   而不是「文件不在就 return」。
4. **缺陷注入验证判别力**：把三处旧错误写回去，4 条断言立刻转红。

纪律：**「数据对」不等于「提示词对」**。任何被模型读取的文档都是交付面，都必须
进版本控制、必须有守卫，且守卫必须用**缺陷注入**证明它不是「永远绿」。

#### 第十类缺陷：FIT 原始文件里有值、解析器整体丢弃、文档断言「设备不写」（2026-11-07）

前九类缺陷有一条共同前提：**数据至少进了库**，问题在「怎么算」或「怎么展示」。
第十类是更上游的断点：**FIT 原始文件里有值，解析器根本没读，于是库里从来没有这一列**，
而文档/提示词却把「库里没有」当成「设备不写」并写成了断言。

##### 判据（三段全中才是这一类）

1. FIT 原始 `session`/`lap` 消息里有这个字段（用 `fit-file-parser` 直接读能拿到值）；
2. `scripts/garmin/fit-parser.js` 的 `_extractActivityData` / `_extractLapsData` 里
   **没有** `_safeGet*(msg, '<字段>')`；
3. `docs/` 或 `skills/` 或提示词里有一句「本数据源不提供 / FIT 不写 / 不可得」。

三段全中 = 我们丢的数据 + 我们对模型说了假话。只有第 1、2 段（没人断言不可得）是
「未利用字段」，属于待办；只有第 3 段（真没有）是正确声明。

##### 实测命中：`total_cycles` 与「总划水次数不可得」

| 字段 | FIT 覆盖 | 解析器 | 文档断言 |
|------|---------|--------|---------|
| `total_cycles` | **349/353** | **不读** | 4 处写「总划水次数不可得，不要索要」 |

`total_cycles` 是 **FIT session 与 lap 两级都有**的绝对计数（`uint32`，`scale: null`），
**语义随运动而变**，这是它最容易被误读的地方：

| 运动 | 语义 | 真实库自证 |
|------|------|-----------|
| 游泳 | **总划水次数** | 518 / 798 / 923 / 695 |
| 跳绳 | **总跳跃次数** | 189 / 187 / 193 |
| 跑步 | 步幅周期数 | 3352 ≈ `avg_cadence`(90) × 2202s/60 = 3303 |
| 爬楼 | 总步数 | 307 / 331s |
| 球类 | 挥拍/触球动作周期 | 篮球 1685 / 1488 / 2399 |

**绝不能 ×2。** `average_cadence` 对跑步做了 ×2（FIT 的 90 是单侧周期/分 → 180 spm），
但 `total_cycles` 是**绝对计数**：518 次划水 ×2 = 1036，与 775m ÷ 1.50m/划 对不上。
这是「同名换算规则不能跨字段复用」的典型 —— 换算规则属于**字段**，不属于「cadence 这个词」。

##### 自证性不变式（两条，都不依赖外部标准）

1. **`Σ lap.total_cycles == session.total_cycles`** —— 4/4 条游泳精确相等
   （518/518、798/798、923/923、695/695）。这一条同时证明 lap 级也要回填：
   只有 session 级有值，分段里的「本段划了多少次」仍然缺失。
2. **`total_cycles ÷ 活跃时间 ≈ FIT avg_cadence`** —— 518 / 21.4min = 24.2 vs 24、
   798 / 33.5 = 23.8 vs 24、923 / 39.5 = 23.4 vs 23、695 / 31.0 = 22.4 vs 22。
   两个独立来源（绝对计数与平均频率）互相印证，说明单位与语义都对。

有了这两条，「每划距离」才可信：`distance_m ÷ total_cycles` = 1.50 / 1.35 / 2.38 / 2.95 m/划。
它是游泳技术分析的核心指标 —— **划频高但每划距离短 = 抓水效率低**。旧数据块两者都没有，
模型只能讲「配速结构」，讲不了技术。

##### 同一个字段在爬楼上的第二个用途：楼层

爬楼（`floor_climbing`，真实库 **30 条**，第二大类型）全站零类型专属处理：详情页只写
「累计爬升 46m」，AI 提示词写「爬楼看爬升量」。而**爬楼的行业语言是「楼层」不是「米」**。

FIT 里**没有** floors 列（session 只有 `total_ascent`），所以这是「该派生没派生」，
不是第十类缺陷本身；但它提供了同类缺陷的第二个判据：**单位是不是该运动的行业语言**。

换算依据是实测反推，不是常识值：

| 爬升 | ÷ 3.048 | 层数 | 残差 | ÷ 3.0 残差 |
|------|---------|------|------|-----------|
| 27m | 8.858 | 9 | 0.43m | 0.00m |
| 30m | 9.843 | 10 | 0.48m | 0.00m |
| 40m | 13.123 | 13 | 0.38m | **1.00m** |
| 43m | 14.108 | 14 | 0.33m | **1.00m** |
| 46m | 15.092 | 15 | 0.28m | **1.00m** |
| 49m | 16.076 | 16 | 0.23m | **1.00m** |

6/6 在 3.048m（= 10 ft，Garmin 标准楼层高）下残差全 < 0.5m（`round()` 唯一确定）；
按常识的 3.0m 反推，40/43/46/49 的残差**恰好都是 1.0m** —— 系统性偏移，不是随机误差。
故 `app/lib/floors.ts` 的 `FLOOR_HEIGHT_M = 3.048`，且文案必须带「约」
（真实楼层高 2.6–3.3m 因建筑而异，精确整数会让人以为设备测了楼层）。

**只对 `floor_climbing` 派生**：山地跑 300m 爬升是「爬了 300m 的高度」，不是「爬了 98 层楼」。

##### 修法（五个面，少一个就留假话）

1. **解析器**：活动级 + lap 级都读 `total_cycles`（`>0` 才写 —— 0 距离休息段的 0
   是「没有划水」，不是「划水 0 次」）。
2. **schema**：`activities` 79→80 列、`activity_laps` 44→45 列；两条迁移条目
   （`declaredColumns()` 与生产库的漂移守卫会自动拦住漏改）。
3. **回填**：`backfill-fit-fields.js` 的 `fields` 加 `total_cycles`；lap 级新增
   `db.updateLapCycles()` —— **按 `lap_index` 只 UPDATE 一列**，不复用 `insertLaps`
   （那是 DELETE + 整体 INSERT，会把解析器不产出的列写成 NULL，对已有 3137 段真实
   数据风险太大）。实测回填 353 活动 + 290 活动的 lap。
4. **展示**：详情页概览按类型给标签（游泳「总划水次数」/ 跳绳「总跳跃次数」/
   爬楼「总步数」）；**跑步刻意不给** —— 步幅周期数（3352）对跑者没有语义，
   `步频` 已经表达了同一信息。AI 数据块：游泳加「总划水次数 + 每划距离」、
   跳绳加「总跳跃次数 + 跳跃频率」、爬楼加「楼层（约）」。
   ⚠️ 当时的实现还留了 `: '总计数'` 兜底，把语义未确认的类型也展示出来 ——
   已由**第十一类缺陷**（见下）删除。
5. **文档与提示词**：删掉四处「总划水次数不可得」（`coach-prompts.ts` 两处、
   `SKILL.md`、`mcp-server/tools.ts`），改成「数据块会给」；`docs/api-reference.md`
   补 `total_cycles` 的语义表与「不要 ×2」。

##### 纪律

- **「库里的列是 NULL」≠「设备不写」**。写「不可得」之前必须先直接读一次 FIT：
  `fit-file-parser` 解出 session，看字段在不在。库里 NULL 有三种成因：设备不写、
  解析器不读、回填没跑 —— 三者的修法完全不同。
- **绝对计数与频率不是同一个换算域**。`avg_cadence × 2` 不能推广到 `total_cycles`。
  任何 ×2 / ÷10 / ×100 的换算都必须写在**字段**旁边，而不是「这个词」旁边。
- **同一字段在不同运动里语义可以完全不同**，标签必须随类型变。`total_cycles` 在
  游泳是技术指标（配合距离算每划距离），在跳绳是唯一执行指标，在跑步是噪音。
  一刀切地「都展示」或「都不展示」都是错的。
- **行业语言优先于原始单位**。爬楼写「米」、游泳写「km/h」，都是让用户自己去换算。

##### 第三轮：`total_cycles` 的语义白名单（第十一类缺陷，2026-11-07）

第一轮修的是「字段没进库」，第二轮修的是「同类字段也没进库」。第三轮换了个方向：
**字段进库了、也展示了，但展示的标签是假的。**

第一轮给 `total_cycles` 按类型配了标签，最后留了一个 `: '总计数'` 兜底 ——
即「我不知道这个数是什么，但库里有值，就展示吧」。用户看到「总计数 436」
只会更困惑；更糟的是它看起来像个**确定的**计数，会被拿去做训练决策。

用两条判据重新审每个类型：

| 判据 | 含义 |
|------|------|
| **结构自证** | `Σlap.total_cycles == session.total_cycles` —— 证明活动级与分段级读的是同一个量，不是解析错位 |
| **独立锚点** | 能用一个**不同来源**的量交叉验证 —— 证明这个量的物理意义就是标签说的那个 |

| 类型 | Σlap==session | 独立锚点 | 结论 |
|------|---------------|---------|------|
| 游泳 4/4 | ✅ 518/798/923/695 全等 | ✅ ÷活跃时间 ≈ 划频（24.2/23.8/23.4/22.4 vs 24/24/23/22） | **总划水次数** |
| 跳绳 3/3 | ✅ 189/187/193 全等 | ✅ ÷时长 = 115–150 次/分（跳绳常识 100–160） | **总跳跃次数** |
| 爬楼 30/30 | ✅ 30/30 全等 | ✅ ÷楼层 = 14.6–29.0 步/层（14 级台阶约 20 步） | **总步数** |
| 力量 0/51 有 lap | ❌ 无 lap 消息 | ❌ `r(cyc, 时长) = −0.118` | 不展示 |
| 室内有氧 1/9 | ❌ | ❌ 同名活动 5 / 19 / 66 / 474 | 不展示 |
| HIIT 0/3 | ❌ | ❌ | 不展示 |
| 篮球 3/3 | ✅ | ❌ 1685/53min = 32「触球」/分 | 不展示 |
| 乒乓 / 羽毛 3/3 | ✅ | ❌ 0.06–0.14 m/cycle，语义随项目变 | 不展示 |

**力量训练的反证最硬**（`r(cyc, moving_time) = −0.118`，n=51）：

| 活动 | 课表 | 时长 | `total_cycles` |
|------|------|------|----------------|
| 557320917 | 核心稳定性4 | **15.2 min** | **51** |
| 626200915 | 核心稳定性4 | **28.1 min** | **40** |

同一套课表，时长翻倍，计数反而更少 —— 它不可能是「做了多少次」。而
`num_laps` 恒为 37/41/42/43/44/49（随课表模板变，与时长无关），也不是组数；
`activity_laps` 更是 **0/51**（设备根本不写 lap 消息），连结构自证都用不了。

**室内有氧的反证最直观**：同名「5 分钟平板支撑挑战」9 条里出现
**5 / 19 / 66 / 474** 四种取值（95 倍跨度）。平板支撑只有 1 次，
任何「次数」解释都不成立。

**球类是最微妙的一类**：结构自证对得上（篮球 3/3、乒乓 2/2、羽毛 1/1 全等），
但没有任何独立量能说清这个数是什么 —— 篮球 53 分钟 1685 次折合 32「触球」/分，
不符合任何球类常识。**结构自证只证明「读得一致」，不证明「读的是什么」。**

##### 修法

1. 新增 `app/lib/cycles.ts`：`CYCLE_SEMANTICS` 白名单（4 条：`lap_swimming` /
   `open_water` / `jump_rope` / `floor_climbing`），每条**必须**带 `basis`
   字段写明两条证据。
2. 详情页概览：`cycleCountLabel()` 返回 `null` 时**整格不渲染**（不是 `--` ——
   那是「数据缺失」的信号，这里是有值但不知道该叫什么）。
3. 详情页分段表：列名从 `!running` 改为 `cycleLabel != null`，并去掉含糊的
   「计数」列名（力量/室内有氧/球类不再出现该列）。
4. AI 数据块：分段行从 `!running && l.total_cycles` 改为 `cycleSem != null`，
   且单位跟着语义走（游泳「划」/ 跳绳「跳」/ 爬楼「步」）—— 旧实现给力量课
   的分段写「40划」，那是游泳专用词。
5. MCP `get_activity` description：明确「只有三种类型确认了语义」，并把
   力量/室内有氧/球类的反证数字写进去。

##### 纪律

- **「库里有值」不等于「知道它是什么」**。语义未确认的字段宁可不展示 ——
  展示一个错误标签比不展示更糟，用户会拿它做训练决策。
- **结构自证只证明一致性，不证明语义**。`Σlap == session` 能排除解析错位，
  但不能告诉你这个数是不是「次数」—— 还需要一个**不同来源**的锚点。
- **不要留「其他/总计/杂项」这类兜底标签**。它们是「我懒得分类」的委婉说法，
  在数据展示里等于把未确认的量伪装成确定值。
- **相关性能证伪，不能证明**。`r(cyc, 时长) = −0.118` 直接否掉了「次数」假设
  （次数必然随时长增长）；但 `r = 0.68` 也不能证明它是别的东西。

##### 第二轮：泳池规格、主观感受、出汗量（2026-11-07）

第一轮修的是 `total_cycles`。第二轮用**同一判据**继续扫，又命中五个字段 ——
全部是「FIT 里一直有 → 解析器不读 → 库里从来没有这一列」：

| 字段 | FIT 覆盖 | 语义 | 为什么重要 |
|------|---------|------|-----------|
| `pool_length` | **4/4**（游泳） | 池长（米） | SWOLF 的基准 |
| `num_active_lengths` | **4/4**（游泳） | 活跃趟数 | SWOLF 的另一个输入 |
| `workout_feel` | **251/353** | 主观感受 0/25/50/75/100 | 唯一由用户主动输入的数据 |
| `workout_rpe` | **251/353** | 主观用力 1–10（Borg CR10） | 体感 vs 数据对比 |
| `est_sweat_loss` | **349/353** | 估计出汗量（ml） | 补液建议的直接依据 |

##### 泳池规格 → SWOLF：唯一能把「快」和「省」合成一个数的指标

游泳此前只有「每 100m 配速」和「划频」两个孤立数字。而游泳圈真正的技术指标是：

```
SWOLF = 单趟用时（秒） + 单趟划水次数
```

同样 25m，**48 秒 + 20 划 = 68** 比 **40 秒 + 32 划 = 72** 更高效 —— 后者虽然快，
但每一划推进距离短。**单看配速会把后者误判为更好**，这就是 SWOLF 存在的理由。

自证不变式（实测 4/4 精确成立）：

| 活动 | 池长 | 趟数 | 趟数×池长 | 距离 |
|------|------|------|-----------|------|
| 599287904 | 25m | 31 | 775 | 775 |
| 614598589 | 25m | 43 | 1075 | 1075 |
| 617083438 | 50m | 44 | 2200 | 2200 |
| 630387237 | 50m | 41 | 2050 | 2050 |

`num_active_lengths × pool_length == total_distance` 全部精确相等 —— 这证明两个字段
都没读错（尤其 `pool_length` 的 FIT scale=100 已被 `fit-file-parser` 应用，
解析后直接是米，再 ÷100 会得到 0.25m 的池子）。

**SWOLF 实测（时间基数 = 活跃 lap 计时器时间之和）**：

| 活动 | 池长 | 趟数 | 活跃秒 | 总划水 | 单趟秒 | 单趟划 | SWOLF |
|------|------|------|--------|--------|--------|--------|-------|
| 599287904 | 25m | 31 | 1283 | 518 | 41.4 | 16.7 | **58** |
| 614598589 | 25m | 43 | 2010 | 798 | 46.7 | 18.6 | **65** |
| 617083438 | 50m | 44 | 2369 | 923 | 53.8 | 21.0 | **75** |
| 630387237 | 50m | 41 | 1862 | 695 | 45.4 | 17.0 | **62** |

**两条纪律，缺一条就给出错误结论**：

1. **绝不能跨池长比较**。50m 池的单趟用时与划水次数都约为 25m 池的两倍，SWOLF 自然
   也翻倍。上表 25m 池是 58/65、50m 池是 75/62 —— 直接比会得出「25m 池更高效」。
2. **绝不能折算**。把 50m 的 75 折成「37（25m 等效）」是错的：转身与蹬壁在长池里
   被摊薄，折算值会远低于任何真实 25m 值。故 `SwolfResult` 必须带 `poolLengthM`，
   文案必须写「58（25m 池）」。

**时间基数必须是活跃 lap 的计时器时间之和，不是活动级 `moving_time`**。
`599287904` 的 `moving_time = 2088s`，其中 **804 秒是池边休息**（0 距离 lap）。
用 2088 算单趟用时会把休息摊到每一趟：2088/31 = 67.4s + 16.7 划 = SWOLF **84**，
而真实值是 **58** —— 差 26 分，把一次不错的训练读成「效率很差」。

##### 主观感受：唯一由用户主动输入的数据

`workout_feel` / `workout_rpe` 覆盖 **251/353**（全部跑步 + 游泳 + 1 条室内骑行；
力量/球类/爬楼不弹窗）。它们是**唯一**由用户主动填写的字段 —— 其余全部是设备测量。

| feel | 条数 | RPE 均值 | 平均 TE |
|------|------|---------|---------|
| 0（很差） | 14 | **8.1** | 4.1 |
| 25（较差） | 38 | **5.9** | 3.7 |
| 50（一般） | 88 | **3.8** | 3.4 |
| 75（良好） | 101 | **2.4** | 3.1 |
| 100（很好） | 10 | **1.4** | 2.5 |

两条自证：`r(feel, rpe) = −0.856`（n=251），且 RPE 均值五档**严格单调**。
若解析器把 `workout_rpe` 的 FIT `scale=10` 漏掉（值变成 20–90），相关性会归零 ——
这两条不变式就是「字段读对了」的证据。

**`feel = 0` 是有效值**（14/251 条「感觉很差」）。任何 `if (feel)` 的真值判断都会把
这 14 条静默丢掉 —— 这是本轮最容易犯的错，测试用 `toBeDefined()` 而不是 `toBeTruthy()`。

**偏离样本仅 1/251（0.4%）**（feel ≥ 75 且 RPE ≥ 6，或 feel ≤ 25 且 RPE ≤ 3），
说明两个字段高度自洽 —— **偏离样本才值得单独解释**，而这恰恰是客观指标完全
无法回答的问题（「为什么数据说很轻，你却觉得吃力」）。

##### 出汗量：设备估算值，且有速率上限

`est_sweat_loss` 覆盖 **349/353**（除游泳 0/4）。它是补液建议的直接依据，
而提示词此前只能让模型「凭时长和温度猜」。

**但它是设备估算值，且有内部速率上限**：实测 306 条有效速率里 **88 条**撞上
999–1000 ml/h 的天花板（p50 = 902、p90 = 989、p99 = 999、**max = 999**，
无一超过 1000），而真实出汗率可达 **1500–2000 ml/h**。

所以它是**保守下限**而不是精确值 —— 展示与 prompt 都必须带「约」，且必须告诉模型
「按它算补液会偏低」。`sweatRateMlPerHour` 也把上限写成代码常量（`1000`），
既是显示守卫也是「这个值一旦接近 1000 就说明设备已饱和」的提示。

##### 五个面（与第一轮同一结构）

1. **解析器**：读 `pool_length`（米，scale 已应用）、`num_active_lengths`、
   `workout_feel`（`!= null`，含 0）、`workout_rpe`（`> 0`，Borg 从 1 开始）、
   `est_sweat_loss`（`> 0`）。
2. **schema**：`activities` 80→85 列（5 条迁移条目）；`activity_laps` 不变（45 列）。
3. **回填**：`backfill-fit-fields.js` 的 `fields` 加 5 项；真实库已备份并回填成功
   （353 活动 + 290 活动的 lap）。
4. **展示**：详情页概览加「SWOLF（带池长）」「池长」「活跃趟数」「主观感受」
   「主观用力」「估计出汗量（约）」六格；AI 数据块加 SWOLF 行（含不可跨池长声明）、
   feel/RPE 行（含体感偏离标记）、出汗量行（含保守下限说明）。
   **feel/RPE 不按运动类型门控** —— 力量/球类不弹窗是设备行为，不是「这类运动不该有体感」。
5. **文档与提示词**：`api-reference` 补 5 字段语义；MCP `get_activity` description
   补全部纪律；skill 补 SWOLF 池长纪律与 feel/RPE 口径。

##### 纪律

- **`0` 是不是有效值，要看字段语义而不是看真假值**。`workout_feel = 0` 是
  「感觉最差」（14 条），`total_cycles = 0` 是「没有划水」（0 距离休息段），
  两者都必须保留；而 `workout_rpe = 0` 不是合法档（量表从 1 开始）、
  `est_sweat_loss = 0` 是「没有估算」（游泳 0/4）—— 同一个 0 在四个字段上
  有四种处理。**判空条件必须写在字段旁边**。
- **设备估算值必须带限定词**。`est_sweat_loss` 有 1000 ml/h 的内部 cap，
  `training_load` 有回退算法，`recovery_time` 是建议值 —— 三者都不能当实测。
- **同一指标换个池长就不是同一个数**。SWOLF 是第一个「单位里含环境参数」的指标，
  后续若加泳姿分项（蝶/仰/蛙/自各有基准），必须同样带泳姿标签。

##### 仍未提取的 FIT 字段（按价值排序，本轮未做）

本轮已把 `swim_stroke` 补上（见本节末尾「第十三类缺陷」）。目前
**没有**确认有价值但尚未入库的字段；其余三个字段经复核主动排除（见下）。

#### 第十二类缺陷：设备记录了「这段是什么」，我们却按配速猜（2026-11-07）

第十至十一类是「字段没进库」与「标签是假的」。第十二类是更隐蔽的一类：
**字段进库的位置本来是对的，但我们从来没读它 —— 而是用另一个字段去推断它的值，
并且把推断结果当成事实展示给用户和 AI。**

详情页「分段数据」表一直有一列「角色」（热身 / 主课 / 恢复 / 冷身 / 匀速）。
它看起来像读出来的，实际是 `activity-insight.ts:analyzeLaps` 用**配速**算的：

```
hard  = pace < 均值 × 0.92          → 主课
easy  = pace > 均值 × 1.12          → 热身/恢复/冷身（看位置）
其余                                 → 匀速
```

而设备在 FIT lap 里**明确记录了每段的意图** —— `intensity` 字段：

| 取值 | 含义 | 段数（真实库） |
|------|------|---------------|
| `interval` | 间歇主课段 | 2392 |
| `cooldown` | 冷身 | 182 |
| `recovery` | 间歇恢复段 | 168 |
| `warmup` | 热身 | 147 |
| `rest` | 完全休息（组间/池边） | 106 |
| `active` | **这段在计时**（不表达意图） | 63 |

覆盖 **3058/3137 段（97.5%）**、287 条活动。解析器从未读取它 ——
`activity_laps` 表连这一列都不存在。

##### 判据（与第十至十一类同一套，两条全中）

| 判据 | 检验 | 结果 |
|------|------|------|
| **结构自证** | `warmup` 是否恒在首段、`cooldown` 是否恒在末段、`interval`/`recovery` 是否严格交替 | **9/9 完美**（见下表） |
| **独立锚点** | 与配速/心率推断的交叉一致率 | **73.2%**（747/1021 段）—— 不高，但这正是设备值的价值：它记录**意图**，配速只反映**结果** |

真实库多段活动实测（全部 9 条含 `warmup`/`cooldown` 的活动）：

```
651707081  warmup,warmup,warmup,interval,recovery,interval,recovery,...,cooldown,cooldown
648412964  warmup,warmup,warmup,interval,recovery,...,interval,cooldown,cooldown,cooldown
647455345  warmup,warmup,interval,interval,recovery,...,interval,cooldown,cooldown
639982410  warmup,warmup,warmup,interval,rest,interval,rest,...,cooldown,cooldown,cooldown
```

`warmup` 恒在索引 0（可以连续多段）、`cooldown` 恒延续到最后一个索引、
`interval` 与 `recovery`/`rest` 严格交替 —— 这是**计划结构**才有的形态，
随机噪声或解析错位几乎不可能出现。这一条不变式已固化为
`app/lib/lap-intensity.ts:validateLapRoles()`。

##### 推断错在哪（274 段的典型样本）

| 活动 | 段 | 设备记录 | 配速推断 | 为什么错 |
|------|----|---------|---------|---------|
| 647455345 | 第 1 段 | **热身** | 主课 | 首段配速偏快（起跑下坡/顺风），推断只看「快于均值 8%」 |
| 648412964 | 第 2 段 | **热身** | 匀速 | 热身中段配速接近全程均值 |
| 650375691 | 第 1 段 | **热身** | 匀速 | 同上，首段恰好不快 |
| 651707081 | 第 3 段 | **热身** | 恢复 | 连续 3 段热身，第 3 段配速抬升被判成恢复 |

**这不只是「角色列错了一个词」**：`workLaps`（主课段数）、`workDistanceMeters`、
`workAvgPaceSecPerKm`、`workAvgHeartRate`、`workHrDrift`（主课漂移）——
整块派生分析全部建立在 `role === 'work'` 之上。角色判错，主课漂移、主课均配速、
「主课执行得怎么样」全部跟着错，而这些结论会原样进入 AI 上下文。

##### `active` 为什么映射为 `null`（绝不猜测）

`active` 是 63 段里最容易被误用的一类。它**只表示「这段在计时」**，
不表达训练意图。真实库 `657456825` 全程 **22 段都是 `active`** —— 那是一次匀速慢跑。

若把 `active` 当 `work`，一次匀速慢跑会整场被标成「主课 22 段」，
比现在的配速推断**更糟**（推断至少判 `steady`）。故：

| intensity | 角色 | 理由 |
|-----------|------|------|
| `interval` | `work` | 间歇主课段，无歧义 |
| `recovery` / `rest` | `recovery` | 组间完全休息同属恢复 |
| `warmup` | `warmup` | 无歧义 |
| `cooldown` | `cooldown` | 无歧义 |
| `active` | **`null`**（回落推断） | 只说「在计时」；推断对匀速跑判 `steady`，是对的 |
| `255` / 缺失 | **`null`**（回落推断） | 设备没写，不是一种角色 |

##### 修法（五个面 + 一个来源标记）

1. **解析器**：`_extractLapsData` 读 `lap.intensity`，**存原始字符串**
   （`255`/空串不写）。不在这里映射成角色 —— 数据库只负责如实保存设备说了什么，
   角色口径将来变了不需要迁移数据。
2. **schema**：`activity_laps` 45→46 列（`intensity TEXT`）+ 一条迁移条目。
3. **角色映射**：新增 `app/lib/lap-intensity.ts`（`lapRoleFromIntensity()` /
   `isDeviceRole()` / `validateLapRoles()`）。**设备值优先、推断兜底**。
4. **来源可查**：`ActivityLapAnalysis.laps[].roleSource: 'device' | 'inferred'` ——
   否则将来又会出现「不知道这个角色是猜的还是读的」。详情页徽标带 `·` 标记与
   `title` 提示（「设备记录的训练角色（FIT lap intensity = warmup）」）。
5. **AI 数据块**：分段行输出设备角色（`ROLE_LABEL_AI`：热身/主课段/恢复段/冷身/匀速）。
   间歇课复盘的核心问题就是「主课段执行得怎么样、恢复段够不够」，模型此前只能看
   配速序列**自己猜**哪几段是主课。
6. **回填**：`db.updateLapFields(activityId, laps, columns)`（列名白名单防注入），
   `updateLapCycles()` 保留为 `@deprecated` 包装。

##### 纪律

- **设备记录的「意图」比从结果反推的「事实」更可信**。配速是结果，会被地形、
  风向、起跑状态污染；`intensity` 是用户/设备在**计划层**写下的意图。两者冲突时
  以设备为准，但必须能区分来源（`roleSource`）。
- **不确定的枚举值宁可返回 `null` 回落，也不要猜**。`active` 若当 `work`，
  匀速跑会整场变「主课」—— 猜测的错误方向比不猜更糟。
- **原始值与语义分层存放**。DB 存 `intensity` 字符串，角色映射放展示层
  （`lap-intensity.ts`）。将来 Garmin 改枚举、或本项目改口径，不需要动数据。
- **派生指标的错误会放大**。一个角色的错会污染 `workLaps`/`workHrDrift`/
  「主课均配速」四个数字，而这四个数字会原样喂给 AI。

#### 第十三类缺陷：同一个字段，在另一个消息层级才有值（2026-11-07）

第十二类缺陷是「字段进库了却用别的字段猜」。第十三类更细一层：
**同一个字段在 FIT 的不同消息层级有不同可信度，而文档只看了层级之一，
于是得出了「这个字段不可得」的错误结论。**

真实情况（泳姿 `swim_stroke`）：

| 层级 | 覆盖 | 结论 |
|------|------|------|
| `session.swim_stroke` | 4/4 **恒为 255** | 设备不写（FIT 无效哨兵 0xFF） |
| `lap.swim_stroke` | **35/79 段有真实值** | **有真实泳姿** |

旧文档与 skill 都写「泳姿仅 Garmin 云端可见」—— 那句话**只对 session 级成立**。
lap 级一直有 `freestyle` / `backstroke` / `breaststroke` / `mixed`，
只是 `fit-parser.js` 从未 `_safeGet*(lap, 'swim_stroke')`，`activity_laps` 表也没有这一列。

##### 判据（与第十至十二类同一套，两条全中）

| 判据 | 检验 | 结果 |
|------|------|------|
| **结构自证** | `swim_stroke === 255` 是否恒对应 `distance === 0` | **0 违反**（79 段） |
| **独立锚点** | 距离与划水次数两条独立链是否同时闭合到 session | **4/4 精确相等**（见下） |

两条自证不变式（真实库 4 条游泳全部成立）：

```
① swim_stroke === '255'  ⟺  distance === 0          （0 违反）
   —— 池边休息段没有泳姿，有距离的段一定有泳姿。
      若解析时把 lap 顺序搞乱，必然出现「有距离却没泳姿」或「休息段却有泳姿」。

② Σ(真实泳姿段 distance) == session.total_distance    （775 / 1075 / 2200 / 2050）
   Σ(真实泳姿段 total_cycles) == session.total_cycles （518 / 798 / 923 / 695）
   —— 距离与划水次数是两条独立链，同时相等才证明没有段落被漏读或重复计入。
```

`599287904` 的 28 段分布：breaststroke 4 / mixed 6 / freestyle 3 / backstroke 1 /
255（0 距离休息）14 —— 与 `Σdist=775`、`Σcycles=518` 完全闭合。

##### `mixed` 是真实取值，不是「未知」

设备在「这一段里换了泳姿」时写 `mixed`。它是一条**真实信息**，
与 `255`（设备没写）和 `null`（数据缺失）是**三件不同的事**：

| 值 | 含义 | 能否算效率 |
|----|------|-----------|
| `mixed` | 这一段混合了多种泳姿（设备明确记录） | **不能** —— 构成未知 |
| `im` | 个人混合泳（按规则轮换四种） | **不能** —— 轮换不是单一泳姿 |
| `drill` | 分解练习 | **不能** —— 配速不代表完整技术 |
| `255` / `null` | 设备没写 / 数据缺失 | 不适用（0 距离休息段） |

把 `mixed` 当「未知」会丢掉一条真实信息；把 `mixed` 摊到某个具体泳姿上、
或给它算「每 100m 效率」，则会**凭空造出一个没有物理含义的数字**，
模型会拿它去跟单泳姿比较并得出错误结论。故 `summarizeSwimStrokes()`
对这三类只给「距离 / 时长 / 划水次数」这类事实，效率字段一律 `null`。

##### 实测泳姿构成（跨 4 条游泳汇总，仅作量级参考）

| 泳姿 | 段数 | 距离 | 秒/100m | 米/划 |
|------|------|------|---------|-------|
| freestyle | 18 | 2250m | 137.2 | 1.84 |
| mixed | 12 | 3675m | —（不给） | —（不给） |
| breaststroke | 4 | 150m | 147.7 | 1.83 |
| backstroke | 1 | 25m | 88.5 | 2.78 |

样本极小（backstroke 只有 1 段 25m），这些数字**不能当能力基线**，
只能说明「字段口径算得通」。

##### 修法（六个面）

1. **解析器**：`_extractLapsData` 读 `lap.swim_stroke`，**存原始枚举字符串**
   （`255`/空串不写）。中文名与效率口径属于展示层。
2. **schema**：`activity_laps` 46→47 列（`swim_stroke TEXT`）+ 一条迁移条目。
3. **映射层**：新增 `app/lib/swim-stroke.ts`
   （`swimStrokeLabel()` / `hasSwimStroke()` / `isComparableStroke()` /
   `summarizeSwimStrokes()` / `validateSwimStrokes()`）。
4. **详情页**：概览「泳姿」格给整体构成；分段表新增「泳姿」列。
   **整列门控**：没有一条 lap 有泳姿时整列不渲染（恒空列会被读成同步失败）。
5. **AI 数据块**：逐段泳姿 + 泳姿构成汇总 + 两条纪律声明
   （`mixed` 不是未知 / 分组秒数不能重算 SWOLF）。
6. **回填**：`db.updateLapFields(id, laps, ['total_cycles','intensity','swim_stroke'])`。

##### 纪律

- **先问「这个字段是不是在另一个消息层级才有值」**。同一字段在 session / lap /
  record 三级的可信度可以完全不同，不能因为一级无效就断言「不可得」。
- **原始值与语义分层存放**。DB 存 `swim_stroke` 原始枚举，中文名与效率口径
  放 `swim-stroke.ts`。Garmin 改枚举或本项目改口径都不需要动数据。
- **`mixed` 不等于 `null`**。前者是设备说的「混合」，后者是「我们没拿到」。
  把真实取值当缺失，与把缺失当真实取值，是同一个错误的两面。
- **不给未知构成编效率**。宁可不给，也不要给一个模型会拿去比较的数字。
- **泳姿分组秒数之和 ≠ SWOLF 的时间基数**。后者含全部活跃段（含 mixed），
  用分组去重算 SWOLF 会偏小。

另三个字段经复核**不做**（不是遗漏，是主动排除）：

| 字段 | 结论 |
|------|------|
| `avg_fractional_cadence` | 只是步频的**小数部分**（+0.34 → 182.7 spm vs 整数 182），精度增量 ≤0.5 spm |
| `enhanced_avg_respiration_rate` | 仅 19/353，覆盖太低 |
| `total_work` | 与 `avg_power × timer` 逐条精确相等（0.999–1.002），纯冗余 |
| `avg_stroke_distance` | FIT 里恒 0（4/4），不可用；每划距离必须用 `distance ÷ total_cycles` |

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
| **游泳类型判定单一来源** | `app/lib/sport.ts`（`SWIMMING_ACTIVITY_TYPES` + `isSwimmingType`，含预置的 `open_water`） | `tests/unit/lib/sport.test.ts`（2 个类型、13 个非游泳、空值 false 且不与 `isRunningType` 同时为真） |
| **游泳每 100m 配速换算单一来源** | `app/lib/pace.ts`（`paceSecPer100m` = `360 ÷ 速度(km/h)`、`formatPacePer100m` = `2:22`） | `tests/unit/lib/pace-group.test.ts`（真实库 4 条游泳逐一验算并与 `average_pace ÷ 10` 交叉校验；`÷10` 旧公式反向断言；null/0/负数/非有限 → null；秒补零与 359.6→6:00） |
| **提示词不得让模型自己做单位换算** | `coach-prompts.ts` 的游泳条目（引用数据块「每 100m 配速」行 + 写明 `360 ÷ 速度`）+ `llm.ts` 非跑步分支产出该行 | `tests/unit/lib/coach-prompt-data-alignment.test.ts`（不得含 `÷10 即秒/100m`、必须含「每 100m 配速」与 `360`、数据块真的产出 `2:22/100m`）+ `tests/unit/lib/llm.test.ts`（游泳有该行且用计时器时间、缺 distance 用 average_speed 兜底、两者皆缺整行不输出、非游泳不输出） |
| **筛选参数归一单一来源** | `db.normalizeTypeFilter`（`all`/空串/空白 → 不过滤）+ `db.normalizeQueryFilter`（纯空白 → 不过滤） | `tests/unit/lib/db-insight-integration.test.ts`（两个归一函数单点定义；`q='' / ' ' / '\t'` 与不过滤逐月相等；`' 游泳 '` 仍命中） |
| **MCP tool description 必须声明统计口径** | `mcp-server/tools.ts`（10 个表现分析工具写「跑步口径」、3 个活动日志工具写「全类型口径」、1 个合并口径工具同时声明「负荷合并 + 里程/次数只统计跑步」、2 个力量工具声明数据边界） | `tests/unit/mcp/tool-scope-contract.test.ts`（逐项断言口径措辞、`list_activities` 不再自称「列出跑步活动」、`get_activity_comparables` 声明 `running=false` 时配速派生字段为 `null`、`get_activity_types` 声明「先调本工具再按类型筛选」、20 个工具均有非空 title/description） |
| **力量训练口径（第三套）** | `app/lib/strength.ts`（画像/强度域/负荷/合并的唯一真源）、`db.getStrengthLoads`·`getStrengthSessions`·`getCombinedTrainingLoads` | `tests/unit/lib/strength.test.ts`（32 例）、`strength-merge.test.ts`（9 例：负荷相加、里程/时长/次数只取跑步、只有力量的日子保留）、`strength-summary.test.ts`（10 例）、`db-strength.test.ts`（12 例：SQL 只查 `strength_training`、分页、空值兜底） |
| **洞察页负荷口径必须合并** | `insight-service.ts` 的 `getCombinedTrainingLoads` | `tests/unit/lib/insight-services.test.ts`（合并入口被调用、跑步口径 `getDailyLoads` 未被调用、EWMA 预热窗口不变） |
| **力量负荷双实现一致性** | `app/lib/strength.ts`（TS）↔ `scripts/common/strength-load.js`（JS 镜像，同步脚本用） | `tests/unit/lib/strength-sync-parity.test.ts`（穷举 12×12 TE×HR、11×5 时长×域、7×7 时间基数；任一侧改阈值而另一侧没跟上 → 红灯） |
| **FIT 循环控制步不得计入训练段** | `app/lib/strength.ts` 的 `isRepeatControlStep`（`repeat_until_*` 前缀匹配，排除 8 种变体） | `tests/unit/lib/strength.test.ts`（真实库 3 条课表工作段 7 而非 8、结构描述无 `? 连续`、5 种 `repeat_until_*` 变体逐一验证）+ `tests/unit/lib/db-strength.test.ts`（聚合组数不虚高） |
| **力量课 AI 数据块必须注入真实可推导项** | `llm.ts` 的 `isStrengthType` 分支（计划名 / 组结构 / 有效组数·休息段·工作:休息 / 计划时长 vs 实际时长 / 强度域 / 数据边界句） | `tests/unit/lib/llm.test.ts`（5 例：含计划名与组结构、计划 6:40 与实际 1:00:09 分行、禁止编造容量、无课表不输出组结构行、跑步不出现力量专属行） |
| **提示词不得引用数据里不存在/已新增的量** | `coach-prompts.ts` 的 `SINGLE_NON_RUNNING_PROMPT`（区分「只有力量训练有派生负荷」与「游泳/球类/爬楼不计算」；禁止编造重量次数；要求引用组结构/强度域） | `tests/unit/lib/coach-prompt-data-alignment.test.ts`（4 例：不再声称非跑步不计算负荷、要求引用派生负荷、要求引用组结构/强度域、禁止编造容量） |
| **追问建议必须按运动类型分流** | `followup-suggestions.ts` 的 `strength` 标志 + `AiAnalysis.tsx` 接线 | `tests/unit/components/followup-suggestions.test.ts`（6 例：力量课不问心率漂移/有氧能力、改问组结构/强度域/负荷竞争、不出现「交叉训练」泛泛说法、安全兜底恒最后、`strength` 缺省行为不变） |
| **首页「跑步天数」判定必须是 `runs>0`** | `app/page.tsx` 的 `thisMonthRuns` | `tests/unit/pages/home-page.test.tsx`（合并口径下「只做力量」的日子 `load>0` 但 `runs=0`，用 `load` 判定会误算成跑步日） |
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
| **分段角色来自设备（FIT lap `intensity`），不是配速推断** | `app/lib/lap-intensity.ts`（`lapRoleFromIntensity` / `isDeviceRole` / `validateLapRoles`，唯一映射来源）；`activity-insight.ts:analyzeLaps` 设备值优先 + `roleSource`；`ActivityDetailClient` 徽标带 `·` 与 `title`；`llm.ts` 的 `ROLE_LABEL_AI` | `tests/unit/lib/lap-intensity.test.ts`（19 例：六种 intensity 映射、**`active`→`null` 绝不猜**、255/未知值→null、大小写空白、结构自证 warmup 首段/cooldown 末段、9/9 真实形态）；`tests/unit/lib/activity-insight.test.ts`（设备值优先于配速、`roleSource` 正确）；`tests/unit/pages/activity-detail.test.tsx`（设备角色不等 insight 请求、`active` 回落推断、title 区分设备/推断）；`tests/unit/lib/llm.test.ts`（分段行输出角色、`active` 不输出、非跑步同样输出） |
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
| **`ActivityLap` 的 47 个字段必须被消费或记账** | 账本 `LAP_FIELD_ALLOWLIST`（`tests/unit/components/lap-field-consumption.test.ts`）+ 两条推导链同基数断言 | 字段数精确 `toBe(47)`、正向未消费为空、反向账本无已消费项、账本键必须是真实列、schema 每列三头必须落一头；四个方向均做过缺陷注入 |
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
| **区间徽章只能有一个样式实现（对比度 AA）** | `hrZoneBadgeStyle`（16% 同色浅底 + `--zN-text` 文字）；功率区间表与活动详情分段表都必须复用它，禁止「实心底+白字」或「主色当文字」 | `tests/unit/components/zone-tables-a11y.test.tsx`（三张区间表首列徽章的 `style.color` 必须是 `var(--zN-text)`）+ `tests/e2e/a11y.spec.ts`（桌面+移动端 axe serious 归零） |
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

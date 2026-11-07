---
name: pbrun-coaching
description: 分析 pbRun (Garmin) 跑步数据出教练诊断报告、查最新跑步数据、分析力量训练负荷、选跑鞋。
---

# pbRun 跑步数据分析与教练诊断

为用户的 pbRun (Garmin) 跑步数据做教练级分析，输出训练诊断报告 + 跑鞋选购建议。用户是进阶业余跑者，偏好**中文、Markdown 表格、专业教练口吻、给出可执行处方和具体目标数字**。

## 工具工作流（按顺序调用）

用 `tool_call` 逐个调用 pbRun 工具。**local/connector 工具一次只能发一个 entry，不能 batch 混合**，否则报错 `Local tools require one entry per tool_call; mixed and multi-local batches are not supported`。多个工具就多次调用。

1. **概览**：`list_activities` (limit 20) 最近跑量；`get_stats period=month`；`get_month_summaries`。看 11 个月趋势判周期化。
   ⚠️ **单位与口径三处都不同，别混用**：
   - `get_month_summaries` 的 `totalDistance`/`runDistance` 单位是 **km**；
   - `get_stats` 的 `totalDistance` 单位是**米**；
   - `list_activities` 的 `distance` 单位是**公里**。
   ⚠️ **月度跑量必须用 `runDistance`/`runCount`**（只算跑步），`totalDistance`/`count` 是**全类型**
   （含游泳/球类/力量）。真实库 2026-08 全类型 199.60km 而跑步 197.55km，用 totalDistance
   当跑量会虚高 2.05km（1 条泳池游泳）。反过来按非跑步类型（如 `type=lap_swimming`）筛选时
   `runDistance` 恒为 0 —— 此时该类里程在 `totalDistance` 里，**不要读成「这个月没运动」**。
2. **能力趋势**：`get_vdot_trend groupBy=week` + `get_vdot_history`（默认 50 条，返回带 total/returned，没取全用 offset 翻）。
3. **强度结构**：`get_hr_zone_analysis groupBy=month startDate/endDate`（返回里的 zoneRanges 基于**该跑者 MAX_HR** 的 BPM 边界，不是通用值）+ `get_pace_zone_analysis startDate/endDate`（vdot 缺省取最新活动）。
4. **负荷/恢复**：`get_training_load_analysis days=28` → ACWR、连续训练/休息日、每日负荷。
   ⚠️ 2026-11 起该工具是**合并口径**：负荷 = 跑步 + 力量训练（力量按训练效应加权派生），
   但 `distance`/`duration`/`runs` 仍**只统计跑步**。解读时不要把「负荷涨了」直接归因于跑量。
5. **力量训练**（有力量记录时必须看，否则 ACWR 会凭空高/低）：`get_strength_sessions limit=20`
   （结构化画像）+ `get_strength_loads startDate/endDate`（逐日负荷）。
6. **PR**：`get_personal_records period=year`（含最长单次距离）。
7. **深度课表复盘**（挑一次高质量快课做，可选但出报告很加分）：`get_activity activityId` + `get_activity_laps`（分段）+ `get_activity_records`（逐秒）+ `get_activity_track`（轨迹/海拔剖面）。

## 快速查看最新数据（「看看/同步最新跑步数据」类轻量请求）

不必走上面的完整报告流程：

1. **先同步再查**：用户要「最新」时先 `bash /home/ubuntu/project/cft/garmin/sync_cn_daily.sh`（增量幂等、flock 防重入，CN 会话失效自动重登，全程约 1-2 分钟；管线细节见 skill `cft-garmin-sync`）。直接查 DB 会漏掉尚未同步的当天活动——先同步，后查询。
2. DB 直读（见下节）一发命中：最近 N 条 + 当月/本周汇总（跑量/次数统计用下节的**跑步口径片段**，不要写 `activity_type='running'`）。
3. **类型清单**：不确定库里有哪几类时先调 `get_activity_types`（返回全库类型键 + 条数，按条数降序），不要从 `list_activities` 首页结果推断（默认按时间倒序，最近可能全是跑步）。
4. 最新一条是比赛/快课时补拉 `activity_laps` 分段即可；逐秒 records/track 只在深度复盘才拉。

## MCP 故障 fallback: 本地 DB 直读

- pbRun MCP 只是本机 SQLite 的一层只读封装, 数据库在 `<pbRun>/app/data/activities.db` (u2 上 `<pbRun>` = `/home/ubuntu/project/pbRun`; MCP 内部取路径逻辑: `DB_PATH` env, 否则 `<cwd>/app/data/activities.db`)。**MCP 调用报错时不要先修 MCP**——用 Python `sqlite3.connect("file:<路径>?mode=ro", uri=True)` 只读查询先出结果, 表 `activities` / `activity_laps` / `activity_records` 与 MCP 返回同源, 数据一样全。
- DB 原始列单位: `activities.distance`=公里, `duration`/`average_pace`=秒 (pace 为秒/公里), `activity_laps.distance`=米; `time_in_hr_zone`/`workout_steps`/`hr_zone_boundaries` 等仍是 JSON 字符串, 需自行 parse。
- 直读列名: 主键是 `activity_id`（**无 `id` 列**）；「最新」排序/过滤用 `start_time_local`（本地时间，`start_time` 是 UTC）；心率列是 `average_heart_rate`/`max_heart_rate`；`garmin_vo2max`/`training_load`/`primary_benefit`/`hrv_rmssd` 都是平铺列。`recovery_time` 单位是**分钟**（赛后 ~4400 ≈ 3 天才合理，按 h 解读会得半年）。
- 表内混有 `strength_training` / `floor_climbing` / `lap_swimming` 等非跑步行（distance=0 或语义不同、部分带 workout_name）：一切跑量/次数/配速/心率区间统计必须加**跑步口径片段**，否则被力量课与游泳稀释。

  ```sql
  AND activity_type IN ('running','track_running','treadmill_running')
  ```

  **⚠️ 不要写 `activity_type='running'`** —— 跑步有**三种**类型键。真实库实测：

  | 口径 | 条数 | 里程 |
  |---|---|---|
  | 只 `running` | 233 | 2086.09 km |
  | 三类型 | 246 | 2185.65 km |
  | **缺口** | **13 条** | **99.56 km** |

  漏掉的是 `track_running` 6 条 50.88km + `treadmill_running` 7 条 48.68km，
  影响 8 个月份（2025-11/12、2026-01/02/04/07/08/10）。写成单值会让「田径场跑」
  与「跑步机」在月度跑量里凭空消失，且是**静默少算**（不报错、数字看着合理）。

  旧库兼容：该列可能为 `NULL`/空串（本项目按跑步处理），严格写法是

  ```sql
  AND (activity_type IN ('running','track_running','treadmill_running')
       OR activity_type IS NULL OR activity_type = '')
  ```

  与项目内 `app/lib/sport.ts` 的 `RUNNING_ACTIVITY_TYPES` / `db.ts` 的 `runningTypeClause` 同一口径。
  **但负荷统计例外**：`get_training_load_analysis` 是合并口径（跑步 + 力量），不要自己去写跑步口径再算 ACWR —— 那会漏掉力量负荷。力量专属数据用 `get_strength_sessions` / `get_strength_loads`。
- MCP 报 `NODE_MODULE_VERSION` 不匹配 = 宿主 Node 与 better-sqlite3 编译 ABI 不一致: 修法是换回与编译时一致的 Node 起 MCP (系统 /usr/bin/node) 或在该 Node 下 `npm rebuild better-sqlite3`; 无 prebuilt 二进制的 Node 版本 rebuild 会源码编译失败, 别死磕——直读 DB 优先, 修 MCP 交给事后运维。

## 关键数据坑（每个都会浪费大量时间）

- **vdot_value 只对 Z3+ 代表强度段计算，轻松/恢复跑为 null**。判断"峰值速度能力"要用**有 vdot 的快课**（间歇/阈值），别用历史均值——均值被大量轻松跑拉低，会严重低估跑者真实速度储备。报告里要区分"峰值 VDOT"和"日常 VDOT"。
- **部分课表配速异常**（如 11:17/km、8:08/km、7:23/km）= 停表/步行/GPS 漂移计入用时。做统计和 PR 判断前先识别剔除，别当成真实能力，也别据此下"跑者变慢"结论。
- **get_activity_records / get_activity_track 输出巨大**（1MB+，自动落 spillover 文件）。用 `execute_code` + hermes_tools.read_file 读盘处理，**不要重拉 API**。逐秒 records 的 cadence/power/pace 等有 None，聚合排序前先 `if x is not None` 过滤，否则 `TypeError: '<' not supported between NoneType and int`。
- **time_in_hr_zone / time_in_power_zone 是 JSON 字符串数组，长度恒为 5，索引 0 = Z1**（`[Z1,Z2,Z3,Z4,Z5]`，**没有**「低于 Z1」这一项；真实库**全部活动**与全部有功率的活动都是恰好 5 个元素，无一例外）。需 json.parse 后按索引直接跨活动聚合。活动级区间边界看该活动的 `hr_zone_boundaries`（设备原始，21 套方案），app 的 5 区一律由 `resolveMaxHr()`（`.env MAX_HR`）本地重算，与全局 get_hr_zone_analysis 的 zoneRanges 同源，但**设备原始边界不可跨活动比较**。
- `get_activity` 里 `workout_steps`（课表）、`hr_zone_boundaries`/`power_zone_boundaries`、`devices`、`workout_name` 等是 **JSON 字符串字段**，需自行 parse。
- get_activity 还提供官方指标：`garmin_vo2max`（官方值，区别于本地推算的 vdot_value）、`threshold_heart_rate`、`recovery_time`、`primary_benefit`、`user_weight`（公斤，供功率体重比）。这些是教练画像的好料，一次抓齐。
- ⚠️ **不要拿 `user_height` / `resting_heart_rate_fit` / `hr_zone_boundaries` 当个人指标**：前两者是**设备配置快照**（`resting_heart_rate_fit` 覆盖约六成活动、仅 7 个取值 42–48，同一天多条活动同值；`user_height` 全库只有 4 个取值且无任何计算引用），`hr_zone_boundaries` 是设备原始边界（21 套方案随固件而变）。app 的心率区间一律走 `resolveMaxHr()` 本地重算，跨活动才可比。
- ⚠️ **`hrv_rmssd` 不要用来判断单次训练的恢复状态**（详见下节「HRV 的正确用法」）。

## 教练诊断框架

详见 `references/coaching-metrics.md`（Daniels VDOT→成绩换算表、跑区配速、ACWR 区间、跑步经济性阈值、Polarized/金字塔目标占比）。

- **VDOT vs 实际 PB**：把"峰值 VDOT 预测成绩"与"实际 PR"对比，差距大 = 速度储备未转化 / 比赛执行保守 / 长距离耐力薄弱——这是最有价值的诊断点。
- **比赛目标折算 (Riegel)**：用近期比赛折算目标距离成绩时，基线时效优先于公式（同周期 ≤2 周的比赛直接用；过期 PB 先按趋势修基线再折算，否则预测系统性偏慢）；输出三档目标+概率，配检查点决策树与心率红线的执行处方——模板见 references/coaching-metrics.md「比赛目标折算与执行处方」。
- **强度结构**：对比 Daniels 目标比例判 Polarized vs 金字塔。Z2 占比过高 + Z1/Z5 不足 = "中等强度陷阱"，建议两极化。
- **ACWR**：0.8-1.3 安全区；连续训练日=0 说明恢复纪律好、伤病风险低。
- **跑步经济性**：垂直振幅 <8mm、垂直比 <8.5%、触地时间 <240ms 为优秀；步频轻松跑偏低但快课能升到 188+ 属正常。
- **周期化**：月度跑量到 180-200km/月后进平台期，后续突破靠**优化强度结构**而非继续堆量。
- **HRV (hrv_rmssd)**：⚠️ **见下节「HRV 的正确用法」——不要按「>100ms 恢复好 / <60ms 需减载」判读，那套阈值在本库会让每一次活动都被判成「需减载」。**

报告结构建议：运动员画像 → VDOT/跑力深度 → 强度结构 → 生物力学 → 周期化 → 目标设定（3/6 个月）→ 伤病/恢复 → 训练处方（周课表 + 配速表）→ 数据质量提醒。结尾给一个可执行的下一步选择让用户挑。

## 力量训练分析（2026-11 新增）

### 数据边界：先认清「能说什么、不能说什么」

**硬边界（51 条本地 FIT 实测，不要越界）**：

| 想拿 | 可得性 | 依据 |
|---|---|---|
| 动作名（深蹲/卧推/硬拉） | ❌ | FIT 里没有 `set` 消息；Garmin 只在云端 `exerciseSets` 提供，本地同步管线只下 FIT |
| 重量 / 次数 | ❌ | 同上（`set`/`exercise_title` 消息数实测为 0） |
| 训练计划名 | ✅ 49/51 | `workout_name`（「全身循环1」「核心稳定性4」等） |
| 组结构（active/rest 交替） | ✅ 49/51 | `workout_steps` JSON |
| 时长 / 平均心率 / 卡路里 | ✅ 51/51 | 平铺列（平均心率 68–129） |
| 训练效应 (TE) | ✅ 51/51 | `total_training_effect` |
| 官方恢复建议 | ✅ 51/51 | `recovery_time`（**分钟**） |

**绝不要**编造「深蹲 80kg × 5 组」这类容量数据 —— 用户会立刻发现你在瞎猜，整个报告的可信度归零。
正确说法：**「课表是全身循环1，7 组 40s 做 + 20s 歇，总时长 24 分钟，平均心率 117，训练效应 1.0」**。

### `get_strength_sessions` 返回字段怎么读

```
{ data: [{
  activityId, name, startTimeLocal,
  durationSeconds,        // 计时器时间(秒) —— 实际练了多久
  avgHeartRate, maxHeartRate, calories,
  aerobicEffect,          // 有氧 TE (0-5)
  anaerobicEffect,        // 无氧 TE (0-5)
  recoveryTimeMinutes,    // 官方恢复建议, 单位**分钟**
  load,                   // 派生负荷分(与跑步 training_load 同量纲)
  planName,               // 计划名
  workingSets,            // 有效组数 = active/interval 步数
  restSets, plannedSeconds, workingSeconds, restSeconds, workRestRatio,
  structure,              // intervals | continuous | unknown
  intensityDomain,        // recovery | base | tempo | high | unknown
}], total, returned, limit, offset }
```

**必须区分 `plannedSeconds` 与 `durationSeconds`**：课表是**「一轮」模板**。
真实样本「核心稳定性1」计划 **400s** 而实际 3609s —— 用户做了多轮。**FIT 无 set 消息，
真实轮数不可得，绝不要推断「做了 8 轮」**。报告里只能写「课表为 40s 做 / 20s 歇 × 6
→ 40s 连续的循环模板，本次实际训练 60 分钟」。

⚠️ 末段休息常是 `open`（无 `duration_sec`），所以计划时长不是整齐的 N×(做+歇)，
描述也不是整齐的「×7」—— 49 条真实课表里 **32 条**是这种 14 步/400s 形态（不是 33：
33 条 14 步里有 1 条计划总时长不是 400s）。

⚠️ 另有 3 条课表末尾带 `repeat_until_steps_cmplt`（FIT 的**循环控制步**，不是训练段，
没有时长）。它**不计入有效组数** —— 若你看到某个课表的组数比「做段数」多 1，
那是旧实现的缺陷，不是数据问题。

### 强度域判定（不要只看心率）

`intensityDomain` 由 **训练效应（TE）为主、心率为辅** 判定：

| 域 | 判定 | 负荷系数 |
|---|---|---|
| high | TE ≥ 3.5 | 1.5 |
| tempo | TE ≥ 2.5 | 1.3 |
| base | TE ≥ 1.5 | 1.0 |
| recovery | TE > 0 | 0.6 |
| unknown | TE/HR 均缺 | 0.8 |

心率兜底：<100 recovery、<130 base、否则 tempo。

**为什么不能只用心率**：力量训练心率响应**滞后且峰值低**（真实库 51 条平均心率
68–129，多数在 Z1/Z2）。一堂 32 分钟、TE 4.0 的高强度循环可能平均心率只有 120 ——
按心率会判成「轻松」，按 TE 才判成「高强度」。**报告里判强度看 TE，心率只作辅助描述。**

### 负荷口径（与跑步同量纲，但别与 Garmin 官方值混比）

`load = 时长(h) × 100 × 域系数`。真实库回填后力量负荷均值 **32.7**（跑步 73.2）——
一次 32 分钟基础力量课 ≈ 32 分，与一次轻松跑同量级。

- **合并口径**：`get_training_load_analysis` 的 `load` 已含力量训练。真实库近 28 天
  ACWR 1.40 → 1.32（慢性负荷 227.25 → 242.25），因为力量课补进了慢性窗。
  **网站各页同口径**：首页 / 分析页 / 洞察页 / 跑者画像全部是合并口径，同一时期
  任何一处给出的 ACWR 都应当一致。若用户说「页面之间数字不一样」，那是缺陷不是口径。
- **但 `distance`/`duration`/`runs` 仍只统计跑步**。看到「负荷涨了但里程没涨」是正常的
  —— 那是力量训练的贡献。
- **不要与 Garmin 官方 `training_load_peak` 比**：后者与库内值比值 1.2–2.6 倍浮动、
  不可换算。跨口径比较只在本项目内自洽。

### 单次力量课的 AI 分析能拿到什么（网站详情页）

网站的活动详情页「AI 教练」对力量课会注入这些专属数据（`app/lib/llm.ts`）：

| 数据块行 | 值示例 | 用途 |
|---|---|---|
| `力量训练计划` | 核心稳定性1 | 识别课表 |
| `组结构` | 40s 做 / 20s 歇 × 6 → 40s 连续 | 判断课表形态 |
| `有效组数 / 休息段 / 工作:休息` | 7 / 7 / 2.3:1 | 刺激结构 |
| `计划时长 / 实际时长` | 6:40 / 1:00:09 | **两者不同，别混用** |
| `强度域` | 恢复（有氧 TE 0.1） | 按 TE 判定，不是心率 |
| `数据边界` | 重量与次数不可得 | 禁止编造容量 |

⚠️ 提示词已明确：**只有力量训练**有派生负荷（游泳/球类/爬楼不计算）。
引用力量负荷时必须说明它不是 Garmin 官方值。

### 教练视角：力量训练怎么进处方

1. **先看频率与分布**：`get_strength_sessions limit=20` 数近 4 周次数、看 `intensityDomain`
   分布。每周 2 次、以 base/recovery 为主 = 维持型；全是 high = 需要插恢复。
2. **看与跑步的负荷竞争**：`get_training_load_analysis days=28` 的 ACWR。若 ACWR 已
   进入 1.3–1.5 警戒区，且力量课占比不低 → 优先减**力量课的强度域**（把 high 换成
   base），而不是砍跑量（跑步是主项）。
3. **看恢复建议是否被尊重**：`recoveryTimeMinutes` 是 Garmin 官方值（真实库力量课最长
   **2970 分钟 ≈ 49.5 小时**，跑步最长 5760 分钟 ≈ 96 小时）。若连续两天都有高强度
   力量课，直接指出「官方建议恢复 49 小时，你在 18 小时后又是一次 high，这是伤病风险
   的主要来源」。
4. **交叉训练的定位**：力量训练对跑者的价值是**肌腱/核心/稳定性**，不是有氧替代。
   若用户把力量课当成「补跑量」，指出 `distance` 语义不存在（力量课 0 距离），
   里程目标只能靠跑步达成。
5. **数据质量提醒**：报告结尾必须有一句「力量训练的重量/次数不可得（FIT 无 set 消息，
   仅 Garmin 云端有），因此无法评估训练容量与渐进超负荷」。不写这句，用户会以为
   你漏做了。

## 游泳分析（2026-11 新增）

### 单位：游泳看**秒/100m**，不是秒/公里

库里 `average_pace` 是**秒/公里**（真实库泳池游泳 1670 s/km），直接说「配速 27:50/km」
对游泳者毫无意义 —— 池长 25/50m，行业语言是秒/100m。换算：

| 已知 | 换算 |
|---|---|
| `average_pace`（秒/公里） | **÷ 10** = 秒/100m |
| `average_speed`（km/h） | **360 ÷ 速度** = 秒/100m（不是 ÷10！） |

真实库四条游泳验算：

| activity_id | 距离 | 计时器时间 | km/h | 秒/100m | 展示 |
|---|---|---|---|---|---|
| 630387237 | 2.05 km | 2911 s | 2.535 | 142.0 | `2:22` |
| 599287904 | 0.775 km | 2088 s | 1.336 | 269.4 | `4:29` |
| 617083438 | 2.2 km | 2384 s | 3.322 | 108.4 | `1:48` |
| 614598589 | 1.075 km | 2415 s | 1.602 | 224.7 | `3:45` |

**⚠️ 常见错误**：拿 km/h 做 ÷10 得 0.25，读成「每 100 米 0.25 秒」（等价 400 m/s）。
时间基数必须是**计时器时间**（`moving_time`，缺失才回退 `duration`）—— 630387237 用
经过时间 3425s 会算成 `2:47`，比真实慢 25 秒。

### 划频、总划水次数、每划距离都可得

- `average_cadence` 对游泳是**划频（次/分）**，不是步频（spm）。真实库 **4/4** 条游泳都有值
  （44/48/48/46）。可以评价「划频偏低 / 偏高」，但**不要**用跑步的 160–190 spm 区间对照。
- **总划水次数** = `activities.total_cycles`。真实库 **4/4** 条游泳都有
  （518 / 798 / 923 / 695）。双重自证：① `Σlap.total_cycles == session.total_cycles`
  （4/4 精确相等）；② `total_cycles ÷ 活跃时间 ≈ average_cadence`
  （518 / 21.4 min = 24.2 次/分 vs FIT `avg_cadence` = 24）。
  **不要 ×2** —— 它是绝对计数，不是步频（×2 会得到 1036 次划水，与 775m/1.5m 对不上）。
- **每划距离**（m/划）= `distance_m ÷ total_cycles`，真实库 1.35–2.95 m/划。
  这是游泳技术分析的核心指标：**划频高但每划距离短 = 抓水效率低**。
- **泳姿**：session 级 `swim_stroke` 恒为 255（无效），但 **FIT lap 级有真实泳姿**
  （freestyle / backstroke / breaststroke / butterfly / drill / mixed / im）。
  真实库 4 条游泳 79 段里 **35 段**有值：freestyle 18 / mixed 12 / breaststroke 4 /
  backstroke 1，其余 40 段是 0 距离池边休息段（255）。
  自证：`swim_stroke == 255 ⟺ distance == 0`（0 违反），且
  `Σ(真实泳姿段 distance) == session.total_distance`（775/1075/2200/2050）、
  `Σ(真实泳姿段 total_cycles) == session.total_cycles`（518/798/923/695）。
  ⚠️ **`mixed` 是设备记录的真实取值**（这一段换了泳姿），**不是「未知」** ——
  不要把它当缺失、也不要说「泳姿记录不完整」。但它**构成未知**：
  **不要给混合泳姿算每 100m 配速或每划距离**（那会凭空造出一个数）；
  `im`（个人混合泳，按规则轮换四种）与 `drill`（分解练习）同理。
  ⚠️ 泳姿分组的秒数之和 **不等于** SWOLF 的时间基数（后者含全部活跃段），
  不要用分组重算 SWOLF。
- 旧版 skill 曾声称「总划水次数与泳姿都拿不到」—— **那是假话**，
  已由第十类缺陷（总划水次数）与第十三类缺陷（泳姿）分别修正
  （FIT 里一直有，是解析器不读）。

### `total_cycles` 只有三种运动能解读

同一个 `total_cycles` 字段，在不同运动里是完全不同的东西。**只有下面三种确认了语义**
（判据：结构自证 `Σlap==session` + 一个**不同来源**的锚点）：

| 运动 | 语义 | 结构自证 | 独立锚点 |
|------|------|---------|---------|
| 游泳 | 总划水次数 | 4/4 精确（518/798/923/695） | ÷活跃时间 ≈ 划频（24.2 vs 24） |
| 跳绳 | 总跳跃次数 | 3/3 精确（189/187/193） | ÷时长 = 115–150 次/分 |
| 爬楼 | 总步数 | 30/30 精确 | ÷楼层 = 14.6–29.0 步/层 |

**其余类型一律不要解读**，即使数据块里出现了这个数字：

- **力量训练**：`r(total_cycles, 时长) = −0.118`（n=51，几乎无关）。同模板
  「核心稳定性4」15.2 分钟的课 `cyc=51`、28.1 分钟的课 `cyc=40` —— 时长翻倍反而更少，
  它不可能是「做了多少次」。`activity_laps` **0/51**（设备不写 lap 消息），
  `num_laps` 恒为 37/41/42/43/44/49（随课表模板变，与时长无关，也不是组数）。
- **室内有氧**：同名「5 分钟平板支撑挑战」9 条里出现 **5 / 19 / 66 / 474**（95 倍跨度）。
  平板支撑只有 1 次，任何「次数」解释都不成立。
- **球类**：结构自证对得上（篮球 3/3、乒乓 2/2、羽毛 1/1），但篮球 53 分钟 1685 次
  折合 32「触球」/分，不符合任何球类常识。**结构自证只证明「读得一致」，
  不证明「读的是什么」。**
- **跑步**：步幅周期数（≈ 步频 ÷ 2）。对跑者没有语义，`步频` 已表达同一信息。

这条纪律来自**第十一类缺陷**：修好「字段没进库」之后，详情页留了 `: '总计数'`
兜底，把语义未确认的数字当成确定值展示。**「库里有值」不等于「知道它是什么」。**

### SWOLF：游泳唯一把「快」和「省」合成一个数的指标

```
SWOLF = 单趟用时（秒） + 单趟划水次数
```

同样 25m，**48 秒 + 20 划 = 68** 比 **40 秒 + 32 划 = 72** 更高效 —— 后者虽快，
但每一划推进距离短。**单看配速会把后者误判为更好**，这就是 SWOLF 存在的理由。

数据块给 `SWOLF: 58（25m 池）` 与 `池长/趟数: 25m 池 × 31 趟`。真实库 4 条：

| 活动 | 池长 | 趟数 | 活跃秒 | 总划水 | SWOLF |
|------|------|------|--------|--------|-------|
| 599287904 | 25m | 31 | 1283 | 518 | **58** |
| 614598589 | 25m | 43 | 2010 | 798 | **65** |
| 617083438 | 50m | 44 | 2369 | 923 | **75** |
| 630387237 | 50m | 41 | 1862 | 695 | **62** |

**两条铁律**：

1. **绝不能跨池长比较**。50m 池的单趟用时与划水次数都约为 25m 池的两倍，
   SWOLF 自然翻倍。上表 25m 是 58/65、50m 是 75/62 —— 直接比会得出
   「25m 池更高效」的错误结论。评价时必须说「这个 25m 池的 58 属于…」。
2. **绝不能折算**。把 50m 的 75 折成「37（25m 等效）」是错的：转身与蹬壁在长池里
   被摊薄，折算值会远低于任何真实 25m 值。**没有「等效 SWOLF」这个概念**。

自证：`num_active_lengths × pool_length == distance×1000` 在 4/4 条上精确成立
（775=31×25、1075=43×25、2200=44×50、2050=41×50）—— 用户可自己核对趟数与池长。

### 主观感受与 RPE：唯一由用户主动输入的数据

- `workout_feel`：0 / 25 / 50 / 75 / 100（很差 → 很好）。数据块给中文标签。
  **`0` 是有效值**（约 6% 的填写者选「感觉很差」），不是缺失。
- `workout_rpe`：Borg CR10 **1–10**（`0` 不合法）。数据块给「RPE 6/10（有点吃力）」。
- 覆盖**约七成活动**（全部跑步 + 游泳 + 1 条室内骑行；力量/球类/爬楼不弹窗）。
- 两者严格反向：`r = −0.856`，feel 各档 RPE 均值
  **8.1 / 5.9 / 3.8 / 2.4 / 1.4**（严格单调）。

**偏离样本仅 1 条（0.4%）**（feel ≥ 75 且 RPE ≥ 6，或 feel ≤ 25 且 RPE ≤ 3）。
数据块出现 `体感偏离: 是` 时才值得单独解释 —— 而这恰恰是客观指标完全无法回答的
问题：「数据说这课很轻，你为什么觉得吃力」。**不要把体感当客观指标**用于
负荷计算或能力评估。

### 估计出汗量：设备估算值，且有速率上限

- `est_sweat_loss` 覆盖**除游泳外的全部活动**（游泳 0/4）。数据块给「约 1794 ml」+
  「约 980 ml/h」。
- **必须带「约」**：实测 306 条有效速率里 **88 条**撞上 999–1000 ml/h 的设备上限
  （p99=999、max=999，无一超过 1000），而真实出汗率可达 **1500–2000 ml/h**。
  它是**保守下限** —— 按它算补液会偏低。
- 补液建议按「体重丢失 1kg ≈ 补水 1.0–1.5L」给区间，并说明这是设备估算值。

### 分段（laps）

- `activity_laps.distance` 单位是**米**。游泳 lap 含 **0 距离休息段**（真实库 79 段里有
  多段 0），这些段 `average_pace` 为 `null` —— 是「没有配速语义」，不是「配速为 0」。
- 最大段可能很长（617083438 有一段 1800m），不要假设每段是 25/50m 池长。
- `average_pace` 在 lap 上仍是秒/公里，同样 ÷10 得秒/100m。
- **分段训练角色来自设备，不是配速推断**（2026-11 修订）：`activity_laps.intensity`
  是 FIT 里设备记录的计划意图，覆盖 **3058/3137 段 = 97.5%**。映射：
  `interval`→主课、`recovery`/`rest`→恢复、`warmup`→热身、`cooldown`→冷身；
  **`active` 只表示「这段在计时」不是主课**（`657456825` 全程 22 段都是 `active`，
  一次匀速慢跑），`255`/缺失 = 设备未记录。
  ⚠️ 旧版按配速推断角色，与设备值仅 **73.2% 一致（747/1021 段）**，典型错误是把
  配速偏快的**首段**判成「主课」而设备标的是「热身」。**复盘间歇课必须以 `intensity`
  为准**，不要自己按配速重判。
  结构自证：`warmup` 恒在索引 0、`cooldown` 恒延续到末段（9/9 完美）。

### 负荷：游泳不进 ACWR/CTL/TSB

`training_load` 在游泳上 **0/4 有值**（Garmin 只对跑步与力量课写该字段）。游泳对跑者的
意义是**主动恢复/有氧维持**，评估它用「时长 + 平均心率 + 心率区间分布 + TE」，不要
自行估算负荷后并入跑量统计。

## HRV 的正确用法（2026-11 修订，旧口径会让每次活动都判「需减载」）

### 先说结论：`hrv_rmssd` 不是单次训练指标

库里的 `hrv_rmssd` 是**运动过程中**由 FIT `hrv` 消息算出的 RMSSD，**只覆盖约 6% 的活动**。
运动中的 HRV 受呼吸频率、运动伪迹、漏拍影响极大，**不能用来判断「今天恢复得好不好」**。
Garmin 官方的 HRV Status 是**隔夜静息测量**，与这个字段**不是一回事**，不能互相替代或类比。

**正确的用法**：只看**同一人、同一时期、相近强度**下的相对趋势（例如同类课从 20ms 掉到
10ms），且必须与静息心率、主观睡眠/酸痛一起看。**永远不要**用绝对值下「恢复好/需减载」的
结论，也**不要跨活动排序**（不同活动的心率水平、时长、强度结构完全不同）。

### 为什么旧阈值必须废弃（实测数据）

旧口径写「高（如 >100ms）= 恢复好；<60ms = 需减载」。用修复后的算法（已拆分设备漏拍
合并值）在真实库 20 条活动上实测：

| 判据 | 命中 | 结论 |
|------|------|------|
| `> 100ms` → 恢复好 | **0/20** | 永远不会触发 |
| `< 60ms` → 需减载 | **20/20** | **每一次活动都会被判「需减载」** |

实际分布是 1.2–34.0ms（中位数约 20ms），因为这是**运动中**的测量值。按旧阈值，模型会对
每一条活动都输出「HRV 偏低、建议减载」——这不是保守，是**系统性错误结论**。

### 字段口径（引用时必须带上）

- `hrv_rmssd`：RMSSD（毫秒），**已拆分设备漏拍合并值**（`0.725 ≈ 2 × 0.363` 这类倍频）。
  修复前 20 条里有 4 条算出「RMSSD > 全程 RR 极差」的物理不可能值（最高 163.59ms vs
  极差 108.3ms），`r(平均心率, RMSSD)` 是 **+0.723**（生理上应为负相关）；修复后
  `r = −0.254`，方向正确。
- `hrv_rmssd_ratio`：`RMSSD / meanRR`，**无量纲自证字段**。运动中正常区间 **< 0.10**；
  **> 0.2 说明数据不可信**（拆分失败/伪迹过多），此时**不要引用该条的任何 HRV 结论**。
  真实库修复后范围 0.004–0.085，中位数 0.037。

**自检动作**：拿到 `hrv_rmssd` 时先看 `hrv_rmssd_ratio`。若 > 0.2，说明这条数据有问题，
直接跳过 HRV 分析；若为 `null`，说明该活动没有 RR 数据，**不要编造 HRV 结论**。

## 跑鞋选购

碳板决策 + 国产碳板 lineup（2026 款）见 `references/shoe-selection.md`。核心原则：按**体重/配速/目标**判是否上碳板；碳板**只用于比赛 + 高强度课**（中底寿命 500-700km），日常堆量继续用无板训练鞋；窄楦碳板 42 码常需上 42.5；配速目标落在 4:30-4:50/km 是碳板收益最大的甜蜜区。

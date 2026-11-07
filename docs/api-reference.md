# API 接口文档

本文档详细介绍 Garmin Running Data Analytics 提供的所有 API 接口。

## 基础信息

- **Base URL**: `https://your-domain.vercel.app`
- **协议**: HTTPS
- **格式**: JSON
- **编码**: UTF-8

## 目录

- [活动相关 API](#活动相关-api)
- [统计相关 API](#统计相关-api)
- [分析相关 API](#分析相关-api)
- [洞察相关 API](#洞察相关-api)
- [深度分析 API](#深度分析-api)
- [系统与模型 API](#系统与模型-api)
- [错误处理](#错误处理)

---

## 统计口径：跑步 vs 全类型

API 分两类口径，**不可混用**（背景与实测数据见 [功能总览 §1.1](features.md#11-统计口径两种口径必须显式区分)）：

| 口径 | 接口 | 说明 |
|------|------|------|
| **表现分析（只取跑步）** | `/api/stats`、`/api/stats/personal-records`、`/api/analysis/hr-zones`、`/api/analysis/pace-zones`、`/api/analysis/power-zones`、`/api/analysis/vdot-trend`、`/api/vdot`、`/api/insight`、`/api/insight/coach`、活动详情的可比样本 | 只统计 `running` / `track_running` / `treadmill_running`；配速、步频、心率区间、VDOT、个人纪录、训练负荷、同路线对比只在跑步内部可比 |
| **活动日志（全类型）** | `/api/activities`、`/api/activities/months` | 返回库里所有运动类型；列表带 `activity_type` 筛选器，月度「N 公里 / N 次」与展开后的卡片严格一致 |

跑步类型集合由 `db.runningTypeClause` / `db.isRunningType` 单点定义；缺
`activity_type` 列或值为空时按跑步处理（旧库兼容）。非跑步活动仍保留自己的分段与
心率区间数据（如泳池游泳的分段、区间分布），只是不参与配速排名与跑力统计。

> 若某接口返回的次数小于数据库活动总数，通常是该接口属于**跑步口径** —— 这不是漏数据。

---

## 活动相关 API

### 1. 获取活动列表

获取活动列表（**全类型口径**），支持分页、按月份筛选与按运动类型筛选。

**请求**

```http
GET /api/activities
```

**查询参数**

| 参数 | 类型 | 必填 | 说明 | 示例 |
|------|------|------|------|------|
| `page` | number | 否 | 页码，默认 1（最大 1000000） | `2` |
| `limit` | number | 否 | 每页数量，默认 20（最大 500） | `50` |
| `type` | string | 否 | 按运动类型精确筛选（`running` / `strength_training` / `lap_swimming`…）。`/list` 页下拉的**值就是这些原始键**，展示文案由 `activityTypeLabel` 转成中文 | `running` |
| `q` | string | 否 | 搜索活动**名称**或**运动类型中文名**（与 `/api/activities/months` 的 `q` 同一实现 `db.buildQueryCondition`）。纯空白等于不搜索 | `力量` |
| `startDate` | string | 否 | 起始本地日期 (YYYY-MM-DD，含当日) | `2026-09-01` |
| `endDate` | string | 否 | 结束本地日期 (YYYY-MM-DD，含当日) | `2026-09-30` |

> `startDate > endDate` 返回 400。列表响应**不含** `track`（单条约 40KB），路线由活动详情接口单独提供。
>
> **`q` 与 `type` 不是同一口径**：`q` 同时匹配名称与类型中文名，`type` 只匹配类型键。
> 真实库 `q=力量` 与 `type=strength_training` 都返回 51 条，但 `q=跑步` 会命中名称里
> 含「跑步」字样的活动（≠ `type=running` 的 233 条）。两者不要互相校验。
>
> **`q` 必须与 `/api/activities/months` 用同一个值**：`/list` 的月卡头部按 `q` 过滤，
> 展开后的卡片走本接口 —— 两处条件不一致时，头部说「2 次」、展开却列出整月 19 条
> （第三十类缺陷）。

**响应示例**

```json
{
  "data": [
    {
      "activity_id": 14234567890,
      "name": "晨跑 10K",
      "activity_type": "running",
      "start_time": "2026-02-13T06:30:00.000Z",
      "start_time_local": "2026-02-13T14:30:00",
      "distance": 10.0,
      "duration": 3000,
      "average_pace": 300,
      "average_heart_rate": 150,
      "average_cadence": 170,
      "vdot_value": 52.3
    }
  ],
  "pagination": { "page": 1, "limit": 50, "total": 150 }
}
```

**字段说明**（DB 列名直出，未做别名映射）

| 字段 | 类型 | 说明 | 单位 |
|------|------|------|------|
| `activity_id` | number | 活动唯一 ID | - |
| `name` | string | 活动名称 | - |
| `activity_type` | string | 运动类型 (`running` / `strength_training` / `lap_swimming`…) | - |
| `sport_type` | string \| null | FIT sport 中文展示 (跑步/健身器械…)；**含退化值「通用」与未翻译原始枚举**（`basketball` / `floor_climbing` / `tennis`），展示前必须过 `isInformativeTypeValue` | - |
| `sub_sport_type` | string \| null | FIT sub_sport 中文展示 (路跑/跑步机/越野…)；真实库 **269/348** 条为「通用」（设备未填子类型），不能直接当类型名用 —— 见 `activityTypeName` | - |
| `start_time` | string | 开始时间（UTC 绝对时刻） | - |
| `start_time_local` | string | 开始时间（本地墙钟，无时区标记） | - |
| `distance` | number | 总距离（**公里**，注意不是米） | km |
| `duration` | number | **经过时间**（FIT `total_elapsed_time`，含暂停） | 秒 |
| `moving_time` | number | **计时器时间**（FIT `total_timer_time`；配速/统计的时间基数） | 秒 |
| `average_pace` | number \| null | 平均配速（时间基数 = `moving_time`；**非跑步类型不可作为跑步配速解读**） | 秒/公里 |
| `average_heart_rate` | number \| null | 平均心率 | bpm |
| `average_cadence` | number \| null | 平均步频（非跑步类型语义不同，如篮球 16） | spm |
| `vdot_value` | number \| null | VDOT 跑力值（仅跑步类型，Z3+ 代表性强度段才计） | - |
| `training_load` | number \| null | 训练负荷（优先 FIT 官方，缺省按时长×心率档回退） | - |
| `garmin_vo2max` | number \| null | Garmin 官方 VO2max | ml/kg/min |
| `recovery_time` | number \| null | 恢复时间 | 分钟 |
| `primary_benefit` | string \| null | 训练主要收益 | - |
| `hr_zone_boundaries` | string \| null | **设备**心率区间上限边界 (JSON 数组，边界方案随固件而变，仅追溯用) | bpm |
| `time_in_hr_zone` | string \| null | 心率区间秒数 (JSON 数组，长度恒为 5，本地 5 区口径，覆盖全部活动) | 秒 |
| `device_time_in_hr_zone` | string \| null | **设备原始**心率区间秒数 (JSON 数组，跨活动不可聚合，仅追溯用) | 秒 |
| `power_zone_boundaries` | string \| null | **设备**功率区间上限边界 (JSON 数组；`[3]` 恒等于 FTP，是 FTP 覆盖率 33→241 的回退依据) | 瓦 |
| `time_in_power_zone` | string \| null | 功率区间秒数 (JSON 数组，长度恒为 5，本地 5 区 **%FTP** 口径，由逐秒功率推导，真实库 241/241) | 秒 |
| `device_time_in_power_zone` | string \| null | **设备原始**功率区间秒数 (JSON 数组，绝对瓦数边界随 FTP 变化，跨活动不可聚合，仅追溯用) | 秒 |
| `devices` | string \| null | 设备列表 (JSON 数组) | - |
| `user_weight` | number \| null | 体重 | kg |
| `user_height` | number \| null | 身高 | m |
| `resting_heart_rate_fit` | number \| null | 静息心率 | bpm |
| `workout_name` | string \| null | 课表名称 | - |
| `workout_steps` | string \| null | 课表步骤 (JSON 数组)。`duration_sec` 是**秒**（FIT 源是毫秒）、`target_pace_sec_per_km` 是**秒/公里**（FIT 源是 mm/s）；两者都不能直接读设备原始值 | 秒 / 秒每公里 |
| `hrv_rmssd` | number \| null | HRV RMSSD（**已拆分设备漏拍合并值**；仅 20/353 有值，不做跨活动对比） | ms |
| `hrv_rmssd_ratio` | number \| null | `RMSSD / meanRR`（无量纲自证字段；运动中应 < 0.10，> 0.2 说明数据不可信） | - |

---

### 2. 获取可用月份列表

按月汇总里程与活动次数（**双口径同行**），用于 `/list` 页的月份折叠卡片。

| 字段 | 口径 | 用途 |
|------|------|------|
| `runDistance` / `runCount` | **只跑步**（`running` / `track_running` / `treadmill_running`，空 `activity_type` 视为跑步） | 月度「N 公里」—— 用全类型会把游泳距离加进跑量（真实库 2026-08 多 2.05km） |
| `totalDistance` / `count` | **全类型**（含游泳/球类/力量训练） | 月度「N 次」与展开后的卡片数严格一致（真实库 2026-09 若只算跑步会显示 3 次却列出 4 张卡） |
| `typeBreakdown` | **全类型**，按条数降序（同数按 `type` 升序） | 月卡「含 力量训练 2 · 爬楼 1」。旧实现只有「含 N 次其他」—— 用户知道还有别的运动，但**不知道是什么**，与「记录栏目只有跑步类型」是同一类观感来源 |
| `totalDuration` | **全类型总时长（秒）**，时间基数为**计时器时间**（`moving_time > 0` 用它，否则回落 `duration`） | 月卡在**里程为 0** 时用它。力量训练/爬楼/HIIT/跳绳的 `distance` 恒为 0，时长是它们唯一的训练量 —— 修复前筛到这些类型月卡只剩「4 次」，而 4 次 20 分钟和 4 次 200 分钟长得一模一样（真实库 2026-09 力量课 4 次共 120 分钟、2026-01 爬楼 16 次共 306 分钟） |

`totalDistance` 为**公里**（与 `activities.distance` 一致）。筛选非跑步类型时
`runDistance`/`runCount` 恒为 0 —— 此时里程在 `totalDistance` 里，不要读成「这个月没运动」。

`totalDuration` 与 `count` **同口径（全类型）**，但与 `getStats().totalDuration`
**刻意不同口径**：后者带 `WHERE runningTypeClause`，只算跑步。月卡的「N 次」是全类型，
旁边的时长必须同口径，否则「4 次」配「3:22:30」（只有 3 次跑步）会让用户以为
第 4 次是 0 分钟。时长**不需要**像里程那样拆双口径 —— 不存在「游泳时长混进跑量」
那种语义冲突（时长在任何运动里都是真实训练时间）。

`typeBreakdown` 的元素形状为 `{ type: string; count: number }`，`type` 已按
`COALESCE(NULLIF(activity_type, ''), 'running')` 归一（空 `activity_type` 计入
`running`，与下拉/筛选同一规则）。**该字段只在未筛选时有展示意义**：按 `type`
或 `q` 筛选后，返回的构成就是被筛后的那部分，「其他」这个概念已不存在。
旧调用方可能拿到空数组（缺省值），UI 会回落到「含 N 次其他」徽标。

**请求**

```http
GET /api/activities/months?limit=6&offset=0&type=lap_swimming&q=游泳
```

**查询参数**

| 参数 | 类型 | 必填 | 说明 | 示例 |
|------|------|------|------|------|
| `limit` | number | 否 | 返回月份数（1–100）。**不传则返回全部** | `6` |
| `offset` | number | 否 | 偏移量，默认 0 | `6` |
| `type` | string | 否 | 按运动类型过滤（原始 `activity_type` 键，最长 64）。`all` / 空串 / 纯空白 = **不过滤**（归一在 `db.normalizeTypeFilter`）。不匹配的月份**不出现**，`total` 随之变化 | `strength_training` |
| `q` | string | 否 | 搜索词（最长 200），**同时匹配活动名称与运动类型中文名**，大小写不敏感。纯空白 = 不过滤（`db.normalizeQueryFilter`）。`q=力量` 能命中名称不含「力量」的 51 条力量课 | `力量` |

**响应示例**

```json
{
  "data": [
    {
      "monthKey": "2026-08",
      "runDistance": 197.55,
      "runCount": 23,
      "totalDistance": 199.6,
      "count": 31,
      "totalDuration": 91560,
      "typeBreakdown": [
        { "type": "running", "count": 23 },
        { "type": "strength_training", "count": 4 },
        { "type": "floor_climbing", "count": 2 },
        { "type": "lap_swimming", "count": 2 }
      ]
    }
  ],
  "total": 13
}
```

> 未传 `limit`/`offset` 时返回 `{ "data": [...] }`（无 `total` 字段）。

---

### 3. 获取活动详情

获取单个活动的完整信息（DB 列名直出，未做别名映射）。

**请求**

```http
GET /api/activities/{id}
```

**路径参数**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `id` | number | 是 | 活动 ID |

**响应示例**（真实生产库，字段已裁剪）

```json
{
  "activity_id": 567565549,
  "name": "九龙坡区 - 长距离跑",
  "activity_type": "running",
  "sport_type": "跑步",
  "sub_sport_type": "通用",
  "start_time": "2026-02-22T08:59:41.000Z",
  "start_time_local": "2026-02-22T16:59:41.000",
  "start_tz_offset_min": 480,
  "distance": 21.74561,
  "duration": 7123,
  "moving_time": 6881,
  "elapsed_time": 7123,
  "average_pace": 327.56,
  "average_speed": 10.99,
  "average_heart_rate": 158,
  "max_heart_rate": 183,
  "average_cadence": 180,
  "max_cadence": 200,
  "average_stride_length": 1.0377,
  "average_vertical_oscillation": 7.87,
  "average_vertical_ratio": 7.66,
  "average_ground_contact_time": 241.8,
  "average_power": 293,
  "max_power": 392,
  "normalized_power": 302,
  "total_ascent": 15,
  "total_descent": 7,
  "total_training_effect": 5,
  "total_anaerobic_training_effect": 0.2,
  "avg_altitude": 291.3,
  "max_altitude": 296.2,
  "min_altitude": 282.2,
  "calories": 1487,
  "average_temperature": 24,
  "total_cycles": 10319,
  "workout_feel": 75,
  "workout_rpe": 2,
  "est_sweat_loss": 1794,
  "vdot_value": 37.4,
  "training_load": 198,
  "garmin_vo2max": 55,
  "recovery_time": 4432,
  "primary_benefit": "有氧高负荷",
  "hr_zone_boundaries": "[94,113,132,150,169,188]",
  "power_zone_boundaries": "[231,284,323,357,411,4000,null,null]",
  "devices": "[{\"device_index\":0,\"device_type\":\"运动手表\",\"manufacturer\":\"garmin\",\"product\":3992,\"firmware\":\"27.09\"}]",
  "user_weight": 67,
  "user_height": 1.76,
  "resting_heart_rate_fit": 47,
  "workout_name": "长距离跑",
  "workout_steps": "[{\"index\":0,\"name\":null,\"duration_type\":\"time\",\"duration_type_label\":\"时长\",\"duration_sec\":2400,\"distance_m\":null,\"reps\":null,\"target_type\":\"speed\",\"target_low\":2944,\"target_high\":3361,\"target_pace_sec_per_km\":{\"fast\":298,\"slow\":340},\"intensity\":\"interval\",\"intensity_label\":\"间歇\"}]",
  "start_lat": 29.52873,
  "start_lng": 106.50725,
  "route_cells": "[\"wm5xzx2\",\"wm5xzx3\",\"wm5xzx6\"]",
  "route_bounds": "{\"minLat\":29.5277,\"maxLat\":29.5296,\"minLng\":106.5016,\"maxLng\":106.5035}",
  "route_km": 21.856
}
```

**字段要点**

- `distance` 为**公里**（`21.74561` = 21.7 公里），不是米。
- `average_speed` 与 `max_speed` 均为 **km/h**（FIT 解析器以 `speedUnit:'km/h'` 解析后原样落库；Strava 源同为 km/h）。不要按 m/s 再乘 3.6 —— 那会把 16.5 km/h 报成 59.4 km/h。
- `vdot_value` 仅在 Z3+ 代表性强度段计算，日常轻松/恢复跑为 `null`。
- `training_load` 优先 FIT 官方值，缺省按时长 × 心率档回退。
- **`total_cycles` 的语义随运动而变，绝不能跨类型比较，也绝不能 ×2**。
  但**只有三种类型确认了语义**（判据：结构自证 `Σlap == session` + 独立锚点）：
  - 游泳 = **总划水次数**（4/4：518/798/923/695，自证 ① `Σlap.total_cycles ==
    session.total_cycles` 4/4 精确相等、② `total_cycles ÷ 活跃时间 ≈ average_cadence`
    518/21.4min = 24.2 vs FIT 24）；
  - 跳绳 = **总跳跃次数**（3/3：189/187/193，自证 ① Σlap==session 3/3 精确、
    ② ÷时长 = 115–150 次/分，落在跳绳常识区间 100–160）；
  - 爬楼 = **总步数**（30/30，自证 ① Σlap==session 30/30 精确、② ÷楼层 = 14.6–29.0
    步/层，与 14 级台阶约 20 步吻合）。
  跑步 = 步幅周期数（≈ `average_cadence` ÷ 2，对跑者无语义，不展示）。
  ⚠️ **力量训练 / 室内有氧 / HIIT / 球类的 `total_cycles` 语义未确认，不要解读**：
  - 力量：`r(total_cycles, moving_time) = −0.118`（n=51，几乎无关）。同模板
    「核心稳定性4」15.2 分钟课 `cyc=51`、28.1 分钟课 `cyc=40` —— 时长翻倍反而更少。
    且 `activity_laps` **0/51**（设备不写 lap 消息），`Σlap == session` 这条自证用不了；
    `num_laps` 恒为 37/41/42/43/44/49（随课表模板变，与时长无关），也不是组数。
  - 室内有氧：同名「5 分钟平板支撑挑战」9 条里出现 **5 / 19 / 66 / 474**（95 倍跨度）。
    平板支撑只有 1 次，任何「次数」解释都不成立。
  - 球类：结构自证对得上（篮球 3/3、乒乓 2/2、羽毛 1/1），但**没有任何独立量能
    说清这个数是什么** —— 篮球 53 分钟 1685 次折合 32「触球」/分，不符合球类常识。
  ⚠️ `average_cadence` 对跑步做过 ×2（单侧周期 → spm），但 `total_cycles` 是
  **绝对计数** —— 对 518 次划水再 ×2 得 1036，与 775m ÷ 1.5m/划 对不上。
  由 `scripts/garmin/fit-parser.js` 直接从 FIT session/lap 的 `total_cycles` 读取
  （第十类缺陷：此前解析器整体丢弃该字段，全库不存在）。
  语义白名单的唯一来源是 `app/lib/cycles.ts`（未确认类型返回 `null` → 整项不渲染）。
- 游泳另可用 `distance(km) × 1000 ÷ total_cycles` 得**每划距离**（真实库 1.35–2.95 m/划），
  这是技术分析的核心指标（划频高但每划距离短 = 抓水效率低）。
- **主观感受 / 主观用力 / 估计出汗量（真实库 251–349/353）**：
  - `workout_feel`：用户主动输入的主观感受，取值 `0 / 25 / 50 / 75 / 100`（很差 → 很好）。
    **`0` 是有效值**（14/251 条「感觉很差」），判空必须用 `!= null`。
  - `workout_rpe`：主观用力（Borg CR10，**1–10**，`0` 不是合法档）。
    与 `workout_feel` 严格反向：`r = −0.856`（n=251），feel 各档 RPE 均值
    8.1 / 5.9 / 3.8 / 2.4 / 1.4。**偏离样本仅 1/251（0.4%）** —— 出现即值得单独解释。
  - `est_sweat_loss`：**设备估算**出汗量（ml，349/353，游泳 0/4）。
    内部速率上限约 **1000 ml/h**（88/306 条已触顶，实测 max = 999），
    而真实出汗率可达 1500–2000 ml/h —— 它是**保守下限**，引用必须带「约」。
- **泳池规格与 SWOLF（仅游泳，4/4）**：
  - `pool_length`（**米**）：FIT 的 scale=100（厘米）已由 `fit-file-parser` 应用，
    解析后直接是米（25/50）。**不要再 ÷100**。
  - `num_active_lengths`：活跃趟数（不含池边休息）。
  - 自证不变式：`num_active_lengths × pool_length == distance × 1000`
    （775=31×25、1075=43×25、2200=44×50、2050=41×50，4/4 精确相等）。
  - **SWOLF = 单趟秒数 + 单趟划水次数**
    = `活跃lap计时器秒之和 ÷ 趟数` + `total_cycles ÷ 趟数`。
    真实库 58（25m）/ 65（25m）/ 75（50m）/ 62（50m）。
    ⚠️ **绝不能跨池长比较，也绝不能折算** —— 50m 池的 SWOLF 天然约为 25m 的两倍；
    把 50m 的 75 折成 37 会远低于任何真实 25m 值（转身与蹬壁在长池里被摊薄）。
    ⚠️ 时间基数必须是**活跃 lap 的计时器时间之和**，不是活动级 `moving_time`
    （后者含池边休息，599287904 有 804s，会把 SWOLF 从 58 抬到 84）。
- **分段训练角色（`activity_laps.intensity`，覆盖 3058/3137 = 97.5%）**：
  设备在 FIT lap 里记录的**计划意图**，不是按配速推断的。DB 存**原始字符串**，
  角色映射属于展示层（`app/lib/lap-intensity.ts:lapRoleFromIntensity`）：

  | `intensity` | 角色 | 说明 |
  |-------------|------|------|
  | `interval` | `work`（主课） | 间歇主课段 |
  | `recovery` / `rest` | `recovery`（恢复） | 组间完全休息同属恢复 |
  | `warmup` | `warmup`（热身） | 恒在首段（可连续多段） |
  | `cooldown` | `cooldown`（冷身） | 恒延续到末段 |
  | `active` | **`null`（不猜）** | 只表示「这段在计时」；657456825 全程 22 段都是 `active`（匀速跑） |
  | `255` / 缺失 | **`null`（不猜）** | 设备没写，不是一种角色 |

  旧实现用配速推断角色（`pace < 均值×0.92` → 主课），与设备值仅
  **73.2% 一致（747/1021 段）**，274 段判错 —— 典型是把配速偏快的首段判成「主课」
  而设备标的是「热身」。设备值优先、推断兜底，来源由
  `ActivityLapAnalysis.laps[].roleSource`（`device` / `inferred`）区分。
  结构自证：`warmup` 恒在索引 0、`cooldown` 恒在末段（9/9 完美）。
- `hr_zone_boundaries` / `power_zone_boundaries` / `devices` / `workout_steps` /
  `route_cells` / `route_bounds` 均为 **JSON 字符串**，需自行 `JSON.parse`。
- `workout_steps` 是**多步**课表（真实库 120/285 条 > 1 步，最多 21 步）。
  `duration_sec` 已从 FIT 原始**毫秒**换算为**秒**；`target_pace_sec_per_km`
  已从 FIT 原始 **mm/s** 换算为**秒/公里**，且 `fast` 恒为更小的数值。
  `target_low/high` 保留设备原始值，**仅用于追溯，不要直接当配速用**。
  旧库（回填前）的 `duration_sec` 仍是毫秒、没有 `target_pace_sec_per_km` ——
  读取端请走 `app/lib/workout.ts`（`parseWorkoutSteps` / `workoutTargetRange`），
  它按「是否有 `duration_type_label`」判别代际并自行换算。
- `time_in_hr_zone` 是**唯一可用于统计**的心率区间数组（5 元素，见 §9「区间时长的唯一口径」）；
  `device_time_in_hr_zone` 是设备原始数组，**不要跨活动相加**。
- `time_in_power_zone` 同理是**唯一可用于统计**的功率区间数组（5 元素，本地 %FTP 口径，
  由逐秒功率推导，真实库 241/241 覆盖）；`device_time_in_power_zone` 是设备原始数组
  （绝对瓦数边界，实测 16 套方案随 FTP 变化），**不要跨活动相加**。
- `track`（约 40KB 的降采样多段线）**不在此接口返回**，见下文说明。
- 不存在的活动返回 404，`id` 非法返回 400。

---

### 4. 获取活动分段数据

获取活动的分段（Laps）数据。**分段不等于公里**：`lap_index` 是 0 基存储键，展示序号
由有序列表位置 +1 推导（`app/lib/lap-label.ts`）；真实库跑步 lap 只有 57.8% 落在
950–1050 m，时间切段的间歇课可以是 0.08 km。

**请求**

```http
GET /api/activities/{id}/laps
```

**路径参数**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `id` | number | 是 | 活动 ID |

**响应示例**

```json
{
  "activity_id": 14234567890,
  "laps": [
    {
      "id": 1,
      "activity_id": 14234567890,
      "lap_index": 0,
      "duration": 300,
      "cumulative_time": 300,
      "moving_time": 300,
      "distance": 1000,
      "average_pace": 300,
      "average_speed": 12.0,
      "average_heart_rate": 145,
      "max_heart_rate": 152,
      "average_cadence": 168,
      "total_ascent": 15,
      "total_descent": 10
    }
  ]
}
```

> `distance` 为**米**；`duration` 是经过时间（含暂停），`moving_time` 是计时器时间，
> **`average_pace` 的时间基数是 `moving_time`**。活动不存在返回 404；`id` 非法返回 400。
> 分段也可能为空数组（非跑步活动或数据源未提供 laps）。

---

### 5. 获取活动记录点数据

获取活动的逐秒记录（Records），包含心率、步频、步幅、配速、海拔、温度等。

**请求**

```http
GET /api/activities/{id}/records
```

**路径参数**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `id` | number | 是 | 活动 ID |

> **无分页参数**：一次返回该活动的全部记录（长距离活动可达上万条）。数据量较大时
> 建议前端按需渲染；若只要轨迹轮廓，用 MCP `get_activity_track`（已降采样）。

**响应示例**

```json
{
  "activity_id": 14234567890,
  "records": [
    {
      "activity_id": 14234567890,
      "record_index": 0,
      "elapsed_sec": 0,
      "heart_rate": 140,
      "cadence": 165,
      "step_length": 0.95,
      "pace": 330,
      "power": 250,
      "altitude": 50.2,
      "temperature": 24.5,
      "speed": 10.9,
      "distance": 0.0
    }
  ]
}
```

**单位**（易错）：`distance` 为**公里**（累计距离），`speed` 为 **km/h**，
`altitude` 米、`temperature` °C、`pace` 秒/公里、`elapsed_sec` 秒。
无记录的活动返回 `records: []`；真正的 DB 读取失败返回 500（不再伪装成 200 空数组）。

> **路线轨迹 (track) 不经此 REST 接口返回**: track 是降采样的 GPS 多段线 + 海拔剖面 + 包围盒
> (~40KB/条 JSON), 仅活动详情页经 SSR (`getActivityTrack`) 渲染离线路线图, 室内/跑步机为
> `null`。AI 客户端可经 MCP 工具 `get_activity_track` 取得 (见 [MCP Server 设计](mcp-design.md));
> 年度每日里程同理, 经 MCP `get_daily_distances` 或首页 SSR 取得, 无 REST 端点。

---

## 统计相关 API

### 6. 获取统计数据

获取**跑步口径**的汇总统计（只统计 `running` / `track_running` / `treadmill_running`，
见 [统计口径](#统计口径跑步-vs-全类型)）。

**请求**

```http
GET /api/stats?period=week
```

**查询参数**

| 参数 | 类型 | 必填 | 说明 | 示例 |
|------|------|------|------|------|
| `period` | string | 否 | `week` / `month` / `year` / `total`；不传等价于 `total` | `month` |

`week` 为 ISO 周（周一起）；`month`/`year` 按本地日历。非法值返回 400。

**响应示例**（真实生产库 `total`）

```json
{
  "totalActivities": 241,
  "totalDistance": 2140439.11,
  "totalDuration": 775004,
  "averagePace": 368.63,
  "averageHeartRate": 146.57,
  "totalAscent": 7660,
  "averageVDOT": 39.35,
  "averageCadence": 177.68,
  "averageStrideLength": 0.946,
  "totalTrainingLoad": 17600
}
```

**字段说明**

| 字段 | 类型 | 说明 | 单位 |
|------|------|------|------|
| `totalActivities` | number | 跑步次数 | 次 |
| `totalDistance` | number | 总距离（**米**；DB 存公里，接口 ×1000） | m |
| `totalDuration` | number | 总时长（**计时器时间** `moving_time` 累加，不是经过时间） | 秒 |
| `averagePace` | number? | 平均配速 = **Σ计时器时间 / Σ距离**（不是 `AVG(average_pace)`：那是「各次配速的平均」，只在距离相同时才成立）。恒等于 `totalDuration / (totalDistance/1000)`，可被用户验算 | 秒/公里 |
| `averageHeartRate` | number? | 平均心率 = **Σ(心率×计时器时间)/Σ计时器时间**（时间加权；等权平均会让一次 12 分钟间歇与一次 2 小时长距离等权，真实库近 7 天差 4.8bpm） | bpm |
| `totalAscent` | number? | 总爬升 | m |
| `averageVDOT` | number? | 区间平均跑力 = 本区间全部跑步样本的**算术平均**（刻意不按距离/时间加权：VDOT 是估计值不是速率，长距离跑的 VDOT 天然偏低，加权会压低「当前跑力」）。与 `insight.vdot.mean` 同一口径 | - |
| `averageCadence` | number? | 平均步频 = Σ(步频×时间)/Σ时间（速率量必须按时间加权；真实库近 7 天等权 177.0 vs 加权 181.4） | spm |
| `averageStrideLength` | number? | 平均步幅 = **Σ距离 / Σ步数**（步数 = 距离/步幅），不是各次步幅的平均 | m |
| `totalTrainingLoad` | number? | 训练负荷总和 | - |

---

### 7. 获取个人记录

获取不同距离的个人最佳成绩（PB），**跑步口径**。

**请求**

```http
GET /api/stats/personal-records?period=total
```

**查询参数**

| 参数 | 类型 | 必填 | 说明 | 示例 |
|------|------|------|------|------|
| `period` | string | 否 | `week` / `month` / `year` / `total` / `6months`，默认 `total` | `6months` |

> `6months` 用「6 个月前同一天（超出取该月最后一天）」定位，避免 7/31 → 3/2 的月末溢出。

**响应示例**（真实生产库 `total`）

```json
{
  "period": "total",
  "startDate": "1970-01-01",
  "endDate": "2026-10-27",
  "records": [
    { "distanceLabel": "1.6公里最佳成绩", "durationSeconds": 389, "achievedAt": "2025-11-15T11:17:59.000Z" },
    { "distanceLabel": "3公里最佳成绩", "durationSeconds": 736, "achievedAt": "2025-11-15T11:17:59.000Z" },
    { "distanceLabel": "5公里最佳成绩", "durationSeconds": 1229, "achievedAt": "2025-11-15T11:17:59.000Z" },
    { "distanceLabel": "10公里最佳成绩", "durationSeconds": 2751, "achievedAt": "2026-10-18T00:01:20.000Z" },
    { "distanceLabel": "半程马拉松最佳成绩", "durationSeconds": 6189, "achievedAt": "2026-03-15T00:01:05.000Z" },
    { "distanceLabel": "全程马拉松最佳成绩", "durationSeconds": null, "achievedAt": null }
  ],
  "longestRunMeters": 21745.61,
  "longestRunDate": "2026-02-22T08:59:41.000Z"
}
```

**计算规则**：单条活动距离 ≥ 目标距离时，优先用 `activity_laps` 跨段插值出目标距离用时
（更精确）；无分段则按距离比例换算。`durationSeconds = null` 表示区间内没有足够长的跑步。

---

### 8. 获取 VDOT 历史

获取有 VDOT 值的跑步活动历史（**跑步口径**，倒序）。

**请求**

```http
GET /api/vdot?limit=50
```

**查询参数**

| 参数 | 类型 | 必填 | 说明 | 示例 |
|------|------|------|------|------|
| `limit` | number | 否 | 返回条数，默认 50（1–500） | `24` |

**响应示例**（真实生产库）

```json
{
  "data": [
    { "activity_id": 653862644, "start_time": "2026-10-22T11:07:11.000Z", "vdot_value": 39.4, "distance": 15060.87, "duration": 5063 },
    { "activity_id": 652123224, "start_time": "2026-10-18T00:01:20.000Z", "vdot_value": 44, "distance": 10111.17, "duration": 2780 },
    { "activity_id": 650375691, "start_time": "2026-10-13T10:25:04.000Z", "vdot_value": 42, "distance": 8306.73, "duration": 3018 }
  ],
  "count": 3
}
```

> `distance` 为**米**（DB 存公里，接口 ×1000）。只有 Z3+ 代表性强度段能算出 VDOT 的
> 活动才出现，日常轻松/恢复跑为 `null` 故不在此列表。

---

## 分析相关 API

### 9. 心率区间分析

按周/月聚合各心率区间（Z1–Z5）的**跑步**活动次数、时长、距离与平均配速/步频/步幅。
聚合粒度为 `activity_laps`（每个分段按平均心率归入一个区间），**跑步口径**。

**请求**

```http
GET /api/analysis/hr-zones?startDate=2026-09-01&endDate=2026-10-31&groupBy=month
```

**查询参数**

| 参数 | 类型 | 必填 | 说明 | 示例 |
|------|------|------|------|------|
| `startDate` | string | 否 | 起始本地日期 (YYYY-MM-DD) | `2026-09-01` |
| `endDate` | string | 否 | 结束本地日期 (YYYY-MM-DD) | `2026-10-31` |
| `groupBy` | string | 否 | `week` / `month`，默认 `month` | `week` |

`startDate > endDate` 或 `groupBy` 非法返回 400。

**响应示例**（真实生产库，节选）

```json
{
  "data": [
    { "period": "2026-09", "period_type": "month", "hr_zone": 1, "activity_count": 15,
      "total_duration": 15492, "total_distance": 32526.62, "avg_pace": 509.11,
      "avg_cadence": 156.86, "avg_stride_length": 0.886, "avg_heart_rate": 124.79 },
    { "period": "2026-09", "period_type": "month", "hr_zone": 2, "activity_count": 20,
      "total_duration": 42164, "total_distance": 111277.42, "avg_pace": 369.74,
      "avg_cadence": 181.67, "avg_stride_length": 0.893, "avg_heart_rate": 140.92 },
    { "period": "2026-09", "period_type": "month", "hr_zone": 3, "activity_count": 9,
      "total_duration": 9934, "total_distance": 28279, "avg_pace": 341.06,
      "avg_cadence": 172.62, "avg_stride_length": 0.963, "avg_heart_rate": 159.06 }
  ],
  "zoneRanges": {
    "1": { "min": 0, "max": 132 }, "2": { "min": 133, "max": 151 },
    "3": { "min": 152, "max": 164 }, "4": { "min": 165, "max": 176 },
    "5": { "min": 177, "max": 190 }
  },
  "summary": {
    "total_activities": 34,
    "total_periods": 1,
    "date_range": { "start": "2026-09-01", "end": "2026-10-31" }
  },
  "groupBy": "month"
}
```

> `activity_count` 是**该区间内的分段数**去重后的活动数，逐区间相加会重复计数
> （同一活动可能横跨多个心率区间），`summary.total_activities` 也是这个相加值 ——
> 只适合做「样本量」参考，不能当成独立活动总数。
> `avg_pace` **恒等于同一行的 `total_duration / (total_distance/1000)`** —— 三个数字并排展示，用户可直接相除验算（真实库旧的逐 lap 加权均值在 Z1 行给 406.0，而该行自身总量是 388.1，差 18 s/km）。
> `avg_cadence` / `avg_stride_length` / `avg_heart_rate` 按 lap **计时器时长**加权。
> 三张区间表的分母各不相同：心率 = 最大心率、配速 = 当前 VDOT、功率 = **各活动自身 FTP**；
> AI 教练在 `surface=analysis` 时会额外收到【区间结构】块（配速/功率区间的时长分布与明细），
> 其余界面不注入。

**心率区间定义**（`app/lib/hr-zones.ts`，基于最大心率百分比，`MAX_HR` 环境变量或默认 190）

| 区间 | 心率范围 | 训练目的 |
|------|----------|----------|
| Zone 1 | ≤ 70% MaxHR | 有氧基础，恢复跑 |
| Zone 2 | 70–80% | 有氧耐力 |
| Zone 3 | 80–87% | 乳酸阈值，节奏跑 |
| Zone 4 | 87–93% | 无氧耐力，间歇跑 |
| Zone 5 | > 93% | 最大摄氧量，冲刺 |

### 区间时长的唯一口径（`activities.time_in_hr_zone` / `time_in_power_zone`）

`time_in_hr_zone` 存的是**上述 5 区模型**下各区间停留秒数（JSON 数组，长度恒为 5），
由 `activity_records` 的**逐秒心率**推导，覆盖全部活动（真实库 348/348）。

> **为什么不用设备原始数组**：FIT `time_in_zone` 消息里的 `time_in_hr_zone` 只有
> 140/348 条活动有值，且区间边界随固件/用户设置变化 —— 实测生产库出现 **19 套**
> 不同方案（`50/60/70/80/90/100%`、`52/62/72/82/92%`、`59/73/82/87/92%` of maxHR）。
> 数组索引 2 在一套里是「70–80%」在另一套里是「73–82%」，**按索引跨活动相加得到的
> 「Z3 占比」没有物理含义**。设备原始数组保留在 `device_time_in_hr_zone` 仅供追溯，
> 任何统计/展示都不应读取它。
>
> 推导的可靠性：推导总秒数与 `moving_time` 偏差 <10% 的活动占 241/241（跑步）与
> 107/107（非跑步）；暂停空档按 `HR_SAMPLE_MAX_GAP_SEC = 5s` 截断，避免暂停时间
> 被算进最后一个区间。历史活动用 `npm run backfill:hr-zones` 回填（幂等，只重算
> `time_in_hr_zone`，并把旧设备数组迁入 `device_time_in_hr_zone`）。

**功率区间是同一个缺陷族的同构修复**。`time_in_power_zone` 同样存**本地 5 区
%FTP 模型**（`app/lib/power-zones.ts`：Z1<65% / Z2<80% / Z3<90% / Z4<100% /
Z5≥100%），JSON 数组长度恒为 5，由 `activity_records` 的**逐秒功率**推导，
覆盖 **241/241** 条有功率的活动（全部跑步；107 条非跑步逐秒功率 0/107）。

> 设备原始数组只有 **33/348** 有值，且是**绝对瓦数**上限 —— 实测 **16 套**方案随 FTP
> 变化（`[218,267,307,338,390,4000,…]` 与 `[229,282,318,353,406,…]`），按索引相加的
> 「Z3 秒数」没有物理含义。归一成 %FTP 后 **241/241 只有一套**：65/80/90/100/115，
> 第 4 个上界即 100% = FTP。app 的 5 区取前 4 个边界，**把设备 Z5(100–115%) 与
> Z6(>115%) 合并进 Z5**（UI 只有 `--z1..--z5` 五个配色 token）；实测 33 条有设备数组的
> 活动里 **32/33** 逐槽偏差 <5 个百分点。设备原始数组保留在
> `device_time_in_power_zone` 仅供追溯。历史活动用 `npm run backfill:power-zones`
> 回填（幂等，先 `ALTER` 再迁移再重算，避免设备数组被覆盖）。

---

### 10. 配速区间分析

按当前跑力 VDOT 把 `activity_laps` 归入 Z1–Z5 配速区间并聚合（**跑步口径**）。

**请求**

```http
GET /api/analysis/pace-zones?startDate=2026-09-01&endDate=2026-10-31&vdot=39.35
```

**查询参数**

| 参数 | 类型 | 必填 | 说明 | 示例 |
|------|------|------|------|------|
| `startDate` | string | **是** | 起始本地日期 (YYYY-MM-DD) | `2026-09-01` |
| `endDate` | string | **是** | 结束本地日期 (YYYY-MM-DD) | `2026-10-31` |
| `vdot` | number | 否 | 跑力值（1–100）；不传则用最新一次跑步的 VDOT | `39.35` |

**响应示例**（真实生产库，节选）

```json
{
  "data": [
    { "zone": 1, "target_pace_sec_per_km": 393.87, "pace_min_sec_per_km": 378.61,
      "pace_max_sec_per_km": 9999, "activity_count": 35, "total_duration": 49255,
      "total_distance": 107360.57, "avg_pace": 520.43, "avg_cadence": 171.64,
      "avg_stride_length": 0.782, "avg_heart_rate": 136.09 },
    { "zone": 2, "target_pace_sec_per_km": 363.35, "pace_min_sec_per_km": 348.75,
      "pace_max_sec_per_km": 378.61, "activity_count": 30, "total_duration": 47294,
      "total_distance": 130580.72, "avg_pace": 362.35, "avg_cadence": 187.83,
      "avg_stride_length": 0.873, "avg_heart_rate": 139.16 }
  ]
}
```

> Z1 的 `pace_max_sec_per_km` 为 9999 表示「比下限更慢都算 Z1」（含热身/恢复慢段）。
> 区间边界由 `app/lib/vdot-pace.ts` 的 `getPaceZoneBoundsFromVdot` 从 VDOT 推导。

---

### 10.5 功率区间分析

按 **%FTP 五区**（Z1<65% / Z2<80% / Z3<90% / Z4<100% / Z5≥100%）聚合分段（laps）
的时长/距离/次数/平均功率/心率/步频/步幅（**跑步口径**）。

**请求**

```http
GET /api/analysis/power-zones?startDate=2026-01-01&endDate=2026-12-31
```

**查询参数**

| 参数 | 类型 | 必填 | 说明 | 示例 |
|------|------|------|------|------|
| `startDate` | string | **是** | 起始本地日期 (YYYY-MM-DD) | `2026-01-01` |
| `endDate` | string | **是** | 结束本地日期 (YYYY-MM-DD) | `2026-12-31` |

> 与 `/api/analysis/hr-zones` 不同，本端点**不接受空日期**：功率区间聚合要给出参与
> 活动的 FTP 中位数作为参照，跨多年会把不同阶段的 FTP 混在一起。缺参/格式错/起止
> 颠倒一律 400。

**响应字段**

| 字段 | 类型 | 说明 |
|------|------|------|
| `zones` | `PowerZoneStat[]` | 恒为 5 个（Z1–Z5），空区间为 0/null |
| `zones[].zone` / `zone_name` | number / string | 区间序号与语义名（如 `Z2(耐力)`） |
| `zones[].activity_count` / `lap_count` | number | 去重活动数 / 参与聚合的 lap 数 |
| `zones[].total_duration` | number | 秒 |
| `zones[].total_distance` | number | **米**（lap 距离累加） |
| `zones[].avg_power` / `avg_heart_rate` / `avg_cadence` / `avg_stride_length` | number \| null | lap **计时器时长加权**均值（速率/强度量必须按停留时间加权） |
| `reference.ftp_median_watts` | number \| null | 参与活动 FTP 的中位数（**参照值，不是任何一次活动的 FTP**） |
| `reference.ftp_device_count` / `ftp_zone_boundary_count` | number | FTP 来源分布（设备显式 / 由 `power_zone_boundaries[3]` 回退） |
| `reference.activity_count` / `distinct_ftp_count` | number | 参与活动数 / 去重 FTP 值个数（说明为何不能按绝对瓦数聚合） |
| `reference.laps_without_ftp` | number | 因活动无 FTP 而被跳过的 lap 数 |
| `ranges` | array \| null | 由 `ftp_median_watts` 派生的瓦数范围表（下界 `ceil`）；参照为 null 时为 null |
| `boundsLabel` | string | 由 `POWER_ZONE_BOUNDS` 派生的口径说明（如 `Z1 <65% / Z2 <80% …`） |

**响应示例**（真实生产库，节选）

```json
{
  "zones": [
    { "zone": 1, "zone_name": "Z1(恢复)", "activity_count": 201, "lap_count": 563,
      "total_duration": 143368, "total_distance": 255082.4, "avg_power": 174.29,
      "avg_heart_rate": 129.61, "avg_cadence": 146.92, "avg_stride_length": 0.778 },
    { "zone": 2, "zone_name": "Z2(耐力)", "activity_count": 224, "lap_count": 1187,
      "total_duration": 361522, "total_distance": 998301.86, "avg_power": 259.59,
      "avg_heart_rate": 143.76, "avg_cadence": 183.87, "avg_stride_length": 0.906 }
  ],
  "reference": {
    "ftp_median_watts": 350, "ftp_device_count": 33, "ftp_zone_boundary_count": 208,
    "activity_count": 241, "distinct_ftp_count": 14, "laps_without_ftp": 0
  },
  "ranges": [
    { "zone": 1, "minW": 0, "maxW": 227 },
    { "zone": 2, "minW": 228, "maxW": 279 },
    { "zone": 3, "minW": 280, "maxW": 314 },
    { "zone": 4, "minW": 315, "maxW": 349 },
    { "zone": 5, "minW": 350, "maxW": null }
  ],
  "boundsLabel": "Z1 <65% / Z2 <80% / Z3 <90% / Z4 <100% / Z5 ≥100%"
}
```

> **为什么必须按 %FTP 聚合**：区间归属用**每个活动自己的 FTP**（真实库 241 条活动 14 个
> 不同值，338–379W）。按绝对瓦数分桶会让同一段 320W 在不同活动里落到不同区间，
> 跨活动相加的「Z3 时长」没有物理含义。`ranges` 是**参照 FTP** 的换算表，
> 不是所有活动通用的定义域 —— 消费方必须把它当作参照值展示。

---

### 11. VDOT 趋势分析

按周/月聚合 VDOT（**跑步口径**）。

**请求**

```http
GET /api/analysis/vdot-trend?startDate=2026-06-01&endDate=2026-10-31&groupBy=month
```

**查询参数**

| 参数 | 类型 | 必填 | 说明 | 示例 |
|------|------|------|------|------|
| `startDate` | string | 否 | 起始本地日期 | `2026-06-01` |
| `endDate` | string | 否 | 结束本地日期 | `2026-10-31` |
| `groupBy` | string | 否 | `week` / `month`，默认 `month` | `week` |

**响应示例**（真实生产库）

```json
{
  "data": [
    { "period": "2026-06", "period_type": "month", "avg_vdot": 39.84, "max_vdot": 44.3, "min_vdot": 33.1, "activity_count": 11, "total_distance": 96176.87, "total_duration": 34218 },
    { "period": "2026-07", "period_type": "month", "avg_vdot": 39.41, "max_vdot": 42.6, "min_vdot": 35, "activity_count": 7, "total_distance": 61357.1, "total_duration": 21829 },
    { "period": "2026-08", "period_type": "month", "avg_vdot": 39.19, "max_vdot": 41.6, "min_vdot": 35.7, "activity_count": 14, "total_distance": 132460.94, "total_duration": 47876 },
    { "period": "2026-09", "period_type": "month", "avg_vdot": 39.77, "max_vdot": 48, "min_vdot": 27.9, "activity_count": 10, "total_distance": 99186.17, "total_duration": 36658 },
    { "period": "2026-10", "period_type": "month", "avg_vdot": 41.4, "max_vdot": 44, "min_vdot": 39.4, "activity_count": 5, "total_distance": 65792.72, "total_duration": 22472 }
  ],
  "groupBy": "month",
  "count": 5
}
```

> `activity_count` 只统计**有 VDOT 值**的活动（Z3+ 代表性强度段），因此小于该期间总跑步次数。
> 移动平均 / 斜率 / 平台期判断不在接口内，由洞察层（`app/lib/insight.ts` 的 `computeVdotTrend`）计算。

---

## 洞察相关 API

洞察接口的核心特征：**不写任何缓存表**，所有指标在请求时由 `app/lib/insight*.ts` 读取 `activities` / `activity_laps` / `activity_records` 实时计算，因此数据同步入库后即刻生效。全部响应带 `Cache-Control: no-store`。

### 12. 训练洞察

动态生成指定时间窗内的全部训练洞察指标。

**请求**

```http
GET /api/insight?days=90
GET /api/insight?startDate=2026-06-01&endDate=2026-09-22
```

**查询参数**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `days` | number/string | 否 | 预设窗口，取值 7 / 30 / 90 / 180 / 365 / 0 (`all`)，默认 30；`0` = 全部历史 |
| `startDate` / `endDate` | string | 否 | 显式区间 `YYYY-MM-DD`（同时提供时优先于 `days`） |

**响应结构（`data`）**

| 字段 | 说明 |
|------|------|
| `range` | 实际计算区间 `{startDate, endDate}` |
| `activityCount` | 区间内**跑步**次数（非跑步活动不计，见 [统计口径](#统计口径跑步-vs-全类型)） |
| `vdot` | VDOT 趋势：`raw` 散点、`perMonth` 月聚合、`slopePer30d` 斜率、`plateau` 平台期 |
| `load` | 训练负荷：`weekly` 周聚合（`{week, km, tl, n, seconds, partial}`，`n` 为**跑步次数**，`partial` 表示该周被区间截断；只含与区间相交的周，零跑量周也出现）、`acute`/`chronic`/`chronicLoadDays`/`acwr`/`acwrTone`（`acwr` 在训练历史不足 28 天时为 `null`，`acwrTone` 相应为 `insufficient`）、`zDistribution` 强度分布 |
| `decoupling` | 有氧解耦：`points` 明细、`meanPct`、`trendPer30d` |
| `form` | 跑姿按月趋势（步频/步幅/触地/垂直振幅/垂直比） |
| `paceHr` | 配速-心率回归模型：`slope`/`intercept`/`r`/`predictions`/`thresholdPaceSecPerKm` |
| `categories` | 训练类别对比（阈值/间歇/长距离/节奏/VO₂max/轻松）。均配速 = **Σt/Σd**（不是各次配速的平均、也不是时长加权平均），均心率/步频 = 时间加权，有氧效率 = 速度/心率 |
| `weather` | 气温分档对比（心率/配速/效率） |
| `routes` | 常跑路线对比（次数/最佳/均值/配速趋势） |
| `periodization` | 周期化：周跑量/负荷/次数/CTL/ATL/TSB、峰值、增幅、波动；每周期带 `partial`（该周被所选区间截断）、`peakWeek`（`{week, km}`，与 `peakWeekKm` 同源，UI 不得自行取 max）、`statsBasis`（`complete` 只用完整周 / `all` 区间不足 2 个完整周时退化为全部周）、`statsWeekCount`。`ctl/atl/tsb` 为期末值，预热 `TRAINING_LOAD_WARMUP_DAYS`（5τ=210 天）并以 `endDate` 为参考日（休息日也走 EWMA） |
| `findings` | 动态洞察建议数组：`{id, severity, title, detail, metric?, action?}` |

**响应示例（节选）**

```json
{
  "data": {
    "range": { "startDate": "2026-06-01", "endDate": "2026-09-22" },
    "activityCount": 125,
    "vdot": { "slopePer30d": 0.18, "latest": 41.2, "plateau": true, "perMonth": [] },
    "load": { "acwr": 0.99, "acwrTone": "optimal", "chronicLoadDays": 28, "lowIntensityPct": 3.5, "highIntensityPct": 45.2 },
    "findings": [
      { "id": "intensity-low", "severity": "warn", "title": "轻松跑占比偏低", "metric": "Z1–Z2 3.5%" }
    ]
  }
}
```

### 13. 全局 AI 综合教练

基于【跑者画像】与【全局洞察指标】的对话式综合教练，返回 SSE 流（OpenAI 兼容 `data:` 分片）。

**请求**

```http
POST /api/insight/coach
Content-Type: application/json

{ "model": "deepseek-flash-qd", "days": 30, "surface": "insight" }
{ "model": "deepseek-flash-qd", "startDate": "2026-10-01", "endDate": "2026-10-29", "surface": "stats" }
{ "model": "deepseek-flash-qd", "days": 0, "question": "我的短板是什么？", "history": [] }
```

**这是「统计类」接口**，与 `POST /api/activities/:id/analysis`（单次活动）是两种能力，
提示词与数据都不同，互不替代。

| 字段 | 说明 |
|------|------|
| `days` | 7 / 30 / 90 / 180 / 365 / 0（`0` 或 `all` = 全部历史），非法值回落 30 |
| `startDate` / `endDate` | **显式区间，页面必须传**：教练分析的时间窗必须等于页面显示的时间窗（统计页是自然周/月/年，与滚动 `days` 不是同一个窗口） |
| `surface` | `dashboard` / `insight` / `analysis` / `stats` —— 决定用哪套统计类提示词（职责、输出格式、篇幅都不同）。非法值回落 `insight`（白名单，防止任意字符串注入提示词） |

| 界面 | `surface` | 提示词侧重 | 篇幅 |
|------|-----------|-----------|------|
| 首页 | `dashboard` | 当前状态快照 + 本周怎么练 | ≤700 字 |
| 洞察页 | `insight` | 区间综合诊断 + 周期化 + 2-4 周 + 3 个月（唯一允许做多月规划的界面） | ≤1800 字 |
| 分析页 | `analysis` | 强度结构 / CTL-ATL-TSB / ACWR / 区间配比 | ≤1200 字 |
| 统计页 | `stats` | 自然周期总量与纪录 + 数据口径陷阱 | ≤900 字 |

单次活动接口（`/api/activities/:id/analysis`）的提示词按运动类型分两套
（跑步 / 非跑步），并显式声明「不做跨多次活动的统计与周期化」，越界问题指向汇总页教练。
对于非「全部历史」区间，服务端会额外计算**上一等长区间**的跑量/跑步次数/时长/配速/跑力/负荷，
作为【区间环比】注入教练上下文（全部为**跑步口径**，非跑步活动不计入）；无上一区间活动或
`days=0` 时自动省略。

`model` 只接受白名单值（`app/lib/model-curation.ts`，共 11 项，与本机 opencode 的
freellm provider 一致 —— 详见[可用模型列表](#17-可用模型列表)）：默认 `deepseek-flash-qd`，
回退目标 `auto`；其余值在服务端清洗为默认模型。

> 默认模型是**实测可用**的那一个：2026-10-29 发现旧的 `deepseek-v4.1-flash-wb` 已返回
> `503 No candidate model has a configured, usable provider key`，每次分析都要先失败一次再回退
> `auto`（多一次往返 + UI 显示「已自动切换」）。

**响应头**

- `Content-Type: text/event-stream`
- 模型回退时附加 `X-Model-Fallback: 1` / `X-Model-Requested` / `X-Model-Used`
- 未配置凭证（缺 `FREELLMAPI_KEY`）时返回 `503`

### 14. 活动详情深挖

返回单次活动的分段角色分析、主课漂移、心率区间占比、逐秒解耦与同路线历史对比。

**请求**

```http
GET /api/activities/{id}/insight
```

**响应结构（`data`）**

| 字段 | 说明 |
|------|------|
| `running` | 是否跑步口径（`isRunningType(activity_type)`）。为 `false` 时服务端已把「配速派生」字段置空：`lapAnalysis.bestPaceSecPerKm` / `bestLapIndex` / `workAvgPaceSecPerKm` 与 `gradeAdjusted` 全为 `null`；客户端据此**整张卡片不渲染**而非显示 `--` |
| `lapAnalysis` | 分段角色（`warmup`/`work`/`recovery`/`cooldown`/`steady`）、主课段数/距离/均配速/心率漂移、最快段。跑步按**配速**识别强度段，非跑步改按**相对心率**（游泳 lap 常无 `average_pace`，用配速会让所有段落进 `steady`、永远识别不出主课） |
| `comparison` | 同路线（或同距离）对比：`basis`、`peers`、`rank` 配速排名、`paceDeltaSecPerKm`、`hrDeltaBpm` |
| `decouplingPct` | 逐秒有氧解耦（%） |
| `hrZoneBreakdown` | 心率区间占比 `{zone, seconds, pct}[]`（本地 5 区 × `MAX_HR`，由逐秒心率推导） |
| `powerZoneBreakdown` | 功率区间占比 `{zone, seconds, pct}[]`（本地 5 区 **%FTP**：Z1<65% / Z2<80% / Z3<90% / Z4<100% / Z5≥100%，由逐秒功率推导，覆盖 241/241 条有功率的活动）。只含非零区间；非跑步恒为 `[]` |
| `ftpWatts` | 功率区间的分母（瓦）。设备显式 `functional_threshold_power` 优先，缺失回退 `power_zone_boundaries[3]`；都取不到时为 `null`（此时 `powerZoneBreakdown` 为空，**不猜默认 FTP**） |
| `environment` | 环境可比性：本次/样本均温、爬升、同温档排名与配速/心率差（无数据时为 `null`） |
| `locationComparison` | 跨名称同位置对比：GPS 首点 ≤1.5km + 距离分档 + 轨迹形状校验；无 GPS/未迁移时为 `null` |
| `locationComparison.routeQuality` | 同路径几何质量：`verifiedPeers`（**有轨迹、真正参与校验**的同伴数，无轨迹的候选不计入）、`roadKm`（路面偏差中位数）、`maxRoadKm`（最差同伴）、`gridJaccard`（网格重合中位数）。未做形状校验时**显式返回 `null`**（不是缺键），客户端可直接按 `null` 分支渲染 |
| `gradeAdjusted` | 等价平路配速（Minetti 2002）：实际/等价配速、差值、爬升/公里。记录不足**或非跑步**时为 `null`（Minetti 是跑步步态模型，套在泳池/球类的「每公里时间」上会产出伪精确值） |
| `temperatureDrift` | 逐秒温度漂移：起止温度、差值、最小/最大（无逐秒温度为 `null`） |
| `comparison.label` | 路线对比含 `· 同起点` 表示已通过 GPS 首点校验；距离回退为 `±x% · a–bkm` |
| `comparison`（非跑步） | 恒为 `null`：非跑步不做配速横向对比（泳池 1670s/km 与跑步 270s/km 不可比）；`lapAnalysis` / `hrZoneBreakdown` / `decouplingPct` 等个人指标照常返回 |

---

## 深度分析 API

### 15. 活动 AI 深度分析（SSE 流式）

基于本次活动数据与【跑者画像】调用本机 freellm 网关生成教练点评，以 SSE 流式返回
（透传 OpenAI 兼容流）；多轮追问复用同一端点。

活动级上下文刻意偏向**当次 + 横向可比**（与汇总页的区间趋势相反）：

- 当次：分段角色/主课漂移/最快段/心率区间/逐秒解耦；
- 同路线/同名：以活动名称「地点前缀」为指纹的历史样本，按路线距离带过滤
  （`<5km ±35%` / `5–12km ±25%` / `>12km ±23%`），并用 GPS 首点做 ≤2km 同起点校验
  （无轨迹保留），含配速排名、组均/组最佳、心率差；
- 同距离：按距离分档独立查询（`<5km ±20%` / `5–12km ±10%` / `>12km ±8%`），
  与深挖面板同一容差；
- 同类训练：由名称 + 距离推断类别，样本 ≥2 才输出；
- 同位置：起点通道（GPS 首点 ≤1.5km）+ 网格通道（`route_cells` 网格 Jaccard + `route_km`
  长度比）并行召回，合并去重后按距离分档 + 轨迹形状相似度（阈值 0.55）精判，
  跨名称匹配同一路线（含「同一环线不同入口」）；
- 环境可比：同距离样本平均温度/爬升、本次与样本差值，以及同温档排名/配速差/心率差；
- 海拔修正：Minetti 2002 等价平路配速；温度漂移：逐秒温度起止差；
- 任一查询失败只降级对应段落，不阻塞 AI 主流程。
  实现：`app/lib/activity-coach-context.ts` + `activity-coach-context-service.ts`。

**非跑步活动走另一套 prompt**（`NON_RUNNING_SYSTEM_PROMPT`）：游泳/篮球/力量训练
不套用跑步教练框架（VDOT / 配速区间 / 步频步幅 / 触地平衡），改为综合体能教练 +
交叉训练视角，重点回答「本次负荷如何、对跑步是促进还是妨碍、下次跑步怎么安排」。
活动数据段对非跑步**整行不输出**配速/步频/步幅/触地/跑力行（分段改用时长），
避免模型把泳池的 1670 s/km 解读成「配速偏慢」。**游泳例外地补两行专属指标**：
「每 100m 配速: 2:22/100m」（`pace.paceSecPer100m` = `360 ÷ 速度(km/h)`，唯一实现）
与「划频: 44 次/分」（`average_cadence`，真实库 4/4 条游泳有值）—— 秒/100m 是游泳的
行业口径，秒/公里量级差 10 倍；划频是真实存在的字段，旧提示词误称「本数据源不提供」。
同时非跑步活动不做配速横向对比
（`paceComparable` 守卫），分段/心率区间等个人指标照常提供。

**非跑步的可比样本块也按同一口径收敛**（`activity-coach-context.ts`）：分段行
不输出「主课配速 / 最快分段」（泳池 1670s/km、乒乓球 30826s/km 不是配速），标题改为
「本次分段（按相对快慢划分, 不比配速）」；GAP 行整段省略；口径说明改为「非跑步活动：
不比较配速/步频/跑力，这些量的分母是「每公里」，对游泳/球类/力量训练没有可比语义」。
这里按 `insight.running` **再次把关**，而不是信任上游字段是否恰好为 `null` —— 任何
上游回填都不该把「每公里时间」当配速泄给模型。

**请求**

```http
POST /api/activities/{id}/analysis
Content-Type: application/json

{ "model": "deepseek-flash-qd" }
{ "model": "glm-5.3-flash-qd", "question": "我的短板是什么？", "history": [] }
```

| 字段 | 说明 |
|------|------|
| `model` | [可用模型列表](#17-可用模型列表) 里的白名单值；省略或非法值清洗为默认 `deepseek-flash-qd`，避免 400 `model_not_found` |
| `question` / `history` | 追问时必填（首轮不传） |

**行为**

- SSE `text/event-stream`，事件为 OpenAI 兼容 `data: {"choices":[{"delta":…}]}`；思考过程（若有）随
  `reasoning` 增量下发，前端折叠展示。
- 出流策略统一在 `app/lib/coach-stream.ts`：响应头 120s、**首字节 90s** 超时即中断并回退 `auto`；
  客户端断开向下游传播。
- 发生回退时响应头带 `X-Model-Fallback: 1` / `X-Model-Requested` / `X-Model-Used`
 （前端据此提示「已自动切换」）。
- 错误：`400` 无效 id、`404` 活动不存在、`5xx`/超时见 [错误处理](#错误处理)。模型白名单、看门狗
  与 A/B 依据见 `docs/insight.md` 与 `docs/faq.md` #17。

---

## 系统与模型 API

### 16. 健康检查

存活/就绪探针（2026-09-15 新增）；无任何探活端点时外部无法判断服务 + DB 是否健康。

**请求**

```http
GET /api/health          # 浅探活（进程存活即 200，不触 DB，供高频轮询）
GET /api/health?deep=1   # 深探活（校验 SQLite 可读）
```

**响应**

| 场景 | 状态码 | 结构 |
|------|--------|------|
| 浅探活 | 200 | `{ status, service, time, uptime_s }` |
| 深探活 · DB 可读 | 200 | 上述 + `{ db: "reachable", vdot_rows }` |
| 深探活 · DB 不可达 | 503 | `{ status: "degraded", db: "unreachable", ... }` |

### 17. 可用模型列表

**请求**

```http
GET /api/llm/models
```

**响应**

```json
{
  "models": [
    { "id": "deepseek-flash-qd", "name": "DeepSeek Flash (QD)", "series": "DeepSeek",
      "available": true, "thinking": true, "recommended": true }
  ],
  "configured": true
}
```

- 每项字段：`id` / `name` / `series` / `available` / `thinking` / `recommended`
 （默认项为 `true` —— 即 preset 内部的 `isDefault`，**对外字段名是 `recommended`**，
 见 `fetchModels`）。
- `models` 是**固定白名单**，**与本机 opencode 的 `providers.freellm.models` 逐项一致**
 （同集合、同顺序，即下拉顺序；`auto` 不出现，仅作服务端回退目标与旧客户端兼容）。
  单一来源：`app/lib/model-curation.ts`。**网关 `/models` 未列出 ≠ 不可用** —— 它是「当前可用」
  的过滤视图（365 条里只列 145 条），实测 `z.ai/glm-5.2-juzi` 未列出但 2.6s 正常返回、
  `hy3-wb` 未列出但返回 429（限流≠不存在）。因此「未列出」按**乐观可用**处理，只有网关
  **显式**返回 `available: false` 才置灰；网关不可达时同样乐观。

| 模型 id | 显示名 | 分组 | 思考 | 下发 `reasoning_effort: low` |

> 取值来自 2026-10-29/30 两次网关实测（同提示 A/B，见 `app/lib/model-curation.ts` 文件头）。
> 探测时不可用的 3 条（`deepseek-v4.1-flash-wb` / `space-bunny-wb` /
> `step-5-preview-wb`）为保守值。

| `deepseek-flash-qd` | DeepSeek Flash (QD) | DeepSeek | 🧠 | 是 |
| `deepseek-v4.1-flash-trae` | DeepSeek V4.1 Flash (Trae) | DeepSeek | 🧠 | 是 |
| `deepseek-v4.1-flash-wb` | DeepSeek V4.1 Flash (WB) | DeepSeek | — | 否 |
| `glm-5.3-flash-qd` | GLM 5.3 Flash (QD) | GLM | 🧠 | 是 |
| `glm-5.3-flash-trae` | GLM 5.3 Flash (Trae) | GLM | 🧠 | 否 |
| `mimo-v2.6-flash-trae` | MiMo V2.6 Flash (Trae) | MiMo | 🧠 | 是 |
| `minimax-m3.1-flash-qd` | MiniMax M3.1 (QD) | MiniMax | — | 否 |
| `minimax-m3.1-flash-trae` | MiniMax M3.1 (Trae) | MiniMax | 🧠 | 否 |
| `qwen3.8-flash-qd` | Qwen3.8 Flash (QD) | Qwen | 🧠 | 否 |
| `space-bunny-wb` | Space Bunny (WB) | Space Bunny | — | 否 |
| `step-5-preview-wb` | Step 5 Preview (WB) | Step | — | 否 |
- `configured`：`FREELLMAPI_KEY` / Base URL 是否就绪；未就绪时 `models` 可能为空，客户端仍可用默认模型。
- `Cache-Control: no-store`；异常返回 `500 { "error": ... }`。

---

## 错误处理

### 错误响应格式

所有错误响应遵循统一格式：

```json
{
  "error": "错误类型",
  "message": "详细错误信息",
  "code": 400
}
```

### HTTP 状态码

| 状态码 | 说明 | 示例 |
|--------|------|------|
| 200 | 成功 | 请求成功 |
| 400 | 请求错误 | 参数格式错误 |
| 404 | 未找到 | 活动不存在 |
| 500 | 服务器错误 | 数据库连接失败 |

### 常见错误

#### 1. 活动不存在

```json
{
  "error": "NotFound",
  "message": "Activity not found",
  "code": 404
}
```

#### 2. 参数错误

```json
{
  "error": "BadRequest",
  "message": "Invalid month format, expected YYYY-MM",
  "code": 400
}
```

#### 3. 数据库错误

```json
{
  "error": "InternalServerError",
  "message": "Database connection failed",
  "code": 500
}
```

---

## 数据类型说明

### 时间格式

- **ISO 8601**: `2026-02-13T06:30:00`
- **日期**: `2026-02-13`
- **月份**: `2026-02`

### 单位约定

⚠️ 距离单位**因接口而异**，这是最容易踩的坑：

| 场景 | 单位 | 示例 |
|------|------|------|
| `/api/activities`、`/api/activities/months` 的 `distance` / `totalDistance` | **公里 (km)**（DB 列原样） | `10.0` = 10 公里 |
| `/api/stats` 的 `totalDistance`、`/api/stats/personal-records` 的 `longestRunMeters` | **米 (m)** | `2140439` = 2140 公里 |
| `/api/vdot`、`/api/analysis/hr-zones`、`/api/analysis/pace-zones`、`/api/analysis/power-zones`、`/api/analysis/vdot-trend` 的 `distance` / `total_distance` | **米 (m)** | `10000` = 10 公里 |
| `/api/activities/{id}/laps` 的 `distance` | **米 (m)** | `1000` = 1 公里 |
| `activity_records.distance`（逐秒记录） | **公里 (km)** | `0.005` |
| `activity_records.speed` | **km/h** | `12.0` |
| `activities.average_speed` / `activities.max_speed` | **km/h**（同单位，别再乘 3.6） | `20.76` = 20.76 km/h |
| 时长 / 配速 | 秒 (s) / 秒每公里 (s/km) | `3000` / `300` = 5:00/km |
| 时长的时间基数 | **计时器时间 `moving_time`**（配速、`totalDuration`、区间表 `total_duration`、TSS、`training_load` 全部同基数） | `582132079` 的 `duration` 10465s / `moving_time` 2621s → 配速按 2621s 算 |
| 心率 / 步频 / 卡路里 | bpm / spm / kcal | `150` / `170` / `500` |
| `activities.total_cycles` / `activity_laps.total_cycles` | **计数（绝对计数，不是频率）；仅游泳/跳绳/爬楼的语义已确认** | `518` = 518 次划水（游泳）；`189` = 189 次跳跃（跳绳）；力量/室内有氧/HIIT/球类语义未确认，不要解读 |
| `activities.pool_length` | **米**（FIT scale=100 已应用） | `25` = 25m 池；不要再 ÷100 |
| `activities.workout_feel` | 无量纲，5 档 | `0 / 25 / 50 / 75 / 100`（0 = 很差，**有效值**） |
| `activities.workout_rpe` | 无量纲，Borg CR10 1–10 | `2` = 很轻松；`0` 不合法 |
| `activities.est_sweat_loss` | **毫升（设备估算）** | `1794` = 约 1794 ml（有 ~1000 ml/h 速率上限） |
| `activity_laps.intensity` | **设备记录的原始字符串**（不是角色枚举） | `warmup` / `interval` / `recovery` / `rest` / `cooldown` / `active`；角色映射走 `app/lib/lap-intensity.ts` |
| `activity_laps.swim_stroke` | **泳姿原始枚举**；**仅 lap 级有效** | `freestyle` / `backstroke` / `breaststroke` / `butterfly` / `drill` / `mixed` / `im`。`activities.swim_stroke` **恒 255（无效）**，不要读；`mixed` 是「这一段混合了多种泳姿」（真实取值，**不是未知**），但它构成未知 → **不要算每 100m 效率**；`im`/`drill` 同理。中文名与汇总走 `app/lib/swim-stroke.ts` |

换算速记：DB 的 `activities.distance` 是公里，`activity_laps.distance` 是米，
`activity_records.distance` 又是公里。聚合前务必按上表换算。

### 速度转配速

```javascript
// 速度 (m/s) 转配速 (s/km)
pace = 1000 / speed

// 示例: 3.33 m/s
pace = 1000 / 3.33 = 300 秒/公里 = 5:00 /km

// 注意: DB 里的 average_speed / max_speed 已经是 km/h, 不要当 m/s 用。
// 若要换算成配速: pace = 3600 / speedKmh
```

### 配速格式化

```javascript
// 秒数转配速字符串
function formatPace(seconds) {
  const minutes = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${minutes}:${secs.toString().padStart(2, '0')}`;
}

// 示例
formatPace(300); // "5:00"
formatPace(285); // "4:45"
```

---

## 使用示例

### JavaScript / TypeScript

```typescript
// 获取活动列表
const response = await fetch('/api/activities?month=2026-02&limit=20');
const data = await response.json();
console.log(data.activities);

// 获取活动详情
const activity = await fetch('/api/activities/14234567890');
const activityData = await activity.json();

// 获取 VDOT 趋势
const vdot = await fetch('/api/vdot?days=90');
const vdotData = await vdot.json();
```

### Python

```python
import requests

# 获取活动列表
response = requests.get('https://your-domain.vercel.app/api/activities', params={
    'month': '2026-02',
    'limit': 20
})
activities = response.json()['activities']

# 获取活动详情
activity_id = 14234567890
activity = requests.get(f'https://your-domain.vercel.app/api/activities/{activity_id}')
activity_data = activity.json()
```

### cURL

```bash
# 获取活动列表
curl "https://your-domain.vercel.app/api/activities?month=2026-02&limit=20"

# 获取活动详情
curl "https://your-domain.vercel.app/api/activities/14234567890"

# 获取 VDOT 趋势
curl "https://your-domain.vercel.app/api/vdot?days=90"
```

---

## 性能优化建议

1. **使用分页**: 避免一次性获取大量数据
2. **缓存数据**: 前端可缓存统计数据，减少 API 调用
3. **按需加载**: 记录点数据量大，建议按需加载或使用虚拟滚动（详情页已自动降采样）
4. **统计接口为实时计算**: 心率区间、VDOT 趋势查询时基于 laps 实时聚合，数据新即可见

---

## 下一步

- 查看 [部署指南](deployment.md) 了解如何部署 API
- 查看 [数据同步说明](data-sync.md) 了解数据来源
- 查看 [常见问题](faq.md) 获取更多帮助

---

如有其他问题，请在 [GitHub Issues](https://github.com/xuandao/pbRun/issues) 中提出。

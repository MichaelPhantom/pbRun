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
| **表现分析（只取跑步）** | `/api/stats`、`/api/stats/personal-records`、`/api/analysis/hr-zones`、`/api/analysis/pace-zones`、`/api/analysis/vdot-trend`、`/api/vdot`、`/api/insight`、`/api/insight/coach`、活动详情的可比样本 | 只统计 `running` / `track_running` / `treadmill_running`；配速、步频、心率区间、VDOT、个人纪录、训练负荷、同路线对比只在跑步内部可比 |
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
| `startDate` | string | 否 | 起始本地日期 (YYYY-MM-DD，含当日) | `2026-09-01` |
| `endDate` | string | 否 | 结束本地日期 (YYYY-MM-DD，含当日) | `2026-09-30` |

> `startDate > endDate` 返回 400。列表响应**不含** `track`（单条约 40KB），路线由活动详情接口单独提供。

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
| `sport_type` | string \| null | FIT sport 中文展示 (跑步/健身器械…) | - |
| `sub_sport_type` | string \| null | FIT sub_sport 中文展示 (路跑/跑步机/越野…) | - |
| `start_time` | string | 开始时间（UTC 绝对时刻） | - |
| `start_time_local` | string | 开始时间（本地墙钟，无时区标记） | - |
| `distance` | number | 总距离（**公里**，注意不是米） | km |
| `duration` | number | 总用时 | 秒 |
| `moving_time` | number | 移动时间 | 秒 |
| `average_pace` | number \| null | 平均配速（**非跑步类型不可作为跑步配速解读**） | 秒/公里 |
| `average_heart_rate` | number \| null | 平均心率 | bpm |
| `average_cadence` | number \| null | 平均步频（非跑步类型语义不同，如篮球 16） | spm |
| `vdot_value` | number \| null | VDOT 跑力值（仅跑步类型，Z3+ 代表性强度段才计） | - |
| `training_load` | number \| null | 训练负荷（优先 FIT 官方，缺省按时长×心率档回退） | - |
| `garmin_vo2max` | number \| null | Garmin 官方 VO2max | ml/kg/min |
| `recovery_time` | number \| null | 恢复时间 | 分钟 |
| `primary_benefit` | string \| null | 训练主要收益 | - |
| `hr_zone_boundaries` | string \| null | 心率区间上限边界 (JSON 数组) | bpm |
| `power_zone_boundaries` | string \| null | 功率区间上限边界 (JSON 数组) | 瓦 |
| `devices` | string \| null | 设备列表 (JSON 数组) | - |
| `user_weight` | number \| null | 体重 | kg |
| `user_height` | number \| null | 身高 | m |
| `resting_heart_rate_fit` | number \| null | 静息心率 | bpm |
| `workout_name` | string \| null | 课表名称 | - |
| `workout_steps` | string \| null | 课表步骤 (JSON 数组) | - |
| `hrv_rmssd` | number \| null | HRV RMSSD | ms |

---

### 2. 获取可用月份列表

按月汇总总距离与活动次数（**全类型口径**），用于 `/list` 页的月份折叠卡片。
`totalDistance` 为**公里**（与 `activities.distance` 一致）；「N 公里 / N 次」与展开后的
活动卡片严格一致（含非跑步活动）。

**请求**

```http
GET /api/activities/months?limit=6&offset=0
```

**查询参数**

| 参数 | 类型 | 必填 | 说明 | 示例 |
|------|------|------|------|------|
| `limit` | number | 否 | 返回月份数（1–100）。**不传则返回全部** | `6` |
| `offset` | number | 否 | 偏移量，默认 0 | `6` |

**响应示例**

```json
{
  "data": [
    { "monthKey": "2026-10", "totalDistance": 140.7707, "count": 17 },
    { "monthKey": "2026-09", "totalDistance": 200.84222, "count": 25 }
  ],
  "total": 26
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
  "workout_steps": "[{\"index\":0,\"name\":\"\",\"duration_type\":\"time\",\"duration_sec\":6840000,\"target_type\":\"speed\",\"target_low\":2888,\"target_high\":3250,\"intensity\":\"interval\"}]",
  "start_lat": 29.52873,
  "start_lng": 106.50725,
  "route_cells": "[\"wm5xzx2\",\"wm5xzx3\",\"wm5xzx6\"]",
  "route_bounds": "{\"minLat\":29.5277,\"maxLat\":29.5296,\"minLng\":106.5016,\"maxLng\":106.5035}",
  "route_km": 21.856
}
```

**字段要点**

- `distance` 为**公里**（`21.74561` = 21.7 公里），不是米。
- `average_speed` 为 **km/h**；`max_speed` 为 m/s（Garmin 原始口径）。
- `vdot_value` 仅在 Z3+ 代表性强度段计算，日常轻松/恢复跑为 `null`。
- `training_load` 优先 FIT 官方值，缺省按时长 × 心率档回退。
- `hr_zone_boundaries` / `power_zone_boundaries` / `devices` / `workout_steps` /
  `route_cells` / `route_bounds` 均为 **JSON 字符串**，需自行 `JSON.parse`。
- `track`（约 40KB 的降采样多段线）**不在此接口返回**，见下文说明。
- 不存在的活动返回 404，`id` 非法返回 400。

---

### 4. 获取活动分段数据

获取活动的分段（Laps）数据，通常按公里分段。

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
      "lap_index": 1,
      "duration": 300,
      "cumulative_time": 300,
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

> `distance` 为**米**。活动不存在返回 404；`id` 非法返回 400。分段也可能为空数组
> （非跑步活动或数据源未提供 laps）。

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
| `totalDuration` | number | 总时长 | 秒 |
| `averagePace` | number? | 平均配速（逐活动 `AVG`，非时长加权） | 秒/公里 |
| `averageHeartRate` | number? | 平均心率 | bpm |
| `totalAscent` | number? | 总爬升 | m |
| `averageVDOT` | number? | 平均 VDOT（仅 Z3+ 代表性强度段有值的活动参与） | - |
| `averageCadence` | number? | 平均步频 | spm |
| `averageStrideLength` | number? | 平均步幅 | m |
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
> `avg_pace` / `avg_cadence` 按 lap 时长加权。

**心率区间定义**（`app/lib/hr-zones.ts`，基于最大心率百分比，`MAX_HR` 环境变量或默认 190）

| 区间 | 心率范围 | 训练目的 |
|------|----------|----------|
| Zone 1 | ≤ 70% MaxHR | 有氧基础，恢复跑 |
| Zone 2 | 70–80% | 有氧耐力 |
| Zone 3 | 80–87% | 乳酸阈值，节奏跑 |
| Zone 4 | 87–93% | 无氧耐力，间歇跑 |
| Zone 5 | > 93% | 最大摄氧量，冲刺 |

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
| `load` | 训练负荷：`weekly` 周聚合、`acute`/`chronic`/`acwr`/`acwrTone`、`zDistribution` 强度分布 |
| `decoupling` | 有氧解耦：`points` 明细、`meanPct`、`trendPer30d` |
| `form` | 跑姿按月趋势（步频/步幅/触地/垂直振幅/垂直比） |
| `paceHr` | 配速-心率回归模型：`slope`/`intercept`/`r`/`predictions`/`thresholdPaceSecPerKm` |
| `categories` | 训练类别对比（阈值/间歇/长距离/节奏/VO₂max/轻松），含时长加权配速/心率与有氧效率 |
| `weather` | 气温分档对比（心率/配速/效率） |
| `routes` | 常跑路线对比（次数/最佳/均值/配速趋势） |
| `periodization` | 周期化：周跑量/负荷/CTL/ATL/TSB、峰值、增幅、波动 |
| `findings` | 动态洞察建议数组：`{id, severity, title, detail, metric?, action?}` |

**响应示例（节选）**

```json
{
  "data": {
    "range": { "startDate": "2026-06-01", "endDate": "2026-09-22" },
    "activityCount": 125,
    "vdot": { "slopePer30d": 0.18, "latest": 41.2, "plateau": true, "perMonth": [] },
    "load": { "acwr": 0.99, "acwrTone": "optimal", "lowIntensityPct": 3.5, "highIntensityPct": 45.2 },
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

{ "model": "deepseek-v4.1-flash-wb", "days": 30 }
{ "model": "deepseek-v4.1-flash-wb", "days": 0, "question": "我的短板是什么？", "history": [] }
```

`days` 支持 7 / 30 / 90 / 180 / 365 / 0（`0` 或 `all` = 全部历史），非法值回落 30；
页面入口：`/insight?days=`、`/analysis?days=`、`/stats?period=`（周→7 / 月→30 / 年→365 / 总→0）。
对于非「全部历史」区间，服务端会额外计算**上一等长区间**的跑量/次数/时长/配速/跑力/负荷，
作为【区间环比】注入教练上下文；无上一区间活动或 `days=0` 时自动省略。

`model` 只接受白名单值（`app/lib/model-curation.ts`）：默认
`deepseek-v4.1-flash-wb`，可选 `glm-5.3-flash` / `kimi-k3` /
`gemini-3.7-flash` / `gemini-3.5-flash-lite`，以及回退目标 `auto`；
其余值在服务端清洗为默认模型。

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
| `lapAnalysis` | 分段角色（`warmup`/`work`/`recovery`/`cooldown`/`steady`）、主课段数/距离/均配速/心率漂移、最快段 |
| `comparison` | 同路线（或同距离）对比：`basis`、`peers`、`rank` 配速排名、`paceDeltaSecPerKm`、`hrDeltaBpm` |
| `decouplingPct` | 逐秒有氧解耦（%） |
| `hrZoneBreakdown` | 心率区间占比 `{zone, seconds, pct}[]` |
| `environment` | 环境可比性：本次/样本均温、爬升、同温档排名与配速/心率差（无数据时为 `null`） |
| `locationComparison` | 跨名称同位置对比：GPS 首点 ≤1.5km + 距离分档 + 轨迹形状校验；无 GPS/未迁移时为 `null` |
| `locationComparison.routeQuality` | 同路径几何质量：`verifiedPeers`（**有轨迹、真正参与校验**的同伴数，无轨迹的候选不计入）、`roadKm`（路面偏差中位数）、`maxRoadKm`（最差同伴）、`gridJaccard`（网格重合中位数）。未做形状校验时**显式返回 `null`**（不是缺键），客户端可直接按 `null` 分支渲染 |
| `gradeAdjusted` | 等价平路配速（Minetti 2002）：实际/等价配速、差值、爬升/公里（记录不足为 `null`） |
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
避免模型把泳池的 1670 s/km 解读成「配速偏慢」。同时非跑步活动不做配速横向对比
（`paceComparable` 守卫），分段/心率区间等个人指标照常提供。

**请求**

```http
POST /api/activities/{id}/analysis
Content-Type: application/json

{ "model": "deepseek-v4.1-flash-wb" }
{ "model": "kimi-k3", "question": "我的短板是什么？", "history": [] }
```

| 字段 | 说明 |
|------|------|
| `model` | [可用模型列表](#17-可用模型列表) 里的白名单值；省略或非法值清洗为默认 `deepseek-v4.1-flash-wb`，避免 400 `model_not_found` |
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
    { "id": "deepseek-v4.1-flash-wb", "name": "DeepSeek V4.1 Flash", "series": "DeepSeek",
      "available": true, "thinking": false, "recommended": true }
  ],
  "configured": true
}
```

- 每项字段：`id` / `name` / `series` / `available` / `thinking` / `recommended`
 （默认项为 `true` —— 即 preset 内部的 `isDefault`，**对外字段名是 `recommended`**，
 见 `fetchModels`）。
- `models` 是**固定白名单**（默认 1 + 可选 4，顺序即下拉顺序；`auto` 不出现，仅作服务端回退目标与
  旧客户端兼容），由 `app/lib/model-curation.ts` 与网关 `/models` 对齐后返回；网关不可达时乐观
  视为可用（`available: true`）。
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
| `/api/vdot`、`/api/analysis/hr-zones`、`/api/analysis/pace-zones`、`/api/analysis/vdot-trend` 的 `distance` / `total_distance` | **米 (m)** | `10000` = 10 公里 |
| `/api/activities/{id}/laps` 的 `distance` | **米 (m)** | `1000` = 1 公里 |
| `activity_records.distance`（逐秒记录） | **公里 (km)** | `0.005` |
| `activity_records.speed` | **km/h** | `12.0` |
| 时长 / 配速 | 秒 (s) / 秒每公里 (s/km) | `3000` / `300` = 5:00/km |
| 心率 / 步频 / 卡路里 | bpm / spm / kcal | `150` / `170` / `500` |

换算速记：DB 的 `activities.distance` 是公里，`activity_laps.distance` 是米，
`activity_records.distance` 又是公里。聚合前务必按上表换算。

### 速度转配速

```javascript
// 速度 (m/s) 转配速 (s/km)
pace = 1000 / speed

// 示例: 3.33 m/s
pace = 1000 / 3.33 = 300 秒/公里 = 5:00 /km
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

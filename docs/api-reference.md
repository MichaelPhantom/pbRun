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
- [错误处理](#错误处理)

---

## 活动相关 API

### 1. 获取活动列表

获取所有跑步活动的列表，支持分页和按月份筛选。

**请求**

```http
GET /api/activities
```

**查询参数**

| 参数 | 类型 | 必填 | 说明 | 示例 |
|------|------|------|------|------|
| `month` | string | 否 | 按月份筛选 (格式: YYYY-MM) | `2026-02` |
| `limit` | number | 否 | 每页数量，默认 50 | `20` |
| `offset` | number | 否 | 偏移量，默认 0 | `0` |

**响应示例**

```json
{
  "activities": [
    {
      "activity_id": 14234567890,
      "activity_name": "晨跑 10K",
      "start_time": "2026-02-13T06:30:00",
      "sport": "跑步",
      "sub_sport": "路跑",
      "total_distance": 10000,
      "total_timer_time": 3000,
      "avg_speed": 3.33,
      "avg_heart_rate": 150,
      "avg_cadence": 170,
      "total_calories": 500,
      "vdot": 52.3
    }
  ],
  "total": 150,
  "limit": 50,
  "offset": 0
}
```

**字段说明**

| 字段 | 类型 | 说明 | 单位 |
|------|------|------|------|
| `activity_id` | number | 活动唯一 ID | - |
| `activity_name` | string | 活动名称 | - |
| `start_time` | string | 开始时间 (ISO 8601) | - |
| `sport` | string | 运动类型 | - |
| `sub_sport` | string | 子类型 (路跑/跑步机/越野等) | - |
| `total_distance` | number | 总距离 | 米 |
| `total_timer_time` | number | 总用时 | 秒 |
| `avg_speed` | number | 平均速度 | m/s |
| `avg_heart_rate` | number | 平均心率 | bpm |
| `avg_cadence` | number | 平均步频 | spm |
| `total_calories` | number | 总卡路里 | kcal |
| `vdot` | number | VDOT 跑力值 | - |

---

### 2. 获取可用月份列表

获取有数据的所有月份，用于月份选择器。

**请求**

```http
GET /api/activities/months
```

**响应示例**

```json
{
  "months": [
    { "month": "2026-02", "count": 18 },
    { "month": "2026-01", "count": 22 },
    { "month": "2025-12", "count": 20 }
  ]
}
```

---

### 3. 获取活动详情

获取单个活动的详细信息。

**请求**

```http
GET /api/activities/{id}
```

**路径参数**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `id` | number | 是 | 活动 ID |

**响应示例**

```json
{
  "activity_id": 14234567890,
  "activity_name": "晨跑 10K",
  "start_time": "2026-02-13T06:30:00",
  "sport": "跑步",
  "sub_sport": "路跑",
  "total_distance": 10000,
  "total_timer_time": 3000,
  "total_elapsed_time": 3010,
  "avg_speed": 3.33,
  "max_speed": 4.5,
  "avg_heart_rate": 150,
  "max_heart_rate": 175,
  "total_calories": 500,
  "avg_cadence": 170,
  "max_cadence": 185,
  "total_ascent": 120,
  "total_descent": 110,
  "avg_stride_length": 1.18,
  "training_effect": 3.5,
  "vdot": 52.3
}
```

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
  "laps": [
    {
      "lap_index": 1,
      "start_time": "2026-02-13T06:30:00",
      "total_distance": 1000,
      "total_timer_time": 300,
      "avg_speed": 3.33,
      "avg_heart_rate": 145,
      "avg_cadence": 168,
      "total_ascent": 15,
      "total_descent": 10
    },
    {
      "lap_index": 2,
      "start_time": "2026-02-13T06:35:00",
      "total_distance": 1000,
      "total_timer_time": 295,
      "avg_speed": 3.39,
      "avg_heart_rate": 150,
      "avg_cadence": 172,
      "total_ascent": 12,
      "total_descent": 8
    }
  ]
}
```

---

### 5. 获取活动记录点数据

获取活动的每秒记录点（Records）数据，包含 GPS、心率、配速等详细信息。

**请求**

```http
GET /api/activities/{id}/records
```

**路径参数**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `id` | number | 是 | 活动 ID |

**查询参数**

| 参数 | 类型 | 必填 | 说明 | 示例 |
|------|------|------|------|------|
| `limit` | number | 否 | 每页数量，默认 1000 | `500` |
| `offset` | number | 否 | 偏移量，默认 0 | `0` |

**响应示例**

```json
{
  "records": [
    {
      "timestamp": "2026-02-13T06:30:00",
      "distance": 10.5,
      "speed": 3.5,
      "heart_rate": 140,
      "cadence": 165,
      "altitude": 50.2,
      "position_lat": 39.9042,
      "position_long": 116.4074
    }
  ],
  "total": 3000,
  "limit": 1000,
  "offset": 0
}
```

**注意**: 记录点数据量较大，建议使用分页获取或前端按需加载。

> **路线轨迹 (track) 不经此 REST 接口返回**: track 是降采样的 GPS 多段线 + 海拔剖面 + 包围盒
> (~40KB/条 JSON), 仅活动详情页经 SSR (`getActivityTrack`) 渲染离线路线图, 室内/跑步机为
> `null`。AI 客户端可经 MCP 工具 `get_activity_track` 取得 (见 [MCP Server 设计](mcp-design.md));
> 年度每日里程同理, 经 MCP `get_daily_distances` 或首页 SSR 取得, 无 REST 端点。

---

## 统计相关 API

### 6. 获取统计数据

获取跑步统计数据，包括总里程、跑量、个人记录等。

**请求**

```http
GET /api/stats
```

**查询参数**

| 参数 | 类型 | 必填 | 说明 | 示例 |
|------|------|------|------|------|
| `year` | number | 否 | 按年份筛选 | `2026` |
| `month` | string | 否 | 按月份筛选 (格式: YYYY-MM) | `2026-02` |

**响应示例**

```json
{
  "summary": {
    "total_runs": 150,
    "total_distance": 1500000,
    "total_time": 450000,
    "total_calories": 75000,
    "avg_distance": 10000,
    "avg_pace": 300
  },
  "monthly": [
    {
      "month": "2026-02",
      "runs": 18,
      "distance": 180000,
      "time": 54000,
      "calories": 9000
    }
  ],
  "weekly": [
    {
      "week": "2026-W07",
      "runs": 4,
      "distance": 42000,
      "time": 12600
    }
  ]
}
```

---

### 7. 获取个人记录

获取不同距离的个人最佳成绩 (PB)。

**请求**

```http
GET /api/stats/personal-records
```

**响应示例**

```json
{
  "records": [
    {
      "distance": 5000,
      "time": 1200,
      "pace": 240,
      "date": "2026-01-15",
      "activity_id": 14200000000,
      "activity_name": "5K PB"
    },
    {
      "distance": 10000,
      "time": 2580,
      "pace": 258,
      "date": "2026-02-10",
      "activity_id": 14230000000,
      "activity_name": "10K 突破"
    },
    {
      "distance": 21097,
      "time": 5700,
      "pace": 270,
      "date": "2025-12-05",
      "activity_id": 14100000000,
      "activity_name": "半马 PB"
    }
  ]
}
```

---

### 8. 获取 VDOT 趋势

获取 VDOT 跑力值的历史趋势数据。

**请求**

```http
GET /api/vdot
```

**查询参数**

| 参数 | 类型 | 必填 | 说明 | 示例 |
|------|------|------|------|------|
| `days` | number | 否 | 最近 N 天，默认 30 | `90` |

**响应示例**

```json
{
  "trend": [
    {
      "date": "2026-02-13",
      "vdot": 52.3,
      "activity_id": 14234567890,
      "distance": 10000,
      "time": 3000
    },
    {
      "date": "2026-02-11",
      "vdot": 51.8,
      "activity_id": 14230000000,
      "distance": 8000,
      "time": 2520
    }
  ],
  "current": 52.3,
  "avg": 51.5,
  "max": 53.2,
  "min": 49.8
}
```

---

## 分析相关 API

### 9. 心率区间分析

获取心率区间分布数据，用于分析训练强度。

**请求**

```http
GET /api/analysis/hr-zones
```

**查询参数**

| 参数 | 类型 | 必填 | 说明 | 示例 |
|------|------|------|------|------|
| `month` | string | 否 | 按月份筛选 (格式: YYYY-MM) | `2026-02` |
| `activity_id` | number | 否 | 单个活动的心率区间 | `14234567890` |

**响应示例**

```json
{
  "zones": [
    {
      "zone": 1,
      "name": "有氧基础",
      "range": "120-140 bpm",
      "time": 3600,
      "percentage": 25.0
    },
    {
      "zone": 2,
      "name": "有氧耐力",
      "range": "140-160 bpm",
      "time": 7200,
      "percentage": 50.0
    },
    {
      "zone": 3,
      "name": "乳酸阈值",
      "range": "160-170 bpm",
      "time": 2880,
      "percentage": 20.0
    },
    {
      "zone": 4,
      "name": "无氧",
      "range": "170-180 bpm",
      "time": 720,
      "percentage": 5.0
    },
    {
      "zone": 5,
      "name": "最大",
      "range": "180+ bpm",
      "time": 0,
      "percentage": 0.0
    }
  ],
  "total_time": 14400
}
```

**心率区间定义** (基于最大心率和静息心率)

| 区间 | 心率储备百分比 | 训练目的 |
|------|----------------|----------|
| Zone 1 | 50-60% | 有氧基础，恢复跑 |
| Zone 2 | 60-70% | 有氧耐力，MAF 训练 |
| Zone 3 | 70-80% | 乳酸阈值，节奏跑 |
| Zone 4 | 80-90% | 无氧耐力，间歇跑 |
| Zone 5 | 90-100% | 最大摄氧量，冲刺 |

计算公式：

```
心率储备 (HRR) = MAX_HR - RESTING_HR
目标心率 = (HRR × 百分比) + RESTING_HR
```

---

### 10. 配速区间分析

获取配速分布数据，识别舒适配速区间。

**请求**

```http
GET /api/analysis/pace-zones
```

**查询参数**

| 参数 | 类型 | 必填 | 说明 | 示例 |
|------|------|------|------|------|
| `month` | string | 否 | 按月份筛选 (格式: YYYY-MM) | `2026-02` |

**响应示例**

```json
{
  "zones": [
    {
      "zone": "4:00-4:30",
      "count": 25,
      "percentage": 16.7,
      "avg_heart_rate": 155
    },
    {
      "zone": "4:30-5:00",
      "count": 60,
      "percentage": 40.0,
      "avg_heart_rate": 150
    },
    {
      "zone": "5:00-5:30",
      "count": 45,
      "percentage": 30.0,
      "avg_heart_rate": 145
    },
    {
      "zone": "5:30-6:00",
      "count": 20,
      "percentage": 13.3,
      "avg_heart_rate": 140
    }
  ],
  "total_activities": 150,
  "avg_pace": 285
}
```

---

### 11. VDOT 趋势分析

获取 VDOT 随时间的变化趋势，用于可视化训练效果。

**请求**

```http
GET /api/analysis/vdot-trend
```

**查询参数**

| 参数 | 类型 | 必填 | 说明 | 示例 |
|------|------|------|------|------|
| `days` | number | 否 | 最近 N 天，默认 90 | `180` |

**响应示例**

```json
{
  "trend": [
    {
      "date": "2026-02-13",
      "vdot": 52.3,
      "ma7": 51.8,
      "ma30": 51.2
    },
    {
      "date": "2026-02-11",
      "vdot": 51.8,
      "ma7": 51.5,
      "ma30": 51.0
    }
  ],
  "statistics": {
    "current": 52.3,
    "avg": 51.5,
    "max": 53.2,
    "min": 49.8,
    "trend": "up"
  }
}
```

**字段说明**

- `ma7`: 7 天移动平均值
- `ma30`: 30 天移动平均值
- `trend`: 趋势方向 (`up` / `down` / `stable`)

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

| 字段类型 | 单位 | 说明 |
|----------|------|------|
| 距离 | 米 (m) | 例如 10000 = 10 公里 |
| 时间 | 秒 (s) | 例如 3000 = 50 分钟 |
| 速度 | 米/秒 (m/s) | 例如 3.33 = 5:00 配速 |
| 配速 | 秒/公里 (s/km) | 例如 300 = 5:00 /km |
| 心率 | 次/分 (bpm) | 例如 150 bpm |
| 步频 | 步/分 (spm) | 例如 170 spm |
| 卡路里 | 千卡 (kcal) | 例如 500 kcal |

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

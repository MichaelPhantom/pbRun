# 数据同步说明

本文档详细介绍 Garmin 数据同步的原理、配置和使用方法。

## 目录

- [同步原理](#同步原理)
- [数据流程](#数据流程)
- [配置方法](#配置方法)
- [使用方法](#使用方法)
- [数据结构](#数据结构)
- [常见问题](#常见问题)

---

## 同步原理

### 数据来源

本项目支持三种 Garmin 数据获取方式，通过统一的数据源抽象层 (`scripts/garmin/sources/`) 实现，`sync.js` 无差别消费：

| 数据源 | 适用场景 | 依赖 | 环境变量 |
|--------|---------|------|---------|
| **`api`** | 国际区 Garmin Connect | OAuth Token (garth) | `GARMIN_SECRET_STRING` |
| **`local`** | 国区，已有 CDP 导出目录 | 本地 `fit/*.fit` + `activities.json` | `GARMIN_CN_EXPORT_DIR` |
| **`cdp`** | 国区，直连浏览器在线下载 | 已登录 garmin.cn 的 Chrome CDP | `GARMIN_CN_CDP` |

> 国际区与国区账号无法互通 API（国区 garminconnect 库不可用），故国区用户需使用 `local` 或 `cdp` 源。

#### 国际区 API (`api`)

从 **Garmin Connect 国际区** 同步运动数据。Garmin Connect 提供了以下数据：

1. **活动列表 API**: 获取所有活动的元数据（ID、日期、距离、时间等）
2. **FIT 文件 API**: 下载每个活动的原始 FIT 文件（包含详细的记录点数据）

#### 国区本地目录 (`local`，国区推荐)

读取 cft/garmin 管线 (`cn_export.py`) 已导出的目录，离线、幂等、零网络依赖：

```
<导出目录>/
├── fit/<activityId>.fit    # cn_export.py 下载的 FIT 文件
├── activities.json         # 活动元数据 (ID/名称/时间/类型)
└── state.json              # 断点状态 (done_ids + latest_start)
```

`cn_export.py` 通过 ZSXF 上已登录 garmin.cn 的 Chrome CDP，在浏览器上下文内 fetch `gc-api`（带 CSRF + cookie），绕过 Cloudflare 与 CSRF 校验。pbRun 直接复用其导出产物，职责分离：**导出归 cft/garmin，分析归 pbRun**。

#### 国区 CDP 直连 (`cdp`)

零依赖 Node CDP 客户端（Node >= 22 原生 `fetch` + `WebSocket`），直连已登录 garmin.cn 的 Chrome，实时拉取活动列表与下载 FIT。拓扑：

```
u2 (127.0.0.1:9995) ──反向隧道──► ZSXF (192.168.196.99:13923)
                                    └─ Chrome 已登录 garmin.cn
```

会话失效（重定向到 `sso.garmin.cn`）时，脚本会明确提示，需在 ZSXF 上运行 `cft/garmin/ws_login.py` 重登。

### FIT 文件格式

FIT (Flexible and Interoperable Data Transfer) 是 Garmin 设备使用的二进制数据格式，包含：

- **会话数据 (Session)**: 活动的汇总信息（总距离、总时间、平均心率等）
- **分段数据 (Laps)**: 按公里或手动分段的数据
- **记录点数据 (Records)**: 每秒或每隔几秒的详细数据（GPS、心率、配速等）

### 数据解析

项目使用 `fit-file-parser` 库解析 FIT 文件，提取以下 **28+ 字段**（含路线轨迹 `track`）：

> 另有 `_extractTrack` 单独产出 `track` 字段（降采样 GPS 多段线 + 海拔剖面 + 包围盒, JSON），存入 `activities.track` 列, 供详情页路线地图使用; 无 GPS 的室内活动为 NULL。

#### 活动级别字段

| 字段 | 说明 | 示例 |
|------|------|------|
| `activity_id` | 活动 ID | `14234567890` |
| `activity_name` | 活动名称 | `晨跑 10K` |
| `start_time` | 开始时间 | `2026-02-13 06:30:00` |
| `sport` | 运动类型 | `跑步` |
| `sub_sport` | 子类型 | `路跑` / `跑步机` / `越野` |
| `total_distance` | 总距离 (米) | `10000` |
| `total_timer_time` | 总用时 (秒) | `3000` |
| `total_elapsed_time` | 总经过时间 (秒) | `3010` |
| `avg_speed` | 平均速度 (m/s) | `3.33` |
| `max_speed` | 最大速度 (m/s) | `4.5` |
| `avg_heart_rate` | 平均心率 (bpm) | `150` |
| `max_heart_rate` | 最大心率 (bpm) | `175` |
| `total_calories` | 总卡路里 (kcal) | `500` |
| `avg_cadence` | 平均步频 (spm) | `170` |
| `max_cadence` | 最大步频 (spm) | `185` |
| `total_ascent` | 总爬升 (米) | `120` |
| `total_descent` | 总下降 (米) | `110` |
| `avg_stride_length` | 平均步幅 (米) | `1.18` |
| `training_effect` | 训练效果 | `3.5` |
| `vdot` | VDOT 跑力值 | `52.3` |

#### 分段级别字段

| 字段 | 说明 | 示例 |
|------|------|------|
| `lap_index` | 分段索引 | `1` |
| `start_time` | 分段开始时间 | `2026-02-13 06:30:00` |
| `total_distance` | 分段距离 (米) | `1000` |
| `total_timer_time` | 分段用时 (秒) | `300` |
| `avg_speed` | 平均速度 (m/s) | `3.33` |
| `avg_heart_rate` | 平均心率 (bpm) | `150` |
| `avg_cadence` | 平均步频 (spm) | `170` |
| `total_ascent` | 分段爬升 (米) | `15` |

### VDOT 计算

VDOT (V̇O2max) 是由 Jack Daniels 提出的跑力指标，基于跑步成绩和心率计算。

计算公式：

```
1. 计算速度 (m/min):
   velocity = distance (meters) / duration (minutes)

2. 计算 VO2max:
   VO2max = -4.60 + 0.182258 * velocity + 0.000104 * velocity²

3. 计算能量消耗比例:
   energy_percent = 0.8 + 0.1894393 * e^(-0.012778 * duration_minutes) + 0.2989558 * e^(-0.1932605 * duration_minutes)

4. 计算 VDOT:
   VDOT = VO2max / energy_percent

5. 代表性强度门控: 仅 Z3+（≥80% maxHR）的全力/阈值段才计入 VDOT，取最快 Z3+ lap 否则全程 Z3+；日常轻松/恢复跑为 null（纯 Daniels，不再做心率乘子修正；%VO2max clamp 至 [0.8,1.0]）
```

> 新口径已回填库：103/197 有 VDOT，均值 39.2（原 32.6）。详见 [VDOT 计算说明](vdot-calculation.md)。

---

## 数据流程

```
┌────────────────────────────────────────────────────────────────┐
│                        数据同步流程                              │
└────────────────────────────────────────────────────────────────┘

1. 获取活动列表
   ↓
   Garmin Connect API
   GET /activitylist-service/activities/search/activities
   ↓
   返回最近 N 条活动的元数据
   [{activityId, activityName, startTimeLocal, distance, ...}]

2. 下载 FIT 文件
   ↓
   对于每个活动，检查本地是否已存在
   ↓
   如果不存在，下载 FIT 文件
   GET /download-service/files/activity/{activityId}
   ↓
   保存到 .cache/fit/{activityId}.fit

3. 解析 FIT 文件
   ↓
   使用 fit-file-parser 解析 FIT 文件
   ↓
   提取 Session 数据 (活动汇总)
   提取 Lap 数据 (分段信息)
   提取 Record 数据 (记录点)

4. 计算 VDOT
   ↓
   根据距离、时间、心率计算 VDOT
   ↓
   支持心率校准 (基于 MAX_HR 和 RESTING_HR)

5. 存储到数据库
   ↓
   写入 activities 表 (活动汇总)
   写入 laps 表 (分段数据)
   写入 records 表 (记录点数据)
   ↓
   SQLite 数据库 (app/data/activities.db)

6. 提交到 Git
   ↓
   git add app/data/activities.db
   git commit -m "chore: update garmin data YYYY-MM-DD"
   git push
   ↓
   触发 Vercel 自动部署
```

---

## 配置方法

### 1. 获取 Garmin Token

**（可选）在 .env 中配置 Garmin 账号密码**，便于非交互获取 Token；不配置则运行脚本时会提示输入。

在项目根创建或编辑 `.env`，可先填写：

```bash
# Garmin 账号密码（供 get_garmin_token.py 使用）
GARMIN_EMAIL=your_garmin_email@example.com
GARMIN_PASSWORD=your_garmin_password
```

然后运行：

```bash
python3 scripts/get_garmin_token.py
```

脚本会从 .env 读取 `GARMIN_EMAIL` / `GARMIN_PASSWORD`（未配置时按提示输入），并输出 `GARMIN_SECRET_STRING`。

**原理**:

1. 使用 Garmin OAuth2 流程获取 OAuth1 和 OAuth2 令牌
2. 将令牌序列化为 Base64 编码的 JSON 字符串
3. 此 Token 可长期使用，除非密码更改

### 2. 配置环境变量

在 `.env` 中配置（含上一步获取的 Token）：

```bash
# Garmin 账号密码（供重新获取 Token 时使用）
GARMIN_EMAIL=your_garmin_email@example.com
GARMIN_PASSWORD=your_garmin_password

# Garmin 认证 Token（由上一步脚本输出）
GARMIN_SECRET_STRING="eyJhbGci...很长的字符串"

# 心率参数
MAX_HR=190        # 最大心率
RESTING_HR=55     # 静息心率
```

### 3. 配置 GitHub Secrets

在 GitHub 仓库的 **Settings > Secrets > Actions** 中添加：

- `GARMIN_EMAIL` — Garmin 登录邮箱（用于重新获取 Token 等）
- `GARMIN_PASSWORD` — Garmin 登录密码（用于重新获取 Token 等）
- `GARMIN_SECRET_STRING` — 上一步脚本输出的 Token，同步数据时使用
- `MAX_HR` — 最大心率（可选）
- `RESTING_HR` — 静息心率（可选）

---

## 使用方法

### 本地同步

#### 初次同步所有历史数据

```bash
npm run init:data
```

这会同步所有历史活动，并自动处理增量更新。

#### 手动同步

```bash
# 同步最近 10 条活动
node scripts/sync-garmin.js --limit 10

# 同步所有新活动 (增量同步)
node scripts/sync-garmin.js

# 强制重新解析所有活动
node scripts/sync-garmin.js --force
```

> 统计类分析（心率区间 / VDOT 趋势 / 配速区间）均为同步完成后实时计算，
> 无需预生成缓存；新数据同步后分析页即自动更新。

### GitHub Actions 自动同步

配置完成后，GitHub Actions 会：

- **每日自动运行** (UTC 00:00)
- **推送到 main 分支时运行** (排除仅 DB 变更)
- **支持手动触发** (Actions 页面点击 Run workflow)

同步完成后，会自动提交数据库并推送到 GitHub，触发 Vercel 重新部署。

### 国区每日 cron 同步 (u2 自部署, 推荐)

国区账号 (connect.garmin.cn) 无法走国际区 OAuth Token, 使用 [cft/garmin](https://github.com/MichaelPhantom/cft) 的 CDP 管线:

```bash
# u2 上 (一次性部署)
bash ~/project/cft/garmin/install_cron.sh     # 每日 12:30 增量同步

# 手动
bash ~/project/cft/garmin/sync_cn_daily.sh    # 幂等, 可重复跑
```

流程: `cn_export.py` (CDP 直连国区增量导出 fit, state.json 去重) → `sync.js --source local` (DB 去重) → 条件 git 提交 `activities.db`。会话过期时自动 `ws_login.py` 重登 (CSRF 刷新 + 重试), 无需人工。统计类分析为同步后实时计算, 无需缓存重建。详见 `cft/garmin/README.cn-daily-sync.md`。

---

## 数据结构

### 数据库表结构

#### activities 表

存储活动汇总数据。

```sql
CREATE TABLE activities (
  activity_id INTEGER PRIMARY KEY,
  activity_name TEXT,
  start_time TEXT,
  sport TEXT,
  sub_sport TEXT,
  total_distance REAL,
  total_timer_time REAL,
  total_elapsed_time REAL,
  avg_speed REAL,
  max_speed REAL,
  avg_heart_rate INTEGER,
  max_heart_rate INTEGER,
  total_calories INTEGER,
  avg_cadence INTEGER,
  max_cadence INTEGER,
  total_ascent REAL,
  total_descent REAL,
  avg_stride_length REAL,
  training_effect REAL,
  vdot REAL,
  track TEXT,  -- 降采样路线轨迹 JSON (coords/bounds/elev/n); 室内/跑步机为 NULL; 由 fit-parser._extractTrack 回填
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
```

> **track 列** (路线轨迹): 存降采样后的 GPS 多段线 + 海拔剖面 + 包围盒 (JSON, ~≤40KB/条)。
> 由 `scripts/garmin/fit-parser.js` 的 `_extractTrack` 在 FIT 解析时生成, 经 `upsertActivity` 动态列写入。
> 新活动随每日同步自动写入; 历史 310 条 FIT 用 `scripts/garmin/backfill-tracks.js` 一次性回填
> (读 `.cache/fit/{activity_id}`, 备份 DB + 幂等 + 无需重新鉴权)。查询: `db.getActivityTrack(id)`。

#### laps 表

存储分段数据。

```sql
CREATE TABLE laps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  activity_id INTEGER,
  lap_index INTEGER,
  start_time TEXT,
  total_distance REAL,
  total_timer_time REAL,
  avg_speed REAL,
  avg_heart_rate INTEGER,
  avg_cadence INTEGER,
  max_cadence INTEGER,
  total_ascent REAL,
  total_descent REAL,
  FOREIGN KEY (activity_id) REFERENCES activities(activity_id)
);
```

#### records 表

存储记录点数据（每秒或每几秒一条）。

```sql
CREATE TABLE records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  activity_id INTEGER,
  timestamp TEXT,
  distance REAL,
  speed REAL,
  heart_rate INTEGER,
  cadence INTEGER,
  altitude REAL,
  position_lat REAL,
  position_long REAL,
  FOREIGN KEY (activity_id) REFERENCES activities(activity_id)
);
```

#### 统计类分析（实时计算）

心率区间分布、VDOT 趋势、配速区间等统计**不依赖预计算缓存表**：
查询时由 `app/lib/db.ts` 基于 `activities` + `activity_laps` 实时聚合（周/月维度），
新数据同步入库后分析页即自动更新。历史版本的 `hr_zone_stats_cache` / `vdot_trend_cache`
缓存表已废弃，不再读写。

---

## 常见问题

### Q1: 同步失败，提示 "Garmin authentication failed"

**原因**: Token 过期或配置错误。

**解决方案**:

```bash
# 重新获取 Token
python3 scripts/get_garmin_token.py

# 更新 .env 和 GitHub Secrets
```

### Q2: 某些活动没有 VDOT 数据

**原因**: VDOT 计算需要距离 > 1000 米且心率数据有效。

**解决方案**:

- 确保 Garmin 设备在跑步时记录了心率数据
- 短距离活动 (<1000m) 不计算 VDOT

### Q3: 同步速度很慢

**原因**: 需要下载大量 FIT 文件。

**优化方案**:

- 首次同步使用 `--limit` 限制数量
- FIT 文件会缓存在 `.cache/fit/` 目录，避免重复下载
- GitHub Actions 每日增量同步，不会重复下载已有数据

### Q4: 数据库文件变大怎么办？

**方案**:

```bash
# 清理旧数据 (保留最近 1 年)
node scripts/db-manager.js --clean --keep-days 365

# 压缩数据库
node scripts/db-manager.js --vacuum
```

### Q5: 如何导出数据？

```bash
# 导出为 CSV
sqlite3 app/data/activities.db "SELECT * FROM activities" -csv > activities.csv

# 导出为 JSON
sqlite3 app/data/activities.db "SELECT json_group_array(json_object('id', activity_id, 'name', activity_name)) FROM activities" > activities.json
```

### Q6: 支持其他运动类型吗？

目前主要针对跑步进行优化，但理论上支持所有 Garmin 记录的运动类型。

可以在 `scripts/sync-garmin.js` 中修改过滤条件：

```javascript
// 当前仅同步跑步
const SPORT_FILTER = ['running'];

// 修改为支持多种运动
const SPORT_FILTER = ['running', 'cycling', 'swimming'];
```

---

## 下一步

- 查看 [部署指南](deployment.md) 了解如何部署到 Vercel
- 查看 [API 参考](api-reference.md) 了解如何使用 API
- 查看 [VDOT 计算说明](vdot-calculation.md) 了解跑力计算原理

---

如有其他问题，请在 [GitHub Issues](https://github.com/xuandao/pbRun/issues) 中提出。

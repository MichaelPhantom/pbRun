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
| 活动列表 | `/list` | `getMonthSummaries` / `getActivities`（月分页 + 筛选） | 每张卡片直达详情 AI 复盘 | ✅ |
| 活动详情 | `/pages/[id]` | `getActivityById/Laps/Records/Track` | 单次活动 AI（见 §2） | ✅ |
| 活动深挖 | `GET /api/activities/[id]/insight` | `activity-insight.ts`：分段角色 / 主课漂移 / 区间 / 解耦 / 同路线对比 / 环境可比性 | 作为活动 AI 的当次指标来源 | ✅ |
| 活动 AI 对话 | `POST /api/activities/[id]/analysis` | `llm.ts` + `coach-stream.ts` + `runner-profile.ts` + `activity-coach-context.ts` | 当次 + 同路线/同名 + 同距离 ±10% + 同类 | ✅ |
| 训练分析 | `/analysis?days=` | 心率区间 / 配速区间 / VDOT / CTL-ATL-TSB | 汇总 AI，跟随页面时间窗 | ✅ |
| 训练洞察 | `/insight?days=` | `insight.ts` / `insight-compare.ts` 实时聚合 + `findings` | 汇总 AI，跟随页面时间窗 | ✅ |
| 统计 | `/stats?period=` | `getStats` / `getPersonalRecords` | 汇总 AI，周/月/年/全部映射 | ✅ |
| 汇总 AI 对话 | `POST /api/insight/coach` | `insight-service.ts` → `formatInsightForCoach` | 区间指标 + 跑者画像 + 趋势 | ✅ |
| 模型目录 | `GET /api/llm/models` | `model-curation.ts` 固定白名单 | — | ✅ |
| MCP Server | `mcp-server/`（stdio） | 16 个 tools 复用 `app/lib/db.ts` 与活动深挖服务 | `get_activity_comparables` 直接返回当次可比 `contextText` | ✅ |
| 数据同步 | `scripts/garmin` / `scripts/strava` | FIT/GPX → SQLite，VDOT 计算 | — | ✅ |

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
- **同位置（跨名称）**：用 `start_lat/start_lng` 索引取 GPS 首点 ≤1.5km 候选，再做 Haversine
  精筛；随后用**轨迹形状相似度**（包围盒 IoU + 质心距离 + 双向最近点平均距离 + 长度比，
  阈值 0.55）剔除同起点但不同环线/折返方向的活动。即使名称不同，同一公园/田径场/起点
  的同类路线也能进入「同位置样本」。
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

**区间环比**（`period-comparison.ts`）：当前区间 vs **上一个等长区间**，输出跑量/次数/时长/
平均配速/平均跑力/训练负荷的绝对值与变化率。无上一区间活动时整段省略（不做虚假基线）；
`days=0`（全部历史）无「上一区间」，自动跳过。追问复用同一上下文
（`buildGlobalCoachFollowupMessages`），前端回传 history。

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

---

## 4. 已知边界与待办（按功能归类）

> 这里只记录**尚未满足的接口能力**，不按日期或开发轮次归档。

### 4.1 活动横向对比

- **位置/形状聚类仍有边界**：首点 ≤1.5km + 形状相似度 0.55 能剔除大部分异形路线，但
  极端 GPS 漂移、极短轨迹、同起点但配速差异极大的变体仍可能误判；下一步可加入轨迹
  geohash/网格签名与 DTW 形状距离。旧行未回填首点时走 JSON1 回退。
- **湿度/风/体感温度仍缺数据源**：Garmin 活动 FIT 通常没有 `weather_conditions` 消息，
  `average_temperature` 可用但湿度/风不可得；已实现**温度漂移**与**等价平路配速**，
  体感温度需接入外部天气 API（按 GPS+时间回查），当前不做伪估算。
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

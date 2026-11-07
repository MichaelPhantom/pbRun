# 常见问题 (FAQ)

> 本文档汇集本项目实际遇到的高频问题与排查结论, 按主题分类。

## 安装与构建

### 1. `npm install` 时 better-sqlite3 编译失败

- **现象**: 报错 `climits: No such file or directory` 或 node-gyp 编译失败
- **原因**: Node 版本过新/过旧, 或 macOS 缺少 Xcode Command Line Tools 的 SDK 路径
- **解决**:
  - macOS: `SDKROOT=$(xcrun --sdk macosx --show-sdk-path) npm install`
  - Linux: 升级 Node 到项目要求版本 (≥ 18) 后重试
  - 换用已编译的预构建包: 安装 `better-sqlite3` 前确保网络可达 GitHub Releases

### 2. `npm ci` 不安装 devDependencies, 导致 jest/tsc 缺失

- **现象**: `npm ci` 后 `node_modules/.bin/jest` 不存在
- **原因**: shell 全局导出了 `NODE_ENV=production`, npm 会跳过 devDependencies
- **解决**: `NODE_ENV=development npm ci` (安装后 NODE_ENV 恢复即可)

### 3. `next build` 失败, `/_global-error` prerender 报 `useContext` 为 null

- **现象**: `TypeError: Cannot read properties of null (reading 'useContext')`
- **原因**: 构建时设置了 `NODE_ENV=development` — Next.js 16 已知 bug
  (vercel/next.js 相关 issue), 会破坏 `/_global-error` 页面 prerender
- **解决**: 正常构建即可 — 不设 NODE_ENV 或 `NODE_ENV=production next build`
- **注意**: 代码本身无问题; 全量测试与生产构建均通过

## 数据与部署

### 4. `activities.db` 无法提交到 GitHub (超 100MB 限制)

- **现象**: `git push` 被拒, 提示文件超过 GitHub 单文件 100MB 上限
- **原因**: 数据量增长后 DB 超过限制 (本库约 33MB 时仍可, 超限后不可再入库)
- **解决**: 已 `git rm --cached` 移出版本控制并加入 `.gitignore`;
  本机由 `app/data/.backups/` 每日 gzip 备份 (保留 14 份)

### 5. 同步数据后网页上还是旧数据

- **原因**: 构建时静态预渲染 (SSR) 会把 DB 数据打进页面
- **解决**: 数据展示页面已全部改为 `force-dynamic` (SSR 每次请求实时查库),
  API 路由加 `Cache-Control: no-store`; 同步后无需 rebuild 即刻可见
- 确认: `next build` 输出中对应页面应显示 `ƒ (Dynamic)`

### 6. 国区 Garmin CDP 直连提示会话失效 / 重定向到 SSO 登录页

- **原因**: garmin.cn 登录会话过期, CDP 页面的 Cookie 失效
- **解决**: 在 ZSXF 上运行 `cft/garmin/ws_login.py` 重新登录,
  或触发 `sync_cn_to_global.sh` 自动重登后重试同步

### 7. Strava 同步报 401 Unauthorized

- **原因**: Refresh Token 过期或被撤销 (Strava OAuth token 有效期与权限变更)
- **解决**: 重新运行 `npm run auth:strava` 完成 OAuth 授权, 更新 `.env` 中
  `STRAVA_REFRESH_TOKEN`

### 8. 本机部署后访问 404 / 空白页

- **排查顺序**:
  1. 服务健康: `systemctl --user status pbRun.service`
  2. 端口监听: `ss -tlnp | grep 3996` (应只监听 127.0.0.1)
  3. 门户反代: 确认 Nginx 已配 `/pbrun/ → 127.0.0.1:3996` 且 basePath 一致
  4. 日志: `journalctl --user -u pbRun.service -n 50`

## 分析相关

### 9. VDOT 值波动很大 (如 25–38), 是否数据错误?

- **原因**: Garmin 对每节课独立计算 VDOT, 强度课 (间歇/冲刺) 若热身与组间
  休息计入用时, 单次 VDOT 会显著偏低; 长距离/节奏课偏高属正常
- **建议**: 看月度平均与趋势, 忽略单次波动; 高强度课用"运动时间"口径评估

### 10. 为什么配速和心率区间分析的数据与手表不一致?

- **差异来源**: 本项目心率区间基于 `MAX_HR` (默认 190, 生产 194) 与
  `RESTING_HR` (默认 55, 生产 46) 计算, 与 Garmin 默认区间划分不同;
  请在 `.env` 中按实际身体参数配置后再对比

### 11. AI 教练分析失败 / 输出被截断 / 距离显示 0.01km

- **现象 A（距离 0.0x km）**: 已修复（2026-09-13）——`app/lib/llm.ts` 曾把
  `activities.distance`（DB 单位：公里）又除以 1000。回归测试见
  `tests/unit/lib/llm.test.ts`。
- **现象 B（`*-juzi` 模型报上游错误 502）**: 本机网关 `jiutian` 渠道凭证缺失
  （u1 `~/.wbwild/cred/jiutian.json`）或上游抖动。前端现会提示切换模型；
  运维侧需续凭证（`push_cred`，约 5h TTL），见网关日志 `RuntimeError`。
- **现象 C（输出中途截断，`finish_reason=length`）**: 思考模型的 reasoning
  占用 `max_tokens` 同预算。本路由已将预算提到 4000（上游 shim 上限 8000）；
  治本方法是在下拉里选**非思考**或**下发 effort 后思考很少**的模型
  （2026-10-29 起默认 `deepseek-flash-qd`：下发 effort 后思考 517 字符、首字节 2.4s；
  `minimax-m3.1-flash-qd` 等非思考项也可）。
- **单位约定**（防复发）: `activities.distance` 为公里、`activity_laps.distance`
  为米；聚合函数在 `db.ts` 内统一转米后再返回。`Activity.distance` 的类型注释已更正。
- **思考模型怎么用（2026-09-13 落地, 2026-09-26 收敛为白名单）**: 能用，但
  `reasoning_effort: low` 必须**按模型精确下发**，而且**同一底模的不同渠道行为
  也不一致**：`glm-5.3-flash-qd` 下发后思考 3897→1917 字符（必需、29s→11s），
  `glm-5.3-flash-trae` 反而 1555→**3761** 字符（毒药），`qwen3.8-flash-qd`
  169→347（毒药），`deepseek-flash-qd` 1061→517（有利）。因此判定顺序是：
  先查 `app/lib/model-curation.ts` 白名单 preset（`thinking`/`effort` 为
  2026-10-29 对本机网关的逐模型 A/B 实测结论），未命中才回落 `isThinkingModel`
  启发式；`auto` 永不下发（路由目标不确定）。单测
  `tests/unit/lib/thinking.test.ts` 锁定映射。
- **分析质量优化（2026-09-13）**: 分段标签改累计距离区间（laps 含 709m 等
  非整公里段，K 序号曾误导模型）；prompt 在活动数据后追加【本次表现与可比样本】
  （当次分段/区间/解耦 + 同路线/同距离/同类横向排名，`app/lib/activity-coach-context.ts`，
  失败自动降级为空）；主模型 502/超时自动回退 auto 并在脚注明示（`X-Model-Fallback` 头）；
  模型下拉按推荐排序并标注思考模型。详见
  `tests/unit/lib/activity-coach-context.test.ts`。

### 12. AI 教练升级为「世界级教练 + 跑者画像 + 对话式」（2026-09-17）

- **提示词升级**: `app/lib/llm.ts` 的 system prompt 从「活动点评」升级为世界级精英
  教练（运动科学 + 实战执教 + 数据诊断），新增【因材施教原则】（以个人水平为参照
  系解读、判定训练性质与执行质量、数据与画像矛盾时给原因）与【分析深度要求】
  （强度性质/配速执行/心率漂移/跑步经济性/综合表现/与近期状态关系 逐项覆盖）。
- **跑者画像**: 新增 `app/lib/runner-profile.ts`，分析前汇总生涯跑量/次数/起始年份、
  个人纪录、VDOT 当前与 30 天趋势、近 7/28 天跑量、CTL/ATL/TSB、惯常步频心率、
  上次跑步等，注入 prompt 首部（取代旧 `coach-context` 简版近况块）。全部查询容错
  降级，失败不阻塞。
- **对话式交互**: `app/lib/components/ai/` 新增 `ThinkingBlock`（思考折叠，流式中
  自动展开、结束收起并显示用时）、`ModelSelector`（按系列分组可搜索）、
  `useStickToBottom`（流式自动滚底）、`useModelCatalog`（模型列表 + 选择持久化）。
  `AiAnalysis` 重构为对话线程：多轮追问（Enter 发送）、停止/继续、复制/重生成/
  更精炼/更深入/👍👎、追问草稿与结果本地缓存、`role=log` 直播区域。
- **模型策展**: 新增 `app/lib/model-curation.ts`，只保留各**具体模型系列最新 2 个
  版本**，剔除聚合器（auto/fusion/free-router…）、同底模多渠道夹具（-wb/-juzi/-qd/
  -trae）与代码/安全/视觉等专用模型。网关原 298 项 → 26 项。`auto` 仍作为默认
  （服务端路由择优），但不再出现在「具体模型」列表中。
- **测试**: `tests/unit/lib/{model-curation,runner-profile}.test.ts`、
  `tests/unit/components/ai-analysis.test.tsx`、`tests/unit/lib/llm.test.ts` 追问用例。

### 13. MCP Server / 同步脚本健壮性修复（2026-09-17）

- **MCP dist 陈旧会跑旧逻辑**: `mcp-server/dist/` 被 `.gitignore` 排除，`tsc` 产物
  不会自动更新。若修改了 `app/lib/db.ts` 等被 MCP 复用的模块，**必须**重新
  `npm run build:mcp`，否则 MCP 仍运行旧代码（曾导致 `get_vdot_history` 返回公里而
  非米、pace-zone 按 lap 计数）。CI（`test.yml`）已加入 `npm run build:mcp` 步骤。
- **Garmin token 刷新**: 修复 Authorization 写入位置（原设在 axios 顶层 defaults，
  刷新写 common → 旧 token 胜出，刷新形同 no-op）；刷新加互斥防并发用已轮换的
  refresh_token 互相失效。见 `tests/unit/garmin/client-token-refresh.test.js`。
- **DB 写入原子性**: `insertLaps`/`insertActivityRecords` 的 DELETE 与 INSERT 纳入
  同一事务，避免插入失败时原有数据被清空。见
  `tests/unit/common/db-manager-atomicity.test.js`。
- **CDP 会话失效**: 200-非-JSON（登录页）与 downloadFit 的 0/302/401/403 现在统一
  抛 `SESSION_FAIL_ERROR`，同步脚本据此中止并触发重登，而非静默"成功 0 条"。
  见 `tests/unit/garmin/cdp-session.test.js`。
- **MCP 工具**: `list_activities` 要求 `offset` 为 `limit` 整数倍（否则报错，避免
  静默丢记录）；`assertDateRange` 改为真实日历校验（拒绝 2026-02-30）；
  `downsampleRecords` 结果不超过 `maxPoints`。
- **格式化**: `formatPace` 修复秒数四舍五入到 60 的进位（不再出现 "5:60"）；
  `getPersonalRecords('6months')` 修复月末溢出（7/31 现正确回到 1/31）。

### 14. AI 教练「世界顶级水准」升级（2026-09-18）

- **提示词框架**: system prompt 升级为世界顶级运动科学专家框架（专业资质 +
  5 条核心原则 + 6 大分析框架逐项覆盖 + 结构化输出 + 写作纪律）。输出含
  📊总评 / 🎯性质判定 / 📈深度数据 / 💡亮点改进 / 🏃下次处方 / 📅长期方向。
- **跑者画像增强**: 新增周环比（本周 vs 上周跑量）、近 28 天强度分布
  （Z1-Z5 时长占比，用于判断 80/20 极化训练结构）、配速趋势（近 30 天 vs
  31-60 天均值对比）。见 `app/lib/runner-profile.ts`。
- **智能追问建议**: 分析完成后展示上下文相关的一键追问 chips（强度结构/心率
  漂移/恢复/技术/目标），见 `app/lib/components/ai/followup-suggestions.ts`。
  **非跑步活动不推「跑步技术（步频/步幅/跑姿）」与「PB/跑力目标」** —— 泳池游泳的
  `average_cadence` 是划水频次、篮球是移动步频，`vdotTrend` 是跑步跑力趋势；
  改推「这项训练和跑步计划如何搭配」。判定入口是 `AiAnalysis` 传入的
  `running: isRunningType(activity.activity_type)`。
- **模型策略**: 429 限流先等待冷却再回退 auto；429 错误文案可操作化。
- **结果呈现**: MarkdownLite 增强 — emoji 章节标题带品牌左边框、`---` 分割线、
  ✅/⚠️ 列表项去重项目符号。
- **实测**: 对真实活动，AI 准确识别被误标为「基础训练」的 5×1km 间歇课，引用
  用户 VDOT 45.8 与 PB，结合 TSB/周环比预警累积疲劳，分析垂直摆动/触地/步频，
  并依据强度分布（Z4 44% 严重失衡）给出 48 小时恢复与长期极化训练建议。

## 运维（本机生产）

### 15. `next build` / 大文件传输输出 `Killed`，但内存还很空闲

进程被**所在 systemd 单元的 cgroup 内存限额**杀掉（本机 `opencode.service`
仅 1.5 GiB），整机 OOM killer 根本不会介入，所以 `free -h` 看着完全正常。

```bash
journalctl -k --since "2 hours ago" | grep -i oom   # 看 oom_memcg= 指向谁
systemd-run --user --scope -- bash scripts/deploy-prod.sh   # 挪到无上限的 user.slice 跑
```

诊断细节与后台运行写法见 [运维手册 · 构建陷阱](ops.md#构建陷阱)。

### 16. 根分区 90%+，哪些能删？

可安全删：`.next/cache/`、`.next/dev/`、`coverage/`、`~/.npm`、`~/.cache/pip`、
`app/data/.backups/` 旧份（保留最近 3 份）。
**不能删**：`.cache/fit`（同步脚本读它）、`tests/fixtures/activities.db`（CI 夹具）、
`mcp-server/dist`、`app/data` 软链。完整白/黑名单与实测收益见
[运维手册 · 磁盘清理白名单](ops.md#磁盘清理白名单)。


## AI 教练模型与稳定性

### 17. 模型选择收敛为固定白名单 + 首字节看门狗（2026-09-26）

- **为什么改**: `model-curation.ts` 原来每轮从网关 298 项里自动策展（每系列最新
  2 版 → 26 项），列表随网关改名漂移，且混入夹具/专用模型；实测默认 `auto`
  与若干思考模型存在失败率高、输出截断、长提示不吐首字节等问题。
- **现在是什么（2026-11-05 调整）**: **与本机 opencode 的 `providers.freellm.models`
  逐项一致**的固定白名单（11 项，`MODEL_PRESETS`，顺序即下拉顺序）：
  - 默认 `deepseek-flash-qd`（实测 2.4s 首字节、1M 上下文、下发 effort 后思考 517 字符）
  - 其余 10 项：`deepseek-v4.1-flash-trae` / `deepseek-v4.1-flash-wb` /
    `glm-5.3-flash-qd` / `glm-5.3-flash-trae` / `mimo-v2.6-flash-trae` /
    `minimax-m3.1-flash-qd` / `minimax-m3.1-flash-trae` / `qwen3.8-flash-qd` /
    `space-bunny-wb` / `step-5-preview-wb`
  - `auto` 不进下拉，只作为**服务端回退目标**与旧客户端兼容值。
  - 旧默认 `deepseek-v4.1-flash-wb` **已失效**（网关返回 `503 No candidate model
    has a configured, usable provider key`），故默认改为 `deepseek-flash-qd`；
    `tests/unit/lib/model-curation.test.ts` 有回归守卫禁止把默认改回它。
  - 2026-11-05 剔除 4 个**已从网关目录消失**的模型（`deepseek/deepseek-v4-flash-juzi`、
    `glm-5.3-flash-wb`、`hy3-wb`、`z.ai/glm-5.2-juzi`，请求一律 404）—— 与限流/过载
    不同，目录除名不会恢复，留在白名单里会让老用户存的选择每次分析必失败；
    两侧（opencode.jsonc ↔ 白名单）同步剔除，旧 id 由 `resolveRequestedModel`
    清洗回默认模型。
- **服务端清洗**: `resolveRequestedModel` 只放行白名单候选 id 与 `auto`，其余
  （旧版本残留选择、拼写错误、越权传参）在打网关之前就清洗为默认模型，
  避免 400 `model_not_found`。见 `tests/unit/api/analysis-fallback.test.ts`。
- **首字节看门狗**: `app/lib/coach-stream.ts` 统一两条教练路由的出流策略——
  拿到响应头后 **90s** 内不吐第一段数据即中断主模型并改走 `auto`
  （实测 `kimi-k3` 完整提示下 150s+ 无首字节，干等 120s 必然超时）；
  响应头上限仍为 120s。5xx/429/不可达同样回退，4xx 不重试。
  覆盖见 `tests/unit/api/coach-stream.test.ts`。
- **前端**: `ModelSelector` 改扁平列表（默认徽标「默认」、🧠 思考标记、
  不可用置灰），`useModelCatalog` 把失效的旧选择迁移回默认模型。
- **改动前先实测**: 各模型是否思考、是否下发 effort 见
  `app/lib/model-curation.ts` 文件头表格；换模型前先对本机网关跑一次
  完整教练提示的 A/B（首字节时延、`finish_reason`、思考字符数）。

## 力量训练接入（2026-11）

### 18. 力量训练为什么单独算「第三套口径」，而不是并入跑步

- **现象**: 生产库 51 条 `strength_training` 一直「收录了但零分析语义」——不进训练负荷、
  没有结构化画像、UI 与 AI 都看不到。每周 2 次力量课对 ACWR/CTL/TSB 的贡献恒为 0。
- **为什么不能并进跑步口径**: `RUNNING_ACTIVITY_TYPES` 加一条，51 条零距离活动立刻污染
  全部表现分析 —— 实测均配速 369 → 989 s/km、心率 Z1 时长 698s → 91221s、
  配速区间 `activity_count` 凭空 +51。力量训练有**自己的语义**（组结构 + 训练效应），
  不是「跑得慢的跑步」。
- **所以分成三套显式口径**: 表现分析只取跑步（`runningTypeClause`）／活动日志含全类型
  （`getActivities`）／力量训练专属（`app/lib/strength.ts`）。**合并只发生在
  `getCombinedTrainingLoads` 这一个显式入口**，且只加 `load` —— `distance`/`duration`/
  `runs` 保持跑步原值（`duration` 会喂「当月均配速」，混入即污染）。
- **不做假数据**: 51 条本地 FIT 实测 `set`/`exercise_title` 消息数为 **0**，动作名/重量/
  次数只在 Garmin 云端 `exerciseSets`。故画像只输出真实可推导的四项（计划名 + 组结构 +
  时长/TE/恢复 + 强度域），**不做容量（组数×重量）指标**。

### 19. 这次踩到的六个坑（都可复现，都已钉成测试）

| # | 坑 | 症状 | 现在的守护 |
|---|----|------|-----------|
| 1 | **`totalLoad` 命名冲突覆盖力量负荷** | `AnalysisClient` 早期 `{...sum, totalLoad}` 把力量负荷覆盖成总负荷，卡片显示「力量负荷」却等于全部 | `analysis-page.test.tsx` 断言两字段分开 |
| 2 | **夹具缺 `runs` 让 `load>0` 判定合法化** | 首页「跑步天数」原用 `load>0`；合并后只有力量的日子 `load>0` 但 `runs=0` → 误算成跑步日 | 判定改 `runs>0`，`home-page.test.tsx` 有反向用例 |
| 3 | **文档交叉引用编号冲突** | 两处误指「§1.6」，而 §1.6 是力量训练，分段标签那节在 `testing-strategy.md` §6.5 | 已改指正确文件 |
| 4 | **洞察页漏接合并口径** | 首页/分析页/MCP 都改了，`insight-service.ts` 仍走 `getDailyLoads`（跑步口径）→ 同一时期洞察页 ACWR 1.40、首页 1.32，两张卡都自洽 | `insight-services.test.ts` 断言合并入口被调用、跑步口径入口**未**被调用 |
| 5 | **prompt 与新增数据矛盾** | 非跑步 prompt 仍写「非跑步不计算训练负荷，数据里也不会出现」，而力量课现在**有**派生负荷 → 模型只能违反指令或装看不见 | `coach-prompt-data-alignment.test.ts` 4 条反向断言 |
| 6 | **夹具比生产「干净」** | 夹具写整齐的 7×(40 做 + 20 歇) → 计划 420s / 结构「× 7」/ 工作:休息 2.0:1；生产实际是末段 `open` → **400s** / 「× 6 → 40s 连续」/ **2.3:1** | 夹具改为复刻真实 JSON，见 `testing-strategy.md` §6.5 纪律 6 |
| 7 | **FIT 循环控制步被当成训练段** | `repeat_until_steps_cmplt` 是「回跳到前面某步」的控制标记（无时长），旧实现按 `intensity='active'` 判工作段 → 3 条课表组数 7→**8**、「本月有效组数」虚高、结构描述多出 `? 连续` | `isRepeatControlStep` 前缀匹配排除 8 种 `repeat_until_*`；真实库工作段总数 352→**349** |

**最值得记住的一条**：坑 4 和坑 5 都是「改了一处、忘了另一处」，且**都不会报错**——
没有编译错误、没有测试变红，只有把两个页面并排看才发现数字不一致。这类缺陷只能靠
「**显式入口 + 漏接即断言**」来防：合并口径做成 `getCombinedTrainingLoads` 而不是在
`getTrainingLoads` 里原地改语义，就是为了让「谁走了合并口径」在代码里可见、可测。

### 20. 「记录」栏目只显示跑步类型 —— 三层根因（2026-11-07）

用户反馈「pbrun 的记录栏目还是只有跑步类型」。库里明明有 353 条活动、其中 120 条非跑步
（力量 51 / 爬楼 30 / 游泳 4 / 篮球 3 …），但打开 `/list` 只看到跑步。这是**三个独立缺陷
叠加**的结果，任何一个单独存在都会让页面「看起来只有跑步」：

| # | 根因 | 为什么隐蔽 | 现在的守护 |
|---|------|-----------|-----------|
| 1 | **类型下拉的选项由「已加载月份」推导** | 页面默认只预取最近 1 个月；2026-11 恰好只有 3 条跑步 → `Object.values(activitiesByMonth).flat()` 里只有 `running` → 下拉只剩「跑步」。数据在库里，筛选器把它藏了 | `getActivityTypes()` 查全库类型清单；`db-insight-integration.test.ts` 断言返回 `['running','lap_swimming']` 且带条数 |
| 2 | **筛选/搜索只在展开的那一个月内生效** | 用户选「力量训练」→ 当前月份没有力量课 → 显示「该月无匹配活动」。必须逐月点开才能找到，等于筛选没做 | 条件作为 SQL `WHERE` 进 `getMonthSummaries`（不匹配的月份直接不出现），首个匹配月自动展开并取数；3 条集成测试（type / q / 分页 total 随过滤变化）+ 1 条 UI 测试（自动展开会拉数据） |
| 3 | **零距离活动显示「0.00 公里」** | 97/353 条活动 `distance = 0`（力量 51、爬楼 30、室内有氧 9、HIIT/跳绳/室内骑行 7）。旧实现 `distance != null` 判定为真 → 卡片写「0.00 公里」，读起来像「这次只跑了 0 米」的异常数据，而实际是**该运动本来就没有距离语义** | `/list` 卡片、仪表盘 `RecentActivityCard`、详情页概览三处都区分 `null`（数据缺失 → `--`）与 `0`（无语义 → 不渲染）；各 1 条测试 |

**两个口径都要，一个都不能删**：月度头部的「N 公里」用 `runDistance`（只跑步），
「N 次」用 `count`（全类型，与展开后的卡片严格一致）。只留全类型 → 跑量虚高
（2026-08 全类型 199.60km vs 跑步 197.55km，差 2.05km 来自 1 条泳池游泳）；只留跑步
→ 「N 次」与卡片数不符（2026-09 会显示 3 次却列出 4 张卡）。所以同一行同时给
`runDistance`/`runCount` 与 `totalDistance`/`count`，另用「含 力量训练 2 · 爬楼 1」
徽标说明差额**并说出具体运动类型**（旧实现只写「含 N 次其他」，用户知道还有别的运动
但不知道是什么）。

**最值得记住的一条**：这三个缺陷**都不报错**。类型下拉少了选项不会抛异常，筛选无结果
会被当成「这个月确实没有力量课」，`0.00 公里` 会被当成真实数据。判断「某类数据是不
是不存在」时，必须验证**入口（下拉选项）的数据源是不是全库**，而不是看「当前视图里
有没有」—— 当前视图本身可能是被过滤后的结果。

#### 后续又挖出四处同源遗漏（同一天，同一根因）

修完上述三层后继续审计「还有哪些地方把非跑步藏起来」，发现四处**同类**缺陷，
共同点是「数据在库里，但某个入口/某条路径只认跑步或只认名称」：

| # | 位置 | 症状 | 修法 |
|---|------|------|------|
| 4 | **搜索只匹配活动名称** | 51 条力量课名称是「全身循环2」「跑前激活1」「核心稳定性1」，**没有「力量」二字**。用户想找力量课，最自然的输入「力量」一条都搜不到 | `getMonthSummaries` 的 `q` 改为「名称 LIKE **OR** 类型中文名精确 IN」（类型名是有限集合，用 `IN` 而非 `LIKE` 避免误命中）；本地即时过滤同步同口径，否则服务端返回该月、本地显示「无匹配」 |
| 5 | **`getActivities({type})` 用 `activity_type = ?`** | 空 `activity_type` 的行筛不出来 —— 下拉清单把空值归入 `running`（有选项），筛选 SQL 却匹配不到（空列表） | 改为 `COALESCE(NULLIF(activity_type,''),'running') = ?`，与下拉/月度筛选/UI 四处同一表达式 |
| 6 | **`runningTypeClause` 只写 `IN (...)`** | `isRunningType(null) === true`（旧库兼容），但 SQL 的 `IN` 排除 NULL/空串 → 同一判定在 JS 说「是跑步」、在 SQL 说「不是」，详情页显示跑步卡片、`/stats` 不统计它 | 改为 `(activity_type IN (...) OR activity_type IS NULL OR activity_type = '')`，覆盖 19 处跑步口径查询 |
| 7 | **AI prompt 写「距离: 0.00 km」** | 力量课 1 小时、距离 0 → prompt 里写「0.00 km」，模型按「几乎没动」解读，复盘里说「训练量极低」 | 距离三态进 prompt：`null` → `--`、`0` → `--（该运动无距离语义）`、`>0` → 正常里程 |
| 8 | **`type=all` 只在 months 端点被归一** | UI 的「所有类型」选项值是字面量 `all`。`/api/activities/months?type=all` 返回全部，`/api/activities?type=all` 却把 `all` 当类型键查 —— 生产库命中 0 条。用户选「所有类型」后月份列表正常、展开的卡片全部消失 | 归一收进 `db.normalizeTypeFilter` 单一来源（`all`/空串 → 不过滤），两个查询函数都经过它；Web 两个端点与 MCP 两个工具因此自动同语义。MCP description 也写明「`all` 或留空 = 不过滤」 |
| 9 | **搜索类型中文名大小写敏感** | 类型名是 `HIIT`（大写），用户习惯输入小写 `hiit`。SQL 的 `name LIKE` 对 ASCII 不区分大小写，但类型名路径用 JS `includes`（敏感）→ 小写输入命中 0 个类型键，3 条 HIIT 课搜不到。同一个搜索框，两种拼写一个有结果一个没有 | `matchingTypeKeys` 与 UI 本地过滤都改用 `toLowerCase()` 比较，与 `LIKE` 同语义 |
| 10 | **分段表距离列整列显示 `0.00`** | 爬楼 30 / 跳绳 3 / 室内骑行 1 / 室内有氧 1 共 35 个活动的 lap 距离全为 0 —— 该运动本来就没有距离语义。整列 `0.00` 对用户零信息量，还会被读成「每段只移动 0 米」。同一列的 `null`（未同步到）也被写成 `0.00`，把「缺失」说成「为零」 | 整组全 `0` → 整列不渲染；`null` → `--`；部分 `0` → 保留（游泳休息段/间歇恢复段是真实数据）。MCP `get_activity_laps` description 同步声明三态 |
| 11 | **按非跑步类型筛选时月度里程整块消失** | 月卡里程只取 `runDistance`，而筛选游泳/篮球/爬楼后 `runDistance` 恒为 0，`km > 0` 判定失败 → 里程块不渲染。用户主动选了「泳池游泳」，最想看的游泳里程反而看不到。真实库 `months?type=lap_swimming` 的 totalDistance 为 2.05 / 3.28 / 0.78km 而 runDistance 全 0 | 里程口径**跟着筛选走**：无筛选用 `runDistance`（防游泳混进跑量），有筛选用 `totalDistance`（此时它就是匹配活动的里程）。MCP `get_month_summaries` description 同步警告「筛选非跑步活动时 runDistance 恒为 0，不要读成这个月没运动」 |
| 12 | **「筛选」只认 `type`，漏了搜索词 `q`** | 修完缺陷 11 后判定写成 `typeFilter === 'all'`，搜索词不算筛选。真实库 `months?q=游泳` 的 totalDistance 是 2.05 / 3.28 / 0.78km 而 runDistance 全 0 —— 搜「游泳」后月卡只剩「1 次」，游泳里程整块消失。「含 N 次其他」同理：`months?q=力量` 每个月 count 2~7 / runCount 0，会渲染成「2 次 含 2 次其他」，而那两次**全都是**用户正在找的力量课 | 判定改为 `appliedFilter.type \|\| appliedFilter.q`，两处（里程口径、徽标）用**同一个条件**。另：口径读**已生效**的 `appliedFilter`（state）而非输入框即时值 —— 搜索防抖 300ms 内两者不同，用即时值会让里程在窗口期按新条件重算而数据仍是旧的 |
| 13 | **搜索词纯空白未被归一** | 与缺陷 8 同源（`type=all` 未归一），只是发生在另一个参数上：`getMonthSummaries` 写 `if (filter?.q)`，route 只做 `qRaw ? qRaw : undefined`（不 trim）。生产库实测 `months?q=%20`（一个空格）返回 **13 个月**，每月只剩名称里恰好带空格的 2~21 条活动 —— 真实库名称多为「两江新区 - 基础训练」，所以**看着像有结果**，实际是一个既非全部、也非空的静默错位集合，用户与模型都不会察觉筛选生效了。UI 侧 `ListClient.applyFilter` 自己 trim 过，所以缺陷只在直连 API / MCP 时显形 —— 而那正是 MCP 模型唯一的数据入口 | 新增 `db.normalizeQueryFilter`（纯空白 → `undefined`），与 `normalizeTypeFilter` 同一纪律、同一层。2 条测试：`q='' / ' ' / '\t'` 与不过滤结果逐月相等；`' 游泳 '` 仍能命中（归一不能吞掉真实搜索词） |
| 14 | **游泳每 100m 配速的换算公式写错** | 非跑步提示词写「由「平均速度」换算每 100m 配速（÷10 即秒/100m）」，**两处都错**：① `÷10` 只对**秒/公里**成立（100 m = 0.1 km），而数据块非跑步分支给的是 `average_speed`（km/h）—— 对 2.535 km/h 做 ÷10 得 **0.25**，模型会写成「每 100 米 0.25 秒」（等价 400 m/s）；② 即使方向对了，换算也跨两步：`3600 / 速度(km/h) / 10 = 360 / 速度`。真实库四条游泳：2.535 km/h → 142.0 s/100m（`2:22`）、1.336 → 269.4（`4:29`）、3.322 → 108.4（`1:48`）、1.602 → 224.7（`3:45`），与 `average_pace ÷ 10` 完全一致 | ① 数据块**直接给答案**：非跑步分支新增「每 100m 配速: 2:22/100m」行（仅游泳），换算收进 `pace.paceSecPer100m` + `formatPacePer100m` 唯一实现；② `sport.ts` 新增 `SWIMMING_ACTIVITY_TYPES` + `isSwimmingType`（与跑步口径同一「单一纯函数来源」纪律）；③ 提示词改为「直接用数据块里的那一行，不要自己换算」；④ 详情页概览、分段表、`/list` 卡片、首页「最近活动」四处补上秒/100m；⑤ MCP 三个活动日志工具 description 声明「`average_pace ÷ 10` 才是秒/100m，对 km/h 要 `360 ÷ 速度`」 |
| 15 | **提示词要求模型无视真实存在的字段** | 两处同源：① 非跑步 prompt 的数据纪律写「设备不写的字段（**划频**/划水次数、心率恢复速率、左右触地平衡）」，而真实库 **4/4** 条游泳活动都有 `average_cadence`（44/48/48/46 次/分，即划水频率）—— 模型拿得到却被要求「不要提」；② 同一 prompt 的核心原则第 3 条要求「游泳看每 100m 配速**与划频**」，两条自相矛盾。与「非跑步活动不计算训练负荷」完全同源（那次是力量负荷真实存在却被声明不存在） | ① 拆开两个概念：**划频可得**（数据块输出「划频: 44 次/分」）；② 数据纪律改为「设备不写的字段（心率恢复速率、左右触地平衡）」；③ 详情页概览补「划频（次/分）」格（旧 `running` 门控把「步频」整格藏掉，连划频也一起消失）；④ MCP `get_activity` / `get_activity_comparables` 声明「`average_cadence` 对游泳是划频不是步频」。**注**：当时把「总划水次数」留在了「不可得」一侧 —— 那是新的假话，见缺陷 21 |

| 16 | **数据块给了模型、详情页从不展示** | 缺陷 3 的反向缺口。第三类修完「prompt 要求 ⇒ 数据块供给」后，仍有字段**只到了模型、没到用户**：真实库 `max_heart_rate` 353/353、`total_training_effect` 353/353、`calories` 353/353、`primary_benefit` 353/353、`total_descent` 268/353、`garmin_vo2max` 238/246（跑步）、`normalized_power` 246/246 —— 概览一项都不渲染。用户在 AI 复盘里读到「训练效果 3.6、消耗 542 kcal」，回详情页找不到任何出处，无法判断模型是引用还是编造；更糟的是 `garmin_vo2max` 有值而本地 `vdot_value` 只有 122/246，**116 条跑步活动「即时跑力」显示 `--`，官方 VO2max 就躺在库里**。另：概览给了 IF 0.82 与 TSS 41，但 `IF = NP ÷ FTP` 的两个输入（NP、FTP）都不在页面上，用户无法自证 | 概览按**字段存在性**补齐 9 项：`最大心率`、`有氧训练效果`、`无氧训练效果`（`>0` 才渲染 —— 纯有氧课为 0 是常态，显示 `0.0` 像缺数据）、`热量`、`累计下降`、`训练收益`、`Garmin VO2max`（`running` 门禁；室内骑行那 1 条 55.0 是误写）、`FTP`、`标准化功率`。**`0` 与 `null` 不是一回事**：`null` 缺失才显示 `--`，`0` 表示该运动无此语义则整格不渲染。守护：`tests/unit/pages/activity-detail.test.tsx` 8 例（逐字段断言 / 无氧 TE=0 不渲染 / 缺 Garmin VO2max 仍给即时跑力 / 非跑步不渲染 Garmin VO2max / 非跑步不渲染 FTP·NP 整块 / IF·TSS 分子分母同屏 / 非跑步不渲染平均海拔·平均温度）。第二批补齐 `avg_altitude` 238/353、`average_temperature` 231/353（非跑步 0/107）与 `max_speed` 48/353（跑步 37；游泳/球类比值可达 85 倍，必须 running 门禁 + 「瞬时」标签）—— 两者数据块早已输出、页面零展示，且温度容易与深挖面板的「温度漂移」混淆，标签必须写「平均温度」 |

| 17 | **跑步口径内部的类型差异被吞掉** | 缺陷 1~16 都在问「非跑步有没有被藏起来」，没人问「跑步内部有没有被抹平」。跑步口径是**三个类型**（`running` / `track_running` / `treadmill_running`），三处徽标判定都写 `!isRunningType(...)` —— 后两者 `isRunningType === true`，于是被判为「普通路跑」，**真实库 13 条活动（田径场 6 + 跑步机 7）在详情页 / `/list` 卡片 / 首页最近活动上完全没有类型标识**。用户看不出这是操场绕圈还是跑步机。这不是「细节」：跑步机 `avg_altitude` / `total_ascent` / GPS 轨迹全为 NULL，配速不含风阻与坡度 —— 拿它对比路跑配速会误判「变快了」；田径场每圈 400m 配速可精确对标，混进路跑统计会稀释其精确性。合并做统计是对的（可比性），但**展示层必须保留区分** | `sport.needsTypeBadge()` 单一判定：非跑步恒 `true`，跑步里只有 `running` 为 `false`，空值 `false`（旧库兼容按跑步处理，但没有信息量）。三处徽标（详情页 / `/list` 卡片 / 首页 `RecentActivityCard`）全部改用它。守护：`tests/unit/lib/sport.test.ts`（13 类型逐条 + 与 `isRunningType` 的同源不变式）+ 详情页 3 例（田径场显示 / 跑步机显示 / 普通路跑不渲染）+ `/list` 2 例 + 首页卡片 2 例 |

| 18 | **消费守卫被「说明文字」骗过（守卫自身的缺陷）** | 前十七个缺陷都是「字段没到用户手上」。查它们靠的是 `insight-field-consumption.test.ts` 的机器守卫 —— 而这个守卫**只剥注释、不剥字符串**。于是 `mcp-server/tools.ts` 的 `get_activity` description 里写一句 `'devices(...)、user_weight/user_height/resting_heart_rate_fit(用户档案)、'` + `'hrv_rmssd(HRV 毫秒, 仅部分活动有)。'`，就把这 4 个字段全判成「已消费」。实测剥掉单/双引号后立刻显形：`hr_zone_boundaries` 353/353、`user_height` 352/353、`resting_heart_rate_fit` 210/353、`hrv_rmssd` 20/353，**UI 与 AI 数据块一次都没读过**。这是最危险的一类缺陷：守卫失效的方式恰好是「看起来在工作」，一旦被骗过，整个字段族都能安静地永不展示而全绿 | `isConsumed` 增加 `stripProseStrings()`（剥单/双引号字符串，**保留模板字面量** —— `db.ts` 的 SQL 列名在反引号里，剥掉会让真实消费误判为未消费）。守卫自身新增 3 条缺陷注入测试（说明文字不算消费 / 真正取值算消费 / 注释不算消费）。4 个字段写进 `ACTIVITY_FIELD_ALLOWLIST` 并写明「为什么不是单次训练指标」。**修好后立刻抓到第一个真实遗漏**：`VdotTrendFit.perMonth[].min`（月度最低 VDOT）算了但从未展示 —— 补进趋势图第三条序列 + AI 数据块「均/高/低」三值同行 |

| 19 | **`hrv_rmssd` 是伪指标，且已写进 MCP description 供模型引用** | 缺陷 18 挖出的 `hrv_rmssd` 不只是「没展示」，而是**算错了**。自证性检验：RMSSD = 相邻 RR 差值的均方根，**必然 ≤ 全程 RR 极差**。真实库 20 条里 **4 条物理不可能** —— `585811407`（163.59 ms vs 极差 108.3，比值 1.51）、`657456825`（154.64 / 113.9 = 1.36）、`573740964`（133.68 / 85.5 = 1.56）、`563735336`（128.67 / 107.7 = 1.19）。两个旁证：`RMSSD/meanRR` 中位数 **0.324**（运动中该 < 0.10），`r(平均心率, RMSSD) = +0.723`（生理上应为**负**相关）。根因：FIT `hrv.time` 是逐拍 RR 长度（不是时间戳），但设备**漏检心搏时会把 2~3 个真实间期合并成一条**（`0.725 ≈ 2 × 0.363`、`1.042 ≈ 3 × 0.347`），旧实现对合并值序列直接求相邻差，等于把每次漏拍当成巨大 RR 跳变。伪迹占比 5.7%–10.8%，却贡献了绝大部分方差 | `_extractHrv` 新增 `_splitMergedRr`：对每个 RR 取 ±31 拍**滑动窗口**中位数 `m`（滑动而非全局 —— 运动中 RR 会随强度从 0.34 漂到 0.46 s，全局基准会把漂移误判成倍频），若 `v ≈ k·m`（k∈[2,4]，容差 35%）拆成 k 个 `v/k`。新增 `hrv_rmssd_ratio`（`RMSSD/meanRR`，无量纲自证字段）。**修复后 20 条全量重算**：`ratio` 中位数 0.324 → **0.037**，范围 0.259–0.458 → **0.004–0.085**，物理不可能 4 → **0**，`r(HR, RMSSD)` +0.723 → **−0.254**（生理正确的负相关）。**纪律：修好不等于该展示** —— 覆盖仅 20/353（5.7%）、运动中 HRV 受呼吸/伪迹影响大，仍不进 UI/AI；Garmin 官方 HRV Status 是**隔夜**测量，不能用本值替代。守护：`fit-parser-branches.test.js` +4 例（漏拍合并必须拆分并对照未拆分的 >100ms / 3 倍漏拍 / 尾部 null 不得当 0ms / RMSSD 恒不超过 RR 极差） |

| 20 | **hermes skill 不在版本控制里，且没有任何机器守卫** | 缺陷 1~19 全在查「Web / MCP 的数据对不对」，没人查**第三个交付面**。`~/.hermes/skills/leisure/pbrun-coaching/` 是模型读的训练提示词，却只存在于家目录、**不在 git、没有任何测试**。实测漂移出四处会直接污染 AI 结论的错误：① HRV 阈值 `>100ms` 恢复好 / `<60ms` 需减载 —— 修复后真实库 `>100` 命中 **0/20**、`<60` 命中 **20/20**，**每一次活动都会被判「需减载」**；② `time_in_hr_zone` 被写成 `[低于Z1, Z1..Z5]` 6 项 —— 实际 **5 项、索引 0 = Z1**（353/353、246/246 全为 5），所有区间占比错位一格；③ Z3/Z4 心率边界写 `~85-90%` / `~90-95%` maxHR —— 实际 `Z3 <87%` / `Z4 <93%`（`HR_ZONE_BOUNDS=[70,80,87,93]`）；④ 力量课平均心率写 `73–129` —— 实际 **68–129**（漏掉最低值那条）。**提示词里的错数字比代码里的错数字更隐蔽**：它不会让任何测试变红，只会让模型自信地给出错误训练建议 | ① 把 skill 移进仓库 `skills/pbrun-coaching/`，`~/.hermes/skills/leisure/pbrun-coaching` 改为**软链**指向它（单一来源，重装 hermes 后按 `docs/ops.md` 重建）；② 新增 `tests/unit/docs/skill-doc-contract.test.ts`（20 例）：HRV 口径必须声明「运动中 RMSSD 不是单次训练指标」+ `ratio <0.10 / >0.2` 自证判据、区间数组必须写「长度恒为 5、索引 0 = Z1」、`HR_ZONE_BOUNDS` 直接从 `app/lib/hr-zones.ts` 导入对撞（不抄数字）、跑步三类型从 `sport.ts` 导入对撞、力量/游泳覆盖率与心率区间查真实库对撞；③ skill 被移出仓库时该测试**直接失败**（不允许「文件不在就静默跳过」）；④ 缺陷注入验证：把三处旧错误写回去，4 条断言立刻转红 |

| 21 | **FIT 原始文件里有值、解析器整体丢弃、文档还断言「设备不写」** | 前二十个缺陷都默认「数据至少进了库」。`total_cycles` 打破了这个前提：FIT session **与** lap 两级都有（真实库 **349/353**，`uint32`、`scale: null`），但 `fit-parser.js` 从未 `_safeGet*(msg,'total_cycles')` —— 库里根本没有这一列。于是「游泳总划水次数」「跳绳总跳跃次数」这两个**用户最关心的计数**全站不存在，而文档与提示词**四处**写「总划水次数不可得，不要索要」（`coach-prompts.ts:232,272`、`SKILL.md:247`、`mcp-server/tools.ts:138`），要求模型对一个真实存在的字段装看不见。同一个字段的语义随运动而变：游泳=总划水次数（518/798/923/695）、跳绳=总跳跃次数（189/187/193）、跑步=步幅周期数、爬楼=总步数、球类=动作周期。**绝不能 ×2** —— `average_cadence` 的 ×2 是「单侧周期→spm」，而 `total_cycles` 是绝对计数（518×2=1036 与 775m÷1.5m/划 对不上）。连带发现爬楼（30 条，第二大类型）全站零类型专属处理：页面上只有「累计爬升 46m」，而**爬楼的行业语言是「楼层」** | ① 解析器活动级 + lap 级都读 `total_cycles`（`>0` 才写）；② schema `activities` 79→80、`activity_laps` 44→45（迁移条目 + 漂移守卫自动拦）；③ 回填脚本加字段，lap 级新增 `db.updateLapCycles()` **只 UPDATE 一列**（不复用 `insertLaps` 的 DELETE+INSERT，避免把 3137 段真实数据的其它列写成 NULL）；实测回填 353 活动 + 290 活动的 lap；④ 详情页按类型给标签（游泳总划水次数/跳绳总跳跃次数/爬楼总步数/其他总计数），**跑步刻意不给**（步幅周期数无语义）；AI 数据块加「总划水次数 + 每划距离」「总跳跃次数 + 跳跃频率」；⑤ 新增 `app/lib/floors.ts` 派生楼层（`FLOOR_HEIGHT_M=3.048`，6 个真实爬升值 6/6 残差 <0.5m；按 3.0 反推 40/43/46/49 残差**恰好都是 1.0m**），文案带「约」，只对 `floor_climbing` 派生；⑥ 删掉四处假话。**自证**：`Σlap cycles == session cycles` 4/4 精确相等（518/518、798/798、923/923、695/695）、`total_cycles ÷ 活跃时间 ≈ FIT avg_cadence`（24.2/23.8/23.4/22.4 vs 24/24/23/22）。守护：`floors.test.ts` 18 例、`fit-parser-branches.test.js` +3 例（含「不得 ×2」）、`llm.test.ts` +5 例、消费守卫字段数 72→73 |
| 22 | **同一判据继续扫出五个字段：泳池规格 / 主观感受 / 出汗量** | 用缺陷 21 的三段判据（FIT 有 → 解析器不读 → 文档断言不可得）继续扫，又命中 **5 个**：`pool_length`（4/4）、`num_active_lengths`（4/4）、`workout_feel`（251/353）、`workout_rpe`（251/353）、`est_sweat_loss`（349/353）。其中最隐蔽的是 **`workout_feel = 0`** —— 14/251 条是 0（「感觉很差」），任何 `if (feel)` 的真值判断都会把这 14 条当「没填写」静默丢掉。另一个是 **SWOLF 的时间基数**：用活动级 `moving_time`（含池边休息，599287904 有 804s）会把 SWOLF 从 58 抬到 **84**，把一次不错的训练读成「效率很差」。第三个是 **`est_sweat_loss` 有设备速率上限**：306 条有效速率里 88 条撞上 999–1000 ml/h 天花板（max=999，无一超过），而真实出汗率可达 1500–2000 —— 它是**保守下限**，不加「约」就等于当实测值 | ① 解析器读 5 字段（`feel` 用 `!= null` 含 0；`rpe` 用 `>0`，Borg 从 1 开始；`sweat` 用 `>0`；`pool_length` scale=100 已应用，**不要再 ÷100**）；② schema `activities` 80→85；③ 回填 353 活动；④ 新增 `app/lib/swim.ts`（SWOLF/池长/活跃时间）+ `app/lib/feel.ts`（feel/RPE/出汗量），详情页六格（SWOLF 带池长/池长/活跃趟数/主观感受/主观用力/估计出汗量），AI 数据块三行；⑤ 文档补 5 字段语义与两条纪律。**自证**：`num_active_lengths × pool_length == distance` 4/4 精确（775/1075/2200/2050）；`r(feel,rpe) = −0.856` 且 feel 各档 RPE 均值严格单调（8.1/5.9/3.8/2.4/1.4）；SWOLF 实测 58/65/75/62。**SWOLF 绝不能跨池长比较、也不能折算**（50m 的 75 折成 37 会远低于任何真实 25m 值，转身蹬壁在长池被摊薄）。守护：`swim.test.ts` 23 例、`feel.test.ts` 14 例、`fit-parser-branches.test.js` +9 例、`llm.test.ts` +13 例、详情页 +9 例、消费守卫 73→78 |
| 23 | **字段进库了、也展示了，但展示的标签是假的** | 缺陷 21 给 `total_cycles` 按类型配了标签，最后留了 `: '总计数'` 兜底 —— 「我不知道这是什么，但库里有值就展示吧」。这比不展示更糟：它看起来是个**确定的**计数，会被拿去做训练决策。两处反证：**力量训练** `r(total_cycles, moving_time) = −0.118`（n=51，几乎无关），同模板「核心稳定性4」15.2min 课 `cyc=51` 而 28.1min 课 `cyc=40`（时长翻倍反而更少）；`activity_laps` **0/51**（设备不写 lap 消息），`num_laps` 恒为 37/41/42/43/44/49（随课表模板变，与时长无关，也不是组数）。**室内有氧**同名「5 分钟平板支撑挑战」9 条出现 **5 / 19 / 66 / 474**（95 倍跨度）—— 平板支撑只有 1 次，任何「次数」解释都不成立。**球类最微妙**：结构自证对得上（篮球 3/3、乒乓 2/2、羽毛 1/1），但篮球 53min 1685 次折合 32「触球」/分，不符合任何球类常识 —— 结构自证只证明「读得一致」，不证明「读的是什么」 | ① 新增 `app/lib/cycles.ts` 语义白名单（`lap_swimming`/`open_water`/`jump_rope`/`floor_climbing` 四条），每条必须带 `basis` 写明**两条判据**（结构自证 `Σlap==session` + 独立锚点）；② 详情页概览 `cycleCountLabel()` 返回 `null` 时整格不渲染（不是 `--`，那是「数据缺失」）；③ 分段表列名从 `!running` 改为 `cycleLabel != null`，删掉含糊的「计数」列；④ AI 数据块分段从 `!running` 改为 `cycleSem != null`，单位跟语义走（游泳「划」/跳绳「跳」/爬楼「步」）—— 旧实现给力量课分段写「40划」；⑤ MCP description 明确「只有三种类型确认了语义」并写入反证数字。**两条判据**：游泳 4/4 Σlap 全等 + ÷活跃时间≈划频（24.2 vs 24）；跳绳 3/3 + 115–150 次/分；爬楼 30/30 + 14.6–29.0 步/层。守护：`cycles.test.ts` 16 例、`llm.test.ts` +6 例、详情页 +6 例 |
| 24 | **设备记录了「这段是什么」，我们却按配速猜** | 前二十三个缺陷都在问「数据在不在库里 / 标签对不对」。第二十四个是更隐蔽的一类：**字段的位置本来是对的，但我们从来没读它，而是用另一个字段去推断它的值，并把推断结果当成事实展示**。详情页分段表一直有一列「角色」（热身/主课/恢复/冷身/匀速），它看起来像读出来的，实际是 `activity-insight.ts:analyzeLaps` 用**配速**算的（`pace < 均值×0.92` → 主课）。而设备在 FIT lap 里**明确记录了每段意图** —— `intensity`（`warmup`/`interval`/`recovery`/`rest`/`cooldown`/`active`），覆盖 **3058/3137 段 = 97.5%**、287 条活动，解析器从未读取，`activity_laps` 表连这一列都不存在。两者逐段对比仅 **73.2% 一致（747/1021 段）**，274 段判错：`647455345` 第 1 段设备标「热身」而推断成「主课」（首段配速偏快）、`648412964` 第 2 段设备「热身」推断「匀速」、`650375691` 第 1 段设备「热身」推断「匀速」。**这不只是角色列错一个词**：`workLaps`（主课段数）、`workDistanceMeters`、`workAvgPaceSecPerKm`、`workHrDrift`（主课漂移）全部建立在 `role === 'work'` 上，角色判错则整块派生分析跟着错，而这些结论会原样进入 AI 上下文。另一个陷阱是 **`active` 63 段**：`657456825` 全程 22 段都是 `active` —— 它只表示「这段在计时」，若当 `work`，一次匀速慢跑会整场被标「主课 22 段」，比推断更糟 | ① 新增 `app/lib/lap-intensity.ts`：`lapRoleFromIntensity()`（`interval`→主课、`recovery`/`rest`→恢复、`warmup`→热身、`cooldown`→冷身、**`active`/`255`/缺失→`null` 回落推断，绝不猜**）+ `isDeviceRole()` + `validateLapRoles()`（结构自证：warmup 恒在索引 0、cooldown 恒延续到末段）；② 解析器读 `lap.intensity`，**存原始字符串**（角色映射属展示层，DB 只如实保存设备说了什么，口径变了不需迁移数据）；③ schema `activity_laps` 45→46 列；④ `analyzeLaps` 设备值优先 + `roleSource: 'device' \| 'inferred'`（否则将来又会出现「不知道这个角色是猜的还是读的」）；⑤ 详情页徽标带 `·` 与 `title`（「设备记录的训练角色（FIT lap intensity = warmup）」/「按配速推断」）；⑥ AI 数据块输出设备角色（`ROLE_LABEL_AI`：热身/主课段/恢复段/冷身/匀速）—— 间歇课复盘的核心问题就是「主课段执行得怎么样、恢复段够不够」；⑦ 回填改用 `updateLapFields(id, laps, columns)`（列名白名单防注入），`updateLapCycles` 保留为 deprecated 包装。**判据**：结构自证 9/9 完美（warmup 恒首段、cooldown 恒末段、interval/recovery 严格交替）+ 独立锚点 73.2%（不高，但这正是设备值的价值：它记录**意图**，配速只反映**结果**）。守护：`lap-intensity.test.ts` 19 例、`llm.test.ts` +6 例、详情页 +4 例、消费守卫 45→46 |

| 25 | **同一个字段，在另一个消息层级才有值** | 前二十四个缺陷都在问「数据在不在库里 / 标签对不对 / 是读的还是猜的」。第二十五个是更细的一层：**同一个字段在 FIT 的不同消息层级有不同可信度，而文档只看了层级之一，于是得出了「这个字段不可得」的错误结论**。泳姿 `swim_stroke` 就是典型：`session.swim_stroke` **4/4 恒为 255**（FIT 无效哨兵 0xFF），于是旧文档与 skill 都写「泳姿仅 Garmin 云端可见」，还要求模型「不要索要，也不要建议补齐泳姿记录」。但 **`lap.swim_stroke` 一直有真实值** —— 真实库 4 条游泳 79 段里 **35 段**有 `freestyle` 18 / `mixed` 12 / `breaststroke` 4 / `backstroke` 1，其余 40 段是 0 距离池边休息段（255）。解析器从未 `_safeGet*(lap, 'swim_stroke')`，`activity_laps` 表也没有这一列。**要求模型对一个真实存在的字段装看不见，它要么说谎、要么违反指令**。两条自证不变式（实测 4/4 精确成立）：① `swim_stroke === '255' ⟺ distance === 0`（0 违反）—— 休息段没有泳姿，有距离的段一定有，若解析错位必然出现「有距离却没泳姿」；② `Σ(真实泳姿段 distance) == session.total_distance`（775/1075/2200/2050）**且** `Σ(真实泳姿段 total_cycles) == session.total_cycles`（518/798/923/695）—— 距离与划水次数两条独立链同时闭合，比只看一条强得多。另一个陷阱是 **`mixed` 不是「未知」**：设备在「这一段换了泳姿」时写 `mixed`，它是**真实取值**，与 `255`（设备没写）、`null`（数据缺失）是三件不同的事。但 `mixed` 构成未知 → **绝不能给它算每 100m 效率或每划距离**（那会凭空造出一个没有物理含义的数字，模型会拿去跟单泳姿比较）；`im`（轮换四种）、`drill`（分解练习）同理。还有一条容易踩的：**泳姿分组秒数之和 ≠ SWOLF 的时间基数**（后者含全部活跃段，含 mixed），用分组重算 SWOLF 会偏小 | ① 解析器 `_extractLapsData` 读 `lap.swim_stroke`，**存原始枚举字符串**（`255`/空串不写；中文名与效率口径属展示层，Garmin 改枚举或本项目改口径都不需迁移数据）；② schema `activity_laps` 46→47 列（`swim_stroke TEXT`）+ 迁移条目；③ 新增 `app/lib/swim-stroke.ts`：`swimStrokeLabel()`（枚举→中文名，`mixed` 必须给出「混合泳姿」而不是 `null`）+ `hasSwimStroke()` + `isComparableStroke()`（只有 freestyle/backstroke/breaststroke/butterfly 算可比，mixed/im/drill 不算）+ `summarizeSwimStrokes()`（**只统计有距离的段**，0 距离休息段不参与；mixed/im/drill 的效率字段一律 `null`；输出按泳姿字典序稳定）+ `validateSwimStrokes()`（结构自证）；④ 详情页概览「泳姿」格给整体构成，分段表新增「泳姿」列并**整列门控**（没有一条 lap 有泳姿时整列不渲染 —— 恒空列会被读成同步失败）；⑤ AI 数据块逐段泳姿 + 泳姿构成汇总 + 两条纪律声明（`mixed` 不是未知 / 分组秒数不能重算 SWOLF）；⑥ MCP `get_activity` / `get_activity_laps` description 与 skill 整段重写（删掉「未入库 / 云端才有」）；⑦ 回填 `updateLapFields(id, laps, ['total_cycles','intensity','swim_stroke'])`。守护：`swim-stroke.test.ts` 43 例、`llm.test.ts` +8 例、详情页 +3 例、`tool-scope-contract` +5 例、`skill-doc-contract` +6 例、消费守卫 46→47。四处缺陷注入全部转红（`mixed` 改成「未知泳姿」/ `mixed` 给效率数字 / AI 数据块去掉泳姿汇总 / skill 写回「mixed 是未知泳姿」） |
| 26 | **三处同源的指标，独独漏了最常用的那一处** | 缺陷 1~25 修的是「非跑步被藏起来 / 标签是假的 / 字段没读到」。第二十六个是另一类：**同一份数据在三个地方都该展示，但只做了两个，第三个看起来就像「这条活动没什么内容」**。真实库 354 条里 19 条（篮球 3 / 乒乓 2 / 羽毛球 1 / HIIT 3 / 室内有氧 9 / 室内骑行 1）`training_load` 全为 NULL（设备对非跑步不产出负荷），又没有语义已确认的 `total_cycles` / 楼层 / 有效组数 —— 修完缺陷 21~23 的类型专属指标后，它们在 `/list` 卡片上仍然只剩「时长 + 类型徽标」。而用户正是通过 `/list` 找活动的地方：筛到「篮球」看到 3 个空壳，结论就是「这些运动没什么可看的」。**这 19 条 19/19 都有 `average_heart_rate`（76–127bpm）**，详情页有「平均心率」格、AI 数据块有「心率: 107」、首页 `RecentActivityCard` 也有 —— 唯独 `/list` 卡片从第一版起就没渲染过这个字段（`grep average_heart_rate app/list/ListClient.tsx` 在修复前为 0 命中）。更糟的是 `docs/features.md` 早就写着「训练负荷与心率与运动类型无关，照常展示」—— 这句话对首页是真的、对 `/list` 是**假的**，文档替缺陷做了背书。**判别式**：任何一个「多入口展示同一字段」的设计，必须逐入口 grep 字段名，而不是相信「我们已经在卡片上展示了」这句话 | ① `app/list/ListClient.tsx` 的 `ActivityCard` 在「训练负荷」与「即时跑力」之间新增心率格（`a.average_heart_rate != null` 才渲染，`Math.round` 取整，与首页卡片同一写法）；② `null` 时**整格不渲染**，不写 `--` —— 心率是与运动类型无关的**可选**指标，缺了不该占位（与「距离为 `null` 显示 `--`」不同：距离是跑步的必答项）；③ 测试盯用户看到的字面：球类卡片必须出现「107 心率」、无心率时不得出现「心率」二字、跑步卡片同样出现「148 心率」；④ 缺陷注入验证：把 `a.average_heart_rate != null` 改成 `false`，两条新用例立刻转红。守护：`list-client.test.tsx` +3 例（78 例全绿）|
| 27 | **「没有这个语义」被处理成了「什么都不给」** | 缺陷 26 修的是「该给的没给」。第二十七个更微妙：**一条纪律执行得对，但它没有替代路径**。里程为 0 时月卡整块不渲染距离 —— 这是对的（力量训练/爬楼/HIIT/跳绳本来没有距离语义，显示「0.00 公里」像同步失败）。但修完前六层后，筛到「力量训练」的月卡**只剩一行「4 次」**。计数不表达训练量：4 次 20 分钟和 4 次 200 分钟在月卡上长得一模一样。真实库实证（修复前）：力量训练 2026-09 共 120 分钟、爬楼 2026-01 共 306 分钟、HIIT 2025-11 共 33 分钟、跳绳 2025-12 共 4 分钟 —— 全部只显示「N 次」。**「隐藏一个不适用指标」的下一步必须是「换一个适用的」**，否则用户得到的是一张空白卡，而空白卡会被读成「这项运动没什么内容」，正是「记录栏目只有跑步」的同一类观感来源。第二个陷阱在实现里：时长有**两种口径**（经过时间 `duration` vs 计时器时间 `moving_time`）。真实库 110/354 条活动两者不同、最多相差 7845 秒（2 小时 11 分）—— 随手写 `SUM(duration)` 会让月卡与统计页对同一批数据给出两个时长 | ① `MonthSummary` 新增 `totalDuration`（秒），SQL 用 `SUM(CASE WHEN moving_time > 0 THEN moving_time ELSE duration END)`，与 `pace.effectiveTimeSec` / `getStats().totalDuration` **同一时间基数**；② 月卡在「里程为 0 且时长 > 0」时渲染时长（`formatDuration`），有里程时**不叠加**（距离已是训练量，手机单行会溢出）；③ 时长**不拆双口径**：与 `count` 同口径（全类型），因为不存在「游泳时长混进跑量」那类语义冲突 —— `getStats` 仍是跑步口径（12150 vs 25750 的差异是刻意的，测试里逐秒断言）；④ 真实 SQL 守卫 `db-insight-integration.test.ts` 断言 25750（计时器）而不是 26000（经过时间），并断言 `sep.totalDuration - stats.totalDuration === 13600`（那条游泳）；⑤ 缺陷注入：把 `DURATION_EXPR` 改回 `'duration'`，断言立刻从 25750 变 26000 转红；⑥ MCP `get_month_summaries` description 写明「非跑步类型 `distance` 恒为 0，读训练量要看 `totalDuration`」。守护：`list-client.test.tsx` +3 例（筛选力量课时长 2:00:00 / 未筛选无跑步也给 / 有里程时不挤时长）|
| 28 | **散文单位被搬进了表格列头** | 缺陷 27 修的是「该给的没给」。第二十八个是「给了，但形态用错了地方」：`total_cycles` 的展示单位原本只有一套 —— `cycles.ts` 的 `unit` 是为**卡片散文**设计的（「189 次跳跃」「307 步」「518 次划水」，散文里没有标签，单位必须自带名词，否则「189 次」不知道在数什么）。而详情页分段表把同一个 `unit` 直接交给 `DataTable` —— 后者的 `unit` 是标签**下方独立一行小字**，两行连起来读就是「跳跃次数 / **次跳跃**」「步数 / 步」，同一个名词说两遍。游泳那格反而正常（「划水次数 / 次」），靠的是详情页两条硬编码特例 `swimming ? '划水次数' : label.replace(/^总/, '')` + `swimming ? '次' : unit` —— **它碰巧对，是因为游泳恰好是唯一「散文单位带名词、表格单位不带」的类型**，新增一种计数运动就必然出错。这也是本项目反复吃的「同一概念两处实现」的第三例（前两例：配速时间基数、类型徽标条件）。**判别式**：任何一个「给多个消费场景复用的文案字段」，必须问「这些场景的排版结构是否相同」——散文是「数值 + 单位」单行，表格是「标签 + 单位」双行，同一个单位字符串不可能同时最优 | ① `CycleSemantic` 新增 `lapLabel`/`lapUnit`（表格形态），与 `label`/`unit`（散文形态）并存；② 新导出 `cycleLapLabel()`，经 `typeMetricsOf().cyclesLapLabel` 下发（**不许调用方直接 import `cycles.ts`** —— `type-metrics-call-sites.test.ts` 已有该断言）；③ 详情页删掉 `swimming ?` 两条特例，改为 `label: typeMetrics.cyclesLapLabel.label`；④ 守卫锁死「调用方不得出现 `swimming ? '划水次数'` / `swimming ? '次'`」（断言前先剥注释 —— 文件里保留了历史说明，不剥的话守卫会被文档骗过，那是缺陷 18 的形态）；⑤ AI 数据块的注释原写「游泳用『划』，跳绳用『跳』，爬楼用『步』」而代码实际输出「划水/跳跃/步」，注释与实现不符暴露了「没有守卫盯真实输出」—— 新增两条 `llm.test.ts` 断言分段行字面为「189跳跃」「307步」；⑥ 缺陷注入：把 `lapUnit` 改回 `'次跳跃'` → `cycles.test.ts` 转红；把 `swimming ?` 分支加回去 → `type-metrics-call-sites.test.ts` 转红。真实库渲染实测：跳绳「跳跃次数 / 次」、爬楼「步数 / 步」、游泳「划水次数 / 次」|
| 29 | **「该运动不产出」被处理成了「这次没测到」** | 缺陷 27/28 修的是「该给的没给」与「形态用错了地方」。第二十九个是本项目**自己早就写下的纪律，却只在一个消费面执行**：`docs/features.md` §「活动数据块的『缺失』分两类」明确区分 —— **该运动不产出**（写入口限定类型 / 设备根本不写）→ **整项不输出（连标签）**；**该活动没测到**（数据源支持，只是这次没有）→ 保留标签 + `--`。AI 数据块严格执行了（`fmtNumIf` + `statRow` 会把 `training_load` 整项略去），但**详情页概览写的是** `{ value: activity.training_load != null ? ... : '--', label: '训练负荷' }`—— 无条件渲染。真实库 354 条实证：跑步 247/247 有值、力量 51/51 有值，**其余 9 类 0/56 全 NULL**（爬楼 30 / 室内有氧 9 / 游泳 4 / 篮球 3 / HIIT 3 / 跳绳 3 / 乒乓 2 / 羽毛球 1 / 室内骑行 1）。于是 56 条活动（占非跑步 120 条的 47%）在详情页永远挂着一个「-- 训练负荷」——用户读到的是「同步失败」，而真相是这项运动根本没有这个指标。**同一页还有内证**：`累计下降` 早就按 `!= null` 门控，而 `累计爬升` 无条件渲染 `--` —— 两个字段在真实库 85 条完全成对缺失（`mismatch = 0`），同页两种处理，是缺陷的活标本。**判别式**：任何「恒为空的数据格」都要先问「是这类运动永远没有，还是这一次没有」——前者的正确输出是**不存在**，不是 `--`；`--` 只留给后者 | ① `app/lib/sport.ts` 新增 `producesTrainingLoad(type)`（跑步三类型 + `strength_training`，空值按产出处理以兼容旧库）；② 详情页概览改用门控（不产出 → 整格不渲染），删掉无条件渲染；③ 判定必须来自**数据管线事实**（`sync.js` 的 `runnableTypes2` + 力量派生分支），页面不许自己写 `!running && !== 'strength_training'`；④ 夹具故意给 `training_load: 45` —— 门控看「这个运动产不产出」，不看「这次有没有值」；⑤ 真实库端到端守卫 `activity-detail-real-db.test.tsx`：56 条非跑步**一条都不许**出现「训练负荷」、247 条跑步 + 51 条力量**全部**出现且数值与库一致、并反向自证「时长/平均心率仍在」（防止为了修一格把整块删了）；⑥ 缺陷注入双向验证：改回无条件渲染 → 18 例转红；把 `producesTrainingLoad` 改成恒 `false` → 跑步/力量 8 例转红。"
| 30 | **同源指标三处消费面，补了第一处忘了第二处** | 第二十六类（心率）修完，`/list` 卡片与首页卡片都有了「平均心率」。但同一批 19 条非跑步活动（篮球 3 / 乒乓 2 / 羽毛球 1 / HIIT 3 / 室内有氧 9 / 室内骑行 1）的卡片上仍然只有「时长 + 心率 + 徽标」—— 因为它们的 `training_load` 全为 NULL（设备对非跑步不产出负荷），而心率只说明「心跳多快」，不说明「这课练得有多重」。**同一批活动 19/19 都有 Garmin 官方 `total_training_effect`（0–1.2）** —— 这是非跑步**唯一的强度量化手段**，详情页「有氧训练效果」与 AI 数据块「训练效果」早就在用，两张卡片从未渲染。更隐蔽的是：**`TE = 0` 是有效值**。真实库羽毛球 `560273729` 的 TE 精确为 0、跳绳 3 条为 0–0.1，它们恰恰是「这课基本没有训练刺激」的唯一证据；判空若写成真值判断（`if (te)`），这 4 条会静默消失，而其它类型照常显示 —— 只有跨活动对撞才会发现。**为什么单测拦不住**：`list-client.test.tsx` 里写 `total_training_effect: 0.9` 的夹具永远走真值分支；`0` 这一支只有真实数据才碰得到。**判别式**：一个字段在三处消费面都该出现时，要问「它是不是已经被第一处证明了可用，却只补了那一处」——同源指标漏一处，是「修完一个缺陷引入下一个缺陷」的典型形态 | ① 新增 `app/lib/training-effect.ts`：`formatTrainingEffect`（`!= null` 门控 + 一位小数）、`TRAINING_EFFECT_LABEL`（卡片「训练效果」）、`TRAINING_EFFECT_DETAIL_LABEL`（详情页「有氧训练效果」，与相邻「无氧训练效果」区分）；② `/list` 卡片与首页 `RecentActivityCard` 在心率之后补 TE 一格；③ 详情页概览改用同一来源（原来自己 `.toFixed(1)`，标签硬编码）；④ **TE 不做运动类型门控**（与 `training_load` 相反）—— 354/354 全有值，加白名单就是第三份「哪些类型有 TE」的判断；⑤ 机器守卫：`type-metrics-call-sites.test.ts` 锁死三处都必须 import `formatTrainingEffect`、都不得自己读 `total_training_effect` 做门控、标签不得硬编码（剥注释后断言，避免被历史说明骗过）；⑥ 真实库端到端：`type-metrics-real-db.test.tsx` 断言 6 类空壳**每张卡片**的 TE 数值与库一致、`TE = 0` 照常渲染、**13 类全部**有「训练效果」（反向证明没加类型门控）；⑦ 新增 `list-card-real-db.test.tsx`：从库里**动态求出**「只有时长+心率」的空壳集合（不写死 19），逐条按 `toFixed(1)` 精确匹配；⑧ 缺陷注入双向验证：`formatTrainingEffect` 改成真值判断 → 8 例转红；两张卡片的 TE 整块删掉 → 13 例转红 |
| 31 | **同一个词，两个口径，三处都没标注** | 追「记录栏目还是只有跑步类型」到第十八层时，发现一个不属于「缺字段」的缺陷：「训练负荷」这个词在页面上是**两个不同口径**。首页「本月概览」与 `/analysis` 负荷图用 `getCombinedTrainingLoads`（跑步 + 力量），`/stats` 九格用 `getStats`（SQL 带 `runningTypeClause`，**纯跑步**）。真实库逐月差值：2026-08 跑步 1715 vs 合并 2004（+289 / 17%）、2026-02 1727 vs 2025（+298 / 17%）、2026 全年 15668 vs 17171（+1503）、全历史 18122 vs 19788（+1666）。用户在首页看到「训练负荷 2004」，点「全部统计 →」过去看到「训练负荷 1715」—— 两个数字都叫同一个名字，既不知道谁对，也不知道差在哪。更隐蔽的是**首页同一行四格两种口径**：本月距离 / 跑步天数 / 平均配速 都来自跑步口径，唯独训练负荷是合并口径 —— 四格并列时没人会怀疑第四个。**两个口径本身都对**：力量课对 CTL/ATL/TSB 的贡献不该恒为 0（合并），`/stats` 是「跑步数据统计」（跑步）。错的只是**同一个词没有限定语**。**为什么测试拦不住**：没有任何断言是错的 —— 首页断言「当月训练负荷 = 420」（夹具里力量负荷为 0，合并值恰好等于跑步值），`/stats` 断言「训练负荷 = 1420.5」（它确实是跑步口径）。两处单测全绿，只有把两个页面并排看才发现同一个名字下是两个数。**判别式**：一个词在多个页面出现时，要问「它的**数据源**是不是同一个」—— 不是「值对不对」，而是「用户拿这两个数能不能对账」 | ① 新增 `app/lib/load-scope.ts`（口径标签唯一来源）：`monthLoadScopeHint`（首页，力量负荷 N 与力量卡同源）、`combinedLoadScopeHint`（分析页，给力量占比）、`DISTANCE_SCOPE_HINT`（距离也是跑步口径，差值来自游泳/球类而非力量）、`STATS_SCOPE_HINT`（一句话覆盖九格）；② 首页「训练负荷」补 hint —— 有力量写「跑步 + 力量合并（力量负荷 N）」，无力量写「跑步口径（本月无力量负荷）」（**0 也要说清**：此时合并值 ≡ 跑步值，继续挂「合并」反而制造怀疑）；③ 首页「本月距离」补 hint「跑步口径（不含游泳/球类）」—— 力量距离恒为 0，措辞点错类型用户会去力量卡里找；④ `/stats` 九格顶部加 `STATS_SCOPE_HINT`；`/analysis` 负荷卡加 `combinedLoadScopeHint`；⑤ 首页「年度里程」热力图标题改「年度跑步里程」（`getDailyDistances` 是跑步口径）；⑥ 机器守卫 `load-scope.test.ts`：三处调用方必须 import 本模块、不得硬编码口径措辞（剥注释后断言）、首页力量数值必须来自 `strengthThisMonth.totalLoad`；⑦ 真实库守卫 `load-scope-real-db.test.ts`：逐月断言「合并 ≡ 跑步 + 力量」、`/stats` 口径 ≡ 纯跑步、差值 ≡ 力量负荷、**2026 年距离差全部来自游泳/球类**（力量距离恒 0，反证 hint 措辞指向正确类型）；⑧ 缺陷注入双向验证：删掉首页 hint → 3 例转红；`monthLoadScopeHint(0)` 改成继续挂「合并」→ 4 例转红；删掉 `/stats` hint → 1 例转红 | 
| 32 | **同一页里一格不跟随周期，另八格跟随** | `/stats` 九格里「当前跑力」来自 `getStats('week').averageVDOT`（页面固定二次取数），而距离/配速/负荷/时长/心率/爬升/步频/步幅八格跟随 `period`。用户切到「年」，八格变成全年，唯独跑力还是最近 7 天 —— 且没标注。真实库：近 7 天 40.3（1 条）、2026 全年均值 39.6（106 条）、全历史 39.3（123 条）。在「年数据统计」标题下看到 40.3，读起来像「今年平均跑力 40.3」。**口径本身是对的** —— 「当前跑力」就该是最新的，跟随周期会退化成历史均值、让「当前」二字失去意义。错的是**没说明它不跟随周期**。与第 31 条同源：都是「同一个词/同一组格，口径不同却没标注」，只是这次的维度是**时间窗**而不是**运动类型**。**判别式**：一排格子并排时，要问「它们**全部**跟随同一个维度吗」—— 有一个不跟随，就必须单独标注，否则用户会按同一条规律读整排 | ① `app/lib/load-scope.ts` 新增 `CURRENT_VDOT_SCOPE_HINT = '近一周'`（与首页/分析页的 `STATS_SCOPE_HINT`、`monthLoadScopeHint` 同一来源）；② `StatsClient` 的 `StatCell` 增加 `hint` 支持，「当前跑力」格补「近一周」；③ 机器守卫：`load-scope.test.ts` 锁死 hint 来自模块、剥注释后不得出现裸 `hint="近一周"`；④ 行为守卫 `stats-list-pages.test.tsx`：切周期时「当前跑力」数值不变、而距离跟随年度变 —— 若有人把它改成跟随 `period`，这条会红，迫使同时更新 hint 与文档；⑤ 真实库守卫：断言近一周 / 2026 全年 / 全历史三个 VDOT 均值**互不相同**（差值 > 0.1），证明 hint 存在的必要性；⑥ 缺陷注入双向验证：删掉 hint → 2 例转红；把 `getStats('week')` 改成 `getStats(period)` → 2 例转红 | 
| 33 | **限定语点错了类型** | `/stats` 九格的口径提示旧文案只写「不含力量训练」。但九格的**差值来源不是同一个类型**：训练负荷差 1666 全来自力量（爬楼 0）、**累计爬升差 1312m 却全来自爬楼**（力量 51 条爬升合计恒为 0）、距离差 11.9km 来自游泳/球类。用户拿 Garmin 上的总爬升减 `/stats` 的爬升，差的 1312m 去力量卡里永远找不到 —— 因为力量训练根本不记爬升。**这不是算错，是限定语点错了类型**：与第 31 条（同一个词两个口径）同源，只是那次错在「该不该标」，这次错在「标的是哪个类型」。**为什么测试拦不住**：旧断言只检查文案里出现了「跑步口径」四个字，文案本身自洽、数字也全对，只有把九个指标的差值逐项按类型拆开才发现「同一句话对一格对、对另一格错」。**判别式**：写「不含 X」之前，先把差值的**构成**按类型列出来 —— 若差值的构成跨多个类型，限定语就必须列全，否则用户会按唯一被点名的那个类型去解释全部差值 | ① `STATS_SCOPE_HINT` 改为「跑步口径：距离/配速/负荷/心率/步频等均只统计跑步（不含力量训练、爬楼、游泳、球类）」；② 单测 `load-scope.test.ts` 扩 2 例：提示必须含「爬楼」、且不得只点名力量；③ 真实库守卫 `load-scope-real-db.test.ts` 扩 2 例：爬升差 1312 **全部**来自爬楼且力量精确为 0（同时钉住 7853/9165 两个数）、负荷差 1666 全来自力量且爬楼为 0 —— 两句合起来证明「只写不含力量」会让爬升的差值无处解释；④ skill 守卫扩 1 例：必须写「爬楼」「1312」且明确否掉「爬升差来自力量」；⑤ 缺陷注入双向验证：文案改回只写力量 → 2 例转红 | 
| 34 | **同一个缺陷修了三处，漏了第四处** | 第十八类发现「同一个词『训练负荷』两个口径」，修了首页、`/analysis`、`/stats` 三处，并写了「三处消费面」的机器守卫。但**洞察页 `/insight` 的负荷卡是第四处**，也是同样的形态：急性负荷 (7天) / 慢性负荷 (28天周均) 来自 `getCombinedTrainingLoads`（跑步 + 力量），而同一张卡第三格「峰值周跑量」来自 `periodization`（`getInsightActivityRows` 带 `runningTypeClause`，纯跑步）。真实库近 28 天合并 1047 vs 跑步 987（力量 60）。旧实现一个字都没标。**为什么守卫没拦住**：守卫是按「已知的三处」写死的（`app/page.tsx` / `StatsClient.tsx` / `AnalysisClient.tsx`），它只能证明「这三处都标了」，证明不了「没有第四处」—— 而这正是本项目反复踩的「白名单式守卫」盲区（与「类型专属指标」守卫同一形态）。**判别式**：修完「多处消费面」的缺陷后，不能只补已知那几处，要**反向搜数据源**——谁还在 import `getCombinedTrainingLoads` / `getTrainingLoads` / `getStats`，逐个确认是否已标口径 | ① `app/lib/load-scope.ts` 新增 `INSIGHT_LOAD_SCOPE_HINT`（同时点出两种口径，不硬凑力量数值）；② `InsightClient` 负荷卡顶部渲染该 hint；③ 单测 `load-scope.test.ts` 扩 3 例：hint 必须同时含合并与跑步、必须点名「急性/慢性」与「峰值周跑量」、措辞不得让峰值周跑量看起来含力量；④ 组件测试 `insight-components.test.tsx` 扩 2 例：卡片上必须出现含力量训练的说明且同时提到峰值周跑量是跑步口径、不得只写合并口径；⑤ 机器守卫：`/insight` 必须 import 本模块、不得硬编码口径措辞；⑥ 真实库守卫：近 28 天合并 ≡ 跑步 + 力量且两者不等（力量贡献 > 0，否则提示无从验证）；⑦ 缺陷注入双向验证：删掉卡片上的 hint → 3 例转红；hint 改成只写「合并」→ 3 例转红 | 
| 35 | **同一行两个数，一个含全部一个只含跑步** | `/list` 月卡显示「200.84 公里 · 25 次」，但 200.84km 只来自 **21 次跑步**，25 次是全部活动（21 跑步 + 2 力量 + 1 爬楼 + 1 游泳）。读者自然算出「平均 8.03 km/次」，而真实跑步均距 9.56 km（差 19%）。2026-02 更极端：「219.30 公里 · 37 次」里 16 条是爬楼，均距只有 5.9km/次。**次数给全类型本身是对的** —— 它必须与展开后的卡片数严格一致，否则用户以为有活动漏了。错的是**没说清这 25 次里有几次有里程**。**为什么测试拦不住**：`db.ts` 的 `getMonthSummaries` 注释早就写着「两个数字互相矛盾」，两个字段也都正确返回；单测分别断言了「里程用 runDistance」和「次数用 count」，各自都对，只有把两个数**并排**读才发现它们不能相除。**判别式**：同一行里的数字，要问「它们的分母是同一批记录吗」—— 能相除的才是同一口径，不能相除的必须标出各自的基数 | ① 月卡次数后标出跑步那部分「25 次（跑步 21）」，用户一眼对上「里程 ÷ 跑步次数」；② **全是跑步时不标**（`4 次` 已足够，`4 次（跑步 4）` 是噪音），`runCount >= count` 时不渲染；③ `runCount` 缺失（旧 API 响应）时也不标，保证信息量不倒退；④ 单测 `list-client.test.tsx` 扩 2 例：必须出现「跑步 21」、全是跑步时不得出现「跑步 4」；⑤ 真实库守卫 `load-scope-real-db.test.ts` 扩 1 例：至少 8 个月份 `count > runCount`、精确钉住 2026-09（25/21）与 2026-02（37/19）、且每月 `runCount ≤ count`；⑥ 缺陷注入双向验证：删掉标注 → 1 例转红；去掉「全是跑步不标」的分支 → 1 例转红 | 
| 36 | **两张卡的口径分布恰好相反，却共用一句说明** | `/insight` 上有两张卡都涉及「负荷」：「训练负荷与周期」是**急性/慢性合并、峰值周跑量纯跑步**；「周期化分析」是**负荷与 CTL/ATL/TSB 合并、跑量与次数纯跑步** —— 分布恰好相反。第二十一类修了前者，后者（同一页、同一份数据源、同样混合）却漏了。真实库 ISO 周 2026-W43（10-19..10-25）：合并负荷 **256** / 跑步 **196**（差 60，全来自力量），而同一行跑量 28.32km、次数 3 都只算跑步。更危险的是**趋势图把两个口径画在同一坐标系**（周跑量跑步 / TSB 合并），用户会以为二者能互相解释。**为什么测试拦不住**：第二十一类的守卫只断言「`/insight` 必须 import `INSIGHT_LOAD_SCOPE_HINT`」，它证明了「负荷卡标了」，证明不了「同一页没有第二张混口径的卡」——与第 34 条同一盲区：**按已知位置写死的守卫，天然看不见相邻位置**。**判别式**：给一张卡加口径说明时，顺手看**同一页还有哪些卡吃同一份数据源** | ① `app/lib/load-scope.ts` 新增 `PERIODIZATION_SCOPE_HINT`（与负荷卡那句刻意不同）；② `InsightClient` 周期化卡在九格下方渲染该 hint；③ 单测 `load-scope.test.ts` 扩 3 例：周期化卡必须用新 hint 且不得硬编码、两条 hint 必须互不相同、周期化 hint 不得出现「峰值周跑量」（那是另一张卡的格）；④ 组件测试 `insight-components.test.tsx` 扩 2 例：周期化卡必须标注两种口径、两条 hint 文本必须互不相同；⑤ 真实库守卫：ISO 周 2026-W43 合并 256 / 跑步 196 / 力量 60，且同周跑量 28.32km、次数 3；⑥ 缺陷注入双向验证：删掉周期化卡 hint → 3 红；hint 改回只写「合并」→ 2 红 | 
| 37 | **注入 AI 的文本里混着两种口径，网页修了但 prompt 没修** | 第二十四类：`formatRunnerProfile` 的跑者画像会进入**每一次**活动分析的 prompt，其中生涯/近期跑量、次数、周环比、配速趋势是**纯跑步**（`getStats` + `getActivities(runningOnly)`），而负荷 CTL/ATL/TSB 是**跑步 + 力量**（`getCombinedTrainingLoads`）。真实库全历史跑步负荷 **18122** / 合并 **19788**（差 **1666**，全来自力量训练）。整段没有一个字说明。**危害比网页更严重**：网页上用户看到两个数会自己犯嘀咕，而模型会拿「近 28 天 8 次跑步」去解释一个含力量课的 CTL，然后在回答里编造「你的负荷主要来自跑量」这类因果（真实库近 28 天跑步 1030 / 合并 1090，力量贡献 5.8%）。**为什么测试拦不住**：本项目此前所有的口径守卫都盯着 `.tsx`（首页/`/stats`/`/analysis`/`/insight`），**没有一条守 `app/lib/*.ts` 里拼给模型的字符串** —— 而那条路径的受众是模型，错了没人当场看得见。**判别式**：修口径缺陷时，除了问「页面还有哪处」，还要问「这段数字会不会被拼进 prompt」 | ① `formatRunnerProfile` 在负荷行后追加「（负荷为跑步 + 力量合并，含力量训练；上面的跑量/次数/配速只统计跑步）」；② **只在有负荷行时输出** —— 无负荷时留着是噪音，还会让模型以为跑量也含力量；③ 单测 `runner-profile-branches.test.ts` 扩 2 例：有负荷必须含「含力量」与「跑步」、无负荷不得出现「含力量」；④ 真实库守卫：全历史跑步 18122 / 合并 19788 / 力量 1666，且合并 ≡ 跑步 + 力量；⑤ 缺陷注入双向验证：删掉那句 → 1 红；挪到 `hasLoad` 之外无条件输出 → 1 红 | 
| 38 | **同一个盲区修了一个入口，另一个入口照样漏** | 第二十四类修了「跑者画像」注入 AI 的口径说明，并写下判别式「这段数字会不会被拼进 prompt」。但**同一类问题还有第二个入口**：`formatInsightForCoach` 的【全局训练指标】也直接进 prompt，里面 `周训练量 2026-W43 28.3km/2:46:46/3次/256TL` —— km/时长/次数是纯跑步，`256TL` 是跑步 + 力量（真实库同周跑步仅 196，差 60 全来自力量）。`负荷: 急性/慢性` 与 `训练负荷(EWMA)` 同样是合并口径。模型会把它们当成同一件事的三个侧面，算出「85 TL/km」这种无意义密度，再据此建议加量。**为什么测试拦不住**：第二十四类只守了 `runner-profile.ts` 一个文件，而「拼给模型的字符串」在本项目里有两个独立入口 —— **按文件写的守卫，天然只覆盖被想到的那个文件**。**判别式**：写下「会进 prompt」这类判别式后，立刻把**所有** prompt 拼装点列出来逐个过一遍（`formatRunnerProfile` / `formatInsightForCoach` / `buildActivityContextBlock` / `coach-prompts.ts`），而不是只修当下发现的那个 | ① `formatInsightForCoach` 在负荷行后追加「（负荷/TL/CTL/ATL/TSB 为跑步 + 力量合并，含力量训练；km/时长/次数只统计跑步）」；② **只在真有负荷数据时输出**（`acute > 0 || chronic > 0 || weekly.length > 0`）；③ 单测 `insight-coach.test.ts` 扩 2 例：有负荷必须含「含力量」与「跑步」、无负荷不得出现「含力量」；④ 真实库守卫：ISO 周 2026-W43 合并 256 / 跑步 196 / 跑量 28.32km / 次数 3，且合并 > 跑步；⑤ 缺陷注入双向验证：删掉那句 → 1 红；条件改成 `if (true)` → 1 红；⑥ 同时确认 `buildActivityContextBlock` 不含训练负荷（只做配速/路线横向对比），无需改动 | 
| 39 | **同一段 prompt 里两个同名指标口径相反** | 第二十五类在【全局训练指标】里写下「负荷/TL/CTL/ATL/TSB 为跑步 + 力量合并（含力量训练）」，但 `buildGlobalCoachMessages` 拼出的**同一条 user 消息**里还有【区间环比】块，它的「训练负荷」来自 `getPeriodStats`（SQL 带 `runningTypeClause`），是**纯跑步**。两个「训练负荷」在同一段上下文里口径相反，模型无法判断该信哪个。真实库近 90 天（2026-08-11 ~ 11-08）：跑步负荷 **4550** / 合并 **4958**（差 **408**，8.2%）。**为什么测试拦不住**：第二十五类的守卫只断言「`formatInsightForCoach` 的输出里有『含力量』」——它证明了**那一块**标了，证明不了**同一段 prompt 的另一块**是相反口径。与第 36 条同一盲区：**按函数写死的守卫，天然看不见同一个消费面上的另一个拼装点**。**判别式**：给 prompt 里的某个指标加口径说明时，要问「这段 prompt 里还有哪些**同名**指标」—— 同名的口径必须能对上，对不上就要么改数、要么各标各的 | ① `app/lib/load-scope.ts` 新增 `PERIOD_COMPARISON_LOAD_SCOPE_HINT` = 「跑步口径，不含力量训练」；② `period-comparison.ts` 在负荷行尾拼接该 hint（用 ` · ` 分隔，避免括号嵌套）；③ 单测 `period-comparison.test.ts` 扩 1 例：负荷行必须含「跑步口径|不含力量|只统计跑步」；④ `load-scope.test.ts` 扩 2 例：hint 必须是跑步口径且点明不含力量、`period-comparison.ts` 必须 import 不得硬编码；⑤ 真实库守卫：近 90 天跑步 4550 / 合并 4958 / 力量 408，且合并 ≡ 跑步 + 力量；⑥ 缺陷注入双向验证：删掉后缀 → 1 红；hint 改成合并口径 → 1 红 | 
| 40 | **同一个日期在两条 CI 腿上不一样** | 第二十七类：`/stats` 个人纪录的两处日期用 `new Date(iso).toLocaleDateString('zh-CN', …)` 渲染，读的是**进程/浏览器时区**。真实库 `longestRunDate = 2026-10-31T23:38:57.000Z`（那场半马）的业务时区是 **2026-11-01 07:38**，CI 的 `TZ=UTC` 腿却渲染成 **2026/10/31**。同一个 PR 在 `quality`（UTC）与 `quality-tz`（Asia/Shanghai）两条腿上显示不同日期；用户手机时区一变，记录日期也跟着漂。**为什么测试拦不住**：全站时区契约（`app/lib/timezone.ts` 固定 +480）有大量单测，但那些测的都是 `formatDate`/`formatDateTime`/`formatListDateTime` **这些函数本身**；没有任何守卫检查「页面有没有绕过它们直接用 `toLocaleDateString`」。契约靠自觉，不靠机器。**判别式**：写下「所有展示时间必须出自某模块」这类契约后，要加一条**静态扫描**去证明没人绕过它 —— 否则契约只约束了愿意遵守的人 | ① `StatsClient` 两处改用 `formatDate`（`toBusinessWallClock`）；② 新增 `tests/unit/ci/timezone-display-hygiene.test.ts`：剥注释后扫 `app/**`，出现 `toLocale(?:Date|Time)?String(` 即红，例外须在 `ALLOW` 里登记理由；③ 页面测试扩 1 例：`longestRunDate` 与 `achievedAt` 都喂跨日 UTC 时间戳，断言渲染出 `2026/11/01` 且**不得**出现 `2026/10/31`；④ 真实库守卫：该活动 `start_time` 是 10-31、`start_time_local` 是 11-01，且它是最近 6 个月最长距离；⑤ 缺陷注入双向验证：两处都改回 `toLocaleDateString` → 1 红；只改回 `RecordRow` 一处 → 1 红；静态守卫单注入 → 1 红 | 
| 41 | **页面上的链接全部 404** | 第二十八类：`/insight` 的常跑路线卡两处活动链接写 `/${activityId}`，而详情页路由是 `app/pages/[id]/page.tsx` → `/pages/{id}`。生产实测 `/pbrun/659795962` → **404**、`/pbrun/pages/659795962` → 200；近 90 天洞察页有 **24 个**死链（6 条路线 × (1 最佳 + ≤5 最近)）。用户点「最佳 5:14/km」想看是哪一次跑，得到 404 页。数据在库里、计算也正确，只是**链接指错了地方**。**为什么测试拦不住**：组件测试夹具里 `best: null, recent: []` —— 恰好把两条分支永久跳过。分支永远不执行，写错的路由也就永远不显形。这与「按函数写死的守卫看不见另一个消费面」同源：**夹具的默认值把分支藏了**。**判别式**：给页面加链接时，要问「这个 URL 对应的路由文件在哪」—— 路由事实只在文件系统里，TypeScript 检查不到；并把「路由形态」抽成一个常量函数 + 静态扫描，而不是在每个 `href` 里手写字符串 | ① 新增 `app/lib/routes.ts` 的 `activityDetailPath()`；② `/insight` 两处、`/list` 的 `router.push`、首页 `RecentActivityCard` 全部改走它；③ 组件测试扩 1 例：喂 `best` + `recent` 非空，断言所有活动链接都是 `/pages/\d+`；④ 新增 `tests/unit/ci/route-hygiene.test.ts`：`app/**` 下出现 `href={`/${…}`}` / `router.push(`/${…}`)` 即红，并自证正则能命中历史那两行；⑤ 新增 `tests/unit/lib/routes.test.ts`：`activityDetailPath` 与文件系统路由一致、顶层无同名动态段；⑥ 真实库守卫：洞察页实际渲染的 24 个 activityId 逐个验证存在且都是跑步；⑦ 缺陷注入双向验证：`activityDetailPath` 改回 `/${id}` → 1 红；只把 `/insight` 一处改回 → 静态守卫 1 红 | 
| 42 | **页面上出现四个星号** | 第二十九类：JSX 文本节点**不解析 Markdown**，而项目里写 prompt/文档习惯用两个星号包裹，顺手写进正文就原样显示。两处同源：`app/daniels/page.tsx:54`「表格按该配速区间归集**跑步分段（laps）**」—— 生产页面实测原样显示 `归集**跑步分段（laps）**`；`app/lib/components/ai/AiAnalysis.tsx:391`「本界面只回答**这一次训练**」。**为什么测试拦不住**：断言用的是正则**子串**匹配（`getByText(/平均心率、步频与步幅/)`），星号夹在句子中间完全不影响匹配 —— 测试通过、缺陷照旧。子串断言天生看不见「同一段文字里多出来的字符」。**判别式**：AI 回答走 `MarkdownLite`（解析 Markdown），页面正文是 JSX（不解析）；断言「用户看到的字面」时必须同时断言「整段文本不含 Markdown 控制字符」，并把「全站正文不许出现成对星号」做成静态扫描 | ① `daniels/page.tsx` 改为 `<strong className="text-fg">跑步分段（laps）</strong>`；② `AiAnalysis.tsx` 改为 `<span className="font-medium text-fg-secondary">这一次训练</span>`；③ `shell-pages.test.tsx` 扩 1 例：断言 `container.textContent` 不含 `**`，并断言正文确实含「归集」（防退化）；④ 新增 `tests/unit/ci/jsx-markdown-hygiene.test.ts`：`app` 下 `.tsx` 剥注释后出现成对星号即红，自证能命中历史两行、不误报 `SUM(a * b)` / `**kwargs` / 注释内说明；⑤ 缺陷注入双向验证：把 `daniels` 那处改回星号 → 静态守卫 1 红 + 页面测试 1 红 |
| 43 | **筛选了但列表还是全部** | 第三十类：`/list` 的月卡头部来自 `getMonthSummaries(filter)`，展开后的卡片来自 `fetchMonthActivities` —— 后者只传 `startDate`/`endDate`，把 `type`/`q` 整个丢掉。生产实证：选「力量训练」时月卡写 `2026年10月 · 2 次`，展开却列出 **19 张卡**（16 跑步 + 2 力量 + 1 跑步机）；`months?type=strength_training` → count=2，而客户端实际请求 `/api/activities?startDate=2026-10-01&endDate=2026-10-31` → 19 条。**筛选等于没做**。更隐蔽的是 `q`：`/api/activities` 根本不接受 `q`，而搜索规则（名称 LIKE **或** 类型中文名精确命中）只写在 `getMonthSummaries` 一个函数里 —— 搜「力量」时头部说 2 次、展开列出整月。**为什么测试拦不住**：既有用例的 `fetch` 桩对**任何** URL 都返回同一个数组，「请求带没带条件」根本不可观测；夹具不看 URL，缺陷就不显形。**判别式**：凡是「列表头说 N 条、展开后是另一批数据」的界面，必须断言**展开请求的 URL 与列表头用的是同一组条件**，而不只是断言渲染结果 | ① `db.buildQueryCondition()` 抽出搜索条件（两处唯一来源）；② `getActivities` 新增 `q` 参数，`/api/activities` 与 MCP `list_activities` 同步开放；③ `fetchMonthActivities(monthKey, filter)` 强制接收生效条件，两处调用点都传 `appliedFilterRef.current`；④ `list-client.test.tsx` 扩 2 例：断言展开请求的 URL 带 `type=strength_training` / `q=游泳`；⑤ 新增 `tests/unit/ci/list-filter-consistency.test.ts`：`fetchMonthActivities` 必须声明 filter 形参、函数体内真的写入 type/q、两处调用点都传第二实参；⑥ 真实库守卫 `list-filter-consistency-real-db.test.ts`：逐月比对「汇总 count == 列表 total」（未筛选 / type / q 三种），并自证 `q=力量` 的 4 条名字里都不含「力量」；⑦ 缺陷注入双向验证：删掉 `params.set` → 2 红；删掉 `getActivities` 的 q 分支 → 真实库 3 红 |
| 44 | **一行提示的承诺，入口兑现不了** | 第三十类修完「筛选与展开同口径」后，`/list` 顶部那行「这个月只有跑步。库里还有 10 种运动：」仍然**在搜索生效时**照常出现。这行提示的语义是「你眼前这个月**全部**都是跑步，所以库里其他运动你看不见」；搜索「长距离」之后页面上只有 **1 条匹配的跑步** —— 那不是「这个月只有跑步」，而是「这个搜索条件下只有跑步」，两句话的事实基础完全不同。更严重的是 chip 的点击后果：`onTypeChange(t.type)` 只替换 `type`、**保留当前搜索词**。生产实测（2026-11-08，354 条库）：搜「长距离」→ `months?q=长距离` 返回 **1 个月**（2026-11）；点「力量训练 51」→ `months?type=strength_training&q=长距离` → **0 个月** —— 页面变成「没有符合筛选条件的活动」，用户以为自己点错了，或以为库里没有力量训练（实际 51 条，只是名字里都不含「长距离」）。**为什么测试拦不住**：既有 chip 用例的夹具要么 `availableTypes` 为空、要么本月已含非跑步活动，`otherTypesHint` 的 `return` 分支从未在「搜索生效 + 本月全跑步」这个组合下执行过。**判别式**：一行提示的前置条件必须与它给出的动作一致 —— 提示说「库里还有力量训练」，那这个入口就必须能到达那 51 条；点了之后是空页面，等于承诺落空 | ① `app/list/ListClient.tsx` 的 `otherTypesHint` 增加第四条前置条件 `if (searchQuery.trim() !== '') return []`，依赖数组补 `searchQuery`；② 用**即时值**而不是 `appliedFilter`（用户刚敲下第一个字时这句话的前提就已不成立；与下拉框那侧读即时值 `typeFilter` 保持一致）；③ **不碰下拉框 + 搜索的组合**（`type=X&q=Y` 是用户主动表达「在这个类型里搜这个词」，是对的）；④ 测试 `list-client.test.tsx` 新增 1 例：先自证搜索前**确实**显示该提示（否则是空断言），再断言搜索生效后不再显示；⑤ 缺陷注入双向验证：删掉 `searchQuery` 门控 → 1 红；恢复 → 89 例全绿 |
"**同一形态还有第二处（同一条修完）**：`累计爬升` 无条件渲染 `--`，而同页 `累计下降` 早就按 `!= null` 门控 —— 两个字段在真实库 **85 条完全成对缺失**（`both_null = 85`、`mismatch = 0`：室内运动 76 条 + 1 条无 GPS 跑步 + 力量 51 中的其余，全是室内无海拔记录）。同页同一对字段两种处理，是这条缺陷最清楚的活标本。修法：`累计爬升` 改按字段门控（与 `累计下降`、与 AI 数据块的 `fmtNumIf` 同口径），**不按运动类型白名单** —— 那会变成第三份「哪些类型有海拔」的判断。通用判别式已机器化：`activity-detail-overview-real-db.test.tsx` 里「**没有任何整类恒为 `--` 的概览格**」逐类型扫全库，唯一的例外是 `即时跑力`，且例外本身有守卫（116 条显示 `--` 的跑步 **116/116** 都有 Garmin 官方 VO2max 同屏兜底） |

**判别式（可复用的自检）**：对任何「筛选/搜索/展示」入口问三十五句 ——
1. 它的**选项**来自全库还是当前视图？（缺陷 1、5）
2. 它的**匹配条件**与其它层是否**同一表达式**？（缺陷 4、5、6、8、9、13）
3. 它的**数值三态**（缺失 / 无语义 / 有值）是否分别处理？（缺陷 3、7、10）
4. 它的**口径**是否跟着**当前筛选**走？（缺陷 11、12 —— 筛到游泳还按跑量显示，里程必然为 0）
5. 「筛选」是否**穷尽了所有筛选入口**？（缺陷 12 —— 只认 `type` 漏了搜索词 `q`；两处判定必须同一个条件）
6. 它的**单位**与该运动的**行业口径**是否一致？（缺陷 14 —— 游泳看秒/100m 而不是秒/公里；单位错了公式就会跟着错）
7. 它是否**声明了某个字段不存在，而库里其实有**？（缺陷 15 —— 提示词说「划频不提供」，真实库 4/4 条游泳都有；先 `SELECT COUNT(*) WHERE col IS NOT NULL` 再写「不提供」）
8. **数据块给了模型的数字，页面上能找到出处吗**？（缺陷 16 —— AI 说「训练效果 3.6」而概览无此项；IF 有值而 NP/FTP 不在屏上。只到模型不到用户 = 用户无法校验 = 编造与引用不可分）
9. **「同一口径」内部的不同类型，展示层保留区分了吗**？（缺陷 17 —— 三个跑步类型合并统计是对的，但 `track_running` / `treadmill_running` 被 `!isRunningType` 一并抹平，13 条活动没有任何类型标识。合并是统计问题，区分是展示问题，两件事不能混）
10. **守卫的「已消费」判定，是真的取值还是只被提到？**（缺陷 18 —— tool description 里写一句字段名就骗过守卫，4 个字段全绿却从未被读取。守卫失效的方式是「看起来在工作」，必须用缺陷注入证明它能区分「取值」与「被提及」）
11. **这个指标算得对吗？先做自证性检验。**（缺陷 19 —— `hrv_rmssd` 4/20 条「RMSSD > 全程 RR 极差」是物理不可能。任何比值/均方根类指标都该有一个**不依赖外部标准**的不变式：RMSSD ≤ RR 极差、IF = NP÷FTP、TSS = 秒/3600×IF²×100、`RMSSD/meanRR` 落在生理区间。算错了的指标比缺失更危险 —— 它会被写进 prompt 供模型引用）
12. **这份文档/提示词本身在版本控制里吗？它的数字有机器守卫吗？**（缺陷 20 —— hermes skill 是三大交付面之一，却长期只存在于 `~/.hermes` 下、**不在 git、无任何测试**。实测漂移出四处会直接污染 AI 结论的数字：HRV 旧阈值 `>100ms/<60ms` 在当前数据上命中 0/20 与 **20/20**（每次活动都判「需减载」）、区间数组被写成 6 项（实际 5 项）、Z3/Z4 边界与 `HR_ZONE_BOUNDS` 不符、力量课心率区间少算 5bpm。**提示词里的错数字比代码里的错数字更隐蔽** —— 它不会让任何测试变红，只会让模型自信地给出错误建议）
13. **这个字段「库里没有」时，是设备不写、解析器不读、还是回填没跑？**（缺陷 21 —— `total_cycles` 在 FIT 里 349/353 都有，解析器**从不读**，于是库里没有这一列，而文档把它当成「设备不写」写了四处断言。三种成因的修法完全不同：设备不写 → 声明边界；解析器不读 → 改解析器 + 回填；回填没跑 → 跑回填。**「NULL」本身不是证据**，必须直接解一次 FIT 看字段在不在。同理：`num_active_lengths × pool_length` 精确等于 `total_distance` 是泳池数据的自证不变式；爬楼 6 个爬升值 6/6 精确落在 3.048m 整数倍上，是「楼层」换算的自证依据 —— 而按常识 3.0m 反推，40/43/46/49 残差**恰好都是 1.0m**，是系统性偏移）
14. **这个「0」是有效值还是缺失？**（缺陷 22 —— `workout_feel = 0` 是「感觉最差」（14/251 条），`total_cycles = 0` 是「没有划水」（0 距离休息段），两者都必须保留；而 `workout_rpe = 0` 不是合法档（Borg 从 1 开始）、`est_sweat_loss = 0` 是「没有估算」（游泳 0/4）。**同一个 0 在四个字段上有四种处理** —— 判空条件必须写在字段旁边，不能凭「真假值」一刀切）
15. **这个指标的单位里含环境参数吗？**（缺陷 22 —— SWOLF 含池长：50m 池的值天然约为 25m 的两倍，跨池长比较会得出「25m 池更高效」的错误结论；**折算也是错的**（50m 的 75 折成 37 会远低于任何真实 25m 值，转身蹬壁在长池被摊薄）。同理：泳姿分项、坡度调整配速、海拔修正 VO2max —— 任何「换环境就不是同一个数」的指标，展示时必须带环境标签）
16. **这个数字是设备估算的还是实测的？**（缺陷 22 —— `est_sweat_loss` 有 1000 ml/h 的内部 cap，306 条里 88 条已触顶（max=999），而真实出汗率可达 1500–2000，它是**保守下限**；`training_load` 缺省时是回退算法；`recovery_time` 是建议值。三者都不能当实测，展示必须带「约/建议/估算」）
17. **这个指标的时间基数对吗？**（缺陷 22 —— SWOLF 必须用**活跃 lap 的计时器时间之和**，不是活动级 `moving_time`：599287904 的 `moving_time` 含 804s 池边休息，用它算 SWOLF 从 58 变 84。全站配速/TSS/区间早已统一到 `effectiveTimeSec`，但**新加的派生指标容易再犯**——凡是「单位时间内的量」都要问一句：分母里有没有混进休息？）
18. **这个标签是「确认的语义」还是「占位符」？**（缺陷 23 —— `total_cycles` 修好后按类型给标签，却留了 `: '总计数'` 兜底。力量 `r(cyc, 时长) = −0.118`、室内有氧同名活动出现 5/19/66/474 —— 这个数根本不是「次数」。**「库里有值」不等于「知道它是什么」**：结构自证（`Σlap==session`）只能排除解析错位，**不能告诉你读的是什么**；还需要一个**不同来源**的锚点（游泳 ÷时间≈划频、爬楼 ÷楼层≈20 步/层）。凡是留了「其他/总计/杂项」兜底的地方，都要问一句：这个标签能通过两条判据吗？）
19. **这个值是我读出来的，还是我推断出来的？**（缺陷 24 —— 详情页分段「角色」列一直存在，看起来像设备数据，实际是 `analyzeLaps` 用**配速**算的。而设备在 FIT lap 的 `intensity` 里明确记录了计划意图（覆盖 97.5%），两者只有 **73.2% 一致** —— 274 段判错。**推断结果必须以「推断」的身份出现**：`roleSource: 'device' \| 'inferred'`，UI 徽标要能区分。更关键的是**派生指标会放大错误**：一个角色的错会污染 `workLaps`/`workHrDrift`/「主课均配速」四个数字，而这四个数字会原样喂给 AI。凡是从结果反推意图的地方（配速→强度、心率→区间、距离→路线类型），都要问一句：**设备是不是直接记了这个意图？**）
20. **这个字段是不是在另一个消息层级才有值？**（缺陷 25 —— `swim_stroke` 在 `session` 级 4/4 恒为 255（无效），于是旧文档断言「泳姿仅 Garmin 云端可见」并要求模型「不要索要」；但 `lap.swim_stroke` 一直有真实值（35/79 段）。**「一级无效」不等于「字段不可得」** —— FIT 的 session / lap / record 三级各有自己的字段子集，同一个字段的可信度可以完全不同。修法是**逐级解一次原始 FIT**，而不是看到一层的 255 就下结论。同类陷阱：`intensity` 只在 lap 级有、`total_cycles` 的语义随类型变、`hr_zone_boundaries` 只在 time_in_zone 消息里。**`mixed` 还提示第三件事：真实取值 ≠ 未知，也 ≠ 缺失** —— `mixed`（设备说「这一段换了泳姿」）、`255`（设备没写）、`null`（数据缺失）是三件不同的事，把真实取值当缺失与把缺失当真实取值是同一个错误的两面）

21. **这个指标三处消费面都补了吗，还是只补了刚发现的那一处？**（缺陷 30 —— 第二十六类给 `/list` 卡片和首页卡片补了心率，19 条非跑步活动终于不是纯空壳。但同一批活动 **19/19 都有 `total_training_effect`**，详情页与 AI 数据块早就在用，两张卡片从未渲染 —— 心率只说明「心跳多快」，不说明「这课练得有多重」。**同源指标漏一处，是「修完一个缺陷引入下一个缺陷」的典型形态**：修完第一处就以为这批卡片「有内容了」，没问「它们还能说什么」。配套的两个陷阱：① **`TE = 0` 是有效值**（羽毛球 `560273729` 精确为 0、跳绳 3 条 0–0.1），真值判断会静默吞掉这几条「这课基本没有训练刺激」的唯一证据，而单测里写 `0.9` 的夹具永远走真值分支；② **门控要区分「该运动不产出」与「该运动产出但这次没测到」** —— `training_load` 只有跑步三类型 + 力量训练产出（要门控），TE 是设备对 13 类全写（354/354，**不许门控**），照抄前者的白名单会整块抹掉 9 类）

22. **同一个词在多个页面出现时，它们的**数据源**是同一个吗？**（缺陷 31 —— 「训练负荷」在首页/`/analysis` 是合并口径（跑步 + 力量），在 `/stats` 是纯跑步口径，真实库 2026-08 分别是 2004 与 1715（差 17%），却共用一个名字。**两个口径都对**，错的只是同一个词没有限定语。这类缺陷所有单测都绿：首页断言「当月负荷 420」（夹具力量负荷为 0，两口径恰好相等）、`/stats` 断言「负荷 1420.5」（它确实是跑步口径）—— 只有把两个页面并排看才发现。配套三个陷阱：① **同一行四格可能两种口径**（本月距离/跑步天数/平均配速是跑步，训练负荷是合并），并列时没人会怀疑第四个；② **差值来源要指对类型** —— 距离差的 10.23km 来自游泳/球类，力量距离恒为 0，hint 写「含力量」会让用户去力量卡里找；③ **差值为 0 时更要说明** —— 本月无力量负荷时合并值 ≡ 跑步值，继续挂「合并」反而制造怀疑，必须写「跑步口径（本月无力量负荷）」）

23. **一排格子并排时，它们全部跟随同一个维度吗？**（缺陷 32 —— `/stats` 九格里「当前跑力」固定取 `getStats('week')`，另八格跟随 `period`。切到「年」，八格变全年、唯独跑力还是最近 7 天，旧实现没标注。真实库近 7 天 40.3 / 2026 全年均值 39.6 / 全历史 39.3。**口径本身对**（「当前跑力」就该是最新的），错的是没说明它不跟随周期。与第 22 条同源：都是「同一组数口径不同却没标注」，只是维度从**运动类型**换成**时间窗**）

24. **写「不含 X」之前，差值的构成只来自 X 吗？**（缺陷 33 —— `/stats` 口径提示旧文案只写「不含力量训练」，但累计爬升差 1312m 全来自**爬楼**（力量 51 条爬升合计恒为 0）、训练负荷差 1666 全来自力量、距离差 11.9km 来自游泳/球类。用户拿 Garmin 总爬升减 `/stats` 爬升，差的 1312m 去力量卡永远找不到。**判别法**：先把差值按类型拆开列出来，构成跨多个类型就必须列全，否则用户会按唯一被点名的那个类型解释全部差值）

25. **修完「多处消费面」的缺陷后，反向搜过数据源吗？**（缺陷 34 —— 第十八类修了首页 / `/analysis` / `/stats` 三处并写了「三处消费面」守卫，但**洞察页 `/insight` 是第四处**：急性/慢性负荷是合并口径、峰值周跑量是纯跑步口径，真实库近 28 天 1047 vs 987（力量 60），旧实现一个字没标。**守卫盲区**：按已知的三处写死的断言只能证明「这三处都标了」，证明不了「没有第四处」。**判别法**：反向搜数据源（谁还 import `getCombinedTrainingLoads`），逐个确认，而不是只补已知清单）

26. **同一行里的数字，分母是同一批记录吗？**（缺陷 35 —— `/list` 月卡「200.84 公里 · 25 次」里，里程只来自 21 次跑步，25 次是全部活动（21 跑步 + 2 力量 + 1 爬楼 + 1 游泳）。读者算出「平均 8.03 km/次」，真实跑步均距 9.56 km（差 19%）。次数给全类型是对的（要与展开的卡片数一致），错的是没说清有几次有里程。**判别法**：能相除的才是同一口径，不能相除的必须标出各自的基数）

27. **给一张卡加口径说明时，同一页还有哪些卡吃同一份数据源？**（缺陷 36 —— `/insight` 的「训练负荷与周期」是「急性/慢性合并、峰值周跑量跑步」，而同一页「周期化分析」是「负荷与 CTL/ATL/TSB 合并、跑量与次数跑步」—— 分布恰好相反。第二十一类修了前者，后者漏了。真实库 ISO 周 2026-W43：合并负荷 256 / 跑步 196（差 60），同周跑量 28.32km、次数 3 只算跑步。**判别法**：口径守卫若按已知位置写死，就只能证明「那几处标了」，看不见相邻位置 —— 加说明时顺手查同一页的其余卡片）

28. **这段数字会不会被拼进 prompt？**（缺陷 37 —— `formatRunnerProfile` 的跑者画像进入**每一次**活动分析的 prompt，其中跑量/次数/配速是纯跑步、负荷 CTL/ATL/TSB 是跑步 + 力量。真实库全历史 18122 vs 19788（差 1666）。网页上用户会自己犯嘀咕，模型则会拿「近 28 天 8 次跑步」去解释含力量课的 CTL，并编造「负荷主要来自跑量」的因果。**判别法**：所有口径守卫此前都盯着 `.tsx`，没有一条守 `app/lib/*.ts` 里拼给模型的字符串 —— 修页面时要顺带问「这些数会不会进 prompt」）

29. **写下「会进 prompt」之后，把所有 prompt 拼装点列全了吗？**（缺陷 38 —— 第二十四类修了 `formatRunnerProfile`，但 `formatInsightForCoach` 是第二个入口：`周训练量 28.3km/2:46:46/3次/256TL` 里 km/次数是纯跑步、256TL 含力量（同周跑步仅 196）。模型会算出「85 TL/km」这种无意义密度。**判别法**：按文件写的守卫只覆盖被想到的那个文件 —— 判别式一旦成立，立刻列出所有 prompt 拼装点（`formatRunnerProfile` / `formatInsightForCoach` / `buildActivityContextBlock` / `coach-prompts.ts`）逐个过）

30. **这段 prompt 里还有哪些同名指标？**（缺陷 39 —— 第二十五类在【全局训练指标】里标注「负荷含力量训练」，但同一条 user 消息的【区间环比】块里「训练负荷」是纯跑步（`getPeriodStats` 带 `runningTypeClause`）。真实库近 90 天跑步 4550 vs 合并 4958（差 408）。模型在同一段上下文读到两个矛盾的「训练负荷」。**判别法**：按函数写的守卫只能证明「那一块标了」，看不见同一消费面上的另一个拼装点 —— 加口径说明时把同名指标全找出来对一遍）

31. **契约有没有被静态守住？**（缺陷 40 —— 全站时区契约有大量单测，但那些测的都是 `formatDate`/`formatDateTime` **函数本身**；`/stats` 个人纪录两处却绕过它们直接用 `new Date(iso).toLocaleDateString()`，读进程时区。真实库 `2026-10-31T23:38:57.000Z` 在业务时区是 11-01，`TZ=UTC` 腿渲染成 10-31。**判别法**：写下「所有展示时间必须出自某模块」之后，要加一条静态扫描证明没人绕过 —— 否则契约只约束愿意遵守的人）

32. **这个链接指向的路由真的存在吗？**（缺陷 41 —— 详情页路由是 `app/pages/[id]/page.tsx`，`/insight` 却写 `/${activityId}`。生产实测 `/{id}` 全部 404、`/pages/{id}` 200，近 90 天 24 个死链。夹具里 `best: null, recent: []` 把分支永久跳过，所以测试永远绿。**判别法**：路由事实只在文件系统里，TypeScript 检查不到 —— 把 URL 形态抽成常量函数并加静态扫描）

33. **这段文字是给 Markdown 渲染器还是给浏览器直出？**（缺陷 42 —— JSX 文本节点不解析 Markdown，`app/daniels/page.tsx:54` 写成「归集**跑步分段（laps）**」，生产页面原样显示四个星号；`AiAnalysis.tsx:391` 的「只回答**这一次训练**」同样。**为什么测试拦不住**：断言用正则子串匹配，星号夹在句子中间不影响匹配 —— 子串断言看不见「多出来的字符」。**判别法**：AI 回答走 `MarkdownLite`（解析 Markdown），页面正文是 JSX（不解析）；断言「用户看到的字面」时要加一条「整段文本不含 Markdown 控制字符」，并加静态扫描兜住全站）

34. **列表头与展开后的数据是同一组条件取的吗？**（缺陷 43 —— 月卡头部按 `type`/`q` 过滤，展开卡片却只传日期，选「力量训练」时头部说 2 次、展开列出 19 张。**判别法**：凡是「列表头说 N 条、展开后是另一批数据」的界面，必须断言展开请求的 URL 与列表头用同一组条件，而不只是断言渲染结果 —— `fetch` 桩对任何 URL 都返回同一个数组时，缺陷永远不可观测）

35. **这行提示的承诺，它给出的入口兑现得了吗？**（缺陷 44 —— `/list` 顶部「这个月只有跑步。库里还有 10 种运动：」在**搜索生效时**照常出现，而搜索「长距离」后页面上只有 1 条匹配的跑步 —— 不是「这个月只有跑步」，是「这个筛选条件下只有跑步」。chip 只替换 `type`、保留搜索词，点「力量训练 51」→ `months?type=strength_training&q=长距离` → **0 个月**，页面变成空态。**判别法**：自动出现的引导入口不能替用户叠加条件 —— 提示说「库里还有力量训练」，那这个入口就必须能到达那 51 条；同时**别把用户主动选的 `type` + `q` 组合一起去掉**，那是他在表达「在这个类型里搜这个词」）

任一问答「否」，就会出现「数据在库里但看不到」「数字看着像异常」或「模型引用了一个算错的数」的静默缺陷。

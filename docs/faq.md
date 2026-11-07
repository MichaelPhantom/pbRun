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
`runDistance`/`runCount` 与 `totalDistance`/`count`，另用「含 N 次其他」徽标说明差额。

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
| 15 | **提示词要求模型无视真实存在的字段** | 两处同源：① 非跑步 prompt 的数据纪律写「设备不写的字段（**划频**/划水次数、心率恢复速率、左右触地平衡）」，而真实库 **4/4** 条游泳活动都有 `average_cadence`（44/48/48/46 次/分，即划水频率）—— 模型拿得到却被要求「不要提」；② 同一 prompt 的核心原则第 3 条要求「游泳看每 100m 配速**与划频**」，两条自相矛盾。与「非跑步活动不计算训练负荷」完全同源（那次是力量负荷真实存在却被声明不存在） | ① 拆开两个概念：**划频可得**（数据块输出「划频: 44 次/分」），**总划水次数不可得**；② 数据纪律改为「设备不写的字段（总划水次数、心率恢复速率、左右触地平衡）」；③ 详情页概览补「划频（次/分）」格（旧 `running` 门控把「步频」整格藏掉，连划频也一起消失）；④ MCP `get_activity` / `get_activity_comparables` 声明「`average_cadence` 对游泳是划频不是步频」 |

| 16 | **数据块给了模型、详情页从不展示** | 缺陷 3 的反向缺口。第三类修完「prompt 要求 ⇒ 数据块供给」后，仍有字段**只到了模型、没到用户**：真实库 `max_heart_rate` 353/353、`total_training_effect` 353/353、`calories` 353/353、`primary_benefit` 353/353、`total_descent` 268/353、`garmin_vo2max` 238/246（跑步）、`normalized_power` 246/246 —— 概览一项都不渲染。用户在 AI 复盘里读到「训练效果 3.6、消耗 542 kcal」，回详情页找不到任何出处，无法判断模型是引用还是编造；更糟的是 `garmin_vo2max` 有值而本地 `vdot_value` 只有 122/246，**116 条跑步活动「即时跑力」显示 `--`，官方 VO2max 就躺在库里**。另：概览给了 IF 0.82 与 TSS 41，但 `IF = NP ÷ FTP` 的两个输入（NP、FTP）都不在页面上，用户无法自证 | 概览按**字段存在性**补齐 9 项：`最大心率`、`有氧训练效果`、`无氧训练效果`（`>0` 才渲染 —— 纯有氧课为 0 是常态，显示 `0.0` 像缺数据）、`热量`、`累计下降`、`训练收益`、`Garmin VO2max`（`running` 门禁；室内骑行那 1 条 55.0 是误写）、`FTP`、`标准化功率`。**`0` 与 `null` 不是一回事**：`null` 缺失才显示 `--`，`0` 表示该运动无此语义则整格不渲染。守护：`tests/unit/pages/activity-detail.test.tsx` 8 例（逐字段断言 / 无氧 TE=0 不渲染 / 缺 Garmin VO2max 仍给即时跑力 / 非跑步不渲染 Garmin VO2max / 非跑步不渲染 FTP·NP 整块 / IF·TSS 分子分母同屏 / 非跑步不渲染平均海拔·平均温度）。第二批补齐 `avg_altitude` 238/353 与 `average_temperature` 231/353（非跑步 0/107）—— 两者数据块早已输出、页面零展示，且温度容易与深挖面板的「温度漂移」混淆，标签必须写「平均温度」 |

**判别式（可复用的自检）**：对任何「筛选/搜索/展示」入口问八句 ——
1. 它的**选项**来自全库还是当前视图？（缺陷 1、5）
2. 它的**匹配条件**与其它层是否**同一表达式**？（缺陷 4、5、6、8、9、13）
3. 它的**数值三态**（缺失 / 无语义 / 有值）是否分别处理？（缺陷 3、7、10）
4. 它的**口径**是否跟着**当前筛选**走？（缺陷 11、12 —— 筛到游泳还按跑量显示，里程必然为 0）
5. 「筛选」是否**穷尽了所有筛选入口**？（缺陷 12 —— 只认 `type` 漏了搜索词 `q`；两处判定必须同一个条件）
6. 它的**单位**与该运动的**行业口径**是否一致？（缺陷 14 —— 游泳看秒/100m 而不是秒/公里；单位错了公式就会跟着错）
7. 它是否**声明了某个字段不存在，而库里其实有**？（缺陷 15 —— 提示词说「划频不提供」，真实库 4/4 条游泳都有；先 `SELECT COUNT(*) WHERE col IS NOT NULL` 再写「不提供」）
8. **数据块给了模型的数字，页面上能找到出处吗**？（缺陷 16 —— AI 说「训练效果 3.6」而概览无此项；IF 有值而 NP/FTP 不在屏上。只到模型不到用户 = 用户无法校验 = 编造与引用不可分）

任一问答「否」，就会出现「数据在库里但看不到」或「数字看着像异常」的静默缺陷。

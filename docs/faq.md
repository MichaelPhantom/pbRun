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
  治本方法是选非思考模型（2026-09-26 起白名单默认即 `deepseek-v4.1-flash-wb`，
  实测无思考、`finish=stop`），或在下拉里选 Gemini（两者均非思考）。
- **单位约定**（防复发）: `activities.distance` 为公里、`activity_laps.distance`
  为米；聚合函数在 `db.ts` 内统一转米后再返回。`Activity.distance` 的类型注释已更正。
- **思考模型怎么用（2026-09-13 落地, 2026-09-26 收敛为白名单）**: 能用，但
  `reasoning_effort: low` 必须**按模型精确下发**——它对 `glm-5.3-flash` 是必需
  （实测思考 889 字符 → 0），对非思考模型反而是毒药（`deepseek-v4.1-flash-wb`
  下发后会诱发 230 字符思考、`glm-5.1-wb` 实测 reasoning 0→1476）。因此判定
  顺序是：先查 `app/lib/model-curation.ts` 白名单 preset（`thinking`/`effort`
  为 2026-09-26 对本机网关 A/B 实测结论），未命中才回落 `isThinkingModel`
  启发式；`auto` 永不下发（路由目标不确定）。单测
  `tests/unit/lib/thinking.test.ts` 锁定映射。
- **分析质量优化（2026-09-13）**: 分段标签改累计距离区间（laps 含 709m 等
  非整公里段，K 序号曾误导模型）；prompt 新增【近期状态】（近 7 天跑量、
  当日 TSB、上次跑步，`app/lib/coach-context.ts`，失败自动降级为空）；
  主模型 502/超时自动回退 auto 并在脚注明示（`X-Model-Fallback` 头）；
  模型下拉按推荐排序并标注思考模型。详见 `tests/unit/lib/coach-context.test.ts`。

### 12. AI 教练升级为「世界级教练 + 跑者画像 + 对话式」（2026-09-17）

- **提示词升级**: `app/lib/llm.ts` 的 system prompt 从「活动点评」升级为世界级精英
  教练（运动科学 + 实战执教 + 数据诊断），新增【因材施教原则】（以个人水平为参照
  系解读、判定训练性质与执行质量、数据与画像矛盾时给原因）与【分析深度要求】
  （强度性质/配速执行/心率漂移/跑步经济性/综合表现/与近期状态关系 逐项覆盖）。
- **跑者画像**: 新增 `app/lib/runner-profile.ts`，分析前汇总生涯跑量/次数/起始年份、
  个人纪录、VDOT 当前与 30 天趋势、近 7/28 天跑量、CTL/ATL/TSB、惯常步频心率、
  上次跑步等，注入 prompt 首部（取代旧 `coach-context` 简版近况块）。全部查询容错
  降级，失败不阻塞。`app/lib/coach-context.ts` 保留但不再被路由引用。
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
- **现在是什么**: 人工挑选的**固定白名单**（`MODEL_PRESETS`，顺序即下拉顺序）：
  - 默认 `deepseek-v4.1-flash-wb`（非思考、`finish=stop`，实测约 1800 token）
  - 可选 `glm-5.3-flash`（思考，但下发 `reasoning_effort: low` 后思考归零）、
    `kimi-k3`、`gemini-3.7-flash`、`gemini-3.5-flash-lite`
  - `auto` 不进下拉，只作为**服务端回退目标**与旧客户端兼容值。
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

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

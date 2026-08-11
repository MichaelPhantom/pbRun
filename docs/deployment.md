# 部署指南

本文档详细介绍如何将 Garmin Running Data Analytics 部署到 Vercel，并配置 GitHub Actions 实现自动数据同步。

## 目录

- [部署前准备](#部署前准备)
- [Vercel 部署](#vercel-部署)
- [GitHub Actions 配置](#github-actions-配置)
- [环境变量配置](#环境变量配置)
- [验证部署](#验证部署)
- [常见问题](#常见问题)

---

## 部署前准备

### 1. 账号准备

- **GitHub 账号**: 用于 Fork 仓库和存储代码
- **Vercel 账号**: 用于部署应用 (可使用 GitHub 账号登录)
- **Garmin 国际区账号**: 用于同步运动数据

注意：Garmin 国区账号不支持，必须使用国际区账号。

### 2. 获取 Garmin 认证 Token

请先完成下方「Vercel 部署」中的 [Fork 仓库](#1-fork-仓库)，再在本地克隆**你 Fork 的仓库**（不要直接 clone 上游），然后获取 Token：

```bash
# 将 YOUR_USERNAME 替换为你的 GitHub 用户名
git clone git@github.com:YOUR_USERNAME/pbRun.git
cd pbRun

# 安装依赖
npm install

# 可选：先在项目根 .env 中配置 Garmin 账号密码，便于非交互获取 Token
# GARMIN_EMAIL=your_email@example.com
# GARMIN_PASSWORD=your_password

python3 scripts/get_garmin_token.py
```

脚本会从 .env 读取 `GARMIN_EMAIL` / `GARMIN_PASSWORD`（未配置时按提示输入），并输出 `GARMIN_SECRET_STRING`。

示例输出：

```
Enter your Garmin email address: your-email@example.com
Enter your Garmin password: ********

✓ Successfully authenticated with Garmin
Your Garmin Secret String: ...

请将此 Token 添加到 GitHub Secrets 和 .env 文件中
```

**重要**: 请妥善保管此 Token，不要泄露给他人。

### 3. 确定心率参数

VDOT 计算需要你的最大心率和静息心率：

- **最大心率 (MAX_HR)**: 可通过 `220 - 年龄` 粗略估算，或通过专业测试获得
- **静息心率 (RESTING_HR)**: 早晨醒来时测量的心率

示例：

```bash
MAX_HR=190        # 30 岁跑者，220-30=190
RESTING_HR=55     # 清晨静息心率
```

---

## Vercel 部署

### 方式一：通过 Vercel 控制台部署 (推荐)

#### 1. Fork 仓库（必做第一步）

访问 [项目仓库](https://github.com/xuandao/pbRun)，点击右上角 **Fork** 按钮，将仓库 Fork 到你的 GitHub 账号。后续所有操作（配置 Secrets、Vercel 导入、本地开发等）均基于你 Fork 的仓库，不要直接使用上游仓库。

#### 2. 登录 Vercel

访问 [Vercel](https://vercel.com)，使用 GitHub 账号登录。

#### 3. 导入项目

1. 点击 **Add New** > **Project**
2. 选择你 Fork 的 `pbRun` 仓库
3. 点击 **Import**

#### 4. 配置项目

Vercel 会自动检测到 Next.js 项目，无需修改默认配置：

- **Framework Preset**: Next.js
- **Build Command**: `next build`
- **Output Directory**: `.next`
- **Install Command**: `npm install`

点击 **Deploy** 开始部署。

#### 5. 部署完成

首次部署可能需要 2-3 分钟，部署成功后你会看到：

```
🎉 Your project has been deployed!
```

Vercel 会自动分配一个域名，如：`your-project.vercel.app`

---

### 方式二：通过 Vercel CLI 部署

如果你熟悉命令行，也可以使用 Vercel CLI：

```bash
# 安装 Vercel CLI
npm install -g vercel

# 登录 Vercel
vercel login

# 部署项目
vercel --prod
```

---

## GitHub Actions 配置

GitHub Actions 用于每日自动同步 Garmin 数据。

### 1. 配置 GitHub Secrets

在你 Fork 的仓库中，进入 **Settings** > **Secrets and variables** > **Actions**：

点击 **New repository secret**，依次添加以下 Secrets：

| Secret 名称 | 值 | 说明 |
|------------|-----|------|
| `GARMIN_EMAIL` | 你的 Garmin 登录邮箱 | 用于重新获取 Token 等 |
| `GARMIN_PASSWORD` | 你的 Garmin 登录密码 | 用于重新获取 Token 等 |
| `GARMIN_SECRET_STRING` | 从上一步获取的 Token | Garmin 认证 Token，同步数据时使用 |
| `MAX_HR` | 例如 `190` | 最大心率（可选） |
| `RESTING_HR` | 例如 `55` | 静息心率（可选） |

配置完成后如下图所示：

```
Repository secrets
• GARMIN_EMAIL
• GARMIN_PASSWORD
• GARMIN_SECRET_STRING
• MAX_HR
• RESTING_HR
```

### 2. 启用 GitHub Actions

1. 进入仓库的 **Actions** 标签页
2. 如果看到 "Workflows aren't being run on this forked repository"，点击 **I understand my workflows, go ahead and enable them**
3. 找到 **Sync Garmin Data** workflow，点击 **Enable workflow**

### 3. 手动触发首次同步

为了验证配置是否正确，建议手动触发一次同步：

1. 进入 **Actions** > **Sync Garmin Data**
2. 点击 **Run workflow** > **Run workflow**
3. 等待执行完成（约 2-5 分钟）

如果执行成功，你会看到：

```
✅ Sync Garmin data
✅ Commit and push
```

### 4. 自动同步计划

GitHub Actions 配置了以下触发条件：

- **定时自动同步**: 每 8 小时 (UTC 00:00、08:00、16:00，对应北京时间 08:00、16:00、次日 00:00)
- **手动触发**: 在 Actions 页面手动运行
- **代码推送**: 推送到 main 分支时 (排除仅 DB 变更)
- **Webhook 触发**: 通过 API 触发 (可用于其他自动化场景)

同步流程：

```
1. 拉取最新代码
2. 从 Garmin 下载新活动的 FIT 文件
3. 解析 FIT 文件，计算 VDOT
4. 更新 SQLite 数据库（统计类分析为查询时实时计算，无需预计算）
5. 提交数据库到 Git
6. 推送到 GitHub (触发 Vercel 重新部署)
```

### 5. 代码更新 / 重新部署 (ubtu2)

生产为 systemd user 服务 (`pbRun.service`, 端口 3996, Nginx 门户 `/pbrun/`):

```bash
bash scripts/deploy-prod.sh            # pull + 依赖检查 + 停服 + build + 起服 + 健康检查
bash scripts/deploy-prod.sh --no-pull  # 跳过 git pull
bash scripts/deploy-prod.sh --verify   # 仅做健康检查 (首页 200 + 主 CSS 200)
```

> ⚠️ **务必先停服再 build**：若在 `next start` 运行中覆盖 `.next`，服务内存中
> 仍是旧前端产物，页面引用的 CSS chunk 会 404，表现为全站无样式/布局混乱。
> 数据同步 (cft cron) 只写 DB、不碰 `.next`，无需重建或重启——统计类分析为
> 查询时实时计算。

日志: `journalctl --user -u pbRun -f`

---

## 环境变量配置

### GitHub Actions 环境变量

已在上文的 GitHub Secrets 中配置，无需额外操作。

### Vercel 环境变量 (可选)

如果你希望在 Vercel 中也配置环境变量（例如用于 API 限流或其他功能），可以：

1. 进入 Vercel 项目页面
2. **Settings** > **Environment Variables**
3. 添加以下变量：

| 变量名 | 值 | 说明 |
|--------|-----|------|
| `MAX_HR` | 例如 `190` | 最大心率 (可选) |
| `RESTING_HR` | 例如 `55` | 静息心率 (可选) |

注意：`GARMIN_SECRET_STRING` 不需要添加到 Vercel，因为数据同步在 GitHub Actions 中完成。

### 本地开发环境变量

创建 `.env` 文件（不要提交到 Git）：

```bash
# Garmin 账号密码（供 get_garmin_token.py 获取/刷新 Token 时使用）
GARMIN_EMAIL=your_email@example.com
GARMIN_PASSWORD=your_password

# Garmin 认证 Token（运行 python3 scripts/get_garmin_token.py 获得）
GARMIN_SECRET_STRING="your_token_here"

# 心率参数
MAX_HR=190
RESTING_HR=55
```

---

## 验证部署

### 1. 检查 Vercel 部署状态

访问你的 Vercel 项目页面，确认部署状态为 **Ready**。

### 2. 访问网站

打开你的 Vercel 域名（例如 `your-project.vercel.app`），检查页面是否正常加载。

### 3. 测试 API 接口

在浏览器中访问以下 API 端点：

```
# 获取活动列表
https://your-project.vercel.app/api/activities?limit=10

# 获取统计数据
https://your-project.vercel.app/api/stats

# 获取 VDOT 趋势
https://your-project.vercel.app/api/vdot?days=30
```

如果返回 JSON 数据，说明 API 工作正常。

### 4. 检查数据库

在 GitHub Actions 执行成功后，检查仓库中的 `app/data/activities.db` 文件：

- 文件大小应该 > 0 KB
- 查看最新的 commit 消息，应该是 `chore: update garmin data YYYY-MM-DD`

### 5. 验证自动部署

当 GitHub Actions 推送新数据后，Vercel 会自动检测到变化并重新部署。

在 Vercel 项目页面的 **Deployments** 标签中，你会看到新的部署记录。

---

## 常见问题

### Q1: GitHub Actions 执行失败，提示 "Garmin authentication failed"

**原因**: `GARMIN_SECRET_STRING` 配置错误或已过期。

**解决方案**:

1. 重新运行 `python3 scripts/get_garmin_token.py` 获取新 Token
2. 更新 GitHub Secrets 中的 `GARMIN_SECRET_STRING`
3. 手动重新运行 workflow

### Q2: Vercel 部署成功，但页面显示 "500 Internal Server Error"

**原因**: 数据库文件不存在或损坏。

**解决方案**:

1. 确认 `app/data/activities.db` 文件已提交到 Git
2. 检查文件大小是否 > 0 KB
3. 在本地运行 `npm run init:data` 初始化数据，然后提交到 Git

### Q3: API 返回空数据

**原因**: GitHub Actions 尚未同步数据。

**解决方案**:

1. 手动触发 GitHub Actions (Actions > Sync Garmin Data > Run workflow)
2. 等待执行完成
3. 确认 `app/data/activities.db` 文件已更新

### Q4: VDOT 计算结果异常

**原因**: 心率参数配置错误。

**解决方案**:

1. 检查 `MAX_HR` 和 `RESTING_HR` 是否符合你的实际情况
2. 更新 GitHub Secrets（`MAX_HR` 参与心率区间划分，改动后无需重建数据，分析页实时生效）

### Q5: Vercel 部署超时

**原因**: 数据库文件过大（>100MB）。

**解决方案**:

Vercel 对部署的文件大小有限制（免费版 100MB），如果数据库文件过大，可以：

1. 清理历史数据（保留最近 1-2 年）
2. 使用 Vercel Pro 计划（支持更大文件）
3. 考虑使用其他部署平台（如 Cloudflare Pages、Netlify）

### Q6: 如何自定义域名？

在 Vercel 项目页面：

1. **Settings** > **Domains**
2. 输入你的域名（例如 `running.yourdomain.com`）
3. 按照提示配置 DNS 记录（CNAME）
4. 等待 DNS 生效（通常 5-30 分钟）

### Q7: 数据同步频率可以调整吗？

可以。编辑 `.github/workflows/sync_garmin_data.yml`:

```yaml
schedule:
  - cron: '0 0 * * *'  # 每日 UTC 00:00
  # 修改为其他时间，例如:
  # - cron: '0 */6 * * *'  # 每 6 小时一次
  # - cron: '0 2,14 * * *'  # 每天 2:00 和 14:00
```

提交修改后，新的计划会自动生效。

---

## 下一步

- 查看 [数据同步说明](data-sync.md) 了解同步机制
- 查看 [API 参考](api-reference.md) 了解 API 使用方法
- 查看 [常见问题](faq.md) 获取更多帮助

---

如有其他问题，请在 [GitHub Issues](https://github.com/xuandao/pbRun/issues) 中提出。

# 安全策略

## 报告漏洞

如果你发现安全漏洞，请**不要**公开提交 Issue。请通过以下方式私下报告：

- 使用 GitHub 的 [Private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing/privately-reporting-a-security-vulnerability) 功能，或
- 私信维护者（仓库 Owner）。

我们会在 7 天内确认，并在合理时间内修复与披露。

## 敏感数据处理

本项目的敏感信息**均不入库**（见 `.gitignore`）：

| 数据 | 存放位置 | 说明 |
|------|----------|------|
| Garmin 账号密码 / Token | `cft/garmin/.env`、根 `.env` | 数据同步凭证, gitignored |
| LLM 网关密钥 | `.env` 的 `FREELLMAPI_KEY` | 服务端专用, 不下发客户端 |
| 跑步数据库 | `app/data/activities.db`（外部块存储） | 含个人健康数据, gitignored |
| 本地备份 | `app/data/.backups/` | gitignored |

- LLM 凭证仅在服务端路由（`/api/**`）使用，客户端只通过代理获取模型列表。
- 部署仅监听 `127.0.0.1`，经 Nginx 门户反代，不直接暴露公网。
- 提交前请确认 `git status` 不含 `.env` / `*.db` / 备份文件。

## 支持版本

仅维护 `main` 分支的最新版本。

# 运维手册（本机生产环境）

面向**自有服务器部署**（systemd + Nginx）场景：服务管理、构建陷阱、磁盘清理、数据备份与异地副本。
如果你部署到 Vercel，请看 [部署指南](deployment.md)。

## 目录

- [架构速览](#架构速览)
- [构建陷阱](#构建陷阱)
- [磁盘清理白名单](#磁盘清理白名单)
- [数据库备份与恢复](#数据库备份与恢复)
- [异地副本（OCI 对象存储）](#异地副本oci-对象存储)
- [故障速查](#故障速查)

---

## 架构速览

| 组件 | 说明 |
|------|------|
| 服务 | `pbRun.service`（systemd **user** 单元）：`next start -p 3996 -H 127.0.0.1` |
| 访问 | Nginx 门户 `/pbrun/` → `127.0.0.1:3996`（仅本机监听，不暴露公网） |
| 数据库 | `app/data/activities.db`；`app/data` 是指向块存储 `/mnt/oci-block/pbrun-data` 的**符号链接** |
| 数据同步 | cft cron（每日 08:30 / 13:30 / 22:30）直接写 DB，**不重启服务** |
| MCP | 运行 `mcp-server/dist/`，改源码后须 `npm run build:mcp` 否则跑旧逻辑 |

### 日常命令

```bash
# 非登录 shell（脚本/远程会话）下 systemctl --user 需要显式 runtime 目录
export XDG_RUNTIME_DIR=/run/user/$(id -u)

systemctl --user status pbRun            # 服务状态
journalctl --user -u pbRun -f            # 跟踪日志
bash scripts/deploy-prod.sh              # 部署：pull + 依赖检查 + 停服 + build + 起服 + 健康检查
bash scripts/deploy-prod.sh --verify     # 仅健康检查（首页 200 + 主 CSS 200）
curl -fsS http://127.0.0.1:3996/pbrun     # 首页应为 200
```

---

## 构建陷阱

### 1. `app/data` 是越界软链，Turbopack 拒绝构建

```
Symlink app/data/activities.db is invalid, it points out of the filesystem root
```

`app/data` → `/mnt/oci-block/pbrun-data` 跨出了项目根，Turbopack 会 panic。
`scripts/deploy-prod.sh` 已处理（构建前把软链换成真实空目录、构建后恢复，
且恢复失败会拒绝启动服务）。**手动构建须复用该脚本**，详见
[部署指南 §5](deployment.md)。

### 2. 构建/下载进程输出 `Killed`：cgroup 内存上限（不是整机内存不足）

**现象**：`next build` 跑到一半打印 `Killed`（退出码 137），或 `oci os object get`
下载 GB 级对象时进程消失；此时 `free -h` 显示内存还很充裕。

**根因**：进程所在的 systemd 单元 cgroup 有硬上限。本机 `opencode.service` 的
`memory.limit_in_bytes = 1572864000`（1.5 GiB），Turbopack 构建一超就在**该 cgroup 内**
被 OOM kill，整机 OOM killer 根本不会介入。

**诊断**：

```bash
cat /proc/self/cgroup                    # 当前 shell 属于哪个 cgroup
journalctl -k --since "2 hours ago" | grep -i oom
# 关键行: oom_memcg=/system.slice/opencode.service
#         Memory cgroup out of memory: Killed process ... (node)
```

**解法**：把重活甩进临时 scope（落在 `user.slice`，无内存上限）：

```bash
systemd-run --user --scope -- bash scripts/deploy-prod.sh
# 后台跑并留日志
setsid nohup systemd-run --user --scope -- bash scripts/deploy-prod.sh \
  > /tmp/deploy.log 2>&1 < /dev/null &
```

> 判别要点：日志里出现 `oom_memcg=<某个单元>` 就是 cgroup 限额问题——
> 跟整机 OOM（`dmesg` 里无 `oom_memcg` 或指向 `/`）是两回事，加内存条/清缓存都救不了，
> 必须换 cgroup 跑。

---

## 磁盘清理白名单

实测一次完整清理：根分区 **90% → 76%**（可用 4.8G → 11G）。

### 可安全删除（可再生 / 无效）

| 路径 | 实测大小 | 再生方式 |
|------|----------|----------|
| `.next/cache/`（webpack + swc） | 242M | 下次 `next build` 自动生成；**不影响运行中的服务** |
| `.next/dev/` | 90M | dev server 未运行即可删，`npm run dev` 重建 |
| `coverage/` | 6.4M | `npm run test:coverage` |
| `/tmp/next-panic-*.log` | ~6K | Next panic 日志，排完障即弃 |
| `~/.npm`（含 `_npx`） | 642M | `npm cache clean --force`；`_npx` 删后下次 npx 重下 |
| `~/.cache/pip` | 1.9G | `pip cache purge` |
| `app/data/.backups/` 旧份 | 347M | 见下文保留策略 |
| `app/data/activities.db.bak.<旧时间戳>` | 37M | 同上 |

### 不可删除

| 路径 | 原因 |
|------|------|
| `app/data`（软链本体） | 指向真实 DB，删了服务即挂 |
| `.cache/fit/`（~60M / 316 个） | `sync.js`、`backfill-*.js` 直接读它作 FIT 缓存，删了要重新鉴权拉取 |
| `tests/fixtures/activities.db` | CI / e2e 夹具库，删了测试跑不起来 |
| `mcp-server/dist/` | MCP 进程正在运行的产物 |
| `~/.cache/ms-playwright`（1.9G） | Playwright 浏览器，删了 e2e 要重新下载 |
| `.next/`（除 `cache/`、`dev/` 外） | 生产服务正在使用的构建产物 |

> ⚠️ **判定"无效文件"前先校验**：`u1rescue-20260914.tar.gz.part-*`（3.4G）名字像
> 断掉的分卷，但 `cat 两卷 | gzip -t` 通过、`tar -tzf -` 能列出 198,965 条记录，
> 是**完整有效**的归档；对应的 `/mnt/rescue`、`/mnt/u1rescue` 挂载点已清空，
> 该归档是唯一副本。凭文件名删大文件前，务必先做完整性校验（见下节）。

---

## 数据库备份与恢复

### 1. 每日滚动备份 `app/data/.backups/`

- 形如 `activities-YYYYMMDD-HHMMSS.db.gz`（约 25MB/份），随数据同步流程生成
- **保留策略：最近 3 份即可**。实测删除 11 份旧备份释放 347M；
  注意备份在块存储盘（`/mnt/oci-block`，49G 仅用 4%），清它**不省根盘空间**

```bash
# 恢复（先停服）
export XDG_RUNTIME_DIR=/run/user/$(id -u)
systemctl --user stop pbRun
gunzip -c app/data/.backups/activities-<timestamp>.db.gz > app/data/activities.db
systemctl --user start pbRun
curl -fsS http://127.0.0.1:3996/pbrun   # 确认 200
```

### 2. 脚本级 `.bak.<ts>`

`init:data` / `backfill-*.js` 等破坏性脚本会**先备份再改写**，回滚命令见
[部署指南 Q8](deployment.md)。

---

## 异地副本（OCI 对象存储）

### 凭证与桶

| 项 | 值 |
|----|----|
| CLI | `~/.local/bin/oci`（`oci-cli` 3.89.0） |
| 配置 | `~/.oci/config`，两个 profile：`flz`（ap-singapore-1）、`cdj`（us-phoenix-1） |
| 私钥 | `~/.ssh/flz.pem`（flz）、`~/.ssh/cdj.pem`（cdj） |
| 命名空间 | `axuk2xcglcwj` |

`flz` profile 下的桶（按存储用量计费，桶本身 $0）：

| 桶 | 内容 | 当前用量 |
|----|------|----------|
| `cft-backup` | ubtu1 整机救援归档 | 3.4G / 2 对象 |
| `garmin-fit-backup` | FIT 原始文件 | 82M / 328 对象 |
| `wlj-data-backup` | 数据导出 | 444M / 1 对象 |

### ubtu1 救援归档（`u1rescue-20260914/`）

- **对象**：`u1rescue-20260914/u1rescue-20260914.tar.gz.part-aa`（2,147,483,648 B）
  与 `...part-ab`（1,386,156,097 B），共 3.4G，创建于 2026-09-14
- **内容**：主机 `ubtu1` 的快照（`/etc/hostname=ubtu1`、`machine-id=1eb31ae6…`，
  与本机 `ubtu2` 不同），含 `/home` `/root` `/etc` `/var` 共 198,965 条记录
- **校验值**：本机 `~/u1rescue-20260914.sha256`
  （`part-aa` = `edb91c1d…4de5317`，`part-ab` = `13f9cfda…ae8754e6`）
  上传后做过全量回读校验，云上副本逐位一致

```bash
OCI=~/.local/bin/oci
for p in aa ab; do
  "$OCI" os object get --profile flz -ns axuk2xcglcwj --bucket-name cft-backup \
    --name "u1rescue-20260914/u1rescue-20260914.tar.gz.part-$p" \
    --file "/home/ubuntu/u1rescue-20260914.tar.gz.part-$p"
done
sha256sum -c ~/u1rescue-20260914.sha256   # 清单即按上述绝对路径记录，可直接校验
cat /home/ubuntu/u1rescue-20260914.tar.gz.part-a{a,b} | tar -xzf - -C /restore/target
```

> ⚠️ GB 级对象的上传/下载必须在 scope 里跑（`oci` 读大对象吃内存，
> 会被 `opencode.service` 的 1.5G 限额杀掉），见 [构建陷阱 §2](#2-构建下载进程输出-killedcgroup-内存上限不是整机内存不足)：
>
> ```bash
> setsid nohup systemd-run --user --scope -- bash upload.sh > /tmp/upload.log 2>&1 &
> ```

### 费用

- 计费只看**存储用量**，新建桶不额外收费（新建 vs 放现有，成本一样）
- Always Free 额度：Standard + Infrequent Access + Archive **合计 20G 免费**
  （付费/试用账户标准层 10G 免费）
- 当前合计约 3.8G → **$0**；超出后约 $0.026/GB/月

---

## 故障速查

| 症状 | 排查方向 |
|------|----------|
| `/pbrun` 返回 401/502 | 401 是门户鉴权；502 说明上游没起 → `systemctl --user status pbRun` |
| 全站无样式 / 布局乱 | 上次构建后未重启服务（内存产物与磁盘不一致）→ `deploy-prod.sh --verify` |
| 构建报 `Symlink ... invalid` | [构建陷阱 §1](#1-appdata-是越界软链turbopack-拒绝构建) |
| 构建/下载输出 `Killed` | [构建陷阱 §2](#2-构建下载进程输出-killedcgroup-内存上限不是整机内存不足) |
| 根分区 90%+ | [磁盘清理白名单](#磁盘清理白名单)；大头通常在 `~/.hermes`、`~/.cache`、`/usr`、`/snap` |
| 页面数据是旧的 | 同步只写 DB、无需重启；确认同步完成 → `/api/health?deep=1`，同步细节见 [数据同步说明](data-sync.md) |
| 改了代码但 MCP 行为没变 | `mcp-server/dist` 未重建 → `npm run build:mcp` |

---

返回 [文档中心](README.md)。

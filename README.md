# KIN Gateway

多槽位 Claude 协议网关。非官方协议先转成官方 Messages，再从**虚拟机 UID** 用 CRS HTTP 转发到 Anthropic。默认只换 `device_id` 为槽位 id。

控制台：`https://ccmax20.cc`（[kin-console](https://github.com/dofastted/kin-console)）  
网关：本机 `8787`，无独立域名。

## 转发

```text
客户端 ──Bearer sk-kin-…──► server.mjs
                              │ 选槽 / sticky / 并发
                              │ 协议 → Messages
                              │ 非官方：追加一行官方人设
                              ▼
                         槽 UID 10001+
                              │ 外层 SOCKS5（若已绑）
                              ▼
                         api.anthropic.com
```

| 模式 | 触发 | 说明 |
|------|------|------|
| **relay（默认）** | 不传或 `x-kin-forward: relay` | 槽内读 access token，HTTP 中继 |
| **cli（替补）** | `x-kin-forward: cli`，或 529 / 超时 | 槽内 `claude` 进程。401/403 **不**降级 |

身份：`device_id` = 虚拟机 id；`session_id` 用 CRS hash；`account_uuid` 用 OAuth 账号。

工作区默认 `client`（工具回调用方）。`x-kin-workspace: vm` 才进槽内沙箱。

## 协议

| 路径 | 协议 |
|------|------|
| `POST /v1/messages` | Anthropic Messages |
| `POST /v1/chat/completions` | OpenAI Chat |
| `POST /v1/completions` | OpenAI Completions（旧） |
| `POST /v1/responses` | OpenAI Responses |
| `GET /v1/models` | 槽内 CLI 模型目录 |
| `GET /health` | 健康 / 能力 |

鉴权：`Authorization: Bearer <key>` 或 `x-api-key`。Master `KIN_API_KEY` 无限制；面板发的 `sk-kin-…` 只走协议口。

非官方 system **只追加** `You are Claude Code, Anthropic's official CLI for Claude.`，不整段替换。官方 Claude Code 请求体不改业务内容。

## 凭证

导入 sessionKey → `persistOauthToVm` → 写入槽 `credentials.json`。  
热路径**禁止** `grant_type=refresh_token`。CLI 路径由官方 CLI 续期后 harvest；relay 只读槽内 access。

额度探测从**槽 UID** 发：`GET /api/oauth/usage`（5h / 7d）+ 1 token `claude-fable-5`。fable 429 只标 fable，不摘整号。

详见 [docs/OAUTH.md](docs/OAUTH.md)。

## 目录

```text
src/server.mjs     入口
src/lib/           运行时
src/config/        路由等（密钥不入库）
docs/              OAUTH / PANEL_API
test/              unit · e2e · fixtures
scripts/           sessionKey 导入
```

## 运行

```bash
WorkingDirectory=/opt/kin-gateway
ExecStart=/usr/local/bin/node src/server.mjs

npm test
```

| 变量 | 作用 |
|------|------|
| `KIN_API_KEY` | Master key |
| `KIN_ADMIN_USER` / `KIN_ADMIN_PASSWORD` | 面板登录 |
| `KIN_REQUEST_LOG_MODE` | `off` / `normal` / `debug`（启动优先于 routing.json） |
| `KIN_DB_PATH` | SQLite，默认 `data/kin.db` |
| `KIN_DB_SECRET` | 凭证列 AES-256-GCM |
| `KIN_BACKUP_DISABLED=1` | 关自动备份 |

默认并发 20（账号 / 密钥均可热改）。日志模式也可在控制台设置里改。

数据在 SQLite（WAL）。`vms/*.json` 仍是 OAuth 单写者，写穿入库。本地备份默认 24h，面板可恢复。

面板契约：[docs/PANEL_API.md](docs/PANEL_API.md)。

## 安全

不要提交 OAuth、sessionKey、SOCKS、`gateway-v2.json`。不要给热路径注入长期 `ANTHROPIC_AUTH_TOKEN`。

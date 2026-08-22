# KIN Gateway

多槽位 Claude 协议网关。Node 控制面把非官方协议转成 Messages，再由每槽一个**长驻 Go worker** 通过该槽绑定的 SOCKS5 转发到 Anthropic。

控制台：`https://ccmax20.cc`（[kin-console](https://github.com/dofastted/kin-console)）  
网关：本机 `8787`，无独立域名。

## 转发

```text
客户端 ──Bearer sk-kin-…──► server.mjs
                              │ 选槽 / sticky / 并发
                              │ 协议 → Messages
                              │ 非官方 rewrite：官方 3 块 + 中性扩写
                              │ park：调用方 system → 对话中 role:system
                              ▼
                    Docker 槽位 Go worker
                              │ 唯一 OAuth refresh owner
                              │ 强制对应 SOCKS5
                              ▼
                         api.anthropic.com
```

生产推理仅使用 Go HTTP worker。`x-kin-forward: cli` 和 `x-kin-workspace: vm` 不再启用 Claude CLI。

| 流式交付 | 触发 | 说明 |
|------|------|------|
| **realtime（默认）** | 不传 header | 首个业务事件前可换号；提交后中断只报错，不拼接账号 |
| **verified** | `x-kin-delivery: verified` | 缓冲到 `message_stop`；不完整时继续轮询账号，完成后回放 |

身份：`device_id` = 虚拟机 id；`session_id` 用 CRS hash；`account_uuid` 用 OAuth 账号。

工具在调用方执行；完整 Messages、并行工具、图片、thinking 和 cache control 均由 HTTP 路径保留。

## 协议

| 路径 | 协议 |
|------|------|
| `POST /v1/messages` | Anthropic Messages |
| `POST /v1/chat/completions` | OpenAI Chat |
| `POST /v1/completions` | OpenAI Completions（旧） |
| `POST /v1/responses` | OpenAI Responses |
| `GET /v1/models` | 健康 Go worker 查询的模型目录 |
| `GET /health` | 健康 / 能力 |

鉴权：`Authorization: Bearer <key>` 或 `x-api-key`。Master `KIN_API_KEY` 无限制；面板发的 `sk-kin-…` 只走协议口。

非官方 persona 由 `routing.compatibility.persona_inject` 决定（热读）。`append` 只追加官方一行；现网 `rewrite` 覆盖为官方 3 块（billing + 身份句 + sub2api 中性扩写，不含工具/`# Doing tasks`/`/help`）。`persona_park` 把调用方 system 插到第一个 user 之后，`role:system`（CLIProxy）。官方 Claude Code 请求体不改业务内容。Go worker 原样转发 JSON，不必因此重建槽位进程。

## 凭证

导入 sessionKey 必须经过 VM 绑定的 SOCKS5，换出的凭证交给对应 Go worker 原子写入。Go worker 是唯一 refresh owner，采用锁、重读、临期二次检查、refresh token rotation 和 generation 防覆盖。refresh、inference、usage、models 均使用同一个 SOCKS5，禁止 direct fallback。

账号池按 sticky、priority、负载、平滑 WRR 和 LRU 选择。账号额度耗尽后写入 account/model cooldown，排除该账号并选择下一个，直到终态成功或达到有界 deadline。

详见 [docs/OAUTH.md](docs/OAUTH.md)。

## 目录

```text
src/server.mjs        入口（HTTP 路由 + 控制面装配）
src/lib/core/         config · errors · security · intercept
src/lib/protocol/     协议转换 / 请求清洗 / 模型目录（convert、sanitize、anthropic-*、models…）
src/lib/identity/     槽位身份改写与人设（vm-identity、identity-rewrite、crs-persona、crs-headers）
src/lib/pool/         账号池调度 · failover · 错误策略 · sticky · 配额
src/lib/transport/    Go worker Unix socket 客户端 + 测试 mock
src/lib/vm/           VM 注册 / Docker 运行时 / 文件锁 / DB 镜像 / 代理池
src/lib/oauth/        凭证归一化持久化 · 用量探测
src/lib/admin/        面板 API · API key · 请求日志 · 备份
src/lib/db/           SQLite migrations / repos
worker/               Go 槽位数据面（cmd + internal）
src/config/           路由等（密钥不入库）
docs/                 OAUTH / PANEL_API / 架构对比
test/                 unit · e2e · fixtures（Go 测试在 worker/internal 内）
scripts/              sessionKey 导入
```

生产代码已无 Claude CLI 残留：不再存在 CLI 推理、CLI 凭证 harvest、CLI 模型目录或每请求 Node UID 子进程。

## 运行

```bash
WorkingDirectory=/opt/kin-gateway
ExecStart=/usr/local/bin/node src/server.mjs

npm test
npm run test:go
npm run build:worker
```

| 变量 | 作用 |
|------|------|
| `KIN_API_KEY` | Master key |
| `KIN_ADMIN_USER` / `KIN_ADMIN_PASSWORD` | 面板登录 |
| `KIN_WORKER_BIN` | 静态 Go worker 路径（默认 `/opt/kin-gateway/bin/kin-worker`） |
| `KIN_REQUEST_LOG_MODE` | `off` / `normal` / `debug`（启动优先于 routing.json） |
| `KIN_DB_PATH` | SQLite，默认 `data/kin.db` |
| `KIN_DB_SECRET` | 凭证列 AES-256-GCM |
| `KIN_BACKUP_DISABLED=1` | 关自动备份 |

默认并发 20（账号 / 密钥均可热改）。日志模式也可在控制台设置里改。

数据在 SQLite（WAL）。账号运行态、model/account cooldown 和每次请求 attempt 均持久化；worker 持有活动凭证，数据库保留加密恢复镜像。本地备份默认 24h。

协议数据对齐 Sub2API 的 usage_logs 口径：流式与非流式统一持久化四类 token（输入/输出/缓存读/缓存写，含 5m/1h TTL 细分）、requested/upstream 模型与 mismatch、首 token 延迟和 stop_reason；账号 5h 会话窗口与限流 reset 以结构化列存入 `account_runtime_states`。OpenAI 兼容响应额外携带 `prompt_tokens_details` / `input_tokens_details` 缓存明细。

面板契约：[docs/PANEL_API.md](docs/PANEL_API.md)。

## 文档

- [OAuth 与凭证生命周期](docs/OAUTH.md)
- [面板 API](docs/PANEL_API.md)
- [Claude 转发架构对比](docs/CLAUDE_FORWARDING_COMPARISON.md)：CRS、Sub2API、CLIProxyAPI 与 KIN 的 HTTP 数据面、功能、健壮性和优化路线

## 安全

不要提交 OAuth、sessionKey、SOCKS、worker config 或 `gateway-v2.json`。`KIN_ADMIN_PASSWORD` 必填；managed API key 仅以 HMAC 索引保存，panel session 只持久化 token hash。

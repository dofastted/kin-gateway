# KIN Gateway

多槽位 Claude 协议网关。Node 控制面负责鉴权、协议转换与账号池调度；每个槽位一个**长驻 Go worker**，通过该槽绑定的 SOCKS5 直接转发到 Anthropic。

控制台：`https://ccmax20.cc`（[kin-console](https://github.com/dofastted/kin-console)）
网关：本机 `8787`，无独立域名。

## 快速开始

```bash
curl -s http://127.0.0.1:8787/v1/messages \
  -H "authorization: Bearer $KIN_KEY" \
  -H 'content-type: application/json' \
  -d '{
    "model": "claude-haiku-4-5-20251001",
    "max_tokens": 64,
    "messages": [{ "role": "user", "content": "ping" }]
  }'
```

同一套密钥也可直接调 OpenAI 兼容口（`/v1/chat/completions`、`/v1/responses`、`/v1/completions`）。完整端点、请求头、usage 字段口径和错误码见 **[docs/API.md](docs/API.md)**。

## 转发路径

```text
客户端 ──Bearer sk-kin-…──► server.mjs（Node 控制面）
                              │ 鉴权 / 协议 → Messages（仅转换一次）
                              │ 账号池选槽 / sticky / 并发预留
                              │ 非官方客户端：追加一行官方人设
                              ▼
                    Docker 槽位内的 Go worker
                              │ 唯一 OAuth refresh owner
                              │ 强制使用该槽 SOCKS5，禁止直连
                              │ SSE 终态校验（message_stop）
                              ▼
                         api.anthropic.com
```

生产推理只有这一条路径：不存在 Claude CLI 推理、CLI 凭证 harvest，也不存在每请求 Node 子进程。`x-kin-forward: cli` 被忽略，`x-kin-workspace: vm` 返回 400。

工具在调用方执行。完整多轮消息、并行工具调用、图片、thinking、`cache_control` 与采样参数由 HTTP 路径原样保留。

身份改写：`device_id` = 槽位 ID，`account_uuid` = 真实 OAuth 账号，`session_id` = hash(账号 + 调用方会话)。

## 流式交付

| 模式 | 触发 | 语义 |
|------|------|------|
| **realtime**（默认） | 不传头 | 低 TTFT。首个业务事件提交前可换号；提交后中断只补发协议内 `error`，绝不拼接另一个账号的输出 |
| **verified** | `x-kin-delivery: verified` | 缓冲到 `message_stop` 再回放；不完整则换号重试，实现"完整或有界耗尽" |

## 账号池

选号顺序：健康 sticky → 优先级 → 最小负载 → 平滑 WRR → LRU，选中后原子预留并发额度。

账号额度耗尽或上游报错时按错误域处理：请求级错误直接返回（不污染账号池）、模型级只冷却该模型、账号级冷却至 reset、代理/上游故障短冷却后换号。重试严格有界（默认最多 10 次换号 / 12 次尝试 / 120s deadline），sticky 只在终态成功后提交。

## 凭证

sessionKey 导入必须经过槽位绑定的 SOCKS5，换出的凭证交由对应 Go worker 原子写入。worker 是该账号唯一 refresh owner，采用 singleflight + 文件锁 + 锁内重读 + 临期二次确认 + refresh token 轮换 + generation 防覆盖。refresh、inference、usage、models 共用同一个 SOCKS5，代理失败时槽位 fail closed，不允许直连。

详见 [docs/OAUTH.md](docs/OAUTH.md)。

## 数据与用量

数据落在 SQLite（WAL）：账号运行态、account/model cooldown、每次请求 attempt 链、请求日志、受管密钥与备份记录。活动凭证由 worker 持有，数据库只保留可加密的恢复镜像。本地备份默认 24h 一次。

协议数据口径对齐 Sub2API 的 `usage_logs`：

- 流式与非流式统一持久化四类 token —— 输入 / 输出 / 缓存读 / 缓存写（含 5m、1h TTL 细分）；
- 记录 `requested_model`、`upstream_model` 与三态 mismatch 观测；
- 记录首 token 延迟（流式实测）与 `stop_reason`；
- 账号 5h 会话窗口与限流 reset 以结构化列存入 `account_runtime_states`；
- 一次请求即使经历多次换号，usage 只按最终成功的 attempt 计一遍；
- OpenAI 兼容响应额外输出 `prompt_tokens_details` / `input_tokens_details` 缓存明细。

面板契约见 [docs/PANEL_API.md](docs/PANEL_API.md)。

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
docs/                 API / OAUTH / PANEL_API / 架构对比
test/                 unit · e2e · fixtures（Go 测试在 worker/internal 内）
scripts/              sessionKey 导入
```

## 运行

```bash
WorkingDirectory=/opt/kin-gateway
ExecStart=/usr/local/bin/node src/server.mjs

npm test              # Node 单测 + e2e
npm run test:go       # Go worker 测试
npm run test:all      # 两者
npm run build:worker  # 构建静态 Go worker → bin/kin-worker
```

| 变量 | 作用 |
|------|------|
| `KIN_API_KEY` | Master key（无限制，可访问 admin/面板） |
| `KIN_ADMIN_USER` / `KIN_ADMIN_PASSWORD` | 面板登录，密码必填 |
| `KIN_WORKER_BIN` | 静态 Go worker 路径（默认 `/opt/kin-gateway/bin/kin-worker`） |
| `KIN_REQUEST_LOG_MODE` | `off` / `normal` / `debug`（启动时优先于 routing.json） |
| `KIN_DB_PATH` | SQLite 路径，默认 `data/kin.db` |
| `KIN_DB_SECRET` | 凭证列 AES-256-GCM 加密密钥 |
| `KIN_BACKUP_DISABLED=1` | 关闭自动备份 |

默认单账号/单密钥并发 20，池化与 failover 参数在 `src/config/routing.json`，也可在控制台热更新（含日志级别）。

## 文档

- [客户端 API](docs/API.md)：端点、请求头、usage 字段、错误码、流式与失败重试语义
- [OAuth 与凭证生命周期](docs/OAUTH.md)
- [面板 API](docs/PANEL_API.md)
- [Claude 转发架构对比](docs/CLAUDE_FORWARDING_COMPARISON.md)：CRS、Sub2API、CLIProxyAPI 与 KIN 的 HTTP 数据面、功能、健壮性和优化路线

## 安全

不要提交 OAuth、sessionKey、SOCKS、worker config 或 `gateway-v2.json`。`KIN_ADMIN_PASSWORD` 必填；受管 API key 仅以 HMAC 索引存储（明文不落库），面板 session 只持久化 token hash。

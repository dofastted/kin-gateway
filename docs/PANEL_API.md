# 面板 API

基址 `/api/panel`。需要**面板登录会话**或 Master `KIN_API_KEY`。`sk-kin-…` 不能调面板。

登录：`POST /api/panel/login` `{ username, password }` → token / Cookie。

## 槽位 / 用量

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/dashboard` | 总览（含 `proxy_pool` 摘要） |
| GET | `/vms` | 列表（含 `has_token`、`cred_status`、`proxy_configured`、`can_import_credential`） |
| GET | `/vms/:id` | 详情（合并代理池健康 + `proxy_pool`） |
| POST | `/vms/:id/probe` | 对应 Go worker 经槽位 SOCKS5 探测 usage + fable |
| POST | `/vms/:id/oauth/refresh` | 对应 Go worker ensure/force refresh |
| POST | `/probe` | 全量探测 |
| GET | `/usage` | 用量汇总 |
| GET | `/models` | 健康 Go worker 的模型目录 |
| GET | `/routing` | sticky / pool / failover / 并发 / 额度 / logging |
| PUT | `/routing` | 热更新 pool/failover；`logging.mode` = off\|normal\|debug |

`cred_status`：`无凭证` / `可用` / `5h 限制` / `7d 限制` / `Fable 限制` / `不可用`。

## 密钥 / 日志

| 方法 | 路径 |
|------|------|
| GET/POST | `/api-keys` |
| PATCH/DELETE | `/api-keys/:id` |
| GET | `/request-logs` |
| GET | `/request-logs/stats` |
| GET | `/request-logs/:request_id` |
| GET | `/request-logs/:request_id/attempts` |

attempts 包含每次选中的 VM/账号、错误域、cooldown、响应提交边界和终态。日志：`normal` 摘要；`debug` 另存脱敏 body 快照。`X-Request-ID` 回写响应头。

### 请求日志协议字段（与 Sub2API usage_logs 对齐）

每行摘要除 `input_tokens` / `output_tokens` 外还包含：

| 字段 | 说明 |
|------|------|
| `cache_read_tokens` / `cache_creation_tokens` | 提示缓存读取 / 写入 token |
| `cache_creation_5m_tokens` / `cache_creation_1h_tokens` | 缓存写入 TTL 细分（无细分时归入 5m） |
| `requested_model` / `upstream_model` / `model_mismatch` | 客户端请求模型、上游响应声明模型、三态不一致观测（null=上游未声明） |
| `first_token_ms` | 首个业务事件延迟（流式实测；由 worker 数据面回传） |
| `stop_reason` | Anthropic 终态 stop_reason（流式来自 `message_delta`） |

流式请求的 usage 由 Go worker SSE 校验器合并后经 `X-Kin-Usage`/`X-Kin-Model`/`X-Kin-Stop-Reason` trailer 回传，与非流式同样只在终态 attempt 记一次。`/dashboard`、`/usage`、`/request-logs/stats` 的汇总均含缓存 token；`/vms/:id` 的 `account.runtime_window` 提供结构化 5h 会话窗口与限流 reset（`rate_limited_at` / `rate_limit_reset_at` / `overload_until` / `session_window_start|end|status`）。

## 备份 / 代理

| 方法 | 路径 |
|------|------|
| GET/POST | `/backups` |
| GET | `/backups/:id/download` |
| POST | `/backups/:id/restore` 须 `{ "confirm": true }` |
| GET/POST/PUT/DELETE | `/proxies…` |

恢复期间协议口 503。每个槽位必须绑定 SOCKS5；Go worker 在槽位容器内显式使用该代理，失败时不直连。

### 虚拟机代理字段

`/dashboard`、`/vms`、`/vms/:id` 的 VM 对象含：

| 字段 | 说明 |
|------|------|
| `proxy_configured` | 是否已绑定 SOCKS5 |
| `can_import_credential` | 是否允许 sessionKey 转换（绑定且代理非 fail/dead） |
| `proxy.status` / `enabled` / `latency_ms` / `last_error` / `last_probe_at` | 来自代理池的健康快照 |

`proxy_pool` 摘要：`{ total, free, bound, ok, dead, probing, disconnect_on_error }`。

sessionKey 导入必须走该槽 SOCKS5。生产忽略 `require_proxy: false`（仅 `KIN_CRS_MOCK=1` 的测试可绕过）。

### 代理池实验开关

`PUT /proxies/config` 可写 `disconnect_on_error`（默认 `false`）。打开后，运行时 SOCKS5 传输错误会立刻停该槽调度、回写代理失败，并重建 worker 以断开半开连接；其它健康槽仍可 failover。

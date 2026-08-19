# 面板 API

基址 `/api/panel`。需要**面板登录会话**或 Master `KIN_API_KEY`。`sk-kin-…` 不能调面板。

登录：`POST /api/panel/login` `{ username, password }` → token / Cookie。

## 槽位 / 用量

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/dashboard` | 总览 |
| GET | `/vms` | 列表（含 `has_token`、`cred_status`、5h/7d/fable） |
| GET | `/vms/:id` | 详情 |
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

### 请求日志协议字段

与 Sub2API `usage_logs` 对齐。

每行摘要除 `input_tokens` / `output_tokens` 外还包含：

| 字段 | 说明 |
|------|------|
| `cache_read_tokens` / `cache_creation_tokens` | 提示缓存读取 / 写入 token |
| `cache_creation_5m_tokens` / `cache_creation_1h_tokens` | 缓存写入 TTL 细分（无细分时归入 5m） |
| `requested_model` / `upstream_model` / `model_mismatch` | 客户端请求模型、上游响应声明模型、三态不一致观测（null=上游未声明） |
| `first_token_ms` | 首个业务事件延迟（流式实测；由 worker 数据面回传） |
| `stop_reason` | Anthropic 终态 stop_reason（流式来自 `message_delta`） |

流式请求的 usage 由 Go worker 的 SSE 校验器合并后经 `X-Kin-Usage` / `X-Kin-Model` / `X-Kin-Stop-Reason` trailer 回传，与非流式同样只在终态 attempt 记一次。客户端可见的 usage 字段映射见 [API.md](API.md#4-usage-字段口径)。

### 汇总口径

| 端点 | 汇总字段 |
|------|----------|
| `/request-logs/stats` | `totals` 与每个 `buckets[]`：`requests`、`errors`、`input_tokens`、`output_tokens`、`cache_read_tokens`、`cache_creation_tokens`、`avg_duration_ms`、`avg_first_token_ms` |
| `/usage` | 每账号 + `totals`：`requests`、`tokens_in`、`tokens_out`、`cache_read_tokens`、`cache_creation_tokens`、`peak_5h`、`peak_7d`、`near_limit` |
| `/dashboard` | `summary` 同上（含缓存 token），另有 `db_totals`（直接来自 `request_logs` 表，重启不丢） |

### 账号运行态窗口

`/vms/:id` 的 `account.runtime_window` 来自 `account_runtime_states`，提供结构化的限流与会话窗口（毫秒时间戳）：

```json
{
  "rate_limited_at": null,
  "rate_limit_reset_at": null,
  "overload_until": null,
  "session_window_start": null,
  "session_window_end": null,
  "session_window_status": "active"
}
```

`rate_limited_at` / `rate_limit_reset_at` 在账号级 429 冷却时写入，`overload_until` 对应 529/上游过载，`session_window_*` 由 5h 窗口 reset 反推得到（`start = end - 5h`）。

## 备份 / 代理

| 方法 | 路径 |
|------|------|
| GET/POST | `/backups` |
| GET | `/backups/:id/download` |
| POST | `/backups/:id/restore` 须 `{ "confirm": true }` |
| GET/POST/PUT/DELETE | `/proxies…` |

恢复期间协议口 503。每个槽位必须绑定 SOCKS5；Go worker 在槽位容器内显式使用该代理，失败时不直连。

# 客户端 API

KIN Gateway 对外暴露 **Anthropic Messages** 与 **OpenAI 兼容** 两套协议口。所有请求都在网关内被转换成官方 Messages 形状，再由目标槽位的 Go worker 经该槽绑定的 SOCKS5 发往 `api.anthropic.com`。

基址默认 `http://127.0.0.1:8787`（`PUBLIC_BASE_URL` 可覆盖）。

## 1. 鉴权

两种等价写法：

```bash
Authorization: Bearer sk-kin-xxxxxxxx
x-api-key: sk-kin-xxxxxxxx
```

| 密钥 | 来源 | 限制 |
|------|------|------|
| Master key | 环境变量 `KIN_API_KEY` | 无并发/额度/RPM 限制，可访问 `/admin/*` 与面板 API |
| 受管密钥 `sk-kin-…` | 控制台创建 | 只能访问协议口，受并发、总额度、RPM 和有效期约束 |

受管密钥在库中只保存 HMAC 索引与前后缀，创建后无法再次明文读取。

缺失或无效密钥：

```json
{
  "error": {
    "type": "authentication_error",
    "code": "missing_api_key",
    "message": "Missing credentials. Login at /api/panel/login or provide Authorization Bearer token."
  }
}
```

## 2. 端点

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/v1/messages`（别名 `/messages`） | Anthropic Messages，原生透传 |
| POST | `/v1/chat/completions`（别名 `/chat/completions`） | OpenAI Chat Completions |
| POST | `/v1/responses`（别名 `/responses`） | OpenAI Responses |
| POST | `/v1/completions`（别名 `/completions`） | OpenAI 旧版 Completions |
| GET | `/v1/models` | 由健康 Go worker 拉取的官方模型目录 |
| GET | `/health`、`/v1/meta` | 状态、能力声明与限制说明 |

模型只接受官方 Claude 名称。支持家族别名（`sonnet` / `opus` / `haiku`）与供应商前缀（`anthropic/claude-sonnet-5`、`openrouter/anthropic/…`），网关会归一化为目录中的具体 ID。非 Claude 模型直接拒绝，不产生上游请求：

```json
{
  "error": {
    "type": "invalid_request_error",
    "code": "model_not_supported",
    "message": "model 'gpt-4o' is not supported. Only official Claude models are accepted.",
    "param": "model"
  }
}
```

## 3. 请求示例

### Anthropic Messages（非流式）

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

```json
{
  "type": "message",
  "id": "msg_01…",
  "role": "assistant",
  "model": "claude-haiku-4-5-20251001",
  "content": [{ "type": "text", "text": "pong" }],
  "stop_reason": "end_turn",
  "usage": {
    "input_tokens": 12,
    "output_tokens": 4,
    "cache_read_input_tokens": 3,
    "cache_creation_input_tokens": 5,
    "cache_creation": {
      "ephemeral_5m_input_tokens": 5,
      "ephemeral_1h_input_tokens": 0
    }
  }
}
```

工具、并行工具调用、图片块、thinking、`cache_control`、`context_management`、采样参数、`stop_sequences`、`tool_choice` 全部原样透传，多轮历史完整保留。工具由调用方执行——网关不执行任何工具。

### 流式

```bash
curl -N http://127.0.0.1:8787/v1/messages \
  -H "authorization: Bearer $KIN_KEY" \
  -H 'content-type: application/json' \
  -d '{ "model": "claude-haiku-4-5-20251001", "max_tokens": 64, "stream": true,
        "messages": [{ "role": "user", "content": "ping" }] }'
```

返回标准 Anthropic SSE 序列，且由 worker 校验完整终态：

```text
event: message_start        → 含 model 与初始 usage
event: content_block_start
event: content_block_delta  → text_delta / thinking_delta / input_json_delta
event: content_block_stop
event: message_delta        → stop_reason + 最终 usage
event: message_stop         → 终态；缺失即判定 incomplete
```

OpenAI 协议口的流以 `data: [DONE]` 收尾。

### OpenAI Chat Completions

```bash
curl -s http://127.0.0.1:8787/v1/chat/completions \
  -H "authorization: Bearer $KIN_KEY" \
  -H 'content-type: application/json' \
  -d '{ "model": "claude-haiku-4-5-20251001", "max_tokens": 64,
        "messages": [{ "role": "user", "content": "ping" }] }'
```

```json
{
  "id": "chatcmpl-msg_01…",
  "object": "chat.completion",
  "created": 1787150481,
  "model": "claude-haiku-4-5-20251001",
  "choices": [{ "index": 0, "message": { "role": "assistant", "content": "pong" }, "finish_reason": "stop" }],
  "usage": {
    "prompt_tokens": 12,
    "completion_tokens": 4,
    "total_tokens": 16,
    "prompt_tokens_details": { "cached_tokens": 3, "cache_creation_tokens": 5 }
  }
}
```

### OpenAI Responses

```bash
curl -s http://127.0.0.1:8787/v1/responses \
  -H "authorization: Bearer $KIN_KEY" \
  -H 'content-type: application/json' \
  -d '{ "model": "claude-haiku-4-5-20251001", "max_output_tokens": 64, "input": "ping" }'
```

响应含 `output`、`output_text` 与 `usage.input_tokens_details`（结构同上）。

## 4. usage 字段口径

Messages 口原样返回 Anthropic 的 `usage`；OpenAI 口在保持原有 token 总数语义的前提下**追加**缓存明细字段。

| Anthropic | OpenAI Chat | OpenAI Responses | 含义 |
|---|---|---|---|
| `input_tokens` | `prompt_tokens` | `input_tokens` | 非缓存输入 token |
| `output_tokens` | `completion_tokens` | `output_tokens` | 输出 token |
| `cache_read_input_tokens` | `prompt_tokens_details.cached_tokens` | `input_tokens_details.cached_tokens` | 命中提示缓存读取的 token |
| `cache_creation_input_tokens` | `prompt_tokens_details.cache_creation_tokens` | `input_tokens_details.cache_creation_tokens` | 写入提示缓存的 token |
| `cache_creation.ephemeral_5m_input_tokens` / `…_1h_…` | — | — | 缓存写入按 TTL 细分 |

要点：

- `prompt_tokens` / `input_tokens` **不包含**缓存 token，与 Anthropic 口径一致；缓存量只出现在明细字段里。
- 明细字段为零时整体省略（omit-when-zero），不会输出 `0` 噪声。
- 流式请求的 usage 由 worker 的 SSE 校验器跨事件合并（`message_start` + `message_delta`），因此流式与非流式的计量完全一致。
- 同一请求即使经历多次账号轮换，usage 只按最终成功的那次计一遍。
- 服务端侧的持久化字段（含 TTL 细分、首 token 延迟、上游模型等）见 [PANEL_API.md](PANEL_API.md#请求日志协议字段)。

## 5. 请求头

| 头 | 取值 | 作用 |
|---|---|---|
| `x-kin-delivery` | `realtime`（默认）/ `verified` | 流式交付模式，见下节 |
| `x-session-id`（或 `x-conversation-id`、`session_id` 等，见 `src/config/routing.json`） | 任意字符串 | 会话粘滞键；同一会话优先复用上次成功的账号 |
| `x-kin-debug` | `1` | 响应追加 `kin` 调试块，并将本次请求日志提升为 debug 模式 |
| `x-kin-log` | `off` / `normal` / `debug` | 单请求覆盖日志级别 |
| `x-kin-rewrite` | `1` | 打开模型/协议改写（默认关） |
| `x-kin-strict-passthrough` | `1` | 严格透传模式，不做兼容性补齐 |
| `x-request-id` | 任意字符串 | 自定义请求 ID；否则网关生成 UUID |

响应固定回写 `x-request-id`，用于关联请求日志和 attempt 链。

`x-kin-debug: 1` 时的附加块：

```json
{
  "kin": {
    "vm_id": "vm-01",
    "account_id": "acct-…",
    "attempts": 1,
    "terminal_state": "verified"
  }
}
```

已移除的头：`x-kin-workspace: vm`（返回 400 `vm_workspace_removed`）；`x-kin-forward: cli` 被忽略——生产推理只有 Go worker 一条路径。

## 6. 流式交付模式

| 模式 | 触发 | 行为 |
|---|---|---|
| `realtime`（默认） | 不传头 | 低 TTFT。首个业务事件下发**之前**可自由切换账号；一旦已向客户端提交内容，出现中断只补发协议内 `error` 事件并记为 `incomplete`，绝不拼接第二个账号的输出 |
| `verified` | `x-kin-delivery: verified` | worker 先缓冲到 `message_stop` 再回放。不完整则换下一个账号重试，直到拿到完整响应或账号池有界耗尽。牺牲 TTFT 换取"完整或失败"语义 |

非流式请求天然按 `verified` 语义处理：只有结构合法的完整 JSON 响应才算成功。

## 7. 账号池与失败重试

一次请求的生命周期：

```text
协议转换（仅一次，产出 canonical request）
   → 选账号：健康 sticky → 优先级 → 最小负载 → 平滑 WRR → LRU
   → 按该账号重建身份/头，重放 canonical request
   → 分类上游结果 → 需要时冷却并排除该账号 → 换号重试
   → 终态成功后才提交 sticky 绑定与 usage 计费
```

错误分域决定行为，避免"一个坏请求毒化整个账号池"：

| 上游情况 | 处理 |
|---|---|
| 400 普通参数错误 | 直接返回，不换号 |
| 400 thinking/tool signature 可修复 | 修复后重试一次 |
| 401 | worker 强制刷新一次；仍失败则该凭证冷却并换号 |
| 403 组织禁用 | 账号级冷却 |
| 429 请求级/权益类 | 直接返回，不冷却账号 |
| 429 模型级 | 仅冷却该模型 |
| 429 5h/7d 额度 | 账号级冷却至 reset |
| 529 / 5xx / 传输失败 | provider/proxy 短冷却，可换号 |
| 客户端取消 | 不处罚账号 |

失败重试严格有界：最多 10 次换号、12 次尝试、120s 总 deadline（`src/config/routing.json` 可调，也可在控制台热更新）。池耗尽时返回稳定的分类错误，永不无限循环。

## 8. 错误响应

统一结构：

```json
{
  "error": {
    "type": "invalid_request_error",
    "code": "invalid_messages",
    "message": "messages must be an array",
    "param": "messages",
    "details": {},
    "request_id": "…"
  }
}
```

`type` 取值：`authentication_error`、`permission_error`、`invalid_request_error`、`not_found_error`、`rate_limit_error`、`quota_error`、`upstream_error`、`api_error`、`overloaded_error`、`timeout_error`、`protocol_error`。

常见 `code`：

| 状态 | code | 说明 |
|---|---|---|
| 401 | `missing_api_key` / `invalid_api_key` | 鉴权失败 |
| 400 | `invalid_json` / `invalid_messages` / `model_required` / `model_not_supported` | 请求体或模型不合法 |
| 400 | `vm_workspace_removed` | 使用了已移除的 VM workspace |
| 403 | `api_key_disabled` / `api_key_expired` | 受管密钥不可用 |
| 429 | `api_key_rate_limit` / `api_key_quota_exhausted` / `api_key_concurrency_limit` | 受管密钥的 RPM / 总额度 / 并发限制 |
| 429 | `gateway_rate_limit` | 网关整体令牌桶限流 |
| 429 | `upstream_rate_limit` | 上游限流且账号池已耗尽 |
| 503 | `account_pool_exhausted` | 无可调度账号；`details.reason` 为 `no_eligible_accounts` 或 `all_accounts_busy` |
| 503 | `pool_deadline_exceeded` / `max_account_switches_exceeded` | 超出重试预算 |
| 5xx | `upstream_error` / `upstream_overloaded` / `upstream_timeout` | 上游异常 |

账号额度安全线（默认 95%，`quota.safety_ratio`）不会直接返回给客户端：命中安全线的账号会被判定为不可调度，网关继续尝试其他账号；只有全部账号都不可用时才返回 503 `account_pool_exhausted`。

流式请求若在提交内容后失败，HTTP 状态仍是 200，错误以协议内 `error` 事件下发，同时请求日志记为 `stream_incomplete`。

## 9. 兼容性说明

- 非官方客户端的 system 提示**只追加**一行官方身份声明，不整段替换；官方 Claude Code 请求体的业务内容不做改动。
- 工具名在需要时做双向映射（OpenAI/Codex 风格 → 官方名），响应与 SSE 中会还原为调用方原始名称。
- 请求清洗遵循 Sub2API 的分层做法：清理空文本块、限制 `cache_control` 数量与 TTL 顺序、过滤无效 thinking signature、修正预算约束。
- 每次账号轮换都从 canonical request 重新构造，不会在已变换的请求体上二次叠加。

## 10. 相关文档

- [OAuth 与凭证生命周期](OAUTH.md)
- [面板 API](PANEL_API.md)
- [Claude 转发架构对比](CLAUDE_FORWARDING_COMPARISON.md)

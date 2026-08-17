# KIN OAuth：session 导入 + CLI 自主续期

对照 [Wei-Shaw/sub2api](https://github.com/Wei-Shaw/sub2api) 只借 **换票与导入**，不借伪装，**不借网关侧 refresh 热路径**。

## 为什么不能和 sub2api 一样用 refresh_token 热刷新

sub2api 自己是 Anthropic 的 HTTP 客户端，所以它必须 `grant_type=refresh_token`。

KIN 的出口是虚拟机里的 **官方 Claude Code**。CLI 会读 `credentials.json` 并自己换票。
网关再打同一条 `refresh_token` = 和 CLI 抢票。Anthropic 会轮换/一次性消费 refresh，
抢一次就是 `invalid_grant`，整户作废。

## 最终生命周期

```
sessionKey（导入 / CookieAuth 恢复）
        │ CookieAuth + PKCE + Chrome TLS（curl_cffi）
        ▼
access (~8h) + refresh
        │ 写入 vm json（含 session_key）
        │ force 播种 credentials.json
        ▼
官方 claude -p  ← 唯一刷新者
        │ CLI 自行 refresh，并轮换 refresh_token
        ▼
harvest credentials.json → 回写 vm + 内存
        │
        └─ 仅当 access 缺失且仍有 session_key
             → 再跑一遍 CookieAuth（不用 refresh_token）
```

| 步骤 | sub2api | KIN |
|---|---|---|
| 导入 | CookieAuth + ImpersonateChrome | 同三步 + `curl_cffi` chrome TLS |
| 续期主体 | 自己 `ClaudeTokenRefresher` | **官方 CLI** |
| 网关换票 | 每请求 `RefreshIfNeeded` | **永不** `grant_type=refresh_token` |
| 到期窗口 | 3 min skew 主动刷新 | 只 harvest；CLI 自己换 |
| 状态探测 | 网关自己打 Anthropic | **`claude auth status --json`**（kincli + VM HOME） |
| 用量探测 | `GET /api/oauth/usage` + 伪装 UA | 官方 hop 的 `rate_limit_event` |
| 恢复 | invalid_grant → 人工 | 存盘 sessionKey → CookieAuth 再导入 |
| 环境变量 | access 当 Bearer | **禁止** `ANTHROPIC_AUTH_TOKEN` |
| `refreshOAuthToken()` | 自己换票 | **永久抛错**（`refresh_token_disabled`） |

## 探测必须走虚拟机 Claude Code

网关**禁止**再自己 `fetch` Anthropic 用量接口或伪装 CLI UA。模型列表同样只信 VM 官方 Claude Code 的目录，不打 Anthropic models。`refreshOAuthToken` 已禁用，恢复只走 sessionKey CookieAuth。

| 能力 | 官方入口 | 频率 |
|---|---|---|
| 登录 / 邮箱 / org | `claude auth status --json` | GET oauth 时现场跑 |
| access 是否仍在 | harvest `credentials.json` | 每请求 + 60s 循环 |
| 5h / 7d | stream-json `rate_limit_event` | 每次官方 `claude -p`；POST probe 可加一次小 hop |
| 该不该换票 | CLI 自己决定 | 网关 `needs_refresh` 只展示，5min 偏斜，**不触发** refresh |

`rate_limit_event` 给的是 `status` / `resetsAt` / `rateLimitType`，没有 utilization 百分比。
不要用伪装 `/oauth/usage` 去补这个数字。

## 运维

- `GET /admin/vm/oauth`：ttl / last / has_session_key + **CLI `auth status`**（无 token）
- `POST /admin/vm/oauth/refresh`：只 harvest，不打 Anthropic
- `POST /admin/vms/:id/probe`：`claude auth status` + 一次官方小 hop（`{hop:false}` 可关 hop）
- 后台 60s 循环：只 harvest
- 导入后 **不要** force-refresh
- CLI oauth 失败且 sessionKey 也死 → 401 `oauth_need_reimport`

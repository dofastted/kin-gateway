# KIN OAuth：session 导入 + CLI 主导续期

对照 [Wei-Shaw/sub2api](https://github.com/Wei-Shaw/sub2api) 只借 **换票**，不借伪装。

sub2api 自己就是 HTTP 客户端，所以它必须 `grant_type=refresh_token`。
KIN 的出口是虚拟机里的 **官方 Claude Code**，CLI 会读 `credentials.json` 并自己换票（Anthropic 会轮换 refresh_token）。
网关再打同一条 refresh_token = 和 CLI 抢票 → `invalid_grant`，整户作废。

```
sessionKey (sk-ant-sid*)          ← 只在导入 / invalid_grant 后用
        │ CookieAuth + PKCE
        │ Chrome TLS (curl_cffi) + SOCKS   // 过 claude.ai CF
        ▼
access_token (~8h) + refresh_token
        │ 写入 vm-*.json + 强制播种 credentials.json
        │ 丢弃 sessionKey（热路径不用）
        ▼
官方 claude -p  （主刷新者）
        │ CLI 自行 refresh 并轮换 refresh_token
        ▼
harvest credentials.json → 回写 vm json + 内存
        │
        └─ 仅当「没有 CLI home」或 access 已完全过期
           才由网关 POST api.anthropic.com  grant_type=refresh_token
           （无 CF、无 Chrome、无 SOCKS、不用 sessionKey）
```

| 步骤 | sub2api | KIN |
|---|---|---|
| 导入 | `CookieAuth`：orgs → authorize → token | 同三步；**curl_cffi chrome131** 过 CF |
| 导入 HTTP | `req.ImpersonateChrome()` + 可选 SOCKS | `scripts/session-import-cffi.py` + SOCKS；node-fetch 仅兜底 |
| 续期主体 | 自己 `ClaudeTokenRefresher` | **官方 CLI**（credentials.json） |
| 网关续期 | 每请求 `RefreshIfNeeded` | 只在 access 已过期且 CLI 没先换到时作备份 |
| 续期端点 | `platform.claude.com/v1/oauth/token` | 备份路径先 `api.anthropic.com`（无 CF） |
| 续期凭证 | **只用 refresh_token** | 同；**不用 sessionKey** |
| 锁 | 进程锁 + Redis + DB 重读 + `_token_version` | 进程锁 + 读 vm json + harvest + `_token_version` |
| 窗口 | 3 min skew | 5 min；窗口内 **defer_to_cli**，不抢票 |
| 出站身份 | 自己仿官方 HTTP | VM 官方 Claude Code |
| 环境变量 | 把 access 当 Bearer | **禁止** `ANTHROPIC_AUTH_TOKEN`（会跳过 CLI 刷新） |
| 写 credentials | 无（自己发 HTTP） | 只在「磁盘不比入参新 / 不是同窗轮换」时覆盖；导入时 `force` 播种 |

`invalid_grant` → 401 `oauth_need_reimport`，需重新 POST `/api/panel/vms/import` 带新 sessionKey。
已标记 `need_reimport` 时热路径不再打 refresh，避免继续烧票。

运维：

- `GET /admin/vm/oauth` 看 ttl / last / need_reimport（无 token）
- `POST /admin/vm/oauth/refresh` 默认 **不 force**（先 harvest / defer）；`{ "force": true }` 才由网关换票
- 后台每 60s 带 cli-home 预检查，不改并发
- **导入后不要立刻 force-refresh**（会消费刚拿到的 refresh_token）

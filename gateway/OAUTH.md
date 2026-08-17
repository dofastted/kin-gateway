# KIN OAuth：session 导入 + refresh_token 续期

对照 [Wei-Shaw/sub2api](https://github.com/Wei-Shaw/sub2api) 只借 **换票与续期**，不借伪装。

```
sessionKey (sk-ant-sid*)          ← 只在导入 / invalid_grant 后用
        │ CookieAuth + PKCE
        ▼
access_token (~8h) + refresh_token
        │ 到期前 skew（5min）
        │ POST /v1/oauth/token  grant_type=refresh_token
        ▼
写回 vm-*.json + 内存 cfg + credentials.json
        │ 不注入 ANTHROPIC_AUTH_TOKEN
        ▼
VM 官方 claude -p
        │ CLI 若自行刷新
        ▼
harvest credentials.json → 回写 vm json
```

| 步骤 | sub2api | KIN |
|---|---|---|
| 导入 | `CookieAuth`：orgs → authorize → token | 同三步 `sessionKeyToOAuth` |
| 导入 HTTP | `req.ImpersonateChrome()` + 可选 SOCKS | `node-fetch`；claude.ai 过 CF 需 Chrome TLS / 可用代理 |
| 续期 | `ClaudeTokenRefresher` + `RefreshIfNeeded`（锁 + DB 重读） | `oauthGuard.ensureFresh`（进程内锁 + 写 vm json） |
| 续期端点 | `platform.claude.com/v1/oauth/token` | 先 `api.anthropic.com`（无 CF），失败再 platform |
| 续期凭证 | **只用 refresh_token** | 同；**不用 sessionKey** |
| 窗口 | 3 min skew | 5 min |
| 出站身份 | 自己仿官方 HTTP | VM 官方 Claude Code |
| 环境变量 | 把 access 当 Bearer | **禁止** `ANTHROPIC_AUTH_TOKEN`（会跳过 CLI 刷新） |

`invalid_grant` → 401 `oauth_need_reimport`，需重新 POST `/api/panel/vms/import` 带新 sessionKey。

运维：

- `GET /admin/vm/oauth` 看 ttl / last（无 token）
- `POST /admin/vm/oauth/refresh` `{ "force": true }`
- 后台每 60s 预刷新，不改并发

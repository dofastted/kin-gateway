# 凭证

对照 CRS / sub2api：只借导入换票，不借网关 `refresh_token`。

```text
sessionKey ──CookieAuth──► access + refresh
                 │ persistOauthToVm + 槽 credentials.json
                 ▼
         relay：读 access，UID HTTP 出站
         cli ：官方 claude 自己续期，网关只 harvest
```

| 禁止 | 原因 |
|------|------|
| 热路径 `grant_type=refresh_token` | 和 CLI 抢票会废号 |
| 宿主机带 OAuth 打 Anthropic | 身份不在槽上 |
| 用探测结果当「过期」去清空凭证 | 拒号 ≠ 文件被清空 |

探测（面板「额度探测」）必须从槽 UID 发出：

- `GET /api/oauth/usage` → 5h / 7d / extra
- `claude-fable-5` 1 token → fable 周限额

`POST /admin/vm/oauth/refresh` 只 harvest，不换票。access 没了且还有 sessionKey 才再走 CookieAuth。

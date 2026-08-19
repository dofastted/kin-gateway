# OAuth 凭证生命周期

每个 VM/槽位的 Go worker 是该账号的**唯一 refresh owner**。

```text
sessionKey
   │ 对应槽位 SOCKS5（禁止 direct fallback）
   ▼
CookieAuth → access + refresh
   │ /internal/credential/import
   ▼
Go slot worker credentials.json
   │ 临期检查 / 401 refresh-once
   │ 同一槽位 SOCKS5
   ▼
https://platform.claude.com/v1/oauth/token
```

## 刷新规则

参考 Sub2API：

1. access token 到期前 5 分钟进入刷新窗口。
2. worker 先做进程内 singleflight，再获取 credential file lock。
3. 锁内重新读取 credential 和 generation，二次确认是否仍需刷新。
4. refresh 请求必须使用该 VM 绑定的 SOCKS5。
5. 成功后原子写入 access、轮换后的 refresh、expiry 和新 generation。
6. context/deadline 已取消的迟到响应不得落盘。
7. `invalid_grant` 先重读 generation，识别其他 worker 已完成的竞争刷新。
8. 401 最多强制刷新并重试一次。

## 网络不变量

以下请求共用 worker 的同一个显式 SOCKS5 transport：

- `/v1/messages`
- `/v1/models`
- `/api/oauth/usage`
- `/v1/oauth/token`
- 健康/额度探测

代理缺失或连接失败时槽位 fail closed，不允许 VPS 直连。

## 管理 API

- `POST /api/panel/vms/:id/oauth/refresh`：调用对应 worker ensure/force refresh。
- `POST /admin/vm/oauth/refresh`：同上，可通过 `vm_id` 指定槽位。
- `GET /api/panel/oauth`、`GET /admin/vm/oauth`：返回 worker 和脱敏 credential 状态。

Claude CLI 不再参与推理或 token rotation。

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

代理缺失或连接失败时槽位 fail closed，不允许 VPS 直连。容器环境变量里没有 `HTTP_PROXY` / `ALL_PROXY` / `socks`；出站由 worker 自己对槽位 SOCKS 做 CONNECT。

### 不要和宿主机 uid REDIRECT 叠两层

`kin-*` 槽位是 **host 网络或与宿主机同 UID 的 Docker**，不是独立 netns。旧 CLI 路径仍可能在宿主机上用 `iptables` owner-uid + `gost :12345` 劫持该 UID 的全部 TCP。

Go worker 会主动 `Dial` 远程 SOCKS。若那条 TCP 也被 REDIRECT 到 gost 的 redirect 口（那不是 SOCKS 服务端），握手会变成 `read SOCKS5 greeting: connection reset by peer`。旧 HTTP 库路径更糟：CONNECT 目标会变成代理自己。

拆开方式（网关在槽位启动和启动后周期复检）：

1. `127.0.0.0/8` → RETURN
2. **槽位 SOCKS `host:port` → RETURN**
3. 其余该 UID 的 TCP → 仍可 REDIRECT 到 gost（留给可能还在的旧 CLI 进程）

推理只由 Go worker 说 SOCKS。gost 通道以后可以拆掉；现在留着是为了不误伤同一 UID 上的其它进程。`KIN_SOCKS_EGRESS_IPTABLES=0` 可关闭这项 iptables 复检。

## 管理 API

- `POST /api/panel/vms/:id/oauth/refresh`：调用对应 worker ensure/force refresh。
- `POST /admin/vm/oauth/refresh`：同上，可通过 `vm_id` 指定槽位。
- `GET /api/panel/oauth`、`GET /admin/vm/oauth`：返回 worker 和脱敏 credential 状态。

Claude CLI 不再参与推理或 token rotation。

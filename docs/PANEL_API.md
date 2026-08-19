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

## 备份 / 代理

| 方法 | 路径 |
|------|------|
| GET/POST | `/backups` |
| GET | `/backups/:id/download` |
| POST | `/backups/:id/restore` 须 `{ "confirm": true }` |
| GET/POST/PUT/DELETE | `/proxies…` |

恢复期间协议口 503。每个槽位必须绑定 SOCKS5；Go worker 在槽位容器内显式使用该代理，失败时不直连。

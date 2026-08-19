# 面板 API

基址 `/api/panel`。需要**面板登录会话**或 Master `KIN_API_KEY`。`sk-kin-…` 不能调面板。

登录：`POST /api/panel/login` `{ username, password }` → token / Cookie。

## 槽位 / 用量

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/dashboard` | 总览 |
| GET | `/vms` | 列表（含 `has_token`、`cred_status`、5h/7d/fable） |
| GET | `/vms/:id` | 详情 |
| POST | `/vms/:id/probe` | **槽 UID** 探测 usage + fable |
| POST | `/probe` | 全量探测 |
| GET | `/usage` | 用量汇总 |
| GET | `/models` | CLI 目录 |
| GET | `/routing` | sticky / 并发 / 额度 / logging |
| PUT | `/routing` | 热更新；`logging.mode` = off\|normal\|debug |

`cred_status`：`无凭证` / `可用` / `5h 限制` / `7d 限制` / `Fable 限制` / `不可用`。

## 密钥 / 日志

| 方法 | 路径 |
|------|------|
| GET/POST | `/api-keys` |
| PATCH/DELETE | `/api-keys/:id` |
| GET | `/request-logs` |
| GET | `/request-logs/stats` |
| GET | `/request-logs/:request_id` |

日志：`normal` 摘要；`debug` 另存脱敏 body 快照。`X-Request-ID` 回写响应头。

## 备份 / 代理

| 方法 | 路径 |
|------|------|
| GET/POST | `/backups` |
| GET | `/backups/:id/download` |
| POST | `/backups/:id/restore` 须 `{ "confirm": true }` |
| GET/POST/PUT/DELETE | `/proxies…` |

恢复期间协议口 503。SOCKS 绑在槽外层 UID，不是容器内代理。

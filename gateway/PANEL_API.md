# Panel API（shadcn 前端契约）

Base: `/api/panel`  
Auth: `Authorization: Bearer <KIN_API_KEY>`

## 统一响应

成功：
```json
{ "ok": true, "data": { ... }, "meta": {} }
```

失败：
```json
{ "ok": false, "error": { "type": "...", "code": "...", "message": "..." } }
```

## 端点

| Method | Path | 用途 | shadcn 组件建议 |
|--------|------|------|----------------|
| GET | `/api/panel/dashboard` | 总览（summary + vms + routing） | Cards + Table |
| GET | `/api/panel/vms` | VM 列表 `data.items[]` | DataTable |
| GET | `/api/panel/vms/:id` | VM 详情 + 账号用量 | Sheet / Detail |
| POST | `/api/panel/vms/:id/probe` | 从 VM 官方 Claude Code 探测（auth status + 可选小 hop） | Button action |
| POST | `/api/panel/vms/:id/activate` | 设为 active | Button |
| POST | `/api/panel/probe` | 全量探测 | Button |
| GET | `/api/panel/usage` | 账号用量汇总 | Progress + Table |
| GET | `/api/panel/models` | 官方模型列表 | Select / Combobox |
| GET | `/api/panel/routing` | 粘性/额度配置 | Form |
| PUT | `/api/panel/routing` | 更新配置 | Form submit |

## Request Logs（SQLite 持久化）

| Method | Path | 说明 |
|--------|------|------|
| GET | `/api/panel/request-logs` | 摘要列表；参数：`limit, offset, api_key_id, vm_id, account_id, model, protocol, status(数字/ok/error), since, until, q`；返回 `items + total` |
| GET | `/api/panel/request-logs?mode=debug` | debug 全量记录（脱敏） |
| GET | `/api/panel/request-logs/stats` | 聚合统计；参数：`bucket=day|hour, since, until`；返回 `totals + buckets[]`（requests/errors/tokens/avg_duration_ms） |
| GET | `/api/panel/request-logs/:request_id` | 单条 debug 详情 |

## Backups（本地备份）

| Method | Path | 说明 |
|--------|------|------|
| GET | `/api/panel/backups` | 备份列表 + schedule 配置 + `next_auto_at` |
| POST | `/api/panel/backups` | 立即备份（manual），201 返回记录 |
| GET | `/api/panel/backups/config` | 读取 `{enabled, interval_hours, retention}` |
| PUT | `/api/panel/backups/config` | 更新调度配置（默认 24h / 保留 7 份 / 开启） |
| GET | `/api/panel/backups/:id/download` | 下载 tar.gz（`application/gzip`，头带 `x-kin-backup-sha256`） |
| POST | `/api/panel/backups/:id/restore` | 恢复；body 必须 `{"confirm": true}`；恢复期间协议请求返回 503 `restore_in_progress` |
| DELETE | `/api/panel/backups/:id` | 删除记录 + 磁盘文件 |

备份记录 row:
```
id, created_at, kind(manual|scheduled|pre_restore), status(ok|failed),
file_name, size_bytes, sha256, db_bytes, includes{db,vms,config}, note, file_exists
```

## data 字段约定（列表行）

VM row:
```
id, name, status, active, email, account_uuid, has_token,
max_concurrency, claude_code_version, utilization_5h, utilization_7d,
inflight, requests
```

Usage account row:
```
account_id, vm_id, email, utilization_5h, utilization_7d,
reset_5h, reset_7d, inflight, max_concurrency, requests,
tokens_in, tokens_out, near_limit
```

Model row:
```
id, label, max_tokens, max_input_tokens
```

旧 `/admin/*` 仍可用，新 UI 请只依赖 `/api/panel/*`。

## Proxy Pool

| Method | Path | 说明 |
|--------|------|------|
| GET | `/api/panel/proxies` | 池快照（config + totals + list） |
| POST | `/api/panel/proxies/import` | body `{ text }` 批量导入 |
| POST | `/api/panel/proxies/probe` | 全量探测 |
| PUT | `/api/panel/proxies/config` | `{ probe_interval_min: 5\|10\|30\|60 }` |
| POST | `/api/panel/proxies/:id/probe` | 单条探测 |
| POST | `/api/panel/proxies/:id/enable` | 启用 |
| POST | `/api/panel/proxies/:id/disable` | 停用（级联暂停 VM 调度） |
| POST | `/api/panel/proxies/:id/bind` | `{ vm_id }` 1:1 绑定 |
| POST | `/api/panel/proxies/:id/unbind` | 解绑 |
| DELETE | `/api/panel/proxies/:id` | 删除 |
| POST | `/api/panel/vms/:id/allocate-proxy` | VM 自动领取空闲代理 |

失败策略：连续探测失败 ≥ max_failures → proxy.enabled=false + VM schedulable=false。

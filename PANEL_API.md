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
| POST | `/api/panel/vms/:id/probe` | 单机官方用量探测 | Button action |
| POST | `/api/panel/vms/:id/activate` | 设为 active | Button |
| POST | `/api/panel/probe` | 全量探测 | Button |
| GET | `/api/panel/usage` | 账号用量汇总 | Progress + Table |
| GET | `/api/panel/models` | 官方模型列表 | Select / Combobox |
| GET | `/api/panel/routing` | 粘性/额度配置 | Form |
| PUT | `/api/panel/routing` | 更新配置 | Form submit |

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

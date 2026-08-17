# PR：KIN Gateway 最终需求对齐与工程收敛

> 分支建议：`feat/final-forward-oauth-ui` → `main`  
> 范围：gateway 运行时、控制台、OAuth 策略、离线验收、死代码清理

---

## Summary

将 KIN Gateway 收敛为**最终产品形态**：

- 默认 **Claude Code 转发**，业务请求完整保留，仅替换槽位身份与凭证相关字段  
- OAuth **单一写入** + **官方 CLI 续期**；禁止网关用凭证打 Anthropic HTTP  
- 默认 **client 工作区流式**；工具回调用方执行  
- Web **凭证统一维护**（导入 / 收割 / 清空 / 状态）  
- 删除重复入口与备份尸体，补齐基于抓包的离线验收套件  

---

## 动机

1. Windows / Hermes 等客户端对接时，工具若在 Linux 槽内执行会导致路径权限错误  
2. 网关侧 `refresh_token` 或 OAuth HTTP 会与官方 CLI 抢票，存在封号风险  
3. 产品要求「只借鉴 sub2api 替换逻辑，不借 HTTP 中继」  
4. 代码库存在重复 `server-v2`、`.bak`、已禁用仍保留的大段死代码  

---

## 改动清单

### A. 调度与转发（核心路径）

| 文件 | 改动 |
|------|------|
| `gateway/server-v2.mjs` | 默认 `workspace=client`：`officialMessagesBody` + `applyForwardReplace` + CLI 转发；**stream 路径**调用 `streamClientWorkspaceCli`；非流式保留 `callClientWorkspaceCli`；去掉无用 import |
| `gateway/lib/client-cli-hop.mjs` | 新增 `streamClientWorkspaceCli`（stream-json + 首个 tool_use 提前结束）；MCP stub 不在槽内执行工具 |
| `gateway/lib/forward-mode.mjs` | **cli / relay 替换集统一**为 `VM_STANDARD_REPLACE`（凭证、session、device、metadata、特征、指纹、settings） |
| `gateway/lib/vm-identity.mjs` | 槽位标准身份加载与 settings / fingerprint 落盘 |
| `gateway/lib/workspace-mode.mjs` | 默认 client；`x-kin-workspace: vm` 可选 |
| `gateway/lib/prepare-cli.mjs` | 保留 tools（`keep_client_tools`）；外人设（Hermes 等）写入官方 system 文本块 |
| `gateway/lib/anthropic-messages.mjs` | **精简**：仅 `officialMessagesBody` + 永久 501 的 HTTP hop 哨兵；禁止 OAuth 打官方 HTTP |
| `gateway/lib/execution-context.mjs` | 每请求独立 ExecutionContext；capabilities 声明 client_tools / stream / forward |

### B. OAuth 与凭证

| 文件 | 改动 |
|------|------|
| `gateway/lib/oauth-refresh.mjs` | 文档化 **单一写入** `persistOauthToVm`；热路径 harvest-only；禁止 `grant_type=refresh_token` |
| `gateway/server-v2.mjs` 导入接口 | sessionKey 导入改为走 `persistOauthToVm`，再 seed `cli-home` |
| `session-to-oauth.mjs` | 仅管理台导入使用，**不在推理热路径**自动换票 |
| `gateway/lib/vm-registry.mjs` / `panel-api.mjs` | 暴露 `oauth_source` / `has_refresh` / `has_session_key` 供控制台展示 |

### C. 控制台 UI

| 文件 | 改动 |
|------|------|
| `gateway/public/console.html` | 导航「导入」→「**凭证**」；凭证页表格 + 详情卡；导入转换 / 收割 CLI / 探测 / 清空；筛选有效·将过期·无凭证 |
| 同上 | 集群卡片/列表增加凭证徽章与快捷入口；协议页能力条（完整保留请求 · 只换身份 · 流式 · 工具在调用方） |
| 同上 | 危险操作确认文案明确节点 ID |

### D. 测试与夹具

| 文件 | 改动 |
|------|------|
| `gateway/lib/acceptance.test.mjs` | **新增**离线验收：抓包协议转换、身份替换保 tools、HTTP OAuth 501、`persistOauthToVm` |
| `gateway/fixtures/pkt-00*.json` | 历史抓包脱敏夹具（chat / messages / responses） |
| `gateway/fixtures/synth-tools-metadata.anthropic.json` | 合成 tools + Windows metadata，测身份替换 |
| `gateway/lib/forward-mode.test.mjs` | 更新为「两模式全量替换」断言（与最终需求一致） |

### E. 死代码清理

| 项 | 处理 |
|----|------|
| `*.bak*`（5 个历史快照） | 删除 |
| `lib/server-v2.mjs`（与根入口重复 ~66KB） | 删除 |
| `server.mjs` / `server-capture.mjs` | 缩为一次性 throw stub |
| `anthropic-messages` 无用 Headers/fetch 实现 | 删除，保留 501 哨兵 |
| 未使用的 `officializeToClaudeCli` / `classifyClient` import | 移除 |

---

## 行为对照（Before → After）

| 行为 | Before | After |
|------|--------|-------|
| 默认工具执行地 | 易落入 VM 沙箱 | **调用方本机**（client workspace） |
| 默认流式 | client 路径整包 JSON | **SSE / 协议流** |
| 身份替换 | cli/relay 不一致 | **两模式同一套 VM 标准替换** |
| OAuth 写入 | 导入可能直接改 json | **仅 `persistOauthToVm`** |
| Anthropic HTTP + OAuth | 曾存在 hop | **永久 501** |
| 控制台凭证 | 导入向导为主 | **统一凭证页可维护** |
| 仓库体积 | 重复 server + bak | **删除无用约 90KB+** |

---

## 测试计划

### 已跑（无真实 key）

```bash
cd gateway/lib
node --test acceptance.test.mjs forward-mode.test.mjs oauth-refresh.test.mjs vm-identity.test.mjs workspace-mode.test.mjs
# 预期：全部 pass
```

### 人工（需有效 sessionKey，本 PR 不强制）

1. 控制台 → 凭证 → 导入 sessionKey → 显示邮箱/过期  
2. 收割 CLI → 状态更新  
3. 客户端 `stream: true` 请求 `/v1/messages` → SSE  
4. 带 tools 请求 → 返回 `tool_use`，在调用方执行  
5. 抓包确认 `metadata.user_id` 为 VM device/session，非 Windows 本机  
6. 日志无对 `api.anthropic.com` 的 Bearer OAuth  

---

## 风险与回滚

| 风险 | 缓解 |
|------|------|
| client 流式与部分客户端兼容性 | 保留非 stream JSON 分支 |
| Hermes 等外人设过长 | system 文本块截断策略既有；可后续再限长 |
| 删除 `lib/server-v2.mjs` | 确认 systemd 仅 `node server-v2.mjs` |

回滚：恢复上一版本 `server-v2.mjs` + `client-cli-hop.mjs` + `console.html`，并重启 `kin-gateway`。

---

## 非目标（本 PR 不做）

- 真 KVM/QEMU 生命周期  
- 网关侧 Anthropic HTTP 中继（明确不做）  
- 控制台拆多页工程化打包  
- 提交任何真实 OAuth / sessionKey / SOCKS 密钥  

---

## Checklist

- [x] 默认 client 工作区 + 流式  
- [x] 全量 VM 身份替换  
- [x] OAuth 单写 + 禁止 HTTP OAuth  
- [x] 凭证 Web 维护  
- [x] 抓包离线验收  
- [x] 死代码清理  
- [x] README 目的与需求  
- [ ] 维护者使用真实 sessionKey 做一次冒烟（环境外）  

---

## 部署备注

```bash
systemctl restart kin-gateway
curl -sS https://kin.fkcodex.com/health
# capabilities.workspace_default == client
# limitations.oauth 含 never HTTP Claude with OAuth
```

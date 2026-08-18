# PR：SQLite 数据库持久化 + 凭证入库 + 本地自动备份（参考 sub2api）

> 分支：`cursor/bc-…` → `main`  
> 范围：数据层（新增 `lib/db/`）、五大 Store 改造、VM/凭证镜像、日志入库、备份服务、控制台备份 UI

## Summary

- **SQLite 数据层**（Node 22 内置 `node:sqlite`，零新依赖）：版本化 SQL 迁移 + SHA-256 校验（仿 sub2api migrations_runner）、Repository 层（`lib/db/repos/*`）。
- **各类数据入库**：api_keys、accounts + account_allocations、sticky_sessions、proxies、request_logs / request_log_debug、settings、backup_records；`ApiKeyStore / AccountQuota / StickyRouter / ProxyPool / RequestLogStore` 对外接口不变。
- **凭证入库（写穿镜像）**：`vms` 表持有完整 `vm_json` + 凭证列；`atomicWriteJson` 写钩子覆盖 oauth-refresh / vm-registry / saveVmPatch / 面板全部写入点；启动 mtime 对账 + `fs.watch` 兜底；文件缺失可从 DB 反向重建；可选 `KIN_DB_SECRET` AES-256-GCM 加密落库。
- **旧文件一次性迁移**：首启导入 `data/*.json`、`request-logs/*`、`vms/*.json`，`settings.legacy_import_done` 幂等；原文件保留。
- **日志系统对接**：`request_logs` 表 + 面板过滤/分页/`total`、新增 `/api/panel/request-logs/stats` 聚合、dashboard `db_totals`；`KIN_REQUEST_LOG_JSONL=1` 可镜像旧 JSONL。
- **本地自动备份（默认开启）**：`BackupService` — `VACUUM INTO` + tar.gz（manifest + db + vms + config，0600）；默认 24h / 保留 7 份 / 启动补跑；面板列表/立即备份/下载/恢复/调度配置；恢复自动 `pre_restore` 快照 + sha256 校验 + 恢复期间协议 503；不做 S3。
- **测试**：新增 45 个单测（db/迁移、各 repo、vm 镜像/加密、legacy 导入、备份）+ 2 个 e2e 套件（persistence、backup）；全量 `npm test` 188/188 通过。

---

# 上一轮 PR：KIN Gateway 最终需求对齐与工程收敛

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

> 说明：`.bak` 历史快照与 `lib/server-v2.mjs` 在本 PR 的基线（`c5c4180`）上**已不存在**，由更早的提交清理，本 PR 未再删除文件。下表仅列本 PR 实际改动。

| 项 | 处理 |
|----|------|
| `server.mjs` / `server-capture.mjs`（各 ~383 行） | 缩为一次性 throw stub |
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
| 冗余入口 | `server.mjs`/`server-capture.mjs` 383 行旧实现 | **收敛为 throw stub** |

---

## 测试计划

### 已跑（无真实 key）

```bash
cd gateway/lib
node --test          # 整个 lib 套件（含 execution-context/client-cli-hop/vm-file）
# 预期：全部 pass（75+ 用例）
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

---

## 补强（审查跟进 / review follow-up）

针对首轮实现与需求/文档不符的缺口做的加固，均在 `gateway/lib` 有对应单测：

| 项 | 改动 | 文件 |
|----|------|------|
| 多轮上下文丢失 | `buildStreamJsonTurns`：无 `--resume` 时把历史轮次展开为 transcript，尾轮原样保留（不再只发最后一句） | `client-cli-hop.mjs` |
| 图片被丢弃 | `toAnthropicBlocks` 保留 image/tool_result/document，OpenAI `image_url`→Anthropic image | `client-cli-hop.mjs` |
| 工具越权风险 | client 工作区改 **fail-closed**：`--permission-mode default`（去 `bypassPermissions`）+ 只允许 `mcp__kinclient__*` + 扩充内置 denylist | `client-cli-hop.mjs` |
| CLI 孤儿进程 | `spawn(detached)` + 进程组 `process.kill(-pid)` 组杀，早停不留残留 | `client-cli-hop.mjs` |
| 请求参数被忽略 | `thinking.budget_tokens`→`MAX_THINKING_TOKENS`；无法映射的 `max_tokens/temperature/...` 记入 `hop_meta.params.dropped` | `client-cli-hop.mjs` |
| system 静默截断 | 超长按 `MAX_SYSTEM_CHARS` 截断并记 `hop_meta.system.truncated` | `client-cli-hop.mjs` |
| 流式 rate-limit 未采集 | 两条 hop 均 `consumeCliNdjson` + 调 `onRateLimit`，返回 `rate_limit(s)` 供配额入账 | `client-cli-hop.mjs` |
| vm.json 写竞态/放大 | 原子写（temp+rename）、per-VM 锁、指纹/settings 仅变更时写 | `vm-file.mjs` / `oauth-refresh.mjs` / `vm-identity.mjs` |
| capabilities 不诚实 | `multi_turn_native=false`（靠 flatten/resume）；`images` 限定“当前轮原样”；修复对应测试 | `execution-context.mjs` |
| 抓包无界增长 | client-diff 抓包按 `KIN_DIFF_CAPTURE`(0/1/0..1，默认 5%) 采样 | `server-v2.mjs` |
| 覆盖回补 | 恢复 `harvestHomeToVm` 断言 | `acceptance.test.mjs` |

### forward 模式与身份替换澄清（T10/T14）

- `cli` 与 `relay` 目前**同一传输**（官方 slot CLI）。Anthropic HTTP hop 永久 501，故不存在独立的 HTTP relay；`relay` 仅作标签，替换集与 `cli` 一致。
- `cli` 传输下真正生效的身份来自 **cli-home seeding**（credentials/settings/fingerprint）；body 上的 `metadata.user_id` 替换服务于审计与一致性断言，`claude -p` 不会把 body 的 `metadata` 直接发往 Anthropic。

### 新增测试

```bash
cd gateway/lib
node --test client-cli-hop.test.mjs vm-file.test.mjs
```

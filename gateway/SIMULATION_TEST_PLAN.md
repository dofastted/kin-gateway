# KIN Gateway — 全面模拟测试计划（Simulation Test Plan）

> 交付物：本文件（计划）+ 已落地测试缝 / mock / harness / e2e。
> 目标：在**无真实 `claude` 二进制 / 无真实 VM / 无真实 OAuth / 无外网**的前提下，用“模拟（mock/simulation）”手段把 gateway 的所有转发路径端到端跑通并断言。

---

## 1. 背景与现状

### 1.1 已有覆盖
- `gateway/lib/*.test.mjs`：纯函数单测（协议转换、forward-mode、workspace-mode、vm-identity、oauth-refresh、client-cli-hop 的 `buildStreamJsonTurns`/`buildHopArgs`、vm-file 原子写等）。合计 76 用例，`cd gateway/lib && node --test` 全绿。

### 1.2 缺口（本计划要补）
1. **无 HTTP 级 e2e**：从未通过 `server-v2.mjs` 的真实 HTTP 端点（`/v1/messages`、`/v1/chat/completions`、`/v1/responses`）驱动完整链路。
2. **hop 从未端到端执行**：`callClientWorkspaceCli` / `streamClientWorkspaceCli` / `callClaudeCli` / `streamClaudeCli` 依赖真实 `sudo -u kincli claude`，从未在测试中真正 spawn 跑通。
3. **凭证生命周期未集成测试**：面板导入（sessionKey→OAuth）、`/oauth/refresh` 收割、`/reset` 清空的 HTTP 行为未验证。
4. **错误路径未覆盖**：401 无 OAuth、501 HTTP hop、model 校验拒绝、超时/孤儿进程回收、rate-limit 入账。
5. **并发/竞态未验证**：T7 的 vm.json 原子写 + per-VM 锁在并发请求下的正确性。
6. **面板 API 未 e2e**：登录鉴权、VM 列表/详情、seed 设置、代理绑定等。

---

## 2. 目标与范围

### 2.1 目标
- 用**可控的模拟替身**替换 4 类外部依赖，使整条链路可在 CI/本地确定性运行：
  1. 官方 `claude` CLI（stream-json 输入/输出）
  2. `sudo -u kincli`（提权执行）
  3. `sessionKeyToOAuth`（外网 Cookie/HTTP 换票）
  4. model 目录（来自 CLI 二进制）
- 覆盖**协议 × 流式 × 工作区 × 内容特性 × 凭证 × 错误 × 并发**的场景矩阵，给出明确断言。
- 产出可重复运行的 `node --test` 套件 + CI 任务。

### 2.2 非目标
- 不联真实 `api.anthropic.com`、不做真号冒烟（另属线上人工验收）。
- 不引入重型测试框架（坚持 Node 内建 `node:test` + `node:assert`）。
- 不改动业务默认行为；仅新增**测试专用 seam**（默认关闭，仅测试置位）。

---

## 3. 模拟策略与需要新增的“测试缝”（seams）

> 现状 spawn 是硬编码的（不可注入），必须先加最小 seam，测试才能替换外部命令。所有 seam **默认不改变生产行为**。

### 3.1 CLI 启动器 seam（关键）
现状（硬编码）：
- `lib/client-cli-hop.mjs:688` → `spawn('sudo', ['-u','kincli','-E','claude', ...args])`
- `lib/cli-runner.mjs:236` → `spawn('sudo', ['-u','kincli','-E','--','claude', ...args])`
- `lib/cli-runner.mjs:172/251` → `chown` / `pkill -u kincli`（提权副作用）

**方案**：抽出单一函数 `resolveClaudeLauncher()`（放 `lib/cli-launcher.mjs`）返回 `{ cmd, prefixArgs }`：
- 生产默认：`sudo -u kincli -E [--] claude`（行为不变）。
- 测试置 `KIN_CLI_LAUNCHER=direct`：直接 `cmd=<CLAUDE_CLI_PATH 或 'claude'>`，`prefixArgs=[]`，跳过 `sudo/chown/pkill`（用 `KIN_DISABLE_PRIVDROP=1` 守卫）。
两处 spawn 与 `chown/pkill` 改为读取该 launcher/守卫。**改动小、可单测**。

### 3.2 Mock `claude` CLI（stream-json 替身）
新增可执行脚本 `gateway/test/mocks/mock-claude.mjs`（`#!/usr/bin/env node`）：
- 解析与真实 CLI 同形的参数（`-p --input-format stream-json --output-format stream-json --verbose [--include-partial-messages] --model <m> --mcp-config ... --allowedTools ... --disallowedTools ... --permission-mode ... [--append-system-prompt ...] [--resume ...]`）。
- 从 stdin 读取 stream-json user turns；按**场景脚本**（env `KIN_MOCK_SCENARIO`）输出 canned NDJSON：
  - `text`：`system.init(session_id)` → `stream_event` 文本增量 → `result`。
  - `tool_use`：输出 `content_block_start`(tool_use) 触发 hop 早停路径。
  - `thinking`：输出 thinking 增量（验证 `MAX_THINKING_TOKENS` 透传，读 env 断言）。
  - `rate_limit`：输出 `rate_limit_event`（验证 `onRateLimit`/配额入账）。
  - `hang`：睡眠超过 timeout（验证超时 + 进程组回收）。
  - `error`：输出错误对象/非零退出。
- 记录被调用的 argv/env 到 `KIN_MOCK_TRACE_FILE`，供测试断言（例如确认 `--permission-mode default`、无 `bypassPermissions`、`--disallowedTools` 含内置、`MAX_THINKING_TOKENS` 已注入、stdin 保留了历史 transcript 与 image block）。

### 3.3 OAuth 换票 seam
现状：`server-v2.mjs:28` 直接 `import { sessionKeyToOAuth }`。
**方案**：在 `session-to-oauth.mjs` 顶部加 `KIN_FAKE_SESSION_OAUTH` 分支：置位时 `sessionKeyToOAuth` 直接返回确定性假凭证（`access_token/refresh_token/expires_at/email/account_uuid`），不触发任何 fetch/SOCKS。仅测试置位。

### 3.4 model 目录 seed
无需改代码，用既有缝：
- `CLAUDE_CLI_PATH` 指向 mock（或让 mock 响应 `--version`/模型列表），或
- `KIN_CLI_MODELS_CACHE` 指向预置 `{ key, ids:[...] }`（注意 `resolveCliBin` 为空时会早退，需配合 `CLAUDE_CLI_PATH`），或
- 直接 `setCliModelCatalogForTest([...])`（进程内测试用）。
测试统一走 **`CLAUDE_CLI_PATH=<mock-claude>` + 预置目录**，让 `/v1/models` 与 model 校验闸门放行受控模型。

### 3.5 文件系统与端口
- 每个测试用 `fs.mkdtempSync` 建临时 `PROJECT`，写 `vms/active.json` + `vms/<id>.json`（含假 OAuth、schedulable、seed_policy、fingerprint）与空 `cli-home`。
- `captures/` 指向临时目录，`KIN_DIFF_CAPTURE=0` 关采样噪声（个别用例置 1 验证抓包）。
- server 监听 `PORT=0`（内核分配空闲端口），从 `server.address().port` 取实际端口。
- 需要 `config.mjs` 支持从 env 覆盖 `PROJECT`/`captures`（若不支持，加 `KIN_PROJECT_ROOT` seam）。

---

## 4. 测试架构与目录规范

```
gateway/test/
  harness.mjs            # 启动/停止 server-v2 于 PORT=0；组装 env + 临时 PROJECT；返回 baseUrl + 清理钩子
  fixtures/
    vms/                 # 种子 VM 模板（假 OAuth / seed_policy / fingerprint）
    requests/            # 各协议入站请求样本（anthropic / openai.chat / openai.responses；含 tools/image/multi-turn）
  mocks/
    mock-claude.mjs      # 官方 CLI stream-json 替身（场景可控 + argv/env trace）
  e2e/
    messages.e2e.test.mjs        # /v1/messages：stream/非stream × text/tool_use/thinking/error/timeout
    openai-chat.e2e.test.mjs     # /v1/chat/completions：转换 + [DONE] + tool_calls
    openai-responses.e2e.test.mjs
    workspace-vm.e2e.test.mjs    # x-kin-workspace: vm（serverTools 路径）
    credentials.e2e.test.mjs     # 导入/收割/清空/状态 + 单写不变量
    errors.e2e.test.mjs          # 401 无oauth / 501 http hop / model 拒绝 / rate-limit 入账
    concurrency.e2e.test.mjs     # T7：并发同 VM，token/fingerprint 不回退；无孤儿进程
    panel-api.e2e.test.mjs       # 登录鉴权 + VM 列表/详情/seed/proxy
  unit/                  # （可选）为新 seam 增补的纯函数单测：cli-launcher 等
```

规范：
- 一律 Node 内建 `node:test`；文件名 `*.e2e.test.mjs` / `*.test.mjs`。
- 断言优先针对**可观测输出**：HTTP 响应体/SSE 事件、`mock-claude` 的 argv/env trace、落盘的 vm.json/settings.json、capture JSON。
- 不依赖真实网络/时钟；超时用小值（如 800ms）。
- 每个用例自建/自清理临时目录与进程，互不影响。

---

## 5. 场景矩阵与断言

### 5.1 协议转换 × 流式（client 工作区，默认）
| 协议 | 非流式断言 | 流式断言 |
|------|-----------|----------|
| `anthropic.messages` | 200，body 为 message 对象，text 来自 mock | SSE 同时含 `event:` 与 `data:`，事件序列合法 |
| `openai.chat` | 转成 chat.completion，choices/usage 正确 | chunk 流 + 结尾 `data: [DONE]` |
| `openai.responses` | 转成 responses 对象 | responses 事件流 + `[DONE]` |

### 5.2 内容特性（core，验证补强）
- **多轮**：user→assistant→user 请求 → 断言 mock stdin 收到含历史 transcript（`first answer` 等）+ 尾轮原样。
- **图片**：`image_url`(data/http) → 断言 stdin 尾轮含 Anthropic `image` block。
- **工具**：带 tools → mock 输出 tool_use → 断言 hop 早停、返回 `stop_reason:tool_use`、工具名去 `mcp__kinclient__` 前缀。
- **thinking**：请求带 `thinking.budget_tokens` → 断言 mock env `MAX_THINKING_TOKENS` 命中；`hop_meta.params.dropped` 含 `max_tokens/temperature`。
- **system 截断**：>24k system → 断言 `--append-system-prompt` 被截断且 `hop_meta.system.truncated=true`。

### 5.3 fail-closed 权限（安全）
- 断言 mock argv：`--permission-mode default`、**无** `bypassPermissions`、`--disallowedTools` 含 `Bash/MultiEdit/...`、无 client tools 时**不**下发 `--allowedTools`。

### 5.4 vm 工作区（opt-in）
- `x-kin-workspace: vm` → 走 `callClaudeCli/streamClaudeCli`（`serverTools:true`），断言 mock argv 含 `--allowedTools Read,...` + `--permission-mode acceptEdits`。

### 5.5 凭证生命周期（单写不变量）
- `POST /api/panel/vms/import`（假 sessionKey）→ 200，vm.json 由 `persistOauthToVm` 写入；断言 access/refresh/email/source 落盘、`_token_version` 更新。
- `POST /api/panel/vms/:id/oauth/refresh`（harvest）→ 断言从 cli-home 的 `credentials.json` 收割，`grant_type_refresh:false`。
- `POST /api/panel/vms/:id/reset {clear_oauth:true}` → 断言 token 清空、不可调度。
- **不变量**：全程无任何对 `api.anthropic.com` 的 OAuth 调用（mock 层零 HTTP）；`callAnthropicMessages/streamAnthropicMessages` 返回 501。

### 5.6 错误路径
- VM 无 access_token → 401 `OAUTH_NEED_REIMPORT`。
- model 不在目录 → 400 `model_not_supported`（无 hop）。
- mock `hang` → 504 超时；随后断言**无残留 mock 进程**（进程组回收，T6）。
- mock `rate_limit` → `accountQuota` 入账（读 `/api/panel/usage` 或内部快照断言）。

### 5.7 并发/竞态（T7）
- 对同一 VM 并发 N 个非流式请求（mock 触发 harvest 写）→ 断言 vm.json 始终是合法 JSON、token 不回退、`writeJsonIfChanged` 抑制无谓重写；`withVmLock` 串行化导入 vs 收割。

### 5.8 面板/鉴权
- 无 key → 401；`Bearer testkey` → 放行；面板 `login`→cookie→`/me`；`/v1/models` 返回 seed 目录。

### 5.9 长会话 × 多协议（补强，P4）
- 同一 `x-session-id`：第 1 跳无 `--resume`；第 2+ 跳 `--resume <mock session_id>`，stdin 只含尾轮。
- 同一 sticky key 串行：`anthropic.messages` → `openai.chat` → `openai.responses` → anthropic stream，resume 不断。
- 不同 `x-session-id` 互不继承 `--resume`。
- 连续 N 轮后 `data/sticky-map.json` 合法，hits / session_id / vm_id 正确。

---

## 6. 执行计划（分阶段）

> 每阶段结束：`cd gateway && node --test test/**/*.test.mjs lib/*.test.mjs` 全绿并提交推送。

### P0 — 测试缝与基础设施（使一切可跑）
- [x] 新增 `lib/cli-launcher.mjs` + 两处 spawn/`chown`/`pkill` 接入；env：`KIN_CLI_LAUNCHER=direct`、`KIN_DISABLE_PRIVDROP=1`、`CLAUDE_CLI_PATH`。
- [x] `session-to-oauth.mjs` 增 `KIN_FAKE_SESSION_OAUTH` 分支。
- [x] `config.mjs` 支持 `KIN_PROJECT_ROOT`/`captures` env 覆盖（若尚不支持）。
- [x] `test/mocks/mock-claude.mjs`（场景 + argv/env trace）。
- [x] `test/harness.mjs`（PORT=0 起停 + 临时 PROJECT + env 组装 + 清理）。
- [x] 冒烟：harness 起服务 → `/health` 200，capabilities 正确。
- **验收**：新 seam 有单测；生产默认路径行为不变（快照对比 argv）。

### P1 — 核心转发 e2e（client 工作区）
- [x] `messages/openai-chat/openai-responses` 三协议 × stream/非stream。
- [x] 内容特性：多轮 / 图片 / 工具 / thinking / system 截断。
- [x] fail-closed 权限断言。
- **验收**：矩阵 5.1–5.3 全覆盖、全绿。

### P2 — 凭证生命周期 + 错误路径 + vm 工作区
- [x] 5.5 导入/收割/清空 + 单写不变量。
- [x] 5.6 错误路径（含超时后无孤儿进程）。
- [x] 5.4 vm 工作区。
- **验收**：矩阵 5.4–5.6 全绿；grep 断言无 anthropic HTTP。

### P4 — 长会话 + 多协议（本轮）
- [x] 同一 `x-session-id` 跨请求 `--resume` + 尾轮 stdin。
- [x] 三协议串行 + 末轮 stream。
- [x] 不同 session 隔离；长序列 sticky-map 合法。
- **验收**：`gateway/test/e2e/long-session.e2e.test.mjs` 全绿。

### 计划仍缺（未做 / 弱断言）
- [ ] 5.2 `hop_meta.params.dropped` / `hop_meta.system.truncated` 未在 HTTP 响应上断言（仅 mock argv）。
- [ ] 5.2 OpenAI `image_url`(data/http) 入站形状未 e2e（仅 Anthropic `image` block）。
- [ ] 5.1 openai.chat / responses 的 `choices`/`usage` 结构只做了文本匹配。
- [ ] 5.6 hang 后无孤儿进程（沙箱无 `ps`，只断言 504）。
- [ ] 5.7 并发导入 vs 收割 `withVmLock` 竞态未单独测。
- [ ] OpenAI tools → `tool_calls` 流式转换未 e2e。
- [ ] Hermes agent 分类 / 入站未纳入本矩阵。
- [ ] `package.json` test 脚本用 glob（`lib/*.test.mjs` …），与原文 `node --test gateway/lib gateway/test` 不完全一致。


---

## 7. 命令与运行

```bash
# 全部（含新 e2e）
cd gateway && node --test lib test

# 仅 e2e
cd gateway && node --test test/e2e

# 关键 env（测试内部由 harness 设置）
KIN_CLI_LAUNCHER=direct KIN_DISABLE_PRIVDROP=1 \
CLAUDE_CLI_PATH=<repo>/gateway/test/mocks/mock-claude.mjs \
KIN_FAKE_SESSION_OAUTH=1 KIN_DIFF_CAPTURE=0 \
KIN_API_KEY=testkey PORT=0
```

---

## 8. 风险与缓解
| 风险 | 缓解 |
|------|------|
| 新 seam 误改生产行为 | 默认分支保持原样；加“生产 argv 快照”单测 |
| mock 与真实 CLI 语义漂移 | mock 以真实抓包（`fixtures/pkt-00*`）为蓝本；关键字段对齐 |
| 进程回收在容器内不稳定 | 用 detached 进程组 + `KIN_DISABLE_PRIVDROP`；断言以 trace 文件/退出码为准 |
| 端口/临时目录泄漏 | harness 强制 `PORT=0` + `afterEach` 清理；用例自包含 |

## 9. 交付物清单（下一轮实现时）
- `lib/cli-launcher.mjs`（+ 单测）、`session-to-oauth.mjs`/`config.mjs` seam。
- `test/harness.mjs`、`test/mocks/mock-claude.mjs`、`test/fixtures/*`。
- `test/e2e/*.e2e.test.mjs`（覆盖 §5 全矩阵）。
- `package.json` test script + CI workflow。
- README「离线验收」章节更新。

## 10. 完成定义（DoD）
- `node --test gateway/lib gateway/test` 全绿，覆盖 §5 全部场景。
- 断言证明三条硬禁止：无 anthropic HTTP OAuth、无网关 `grant_type=refresh_token`、默认不剥离 tools。
- CI 在 PR 上自动运行且通过。
- 生产默认路径行为零回归（argv/env 快照一致）。

# KIN Gateway

多虚拟机槽位的 **Claude Code 官方协议转发网关**。

将 OpenAI / Anthropic / 第三方 Agent（Claude Code、Hermes、Codex 等）的请求，整理为官方形态后，在虚拟机槽内用 **官方 `claude` CLI** 完成推理；凭证只在槽内使用与续期，网关不拿 OAuth 直打 Anthropic HTTP。

线上入口：`https://kin.fkcodex.com`

---

## 目的

| 目标 | 说明 |
|------|------|
| 统一出口 | 多客户端协议收敛到官方 Claude Code 执行面 |
| 凭证安全 | sessionKey → OAuth 只导入一次；续期由官方 CLI 完成；网关只收割 |
| 身份一致 | 调用方 device / 时区 / settings / 指纹全部替换为槽位标准特征 |
| 工具归属清晰 | 默认工具在**调用方本机**执行（Windows 文件可读）；可选 VM 沙箱 |
| 可运营 | Web 控制台维护虚拟机、凭证、代理、用量、路由 |

**不是**：KVM/QEMU 真虚拟机管理器，也不是 sub2api 式 Anthropic HTTP 中继。

---

## 最终需求（产品锁定）

1. **OAuth**：支持 sessionKey 转换为凭证  
2. **统一维护**：Web 可显示、可导入、可收割、可清空（形态参考 sub2api，不照搬实现）  
3. **使用位置唯一**：凭证实际只在虚拟机槽内使用  
4. **默认转发**：Claude Code 转发；替换凭证 + 虚拟机特征  
5. **请求保留**：用户业务内容完整保留；只替换与虚拟机冲突的身份字段（device_id、时区、settings、指纹等）  
6. **借鉴范围**：仅借鉴 sub2api / cliproxy 的**替换逻辑**，不借网关侧 refresh、不借伪装打官方 HTTP  
7. **流式返回**：支持 SSE / stream-json 回包  
8. **多协议**：OpenAI Chat、Responses、Anthropic Messages → 官方 Messages 后再转发  

### 硬性禁止

- 使用 OAuth / sessionKey 在热路径打 `api.anthropic.com`
- 网关执行 `grant_type=refresh_token`（与官方 CLI 抢票会导致废号）
- 默认路径剥离 client tools 或压扁为纯文本

---

## 架构

```text
客户端 (Claude Code / Hermes / Codex / OpenAI SDK …)
        │  Bearer KIN API Key
        ▼
   kin-gateway (server-v2.mjs)
        │  选槽 + sticky
        │  协议 → 官方 Messages
        │  身份 → VM 标准特征
        ▼
   虚拟机槽 cli-home
        │  官方 claude CLI（唯一持有并刷新 OAuth）
        ▼
   流式 / 整包响应
        │
        └─ tool_use → 默认回调用方执行
```

### 工作区

| 模式 | Header | 工具执行位置 |
|------|--------|----------------|
| **client**（默认） | `x-kin-workspace: client` 或不传 | 调用方本机 |
| **vm**（可选） | `x-kin-workspace: vm` | 槽内沙箱 |

### 转发模式

| 模式 | Header | 说明 |
|------|--------|------|
| **cli**（默认） | `x-kin-forward: cli` | Claude Code 传输 |
| **relay** | `x-kin-forward: relay` | 协议中继标签；身份替换集与 cli **相同** |

两者都做全量 VM 标准身份替换：`credentials / session_id / device_id / metadata.user_id / characteristics / fingerprint / settings`。

---

## 协议与接入

| 路径 | 协议 |
|------|------|
| `POST /v1/messages` | Anthropic Messages |
| `POST /v1/chat/completions` | OpenAI Chat Completions |
| `POST /v1/responses` | OpenAI Responses |
| `GET /v1/models` | 模型列表（来自槽内 CLI 目录） |
| `GET /health` · `GET /v1/meta` | 健康与能力声明 |

鉴权：`Authorization: Bearer <KIN_API_KEY>` 或 `x-api-key`。

控制台：`/console`（面板登录后管理虚拟机与凭证）。

---

## OAuth 生命周期

```text
管理台粘贴 sessionKey
    → CookieAuth 换出 access/refresh
    → 唯一写入 persistOauthToVm(vm.json)
    → seed 到槽内 credentials.json
    → 官方 claude CLI 自行续期
    → 网关 harvest 回写（不 refresh）
```

详情见 [`gateway/OAUTH.md`](gateway/OAUTH.md)。

---

## 控制台能力

- **总览 / 集群 / 虚拟机**：槽位状态、额度、内核标签  
- **凭证**：列表筛选、导入 sessionKey、收割 CLI、清空、探测  
- **代理池 / 用量 / 协议 / 设置**：SOCKS、5h·7d、模型、sticky 与并发  

---

## 本地与部署

生产进程：

```bash
# systemd: kin-gateway.service
WorkingDirectory=/opt/kin-gateway/gateway
ExecStart=/usr/bin/node server-v2.mjs
```

关键环境变量：`KIN_API_KEY`、`PORT`、`PUBLIC_BASE_URL`、面板账号密码。

### 离线验收（无真实 key）

```bash
cd /opt/kin-gateway/gateway/lib
node --test acceptance.test.mjs forward-mode.test.mjs oauth-refresh.test.mjs
```

夹具：`gateway/fixtures/`（抓包脱敏 + 合成 tools/metadata）。

---

## 目录要点

```text
gateway/
  server-v2.mjs          # 唯一生产入口
  lib/                   # 调度、身份、CLI 转发、OAuth、面板 API
  public/console.html    # 控制台
  fixtures/              # 离线验收抓包
  captures/              # 运行时抓包（勿提交真实 token）
vms/                     # 槽位元数据 + cli-home
session-to-oauth.mjs     # sessionKey → OAuth（导入专用）
```

---

## 相关文档

| 文档 | 内容 |
|------|------|
| [OAUTH.md](gateway/OAUTH.md) | 凭证策略与和 sub2api 的差异 |
| [ALIGNMENT.md](gateway/ALIGNMENT.md) | 非伪装对齐原则 |
| [COMPAT.md](gateway/COMPAT.md) | 协议兼容 |
| [PANEL_API.md](gateway/PANEL_API.md) | 面板 API |
| [CHANGELOG_PR.md](CHANGELOG_PR.md) | 本轮完整改动清单（PR 用） |

---

## 安全

- 禁止提交真实 OAuth、sessionKey、SOCKS 账号  
- 网关不得将 `ANTHROPIC_AUTH_TOKEN` 注入为长期绕过 CLI 的手段  
- 凭证文件权限应限制为运行用户可读  

---

## License / 归属

私有部署组件。第三方协议与 Claude Code 商标归原厂商所有。

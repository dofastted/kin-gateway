# 网关对齐原则（非伪装）

## 架构

```text
第三方客户端 (OpenAI / Pi / Codex / Claude Code)
        ↓
   种核网关：协议转换 + 拦截/改写官方 Claude Code 不接受的字段
        ↓
   虚拟机内真实 Claude Code（`claude -p`）
        ↓
   把模型输出按原协议返回给客户端
```

## 原则

1. **虚拟机里已经是官方 Claude Code**，出口身份由 VM 负责。网关不注入 billing header、不改 UA、不伪造 metadata。
2. 网关只做两件事：把用户请求内容接进 CLI；把 CLI 输出按客户端协议返回。模型列表只信 VM 里那份官方 Claude Code 认识的目录，不自己打 Anthropic `/v1/models`。
3. 官方 Claude Code 客户端：透传用户消息；剥掉 billing / 身份 / 官方 interactive-agent 系统提示（VM 会再加），CWD 保留为官方字段。
4. 第三方 / 未知 harness（Pi、Codex、ChatGPT、Hermes、OpenClaw）：协议转换；人设改写成官方 `system` 文本块并追加。不给每个 Agent 开分支。
5. 这是接入，不是伪装。未知顶层字段白名单丢弃。详见 [COMPAT.md](COMPAT.md)。

## 收紧规则（硬约束）

| 规则 | 行为 |
|---|---|
| 对话 / 流式 / 模型列表 / 用量探测 | **只**经 VM `claude -p` 或 `claude auth status` / CLI 目录 |
| 网关 `grant_type=refresh_token` | **永久禁用**（会和 CLI 抢票） |
| 网关打 Anthropic Messages / models / oauth/usage | **禁止** |
| 未知模型 id | **400**，不 hop |
| CLI 目录为空 | **拒绝**（fail closed），不放行未校验的 `claude-*` |
| 未知请求体顶层字段 | 白名单外丢弃 |
| 旧 `server.mjs` / `server-capture.mjs` | 启动即抛错，禁止直连 Anthropic |

## 清洗（借鉴 sub2api 的转换，不用它的 mimicry）

| 项 | 处理 |
|---|---|
| 协议 | OpenAI Chat / Responses → Messages |
| 官方 billing / 身份 | 删除（VM 已有） |
| 官方 CWD/Date | 保留为官方 system 文本块 |
| Pi / Codex / ChatGPT / Hermes / OpenClaw / 未知人设 | 改写成官方 `{type,text,cache_control}` 并追加到 system |
| 其它任务上下文 | 同样追加为官方 system 文本块 |
| 未知顶层字段 / thinking / metadata / 客户端 tools | 白名单外一律删除（`claude -p` 不接受） |
| 带前缀的模型名 `anthropic/claude-*` | 剥前缀，只留 VM Claude Code 目录里的官方 id / 别名 |
| Codex 工具名 | 映射表保留给后续，当前 CLI  hop 不转发 tools |

## 抓包

`captures/client-diff/*-prepare-cli.json`

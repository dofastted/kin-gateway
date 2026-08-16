# 未知客户端兼容（Claw / Hermes / 未收录 harness）

KIN 不给每个 Agent 写特例。未知请求走同一条管道：协议识别 → 字段白名单 → 人设改写 → `claude -p`。

对照 sub2api 只借**转换**，不借**伪装**。

## 1. sub2api 怎么处理「不是官方 Claude Code」的请求

OpenClaw 已被它当成测试用例：`You are a personal assistant running inside OpenClaw.`

```
rewriteSystemForNonClaudeCode
```

流程：

1. **判定是不是官方 CC**：UA 必须 `claude-cli/x.y.z`，messages 路径再查 X-App、anthropic-beta/version、system 与官方模板的相似度、billing header。
2. **非官方**：把 `system` **整段换成** 伪造的官方 3 块  
   `[billing header] + [You are Claude Code...] + [expansion + cache_control]`
3. 原来的人设 **搬进 messages**：
   - user: `[System Instructions]\n<原 system>`
   - assistant: `Understood. I will follow these instructions.`
4. 目的写在注释里：Anthropic 用 system 内容抓第三方；只在前面拼 CC 提示词不够，必须把非 CC 内容从 system 里挪走。

这是 **mimicry**：让上游以为请求来自官方 CLI。

KIN 不能这么做。出口已经是虚拟机里的真 Claude Code，网关再注入 billing / 身份 / 假 ack 是重复伪装。

| | sub2api | KIN |
|---|---|---|
| 目标上游 | Anthropic HTTP（要过第三方检测） | 本机 `claude -p`（VM 已有官方身份） |
| 外人设 | 从 system 挪到 messages，system 改成假 CC | 改写成官方 `system` 文本块并追加 |
| billing / UA | 注入 | 不注入 |
| 未知字段 | 多数透传给 Anthropic | 白名单，其余丢掉 |
| 未知协议 | 另一套 apicompat | 只接 Messages / Chat / Responses |

可借鉴：协议转换、`classify` 客户端、把外人设从「污染身份的位置」挪走。  
不可借鉴：3-block 替换、假 ack、伪造 metadata.user_id。

## 2. Claw / Hermes 实际会长什么样

### Hermes Agent（Nous）

- 协议：随 `provider` 走 Anthropic Messages **或** OpenAI Chat；`extra_body` 原样塞进请求。
- system：三段拼成**一条长 string**  
  `stable`(SOUL.md / 默认身份 + skills + platform hints)  
  → `context`(`.hermes.md` / `AGENTS.md` / `CLAUDE.md`)  
  → `volatile`(MEMORY.md / USER.md / 时间戳)。
- 特征串：`You are Hermes`、`SOUL.md`、`<available_skills>`、`## Persistent Memory`。
- tools：本地 40+ toolset，名字是 Hermes 自己的。
- UA：`hermes-agent/...` 或 Python HTTP 库。

### OpenClaw（用户说的 claw）

- 协议：Anthropic Messages（API key）或自己调 `claude -p`。
- system：`SOUL.md` / 「running inside OpenClaw」。
- 非标顶层：`cacheRetention`、`fastMode`、`anthropicServerCompaction`、`thinking`、一堆 `anthropic-beta`。
- 模型名常带前缀：`anthropic/claude-opus-4-6`。
- tools：skill / MCP，在**用户机器**上执行。

sub2api 对 Claw 的处理就是上面那套「人设搬进 messages + 假 CC system」。KIN 应把同一段人设**追加成官方 system 块**。

## 3. 这类请求打到现在的 KIN 会怎样

| 现象 | 现在 | 结果 |
|---|---|---|
| 人设不在 Pi/Codex 正则里 | `classify=keep`，仍会 `append_persona_as_official_system` | 文本对话能通 |
| `anthropic/claude-sonnet-5` | `validateOfficialModel` 400 | **直接失败** |
| `cacheRetention` / `extra_body` / `fastMode` | 不在剔除表，留在 body | `claude -p` 忽略，无害但脏 |
| 48 个 Hermes tools | 全部 drop | 问答应 pong；**本地工具环断开** |
| UA 未收录 | `client_class=unknown` | 清洗照走，只是审计难看 |
| Gemini / 自研 JSON | 过不了 protocol 校验 | 应 400，并写出 inspect |

## 4. 兼容策略：通用未知 harness，不写死 Agent

```text
任意客户端
  ① 协议信封   Messages | Chat | Responses | 未知→400+抓包
  ② 模型名     剥 provider 前缀，只留 claude-*
  ③ 字段白名单 只留 claude -p 吃得下的键，其余记入 decisions 后丢
  ④ system     官方身份/官方 agent 提示 → 剥
               官方 CWD → 留
               其它全部（含 Claw/Hermes/没见过的人设）→ 官方 system 文本块
  ⑤ tools      丢掉。工具在客户端本机，VM 执行不了
  ⑥ 用户消息   原样进 claude -p
  ⑦ 回包       按原协议把文本流回去
```

客户端分类（hermes / openclaw / pi / …）只用于抓包，**不改变管道**。

### 工具环为什么不能“兼容到能跑”

Hermes/Claw 的 Read/Shell 打的是**用户自己的盘**。KIN 的 VM Claude 工具打的是**虚拟机**。  
映射工具名再转发，等于在别人机器上执行。正确行为：丢 tools，当文本补全。多步本地改文件的 Agent 环会降级，这是架构边界，不是漏实现。

若以后要做「工具回放」，只能把 VM 的 tool_use 按客户端 schema 翻译回去让**客户端自己执行**，再把 tool_result 送回来。那是第二阶段，现在不做。

### 和 sub2api 的人设处理对照

```
sub2api:  system = 假CC三块
          messages = [System Instructions][ack] + 原文

KIN:      system = [CWD?][外人设 official text block…]
          messages = 用户原文
```

未知人设走 KIN 的 `keep` / `foreign_identity` 都进同一条「追加为官方字段」。新增正则只是为了审计标签，不是新分支。

## 5. 落地（本提交）

1. 顶层字段改为**白名单**（未知键一律丢）。
2. 模型名剥 `anthropic/` `openrouter/` 等前缀。
3. UA / system 识别 hermes、openclaw，人设正则补上。
4. 抓包 `client_class` + `stripped` 继续写 `*-prepare-cli.json`，用来收录下一个没见过的 Agent。

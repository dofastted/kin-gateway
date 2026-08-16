# 网关对齐原则（非伪装）

## 架构

```text
第三方客户端 (OpenAI / Pi / 其它)
        ↓
   种核网关：协议转换 + 对齐 Claude Code 官方标准
        ↓
   虚拟机内 Claude Code 转发路径
        ↓
   Anthropic / 上游
```

## 原则

1. **虚拟机侧跑的是 Claude Code**，出口必须符合 Claude Code 官方请求契约。
2. 第三方协议在网关完成转换后，再 **对齐** 到该契约（字段、头、beta、messages 形态）。
3. 这是 **标准对齐 (alignment)**，不是身份伪装 (spoofing)。
4. 已是 Claude Code 官方客户端的请求：默认透传（仅做必要 sanitize）。

## 对齐内容

| 项 | 说明 |
|----|------|
| Body | model / messages / max_tokens / system / tools / metadata |
| Headers | anthropic-version、claude-code beta、x-app=cli、Claude Code UA |
| 剥离 | 官方契约不接受的实验字段（如部分 context_management） |
| 协议 | OpenAI Chat/Responses → Claude Messages 后再对齐 |

## API

- 模块：`alignToClaudeCodeStandard()`
- 抓包：`captures/client-diff/*-aligned-claude-code-standard.json`

# 种核 KIN — 需求层次与系统架构

## 一、需求层次（从外到内）

```
L0  平台层 Platform
    网关服务、鉴权、Base URL / API Key、健康状态

L1  集群层 Cluster
    多种子虚拟机池、总览用量、近限额告警、全量探测

L2  虚拟机层 VM
    单机状态、内核、时区/语言、代理 SOCKS5、指纹、Claude Code 版本

L3  账号层 Account / Credential
    OAuth（session→oat）、绑定关系、并发上限、粘性会话

L4  用量层 Usage / Quota
    官方 CLI `rate_limit_event`、5h·7d 状态、分配记录

L5  协议层 Protocol Gateway
    OpenAI Chat / Responses / Anthropic Messages
    → 协议转换 + 拦截官方不接受的字段 → VM 内真实 Claude Code
    外国 CLI 人设追加为官方 system 文本块；不注入 billing/身份

L6  配置层 Settings
    粘性路由、额度策略、拦截规则、种子模板
```

## 二、核心原则

1. VM 内跑 Claude Code；网关做协议对齐，不是伪装
2. 仅 VM 官方 Claude Code 认识的模型
3. 透传优先，改写默认关
4. 对话粘性可配置；额度 5h/7d 卡 95%
5. 多 VM 是终态；单机是当前最小单元

## 三、UI 信息架构

| 导航 | 对应层次 | 内容 |
|------|----------|------|
| 总览 | L0+L1 | 健康、汇总卡片、集群一览 |
| 集群 | L1 | VM 卡片网格（现有组件强化） |
| 虚拟机 | L2+L3 | 单机详情 / 账号 / 探测 |
| 用量 | L4 | 5h·7d、近限额、流水 |
| 协议 | L5 | 路由、模型、错误类型说明 |
| 设置 | L6 | sticky / quota / concurrency |

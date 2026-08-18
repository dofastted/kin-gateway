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
    官方 /api/oauth/usage、5h·7d 95% 安全线、分配记录

L5  协议层 Protocol Gateway
    OpenAI Chat / Responses / Anthropic Messages
    → 对齐 Claude Code 官方标准 → VM 转发
    模型白名单、system 策略、错误分类

L6  配置层 Settings
    粘性路由、额度策略、拦截规则、种子模板
```

## 二、核心原则

1. VM 内跑 Claude Code；网关做协议对齐，不是伪装
2. 仅官方 Claude 模型名
3. 透传优先，改写默认关
4. 对话粘性可配置；额度 5h/7d 卡 95%
5. 多 VM 是终态；单机是当前最小单元

## 三、数据层（参考 sub2api，SQLite 落地）

```
SQLite (node:sqlite, WAL, data/kin.db)
  ├─ 迁移: lib/db/migrations/*.sql + schema_migrations(SHA-256 校验)
  ├─ 仓库: lib/db/repos/*  (settings / api-keys / accounts / sticky /
  │        proxies / vms / request-logs / backup)
  ├─ 凭证镜像: vms/*.json 写穿入 vms 表(可 KIN_DB_SECRET 加密)
  │            启动对账 + fs.watch 兜底; 文件缺失可反向重建
  ├─ 日志: request_logs + request_log_debug (过滤/分页/聚合)
  ├─ 旧数据: 首启一次性导入 data/*.json + vms/*.json (幂等)
  └─ 备份: BackupService — VACUUM INTO + tar.gz(db+vms+config)
           默认 24h 自动、保留 7 份; 恢复带 pre_restore 兜底
瞬态不入库: inflight 并发、RPM 桶、面板 session (对应 sub2api Redis)
```

## 四、UI 信息架构

| 导航 | 对应层次 | 内容 |
|------|----------|------|
| 总览 | L0+L1 | 健康、汇总卡片、集群一览 |
| 集群 | L1 | VM 卡片网格（现有组件强化） |
| 虚拟机 | L2+L3 | 单机详情 / 账号 / 探测 |
| 用量 | L4 | 5h·7d、近限额、流水 |
| 协议 | L5 | 路由、模型、错误类型说明 |
| 设置 | L6 | sticky / quota / concurrency |

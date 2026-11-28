# Loom

Loom 是一套 **Agent 驱动的研发流程**，旨在改造从需求到交付的日常研发协作。它将 GitHub Issue、实现方案、代码变更和验证结果串成一条可追踪的流程，让 Agent 持续推进规划、编码与修复，让维护者在方案确认、发布授权和代码评审时做决定。

## 研发流程

```mermaid
flowchart TD
    issue["GitHub Issue：记录需求"] --> plan["Agent：起草并回贴实现方案"]
    plan --> approval{"维护者确认方案"}
    approval -->|@loom 反馈| plan
    approval -->|@loom 通过| code["Agent：在沙箱中修改获准的文件"]
    code --> validation{"Worker 本地验证"}
    validation -->|需要修复| repair["Agent 修复"]
    repair --> validation
    validation -->|通过| patch["Worker 保存补丁"]
    patch --> release{"获得发布授权"}
    release -->|已授权| pr["草稿 PR：交付变更供评审"]
    pr --> ci["GitHub Actions 检查"]
    ci --> status["控制台：查看 CI 结果"]
```

- **需求和决策在 GitHub 留痕。** Loom 将方案回贴到原 Issue。有仓库写权限的开发者可以回复 `@loom 通过`，或用 `@loom <反馈>` 请求修订。新版方案发布后需要重新批准，草稿 PR 仍需单独获得发布授权。
- **沙箱执行，验证后交付。** Agent 只在预先获准的文件范围内修改代码。Worker 运行本地检查，验证通过后保存补丁。
- **进度和结果可追踪。** 控制台记录阶段输入输出、草稿 PR 和对应提交的 CI 结果，并根据修复次数、耗时和失败记录提供审计建议。

## 控制台

控制台使用 React、TypeScript 和 React Router，Node.js 服务读取现有 SQLite 数据。左侧菜单可切换总览、任务、执行记录、Worker、能力、审计与日志。

使用 GitHub 登录后，仓库授权者可以创建、启动、暂停和排空自己的 Worker。Worker 可并行推进不同 Issue，同一个 Issue 同时只有一个 Worker 处理。能力页展示 AgentGateway 模型、MCP 工具和已配置的 SkillHub 技能版本。

## 系统架构

```mermaid
flowchart LR
    maintainer["维护者"]
    github["GitHub<br/>Issue、草稿 PR、Actions"]
    deepseek["DeepSeek"]

    subgraph loom["Loom"]
        caddy["Caddy"]
        controller["Controller"]
        console["工作流控制台"]
        db[("SQLite<br/>任务、审批、交付和 CI 结果")]
        worker["Worker"]
        sandbox["Docker 沙箱<br/>OpenCode"]
        gateway["AgentGateway"]

        caddy -->|Webhook| controller
        caddy -->|控制台请求| console
        controller -->|登记任务、授权和 CI 结果| db
        console -->|查看执行记录、管理 Worker| db
        db <-->|独占领取 Issue、记录输入输出| worker
        worker <-->|规划、编码和修复| sandbox
        sandbox -->|模型请求| gateway
    end

    maintainer -->|提交 Issue、确认方案、授权发布| github
    maintainer -->|查看进度、发起运行| caddy
    github -->|Webhook 事件| caddy
    controller -->|轮询已配置的 Issue| github
    worker -->|通过 GitHub App 发布方案和草稿 PR| github
    gateway --> deepseek
```

Controller 接收签名 Webhook，并轮询已配置的 GitHub Issue。Worker 管理进程在同一主机上并行调度实例。各实例通过 SQLite 独占领取 Issue，使用独立沙箱执行，并将 OpenCode 的模型请求交由 AgentGateway 转发。方案评论与草稿 PR 通过 GitHub App 发布。

## Temporal 试点

TypeScript 试点通过 Temporal 编排方案审批、沙箱执行和交付。在隔离环境运行和验收的步骤见 [试点说明](temporal/README.md)。

## 部署

生产部署由 GitHub Actions 在变更合并到 `main` 后触发。首次配置见[部署流水线说明](deploy/README.md)。

失败重试、指数退避和人工恢复见[失败重试实践](docs/retry-policy.md)。

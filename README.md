# Loom

Loom 是一套 **Agent 驱动的研发流程**，旨在改造从需求到交付的日常研发协作。它将 GitHub Issue、实现方案、代码变更和验证结果串成一条可追踪的流程，让 Agent 持续推进规划、编码与修复，让维护者在方案确认、发布授权和代码评审时做决定。

## 研发流程

```mermaid
flowchart TD
    issue["GitHub Issue：记录需求"] --> plan["Agent：起草并回贴实现方案"]
    plan --> approval{"维护者确认方案"}
    approval -->|已确认| code["Agent：在沙箱中修改获准的文件"]
    code --> validation{"Worker 本地验证"}
    validation -->|需要修复| repair["Agent 修复"]
    repair --> validation
    validation -->|通过| patch["Worker 保存补丁"]
    patch --> release{"获得发布授权"}
    release -->|已授权| pr["草稿 PR：交付变更供评审"]
    pr --> ci["GitHub Actions 检查"]
    ci --> status["控制台：查看 CI 结果"]
```

- **需求和决策在 GitHub 留痕。** 实现方案回贴到原 Issue，由维护者回复 `/loom approve <方案编号>` 确认。草稿 PR 需要单独获得发布授权。
- **沙箱执行，验证后交付。** Agent 只在预先获准的文件范围内修改代码。Worker 运行本地检查，验证通过后保存补丁。
- **进度和结果可追踪。** 控制台汇总任务阶段、草稿 PR 和对应提交的 CI 结果，也可发起运行请求。

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
        console -->|读取状态、提交运行请求| db
        db <-->|领取任务、记录进度| worker
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

Controller 接收签名 Webhook，并轮询已配置的 GitHub Issue。Worker 通过 SQLite 领取任务、记录阶段，并将 OpenCode 的模型请求交由 AgentGateway 转发给 DeepSeek。方案评论与草稿 PR 通过 GitHub App 发布。

## 部署

生产部署由 GitHub Actions 在变更合并到 `main` 后触发。首次配置见[部署流水线说明](deploy/README.md)。

# Loom

brand new workflow with AI

Loom 是 ai-native 工作流的源码仓库。当前部署接收 `LeeJim/HowToCookOnMiniprogram` 的 GitHub Issue，使用 DeepSeek 和 OpenCode 生成方案，等待确认后执行代码任务，并可在获得发布授权后交付草稿 PR。

源码仓库、工作流目标仓库与服务器运行数据彼此独立。本仓库包含 Controller、Worker、控制台、MCP、部署配置及 GitHub Actions 工作流模板。以下部署记录同时保留了早期验收过程。

## ai-native 部署记录

2026-11-26，Ubuntu 24.04，2 核、约 1.9 GiB 内存、约 1.9 GiB 交换空间。安装前根分区有 32 GB 可用空间。部署目录为 `/opt/ai-native`。SSH 使用 `ssh ai-native`。

| 检查 | 实测结果 |
| --- | --- |
| SSH 与服务 | SSH 可用，安装前无失败的 systemd 单元 |
| 出站网络 | GitHub API 与 npm 返回 200。GHCR、Docker Hub、DeepSeek 的匿名探测返回 401 |
| 基础设施 | Docker 29.1.3，Compose 2.40.3 |
| AgentGateway | v1.7.0，`127.0.0.1:4000`，模型列表返回 200 |
| DeepSeek | 使用占位凭证时返回 401。加载服务器凭证后，模型推理成功，上游返回 `deepseek-flash` |
| OpenCode | Docker 镜像构建成功，在禁用网络的容器内确认版本 1.19.6。接入内部网络后访问网关返回 200，直连 GitHub 失败 |
| Controller | `127.0.0.1:8787`，健康检查通过。测试 Issue #13 已入队。重启后 API 和只读 SQLite 查询均返回该记录 |
| Issue #13 执行 | 已到达 `Delivery`，`repair_count=0`，`last_error=null`。补丁仅向 README 增加 7 行 |
| 补丁复核 | 基于本地 `origin/main` 的 README 验证通过，包括 `git apply --check` 和 `git diff --check`。说明中的两条版本命令均运行成功 |

## 运行与核验

网关使用本目录的 `compose.yaml` 和 `gateway.yaml`。Controller 镜像来自 `controller.Dockerfile`，当前以独立容器 `ai-native-controller` 运行，挂载 `/opt/ai-native/data` 持久化 SQLite。它默认每 120 秒轮询至多一个已授权且尚未入队的公开 Issue，并遵循 GitHub 返回的限流重试时间，根据 Issue 编号去重。`secrets/controller.env` 当前配置 `ISSUE_NUMBER=13`。

轮换 DeepSeek 密钥，在服务器的 `secrets/gateway.env` 更新 `DEEPSEEK_API_KEY`。文件权限保持 `0600`。在服务器执行以下命令，验证模型并检查沙箱网络是否仍挂载到重建后的网关。

```sh
cd /opt/ai-native
sudo docker compose up -d --force-recreate gateway
sudo docker network connect --alias gateway ai-native-sandbox ai-native-gateway-1
curl -fsS http://127.0.0.1:4000/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"deepseek/deepseek-v4-flash","messages":[{"role":"user","content":"Reply with OK"}],"max_tokens":128}'
curl -fsS http://127.0.0.1:8787/jobs
```

测试执行器由操作员在模型冒烟测试通过后启动。它只给沙箱挂载 README，使用主机文件锁保证执行器单并发，SQLite 记录阶段及错误，检验失败时允许一次修复。此执行器仅适用于 Issue #13。Delivery 阶段产物是 `data/issue-13.patch`。

```sh
sudo python3 /opt/ai-native/workflow/run-docs-test.py
```

测试 Issue 已获授权并创建。补丁保存在服务器的 `/opt/ai-native/data/issue-13.patch`。经确认后，已将补丁应用到目标仓库最新 `main` 并推送至 `codex/ai-native-issue-13`。提交为 `a3f2eff73f6bda0bebb781d1a62012bbaae3f1e6`。操作员通过 GitHub 创建了[草稿 PR #14](https://github.com/LeeJim/HowToCookOnMiniprogram/pull/14)，关联 Issue #13，PR 已核实为草稿且未合并。目标仓库现有工作流由特定 PR 评论或 main 分支推送触发，云端质量检查待单独接入。通用任务执行仍待接入。GitHub 仓库侧的 Webhook 设置见下。

- [AgentGateway DeepSeek 配置](https://agentgateway.dev/docs/standalone/latest/integrations/llm/providers/deepseek/)
- [OpenCode 自定义提供商](https://opencode.ai/docs/providers)
- [公开测试 Issue #13](https://github.com/LeeJim/HowToCookOnMiniprogram/issues/13)

## HTTPS 入口

`ai.anyhub.cn` 使用容器 `ai-native-https` 在 TCP 443 提供 HTTPS。服务器配置位于 `/opt/ai-native/proxy/Caddyfile`。Caddy 通过 443 上的 ACME TLS-ALPN-01 验证取得 Let's Encrypt 证书，证书和续期状态保存在 Docker 卷 `ai-native-caddy-data`。

公网实测 `https://ai.anyhub.cn/healthz` 返回 200，证书校验通过。代理将该路径转发到 `127.0.0.1:8787`。公网 `/jobs` 返回 404。

## GitHub Webhook

接收端已部署在 `POST https://ai.anyhub.cn/webhooks/github`。Controller 对原始请求体验证 `X-Hub-Signature-256`，限制仓库为 `LeeJim/HowToCookOnMiniprogram`，并在同一个 SQLite 事务中记录投递 ID 和入队。当前仅允许配置的 Issue #13 的 opened 或 reopened 事件入队。Polling 继续运行。

公网实测匿名 POST 返回 401。服务器 TLS 入口测试中，有效签名返回 202，重复投递不会重复处理，其他仓库返回 403。无外网临时容器测试确认有效 Issue 事件可以在空数据库创建一条 Planning 任务，重投后仍只有一条。生产环境原有 Issue #13 保持 Delivery。

在 GitHub 仓库 Settings → Webhooks → Add webhook 中使用上述 URL、`application/json`、Issues 事件，启用 SSL verification。Secret 从服务器 `/opt/ai-native/secrets/github-webhook` 取得，权限为 `0600`，直接粘贴到 GitHub。仓库配置完成后，服务器于 2026-11-26 20:50:20（UTC+8）收到 GitHub 的实际 ping。签名验证通过，投递记录已写入 SQLite。

## 单任务 Worker

`ai-native-worker.service` 已启用，当前执行目录为 `/opt/ai-native/workflow-worker-v5`。Worker 每 5 秒查看 SQLite，只认领已配置执行配置的任务，并与手动执行器共用 `data/worker.lock`。当前配置只适用于 Issue #13 的 README 验收用例。

隔离数据库测试验证了从中断阶段重新认领、失败后停止重试、跳过已交付任务及未获准任务。重启后，中断任务从 Planning 重新执行，阶段记录用于识别中断状态。本次服务器实测确认了独占文件锁和 systemd 重启，已交付的 #13 保持 Delivery。真实 Issue 触发 Worker、通用代码任务、云端验证、自动 PR 写回与 MCP 调用待验收。

## Issue #13 交付回写

通过 GitHub 连接器确认 PR #14 仍为打开的草稿，未合并。使用 `record-delivery.py` 将 Issue 编号、PR 编号、链接和完整提交 SHA 写入服务器 SQLite 的 `pr_deliveries` 表。同一交付可重复写入。GitHub 返回该提交的 PR 工作流运行数为 0。此次为操作员回写，自动发布和工作流结果回传仍待接入。服务器直接查询 GitHub API 时出现匿名请求限流，核对改由 GitHub 连接器完成。

2026-11-26 22:19（UTC+8），按授权关闭后立即重开 Issue #13。GitHub 确认最终状态为 open。服务器在两次操作后分别记录两条有效签名的 `issues` 投递，共四条。数据库仍只有一条 #13 任务记录，阶段为 Delivery，修复次数为 0，且 PR #14 的交付记录仍在。此次验收覆盖了真实 Issues Webhook 和已交付任务的入队去重。


## 云端验证、Repair 与 MCP

- 云端验证分支为 `codex/ai-native-ci-validation`，工作流提交为 `1d08451991f08c2104a95b671762f2665684a464`。[GitHub Actions 运行 45838749856](https://github.com/LeeJim/HowToCookOnMiniprogram/actions/runs/45838749856) 已成功，检查了草稿 PR #14 的固定提交和 README 指令。结果已写入服务器 SQLite，服务器本机 `GET /ci-validations` 可查。
- Controller 已支持签名 `workflow_run.completed` 回传。隔离测试验证了登记的工作流路径和 SHA 匹配后入库、未登记的 SHA 被忽略、重复投递不重复入库。GitHub 已投递真实 Workflow runs 事件。原始结果由操作员回写，重跑结果由 Controller 自动入库。
- 在临时数据库和临时工作目录重跑 #13。首次验证前恢复原始 README，验证失败后由 OpenCode 和 DeepSeek 实际修复，第二次验证通过并生成补丁。阶段依次为 Planning、Coding、Validation、Repair、Validation、Review、Delivery。生产 #13 和草稿 PR 保持原状态，Worker 已恢复运行。
- MCP 使用独立 AgentGateway 容器和内部 Docker 网络。沙箱实测能列出并调用只读工具 `workflow_stages`，无法直接连接 MCP 上游。OpenCode 1.19.6 的 `mcp list` 显示连接成功。工具没有公网端口。

2026-11-26 22:35:28（UTC+8），GitHub Actions 运行 45838749856 的第 3 次尝试经 HTTPS Webhook 自动写入 SQLite，结论为 success，关联 Issue #13、PR #14 和已验证的 PR head。Controller 按 run ID 和 attempt 去重，查询返回最新尝试。


## Worker v3 与草稿发布

- Worker 支持从 `AI_NATIVE_CODE_PROFILES` 指定的 JSON 读取 Issue 编号和允许修改的现有 JavaScript 文件列表。代码任务只向 OpenCode 挂载这些文件。验证包括工作区文件范围、离线 Node 语法检查和补丁可应用性。在隔离 Git 仓库中用实际 OpenCode 和 DeepSeek 生成修改，通过了独立的 JavaScript 行为断言。线上仍只启用已授权的 #13 README 用例。
- Worker 会为已登记、关联当前 PR 提交的最新失败 CI 尝试生成一次 Repair 候选。候选写入独立补丁，保留原补丁和交付记录。隔离测试注入 CI 失败记录后，实际模型修复通过行为断言；重复扫描没有产生第二次修复。线上 GitHub Actions 当前结果为 success。
- 草稿发布器读取已验证补丁的摘要及基准提交，只允许策略中列出的 Issue 和文件。已在本地 Git 远端与模拟 GitHub API 上验证新分支、草稿 PR 回写、重复执行和文件范围拒绝。服务器已安装发布器。真实发布仍需为该仓库专门签发的 GitHub 凭证，具备 Contents 和 Pull requests 写权限，凭证文件权限为 0600。systemd 可通过 `AI_NATIVE_GITHUB_APP_CONFIG` 指定 App 配置，通过 `AI_NATIVE_PUBLISH_ISSUES` 指定允许发布的 Issue。凭证只供发布器使用。已有 PR 回执的任务会跳过发布。

## 可视化控制台

`ai-native-console.service` 已部署到 `/opt/ai-native/console`，仅监听服务器的 `127.0.0.1:8790`。在本机建立 SSH 隧道：

```sh
ssh -N -o ExitOnForwardFailure=yes -L 8790:127.0.0.1:8790 ai-native
```

保持终端运行，访问 [本机控制台](http://127.0.0.1:8790/)。页面显示阶段编排、阶段任务数、执行和 Repair 次数、任务筛选、执行时间线、CI 回传与 PR 交付。默认每 15 秒刷新，可暂停。控制台通过只读 SQLite 连接读取数据。

Worker v4 增加了运行及阶段记录。服务重启时，将没有结束记录的旧执行标记为 interrupted。历史 Issue、CI 和 PR 数据会继续展示。执行次数从启用遥测时开始统计。

生产实测为 Issue #13、Delivery、PR #14、CI 第 3 次尝试通过。通过 SSH 隧道验证了页面、静态资源和 API 的 HTTP 200。工作流记录和页面渲染逻辑通过隔离测试。内置浏览器预览超时。


### 多 Issue 和可复用云端检查

Controller 也支持 `ISSUE_NUMBERS`，值为逗号分隔的 Issue 编号。与 Worker 的代码执行配置分别生效，新增真实任务时需对应登记。线上仍仅启用 #13。隔离环境验证了多个获准 Issue 入队、重复投递去重和未获准 Issue 被忽略。

控制台的任务交付列显示发布状态和错误，也可查看 CI 修复候选的执行结果。生产库当前无新的候选补丁。SQLite 隔离测试覆盖了有候选补丁和有发布失败的情况。

`pr-validation.yml` 是可复用的草稿 PR 工作流。脚本在本地 Git 样例中通过正反测试。它仍待纳入目标仓库，并接入通用 CI 任务登记。现有 #13 验证仍使用已通过实测的固定提交工作流。自动发布的 GitHub App 已配置，真实写入验收仍待有未交付的获准任务。


### GitHub App 发布身份

Worker v5 使用 GitHub App，从仓库 API 自动获取安装 ID，并为推送分支与创建草稿 PR 按需生成短期安装令牌。安装令牌仅在内存中使用，权限限定为目标仓库的 Contents 和 Pull requests 写权限。现有仓库 Webhook 继续用于事件接收。

在 GitHub 上注册私有 App，只安装到 `LeeJim/HowToCookOnMiniprogram`。将 PEM 直接上传至服务器 `/opt/ai-native/secrets/github-app.pem`，由 root 持有，权限为 0600。再将下列配置保存到 `/opt/ai-native/secrets/github-app.json`，用实际 App ID 替代示例值。

```json
{"app_id": 123456, "private_key_file": "/opt/ai-native/secrets/github-app.pem"}
```

无需写入安装 ID，也无需手动生成安装令牌。配置完成后，可以在服务器运行以下命令验证认证和权限，命令只读取 GitHub 仓库信息。

```sh
sudo -n python3 /opt/ai-native/workflow-worker-v5/github_app.py
```

RSA 签名、仓库授权范围和权限检查已通过本地验证，已在服务器实测 App 5946520 的仓库范围安装令牌，确认 Contents 和 Pull requests 写权限。使用该令牌查询的目标 Git 分支与草稿 PR #14、SQLite 回执的提交一致。systemd 发布白名单当前为 #13，已有交付回执，因此本次未执行分支推送或创建 PR。

### 通用 PR CI 回传

Controller 已部署对 `.github/workflows/ai-native-pr-validation.yml` 的签名回调处理。它按 PR 编号和当前交付提交 SHA 关联结果。若回调先于发布回执到达，Controller 最多保留七天并定期补关联。隔离测试覆盖了回调乱序、提交 SHA 不匹配、非指定工作流及重复投递。

模板在本项目的 `pr-validation.yml`，目标仓库仍待通过正常代码审查纳入该工作流。现有独立 CI 分支和 #13 的回传继续有效。服务器另使用 GitHub App 安装令牌对既有 #13 分支执行了 `git push --dry-run`，成功连接 GitHub 写入端点，远端分支没有变化。

通用工作流已提交到目标仓库分支 [codex/ai-native-pr-workflow](https://github.com/LeeJim/HowToCookOnMiniprogram/compare/main...codex/ai-native-pr-workflow)，提交为 `f9c6ddccd896f421626e289977a18bf3936c8206`。工作流按 PR 的共同祖先检查变更，避免把主分支的独立提交算到 PR 上。已使用 GitHub Compare API 返回的共同祖先和 PR #14 的实际提交在本地执行完整检查脚本，结果通过。该工作流仍待进入 `main` 后进行真实 PR 自动触发验收。

### Issue #15 真实代码任务验收

用户已提交 [Issue #15](https://github.com/LeeJim/HowToCookOnMiniprogram/issues/15)。Controller 和 Worker 已登记该任务，审批文件范围为 `miniprogram/utils/index.js`。任务实际执行一次，经过 Planning、Coding、Validation、Review、Delivery，修复次数为 0。补丁保存在服务器 `/opt/ai-native/data/issue-15.patch`。按原基准提交重放补丁后，在无外网容器中验证了默认输出、关闭秒数和显式开启秒数三个断言，并确认 `groupBy` 仍导出。控制台可查到执行时间线。发布策略仍仅允许 #13，#15 尚无 PR 或 CI 记录。

### 标签授权与公网登录

- 在 `LeeJim/HowToCookOnMiniprogram` 的 Issue 上，由 LeeJim 本人添加 `ai-native:publish`。签名 Webhook 校验操作者数字 ID，只有已配置执行范围的 Issue 可以使用标签授权。发布前会复核最新授权、Issue 开放状态和当前标签。移除标签或关闭 Issue 会撤销尚未使用的授权。已有草稿交付回执会阻止重复发布。
- 标签只授权向独立分支推送并创建草稿 PR。工作必须先生成通过本地检查的补丁。#15 的三个 `formatTime` 行为断言已接入本地 Validation。GitHub 自动合并仍由维护者控制。
- 公网入口为 [ai-native 控制台](https://ai.anyhub.cn/console/)，浏览器使用 HTTPS Basic Auth 登录。用户名为 `operator`。在可信的本地终端使用 `ssh ai-native 'sudo -n cat /opt/ai-native/secrets/console-password'` 读取随机密码。Caddy 仅加载 bcrypt 哈希。公网控制台路由不会转发 Authorization 头给 Python 应用。
- “运行”按钮只对已登记、没有活跃执行、尚无发布记录和标签授权的任务可用。重复请求会去重，Worker 按单任务锁执行。持久化执行和阶段记录可在同一页面查看。公网 POST 校验同源 Origin。

公网实测匿名页面及 API 返回 401，认证后可获取页面、资源和数据，跨站运行请求返回 403，已交付 #13 和重复点击返回 409。通过公网运行按钮接口提交 #15 后，Worker 只新增一次执行，三个行为断言通过并生成新版补丁。#15 当前等待标签授权。签名标签的所有者校验、撤销、乱序和未登记 Issue 均已通过生产镜像的隔离测试。

### Issue 方案确认

已登记的 Issue 第一次进入 Worker 或由控制台请求重跑时，先由只读 OpenCode 生成方案。GitHub App 在原 Issue 下发出带版本号的评论，列出允许修改的文件、实现步骤和验收方式。控制台显示「待确认方案」并链接该评论。Worker 大约每 20 秒检查等待中的方案，没有确认时不进入 Coding。

确认方法是在同一 Issue 下使用 LeeJim 账号发表新评论，完整复制机器人给出的 `/ai-native approve <方案编号>`。仅当前编号、正文完全匹配且发于方案之后的未编辑评论有效。Issue 标题、正文或执行文件范围变更时会重新生成方案；执行前会核对 `main` 的基准提交，基准变化也需要新方案。控制台的运行按钮提交规划请求，同样受确认门槛约束。审批方案只允许执行，创建草稿 PR 仍由 `ai-native:publish` 单独授权。

旧任务与交付回执保持原状态。隔离测试覆盖方案先发、非所有者确认忽略、Issue 改动后旧确认失效，以及当前方案只执行一次。

服务器实测 GitHub App 可读取 #15 及评论列表，OpenCode 能从允许文件生成只读实现方案。该冒烟测试未在现有 Issue 下发表评论，也未生成补丁。

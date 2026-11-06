# 外部 Agent 协作规划：Skill / CLI 与 Codex 接入

> 状态：已规划，待排期；功能、依赖和原生权限均未实施。记录日期：2026-11-06。
> 本次用户要求：先规划「Skill + 命令行工具」和「Codex SDK / App Server」，等待后续加入。本文件不构成启动实现、安装依赖、测试、调用模型、提交或发布的授权。
> 后续明确启动实施时，使用 `executing-plans` 按阶段推进；测试与推送继续遵守当前仓库 `AGENTS.md`，不得沿用其他专项的历史授权。

**Goal:** 让本机外部 Agent 更方便地操作 AI Canvas，并让画布能够把明确范围的任务交给独立 Codex 会话，安全接收和应用结果。

**Architecture:** 两条路线共用现有工具、权限和任务基础。A 线先提供外部操作 Skill，再以薄 CLI 复用现有本机控制桥；B 线优先由 Rust 管理 Codex App Server 的 stdio 会话，通过主窗口编排任务，先返回建议，再接入受控写回。SDK 保留为备选，不同时实现两套执行后端。

**Tech Stack:** 现有 Tauri、Rust、React、TypeScript、Zustand、MCP 控制桥与 Node 脚本；Codex 的最低版本、认证和分发方案须在 B0 确定，本轮不新增依赖。

主入口：[MCP 控制模块](../MCP控制模块.md)。B 线涉及的任务控制、模式和多窗口边界参见[对话助手 Agent](../对话助手-Agent能力实施方案.md)；业务能力仍归各自模块。

与[多模型 Agent 集群专项](./2026-11-06-multi-model-agent-teams.md)结合时，CLI/MCP 是团队任务入口，Codex 是可选角色执行器，Team Run 统一调度、产物、预算与写回。通用文本 API 团队可先实施，不必等待 Codex；不由每个入口另维护剧本权威。本规划两条路线仍待排期、未实施。

## 1. 两条路线与当前事实

| 路线 | 用户体验目标 | 首期边界 |
|---|---|---|
| A：Skill + CLI | 对外部 Agent 说「读取这个项目，修改这些节点并核对结果」，由其通过终端完成 | 需要桌面应用运行且用户已开启本机控制；CLI 首期仍复用 MCP 所使用的本机桥，不是独立替代协议 |
| B：Codex SDK / App Server | 选中节点，交给 Codex，查看进度、继续任务并把成果放回画布 | 创建独立 Codex 会话；不接管当前 Codex 桌面聊天，不读取其他聊天，不替换内置 Agent 或只读子智能体 |

静态核对到的现有基础：

- [ai-canvas-mcp.mjs](../../scripts/ai-canvas-mcp.mjs) 导出 `LoopbackClient`，已有本机连接、请求、取消和关闭能力。打包入口为 [build-mcp-adapter.mjs](../../scripts/build-mcp-adapter.mjs)，当前 [tauri.conf.json](../../src-tauri/tauri.conf.json) 登记的是 MCP 适配器资源，未提供本规划的 CLI 资源。
- [mcpToolCatalog.ts](../../src/services/mcp/mcpToolCatalog.ts) 提供发现与调用信封；[mcpControlService.ts](../../src/services/mcp/mcpControlService.ts) 将请求接入 Registry、Policy 和任务审计。[mcpOperationService.ts](../../src/services/mcp/mcpOperationService.ts) 的操作键只覆盖当前项目的 `canvas_write` / `media_generation`，不能推广为所有写入均可安全重投。
- [agentTaskControl.ts](../../src/services/chat/agentTaskControl.ts) 的 `runAgentTask` 已接受执行器；[agentTaskService.ts](../../src/services/chat/agentTaskService.ts) 有重启后暂停规则。[AgentTask](../../src/types/agent.ts) 尚无本规划的外部执行器身份，现有专家父子任务字段属于只读子智能体。
- [agentToolExecution.ts](../../src/services/chat/agentToolExecution.ts) 是可复用的受控工具执行入口；主窗口仍为 Store 写入源。上述基础不表示两条新路线已经实现或通过验收。

旧 [Codex 机制对照专项](./2026-10-11-agent-codex-alignment.md) 改进的是内置 Runtime；本规划新增可选外部执行器，与其职责不同，不将旧完成记录作为接入证据。

## 2. 共用约束

1. 启用入口、材料范围和任务归属明确可见。任务绑定项目、会话和任务 ID；选中节点、必要引用与显式模型选择组成有界材料，不默认导出全画布、完整本地文件或其他会话。
2. 外部 Skill 是操作知识，与应用内 Skill 导入、Agent Package 和 Codex 跨会话记忆分别管理；安装 Skill 不授予执行权限，不自动导入应用，也不修改 Hindsight 或产品记忆。
3. 新入口复用 Registry、本地 schema、Policy、Store Action、历史快照和派生守卫。读后写同时考虑项目、revision 与目标节点内容指纹；手动改稿不一定推进全局 revision，不能仅依赖 revision。
4. A 线沿用现有 MCP 控制会话权限；B 线写回遵守其所属 AgentTask 的 Plan/B/C 模式。不能借用 MCP 自主身份绕过 B 模式确认或 Plan 的只读限制，`user_choice` 始终按既有规则由用户回答。
5. 密钥、固定令牌、原生安装路径和运行时句柄不得进入普通持久化、对话元数据或诊断。外部结果和 Skill 内容均是不可信输入，不提供任意 Shell、任意路径或通用网络执行入口。
6. 写入、删除和付费生成不自动重试。断线、取消和超时先核对原操作；进程退出、请求取消或模型说「完成」都不能证明画布写入或厂商任务已经完成。

## 3. A 线：Skill + CLI

### A0：确定最小使用合同

- 先支持本机、用户已有 Node 环境和已开启的控制会话；不自动开启 MCP、不修改网络绑定、不自动安装运行时。
- 以「读取一个项目 → 修改一个文本节点 → 核对结果」为最小闭环，再扩展模型配置、素材与生成流程。首次验收不调用付费模型。
- 发现遵守「先工具简介，再按需读完整参数」；Skill 不复制整份静态工具目录，参数以运行中的应用返回值为准。

### A1：外部操作 Skill

拟新增 `.agents/skills/ai-canvas/SKILL.md`，并按需增加 `references/`；尚未创建。该 Skill 仅面向操作运行中的 AI Canvas，避免与开发本仓库的指导混淆。先可通过既有 MCP 使用，后续增加 CLI 使用说明。

流程需覆盖：

1. 确认应用和连接状态，按项目 ID 区分同名项目，读取实际节点与引用。
2. 查找工具简介、读取 schema，确认目标节点、当前内容和已选模型；优先复用已有节点和素材。
3. 创建/连线沿用宿主自动布局；分镜表按需使用，不强制创建额外全文或剧本快照。
4. 写入携带项目、版本和工具要求的节点指纹；配置保存先预览，不向模型或诊断暴露凭据。
5. 画布写和付费生成保留同一意图的操作键；失败后先读原回执，不换 key 重投；其他写入不能宣称具备相同保证。
6. 回读实际结果，说明已执行、等待用户选择、冲突或结果不确定，并保留后续查询标识。

### A2：薄 CLI

拟新增 `scripts/ai-canvas-cli.mjs`，直接复用 `LoopbackClient`，首期不为一个调用方重构公共传输层。下面是拟定命令合同，不是当前可运行命令：

| 拟定入口 | 职责 |
|---|---|
| `status` | 只读诊断已配置的连接和协议兼容性，不开启服务，不显示令牌 |
| `tools search` / `tools describe` | 映射现有工具发现与完整参数读取 |
| `call` | 从 stdin 或 UTF-8 JSON 文件读取完整 `tools_call` 信封，透传真实工具名与参数 |
| `operation get` | 调用现有 `mcp_operation_get` 回查原操作，不重新提交 |

- `expectedProjectId`、`expectedRevision`、`operationKey` 位于调用信封，与 `name` / `arguments` 同级；节点指纹按目标工具 schema 传入。不要把信封字段混入业务参数。
- stdout 只输出结构化结果，stderr 为有界脱敏诊断；退出码和错误类型稳定区分输入错误、连接失败、业务拒绝/冲突、取消及结果不确定，不把超时统一当作未执行。
- 令牌由用户侧受信运行环境注入，优先沿用 `AI_CANVAS_MCP_TOKEN`；不新增命令行明文令牌入口、不把令牌写进 Skill、示例或诊断。环境传递也不等于跨进程隔离。
- Ctrl+C、超时和退出关联当前请求取消并关闭连接；不承诺撤销已提交的厂商任务，也不把跨进程取消任意任务列入首期。
- 只在有效控制会话内工作；不直接读写 IndexedDB、项目存储文件或绕过主窗口调用 Store。

### A3：说明与交付

- 在 [McpControlSettings.tsx](../../src/components/settings/McpControlSettings.tsx) 补 CLI/Skill 入口说明、运行前提和脱敏诊断，复用 UI Kit、主题与现有多语言机制。
- 首期交付仓库脚本与 Skill；独立可执行文件、无 Node 安装体验及安装包内资源在后续明确分发需求后再做，届时分别修改构建入口与资源登记。
- 原 stdio 与 HTTP MCP 客户端保持兼容。真正脱离 MCP 控制会话的本机 RPC/命名管道不在本期，需求成立后另评估，避免维护平行控制协议。

## 4. B 线：画布委派 Codex

### B0：版本、认证与执行边界可行性

以下问题须在启用功能前形成明确结论；不能由提示词替代实际约束：

- **接入选型**：产品优先 Rust → Codex App Server stdio；TypeScript SDK 是服务端 Node 方案，不能直接塞入 Tauri Renderer。SDK 仅作替代路线，不并行引入 Node/Python 常驻进程。[官方选型](https://developers.openai.com/blog/codex-as-a-platform)、[SDK 要求](https://learn.chatgpt.com/docs/codex-sdk)
- **版本合同**：实施时确定受支持版本与对应 schema、握手、线程、事件和中断合同；遇到未知关键协议失败关闭。当前 stdio 使用 JSONL，WebSocket 及动态工具接口仍带实验限制，不把它们作为首期稳定依赖。[App Server 协议](https://learn.chatgpt.com/docs/app-server)
- **认证适用范围**：官方明确 app-server authentication 不允许用于商业或托管服务；本机个人接入、新应用分发和本项目 source-available 形态的适用性需重新核实。商业发行按官方支持的 Sign in with ChatGPT 或 API 认证路线评估，不预设可复用订阅或免费额度。AI Canvas 不导入 Codex 凭据文件；如果需要宿主持有 API Key，只能走 `secret_store`。[官方认证边界](https://learn.chatgpt.com/docs/app-server#auth-endpoints)
- **安装与进程**：首期候选为用户已有的受支持本机 Codex；原生登记并校验安装身份，不自动下载或升级。Renderer 只提交受限任务参数，不能指定 executable、脚本、argv、cwd、env 或输出路径。确切发现与原生定位保存方式留在本阶段确定，不把绝对路径写入普通配置。
- **宿主能力隔离**：逐项证明如何限制 Shell、文件读写、网络、继承的用户配置、其他 MCP/插件和浏览器能力；普通 read-only 仍可运行只读命令，网络代理也不覆盖全部工具。工作目录、Job Object、拒绝审批或「只输出建议」提示词不能单独证明隔离。无法约束所需模式时，停止该模式的接入，保留手动交接候选，不开放宿主权限。[官方安全边界](https://learn.chatgpt.com/docs/agent-approvals-security)
- **材料与留存**：工作区仅包含用户选择的必要材料，禁止以应用源码、用户主目录或整个项目媒体目录作为默认工作区；若暂存，必须是受限私有目录并纳入通用文件/归档拒绝保护。分别明确应用脱敏摘要与 Codex 自有线程留存、清理策略，不承诺停止进程即删除外部历史。
- **预算可观测性**：核实外部模型轮次、token、费用的实际可观测性和可强制上限，确定任务时限、输出与并发限制。宿主工具预算不等于 Codex 模型开销预算；未知用量标为未知，不记为零，也不声称受内置 `maxModelRounds` 自动约束。

冻结方案后，在 `doc/adr/` 按当时实际编号记录认证、隔离和传输取舍；本文件目前是待实施方案，不改写现行架构决策。

### B1：选中内容 → 独立任务 → 建议

1. 桌面画布提供显式入口，让用户选择节点、必要引用、任务目标和可见材料范围；只投影选中材料的有界快照，提供发送前范围摘要。
2. 主窗口创建外部执行任务，绑定 `projectId`、`conversationId`、`taskId` 和运行期会话身份；Codex 的 `threadId` / `turnId` 映射回同一任务，拒绝无匹配身份的迟到事件。
3. Rust 按固定启动合同管理 stdio、请求关联、并发和输出上限。stdout 只解析协议，stderr 有界脱敏；进度映射为任务事件，不复制完整调试日志或推理正文。
4. 任务中心展示来源、进度、停止和明确错误。Codex 缺失、未登录、额度耗尽、版本不支持与协议异常分别显示，不静默转交其他付费模型。
5. 第一闭环只返回文本/结构化建议，不改画布、不生成媒体。取消先发送协议中断，超时再回收所属进程树；应用退出参与既有退出准备。独立窗口只同步脱敏状态和动作，主窗口唯一执行；关窗交接回主窗口，按现有后台任务语义继续，不因展示切换重启或取消任务。

### B2：受控结果写回

- 返回值只接受本地 schema 定义的白名单操作提案，展示建议与实际已执行操作的区别；模型输出不能当代码、文件路径或原生命令执行。
- 主窗口将提案交给 `executeRegisteredAgentToolCall` 等既有宿主执行链，保留原任务的 Plan/B/C、effect、宿主工具预算、审批与 `user_choice`；外部模型预算按 B0 的独立结论执行。不向 Codex 注入应用的 MCP 固定令牌，不经自主 MCP 会话替 B/Plan 执行写回。
- 执行前复核项目、revision、目标节点指纹与材料授权；异步结果投影复用 `canvasDerivationGuard`。同一次宿主批量写只提交一次历史，不覆盖无关节点。
- 写回首期以文本节点和结构化配置草稿为限；付费媒体生成、删除及更广泛配置修改后续按实际工具合同扩展。生成沿用现有显式模型引用与模式规则，不新增隐含默认模型。
- 使用任务/提案身份核对已执行结果；需要跨重启去重时先确定原子持久化合同，不把当前 MCP 操作回执直接假定为通用外部任务账本。
- 动态工具直连可作为后续锁版本适配器评估；首期提案回填不依赖实验 `dynamicTools`，不额外创造平行工具执行器。

### B3：持续会话与恢复

- 首期限制每个外部会话一个活动轮次，支持明确的继续与取消；不默认启动多 Agent 并发写画布。
- 复用任务控制与恢复规则，新增明确执行器身份，旧任务缺省仍属内置 Agent。外部执行器不借用只读专家的 `parentTaskId` / `expertRole` 语义。
- 普通持久化只保存必要的执行器标识、外部线程关联、状态和脱敏摘要，不保存材料整包、控制器、进程句柄、凭据或工作区绝对路径。
- 重启后未完成任务为暂停；用户继续前复核外部线程、版本、授权及项目上下文，不自动续跑或重放写操作。仅保留线程 ID 不代表可以安全恢复。

## 5. 实施文件清单（未来范围）

下面的新增路径均为拟定，尚未创建；正式实施前再次核对源码与并行改动。按阶段只改必要文件，不一次性铺开全部范围。

| 阶段 | 拟新增 | 已有入口，按实际需要修改 |
|---|---|---|
| A1 | `.agents/skills/ai-canvas/SKILL.md`、必要 `references/` | 本专项与 MCP 模块说明 |
| A2 | `scripts/ai-canvas-cli.mjs`、`tests/scripts/aiCanvasCli.test.mjs` | `scripts/ai-canvas-mcp.mjs` 只在确有接口缺口时修改；现有适配器回归为 `tests/scripts/aiCanvasMcp.test.mjs` |
| A3 | 仅在单独确定打包方案后新增交付资源 | `src/components/settings/McpControlSettings.tsx`、`scripts/build-mcp-adapter.mjs`、`src-tauri/tauri.conf.json` 与实际多语言入口；不手改构建产物 |
| B0/B1 | `src/types/externalAgent.ts`、`src/services/chat/externalAgents/externalAgentService.ts`、`codexAppServerAdapter.ts`（同目录）、`src-tauri/src/agent/codex_runtime.rs`、`src/components/settings/ExternalAgentSettings.tsx` | `src/types/agent.ts`、`src/store/store.agent.ts`、`src/services/chat/agentTaskControl.ts`、`agentTaskService.ts`（同目录）、`src-tauri/src/lib.rs` 及准确的 `permissions/`、`capabilities/` 声明 |
| B1/B2/B3 | 对应协议映射、上下文守卫、恢复和原生进程生命周期用例，精确文件在 B0 冻结 | `src/components/SettingsPanel.tsx`、`src/components/chat/AgentTaskCenter.tsx`、`AgentTaskTimeline.tsx`（同目录）、`src/services/chat/chatWindowService.ts`、`agentToolExecution.ts`（同目录）；必要时同步 IndexedDB schema/迁移，不能仅改类型而遗漏持久化 |

原生进程取消与退出参考 `src-tauri/src/plugins/runtime.rs`，只借鉴生命周期机制，不冒用插件身份或权限。涉及路径时复用 `path_policy.rs`；新增命令与显式权限声明、调用方校验同步。新增 UI 先查 `src/styles/ui-kit.css` 和样式预览，两种主题、键盘与减少动态效果一并纳入验收。

## 6. 实施顺序与验收计划

推荐顺序为 **A0 → A1 → A2 → A3，B0 可独立调研，结论明确后再推进 B1 → B2 → B3**。不承诺日期；每阶段完成只记录真实实现和验证状态。

### A 线桌面验收

前置：运行 Tauri 桌面端，使用测试项目与无敏感数据，用户开启本机控制；有兼容 Node 和受信令牌注入。以下步骤留待实现后由用户验收：

1. CLI 获取工具简介和单工具 schema，按 ID 打开测试项目并读取画布；返回真实项目和节点，不泄漏路径或密钥。
2. 修改一个文本节点并回读；只产生预期历史。先手动修改目标节点或切换项目，再提交旧快照，应拒绝覆盖新内容并提示重新读取。
3. 对支持的画布写使用相同操作键回查，不重复执行；同 key 改参数应冲突。超时/断开后只核对原回执，不换 key 自动重投。
4. 覆盖应用关闭、错端口、无效令牌、非法/超大 JSON、工具不可用、Ctrl+C 和服务端等待用户选择；失败类别明确，取消不误报回滚。
5. 回归原 stdio/HTTP MCP 客户端与深浅主题设置说明；付费生成验收单独明确授权和成本。

### B 线桌面验收

前置：B0 兼容、认证和隔离结论已完成；用户显式启用受支持的本机 Codex，用测试项目选中一个文本节点。首次模型调用另按届时授权执行：

1. 从选中内容发出建议任务；发送范围准确，流式状态与真实终态一致，首期不改变画布。缺安装、未登录、版本不符或额度不足时明确失败。
2. 对不允许的 Shell、路径、其他 MCP/插件与网络能力做对应实际隔离验收；不能只检查 UI 没有按钮，未知审批失败关闭。
3. 关闭独立助手应交接回主窗口，后台任务继续且不重启。分别验收中途取消、禁用接入和退出应用，确认正确的任务状态与所属进程清理；终止进程不误记为厂商任务已撤销或账单已取消。
4. B2 分别检查 Plan 拒绝写入、B 等待确认、C 按现有权限执行，`user_choice` 等待真实用户；写回可撤销，未经执行的建议不标为已应用。
5. 任务中手动改目标节点、切项目或撤销材料授权，迟到结果不得错误写回。覆盖多窗口、超限输出、坏 JSON、重复事件和身份不匹配。
6. 应用重启后未完成任务暂停，不自动调用模型或重投写入；用户继续后先检查上下文。禁用接入不影响内置 Agent 和已有 MCP。

### 自动化验证入口（未执行）

实施时为 CLI 契约、App Server 协议映射、任务恢复/模式、节点冲突和原生取消增加有意义的回归；原有基线包括 `tests/services/mcp/mcpControlService.test.ts`、`tests/services/chat/agentTaskControl.test.ts`、`agentTaskService.test.ts`、`agentToolExecution.test.ts`（后三者同目录）。待文件与协议冻结后提供精确定向命令，不把未创建用例写成当前可运行检查。完整前端 CI 仅按推送或届时明确授权运行；Rust 和桌面验收另按授权范围执行。

## 7. 回退与本轮完成状态

- A 线可独立移除 Skill、CLI 和新增说明，保留现有控制桥。首期不需要新增数据库结构或原生权限；打包阶段新增资源另行回退。
- B 线默认关闭，禁用时撤销会话与运行期材料授权、取消并清理所属进程，保留必要脱敏历史；内置 Agent/MCP 继续工作。若引入持久化字段/迁移，旧记录兼容和降级须在 B0/B3 明确，不能宣称关开关等于回滚数据库。
- 本轮已完成：两条路线的范围、依赖、阶段、实施入口、验收与回退规划；已加入文档入口。
- 待完成：全部功能开发、Codex 版本/认证/隔离可行性结论、运行时与分发选择、实际模型调用、自动化和桌面验收。两条路线均未加入当前产品，不纳入现有版本已实现清单。
- **本次未运行测试，待用户验收。** 本轮仅文档及必要静态核对，未安装依赖、启动应用、调用模型、提交或推送。

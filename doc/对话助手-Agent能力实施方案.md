# 对话助手 Agent 能力实施方案

> 范围：应用内部对话助手与 Agent。最后整理：2026-09-11。
> 产品设计：[对话式画布助手功能方案](./对话式画布助手-功能方案.md)。其他模块见[文档导航](./文档导航.md)。
> 本次仅整理文档，以下完成情况沿用历史记录，不代表重新执行了功能验收。原阶段详情和测试证据见[历史归档](./history/2026-09-07-跨模块实施记录归档.md)。

## 职责与边界

本方案管理会话模式、Agent 执行循环、工具注册与策略、任务控制与恢复、上下文压缩、项目记忆、Skill、子智能体及 Agent Package 接入。

插件 UI、导演台、厂商媒体适配、画布交互、文件存储、MCP 传输和桌面安全各有模块文档。它们的 Agent 工具适配可在这里记录，业务实现与完整阶段进度仍归对应模块。

## 源码入口

| 领域 | 主要入口与职责 |
|---|---|
| 会话与多窗口 | [ChatPanel.tsx](../src/components/chat/ChatPanel.tsx)、[chatWindowService.ts](../src/services/chat/chatWindowService.ts)：会话界面、独立窗口协议，主窗口为共享状态写入源 |
| 执行循环 | [agentRuntime.ts](../src/services/chat/agentRuntime.ts)、[agentRoundExecutor.ts](../src/services/chat/agentRoundExecutor.ts)：模型轮次、工具调用与 Observation 回送 |
| 工具与权限 | [toolRegistry.ts](../src/services/chat/toolRegistry.ts)、[policyEngine.ts](../src/services/chat/policyEngine.ts)、[tools](../src/services/chat/tools/)：工具 schema、effect、授权与执行器 |
| 任务控制 | [agentTaskControl.ts](../src/services/chat/agentTaskControl.ts)、[agentTaskService.ts](../src/services/chat/agentTaskService.ts)、[store.agent.ts](../src/store/store.agent.ts)：调度、停止、审批等待与恢复 |
| 预算与上下文 | [agentBudgetService.ts](../src/services/chat/agentBudgetService.ts)、[contextManager.ts](../src/services/chat/contextManager.ts)、[contextCompressionService.ts](../src/services/chat/contextCompressionService.ts) |
| 项目记忆与子智能体 | [projectMemoryService.ts](../src/services/chat/projectMemoryService.ts)、[subAgentService.ts](../src/services/chat/subAgentService.ts)、[subAgentProfileService.ts](../src/services/chat/subAgentProfileService.ts) |
| Skill 与 Agent Package | [agentPackages](../src/services/agentPackages/)、[store.agentPackages.ts](../src/store/store.agentPackages.ts)：包目录、导入健康、运行期 Skill 接入 |
| 领域类型 | [agent.ts](../src/types/agent.ts)、[chat.ts](../src/types/chat.ts)：任务、会话、模式和预算合同 |

执行主线为：会话提交 → Runtime 调度 → 模型轮次 → Registry 校验与 Policy 决策 → 工具执行 → Observation → 后续轮次或收尾。具体业务能力继续调用所属模块的服务。

## 固定执行边界

| 工具 effect | Plan | B 协作 | C 自主 |
|---|---|---|---|
| `read` | 自动执行 | 自动执行 | 自动执行 |
| `canvas_write`、`file_write`、`permanent_delete`、`media_generation`、`memory_write`、`config_write`、`asset_write` | 拒绝 | 等待确认 | 自动执行 |
| `user_choice` | 拒绝 | 等待用户作答 | 等待用户作答 |

该表对应当前 `policyEngine.ts` 的模式判断；工具自身的授权、项目、资源和输入校验仍必须通过。MCP 的模式映射与连接授权见[MCP 控制模块](./MCP控制模块.md)。

- 新工具通过 Registry 注册，声明本地 schema 与准确 effect，不在 ChatPanel 中另加执行协议分支。
- 消息、任务和工具调用保留项目、会话、任务关联；后台任务不能使用当前已切换项目的数据。画布回写校验项目及 revision，并复用派生结果守卫。
- 主窗口执行共享状态写入；新增独立窗口操作扩展既有协议，不创建第二套持久化写入源。
- 停止同步清理控制状态并向执行链传播取消；画布写、文件写、永久删除和媒体生成不得自动重试。预算默认值及累计上限以类型与预算服务为准。
- 重启后的未完成任务只能恢复为暂停，不能自动重放有副作用的工具。网页、文件、Skill 和 MCP 内容不具有修改 Policy 的权限。
- 文件授权句柄仅在内存中使用；普通持久化不保存密钥、完整网页/文件正文或运行时控制器。项目记忆通过既有提议工具和 Policy 写入。
- 子智能体保持只读与隔离上下文；Agent Package 的导入、启停和 Skill 读取复核当前健康及授权状态，不执行包内任意脚本。

## 回复完整性

[streamParsers.ts](../src/services/ai/streamParsers.ts) 兼容 SSE 冒号后的可选空格，并保留正文缩进；收到 JSON Content-Type 时复用非流式解析并发出相同正文事件，避免正文只留在返回值而未进入会话。服务商明确错误、没有正文且没有有效工具调用的回复不得静默标记完成，需向用户报告接口/协议异常。正常的纯工具调用仍有效。

该修复不扩大工具权限，也不自动重试写操作或付费生成。媒体导入、视频制作等新业务工具的状态和验收归[MCP 模块](./MCP控制模块.md)，不在本方案重复登记业务完成日志。

## 阶段状态与待办

下表汇总历史已记录的状态，避免把局部回归通过扩大为整个阶段完成。

| 阶段 / 能力 | 状态 | 后续与历史依据 |
|---|---|---|
| P3 基础 Agent | 已完成；早期 P3-C1 联网方案曾移除 | [P3 记录](./history/2026-09-07-跨模块实施记录归档.md#agent-p3)，当前联网实现看 P5-D |
| P4 调度、恢复、上下文、只读子智能体 | 已完成 | [P4 记录](./history/2026-09-07-跨模块实施记录归档.md#agent-p4)、[Runtime 演进计划](./plans/2026-07-21-agent-runtime-evolution.md) |
| P5-A / B / D 文档读取、配置草稿、联网检索 | 已完成 | [P5 记录](./history/2026-09-07-跨模块实施记录归档.md#agent-p5)、[只读联网计划](./plans/2026-07-23-read-only-web-research.md) |
| P5-C 端到端安全回归与验收 | 待实施 / 未闭环 | [原进度表](./history/2026-09-07-跨模块实施记录归档.md#agent-progress)；开始前重新明确当前范围与验收矩阵 |
| P5-F 核心编排收敛 | 已有实施记录 | [编排职责记录](./history/2026-09-07-跨模块实施记录归档.md#agent-orchestration) |
| Skill 渐进披露、显式绑定、领域子智能体 | 已完成已记录阶段 | [Skill 计划](./plans/2026-07-28-assistant-skill-progressive-disclosure.md)、[显式绑定计划](./plans/2026-08-12-explicit-skill-bindings.md)、[子智能体计划](./plans/2026-07-29-domain-sub-agents.md) |
| 工具详情、执行依据、项目模型路由与视觉上下文 | 已有实施记录 | [工具可观测性](./plans/2026-08-12-agent-tool-observability.md)、[执行依据](./plans/2026-08-13-agent-execution-rationale.md)、[项目上下文记录](./history/2026-09-07-跨模块实施记录归档.md#agent-project-context) |
| Agent Package 首批接入、任务 Skill 与 MCP 只读兼容 | 首批已完成，后续未完成 | 项目覆盖和后台表面接入待实施；见[Agent Package 记录](./history/2026-09-07-跨模块实施记录归档.md#agent-packages) |
| 助手可靠性、网页与厂商配置 A–D 优化 | 实现与定向检查已完成，实机验收有缺口 | [可靠性记录](./history/2026-09-07-跨模块实施记录归档.md#agent-reliability)、[A–D 联合复核](./history/2026-09-07-跨模块实施记录归档.md#agent-web-validation) |
| 项目记忆外部后端评估 | 已取消 | [取消记录](./history/2026-09-07-跨模块实施记录归档.md#agent-memory-cancelled)，不作为待实现项继续推进 |

A–D 历史联合复核未覆盖真实桌面 WebView、双窗口审批、真实厂商请求和付费生成；不能据此认定 P5-C 完成。Agent Package 的未完成范围和当时测试限制保留在原记录中，恢复开发时重新验证。

## 验证入口

- 权限：[policyEngine.test.ts](../tests/services/chat/policyEngine.test.ts)；控制与预算：[agentTaskControl.test.ts](../tests/services/chat/agentTaskControl.test.ts)、[agentBudgetService.test.ts](../tests/services/chat/agentBudgetService.test.ts)。
- 执行诊断：[agentRuntimeDiagnostics.test.ts](../tests/services/chat/agentRuntimeDiagnostics.test.ts)；Agent Package：[Store 测试](../tests/store/agentPackages.test.ts)、[Skill 接入测试](../tests/services/agentPackageSkillService.test.ts)。
- 代码变更按范围运行定向 Vitest、ESLint、应用/测试类型检查；涉及原生网页或包读取时补充对应 Rust 检查。
- 实机验收至少覆盖所改链路的审批、停止、切项目、双窗口同步与重启恢复。记录实际通过项和未覆盖项；文档整理只验证内容、链接、编码与差异。

## 后续维护

内部 Agent 阶段开始时写明范围、状态、验收和回滚；完成后更新本页对应状态，详细证据链接到该阶段计划。普通修复只在影响长期行为或待办时更新本页，不再追加对话过程、逐次命令输出、提交流水或其他模块的完成记录。

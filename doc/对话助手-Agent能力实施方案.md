# 对话助手 Agent 能力实施方案

流式 Markdown 已按稳定块复用，独立窗口节点改为增量补丁并缓存历史图片引用解析；本轮未运行测试，待用户验收。版本/引用边界和桌面步骤见[Q24～Q28 性能收敛](./plans/2026-09-09-canvas-interaction-performance.md#q24-q28-performance)。

> 范围：应用内部对话助手与 Agent。最后整理：2026-10-28（仅文档）。
> 产品设计：[对话式画布助手功能方案](./对话式画布助手-功能方案.md)。其他模块见[文档导航](./文档导航.md)。
> 历史阶段表沿用当时记录，不代表重新执行了功能验收。原阶段详情和测试证据见[历史归档](./history/2026-09-07-跨模块实施记录归档.md)；新增上下文改动见下方专项计划。

## Codex 机制对照改进

2026-10-12 已实现 Skill 按当前上下文分页读取、关键词检索、游标失效和去重重置；公开推理字段与回答正文分开，采用有界脱敏的临时展示，不保存正文到推理元数据或回传模型。流式失败保留已收到回答，压缩显示独立活动与耗时，折叠步骤后仍可恢复任务。权限、成功写操作去重、原生来源授权和最近完整轮次的边界保持由宿主控制。

范围、回滚与桌面验收步骤见[Codex 对照专项](./plans/2026-10-11-agent-codex-alignment.md)。定向检查与发布门禁的实际结果见[0.10.5 发布专项](./发布记录.md)；真实模型、Tauri 文件来源与双窗口实机项待用户验收。

## 职责与边界

启动页已提供通用助手入口，无需打开画布即可直接输入、连续追问、使用 Skill、联网、分析已授权文件和参考图，并按原有 Policy 保存文本或配置厂商。通用会话沿用现有持久化，使用独立应用级归属，不创建 CanvasProject；画布、项目资产和媒体生成不进入其工具范围。主窗口与独立窗口共用欢迎建议、范围标签、思考折叠和阅读布局。会话加载保留正在输入或刚创建的内容，追问纳入尚未落盘的上一轮回复。已实现，未运行测试，待用户验收；源码范围、GitHub 对照、边界、测试入口与回滚见[通用助手改进](./plans/2026-10-20-general-assistant.md)。

助手回形针已兼容 PNG/JPEG/WebP 参考图与原有文本授权；待发送图片由会话级 Store 草稿管理，主窗口负责选择、校验和项目文件落盘，独立窗口使用快照/补丁同步。消息只保存无路径图片引用，视觉输入、纯文本模型的视觉描述及媒体生成复用原解析链路；不自动创建画布节点，不改变工具 Policy。已补充回归用例，本次未运行测试，待用户验收；限制、源码入口、桌面步骤与回滚见[助手图片附件](./plans/2026-10-19-chat-image-attachments.md)。

本方案管理会话模式、Agent 执行循环、工具注册与策略、任务控制与恢复、上下文压缩、项目记忆、Skill、子智能体及 Agent Package 接入。

插件 UI、导演台、厂商媒体适配、画布交互、文件存储、MCP 传输和桌面安全各有模块文档。它们的 Agent 工具适配可在这里记录，业务实现与完整阶段进度仍归对应模块。

消息展示已参考 Grok 官方产品页与 Grok Build 的终端思考折叠结构收敛：回答采用平整阅读区，思考内容沿用原生折叠；连接、压缩和工具步骤共用轻量活动标记，任务暂停或结束后停止动效，并适配减少动态效果和性能模式。用户要求保留当前输入区，本次未修改其布局或样式。已实现，本次未运行测试，待用户验收；参考来源、范围和桌面验收见[通用助手改进](./plans/2026-10-20-general-assistant.md#grok-风格的消息与活动展示2026-10-20)。

## 源码入口

外部 MCP 工具已接入通用与画布会话，通过现有 Registry 和 Policy 执行；会话显式选择服务，`external_write` 在 Plan 拒绝、B 确认、C 自动执行。逐工具只读授权由用户决定，定义和会话授权修订变化使旧审批失效。主窗口单点调用，独立窗口仅同步连接名称与选择状态。已实现，未运行测试，待用户验收；连接、凭据、传输和完整实施范围见 [MCP 模块](./MCP控制模块.md#助手连接外部服务)与[专项计划](./plans/2026-10-20-assistant-mcp-client.md)。

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

## 项目模型与视觉上下文

`projectSettingsService.ts` 先提供项目默认文本模型，再回退应用助手模型；实际可用性由模型解析层判断。视觉输入由 `chat/assistantVisualContext.ts` 在请求发送前解析用户显式引用的节点、项目素材与短剧资产：支持视觉的文本模型收到受限 data URL，纯文本模型通过 `chat/visualDescriptionService.ts` 获取项目域的客观描述。共用图像准备上限为 6 张、单张 8 MiB、合计 24 MiB；图片字节不进入消息、AgentTask 或项目记忆持久化。

描述按所属剧集／项目与图片内容指纹缓存，仅保存描述、指纹和模型元数据；图片内容变化后重建，描述作为不可信素材说明，不能修改 Policy。项目视觉模型不可用时明确报错，不把说明性文字伪装成已看图。设计取舍保留在[项目视觉上下文 ADR](./adr/0007-project-visual-context.md)与[项目助手模型 ADR](./adr/0006-project-assistant-model-selection.md)。旧计划中的“自主按用途自动选择媒体模型”不再适用；对话中的图片、视频、音频生成仍要求用户本轮显式 `@model`，文本／视觉回退不能代替媒体授权。

原视觉实施计划只列验证项，未记独立执行结论。历史实施证据仍见[项目上下文记录](./history/2026-09-07-跨模块实施记录归档.md#agent-project-context)；`tests/services/chat/visualDescriptionService.test.ts` 及视觉装配、项目模型回归是后续验收入口。本次未运行检查。桌面核对项目／应用文本模型回退、视觉直传与描述缓存、换图失效和切项目隔离；真实视觉模型调用与缓存恢复不可由静态整理替代。回退应保留项目配置兼容读取，不把图片正文或旧描述转存到对话。

受控 SPA 网页读取仍是静态提取不足时的匿名回退；登录、跨来源依赖或渲染失败应明确报告，不诱导反复重试同一页面。原生来源、只读及窗口销毁边界见[桌面安全模块](./桌面运行时与安全模块.md#受控-spa-网页渲染)，网页正文始终作为不可信材料。

## 固定执行边界

| 工具 effect | Plan | B 协作 | C 自主 |
|---|---|---|---|
| `read` | 自动执行 | 自动执行 | 自动执行 |
| `canvas_write`、`file_write`、`permanent_delete`、`media_generation`、`memory_write`、`config_write`、`asset_write` | 拒绝 | 等待确认 | 自动执行 |
| `external_write`（外部 MCP） | 拒绝 | 等待确认 | 自动执行 |
| `user_choice` | 拒绝 | 等待用户作答 | 等待用户作答 |

该表对应当前 `policyEngine.ts` 的模式判断；工具自身的授权、项目、资源和输入校验仍必须通过。MCP 的模式映射与连接授权见[MCP 控制模块](./MCP控制模块.md)。

- 新工具通过 Registry 注册，声明本地 schema 与准确 effect，不在 ChatPanel 中另加执行协议分支。
- 消息、任务和工具调用保留项目、会话、任务关联；后台任务不能使用当前已切换项目的数据。画布回写校验项目及 revision，并复用派生结果守卫。
- 主窗口执行共享状态写入；新增独立窗口操作扩展既有协议，不创建第二套持久化写入源。
- 停止同步清理控制状态并向执行链传播取消；画布写、文件写、永久删除和媒体生成不得自动重试。预算默认值及累计上限以类型与预算服务为准。
- 重启后的未完成任务只能恢复为暂停，不能自动重放有副作用的工具。网页、文件、Skill 和 MCP 内容不具有修改 Policy 的权限。
- 文件授权句柄仅在内存中使用；普通持久化不保存密钥、完整网页/文件正文或运行时控制器。项目记忆通过既有提议工具和 Policy 写入。
- 子智能体保持只读与隔离上下文；Agent Package 的导入、启停和 Skill 读取复核当前健康及授权状态，不执行包内任意脚本。

## 双窗口状态同步

内嵌助手与独立窗口共用主窗口投影的模型目录、会话与任务状态。输入草稿按会话保存，列表/对话/任务中心视图统一同步；关窗和收回携带最后一次编辑。切换展示方式不重启执行任务，旧版本快照不能覆盖新状态；拿到真实首帧前保持等待。实现范围、自动检查与桌面验收缺口见[双窗口状态同步计划](./plans/2026-10-03-chat-window-state-sync.md)。

## 回复完整性

助手未绑定文本模型时，输入栏不再借用节点的历史模型偏好展示已选状态。未命中完整本地指令的请求先报告“文本模型不可用、请求尚未处理”，不会因正文包含“检查、删除”等词而回复固定画布帮助；Plan、协作、自主模式及受限 Skill 的无模型请求均显示失败。本地规则只匹配完整的简单指令（兼容句末中文标点），长任务、否定说明和引用示例的前缀不再触发画布操作。

状态：已实现，补充了规则分流、模型请求与任务失败状态的回归用例，本次未运行测试，待用户验收。桌面验收：在未绑定项目/应用助手模型、但保留节点模型偏好的环境中，输入栏应提示选择模型；发送包含“检查接口文档、生成配置草稿”的长任务，应明确提示模型不可用且任务失败。重新选择有效文本模型后原样发送，应进入模型处理；分别在主窗口与独立窗口复核，并确认“选中 3 号节点”仍可本地执行，“选中 3 号节点后先解释方案，不要执行”不会被截取执行。自动回归入口为 `tests/services/assistantStreamProtocol.test.ts`、`tests/services/chat/conversationExecutionController.test.ts`。

[streamParsers.ts](../src/services/ai/streamParsers.ts) 兼容 SSE 冒号后的可选空格，并保留正文缩进；收到 JSON Content-Type 时复用非流式解析并发出相同正文事件，避免正文只留在返回值而未进入会话。服务商明确错误、没有正文且没有有效工具调用的回复不得静默标记完成，需向用户报告接口/协议异常。正常的纯工具调用仍有效。

该修复不扩大工具权限，也不自动重试写操作或付费生成。媒体导入、视频制作等新业务工具的状态和验收归[MCP 模块](./MCP控制模块.md)，不在本方案重复登记业务完成日志。

Agent 在结束纯文本轮次前再次接收执行中补充要求；每轮由 [agentPromptGuidance.ts](../src/services/chat/agentPromptGuidance.ts) 按当前模式和实际工具列表刷新说明。模型返回 `length` 时保留 partial 回复并暂停，本轮工具提案不执行；用户可通过既有任务恢复入口继续。具体范围与回归证据见[对话上下文接入计划](./plans/2026-10-03-agent-conversation-context.md#第二阶段执行收尾与工具说明)。

## 阶段状态与待办

2026-10-03 接入 Pi 的上下文有效切点与序列化机制：续聊带回同项目、同会话的脱敏工具结果；保留完整近期对话轮次；长工具链在内存中压缩后继续，保留任务步骤、恢复去重与固定权限。来源许可、自动验证和真实模型/桌面验收缺口见[对话上下文接入计划](./plans/2026-10-03-agent-conversation-context.md)。

下表汇总历史已记录的状态，避免把局部回归通过扩大为整个阶段完成。

| 阶段 / 能力 | 状态 | 后续与历史依据 |
|---|---|---|
| P3 基础 Agent | 已完成；早期 P3-C1 联网方案曾移除 | [P3 记录](./history/2026-09-07-跨模块实施记录归档.md#agent-p3)，当前联网实现看 P5-D |
| P4 调度、恢复、上下文、只读子智能体 | 已完成 | [P4 记录](./history/2026-09-07-跨模块实施记录归档.md#agent-p4)、[Runtime 架构决策](./adr/0002-agent-runtime-evolution.md) |
| P5-A / B / D 文档读取、配置草稿、联网检索 | 已完成 | [P5 记录](./history/2026-09-07-跨模块实施记录归档.md#agent-p5)、[只读联网计划](./plans/2026-07-23-read-only-web-research.md) |
| P5-C 端到端安全回归与验收 | 待实施 / 未闭环 | [原进度表](./history/2026-09-07-跨模块实施记录归档.md#agent-progress)；开始前重新明确当前范围与验收矩阵 |
| P5-F 核心编排收敛 | 已有实施记录 | [编排职责记录](./history/2026-09-07-跨模块实施记录归档.md#agent-orchestration) |
| Skill 渐进披露、显式绑定、领域子智能体 | 已完成已记录阶段 | [Skill 计划](./plans/2026-07-28-assistant-skill-progressive-disclosure.md)、[显式绑定记录](./history/2026-09-07-跨模块实施记录归档.md#821-显式-skill-任务级确定性注入)、[子智能体计划](./plans/2026-07-29-domain-sub-agents.md) |
| 工具详情、执行依据、项目模型路由与视觉上下文 | 已有实施记录 | [工具可观测性](./history/2026-09-07-跨模块实施记录归档.md#820-agent-工具调用结构化详情)、[执行依据](./history/2026-09-07-跨模块实施记录归档.md#822-可折叠实时执行依据)、[项目上下文记录](./history/2026-09-07-跨模块实施记录归档.md#agent-project-context) |
| Agent Package 首批接入、任务 Skill 与 MCP 只读兼容 | 首批已完成，后续未完成 | 项目覆盖和后台表面接入待实施；见[Agent Package 记录](./history/2026-09-07-跨模块实施记录归档.md#agent-packages) |
| 助手可靠性、网页与厂商配置 A–D 优化 | 实现与定向检查已完成，实机验收有缺口 | [可靠性记录](./history/2026-09-07-跨模块实施记录归档.md#agent-reliability)、[A–D 联合复核](./history/2026-09-07-跨模块实施记录归档.md#agent-web-validation) |
| 项目记忆外部后端评估 | 已取消 | [取消记录](./history/2026-09-07-跨模块实施记录归档.md#agent-memory-cancelled)，不作为待实现项继续推进 |

A–D 历史联合复核未覆盖真实桌面 WebView、双窗口审批、真实厂商请求和付费生成；不能据此认定 P5-C 完成。Agent Package 的未完成范围和当时测试限制保留在原记录中，恢复开发时重新验证。

## 智能体中心卡片与大纲

- 范围：`AgentCenterPanel.tsx` 的安装卡片采用顶部紧凑操作行，下方说明、权限和大纲使用整行宽度。
- 大纲：默认折叠，按安装记录的 `entrypoints` 显示目录与 Skill 入口，各目录可独立折叠；包括停用包，不读取或执行包内正文。目录代表安装时已识别的入口，不是全部资产文件；扫描上限和预检提醒仍由原生导入流程负责。
- 状态：已实现。定向 ESLint、应用/测试类型检查及面板、安装目录、Skill 服务回归通过；实际组件的隔离浏览器检查通过默认折叠、鼠标/键盘操作、长名称、320/400/600px 宽度和明暗主题。真实 Tauri 安装包目录尚未进行界面验收。
- 回滚：撤销本次面板与对应测试改动即可，不涉及存储格式、原生权限或依赖变化。

## Skill 共享目录与导入

- 节点 `/` 菜单、主窗口和独立窗口助手、提示词润色、子智能体绑定共用手动上传和智能体包的 Skill 目录，以同一 Skill ID 调用。显式调用遵守 `user-invocable` 和包路由声明，自动发现沿用既有开关。
- 节点提交和子智能体执行从当前共享目录读取正文；来源停用、删除或目录刷新后不从组件旧快照读取。子智能体绑定不可用时，有内联角色提示词则回退，否则明确报错。
- 主窗口助手提供单文件与文件夹上传，复用已有 Store Action；桌面端文件上传同时兼容 `.zip`、`.tar.gz`、`.tgz`，经原生有界校验后按文件夹型 Skill 保存入口及文本资料。文件夹导入授权所选目录的多级附属资料。Skill 管理展示手动上传与智能体包两种来源，包内 Skill 保持只读并由智能体中心管理。
- 状态：已实现，待用户验收。本次未运行测试；回归用例已补充。范围、Tauri 桌面验收顺序和回滚见 [Skill 全软件统一调用计划](./plans/2026-10-11-unified-skill-access.md)。

## 验证入口

- Agent Package 归档预览与导入支持全局 PAX 元数据，局部 PAX 的实际路径仍经过原生校验；异常导入保留可读错误详情，元数据不作为文件或脚本执行。前端回归入口为 [agentPackageImportService.test.ts](../tests/services/agentPackageImportService.test.ts)，原生回归位于 `agent_package::tests`；具体导入健康与权限边界仍以当前源码为准。

- 权限：[policyEngine.test.ts](../tests/services/chat/policyEngine.test.ts)；控制与预算：[agentTaskControl.test.ts](../tests/services/chat/agentTaskControl.test.ts)、[agentBudgetService.test.ts](../tests/services/chat/agentBudgetService.test.ts)。
- 执行诊断：[agentRuntimeDiagnostics.test.ts](../tests/services/chat/agentRuntimeDiagnostics.test.ts)；Agent Package：[Store 测试](../tests/store/agentPackages.test.ts)、[Skill 接入测试](../tests/services/agentPackageSkillService.test.ts)。
- 代码变更由用户按范围运行定向 Vitest、ESLint、应用/测试类型检查；涉及原生网页或包读取时补充对应 Rust 检查。助手仅在用户明确授权对应检查时执行。
- 实机验收至少覆盖所改链路的审批、停止、切项目、双窗口同步与重启恢复。记录实际通过项和未覆盖项；文档整理只验证内容、链接、编码与差异。

## 后续维护

内部 Agent 阶段开始时写明范围、状态、验收和回滚；完成后更新本页对应状态，详细证据链接到该阶段计划。普通修复只在影响长期行为或待办时更新本页，不再追加对话过程、逐次命令输出、提交流水或其他模块的完成记录。

# Findings & Decisions: 全局智能体兼容体系

## Requirements

- 智能体安装后必须全局可用，不局限于当前画布项目。
- 整套智能体体系需要兼容，而不是只导入一个入口 Skill。
- 系统应根据任务按需发现和调用路由、Skill、知识、工具、模型、资产及子智能体。
- 普通聊天、画布项目、独立窗口、后台任务和 MCP 应复用一致的能力与安全边界。
- 架构方案已经用户确认，现已授权进入分阶段代码实施。
- AI 短剧智能体以及未来业务智能体都不能嵌入软件或项目，必须由用户主动上传/安装。
- 用户未安装任何智能体时，软件全部既有功能必须保持可用；智能体禁用、损坏、来源丢失、索引失败或版本不兼容也不能阻塞应用启动、项目加载、普通聊天、画布、工作流或原有模型调用。
- 智能体上传入口必须位于内部助手，并同时支持用户选择文件夹和压缩包。

## Research Findings

- AI 短剧样板是复合智能体：包含总控规则、阶段路由、28 个 SKILL.md、知识资料、视觉资产、Python 门禁和版本/回归约定。
- 当前扫描为 534 个文件、约 592.2 MiB；其中本体 18 个 Skill、海外 3 个、B 方案 6 个、Skill 创建器 1 个。
- 当前文件夹 Skill 只复制 UTF-8 的 md/txt/json，并把一个目录登记为一个 UserSkill；图片、Office/PDF、Python 和视频不会成为 Skill 资源。
- 当前 Skill 系统索引最多 24 项，单任务主动加载最多 4 个 Skill，累计 24000 字符，单个资源列表最多 60 项。
- 当前子智能体是只读领域专家，只能读取用户显式引用节点正文和当前项目短剧资产，不能代表整个外部智能体包。
- 当前插件体系面向声明式节点工具和可信 Python/QuickJS 运行时；Python 插件未作为 Agent/MCP 工具开放。
- 当前 Agent Runtime、Tool Registry、Policy Engine、任务持久化、MCP 映射已经是可复用的统一执行底座。
- 先前 MCP 讨论只形成架构建议，并没有实际把短剧知识库接入桌面软件。
- 当前 Zustand 聚合 19 个 slice；Skill、Plugin、SubAgent、模型连接和 AppConfig 已经属于全局状态，项目仅保存 ProjectSettings、节点与项目域数据。
- IndexedDB 当前为 v20，Skill、Plugin、SubAgent Profile 是全局 object store；Conversation、Message、AgentTask、ProjectMemory 等记录仍要求 projectId。
- App 启动通过统一 initFromDb 入口恢复全局和项目数据，适合作为全局智能体安装记录与目录授权状态的 hydration 入口。
- AppConfig 已有全局助手模型，ProjectSettings 已有项目默认模型和自动路由开关，证明“全局默认 + 项目覆盖”是项目内已有设计先例。
- 当前 ChatMessage/AgentTask 持久化链以 projectId 为必填关联；若要求在项目之外调用智能体，需要新增显式 ExecutionScope，而不是用伪造项目 ID 隐藏问题。
- AppConfig 现有 assetFolders 直接持久化本地绝对路径；新智能体目录不应继续复制这一模式，应把真实路径收口到原生授权层，Renderer/IndexedDB 只持久化不透明 sourceId 和可显示状态。
- 当前没有项目时会自动创建“默认画布”，说明产品运行模型仍以项目/画布为中心，没有真正的全局工作台执行域。
- buildAssistantSystemPrompt 当前总会读取 Store 的当前 nodes，并在 Agent 工具模式下注入大量画布规则；全局智能体任务若直接复用，会被不必要的画布上下文污染。
- SkillCatalog 与 SubAgentCatalog 已经全局注入 Agent 系统提示词，是全局智能体目录的可复用先例；但复合智能体需要再增加一层轻量 Agent Catalog，不能把每个包的全部 Skill 都提前展开。
- SubmitConversationMessageOptions 虽允许省略 projectId，但执行时会回退到 conversation.projectId/currentProjectId/空字符串，CreateAgentTask 和 AgentTask 仍要求 projectId，属于表面可选、内部强绑定。
- 用户显式引用的 Skill 会在 AgentTask 创建时形成不可变快照；全局智能体的版本、启用能力、Prompt、工具和知识源也应形成任务级 AgentBindingSnapshot，避免运行中更新导致语义漂移。
- 当前文本模型解析固定为“项目默认模型优先、应用助手模型兜底”；会话内切换文本模型会持久修改项目设置或全局配置，没有独立的会话覆盖层。
- GeneralModelConfig 已有类别、上下文窗口、用途描述和输入模态，适合让智能体声明“能力要求/推荐角色”，不应让智能体包携带凭据或直接写死用户连接 ID。
- 当前项目记忆只属于 projectId/seriesOwnerId；全局智能体若需要长期偏好，应新增 agent-scoped memory，并继续遵守用户确认、限长、脱敏和不保存正文的既有规则。
- 全局角色库已经采用 global/project 双作用域，并显式剥离项目节点引用，是智能体全局定义与项目绑定分离的现成设计参考。
- 用户新增硬边界：AI Canvas 只提供通用智能体平台；AI 短剧智能体不得成为内置资源、默认项目内容或源码中的专用分支。
- 当前独立窗口仍把请求交回主窗口的同一 `submitConversationMessage`，说明全局智能体也应只增加统一调用网关，不能为各入口复制 Runtime。
- 当前 AgentTask、Scheduler、Runtime、Tool Registry、Policy、审批和审计链可以直接复用；新增包层只负责目录、路由、上下文和能力声明。
- 当前 MCP 在没有活动项目时不暴露工具，并以 `mcp-control-` 会话名前缀承担部分权限语义；全局能力需改为显式 `origin` 与 `ExecutionScope`。
- `src-tauri/src/mcp_bridge.rs` 的 Streamable HTTP 当前绑定 `Ipv4Addr::UNSPECIFIED`，与项目规则要求的仅 IPv4 loopback 不一致；在向 MCP 暴露全局智能体前必须单独收紧并验证。
- 当前真实 Store 聚合数为 20，IndexedDB 版本为 20；项目规则中的 19 个 slice / v17 已发生漂移，实施时必须以源码为准并同步治理文档。
- 当前外部知识库没有根级智能体包 manifest，约 408.11 MiB 的 archive 应默认排除；其部分回归/扫描脚本会写输出，不能被误认成只读 validator 自动执行。
- AI 短剧样板的 `run_main_regression.py`、海外回归、初始化和第三方扫描会写文件；候选只读校验器与写入命令必须在 Manifest 中分栏、分别标注 effect，并按版本与哈希独立授权。
- 仓库同时存在 `doc/` 与 `docs/`；用户明确指定 `docs/`，规划记录迁移到已有 `docs/plans/`。
- 当前工作树在实施前已有 `src-tauri/Cargo.toml`、`src-tauri/gen/schemas/desktop-schema.json`、`src-tauri/gen/schemas/windows-schema.json` 改动和 `.cargo/` 未跟踪项，必须保留且避免覆盖。
- `src/services/fs/skillFiles.ts` 已有 Tauri 对话框选择单文件/文件夹、递归收集、相对路径校验和应用数据目录落盘模式，可复用交互结构但不能沿用其仅支持文本和整包复制的限制。
- `src/services/projectTransferService.ts` 与 `src-tauri/src/project_archive.rs` 已有归档选择、Tauri 命令、安全相对路径和失败清理先例；当前项目归档协议是 tar.gz，不等同于用户要求的通用 zip 智能体包。
- Rust `project_archive` 与 `director_desk_runtime` 均已有拒绝归档路径逃逸的规范化函数，Agent 包解压应提取共享安全语义或独立实现同等严格测试，不能直接使用不受控解压。
- `src-tauri/Cargo.toml` 当前已有 `flate2`、`tar`、`sha2` 和 `serde_json`，没有直接 `zip` 依赖；因此可不新增依赖地支持 `.aicanvas-agent`/`.tar.gz`，若首批必须兼容普通 `.zip`，需另行获得新增 crate 授权或找到仓库已有可复用实现。
- `path_policy.rs` 已把文件对话框选择结果登记进 fs scope，自定义命令仍必须执行可信窗口检查、真实路径解析、应用数据/授权根 containment 和 secrets 拒绝；Agent 导入命令可复用这套边界。
- `project_archive.rs` 已有条目数、展开体积、文本体积、链接/设备文件和 `..`/绝对路径拒绝测试，可作为智能体归档限制的最低基线。
- `package-lock.json` 当前含有传递依赖 `fflate@0.8.2`，但 `package.json` 未直接声明；不能把偶然 hoist 当正式 ZIP 合同。普通 ZIP 若走前端解压仍需直接依赖授权，首批可优先用现有 Rust tar.gz 能力承载 `.aicanvas-agent` 压缩包。
- `ChatInput.tsx` 已在助手输入区提供 Skill 引用菜单和“上传 Skill”按钮，并通过 `allowSkillUpload` 禁止独立窗口直接写主 Store；智能体入口可以在同一区域新增独立 Agent 菜单，而不把智能体伪装成 Skill。
- `ChatPanel.tsx` 是主窗口/独立窗口共用容器，独立窗口仍由主窗口单写入；Agent 上传只能在主窗口执行，独立窗口应显示全局安装摘要并把启停/选择动作回传主窗口。
- `store.projects.ts:initFromDb()` 当前用 `Promise.all` 等待全部全局目录后再加载项目；Agent Catalog 不能加入这个数组，否则其失败会让整个项目初始化进入 error。应在 `App.tsx` 以独立 effect 非阻塞加载并自行捕获错误。
- `ChatInput` 现有 Skill 上传处理固定调用 `uploadSkill('file')`，虽然 Store 已支持 folder；新的智能体菜单应明确给出“选择文件夹”和“选择压缩包”两个动作，避免隐含模式。
- Agent Catalog 独立 DB 需要自己的 open/reset/error 状态，不应复用核心 `schema.ts` 或 `catalogRepository.ts`，但 Store slice 的排序、保存后更新和 toast 语义可参考 `store.plugins.ts`。
- `ChatInput` 在空会话状态不渲染，所以上传入口不能只藏在输入区；首要入口应是 `ChatHeader` 打开的 `AgentCenterPanel`，空会话与普通会话都可访问。
- 内部助手当前名称和空态示例强绑定画布；首批可安全优化为“AI 助手 / 默认助手”，通用任务常驻、画布示例按项目上下文展示，AgentModeSelector 继续只表达 Plan/B/C 权限，不能兼任智能体选择。
- 独立窗口仍是主窗口单写入镜像；首批可以只同步精简安装摘要并隐藏上传写操作，后续若允许独立窗口上传必须新增 Action 回传主窗口，不能直接持久化。
- `ChatHeader` 当前已经显示“AI 助手”，真正漂移的是 Sidebar 的“画布助手”、`EmptyChatState` 的“画布 AI 助手”和画布专用示例；优化应小步修正文案和空态，不重复改已正确的 Header。
- Agent Center 首批应覆盖对话内容区并与 `SubAgentPanel` 同构，提供文件夹/压缩包导入、全局列表、启停、健康、版本和移除；输入框保留任务引用职责，避免安装管理与单轮提示混杂。
- `resolveAssistantModel(projectId?)` 和 `streamAssistantReply({ projectId })` 已具备项目参数，但 `conversationExecutionController` / `assistantService` 多处仍无参调用；后台任务在切换项目后可能使用当前项目模型和画布。内部助手优化应把 task projectId 显式透传，并让提示词在未加载该项目画布时省略画布摘要。
- `buildAssistantSystemPrompt()` 当前总是读取当前 Store 的 nodes/edges/currentProjectId；要支持全局智能体和后台任务，首批 Catalog UI 之后必须把画布上下文装配改成显式 options，同时保证无参数调用输出不变。
- `getAgentModeToast()` 对 C 自主模式的文案仍声称付费媒体和文件写入需要确认，与固定 Policy/AGENTS 规则不一致；属于助手文案漂移，应在不改变 Policy 的前提下修正文案及三语翻译。
- 本轮初次检查时工作区 `node_modules` 暂时缺少 Vitest，`npx` 自动联网被沙箱拒绝，离线安装也因缓存不完整失败；后续工作区本地 `.bin` 恢复可用，在不修改 `package.json`/lockfile 的前提下完成 TypeScript、Vitest 和 ESLint 验证。
- Agent Package 首批已落地为独立 Catalog：安装记录和 Rust 私有来源注册表都不持久化 `instructionText`，Renderer 目录也不保存绝对路径；入口正文只在当前原生预检结果中短暂存在，后续通过 `sourceId + 包内相对路径` 按需读取。
- 旧式目录 `manifest:null` 会生成 `legacy.<contentHash 前16位>` 宿主清单，`autoInvoke:false`、`degraded`、默认停用；这使用户选择的未改造知识库目录可以上传，但不会自动执行或自动路由。
- 原生压缩包实现采用 tar.gz 内核，拒绝路径逃逸、反斜杠、链接/设备、重复条目、过量文件和超限体积；staging 验证成功后才原子迁入托管目录。
- 助手中心已成为主窗口内的安装管理入口；独立窗口不直接写 Catalog。没有外部智能体时仅显示默认助手，Catalog 加载失败退化为空目录。
- 当前首批尚未把启用智能体绑定到 AgentTask；启用只表示候选可用状态，不等同于已经在聊天、画布、后台或 MCP 中按需运行。
- Fork 在本轮实施期间新增 `dc85e67`；远端变更仅涉及厂商配置草稿服务/工具/测试，与 Agent Package 切片无重叠，已快进并完成合并后回归。

## Technical Decisions

| Decision | Rationale |
|----------|-----------|
| 新增全局 Agent Package/Agent Profile 层 | 单 Skill、插件和子智能体都不足以表达复合智能体 |
| 包描述能力，运行实例绑定上下文 | 同一全局智能体可服务不同项目、会话和无项目聊天，且任务状态互不污染 |
| 内容按需索引和读取，不整包注入提示词 | 控制上下文成本，保留渐进披露与安全边界 |
| 外部目录默认只读链接，代码工具默认禁用 | 避免复制数百 MiB 资源和自动执行不可信脚本 |
| MCP 复用 Tool Registry，不做独立权限分支 | 保持应用内与外部控制一致的工具、Policy 和审计语义 |
| 分离全局安装与 ExecutionScope | 智能体定义全局共享，但每次运行必须明确 global/project/series/conversation 等数据边界 |
| 使用“全局默认 + 项目覆盖 + 会话临时选择”解析顺序 | 与现有模型选择语义一致，避免为每个项目复制智能体定义 |
| 增加 Context Capability Negotiation | 全局任务不应自动注入画布节点和画布工具；根据 global/project/canvas/assets 等需要装配上下文 |
| 两级渐进披露：Agent Catalog → Agent 激活 → Skill/资源按需加载 | 避免全局安装多个复合智能体后系统提示词和工具目录膨胀 |
| 智能体绑定进入任务不可变快照 | 复用现有 AgentSkillBinding 的恢复一致性原则 |
| 模型解析优先级为用户显式 > 会话临时 > 项目绑定 > 智能体能力策略 > 应用默认 | 既尊重用户与项目，又让智能体按能力推荐模型且不篡改全局配置 |
| 智能体包只声明模型能力和角色，不声明 API Key 或本机 provider 连接 | 凭据继续由全局 Provider/secret_store 管理 |
| 记忆分 agent/project/conversation/task 四层 | 全局智能体经验、项目事实、会话摘要和任务暂态不能混存 |
| 上传来源支持“外部目录只读链接”和“托管包导入”，均须用户主动发起 | 兼顾数百 MiB 本地知识库和可分发小型智能体包，且不内置业务内容 |
| 项目绑定只保存 installationId 与覆盖配置 | 项目引用全局安装，不复制 Manifest、Skill、知识正文或资产 |
| 在现有消息执行控制器前增加可选 AgentInvocationGateway | 有可用智能体时解析并冻结绑定；无智能体或全局关闭时直接调用现有链路，不改变原生行为 |
| 包目录 hydration、索引和健康检查不得成为 App/Project readiness 前置条件 | 智能体层故障只进入 degraded 状态，不能拖垮配置恢复和项目启动 |
| 全局路由结果为空等价于“未启用智能体” | 不注入空包 Prompt、不注册包工具、不改变模型选择、不创建额外任务类型 |
| 包专属任务遇到来源缺失或 hash 漂移时暂停并明确报错 | 普通功能 fail-open；依赖该包语义的任务必须 fail-closed，避免静默产生错误结果 |
| 不把智能体包等同于 Plugin | Plugin 主要是节点工具运行时，且 Python 没有 OS 沙箱；包内脚本默认禁用并独立授权 |
| 新增显式 origin 与数据/表面双维作用域 | 替代会话 ID 前缀和伪全局项目，支持 global/project/series 与 chat/canvas/background/MCP 组合 |
| 首版把 Definition、Installation、Binding、Conversation Runtime 放入独立 Agent Catalog DB | 核心 IndexedDB 保持 v20；Agent DB 失败时退化为空目录，不阻断项目和聊天 |
| 现有 AgentTask 只增加可选 AgentSnapshot | 只有实际调用智能体的任务携带版本/哈希/路由快照，历史任务和无智能体任务保持原语义 |
| 标准包使用根级 `ai-canvas-agent.json` | 清单声明入口、路由、Skill 根、知识集、资产、外部绑定、能力请求、验证器/命令和完整性信息 |
| 无根级 Manifest 的旧目录由导入向导生成宿主侧 sidecar | 不写回或改造用户源目录；完成静态审查前标记 `legacy-unverified` 且不参与自动路由 |
| 显式选择的智能体不可用时只阻止该次智能体调用 | 明确告知“未应用该智能体”，由用户选择重连或改用普通助手；不能静默伪装执行成功 |
| 首批安装记录不保存入口正文 | 遵守本地文件正文不进 IndexedDB 的边界；真正执行时再经原生 sourceId API 有界读取并形成任务快照 |
| 首批旧目录默认停用且禁止自动路由 | 用户可以先审核兼容清单和预检提醒，软件不会因发现 AGENTS.md/SKILL.md 就自动信任业务智能体 |

## Issues Encountered

| Issue | Resolution |
|-------|------------|
| 外部知识库使用说明中的 Skill 数量与实际扫描不一致 | 兼容层必须自动发现、校验和报告漂移，不能把人工统计当真源 |
| 全局智能体与项目数据容易混淆 | 架构中分离 Definition、Installation、Binding、Runtime Instance 和 Task Snapshot |
| 用户上传不应等同于自动信任 | 上传只授权读取清单；代码、网络、写入和模型开销分别授权 |
| 可选增强层可能反向污染原生链路 | 建立 feature gate、空目录快速旁路、独立错误边界和 no-agent 回归套件 |
| 全局智能体开放扩大 MCP 暴露面 | 先修复非 loopback 监听和显式 origin，再开放全局包工具 |
| `rg` 在 Windows 上把 `setup*` 当成非法路径 | 改为显式文件路径或 `rg --files` 管道，不重复使用 shell 通配路径参数 |
| 初次前端测试依赖缺失且网络受限 | 停止联网和离线安装重试；本地 `.bin` 恢复后重新执行，最终定向 Vitest 55 项、类型和 ESLint 均通过 |

## No-Agent Compatibility Contract

- 零安装、全部停用或全局功能开关关闭时，调用网关执行常量时间空目录判断并直接进入现有 `submitConversationMessage` 链。
- 空目录不增加系统提示词段、不改变工具列表、不启动扫描器/索引器/解析器、不检查 Python，也不产生额外模型调用。
- Agent Catalog hydration 使用独立错误边界和 `allSettled` 语义，不参与 `configHydrated`、项目 readiness 或默认画布创建。
- 自动路由遇到损坏候选时移除该候选并继续原生助手；显式 `@agent` 失败时停止该次增强调用并清楚提示，不影响随后普通聊天。
- 已开始的智能体任务遇到版本或内容哈希漂移时进入 `needs-attention/paused`，不能偷偷换成普通助手或新版本继续。
- 包级索引、文档解析、外部绑定和验证器分别降级；任何单项失败不得扩大权限或波及非智能体功能。

## Resources

- 项目 Agent 分阶段实施方案
- 项目对话式画布助手功能方案
- Skill 渐进披露、子智能体、插件平台和 MCP 相关实现
- AI 短剧知识库入口、拓扑、总控 Skill 与平台适配说明

## Visual/Browser Findings

- 本轮未使用浏览器或视觉材料。

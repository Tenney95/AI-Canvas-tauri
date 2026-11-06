# Harness 借鉴能力实施方案

日期：2026-11-06。状态：**用户已确认原 172 文件范围、七条仅主窗口原生命令/专用权限，以及第 4.8 节补齐的项目摘要文件；总授权范围 173 文件，已写入，待用户验收**。

本专项承接用户对 DeepSeek Harness 插件与 Agent 能力的调研，以及“都实施一下吧”的目标授权；用户随后选择“按完整方案实施（推荐）”，确认本文件完整范围与权限，授权实施但不运行测试、构建、模型或提交推送。八项能力均纳入阶段，不把研究结论写成已实现或已验证。跨模块实现与验收状态统一在本专项维护，相关模块说明仅同步关键合同与入口。

## 1. 目标与已确认基线

| 能力 | 现有实现 | 本次补齐 |
|---|---|---|
| 运行时自描述 | `plugin-host.json`、`PluginHostInfo`、SDK、MCP 工具发现 | 面向 Agent 的有界只读宿主/插件合同查询 |
| 开发预览与健康 | `plugin-dev`、市场、隔离 UI、原生 registration | 不安装的开发界面预览、实际激活 revision 与故障诊断 |
| 创作能力组合包 | AgentPackage、Skill、插件、团队模板各自独立 | 声明式 CreationProfile、导入差异预览与缺项提示 |
| 插件依赖与清理 | 双摘要、调用租约、事务安装、取消 | 依赖图校验与阻塞原因、依赖变更撤租、统一逆序清理 |
| 可配置多 Agent 任务图 | 四种固定模板、五类角色、产物与分集条件保存 | 可配置 DAG、负责人、依赖交接、事务 CAS 与恢复 |
| 大结果按需读取 | 单工具/任务总量裁剪、上下文压缩、团队产物 | 内容策略分流、有界预览与 opaque resultId、授权回读 |
| 执行持久化与分支 | Team 模型调用已有持久化屏障；普通任务恢复暂停；MCP 回执 | 通用调用前屏障、未知结果状态、完成轮次分支 |
| 外部 Agent 适配 | stdio/HTTP 控制桥与 LoopbackClient；两条外部路线已规划 | Skill + 薄 CLI、受限 Codex App Server 执行器与任务界面 |

源码基线以本轮文件为准：IndexedDB `DB_VERSION` 当前为 **27**，不沿用旧文档中写死的版本。固定团队继续使用现有文本 Provider、`tools: []` 与预算；外部完整 Agent 执行器是独立能力，不混入模型协议。

## 2. 共同边界与完成标准

- 主窗口仍是 Store 与业务写入的唯一来源。助手、独立助手和剧本工作台共用同一团队/任务服务；工作台选集不切换画布集数。
- 新工具全部通过 Registry，声明本地 schema 与准确 effect，沿用 Plan/B/C/MCP 的现有 Policy；不从插件、组合包或外部 Agent 输入改变权限。
- 不引入 Harness、Cordis、PTC 或其他 npm/cargo 依赖，不开放模型生成 JS 的执行通道，不替换现有插件安全模型。
- 插件继续使用原生私有快照、双摘要与版本租约；缺失或失效身份失败关闭。预览不是安装授权，模拟结果不能标记为真实执行成功。
- 网页/文件正文、密钥、令牌、本地绝对路径与运行时句柄不进入普通配置、消息元数据、IndexedDB 或持久化 Agent 摘要。模型只得到受限摘要、来源和不透明引用。
- 不自动下载/安装/启用插件、不自动登录或启动外部 Agent、不自动调用模型。新增界面使用现有 UI Kit、共享 Modal/Select 和三种外语字典。
- 每阶段须接通真实入口、类型、存储、取消与错误状态；仅新增类型或服务文件不算完成。阶段状态区分“已实现，待用户验证”和“已验证”。
- 本次范围不包含测试执行、构建、桌面验收、提交或推送。编写有意义的回归用例不等于运行它们；用户以后要求推送时按 `pre-push` 完整前端 CI 门禁执行。

## 3. 分阶段行为合同

### P1：插件自描述

新增有界只读工具 `plugin_host_inspect`，按类别检索宿主能力、插件合同和受支持的 API/配置 schema。返回宿主版本、API 版本、能力与限制、已安装插件的脱敏摘要和实际可用原因。UI Kit token/组件仅作为源码开发参考；当前隔离插件合同只有 theme、locale、固定 tool-dialog 与变更事件，不宣称能直接使用宿主组件或新挂载槽位。分页、字段白名单与独立字节预算均由宿主管理，不向模型开放任意对象路径、源码、运行时 service 或凭据读取。SDK 文档与运行时共享同一份可公开合同，后续 CLI 通过调用该工具查询，不另改 plugin-dev 的 Node/TS 加载边界。

### P2：开发预览与健康

在插件设置中选择开发目录，经既有目录授权与清单验证读取 UI 产物，用独立预览文档/bootstrap 载入现有隔离 iframe；采用明确标识的模拟上下文与宿主响应。不安装、不激活、不运行 Python/模型/网络/文件 effect，也不放松生产私有协议 loader。显式“重新载入”衔接既有 CLI watch，不承诺运行时 HMR。退出、重载或换目录撤销全部预览监听与会话资源。

健康显示区分配置启用、实际 active revision、缺少依赖、兼容性拒绝、私有快照缺失/损坏和激活失败。复用原生 `get_plugin_registration_status`，只返回结构化原因与摘要；展示不会自动修复、重装或激活。

### P3：创作能力组合包与插件依赖

CreationProfile 是引用清单，包含插件 ID/revision、AgentPackage ID/contentHash、Skill ID、团队模板/模型绑定与上下文偏好。目录存 AppConfig，会话/分集仅保存 ID + version/hash 的选择，任务启动冻结解析快照；更新/删除组合包不改变运行中任务，保存失败不显示应用成功。导出不携带插件源码、Key 或本机路径。导入先校验版本/大小/数量，展示变更与缺项；应用只调用现有 Store Action 更新获准配置，缺少安装/权限/模型不能静默跳过或自动补齐，也不改变 Policy。组合包与可执行 AgentPackage 分开。

插件 API2 的依赖关系仅是声明式执行前置条件，不是跨插件 RPC。声明必需/可选依赖及最低版本，并要求 `plugin.dependencies` 宿主能力；原生 registry 重算图，必需依赖缺失/版本不足或循环阻止激活/执行，可选依赖缺失只作诊断。enabled 保留用户意图，实际可用状态单独派生。依赖换版、停用或卸载撤销受影响调用/窗口/资源授权，依赖恢复不自动复活旧调用。每次调用绑定依赖 revision 指纹，迟到结果不能回写。统一清理作用域只处理宿主管理的资源，逆序、幂等且等待异步清理，不声称可以回滚外部副作用。

### P4：可配置团队 DAG

保留旧 v1 记录与四个模板校验，新配置使用 v2 图合同并仍由 `teamRuntime` 调度。首期允许同一角色多个任务，指定现有五类角色、冻结的模型负责人、依赖与产物交接；任务状态可视化，运行中能暂停/取消。文本 API 参与者继续 `tools: []`，P7 外部执行目标另受其固定合同约束。模型不自行改任务图，不增加任意宿主工具或任意 Agent 通信。

图结构只在暂停且无活动调用时编辑；递增 run revision 并使受影响节点及下游失效。board revision 负责界面 CAS 与事件排序；每个节点以 task revision + attemptId + run revision 保护 claim/完成，避免并行节点互相误判过期。CAS 在 IndexedDB 同一 readwrite 事务完成，普通任务快照保存也须保留最新图，不能绕过 CAS。依赖产物带不可变引用/哈希，沿用分集目标 hash 和项目派生守卫。

### P5：大结果与上下文

每种结果声明存储策略。允许持久化的项目派生产物写入既有不可变 projectFiles，校验哈希后返回摘要与 opaque resultId；网页、本地文件正文及外部 MCP 敏感结果默认只进入有界内存，持久化脱敏来源描述，按原授权回读。应用重启后失效的内存引用明确过期，不能伪造恢复。

按结果 ID 分段读取，绑定项目/会话/任务和原始授权，限制单段/累计大小，撤权即失效。存储失败给出受限摘要与失败原因，不回退巨大 inline 正文。压缩继续复用现有预算与近期完整轮次保留；任务负责人只接收依赖所需的产物材料，防止所有模型共享全部长历史。

### P6：持久化屏障、未知结果与分支

通用模型/工具调用在 dispatch 前 await 持久化意图与调用身份；保存失败立即暂停，不启动下游。记录 prepared/dispatched/settled，Team 复用已有屏障并增加精确状态。重启后 dispatched 未 settled 标为 outcome_unknown，不能改为普通 pending 后自动重投；MCP 原 operationKey/receipt 继续是其执行权威。付费生成、画布/文件写入和外部写入不自动重试，也不把屏障等同外部 exactly-once。

提供“从这里分支继续”：仅选择同项目已完成 assistant 轮次，在当前 IndexedDB 事务原子创建新对话并复制边界内的脱敏内容/结果摘要，新消息 ID、无旧任务/审批/命令/文件 grant/媒体重试句柄。不重放历史 effect，不复用越过分支点的压缩摘要，外部材料重新授权。原对话和原任务不变；不实现完整事件溯源或任意时间点机器状态还原。

### P7：Skill/CLI 与外部 Codex

CLI 复用既有 LoopbackClient、工具发现/调用、operation receipt 和取消协议，Skill 解释发现 schema、读取快照、带项目/revision 调用以及超时后查回执的流程。只通过环境注入本机控制令牌，不写入 Skill、参数、日志或示例。开发资源先随源码交付，不扩张打包资源配置。

Codex 接入采用固定 App Server 协议适配器，统一任务能力、状态、进度、取消、建议成果与用户显式继续；首版仅返回建议，应用成果仍由主窗口既有 Registry/Policy 执行，不授予外部进程直接访问画布 Store。缺安装、认证、受支持版本或隔离前提时明确不可用，不能静默改用无限制进程。精确原生边界与文件清单见后续范围表。

## 4. 完整文件范围

### 4.1 现有业务文件（68 个）

各阶段的修改职责见第 3 节。共享文件合并修改一次，不为各入口建立平行状态或执行器。以下路径均已核实存在。

| 阶段 | 文件 |
|---|---|
| P1–P3 | `src/types/plugin.ts` |
| P1/P3 | `plugin-host.json` |
| P3 | `sdk/plugin-sdk.d.ts` |
| P1–P3 | `src/services/plugins/pluginHost.ts` |
| P1–P3 | `src/services/plugins/pluginManifest.ts` |
| P1–P3 | `src/services/plugins/pluginRuntime.ts` |
| P1–P3 | `src/services/plugins/pluginUiSessionService.ts` |
| P1–P3 | `src/services/plugins/pluginUiWindowService.ts` |
| P1–P3 | `src/services/plugins/pluginResourceService.ts` |
| P1–P3 | `src/services/plugins/pluginVideoReplicaJobService.ts` |
| P2 | `src/services/fs/pluginPackageFiles.ts` |
| P3 | `src/store/store.plugins.ts` |
| P1–P3 | `src/components/settings/PluginSettings.tsx` |
| P2 | `src/components/nodes/shared/toolbar/NodePluginToolDialog.tsx` |
| P1/P3 | `src-tauri/src/plugins/registry.rs` |
| P1/P5 | `src/services/chat/tools/index.ts` |
| P1 | `src/services/chat/assistantScope.ts` |
| P1 | `src/services/mcp/mcpToolCatalog.ts` |
| P3 | `src/types/index.ts` |
| P3/P5/P6 | `src/types/chat.ts` |
| P3/P5/P6 | `src/types/agent.ts` |
| P3/P4 | `src/types/scriptWorkbench.ts` |
| P4/P7 | `src/types/agentTeam.ts` |
| P3–P7 | `src/store/store.config.ts` |
| P3–P7 | `src/store/store.chat.ts` |
| P3–P7 | `src/store/store.projects.ts` |
| P3–P7 | `src/store/store.agent.ts` |
| P3–P7 | `src/store/store.ui.ts` |
| P3 | `src/services/configPatch.ts` |
| P3/P4/P6 | `src/services/indexedDbService.ts` |
| P3–P7 | `src/services/chat/chatHistoryService.ts` |
| P3–P7 | `src/services/chat/chatWindowService.ts` |
| P3–P7 | `src/services/chat/detachedChatSyncController.ts` |
| P3–P7 | `src/services/chat/conversationExecutionController.ts` |
| P3–P7 | `src/services/chat/agentTaskService.ts` |
| P3–P7 | `src/services/chat/toolRegistry.ts` |
| P3–P7 | `src/services/chat/agentRoundExecutor.ts` |
| P3–P7 | `src/services/chat/fileGrantService.ts` |
| P3–P7 | `src/services/chat/contextTranscript.ts` |
| P3–P7 | `src/services/chat/contextCompressionService.ts` |
| P3–P7 | `src/services/chat/agentRuntime.ts` |
| P3–P7 | `src/services/chat/agentToolExecution.ts` |
| P3–P7 | `src/services/chat/agentTaskControl.ts` |
| P3–P7 | `src/services/chat/agentCheckpointService.ts` |
| P4/P6/P7 | `src/services/chat/teams/teamProfileService.ts` |
| P4/P6/P7 | `src/services/chat/teams/teamValidation.ts` |
| P4/P6/P7 | `src/services/chat/teams/teamRuntime.ts` |
| P4/P6/P7 | `src/services/chat/teams/teamInvocationService.ts` |
| P4/P6/P7 | `src/services/chat/teams/teamResultApplyService.ts` |
| P4/P6/P7 | `src/services/chat/teams/teamModelExecutor.ts` |
| P3 | `src/services/scriptWorkbenchWindowService.ts` |
| P5 | `src/services/chat/tools/fileTools.ts` |
| P5 | `src/services/chat/tools/webTools.ts` |
| P5 | `src/services/chat/tools/canvasTools.ts` |
| P5 | `src/services/chat/tools/seriesTools.ts` |
| P3–P7 | `src/components/chat/ChatPanel.tsx` |
| P3–P7 | `src/components/chat/AgentCenterPanel.tsx` |
| P3–P7 | `src/components/chat/AgentTaskTimeline.tsx` |
| P3–P7 | `src/components/chat/MessageBubble.tsx` |
| P3–P7 | `src/components/chat/ChatMessages.tsx` |
| P3/P4 | `src/components/ScriptWorkbench.tsx` |
| P4/P6/P7 | `src/components/shared/agentTeams/TeamExecutionPicker.tsx` |
| P4/P6/P7 | `src/components/shared/agentTeams/TeamRunCard.tsx` |
| P4/P6/P7 | `src/components/shared/agentTeams/TeamResultReview.tsx` |
| P7 | `src/components/SettingsPanel.tsx` |
| P7 | `src/components/settings/SettingsNavigation.tsx` |
| P7 | `src-tauri/src/lib.rs` |
| P7 | `src-tauri/src/agent/package.rs` |

### 4.2 拟新增业务文件（35 个）

方案冻结时已确认以下同名路径不存在；此表记录批准的拟新增范围，实际实施与验收状态见第 6 节。外部执行器的两项 ACL 文件单独说明于第 4.6 节。

| 阶段 | 拟新增文件 |
|---|---|
| P1 | `src/services/plugins/pluginContractCatalog.ts` |
| P1 | `src/services/plugins/pluginHealthService.ts` |
| P1 | `src/services/chat/tools/pluginInspectionTools.ts` |
| P1 | `src/components/settings/plugins/PluginDiagnosticsPanel.tsx` |
| P2 | `src/services/plugins/pluginUiFrameDocument.ts` |
| P2 | `src/services/plugins/pluginPreviewService.ts` |
| P2 | `src/components/settings/plugins/PluginPreviewDialog.tsx` |
| P2 | `plugin-preview-host.html` |
| P2 | `public/plugin-preview-bootstrap.js` |
| P3 | `src/services/plugins/pluginDependencyService.ts` |
| P3 | `src/services/plugins/pluginLifecycleScope.ts` |
| P3 | `src/types/creationProfile.ts` |
| P3 | `src/services/creationProfiles/creationProfileManifest.ts` |
| P3 | `src/services/creationProfiles/creationProfileService.ts` |
| P3 | `src/components/shared/creationProfiles/CreationProfilePicker.tsx` |
| P3 | `src/components/shared/creationProfiles/CreationProfileManager.tsx` |
| P4 | `src/services/chat/teams/teamGraphService.ts` |
| P5 | `src/types/agentResult.ts` |
| P5 | `src/services/chat/agentResultService.ts` |
| P5 | `src/services/chat/tools/resultTools.ts` |
| P6 | `src/services/chat/agentDurabilityService.ts` |
| P6 | `src/services/chat/conversationBranchService.ts` |
| P7 | `.agents/skills/ai-canvas/SKILL.md` |
| P7 | `scripts/ai-canvas-cli.mjs` |
| P7 | `src/types/externalAgent.ts` |
| P7 | `src/services/chat/externalAgents/externalAgentRegistry.ts` |
| P7 | `src/services/chat/externalAgents/externalAgentService.ts` |
| P7 | `src/services/chat/externalAgents/codexAppServerAdapter.ts` |
| P7 | `src/components/settings/ExternalAgentSettings.tsx` |
| P7 | `src-tauri/src/agent/codex_runtime.rs` |
| P7 | `src-tauri/src/agent/codex_protocol.rs` |
| P7 | `src-tauri/src/agent/codex_process.rs` |
| P7 | `src-tauri/src/agent/codex_contract.rs` |
| P7 | `src-tauri/permissions/external-agent.toml` |
| P7 | `src-tauri/capabilities/external-agent.json` |

### 4.3 回归文件（50 个，仅编写，不自动执行）

修改以下 27 个现有用例文件。涉及 Hook、Store 或窗口协议时，同步核对现有 mock；不靠删除断言或关闭检查掩盖问题。

```text
tests/services/pluginManifest.test.ts
tests/components/nodePluginToolDialog.test.tsx
tests/store/plugins.test.ts
tests/services/pluginRuntime.test.ts
tests/services/pluginUiSessionService.test.ts
tests/services/pluginUiWindowService.test.ts
tests/services/pluginResourceService.test.ts
tests/store/config.test.ts
tests/services/configPatch.test.ts
tests/services/chat/conversationExecutionController.test.ts
tests/services/chat/detachedChatSyncController.test.ts
tests/services/scriptWorkbenchWindowService.test.ts
tests/components/scriptWorkbench.test.tsx
tests/services/chat/teamValidation.test.ts
tests/services/chat/teamInvocationService.test.ts
tests/components/agentTeamControls.test.tsx
tests/services/chat/agentTaskService.test.ts
tests/services/chat/agentTaskPersistenceQueue.test.ts
tests/services/chat/agentRoundExecutor.test.ts
tests/services/chat/contextCompression.test.ts
tests/services/chat/agentCheckpointService.test.ts
tests/services/indexedDbService.test.ts
tests/components/messageBubble.test.tsx
tests/components/chatMessages.test.ts
tests/services/chat/chatWindowListener.test.ts
tests/services/chat/chatWindowLifecycle.test.ts
tests/scripts/nativeAppCommandAcl.test.ts
```

拟新增以下 23 个有意义的行为/安全合同用例。Rust 的协议、配置与进程边界用例放在对应新增 `.rs` 文件的内联测试中；不添加重复模拟实现的测试。

```text
tests/services/pluginContractCatalog.test.ts
tests/services/pluginHealthService.test.ts
tests/services/chat/pluginInspectionTools.test.ts
tests/components/pluginDiagnosticsPanel.test.tsx
tests/services/pluginPreviewService.test.ts
tests/services/pluginUiFrameDocument.test.ts
tests/services/pluginPreviewBootstrap.test.ts
tests/components/pluginPreviewDialog.test.tsx
tests/services/pluginDependencyService.test.ts
tests/services/pluginLifecycleScope.test.ts
tests/services/creationProfileManifest.test.ts
tests/services/creationProfileService.test.ts
tests/components/creationProfileControls.test.tsx
tests/services/chat/teamGraphService.test.ts
tests/services/chat/teamTaskBoardPersistence.test.ts
tests/services/chat/agentResultService.test.ts
tests/services/chat/resultTools.test.ts
tests/services/chat/agentDurabilityService.test.ts
tests/services/chat/conversationBranchService.test.ts
tests/scripts/aiCanvasCli.test.mjs
tests/services/chat/externalAgentRegistry.test.ts
tests/services/chat/codexAppServerAdapter.test.ts
tests/components/externalAgentSettings.test.tsx
```

### 4.4 多语言文件（9 个，均为修改）

```text
src/i18n/locales/en-US/chat.ts
src/i18n/locales/en-US/settings.ts
src/i18n/locales/en-US/series.ts
src/i18n/locales/ja-JP/chat.ts
src/i18n/locales/ja-JP/settings.ts
src/i18n/locales/ja-JP/series.ts
src/i18n/locales/ko-KR/chat.ts
src/i18n/locales/ko-KR/settings.ts
src/i18n/locales/ko-KR/series.ts
```

新增中文 key 同步英、日、韩；删除或更名 key 时搜索全部源码引用。

### 4.5 文档（10 个）

拟新增：

- `doc/plans/2026-11-06-harness-capabilities.md`（本文件）。

修改：

- `doc/plans/计划索引.md`
- `doc/plans/2026-11-06-multi-model-agent-teams.md`
- `doc/plans/2026-11-06-external-agent-collaboration.md`
- `doc/插件平台模块.md`
- `doc/插件开发规范.md`
- `doc/对话助手-Agent能力实施方案.md`
- `doc/桌面运行时与安全模块.md`
- `doc/MCP控制模块.md`
- `doc/文件与存储模块.md`

本专项负责八项能力的分阶段记录；既有多模型/外部协作专项仅链接并更新对应真实状态，模块文档只同步重要合同。文档导航已有模块入口，无需再增加同主题文档。README、历史归档、AGENTS、生成产物和缓存均不在范围内。

### 4.6 外部执行器的新增原生权限

以下权限变更已在本次完整范围确认中单独列明并获用户批准。本次不修改 `tauri.conf.json`、默认 capability、文件 scope 或 CSP，也不增加通用 shell 权限。

| 拟新增命令 | 固定输入与边界 |
|---|---|
| `codex_runtime_status` | 脱敏状态与能力，不启动进程，不返回本机路径/密钥 |
| `codex_runtime_register` | 不接收路径；由原生文件选择器与确认登记受支持原生可执行文件及摘要 |
| `codex_runtime_configure` | 仅接受 enabled，默认关闭；禁用时取消所属运行 |
| `codex_runtime_remove` | 先取消所属进程，再清理登记；不删除用户安装的 Codex |
| `codex_runtime_start` | 任务/节点/修订身份、模型名、有界材料、输出合同与 Channel；拒绝 executable/argv/cwd/env 字段 |
| `codex_runtime_cancel` | 仅该登记运行的有界 invocationId |
| `codex_runtime_collect` | 按 invocationId 取有界结果，不重新执行 |

`src-tauri/permissions/external-agent.toml` 显式声明这七个命令的 allow/deny；`src-tauri/capabilities/external-agent.json` 仅授予本地真实 `main` 窗口，无 remote/wildcard。命令内部还须调用受信调用方校验并限制 `main`；独立助手/工作台只经主窗口现有协议请求，插件/远程页面不能直接 invoke。不把命令加入宽泛 first-party allow 列表。

登记、临时工作区与独立 Codex 配置放入已经受保护的 `agent-private/external-codex` 子树，复用现有文件/asset/path_policy 三路保护与祖先保护。原生指定 cwd、CODEX_HOME、CODEX_SQLITE_HOME、HOME/USERPROFILE/TEMP，采用受控最小环境，不继承用户 Codex 配置、auth.json、MCP、插件或 Shell 脚本；不复制项目源码与素材目录。

Key 使用既有 writeAppSecret 写入 Rust secret_store 的固定 `external-agent/codex` 条目，保存后清空界面输入，状态只返回 configured 布尔；原生以既有内部读取方法获取后，仅注入所属子进程的固定 env_key，不回传 Renderer，不调用会另外落盘 Key 的 account/login/start。首版固定 OpenAI Responses provider，不承诺复用 ChatGPT 订阅；通用文本 Provider 路线仍支持现有多厂商。不新增 secret 命令或普通配置 Key 字段。

**固定实现基线**：仅支持官方稳定 tag `rust-v0.167.0`，提交 `086ccc833bc9cf01024ad2dd6af7dbd421b6bf9a` 的协议与配置合同。未来版本必须另做兼容核对，不能仅凭版本更高放行。登记时由原生在用户信任确认后执行固定版本查询并保存摘要；每次启动复核真实路径、非链接与摘要，不执行 Renderer 提交的参数。

登记文件在原生锁内打开并核对身份后，按句柄流式复制到本次私有工作区，检查取消/体积、同步后回读 SHA-256 必须匹配登记摘要；登记版本查询也使用私有快照。Windows 快照持有拒绝写/删除共享的句柄，Unix 使用私有目录和只读执行权限。固定进程为 `[verifiedPrivateSnapshot, "app-server"]`，默认 stdio，防止原安装路径在准备期间更新而执行未核对字节；不声称对任意同用户恶意进程构成沙箱。

使用该提交 `codex-rs/app-server-protocol/schema/{json,typescript}/v2/` 的真实合同，不混用滚动官网 schema。初始化不开 experimental API；白名单流程为 initialize → initialized → config/read（includeLayers + 私有 cwd）→ configRequirements/read → thread/start → turn/start。首版仅接受 requirements 为 null，有企业/机器约束则明确拒绝，不替用户覆盖组织配置。使用有界 JSON 行 framing、字节/并发/时限预算，匹配 invocation/thread/turn 身份；只有权威 turn/completed 才认定完成。取消发 turn/interrupt，超时或协议失配终止所属进程树；发送、启动进程和消费缓冲事件前均复核取消/时限，但不声称撤回已提交 turn。未知 server request 拒绝并停止相关调用，不能批准 shell/补丁/文件请求。

宿主在**启动前**写入私有固定配置及静态 `model_catalog_json`（线程级覆盖无效，不能用它代替启动配置）。静态 ModelInfo 设 `shell_type=disabled`、`apply_patch_tool_type=null`、`tool_mode=direct`、`experimental_supported_tools=[]`、`node_repl_disabled=true`，不采用远程刷新后带入的新工具。特性同时关闭 shell_tool、apps、hooks、plugins/remote_plugin、multi_agent、memories/goals、view_image、web search 与自动 Skill 依赖；空 MCP/Skill 目录，使用固定 Provider、独立 HOME 和工作目录。保留 readOnly sandbox、networkAccess=false、approvalPolicy=never，不宣称该版支持任意受限 read roots。

`config/read` 是配置层合成结果，不是最终工具清单证明；检查 config/origins/layers 只有本次宿主配置及预期会话覆盖，拒绝带实际额外配置的 system/project/enterprise/MDM 或未知来源。thread/start 使用同一 cwd、精确模型/provider、readOnly、never 与 ephemeral，重新核对响应，instructionSources 应为空。核对完成前不发送任务材料或启动模型。源码中的 shell 总开关会先于 unified_exec 分支生效；apply_patch 的目录字段设为 null，且只读 + never 还会拒绝补丁作为额外防线。不得使用未公开的 ExtensionDataInit ToolPolicy 伪造 App Server 参数，也不承诺工具清单为空。

原生登记与摘要只绑定**用户信任的本机进程**，不构成 OS 沙箱，也不能保证恶意可执行文件遵守配置。原生确认必须说明任务材料会发往模型服务、调用可能计费、本机程序拥有当前用户进程权限；不自动下载/替换程序或复用登录账户。

首版角色能力明确为 one-shot、cancel、progress、text/structured-result，以及已知/未知用量；resume/fork/inheritsParentContext/hostTools 均为 false。追加要求通过团队修订产生新受限调用，不宣传为继续桌面 Codex 会话。它返回候选成果，成果应用仍经宿主 Policy、目标稿件 hash 与项目/revision 守卫。

固定配置与 ModelInfo 模板放在拟新增 `src-tauri/src/agent/codex_contract.rs`，不接收 Renderer 提交的模型元数据，不额外增加 Tauri 打包资源。ModelInfo 除上述字段还固定文本 input_modalities、关闭 supports_search_tool / supports_experimental_context 及 Skill/app/plugin instructions；其余必需字段按固定版完整模板生成。只接受本次私有目录中的精确 slug，不能 fallback 到默认目录；multi_agent_version 不能靠该 JSON 设置，必须由配置特性关闭。

以下为宿主生成的配置合同（路径由原生替换，不允许前端传入）：

```toml
model_provider = "ai_canvas_openai"
model_catalog_json = "<native-private-models.json>"
sandbox_mode = "read-only"
approval_policy = "never"
allow_login_shell = false
web_search = "disabled"
notify = []
project_root_markers = []
project_doc_max_bytes = 0

[mcp_servers]

[history]
persistence = "none"

[skills]
include_instructions = false
config = []

[skills.bundled]
enabled = false

[features]
shell_tool = false
shell_snapshot = false
apps = false
plugins = false
remote_plugin = false
hooks = false
multi_agent = false
multi_agent_v2 = false
memories = false
goals = false
view_image = false
image_generation = false
browser_use = false
computer_use = false
in_app_browser = false
code_mode = false
code_mode_only = false
code_mode_host = false
workspace_dependencies = false
deferred_executor = false
request_permissions_tool = false
skill_mcp_dependency_install = false
skill_env_var_dependency_prompt = false
skill_search = false
skip_host_skill_discovery = true
standalone_web_search = false
api_key_model_discovery = false

[model_providers.ai_canvas_openai]
name = "AI Canvas OpenAI"
base_url = "https://api.openai.com/v1"
wire_api = "responses"
env_key = "AI_CANVAS_CODEX_API_KEY"
```

`skip_host_skill_discovery` 是固定版开发中特性，不能泛称跨版本稳定接口。Provider 网络仅用于这一路模型请求；readOnly 中 networkAccess=false 指模型工具 sandbox，不能误写成进程没有网络。一次外部 turn 也不等于硬性金额上限，用量未知不记为零。依据：[配置 schema](https://github.com/openai/codex/blob/086ccc833bc9cf01024ad2dd6af7dbd421b6bf9a/codex-rs/core/config.schema.json)、[ModelInfo](https://github.com/openai/codex/blob/086ccc833bc9cf01024ad2dd6af7dbd421b6bf9a/codex-rs/protocol/src/openai_models.rs)、[静态目录选择](https://github.com/openai/codex/blob/086ccc833bc9cf01024ad2dd6af7dbd421b6bf9a/codex-rs/model-provider/src/provider.rs)、[工具注册](https://github.com/openai/codex/blob/086ccc833bc9cf01024ad2dd6af7dbd421b6bf9a/codex-rs/core/src/tools/spec_plan.rs)、[补丁拒绝](https://github.com/openai/codex/blob/086ccc833bc9cf01024ad2dd6af7dbd421b6bf9a/codex-rs/core/src/safety.rs)。

### 4.7 规模与不在范围内的变更

原完整清单共 **172 个唯一文件：103 个业务文件、50 个测试文件、9 个多语言文件、10 个文档**，已经用户确认；随后另批准第 4.8 节一个摘要转换文件，总授权范围 173。允许在清单内合并/减少实际改动；不为凑清单机械修改可复用文件或重复测试，实际文件以最终差异为准。未列文件不得悄悄扩大范围。

不新增 npm/cargo 依赖，不删除现有文件，不新增 object store/index、不提升 DB_VERSION，不改 Policy 权限矩阵。不安装 DeepSeek Harness、不启动本机 Codex 或运行模型，不修改个人 Hindsight 为产品功能。

### 4.8 静态审阅发现的持久化范围补齐（已确认并实施）

需要额外修改一个已存在文件 `src/services/indexedDb/projectSummary.ts`：其显式白名单是项目保存、列表载入和数据库升级的共用入口，目前会丢弃新增的 creationProfile / teamProfileOverride。拟在摘要类型和转换函数中保留经过白名单规范化的组合包 ID/版本/摘要及角色模型引用，不保存源码、路径、Key 或运行时对象。旧项目缺字段仍兼容，不新建表、不提高 DB_VERSION、不改变权限。

用户已选择“补齐该持久化文件（推荐）”。回归补到原已批准的 `tests/services/indexedDbService.test.ts`，覆盖保存/列表回读、字段清除、旧记录与非法字段；源码与用例已写入，未执行。本项确认后总授权范围为 173 文件；无新增依赖或权限。

对应字段还同步调整了既有 `tests/store/projects.test.ts`，断言分集换包清除旧角色覆盖、且不切换当前画布。此项仅补充关联测试清单，不增加业务源文件、权限或测试执行授权；连同该现有回归，最终清单上限为 174 文件。没有为凑清单修改所有预估文件。

## 5. 验收、恢复与回退

### 5.1 实施顺序与阶段交付

建议顺序为 **P1 → P2 → P3 的插件依赖基础 → P6 的持久化基础 → P5 → P4 → P3 的组合包闭环 → P6 的分支界面 → P7**。编号按用户能力阅读，顺序按真实依赖执行。各阶段完成静态差异与引用核对后继续下一阶段；同一已批准范围不再次按文件数量询问。新增依赖、删除文件或超出第 4.6 节的原生权限仍需单独确认。

所有阶段共用的回归项：旧配置缺字段兼容、运行任务捕获不可变配置、两种主题与窄窗口、独立窗口由主窗口执行、切项目/分集/会话后的迟到结果拒绝、取消与关闭不泄漏资源。手工验收以 Tauri 桌面端为主，Web 展示不能替代原生隔离/持久化验收。

### 5.2 手工验收矩阵（由用户执行）

前置：测试项目、无敏感材料、Tauri 桌面端。需要模型的步骤由用户主动配置并发送；本次助手实施不运行这些操作。

| 阶段与入口 | 正向操作和预期 | 异常/回归 |
|---|---|---|
| P1：助手工具与插件设置诊断 | 查询支持合同；展开某插件后刷新，区分配置启用与真实 revision | 未知 section/分页、缺快照、摘要失配、版本不兼容、Python 不可用；无正文、路径或密钥 |
| P2：插件设置→开发预览 | 选择开发目录，展示带模拟标识的 UI；重载/关闭均释放资源，无新安装记录 | 伪造 source/session、外链/网络/导航/真实 effect、坏摘要、有界请求；生产 loader 仍拒绝任意 URL |
| P3：依赖 | A 依赖 B，刷新看见解析结果；停用/换版 B 时 A 阻塞、活动调用取消 | 环、低版本、并发更新、补偿失败、迟到结果、重复清理；Python 原生确认保持 |
| P3：助手/工作台组合包 | 导入→查看差异/缺项→应用到当前会话或当前工作台分集 | 缺插件/Skill/模型、非法字段/Key/路径、权限扩大、运行时换配置；工作台不切画布分集 |
| P4：原团队配置及看板 | 配置结构→并行审阅→汇合→主编，查看产物谱系与最终候选 | 环、无效负责人、缺产物、双窗 CAS 冲突、并行完成互相误失效、旧 v1 继续/恢复 |
| P5：长结果与回读 | 查看中间/末尾片段；压缩后合法引用仍可用，预览标真实截断状态 | 猜 resultId、跨会话/项目、撤权、TTL/重启过期、文件变化、哈希错误/存储不足；正文不落盘 |
| P6：持久化/恢复 | 模拟 dispatch 后退出，重启显示未知并暂停；已完成结果仍可读 | 保存失败调用次数为零；执行后保存失败不重投；保存等待中撤权/切项目仍复核 |
| P6：已完成消息→从这里分支 | 新对话仅有分支点之前资料，原会话/任务/画布不变 | 事务失败无半个对话；旧审批/grant/命令不复活；媒体不重投；越界摘要不继承 |
| P7：CLI | 发现 schema→绑定项目/revision→调用→回读回执，stdout 为 JSON | 未开服务/错令牌/坏 JSON/超限、revision 冲突、Ctrl+C/断线；不换 operationKey 自动重投 |
| P7：设置→外部执行器、团队角色 | 原生登记后显式启用，角色返回有界候选，真实阶段/用量/取消可见 | 未登记/禁用/文件摘要变化/不兼容配置拒绝；未知协议、坏结构化结果、退出回收、重启暂停；其他窗口直接 invoke 拒绝 |

### 5.3 自动化验证入口（尚未执行）

相关用例已写入，尚未执行。可在仓库根目录执行下列命令；以下是验收计划，不是已运行记录，用户明确授权前助手不执行。

```powershell
npx vitest run tests/services/pluginContractCatalog.test.ts tests/services/pluginHealthService.test.ts tests/services/chat/pluginInspectionTools.test.ts
npx vitest run tests/services/pluginPreviewService.test.ts tests/services/pluginUiFrameDocument.test.ts tests/services/pluginPreviewBootstrap.test.ts
npx vitest run tests/services/pluginDependencyService.test.ts tests/services/pluginLifecycleScope.test.ts tests/services/creationProfileManifest.test.ts tests/services/creationProfileService.test.ts
npx vitest run tests/services/chat/agentDurabilityService.test.ts tests/services/chat/agentResultService.test.ts tests/services/chat/resultTools.test.ts tests/services/chat/conversationBranchService.test.ts
npx vitest run tests/services/chat/teamGraphService.test.ts tests/services/chat/teamTaskBoardPersistence.test.ts tests/components/agentTeamControls.test.tsx
npx vitest run tests/scripts/aiCanvasCli.test.mjs tests/services/chat/externalAgentRegistry.test.ts tests/services/chat/codexAppServerAdapter.test.ts tests/scripts/nativeAppCommandAcl.test.ts
npm run ci
```

Rust 检查在 `src-tauri/` 运行 `cargo check --lib`；需要原生单测时在同目录运行 `cargo test --lib`。这些均需对应授权；推送只自动授权前端 `npm run ci`，不自动授权 Rust 或桌面/真实模型验收。差异、引用与严格 UTF-8 核对可自行执行。

### 5.4 恢复与回退

- P1/P2：关闭新诊断/预览入口即可，未产生安装或原生注册迁移；保留原安装/执行能力。
- P3：清除组合包选择回到原会话/项目配置，不卸载共享插件或删除 Skill。声明新依赖的插件在旧宿主上应因 capability 不匹配拒绝执行，不能忽略依赖降级运行。
- P4：停止 v2 新建/执行，保留产物、图与 v1 路径；旧代码不识别 v2 时拒绝，不能套用旧模板执行。
- P5：停用新 spill 入口仍保持硬预算；已存在的允许派生产物保持可读，不删除用户材料或回退巨大正文。
- P6：分支关闭后已创建会话仍是普通可读会话；持久化失败必须停调度，不能退回无屏障调用。未知状态不能被旧 pending 修复覆盖。
- P7：先禁用并取消所有所属运行，再撤回角色入口与七条 command/对应 ACL；保留脱敏历史候选，不删除用户的 Codex 安装。CLI/Skill 可独立撤回，现有 MCP 不变。
- 不回退用户其他任务的改动，不自动做数据库降级或历史清空；本方案没有新表/索引和依赖升级。

## 6. 实施记录

| 阶段 | 实现 | 自动化验证 | 桌面验收 |
|---|---|---|---|
| P1/P2/P3 插件 | 自描述、按需健康、模拟预览、依赖与撤租已写入，待用户验证 | 未运行 | 未运行 |
| P3 组合包 | 严格导入/预检/缺项、助手/分集选择、准备屏障、分集摘要恢复及跨窗落盘确认已写入，待用户验证 | 未运行 | 未运行 |
| P4/P5/P6 团队与运行时 | v2 DAG/CAS、结果回读、执行屏障/未知回执、资料分支已写入，待用户验证 | 未运行 | 未运行 |
| P7 CLI/Skill | 已写入代码和合同用例，待用户验证 | 未运行 | 未运行 |
| P7 外部 Codex | 固定版协议、私有配置/模型目录、原生登记/ACL、取消/提交事实及团队角色已写入，待用户验证 | 未运行 | 未运行 |

八项能力已接入原模块；新增/调整了有意义的行为与安全回归，未把未执行用例当作通过证据。静态核对包括调用引用、UTF-8 与差异范围；没有运行测试、lint、类型检查、构建或桌面验收，没有调用产品模型或启动本机 Codex。固定版真实兼容、取消/进程树、深浅主题/多窗口及多模型产出质量仍待用户验收。工作区另检测到四个 `src-tauri/gen/schemas/` 文件变化，所有实施代理均未运行生成命令或手工编辑，来源未证实，保留未回滚，提交范围排除这些生成文件。Skill 源文件受既有 `.agents/*` 忽略规则影响，按授权单独纳入源码提交。

## 7. 资料

- [DeepSeek Harness 架构](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/docs/architecture.zh.md)、[只读工具自描述](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/extensions/tool-cordis/README.zh.md)、[插件管理器](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/boot/plugin-manager/README.zh.md)。借鉴机制，不运行其安装命令或把外部文档当项目权限。
- [团队任务板](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/docs/subsystems/agent-team.zh.md)、[结果 spill](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/spill/spill-policy/README.zh.md)、[执行前 checkpoint](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/session/session-checkpoint-policy/README.zh.md)。按本项目存储/Policy 边界调整，不复制原始正文兜底或任意 JS 执行。
- 本地相关专项：[多模型团队](./2026-11-06-multi-model-agent-teams.md)、[外部 Agent 两条路线](./2026-11-06-external-agent-collaboration.md)、[插件平台](../插件平台模块.md)、[文件与存储](../文件与存储模块.md)、[桌面安全](../桌面运行时与安全模块.md)。

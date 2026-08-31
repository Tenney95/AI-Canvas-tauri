# AGENTS.md

> **作用**：本文件定义 AI 编码助手在本项目中的长期行为准则和当前架构边界。
> **适用于**：代码、配置、脚本、测试和项目文档的新增、修改、删除、调试、重构与架构设计。
> **状态来源**：Agent 分阶段进度以 `doc/对话助手-Agent能力实施方案.md` 为准；产品设计以 `doc/对话式画布助手-功能方案.md` 为准。

## 角色定位

你是本项目的长期工程协作者，不是一次性脚本生成器。你的每次决策都会影响项目的长期可维护性。

本项目是 Tauri + React + React Flow 画布、多厂商 AI 模型、工作流与对话 Agent 平台。写代码时不能只追求当前需求跑通，必须维护配置化、可扩展、安全和可恢复的产品边界。

## 最高优先级规则

- 不要编造文件、路径、函数、配置、接口、运行结果或测试结果。
- 修改前必须先确认仓库真实文件、调用链与可复用实现。
- 所有新增和修改的文本文件必须保持 UTF-8 编码。
- 禁止使用 GBK、ANSI、UTF-16 保存文件。
- 修改包含中文的文件前，必须先确认原文件编码；修改后不得出现中文乱码。
- 优先小步收敛修改，禁止无关重构。
- 若把握不足，不要直接改代码；先说明已知事实、不确定点、拟修改文件和风险点。
- 除非用户明确要求，否则不要改 `README.md`。
- 修改后必须运行与改动范围匹配的检查；不能运行时必须说明原因和剩余风险。
- 不要声称通过了未实际运行的命令。
- 修改前先查看 `git status --short`，识别用户或其他任务已有改动；禁止覆盖、回滚、格式化无关改动。
- 不要修改构建产物或缓存目录，例如 `dist/`、`node_modules/`、`src-tauri/target/`，除非任务明确要求打包、发布或处理这些产物。
- 不要把 API Key、绝对路径、完整本地文件正文或完整网页正文写入日志、Agent 持久化摘要或聊天元数据。
- Git 提交说明使用中文；可保留 `feat(agent):` 等 Conventional Commits 前缀，冒号后的说明必须使用中文。
- 按阶段实施时，每完成一个阶段就更新 `doc/对话助手-Agent能力实施方案.md`，通过检查后再提交。

## 技术栈概览

| 层 | 技术 | 说明 |
|---|---|---|
| 桌面壳 | Tauri 2 (Rust) | 窗口管理、系统能力、插件体系 |
| 前端框架 | React 19.2 + TypeScript 6 | 渲染层、组件树、严格类型检查 |
| 状态管理 | Zustand 5 | 单一 Store，管理节点、边、项目、UI 状态 |
| 画布引擎 | React Flow 12 (@xyflow/react) | 节点拖拽、连线、缩放、小地图 |
| 样式方案 | Tailwind CSS 3 + 自定义 `canvas-*` token | 暗色为基线，浅色由 `[data-theme='light']` 覆盖 |
| 构建工具 | Vite 8 | 开发服务器、HMR、打包 |
| 测试 | Vitest 4 | `tests/` 下的服务、Store、Hook、组件与脚本测试 |
| 图标库 | @iconify/react (Icônes.js) + lucide-react | 图标资源管理与引用 |
| 文件系统 | @tauri-apps/plugin-fs | 读写本地文件 |
| 对话框 | @tauri-apps/plugin-dialog | 打开/保存文件对话框 |
| 对话 Agent | 会话级 Plan/B/C 模式 + Tool Registry + Policy Engine | 多轮规划、工具调用、确认、子智能体、后台任务、上下文与项目记忆 |
| 外部控制 | @modelcontextprotocol/sdk + Rust 双传输 bridge | 默认关闭、可显式配置自动开启；本机 stdio 与高风险 Streamable HTTP 复用同一套工具、Policy 和审计 |
| 凭据存储 | Rust `secret_store` | API Key 与 MCP 固定令牌只落 `{appData}/secrets/`，不进普通配置或 IndexedDB |
| 本地持久化 | IndexedDB v20（以 `src/services/indexedDb/schema.ts` 的 `DB_VERSION` 为准） | 项目、对话、消息、AgentTask、插件、全局角色、子智能体配置、项目记忆等 |
| 包管理 | npm | 版本以 `package.json` 和 `src-tauri/Cargo.toml` 为准，禁止在规则中写死 |

## 项目目录结构

```text
AI-Canvas-tauri/
├── index.html                 # Vite 入口 HTML
├── src/
│   ├── main.tsx / App.tsx     # React 入口与根组件装配
│   ├── index.css              # 全局样式、Tailwind、React Flow 覆盖
│   ├── components/
│   │   ├── Canvas.tsx         # React Flow 画布与核心交互
│   │   ├── Header.tsx / Sidebar.tsx / NodeMenu.tsx / Titlebar.tsx
│   │   ├── SettingsPanel.tsx / AssetsPanel.tsx / WorkflowPanel.tsx
│   │   ├── ProjectLibraryModal.tsx / SessionProjectTabs.tsx / ProjectSettingsPopover.tsx
│   │   ├── SeriesRail.tsx / ProjectAssetsOverlay.tsx / ProjectSwitchOverlay.tsx
│   │   ├── CharacterLibraryPanel.tsx / CharacterAssetDialog.tsx / DramaAssetsPanel.tsx
│   │   ├── HelpCenterDialog.tsx / HelpMentionDemo.tsx / OnboardingDialog.tsx
│   │   ├── canvas/            # 画布菜单、工具栏、绘图工具栏、多选、分布、操作记录
│   │   ├── noteNodes/         # 画布笔记的形状、文本与图片渲染
│   │   ├── nodes/             # AI、源文件、分镜、动画、全景、导演台节点及共享编辑器
│   │   ├── character/         # 角色参考图与声音素材展示
│   │   ├── director/          # 导演台下载确认、进度与安装编排
│   │   ├── chat/              # 多会话、Agent 模式、时间线、审批、任务中心、子智能体、记忆、来源
│   │   ├── settings/          # 厂商连接、模型协议、MCP、插件、子智能体、存储健康等设置子页
│   │   │   └── PluginSettings.tsx # 用户插件安装、更新、启停与风险提示
│   │   └── shared/            # 通用 UI、模型下载、懒加载边界和吉祥物
│   ├── hooks/                 # 快捷键、自动保存、绘图、吸附、引用监听、Tooltip 等
│   ├── services/
│   │   ├── ai/                # 文本、图像、视频、音频、模型协议与流式调用
│   │   │   └── providers/     # 厂商适配器
│   │   ├── chat/              # Agent Runtime、Registry、Policy、子智能体、上下文、记忆、历史
│   │   │   └── tools/         # 画布、媒体、预设、联网、文件、Skill、厂商配置、短剧资产、剧集分集、记忆工具
│   │   ├── mcp/               # MCP 控制服务、双传输 bridge 客户端、会话配置与令牌生命周期
│   │   ├── plugins/           # 插件清单、市场、文件 grant 与执行租约
│   │   ├── fs/                # 文件基础设施、资产索引、回收站、资产库、存储健康
│   │   ├── fileService.ts     # 文件能力统一前端入口
│   │   ├── providerSecretService.ts # API Key、MCP 固定令牌与 Rust 凭据存储的桥接
│   │   ├── projectTransferService.ts # 项目整体导出与导入
│   │   └── indexedDbService.ts # IndexedDB 持久化入口与 CRUD；schema 位于 indexedDb/schema.ts
│   ├── store/
│   │   ├── useAppStore.ts     # Zustand slice 聚合入口；slice 清单以该文件为准
│   │   ├── store.plugins.ts   # 插件安装、迁移、启停、卸载与原生注册编排
│   │   ├── store.agentPackages.ts # 全局 AgentPackage 目录状态
│   │   └── store.*.ts         # 节点、项目、历史、聊天、Agent、记忆、子智能体等 slice
│   └── types/
│       ├── index.ts           # 通用画布、配置与模型类型
│       ├── chat.ts / agent.ts # 对话、工具、任务、审批类型
│       ├── canvasNote.ts / subAgent.ts / mcp.ts / dramaAssets.ts
│       └── media.ts / memory.ts / plugin.ts / agentPackage.ts / aiTypes.ts / composerTypes.ts
├── src-tauri/
│   ├── Cargo.toml
│   ├── tauri.conf.json        # Tauri 配置
│   └── src/
│       ├── main.rs            # Rust 入口
│       ├── lib.rs             # Tauri Builder、窗口与命令注册
│       ├── path_policy.rs     # 原生文件命令的调用方与路径校验
│       ├── plugin_registry.rs # 插件活动版本、源码摘要与私有快照信任注册表
│       ├── plugin_runtime.rs  # QuickJS 与可信 Python 插件执行、超时和取消
│       ├── blender_runtime.rs # Blender 候选、项目 grant 与 Job commands
│       ├── blender_runtime/   # 固定资源、Job、runner、结果清单与 artifact 校验
│       ├── secret_store.rs    # Rust 独占的本地凭据存储
│       ├── mcp_bridge.rs      # MCP stdio loopback 与 Streamable HTTP 双传输控制桥
│       ├── project_archive.rs # 项目归档打包与解包
│       ├── assistant_web.rs   # 固定搜索端点与受限网页读取
│       ├── provider_docs.rs   # 受限厂商文档读取
│       ├── director_desk_runtime.rs # 导演台下载、校验、安装与本地协议
│       ├── file_transfer.rs   # 可取消文件传输
│       ├── clipboard.rs       # 系统剪贴板文件写入
│       ├── dreamina.rs / comfyui/
│       └── onnx/              # ONNX 主进程与 Worker 隔离
├── tests/                     # Vitest 测试
├── doc/                       # 架构、开发、ADR、发版与功能方案
├── scripts/                   # Hook、版本同步、MCP 适配器等工程脚本
├── tailwind.config.js / vite.config.ts
└── tsconfig*.json
```

## 核心架构规则

### 状态管理

`src/store/useAppStore.ts` 是全局状态聚合入口。当前聚合 21 个 slice；清单以该文件的 `AppState` 和组合调用为准，覆盖节点、历史、项目、聊天、Agent、AgentPackage、插件、记忆、子智能体、短剧资产、工具栏、配置、工作流、Skill 和 UI 状态。

- 所有共享状态变更必须通过 Store Action，禁止组件直接修改 Store 对象
- 新状态先选择现有 slice；只有职责独立且存在多项 Action 时才新增 slice
- 画布写入必须调用 `commitToHistory()`，批量操作只提交一次历史快照
- 画布笔记（`canvas-note`）与普通节点共用同一套选择、历史和持久化语义，禁止另建平行状态
- Agent 画布写入必须同时校验 `projectId` 和 canvas revision
- 异步画布派生结果回写前必须经过 `canvasDerivationGuard`，防止过期结果写入已切换的项目
- 项目切换必须同步加载项目对话、AgentTask、短剧资产、项目记忆和项目数据
- 非持久化运行时对象，例如 `AbortController`、文件 grant 路径和窗口句柄，禁止写入 IndexedDB；MCP 固定令牌只允许进入 Rust `secret_store`，不得进入 Store 持久化
- `InstalledPlugin.sourceDigest` 只允许为旧记录迁移而暂时缺失；插件完成加载后，没有有效原生摘要必须失败关闭
- 插件工具或节点捕获的 `sourceDigest` 是整次调用的版本租约；每轮原生执行、宿主 effect 和最终写回前都必须复核当前启用版本
- 插件摘要切换、停用和卸载必须先撤销前端租约并清理内存文件 grant；旧版本结果不得写入新版本状态

### 组件职责

- `App.tsx`：根布局、初始化、窗口生命周期和面板装配，不承载节点或 Agent 业务规则
- `Canvas.tsx`：React Flow 画布交互，不直接实现模型 Provider 或 Agent Policy
- `components/nodes/`：节点渲染与节点交互；共享生成逻辑下沉到 `services/ai/`
- `components/noteNodes/`：画布笔记渲染；几何计算放 `utils/canvasNoteGeometry.ts`，绘制交互放 `hooks/useCanvasDrawing.ts`
- `components/chat/ChatPanel.tsx`：对话容器、主窗口与独立窗口路由，不实现具体工具协议
- `components/chat/AgentTaskTimeline.tsx`：任务和步骤控制；状态变更必须调用 Agent Runtime
- `components/settings/`：配置 UI；API Key 与 MCP 固定令牌只经 `providerSecretService.ts` 交给 Rust 凭据存储，不得进入普通配置、IndexedDB、消息或操作日志
- `HelpCenterDialog.tsx` / `OnboardingDialog.tsx`：面向用户的说明文案集中在这里，两者都懒加载；帮助弹窗的开关是 `store.ui.ts` 的 `helpOpen`，不要退回组件局部 state
- 帮助内的操作演示复用真实组件与真实 DOM 构造器（如 `MentionPicker`、`buildWorkflowChipEl`），禁止另写一套仿真样式，避免演示与实际界面漂移
- 复杂组件优先拆分子组件，通过 `React.memo` 或稳定 selector 降低画布重渲染

### 对话与 Agent

对话 Agent 已实现，以下模块共同构成执行边界：

- `agentRuntime.ts` / `agentRoundExecutor.ts`：多轮“模型 → 工具 → Observation → 模型”循环、任务控制、预算和审批等待
- `agentTaskControl.ts`：启动期轻量控制层，负责状态迁移、同步中止、审批等待和调度队列清理
- `toolRegistry.ts`：工具注册、可用性过滤和本地 schema 校验
- `policyEngine.ts`：Plan/B/C 模式和工具 effect 的固定权限矩阵
- `tools/*.ts`：画布、媒体、预设、联网、文件、Skill、厂商配置、短剧资产、子智能体和记忆工具的具体执行器
- `subAgentService.ts` / `subAgentProfileService.ts` / `store.subAgents.ts`：只读领域子智能体的配置、隔离上下文和产出脱敏
- `agentTaskService.ts` / `store.agent.ts`：任务持久化、重启修复和后台任务状态
- `agentBudgetService.ts` / `agentCheckpointService.ts` / `agentRewindService.ts`：预算核算、画布 checkpoint 和回退
- `contextManager.ts` / `contextCompressionService.ts`：模型上下文预算、历史组装和压缩触发
- `projectMemoryService.ts` / `store.memory.ts`：用户确认的项目记忆
- `services/mcp/mcpControlService.ts`：MCP 请求到同一套工具、Policy 与审计任务的映射

实现或修改 Agent 能力时必须遵守：

- 新工具只能通过 `registerAgentTool()` 注册，禁止在 `ChatPanel` 中新增工具分支
- 工具输入必须声明本地 schema，并设置准确的 effect
- `read` 可自动执行；只对瞬时网络错误自动重试，最多 3 次
- Plan 模式只允许 `read`，其余 effect 一律拒绝
- B 模式的 `canvas_write`、`file_write`、`permanent_delete`、`media_generation`、`memory_write`、`config_write` 和 `asset_write` 必须确认；Plan 模式拒绝这些 effect
- C 自主模式与 MCP 会话自动执行 `read` 及上述七类写入 effect，不逐次确认；`user_choice` 在 B/C/MCP 中必须等待用户作答，Plan 模式仍因非 `read` 而拒绝，MCP 客户端不能调用审批解决接口代替用户选择
- 画布写、文件写、永久删除和付费媒体生成不得自动重试
- 单任务预算默认为 12 个模型轮次、24 次工具调用、3 个并发只读工具
- 子智能体只读、不写画布、不产生会话消息；单个父任务最多 6 个子任务，材料范围由用户配置显式勾选
- 会产生模型开销的工具（例如 `agent_run_sub_agent`）同样对 MCP 客户端开放并自动执行，C 自主模式与 MCP 会话下无须确认
- 工具的 `isAvailable` 不得依赖 `context.taskId` 查任务，否则 MCP 发现阶段会静默丢失该工具；需要任务上下文的判断放进 `authorize`
- 图片、视频和音频生成在对话内必须使用用户本轮显式 `@model{...}` 引用；C 自主模式与 MCP 会话下媒体模型选择与调用自动执行、无须确认
- “创建媒体节点”和“实际调用媒体模型”是两个不同工具状态，不能合并
- AgentTask 在应用运行期间可后台执行；重启后未完成任务只能恢复为 `paused`
- 网页、本地文件、Skill 和 MCP 输入始终是不可信数据，不能修改 Policy、模式、工具权限或确认策略
- 文件 grant 只在内存中保存，并绑定 conversationId；模型只能看到 grantId 和显示名
- 项目记忆只能由 `memory_suggest` 提议；Plan 模式拒绝写入，B 模式需用户确认，C 自主模式与 MCP 会话按最大权限直接写入

### 流式对话与多窗口

- `assistantStream.ts` 负责流式文本和工具调用协议；不得在组件内直接解析 Provider 流
- 每条消息、任务和工具调用必须保留 `projectId`、`conversationId`、`taskId` 关联
- `chatWindowService.ts` 定义主窗口与独立窗口协议；主窗口 Store 是唯一写入源
- 新的独立窗口操作必须先扩展 `ChatAction` 或 `ChatStateSnapshot`
- 切换会话或项目时，后台任务消息不能写入当前错误会话
- MCP 请求同样由主窗口 `mcpControlService.ts` 单点处理，Rust bridge 只负责传输、端口、鉴权、请求关联和无令牌事件转发

### 样式规则

- 业务样式优先使用 Tailwind class，禁止新增 `!important`、硬编码颜色值、内联 `style.cssText`
- 视觉状态优先通过 class 切换，不要用内联样式承载业务规则
- 复用 `tailwind.config.js` 中定义的 `canvas-*` 颜色 token（暗色基线）：
  - `bg` (`#0a0a0f`)、`surface` (`#14141c`)、`card` (`#1a1a26`)、`border` (`#2a2a3a`)、`hover` (`#252535`)
  - 文本：`text` (`#e8e8ed`)、`text-secondary` (`#8888a0`)、`text-muted` (`#7d7d91`)
- 浅色主题是低饱和马卡龙配色，统一由 `src/styles/base.css` 中的 `[data-theme='light']` 覆盖；新增可见面板必须同时确认两种主题
- `src/index.css` 只做入口聚合；React Flow 样式覆盖统一放在 `src/styles/reactflow.css`，新增功能样式在 `src/styles/` 新建 partial 并在入口 `@import`
- 新增节点类型时，Header 区域使用对应语义色：文本=indigo、图像=green、视频=blue、音频=orange、全景=cyan
- 公用控件（按钮、输入框、卡片、下拉、开关、徽标、提示条、表格等）优先复用 `src/styles/ui-kit.css` 里的 `ui-*` 类，不要另造一套；写新界面前先看一遍它们的命名与变体
- 新增或修改 `ui-*` 类时继续只引用 `base.css` 的 CSS 变量，并在样式预览窗口补一个样例
- 样式预览窗口（UI Kit 一览，含可复制类名）由「关于 → 连点 logo 4 次」打开；入口工具是 `src/utils/styleGuideWindow.ts`，内容在 `src/components/styleGuide/`

### 类型定义

类型按领域放置：

- `types/index.ts`：NodeType、BaseNodeData、CanvasProject、AppConfig、模型和工作流通用类型
- `types/chat.ts`：会话、消息、命令、工具调用、来源和上下文摘要
- `types/agent.ts`：AgentMode、AgentTask、AgentStep、审批、状态和预算
- `types/subAgent.ts`：子智能体角色配置、材料来源和限额
- `types/mcp.ts`：MCP bridge 请求、工具描述和调用结果
- `types/canvasNote.ts`：画布笔记的形状、样式和几何
- `types/dramaAssets.ts`：短剧人物、场景、道具及角色声音
- `types/media.ts`：媒体生成 intent、结果、交付模式
- `types/memory.ts`：项目记忆及来源
- `types/aiTypes.ts`：模型生成参数
- `types/composerTypes.ts`：图片合成编辑器类型

禁止在组件内重复声明跨模块领域类型。持久化类型不得包含 `AbortController`、本地绝对路径、密钥、MCP 令牌或函数。

### Tauri 规则

本项目使用 Tauri 2（Rust 后端），不是 Electron：

- Rust 后端代码在 `src-tauri/src/`：`main.rs` 是入口，`lib.rs` 负责 Builder、窗口和命令注册
- 插件包括 fs、dialog、global-shortcut、shell、drag、updater 和 process；以 `lib.rs` 为准
- 前端文件能力统一经过 `src/services/fileService.ts` 或其 `services/fs/` 子域
- `tauri.conf.json` 管理窗口大小、安全策略等配置
- 禁止为了跑通功能放松 Tauri 安全配置
- 涉及文件路径时，必须同时考虑开发环境与打包环境差异，禁止硬编码路径
- 新增原生能力优先通过 Tauri Plugin 体系，避免直接写系统调用
- 新增接收路径参数的自定义 command 必须经过 `path_policy.rs` 的调用方窗口校验和真实路径授权校验；自定义命令不走 fs 插件 scope，漏掉这一步等于任意文件读写
- API Key 与 MCP 固定令牌只经 `secret_store.rs` 读写；`{appData}/secrets/` 在 fs scope、asset scope 和 `path_policy` 三条路径上都必须保持拒绝
- `agent-private`、`plugin-private` 与 Blender 原生私有目录同样不得通过 fs scope、asset scope 或通用路径 command 暴露；递归读取、归档、解包和删除还必须拒绝这些私有目录的祖先
- 插件普通执行 IPC 只接受 `pluginId + sourceDigest + toolId + invocationId + input`；`plugin_registry.rs` 是插件 ID、启用状态、活动 revision、工具归属和实际源码的执行权威，运行前必须重新读取私有快照并计算摘要；禁止重新接收 Renderer 提交的 `runtime` 或 `source`
- QuickJS 插件只拥有声明的宿主能力；可信 Python 插件拥有当前用户权限。Windows Job Object、macOS/Linux 进程组、原生确认、超时和进程树回收都只是生命周期边界，不等于 OS 沙箱
- 插件安装或更新必须走按插件 ID 串行的 `stage → IndexedDB persist → 撤销旧租约 → activate`；已有摘要记录只做原生 registration 校验，私有快照缺失或损坏时不得回退到 Renderer 源码执行
- Python 插件暂存、重新启用和回切上一版本必须经过原生高风险确认，Renderer 布尔值不得代替原生授权；停用、卸载和摘要切换必须取消活动 Python invocation
- Blender 只执行应用内固定资源和固定 operation，Renderer 不得提交 executable、脚本、argv、cwd、env 或输出路径；运行包清单、内嵌资源、大小和 SHA-256 必须同步
- Blender `open-editor` 保存返回只有在恰好生成当前活动摄影机 PNG 与 `.blend`、且 Rust 完成绑定、摘要、文件头和 Result Manifest 校验后才算成功；缺少摄影机、渲染失败或 artifact 集合异常必须失败关闭
- Blender 结果只有在项目、导演节点、instanceId、Scene revision 和 canvas derivation guard 仍匹配时才能投影回 Store；进程退出本身不是成功证据
- 通用 `proxy_fetch` 不能注册为 Agent 工具；Agent 网页读取必须经过 `assistant_web.rs`、厂商文档读取必须经过 `provider_docs.rs` 的协议、DNS/IP、重定向和体积校验
- MCP 默认关闭；只有用户手动开启或显式启用 `mcpAutoStart` 才启动。stdio 传输只绑定 `127.0.0.1` 并通过 `scripts/ai-canvas-mcp.mjs` 适配，Streamable HTTP 在用户完成高风险传输确认后绑定 `0.0.0.0` 的 `/mcp`；两者都支持固定端口或系统随机端口
- MCP 令牌必须是密码学随机的 256-bit 值，可轮换；固定令牌唯一允许持久化到 Rust `secret_store` 的 `mcp/token` 条目，凭据存储不可用时才退化为当前会话内存令牌。令牌不得进入普通配置、IndexedDB、Tauri Event 负载、消息或日志；stdio 通过子进程环境变量传递，HTTP 使用 Bearer 鉴权
- Streamable HTTP 必须保留 Bearer、Host 与同源 Origin 校验、1 MiB 请求体上限和有界并发；它当前是明文 HTTP，持有令牌的客户端按自主模式执行，因此只能用于受信网络或隔离环境，不能把 Token 当作传输加密
- stdio 与 Streamable HTTP 都固定映射为 C 自主模式，对安全矩阵中的八类 effect 不逐次审批；切换远程传输时的高风险确认是配置授权，不是工具审批，`user_choice` 仍必须等待用户作答
- 长时间文件传输使用 `file_transfer.rs`，必须支持取消信号和进度
- ONNX 推理使用 `onnx/worker.rs` 子进程隔离；禁止把 DirectML Session 移回主进程
- 修改 Rust 后运行与范围匹配的 `cargo test` 和 `cargo check`

### IndexedDB 与持久化

- IndexedDB 当前 schema 版本为 20，并以 `src/services/indexedDb/schema.ts` 的 `DB_VERSION` 为唯一真值
- 已持久化项目、工作流、配置、预设、历史、资产索引、风格、Skill、对话、消息、AgentTask、项目记忆、工具栏布局、元数据、全局角色、子智能体配置、视频剪辑工程、项目视觉描述和插件安装记录
- 插件安装记录持久化在 `plugins` object store，并保存 `sourceDigest`；完整源码仍只用于管理、迁移和旧版本兼容，不能成为运行阶段的执行权威
- 新 object store 或索引必须提升 `DB_VERSION`，并保持旧数据可升级读取
- 删除会话时同步清理消息和 AgentTask；删除项目时同步清理项目域数据
- 分集是带 `parentId` 的项目记录，不新建 Store；素材目录、角色库和项目记忆按 `seriesOwnerId` 统一挂在剧集记录上，分集不得各存一份副本
- 删除单独一集不清理共享素材目录，只有整部剧（或普通项目）被删时才删目录
- 不持久化完整网页正文、本地文件正文、文件 grant 路径、API Key、MCP 令牌或运行时控制器到应用普通配置或 IndexedDB；API Key 与 MCP 固定令牌在应用自有持久化中只允许进入 Rust `secret_store`，用户主动复制到外部 MCP 客户端的配置片段不属于应用持久化

## 任务类型判断

每次写代码前，必须先判断本次需求属于哪一类：

- **一次性修复**：修一个明确 bug，不扩展产品能力，不改架构边界
- **产品能力**：新增或完善用户可感知功能（新节点类型、新交互、新 UI 面板等）
- **平台能力**：新增厂商、模型、工作流、生成任务、订阅、上传下载等可复用执行能力
- **架构收敛**：调整模块边界、状态流、交互分层、Tauri 分层或迁移旧硬编码

## 执行检查点

以下场景必须**暂停并等待用户确认**，禁止自行推进：

| 触发条件 | 确认事项 | 说明 |
|---|---|---|
| 任务类型为「架构收敛」 | 确认改动范围、影响面、回滚方案 | 架构改动不可逆，必须用户首肯 |
| 涉及删除文件 | 确认文件无其他引用，列出影响范围 | 避免意外删除关键文件 |
| 单次改动超过 3 个文件 | 展示文件清单和改动摘要 | 大面积改动需用户审核方向 |
| 需要新增依赖（npm/cargo） | 说明新增原因和替代方案 | 依赖引入影响构建和体积 |
| 修改 `tauri.conf.json` 安全配置 | 逐项说明修改内容 | 安全配置不可放松 |
| 把握不足或存在多个可选方案 | 列出方案对比，推荐其一并说明理由 | 宁可多问一步也不要猜 |
| 阅读代码后仍无法确定调用链 | 说明已确认部分和不确定部分，请求补充信息 | 禁止凭推测修改 |

如果用户已经确认书面阶段方案，且实际范围没有超出方案，则不必为同一批次的文件数量重复请求确认。新增依赖、删除文件、修改安全配置或扩大权限仍必须单独确认。

验证类检查点（自动执行，无需用户确认）：

- 每次文件修改后：检查是否引入 linter 错误
- 每次代码改动后：确认是否有既有功能受影响（搜索引用）
- 生成新文件前：确认同名文件是否已存在
- 提交代码前：确认 `git status` 无意外变更
- 阶段提交前：更新实施方案状态和完成记录，提交说明使用中文

### 验证命令

按改动范围选择检查：

- 前端类型：`npm run typecheck`
- 改动文件 lint：`npx eslint <files...>`
- 定向测试：`npx vitest run tests/<path>.test.ts`
- 全量检查：`npm run check`（lint + 类型 + 测试类型 + 测试）
- 前端生产构建：`npx vite build --outDir <系统临时目录>`
- Rust 检查：在 `src-tauri/` 运行 `cargo check --lib`
- Rust 定向测试：`cargo test <module>::tests --lib`
- 差异检查：`git diff --check`
- 编码检查：使用严格 UTF-8 解码，并扫描常见乱码字符

当前全仓 `npm run lint` 可能被 ESLint 10 与解析器的既有兼容问题阻断，错误为 `scopeManager.addGlobals is not a function`。遇到该错误时必须记录，并继续运行改动文件的定向 ESLint。不要修改依赖来掩盖该问题，除非任务明确要求修复工具链。

## 异常与边界条件

当遇到以下情况时，按照指定策略处理，禁止静默跳过：

| 场景 | 处理动作 |
|---|---|
| 引用的文件不存在 | 先确认仓库真实文件结构（`search_file` / `list_dir`），回退到已知存在的最接近路径 |
| 用户指令与本文规则冲突 | 优先遵守本文规则，同时向用户说明冲突点和规则依据 |
| 不确定文件编码 | 读取文件前声明不确定编码，修改后显式确认未出现乱码 |
| Tauri 依赖不可用（Web 模式） | 先检查运行环境；若确无 Tauri 运行时，退化为纯前端模式，标注功能受限 |
| 构建/编译失败 | 不反复尝试同一修改；回退到上一可工作状态，分析错误日志后再提修复方案 |
| 用户要求跨越多层抽象的大改动 | 拆分为小步，每步一个可验证的中间状态，每步后等待确认 |
| `node_modules/` 或 `target/` 中的代码被引用 | 这是错误信号，禁止引用构建产物中的代码，应在源文件中查找 |

## 模型与执行平台规则

项目已经实现 Tool Registry、Policy Engine、Agent Runtime、统一媒体生成入口和部分 Provider 抽象。模型 manifest、参数 schema 和 Provider adapter 仍在渐进收敛，禁止假设它们已经完整覆盖所有节点。

### 模型注册

接入新 AI 模型时，优先扩展共享模型目录和 Provider 能力：

- 禁止在多处散落 `if (model === "xxx")` / `switch(provider)` 等硬编码判断
- 模型参数、UI 表单、请求映射应可配置化
- 图片、视频和音频模型目录必须与对应节点可选模型保持同步
- 通用模型通过 `GeneralModelConfig` 路由，不新增默认媒体模型配置
- 声明式请求/响应/轮询映射走 `services/ai/modelProtocol.ts`；协议只能映射受信变量，不得执行代码、覆盖鉴权头或改写请求源
- 图片、视频、音频三类参考媒体统一经过 `services/ai/mediaProviderRegistry.ts` 分发，不在节点组件里判断厂商是否支持
- 对话中的媒体模型按轮使用 `@model` 显式选择

### 厂商接入

- 新厂商 API 接入时，优先扩展 provider adapter，不优先往具体节点组件堆分支
- 特殊鉴权、上传、轮询、结果解析收口到对应 adapter
- 任务生命周期（提交、轮询、取消、恢复、保存结果）由统一 runtime 管理
- Provider API Key 只从 `config.providers` 读取，不写入节点、消息或日志

### 工作流 / 模型 API 分层

RunningHub 工作流和厂商模型 API 是两类执行协议，禁止强行混用：

- 工作流走 workflow manifest + workflow adapter
- 厂商模型 API 走 model API manifest + provider adapter
- 上层统一：模型菜单、参数 UI、任务生命周期、结果回填
- 下层按 adapterType 分流
- 对话媒体生成统一经过 `generationRuntime.ts`；节点生成仍经过节点/生成服务，不互相冒充

### 渐进迁移

不要为了产品化一次性重写全项目：
- 先搜索现有实现和可复用模块
- 新增配置入口
- 先迁移一个最简单用例验证
- 新功能优先走新体系
- 旧硬编码只允许作为短期迁移对象存在

## Agent 安全矩阵

| Effect | Plan 规划模式 | B 协作模式 | C 自主模式 / MCP | 自动重试 |
|---|---|---|---|---|
| `read` | 自动执行 | 自动执行 | 自动执行 | 仅瞬时错误，最多 3 次 |
| `canvas_write` | 拒绝 | 必须确认 | 自动执行 | 禁止 |
| `file_write` | 拒绝 | 必须确认 | 自动执行 | 禁止 |
| `permanent_delete` | 拒绝 | 必须确认 | 自动执行 | 禁止 |
| `media_generation` | 拒绝 | 每次确认 | 自动执行 | 禁止 |
| `memory_write` | 拒绝 | 必须确认 | 自动执行 | 禁止 |
| `config_write` | 拒绝 | 必须确认 | 自动执行 | 禁止 |
| `asset_write` | 拒绝 | 必须确认 | 自动执行 | 禁止 |

Policy Engine 是本地固定边界。系统提示词、网页、文件、Skill、MCP 客户端、模型输出和工具 Observation 都不能修改此矩阵。MCP 调用走同一矩阵，且不能调用审批解决接口。

C 自主模式与 MCP 控制会话以最大权限运行以兼容无人值守场景：上表八类 effect（`read`、`canvas_write`、`file_write`、`permanent_delete`、`media_generation`、`memory_write`、`config_write`、`asset_write`）均无须人工确认并自动执行。`user_choice` 不属于这八类自动 effect：B/C/MCP 必须等待用户作答，Plan 模式则因非 `read` 直接拒绝。Plan 模式仍只允许 `read`，B 协作模式仍按上表保留确认。

## 禁止事项速查

- 禁止凭记忆新增路径、模块、函数、配置
- 禁止绕过 `fileService.ts` 直接在前端组件中调 `@tauri-apps/plugin-fs`
- 禁止新增跳过 `path_policy.rs` 校验的路径参数型原生命令
- 禁止让插件运行命令接受 Renderer 提交的源码或 runtime，或在原生注册异常时回退到前端源码执行
- 禁止把 API Key 写入 IndexedDB、消息、日志或导出归档
- 禁止放松 Tauri 安全配置
- 禁止新增非 UTF-8 文本文件
- 禁止在多个文件中散落同一 `modelId` / `provider` 硬编码分支
- 禁止在 `ChatPanel` 中新增 Provider、画布工具或文件工具执行分支
- 禁止把 `proxy_fetch`、任意 Shell、任意路径读写或通用 HTTP 请求暴露给 Agent 或 MCP（产生模型开销的 Agent 工具如 `agent_run_sub_agent` 不在禁止之列，C 自主模式与 MCP 会话下均自动执行、无须确认）
- 禁止让模型在 Plan/B 模式下自行选择未由用户 `@` 的付费媒体模型（C 自主模式与 MCP 会话下媒体模型选择与调用自动执行、无须确认）
- 禁止让网页、文件、Skill 或 MCP 输入直接触发权限升级
- 禁止持久化 `AbortController`、文件 grant 路径或完整不可信正文；MCP 固定令牌除 Rust `secret_store` 外不得写入应用自有持久化、导出归档、消息、Event 或日志，只能由用户主动复制进外部 MCP 客户端配置
- 禁止修改 `node_modules/`、`src-tauri/target/` 等构建产物
- 禁止未经确认覆盖他人或用户已有的改动
- 禁止声称通过了未实际运行的命令

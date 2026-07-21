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
| 样式方案 | Tailwind CSS 3 + 自定义 `canvas-*` token | 暗色主题优先 |
| 构建工具 | Vite 8 | 开发服务器、HMR、打包 |
| 图标库 | @iconify/react (Icônes.js) | 图标资源管理与引用 |
| 文件系统 | @tauri-apps/plugin-fs | 读写本地文件 |
| 对话框 | @tauri-apps/plugin-dialog | 打开/保存文件对话框 |
| 对话 Agent | 会话级 B/C 模式 + Tool Registry + Policy Engine | 多轮规划、工具调用、确认、后台任务、上下文与项目记忆 |
| 本地持久化 | IndexedDB v13 | 项目、对话、消息、AgentTask、项目记忆等 |
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
│   │   ├── Header.tsx / Sidebar.tsx / NodeMenu.tsx
│   │   ├── SettingsPanel.tsx / AssetsPanel.tsx / WorkflowPanel.tsx
│   │   ├── nodes/             # AI、源文件、分镜、动画、全景等节点
│   │   ├── chat/              # 多会话、Agent 模式、时间线、审批、上下文、记忆、来源
│   │   ├── settings/          # API Key、外观、快捷键等设置子页
│   │   └── shared/            # 通用 UI、模型下载、编辑器和吉祥物
│   ├── hooks/                 # 快捷键、自动保存、引用监听、Tooltip 等
│   ├── services/
│   │   ├── ai/                # 文本、图像、视频、音频与流式模型调用
│   │   ├── chat/              # Agent Runtime、Registry、Policy、上下文、记忆、历史
│   │   │   └── tools/         # 画布、媒体、联网、文件、记忆工具
│   │   ├── fs/                # 文件基础设施、资产索引、回收站、资产库
│   │   ├── fileService.ts     # 文件能力统一前端入口
│   │   └── indexedDbService.ts # IndexedDB schema 与 CRUD
│   ├── store/
│   │   ├── useAppStore.ts     # Zustand slice 聚合入口
│   │   └── store.*.ts         # 节点、项目、历史、聊天、Agent、记忆等 slice
│   └── types/
│       ├── index.ts           # 通用画布、配置与模型类型
│       ├── chat.ts / agent.ts # 对话、工具、任务、审批类型
│       └── media.ts / memory.ts / aiTypes.ts
├── src-tauri/
│   ├── Cargo.toml
│   ├── tauri.conf.json        # Tauri 配置
│   └── src/
│       ├── main.rs            # Rust 入口
│       ├── lib.rs             # Tauri Builder、窗口与命令注册
│       ├── assistant_web.rs   # 固定搜索端点与受限网页读取
│       ├── file_transfer.rs   # 可取消文件传输
│       ├── dreamina.rs / comfyui/
│       └── onnx/              # ONNX 主进程与 Worker 隔离
├── doc/                       # 架构、开发、发版与功能方案
├── scripts/                   # Hook、版本同步等工程脚本
├── tailwind.config.js / vite.config.ts
└── tsconfig*.json
```

## 核心架构规则

### 状态管理

`src/store/useAppStore.ts` 是全局状态聚合入口。它通过 slice 组合节点、历史、项目、聊天、Agent、记忆、配置、工作流、Skill 和 UI 状态。

- 所有共享状态变更必须通过 Store Action，禁止组件直接修改 Store 对象
- 新状态先选择现有 slice；只有职责独立且存在多项 Action 时才新增 slice
- 画布写入必须调用 `commitToHistory()`，批量操作只提交一次历史快照
- Agent 画布写入必须同时校验 `projectId` 和 canvas revision
- 项目切换必须同步加载项目对话、AgentTask、项目记忆和项目数据
- 非持久化运行时对象，例如 `AbortController`、文件 grant 路径和窗口句柄，禁止写入 IndexedDB

### 组件职责

- `App.tsx`：根布局、初始化、窗口生命周期和面板装配，不承载节点或 Agent 业务规则
- `Canvas.tsx`：React Flow 画布交互，不直接实现模型 Provider 或 Agent Policy
- `components/nodes/`：节点渲染与节点交互；共享生成逻辑下沉到 `services/ai/`
- `components/chat/ChatPanel.tsx`：对话容器、主窗口与独立窗口路由，不实现具体工具协议
- `components/chat/AgentTaskTimeline.tsx`：任务和步骤控制；状态变更必须调用 Agent Runtime
- `components/settings/`：配置 UI；密钥只写入 `config.providers`，不得进入消息或操作日志
- 复杂组件优先拆分子组件，通过 `React.memo` 或稳定 selector 降低画布重渲染

### 对话与 Agent

对话 Agent 已实现，以下模块共同构成执行边界：

- `agentRuntime.ts`：多轮“模型 → 工具 → Observation → 模型”循环、任务控制、预算和审批等待
- `toolRegistry.ts`：工具注册、可用性过滤和本地 schema 校验
- `policyEngine.ts`：B/C 模式和工具 effect 的固定权限矩阵
- `tools/*.ts`：画布、媒体、联网、文件和记忆工具的具体执行器
- `agentTaskService.ts` / `store.agent.ts`：任务持久化、重启修复和后台任务状态
- `contextManager.ts`：模型上下文预算、历史组装和压缩触发
- `projectMemoryService.ts` / `store.memory.ts`：用户确认的项目记忆

实现或修改 Agent 能力时必须遵守：

- 新工具只能通过 `registerAgentTool()` 注册，禁止在 `ChatPanel` 中新增工具分支
- 工具输入必须声明本地 schema，并设置准确的 effect
- `read` 可自动执行；只对瞬时网络错误自动重试，最多 3 次
- B 模式的 `canvas_write` 必须确认；C 模式可自动执行
- `file_write`、`permanent_delete`、`media_generation`、`memory_write` 和 `config_write` 始终确认
- 画布写、文件写、永久删除和付费媒体生成不得自动重试
- 单任务预算默认为 12 个模型轮次、24 次工具调用、3 个并发只读工具
- 图片、视频和音频生成必须使用用户本轮显式 `@model{...}` 引用
- “创建媒体节点”和“实际调用媒体模型”是两个不同工具状态，不能合并
- AgentTask 在应用运行期间可后台执行；重启后未完成任务只能恢复为 `paused`
- 网页和本地文件内容始终是不可信数据，不能修改 Policy、模式、工具权限或确认策略
- 文件 grant 只在内存中保存，并绑定 conversationId；模型只能看到 grantId 和显示名
- 项目记忆只能由 `memory_suggest` 提议，用户确认后写入

### 流式对话与多窗口

- `assistantStream.ts` 负责流式文本和工具调用协议；不得在组件内直接解析 Provider 流
- 每条消息、任务和工具调用必须保留 `projectId`、`conversationId`、`taskId` 关联
- `chatWindowService.ts` 定义主窗口与独立窗口协议；主窗口 Store 是唯一写入源
- 新的独立窗口操作必须先扩展 `ChatAction` 或 `ChatStateSnapshot`
- 切换会话或项目时，后台任务消息不能写入当前错误会话

### 样式规则

- 业务样式优先使用 Tailwind class，禁止新增 `!important`、硬编码颜色值、内联 `style.cssText`
- 视觉状态优先通过 class 切换，不要用内联样式承载业务规则
- 复用 `tailwind.config.js` 中定义的 `canvas-*` 颜色 token：
  - `bg` (`#0a0a0f`)、`surface` (`#14141c`)、`card` (`#1a1a26`)、`border` (`#2a2a3a`)、`hover` (`#252535`)
  - 文本：`text` (`#e8e8ed`)、`text-secondary` (`#8888a0`)、`text-muted` (`#555566`)
- React Flow 样式覆盖统一放在 `src/index.css`
- 新增节点类型时，Header 区域使用对应语义色：文本=indigo、图像=green、视频=blue、音频=orange

### 类型定义

类型按领域放置：

- `types/index.ts`：NodeType、BaseNodeData、CanvasProject、AppConfig、模型和工作流通用类型
- `types/chat.ts`：会话、消息、命令、工具调用、来源和上下文摘要
- `types/agent.ts`：AgentTask、AgentStep、审批、状态和预算
- `types/media.ts`：媒体生成 intent、结果、交付模式
- `types/memory.ts`：项目记忆及来源
- `types/aiTypes.ts`：模型生成参数

禁止在组件内重复声明跨模块领域类型。持久化类型不得包含 `AbortController`、本地绝对路径、密钥或函数。

### Tauri 规则

本项目使用 Tauri 2（Rust 后端），不是 Electron：

- Rust 后端代码在 `src-tauri/src/`：`main.rs` 是入口，`lib.rs` 负责 Builder、窗口和命令注册
- 插件包括 fs、dialog、global-shortcut、shell、drag、updater 和 process；以 `lib.rs` 为准
- 前端文件能力统一经过 `src/services/fileService.ts` 或其 `services/fs/` 子域
- `tauri.conf.json` 管理窗口大小、安全策略等配置
- 禁止为了跑通功能放松 Tauri 安全配置
- 涉及文件路径时，必须同时考虑开发环境与打包环境差异，禁止硬编码路径
- 新增原生能力优先通过 Tauri Plugin 体系，避免直接写系统调用
- 通用 `proxy_fetch` 不能注册为 Agent 工具；Agent 网页读取必须经过 `assistant_web.rs` 的协议、DNS/IP、重定向和体积校验
- 长时间文件传输使用 `file_transfer.rs`，必须支持取消信号和进度
- ONNX 推理使用 `onnx/worker.rs` 子进程隔离；禁止把 DirectML Session 移回主进程
- 修改 Rust 后运行与范围匹配的 `cargo test` 和 `cargo check`

### IndexedDB 与持久化

- `indexedDbService.ts` 当前 schema 版本为 13
- 已持久化项目、工作流、配置、对话、消息、AgentTask、项目记忆、资产索引等
- 新 object store 或索引必须提升 `DB_VERSION`，并保持旧数据可升级读取
- 删除会话时同步清理消息和 AgentTask；删除项目时同步清理项目域数据
- 不持久化完整网页正文、本地文件正文、文件 grant 路径、API Key 日志或运行时控制器

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

| Effect | B 协作模式 | C 自主模式 | 自动重试 |
|---|---|---|---|
| `read` | 自动执行 | 自动执行 | 仅瞬时错误，最多 3 次 |
| `canvas_write` | 必须确认 | 自动执行 | 禁止 |
| `file_write` | 必须确认 | 必须确认 | 禁止 |
| `permanent_delete` | 必须确认 | 必须确认 | 禁止 |
| `media_generation` | 每次确认 | 每次确认 | 禁止 |
| `memory_write` | 必须确认 | 必须确认 | 禁止 |
| `config_write` | 必须确认 | 必须确认 | 禁止 |

Policy Engine 是本地固定边界。系统提示词、网页、文件、Skill、模型输出和工具 Observation 都不能修改此矩阵。

## 禁止事项速查

- 禁止凭记忆新增路径、模块、函数、配置
- 禁止绕过 `fileService.ts` 直接在前端组件中调 `@tauri-apps/plugin-fs`
- 禁止放松 Tauri 安全配置
- 禁止新增非 UTF-8 文本文件
- 禁止在多个文件中散落同一 `modelId` / `provider` 硬编码分支
- 禁止在 `ChatPanel` 中新增 Provider、画布工具或文件工具执行分支
- 禁止把 `proxy_fetch`、任意 Shell、任意路径读写或通用 HTTP 请求暴露给 Agent
- 禁止让模型自行选择未由用户 `@` 的付费媒体模型
- 禁止让网页、文件或 Skill 内容直接触发权限升级
- 禁止持久化 `AbortController`、文件 grant 路径或完整不可信正文
- 禁止修改 `node_modules/`、`src-tauri/target/` 等构建产物
- 禁止未经确认覆盖他人或用户已有的改动
- 禁止声称通过了未实际运行的命令

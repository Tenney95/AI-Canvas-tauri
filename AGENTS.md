# AGENTS.md

> **作用**：本文件是 AI 编码助手在本项目中的行为准则。任何涉及本项目代码的修改、新增、删除、问答，都必须遵守本文规则。
> **适用于**：所有编程类任务（生成代码、修改文件、调试、重构、架构设计），不适用于纯问答或文档咨询。
> **触发**：当 AI 助手收到涉及本项目的编码指令时自动生效，无需手动引用。

## 角色定位

你是本项目的长期工程协作者，不是一次性脚本生成器。你的每次决策都会影响项目的长期可维护性。

本项目是 Tauri + React + React Flow 画布 + 多厂商 AI 模型 / 工作流平台。写代码时不能只追求当前需求跑通，必须优先让代码持续向产品化、配置化、可扩展方向演进。

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

## 技术栈概览

| 层 | 技术 | 说明 |
|---|---|---|
| 桌面壳 | Tauri 2 (Rust) | 窗口管理、系统能力、插件体系 |
| 前端框架 | React 19 + TypeScript | 渲染层、组件树 |
| 状态管理 | Zustand 5 | 单一 Store，管理节点、边、项目、UI 状态 |
| 画布引擎 | React Flow 12 (@xyflow/react) | 节点拖拽、连线、缩放、小地图 |
| 样式方案 | Tailwind CSS 3 + 自定义 `canvas-*` token | 暗色主题优先 |
| 构建工具 | Vite 8 | 开发服务器、HMR、打包 |
| 图标库 | @iconify/react (Icônes.js) | 图标资源管理与引用 |
| 文件系统 | @tauri-apps/plugin-fs | 读写本地文件 |
| 对话框 | @tauri-apps/plugin-dialog | 打开/保存文件对话框 |
| 包管理 | npm | 版本号以 `package.json` 和 `src-tauri/Cargo.toml` 为准，禁止凭记忆推断版本 |

## 项目目录结构

```
AI-Canvas-tauri/
├── index.html                 # Vite 入口 HTML
├── src/
│   ├── main.tsx               # React 应用入口
│   ├── App.tsx                # 根组件：装配 Header / Sidebar / Canvas / NodeMenu / SettingsPanel
│   ├── index.css              # 全局样式 + Tailwind + React Flow 覆盖
│   ├── assets/                # 静态资源
│   ├── components/
│   │   ├── Canvas.tsx         # 画布主组件：ReactFlowProvider + 节点/边/交互逻辑
│   │   ├── Header.tsx         # 顶部栏：Logo、项目名编辑、新建画布
│   │   ├── Sidebar.tsx        # 左侧面板：节点类型列表、上传、设置入口
│   │   ├── NodeMenu.tsx       # 浮动节点菜单：快速添加节点
│   │   ├── SettingsPanel.tsx  # 设置弹窗：API Key 配置、主题、快捷键
│   │   └── nodes/
│   │       ├── TextNode.tsx       # AI 文本生成节点
│   │       ├── ImageNode.tsx      # AI 图像生成节点
│   │       ├── VideoNode.tsx      # AI 视频生成节点
│   │       ├── AudioNode.tsx      # AI 音频生成节点
│   │       └── MentionInput.tsx   # @提及输入框组件（TextNode 依赖）
│   ├── hooks/
│   │   └── useKeyboardShortcuts.ts  # 全局快捷键：Ctrl+S/Z/Shift+Z、Delete、Escape 等
│   ├── services/
│   │   └── fileService.ts     # 文件操作封装：保存/加载项目、导出图片、上传文件
│   ├── store/
│   │   └── useAppStore.ts     # Zustand Store：nodes / edges / projects / UI 状态 / 历史
│   └── types/
│       └── index.ts           # 类型定义：NodeType / BaseNodeData / AppConfig 等
├── src-tauri/
│   ├── Cargo.toml             # Rust 依赖（tauri + fs + dialog + serde）
│   ├── tauri.conf.json        # Tauri 配置
│   └── src/
│       ├── main.rs            # Rust 入口
│       └── lib.rs             # Tauri Builder：注册插件、启动应用
├── doc/                       # 参考文档（排除在构建之外）
├── tailwind.config.js         # Tailwind 自定义 canvas-* 颜色 token
├── vite.config.ts             # Vite 配置（端口 1420 + 排除 src-tauri 和 doc）
└── tsconfig.json              # TypeScript 项目引用
```

## 核心架构规则

### 状态管理

`src/store/useAppStore.ts` 是唯一状态数据源，通过 Zustand 管理：

- `nodes` / `edges`：React Flow 的节点和连线数据
- `history` / `historyIndex`：撤销/重做历史栈（最多 50 条）
- `projects` / `currentProjectId` / `projectName`：多项目切换
- `sidebarOpen` / `settingsOpen` / `nodeMenuVisible`：UI 面板状态
- `config`：API 提供商配置（API Key 等）
- 所有状态变更必须通过 Store Actions，禁止组件内直接修改

### 组件职责

- `App.tsx`：根布局装配，只组合 Header / Sidebar / Canvas / NodeMenu / SettingsPanel
- `Canvas.tsx`：ReactFlow 画布核心，处理节点增删、连线、双击添加、空状态提示
- `Header.tsx`：纯展示 + 项目名编辑 + 新建画布按钮
- `Sidebar.tsx`：节点类型列表 + 上传入口 + 设置入口
- `NodeMenu.tsx`：浮动弹出菜单，点击外部自动关闭
- `SettingsPanel.tsx`：模态框，API Key 配置、主题、快捷键展示
- `nodes/*.tsx`：各类型节点的渲染组件，通过 `React.memo` 包裹，接收 `{ data, selected }`

### 样式规则

- 业务样式优先使用 Tailwind class，禁止新增 `!important`、硬编码颜色值、内联 `style.cssText`
- 视觉状态优先通过 class 切换，不要用内联样式承载业务规则
- 复用 `tailwind.config.js` 中定义的 `canvas-*` 颜色 token：
  - `bg` (`#0a0a0f`)、`surface` (`#14141c`)、`card` (`#1a1a26`)、`border` (`#2a2a3a`)、`hover` (`#252535`)
  - 文本：`text` (`#e8e8ed`)、`text-secondary` (`#8888a0`)、`text-muted` (`#555566`)
- React Flow 样式覆盖统一放在 `src/index.css`
- 新增节点类型时，Header 区域使用对应语义色：文本=indigo、图像=green、视频=blue、音频=orange

### 类型定义

`src/types/index.ts` 是全局类型定义文件：

- `NodeType`：所有节点类型联合类型
- `BaseNodeData`：节点数据接口（label、type、prompt、output、status、imageUrl/videoUrl/audioUrl 等）
- `CanvasProject`：项目元数据
- `ApiProviderConfig` / `AppConfig`：API 配置
- 新增类型优先加到这里，禁止在组件文件中重复定义

### Tauri 规则

本项目使用 Tauri 2（Rust 后端），不是 Electron：

- Rust 后端代码在 `src-tauri/src/`：`main.rs` 是入口，`lib.rs` 是 Tauri Builder 装配
- Tauri 插件通过 `lib.rs` 注册：`tauri_plugin_fs`（文件系统）、`tauri_plugin_dialog`（原生对话框）
- 前端通过 `@tauri-apps/plugin-fs` 和 `@tauri-apps/plugin-dialog` 调用原生能力，封装在 `src/services/fileService.ts`
- `tauri.conf.json` 管理窗口大小、安全策略等配置
- 禁止为了跑通功能放松 Tauri 安全配置
- 涉及文件路径时，必须同时考虑开发环境与打包环境差异，禁止硬编码路径
- 新增原生能力优先通过 Tauri Plugin 体系，避免直接写系统调用

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

验证类检查点（自动执行，无需用户确认）：

- 每次文件修改后：检查是否引入 linter 错误
- 每次代码改动后：确认是否有既有功能受影响（搜索引用）
- 生成新文件前：确认同名文件是否已存在
- 提交代码前：确认 `git status` 无意外变更

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

## 后续平台化演进方向（暂未实施）

以下规则是参考设计，当前项目处于早期阶段，尚未实现 registry / manifest / schema / adapter / runtime 体系。当开始接入真实 AI 模型时，再按以下方向演进：

### 模型注册

接入新 AI 模型时，优先抽象为配置而非硬编码分支：

- 禁止在多处散落 `if (model === "xxx")` / `switch(provider)` 等硬编码判断
- 模型参数、UI 表单、请求映射应可配置化
- 前端通过 schema 自动渲染参数面板
- 后端通过 adapter 自动映射请求

### 厂商接入

- 新厂商 API 接入时，优先扩展 provider adapter，不优先往具体节点组件堆分支
- 特殊鉴权、上传、轮询、结果解析收口到对应 adapter
- 任务生命周期（提交、轮询、取消、恢复、保存结果）由统一 runtime 管理

### 工作流 / 模型 API 分层

RunningHub 工作流和厂商模型 API 是两类执行协议，禁止强行混用：

- 工作流走 workflow manifest + workflow adapter
- 厂商模型 API 走 model API manifest + provider adapter
- 上层统一：模型菜单、参数 UI、任务生命周期、结果回填
- 下层按 adapterType 分流

### 渐进迁移

不要为了产品化一次性重写全项目：
- 先搜索现有实现和可复用模块
- 新增配置入口
- 先迁移一个最简单用例验证
- 新功能优先走新体系
- 旧硬编码只允许作为短期迁移对象存在

## 禁止事项速查

- 禁止凭记忆新增路径、模块、函数、配置
- 禁止绕过 `fileService.ts` 直接在前端组件中调 `@tauri-apps/plugin-fs`
- 禁止放松 Tauri 安全配置
- 禁止新增非 UTF-8 文本文件
- 禁止在多个文件中散落同一 `modelId` / `provider` 硬编码分支
- 禁止修改 `node_modules/`、`src-tauri/target/` 等构建产物
- 禁止未经确认覆盖他人或用户已有的改动
- 禁止声称通过了未实际运行的命令

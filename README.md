# AI Canvas Tauri

<p align="center">
  <img src="public/icons.svg" alt="AI Canvas Tauri Icon" width="200" height="200" />
</p>

> 基于 **Tauri 2 + React 19 + React Flow 12** 的本地优先 AI 多模态画布与对话 Agent 桌面应用。

AI Canvas Tauri 将文本、图像、视频、音频、逐帧动画、Markdown、分镜和 360° 全景组织成可连接的画布节点。你可以在同一个项目中编排生成链路、管理本地素材与 ComfyUI 工作流，也可以通过对话助手查询或修改画布、生成媒体、读取授权文件并沉淀项目记忆。

![Version](https://img.shields.io/badge/version-0.5.6-6366f1)
![Tauri](https://img.shields.io/badge/Tauri-2-24c8db)
![React](https://img.shields.io/badge/React-19-61dafb)
![React Flow](https://img.shields.io/badge/React_Flow-12-ff0072)
![TypeScript](https://img.shields.io/badge/TypeScript-6-3178c6)
![License](https://img.shields.io/badge/license-source--available-f59e0b)

## 界面预览

![AI Canvas Tauri Screenshot](public/screenshot.jpg)

## 核心能力

| 能力 | 说明 |
| --- | --- |
| 多模态节点画布 | 文本、图像、视频、音频、逐帧动画、Markdown、分镜、全景和源文件节点统一连接与编排。 |
| 画布生产力 | React Flow 无限画布、小地图、网格、吸附参考线、多选对齐与分布、分组、复制粘贴、撤销重做。 |
| 多种生成后端 | 支持云端模型、自定义通用模型接口、ComfyUI 工作流、Dreamina 登录态调用和本地 ONNX 推理。 |
| 对话 Agent | 多会话、流式响应、B/C 两种执行模式、工具调用、审批卡片、任务时间线、上下文压缩和项目记忆。 |
| 本地优先存储 | 项目数据目录保存媒体文件，IndexedDB v13 持久化项目、配置、会话、Agent 任务、资产索引和项目记忆。 |
| 桌面原生能力 | Tauri 负责窗口、文件对话框、拖拽、剪贴板、文件传输、更新、本地模型和系统文件操作。 |
| 有限 Web 降级 | 可单独运行 Vite 前端；文件与持久化能力按浏览器环境降级，原生能力不可用时会受限。 |

## 功能概览

### 画布与节点

- 无限画布支持缩放、平移、小地图、网格背景、适应视图和多种交互模式。
- 节点支持拖拽、框选、多选、吸附、对齐、平均分布、分组、连线、复制、剪切、粘贴和删除。
- 画布结构变更接入历史快照，可撤销和重做；多节点写入按批次提交历史。
- 支持选中节点批量生成；存在连线依赖时按拓扑顺序执行，无依赖节点可并发执行。
- 系统剪贴板、文件拖放和资产面板可把图片、视频、音频与文本带入画布。

### AI 与媒体

- 文本节点支持流式生成、多轮内容、提示词预设、Skill、风格和 `@` 节点引用。
- 图像节点支持文生图、图生图、批量结果，以及裁剪、扩图、标注、抠图、自由视角和宫格编辑。
- 视频节点支持文生视频、图生视频、分辨率、帧率、时长和有声视频等模型参数。
- 音频节点支持音乐、语音生成、上传、播放和结果管理。
- 动画节点支持动作与帧数配置、Sprite Sheet 生成和预览。
- 分镜节点支持自定义宫格、单格覆盖、素材拖入和画格提取。
- 全景节点使用 Three.js 预览 360° 图像，并可将视角截图生成新图片节点。
- ComfyUI 工作流可从 JSON 导入，在工作流面板配置后由节点执行。
- 本地 ONNX Worker 提供图片超分、主体抠图和角色方向图等能力，避免阻塞 Tauri 主进程。

### 对话 Agent

对话助手既可以嵌入主窗口，也可以打开为独立窗口。每个会话归属于当前项目，并独立保存模式、消息、任务与上下文。

- **B 协作模式**：读取和查询自动执行，新增、更新、连接、分组或删除画布节点前需要确认。
- **C 自主模式**：画布写操作可自动执行，但仍必须校验项目和 canvas revision，并写入撤销历史。
- **固定审批边界**：文件写入、媒体生成和项目记忆写入在两种模式下都需要用户确认。
- **工具注册表**：画布查询与操作、媒体生成、会话级文件读取/导出、项目记忆均通过本地 schema 和 effect 校验。
- **媒体交付**：生成结果可以返回对话、加入画布，或同时交付到两端；付费媒体请求逐次确认。
- **任务控制**：时间线展示规划、工具、Observation、审批和回答步骤，支持暂停、继续、停止与重新规划。
- **后台与恢复**：切换会话后任务可继续运行；应用重启后未完成任务恢复为暂停状态，不会静默续跑。
- **上下文与记忆**：显示上下文占用并在预算触发时压缩；项目记忆只能由 Agent 提议并经用户确认后保存。

Agent 的本地 Policy Engine 不接受提示词、模型输出、Skill、网页或文件内容修改权限规则。文件授权只在当前运行时内保存，并绑定到具体会话；模型只接收 `grantId`、显示名和经过限制的内容，不接收授权路径。API Key 仅从本地 provider 配置读取，不写入消息或 Agent 操作日志。

### 项目、资产与桌面体验

- 多项目切换会同步恢复画布、工作流、对话、Agent 任务和项目记忆。
- 资产库支持项目资产索引、外部文件夹登记、独立搜索窗口、缩略图和拖回画布。
- 文件删除优先进入可恢复流程；长时间复制和下载支持进度与取消。
- 深色/浅色主题、多种画布背景、自定义标题栏、全局快捷键和桌面更新。
- Windows/macOS 文件定位与指定应用打开；浏览器模式下原生功能会明确降级。

## 技术栈

| 技术 | 用途 |
| --- | --- |
| [Tauri 2](https://tauri.app/) + Rust | 桌面壳、窗口、文件、更新、本地模型与系统能力 |
| [React 19](https://react.dev/) + TypeScript 6 | UI、领域类型和严格类型检查 |
| [React Flow 12](https://reactflow.dev/) | 节点画布、连线与视图控制 |
| [Zustand 5](https://zustand.docs.pmnd.rs/) | Slice 化全局状态管理 |
| [Tailwind CSS 3](https://tailwindcss.com/) | 组件样式与 `canvas-*` 设计 token |
| [Three.js](https://threejs.org/) | 360° 全景与图形渲染 |
| [Konva](https://konvajs.org/) | 图像标注与组合编辑器 |
| [Framer Motion](https://motion.dev/) / [GSAP](https://gsap.com/) | 界面与复杂动效 |
| [@iconify/react](https://iconify.design/) | 图标体系 |
| IndexedDB | 项目元数据、配置、会话、任务、记忆与资产索引 |

## 快速开始

### 环境要求

- Node.js：满足 Vite 8 的运行要求，建议使用当前 LTS
- npm
- Rust stable toolchain
- 对应平台的 [Tauri 系统依赖](https://v2.tauri.app/start/prerequisites/)

Windows 构建还需要 Visual Studio Build Tools 2022，并安装“使用 C++ 的桌面开发”工作负载。

### 安装依赖

```bash
npm install
```

### 启动开发环境

```bash
# 仅启动 Web 前端，默认访问 http://localhost:1420
npm run dev

# 启动完整 Tauri 桌面应用
npm run tauri dev
```

Web 模式适合前端界面开发，但原生对话框、会话级本地文件工具、系统窗口和部分文件能力不可用或会降级。

### 检查与构建

```bash
# TypeScript 类型检查
npm run typecheck

# ESLint 检查
npm run lint

# 前端生产构建
npm run build

# 桌面应用构建
npm run tauri build
```

版本发布时以 `package.json` 为版本源，运行 `npm run sync-version` 可同步 Rust 配置和 README 版本徽章。

## 项目结构

```text
AI-Canvas-tauri/
├── src/
│   ├── components/
│   │   ├── canvas/           # 画布工具栏、菜单、多选与分布交互
│   │   ├── chat/             # 多会话、Agent 时间线、审批、上下文与记忆 UI
│   │   ├── nodes/            # AI、源文件、动画、分镜、全景等节点
│   │   ├── settings/         # API、存储和桌面能力设置
│   │   └── shared/           # 跨模块通用组件
│   ├── hooks/                # 快捷键、自动保存、吸附、节点创建等交互 Hooks
│   ├── services/
│   │   ├── ai/               # 文本/图片/视频/音频生成与 Generation Runtime
│   │   ├── chat/             # Agent Runtime、Tool Registry、Policy、上下文与记忆
│   │   └── fs/               # 文件基础设施、资产库、索引、回收站与存储健康
│   ├── store/                # Zustand 聚合入口与业务 slices
│   ├── styles/               # 全局功能样式与 React Flow 覆盖
│   ├── types/                # 画布、AI、聊天、Agent、媒体和记忆类型
│   ├── utils/                # 批量执行、几何、动画与资源工具
│   ├── App.tsx               # 主窗口装配
│   └── main.tsx              # 主窗口/聊天窗口/资产窗口入口
├── src-tauri/
│   ├── src/
│   │   ├── lib.rs            # Tauri Builder、窗口和 command 注册
│   │   ├── file_transfer.rs  # 可取消文件传输
│   │   ├── comfyui/          # 本地 ComfyUI 启动能力
│   │   ├── dreamina.rs       # Dreamina 登录与生成运行时
│   │   └── onnx/             # ONNX Worker、下载和推理
│   ├── Cargo.toml
│   └── tauri.conf.json
├── doc/                      # 架构、开发、产品方案和发版文档
├── scripts/                  # Git Hook、版本同步等工程脚本
├── package.json
├── vite.config.ts
└── tailwind.config.js
```

## 核心模块

| 模块 | 说明 |
| --- | --- |
| `src/components/Canvas.tsx` | React Flow 集成边界，编排节点、连线和画布事件。 |
| `src/components/nodes/` | 节点渲染、节点交互和共享媒体编辑能力。 |
| `src/components/chat/ChatPanel.tsx` | 主窗口与独立窗口复用的对话容器。 |
| `src/services/ai/` | 多模态生成、流式协议、Provider 适配和统一媒体生成入口。 |
| `src/services/chat/agentRuntime.ts` | 多轮模型/工具循环、预算、审批等待和任务控制。 |
| `src/services/chat/toolRegistry.ts` | Agent 工具注册、可用性过滤和本地 schema 校验。 |
| `src/services/chat/policyEngine.ts` | B/C 模式与工具 effect 的固定权限矩阵。 |
| `src/store/useAppStore.ts` | Zustand 聚合入口，组合画布、项目、聊天、Agent、记忆和配置状态。 |
| `src/services/fileService.ts` | Tauri 文件能力与浏览器降级的统一前端入口。 |
| `src/services/indexedDbService.ts` | IndexedDB v13 schema、升级和领域 CRUD。 |
| `src-tauri/src/lib.rs` | Tauri 插件、窗口生命周期与原生 command 装配。 |

## 开发约束

- 共享状态通过 `useAppStore` 的 Store Action 修改，画布结构写入必须接入历史记录。
- 组件只负责展示和交互；Provider、Agent Policy、文件和持久化协议位于对应 Service。
- 新 Agent 工具通过 `registerAgentTool()` 注册，声明本地 schema 和准确的 effect。
- 文件能力统一经过 `fileService.ts` 或 `services/fs/`，不在组件中直接调用 Tauri fs 插件。
- 新模型优先扩展共享模型目录和 Provider adapter，避免在多个节点散落 provider/model 分支。
- 样式优先使用 Tailwind 与 `canvas-*` token；React Flow 覆盖集中在 `src/styles/reactflow.css`。

更完整的边界和实施记录以仓库内的 [AGENTS.md](AGENTS.md) 与下列文档为准。

## 项目文档

- [开发指南](doc/开发指南.md)
- [架构说明](doc/架构说明.md)
- [对话式画布助手功能方案](doc/对话式画布助手-功能方案.md)
- [对话助手 Agent 能力实施方案](doc/对话助手-Agent能力实施方案.md)
- [打包与发版流程](doc/打包与发版流程.md)

## License

本项目采用 **AI Canvas Tauri Source-Available License**，完整条款见 [LICENSE](LICENSE)。

允许学习、研究、内部使用、修改和集成使用。禁止未经授权的套壳销售、白标分发、源码转售、商业再分发及将本项目作为同类产品进行商业化。

本项目并非 OSI 定义下的开源项目。如需商业授权，请联系版权方。

## Contact

开发沟通 QQ 群：873354155

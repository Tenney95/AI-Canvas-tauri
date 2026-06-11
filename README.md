# AI Canvas - Tauri 2 + React Flow

基于 **React Flow** + **Tauri 2** 重构的 AI 多模态节点画布编辑器，参考 [AI-CanvasPro](https://github.com/ashuoAI/AI-CanvasPro) 项目。所有数据完全本地化存储——项目文件（`.aicanvas.json`）、上传的媒体资源、API 配置均保存在用户指定的本地目录中，无需依赖任何云服务。借助 Tauri 2 的原生文件系统能力，通过 `fileService.ts` 抽象层统一管理文件的读写、导入导出和画布截图，回退到纯浏览器模式时则自动切换至 IndexedDB 本地持久化，真正实现"一个项目一个文件夹"的自包含管理。除了支持云端 AI 厂商（OpenAI、DeepSeek、即梦等），还兼容本地部署的大模型和 ComfyUI 工作流：通过「通用模型」功能接入任意 OpenAI 兼容的本地大模型接口（如 Ollama、vLLM），通过工作流面板导入 ComfyUI JSON 即可直接在画布上调用本地 ComfyUI 引擎执行文生图、图生视频等任务，实现云端与本地 AI 能力的无缝切换。

## 技术栈

| 技术 | 用途 |
|------|------|
| [Tauri 2](https://tauri.app/) | 桌面应用框架 (Rust 后端) |
| [React 19](https://react.dev/) | UI 框架 |
| [React Flow](https://reactflow.dev/) | 节点画布引擎 |
| [Zustand](https://zustand.docs.pmnd.rs/) | 状态管理 |
| [Tailwind CSS](https://tailwindcss.com/) | 样式系统 |
| [@iconify/react](https://iconify.design/) ([Icônes.js](https://icones.js.org/)) | 图标库 |
| [TypeScript](https://www.typescriptlang.org/) | 类型安全 |
| framer-motion | 动画库 |
## 功能特性

### 核心功能
- **无限画布**: 自由缩放、平移，支持小地图导航和网格吸附
- **多种 AI 节点**:
  - **文本生成** - 多轮对话、流式输出
  - **图像生成** - 文生图/图生图
  - **视频生成** - 文生视频/图生视频
  - **音频生成** - TTS 文本转语音
- **节点连接**: 可视化连线组合 AI 能力
- **@ 引用语法**: 在提示词中引用其他节点的输出结果

### UI 特性
- 淗色主题设计（匹配原版风格）
- 左侧可折叠侧边栏 + 节点添加菜单
- 顶部项目名称编辑 + 多画布切换
- 设置面板（API Key 配置、快捷键）
- 底部控制栏（缩放、网格开关、适应画布）


## 项目结构

```
src/
├── components/
│   ├── canvas/                # 画布交互子组件
│   │   ├── CanvasContextMenu.tsx  # 画布右键菜单（添加节点/撤销/重做）
│   │   ├── CanvasEmptyState.tsx   # 画布空状态引导界面
│   │   ├── CanvasToolbar.tsx      # 右下角浮动工具条（网格/连线/缩放）
│   │   ├── ConnectionMenu.tsx     # 连线拖放目标选择菜单
│   │   └── NodeContextMenu.tsx    # 节点右键菜单（复制/剪切/副本/删除）
│   ├── nodes/                 # 画布节点组件
│   │   ├── shared/                # 节点共享子组件
│   │   │   ├── defaultModels.ts       # 预置模型配置（文本/图像/视频/音频）
│   │   │   ├── ImageNodeToolbar.tsx   # 图像节点浮动工具栏（遮罩/扩图/裁切等）
│   │   │   ├── MattingToolbar.tsx     # 遮罩编辑工具栏（画笔/橡皮擦/油漆桶）
│   │   │   ├── MentionEditor.tsx      # @提及编辑器（引用其他节点输出）
│   │   │   ├── ModelSelector.tsx      # 模型/工作流下拉选择器
│   │   │   ├── NodeLabel.tsx          # 节点标题栏（图标/颜色/编号）
│   │   │   ├── PromptPanel.tsx        # 提示词输入面板（模型/参数/生成）
│   │   │   ├── QualityRatioSelector.tsx # 图像质量/比例选择器
│   │   │   ├── TextNodeToolbar.tsx    # 文本节点浮动工具栏
│   │   │   └── VideoParamSelector.tsx # 视频参数选择器
│   │   ├── AINodeDialog.tsx       # AI 生成弹窗（Prompt + 模型 + 生成按钮）
│   │   ├── AudioNode.tsx          # 音频节点（上传/波形可视化）
│   │   ├── ImageNode.tsx          # 图像节点（上传/遮罩/工具栏/全屏）
│   │   ├── TextNode.tsx           # 文本节点（编辑/复制/调整大小）
│   │   └── VideoNode.tsx          # 视频节点（上传/播放）
│   ├── Header.tsx           # 顶部栏（Logo、项目名、侧边栏/设置入口）
│   ├── Sidebar.tsx          # 左侧面板（节点列表、上传、项目切换）
│   ├── NodeMenu.tsx         # 浮动节点添加菜单
│   ├── SettingsPanel.tsx    # 设置弹窗（API Key 配置、连接测试）
│   ├── Titlebar.tsx         # 自定义窗口标题栏（最小化/最大化/关闭）
│   ├── Toast.tsx            # 全局消息提示（成功/错误）
│   ├── WorkflowPanel.tsx    # 工作流管理面板（导入 JSON/分类筛选）
│   └── Canvas.tsx           # React Flow 画布主区域
├── hooks/                   # 自定义 React Hooks
│   ├── useCanvasContextMenu.ts   # 画布右键菜单逻辑
│   ├── useConnectionDropMenu.ts  # 连线拖放创建节点逻辑
│   ├── useKeyboardShortcuts.ts   # 全局键盘快捷键
│   ├── useNodeContextMenu.ts     # 节点右键菜单逻辑
│   └── useNodeSnap.ts            # 节点拖拽吸附对齐
├── services/                # 服务层
│   ├── aiService.ts         # AI 生成 API 封装（多厂商/工作流）
│   ├── fileService.ts       # 文件操作（Tauri + IndexedDB 双通道）
│   ├── indexedDbService.ts  # IndexedDB 本地持久化
│   └── testConnection.ts    # API 密钥连接测试服务
├── store/
│   └── useAppStore.ts       # Zustand 全局状态（节点/边/项目/配置/撤销历史）
├── types/
│   └── index.ts             # 核心类型定义
├── App.tsx                  # 根组件装配
├── main.tsx                 # 应用入口
└── index.css                # 全局样式 + Tailwind + React Flow 覆写
```

## 开发指南

### 前置要求
- Node.js >= 18
- Rust (用于 Tauri 编译)
- npm 或 pnpm

### 安装依赖
```bash
npm install
```

### 启动开发模式
```bash
# 仅前端开发（不需要 Rust）
npm run dev

# 完整 Tauri 应用（需要 Rust 工具链）
npm run tauri dev
```

### 构建生产版本
```bash
npm run build          # 构建 Web 前端
npm run tauri build    # 构建桌面应用
```

## 与原版的差异

本项目是对 [AI-CanvasPro](https://github.com/ashuoAI/AI-CanvasPro) 的重新实现：

| 方面 | 原版 | 本实现 |
|------|------|--------|
| 框架 | 原生 JS + Python 后端 | React + Tauri (Rust) |
| 画布引擎 | 自定义 Canvas 实现 | React Flow |
| 状态管理 | 手动 store | Zustand |
| 类型安全 | 无 | TypeScript 全面覆盖 |
| 包体积 | 较大 | Tauri 极致轻量 (~3MB) |
| API 集成 | Python Flask 服务端 | 可直接调用 API 或通过 Tauri Command |

## License

MIT License - 本项目仅作学习研究用途。

# AI Canvas - Tauri 2 + React Flow

基于 **React Flow** + **Tauri 2** 重构的 AI 多模态节点画布编辑器，仿照 [AI-CanvasPro](https://github.com/ashuoAI/AI-CanvasPro) 项目。

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

### 快捷键
| 快捷键 | 功能 |
|--------|------|
| `Ctrl+S` | 保存项目 |
| `Ctrl+Z` | 撤销 |
| `Ctrl+Shift+Z` | 重做 |
| `Delete / D` | 删除选中节点 |
| `双击画布` | 添加文本节点 |
| `F` | 适应画布 |

## 项目结构

```
src/
├── components/
│   ├── nodes/           # 自定义节点组件
│   │   ├── TextNode.tsx    # 文本生成节点
│   │   ├── ImageNode.tsx   # 图像生成节点
│   │   ├── VideoNode.tsx   # 视频生成节点
│   │   ├── AudioNode.tsx   # 音频生成节点
│   │   └── MentionInput.tsx # @引用输入组件
│   ├── Header.tsx       # 顶栏（Logo、项目名、标签页）
│   ├── Sidebar.tsx      # 左侧边栏（节点类型列表）
│   ├── NodeMenu.tsx     # 浮动节点添加菜单
│   ├── SettingsPanel.tsx # 设置弹窗
│   └── Canvas.tsx       # ReactFlow 画布主区域
├── store/
│   └── useAppStore.ts   # Zustand 全局状态管理
├── hooks/
│   └── useKeyboardShortcuts.ts # 全局快捷键
├── services/
│   └── fileService.ts   # Tauri 文件操作服务
├── types/
│   └── index.ts         # TypeScript 类型定义
├── App.tsx              # 主应用组件
├── main.tsx             # 入口文件
└── index.css            # 全局样式 + ReactFlow 覆写
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

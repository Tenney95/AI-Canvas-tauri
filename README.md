# AI Canvas Tauri

**简体中文** · [English](README.en.md) · [日本語](README.ja.md) · [한국어](README.ko.md)

<p align="center">
  <img src="public/icons.svg" alt="AI Canvas Tauri Icon" width="140" height="140" />
</p>

> 基于 **Tauri 2 + React 19 + React Flow 12** 的本地优先 AI 多模态画布与对话 Agent 桌面应用。

AI Canvas Tauri 将文本、图像、视频、音频、逐帧动画、Markdown、分镜、360° 全景和手绘笔记组织成可连接的画布节点。你可以在同一个项目中编排生成链路、管理角色库与本地素材、执行 ComfyUI 工作流，也可以通过对话助手查询或修改画布、生成媒体、派出只读子智能体、读取授权文件并沉淀项目记忆。项目还能拆成剧集与分集，一部短剧的每一集各占一张画布，角色库与素材整部剧共用。

![Version](https://img.shields.io/badge/version-0.8.15-6366f1)
![Tauri](https://img.shields.io/badge/Tauri-2-24c8db)
![React](https://img.shields.io/badge/React-19-61dafb)
![React Flow](https://img.shields.io/badge/React_Flow-12-ff0072)
![TypeScript](https://img.shields.io/badge/TypeScript-6-3178c6)
![License](https://img.shields.io/badge/license-source--available-f59e0b)

**在线体验：** <https://tenney95.github.io/AI-Canvas-tauri/>（首屏可直接试用，内置演示画布）

**下载：** <https://github.com/tenney95/AI-Canvas-tauri/releases>（获取桌面安装包）

[在线体验](https://tenney95.github.io/AI-Canvas-tauri/) · [下载](https://github.com/tenney95/AI-Canvas-tauri/releases) · [核心能力](#核心能力) · [快速开始](#快速开始) · [项目文档](#项目文档) · [License](#license)

> 在线版适合体验画布与界面。文件系统、凭据存储、独立窗口、3D 导演台、本地模型等能力依赖 Tauri 桌面环境；完整体验请按下方步骤启动桌面应用。

## 界面预览

![AI Canvas Tauri Screenshot](public/screenshot.png)

## 核心能力

| 能力 | 说明 |
| --- | --- |
| 多模态节点画布 | 文本、图像、视频、音频、逐帧动画、Markdown、分镜、全景、3D 导演台、源文件和画布笔记节点统一连接与编排。 |
| AI 与工作流 | 支持云端模型、自定义模型执行协议、ComfyUI 工作流、Dreamina 登录态调用和本地 ONNX 推理。 |
| 内置视频剪辑 | 视频节点可在独立编辑器中进行多轨编排、裁剪与分割、画面变换、转场、文字与贴纸、音量调整，并无损直通或合成导出到本地及新节点。 |
| 对话 Agent | 多会话、流式响应、Plan/B/C 三种执行模式、工具调用、审批卡片、任务时间线、上下文压缩和项目记忆。 |
| 只读子智能体 | 用户可在助手内自定义领域角色，主任务按需派出并行只读子智能体，产出脱敏后回传。 |
| 角色库与短剧资产 | 全局与项目级角色卡、多参考图、声音绑定与配音出口，以及短剧人物、场景和道具资产。 |
| 本地 MCP 控制桥 | 手动开启的会话级 stdio MCP 适配器，让外部客户端复用同一套工具、Policy、审批和任务时间线。 |
| 本地优先与安全 | 媒体保存在项目数据目录，结构化数据由 IndexedDB 持久化；API Key 由 Rust 凭据存储隔离保管。 |
| 剧集与分集 | 项目可拆成剧集与分集，每集独占一张画布，共用角色库、项目记忆与素材目录；助手可读完剧本后批量建集。 |
| 项目与资产 | 支持多项目、资产库、可恢复删除和 `.aicanvas` 项目整体导入导出。 |
| 新手引导与帮助中心 | 首次启动弹出引导，集中说明悬停提示与空格开对话框、长按批量出图等隐藏操作；帮助中心按场景分类，并用真实 @ 芯片演示 ComfyUI 输入节点的写入过程。 |
| 按需 3D 导演台 | 首次创建导演台节点时下载固定且经过校验的运行资源，并在 Tauri 独立窗口中完成场景摆位、机位预演和截图回传。 |

更详细的功能说明与阶段进度见[功能方案](doc/对话式画布助手-功能方案.md)和[Agent 能力实施方案](doc/对话助手-Agent能力实施方案.md)。

## 技术栈

| 技术 | 用途 |
| --- | --- |
| [Tauri 2](https://tauri.app/) + Rust | 桌面壳、窗口、文件、更新、本地模型与系统能力 |
| [React 19](https://react.dev/) + TypeScript 6 | UI、领域类型和严格类型检查 |
| [React Flow 12](https://reactflow.dev/) | 节点画布、连线与视图控制 |
| [Zustand 5](https://zustand.docs.pmnd.rs/) | Slice 化全局状态管理 |
| [Tailwind CSS 3](https://tailwindcss.com/) | 组件样式与 `canvas-*` 设计 token |
| [Vitest](https://vitest.dev/) | 自动化测试 |
| IndexedDB | 本地结构化数据持久化 |

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

Web 模式适合界面开发；原生对话框、本地文件工具、独立窗口、本地模型和 3D 导演台等能力需要 Tauri 桌面环境。

### 检查与构建

```bash
# TypeScript 类型检查
npm run typecheck

# ESLint 检查
npm run lint

# 单元测试（Vitest）
npm run test

# lint + 类型检查 + 测试
npm run check

# 前端生产构建
npm run build

# 桌面应用构建
npm run tauri build
```

版本发布时以 `package.json` 为版本源，运行 `npm run sync-version` 可同步 Rust 配置和 README 版本徽章。

## 项目文档

- [开发指南](doc/开发指南.md)：环境、命令、目录、开发约定、调试和常见问题
- [架构说明](doc/架构说明.md)：核心模块、数据流、安全边界和性能设计
- [ComfyUI 工作流集成说明](doc/ComfyUI工作流集成说明.md)：导入、IO 节点识别、内容与参数注入、结果取回
- [对话式画布助手功能方案](doc/对话式画布助手-功能方案.md)
- [对话助手 Agent 能力实施方案](doc/对话助手-Agent能力实施方案.md)
- [打包与发版流程](doc/打包与发版流程.md)

长期工程边界以仓库内的 [AGENTS.md](AGENTS.md) 为准，架构决策记录位于 [`doc/adr/`](doc/adr/)。

## License

本项目采用 **AI Canvas Tauri Source-Available License**，完整条款见 [LICENSE](LICENSE)。

允许学习、研究、内部使用、修改和集成使用。禁止未经授权的套壳销售、白标分发、源码转售、商业再分发及将本项目作为同类产品进行商业化。

本项目并非 OSI 定义下的开源项目。如需商业授权，请联系版权方。

### 第三方素材

画布笔记的工具条与属性面板视觉设计参考自 [Excalidraw](https://github.com/excalidraw/excalidraw)，其许可证见 [doc/licenses/excalidraw-MIT.txt](doc/licenses/excalidraw-MIT.txt)。

## Contact

开发沟通 QQ 群：873354155

## 联合开发者

<p>
  <a href="https://github.com/zhurui0523" title="zhurui0523"><img src="https://images.weserv.nl/?url=github.com/zhurui0523.png&amp;w=128&amp;h=128&amp;fit=cover&amp;mask=circle" width="64" height="64" alt="zhurui0523" /></a>
  <a href="https://github.com/stars-one" title="stars-one"><img src="https://images.weserv.nl/?url=github.com/stars-one.png&amp;w=128&amp;h=128&amp;fit=cover&amp;mask=circle" width="64" height="64" alt="stars-one" /></a>
  <a href="https://github.com/luckcatlin2000" title="luckcatlin2000"><img src="https://images.weserv.nl/?url=github.com/luckcatlin2000.png&amp;w=128&amp;h=128&amp;fit=cover&amp;mask=circle" width="64" height="64" alt="luckcatlin2000" /></a>
  <a href="https://github.com/xiaozangao" title="xiaozangao"><img src="https://images.weserv.nl/?url=github.com/xiaozangao.png&amp;w=128&amp;h=128&amp;fit=cover&amp;mask=circle" width="64" height="64" alt="xiaozangao" /></a>
  <a href="https://github.com/orlova851986-debug" title="orlova851986-debug"><img src="https://images.weserv.nl/?url=github.com/orlova851986-debug.png&amp;w=128&amp;h=128&amp;fit=cover&amp;mask=circle" width="64" height="64" alt="orlova851986-debug" /></a>
</p>

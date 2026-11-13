# AI Canvas Tauri — AI 画布、AI短剧与AI资产管理

![AI Canvas Tauri — 从创意、分镜到视频的本地优先创作画布](doc/images/github-social-preview.jpg)

**把创意、角色、分镜和视频放在同一张画布里，连接 ComfyUI、AI Agent 与 MCP 完成创作。**

[![GitHub Stars](https://img.shields.io/github/stars/Tenney95/AI-Canvas-tauri?style=flat&label=Star%20on%20GitHub)](https://github.com/Tenney95/AI-Canvas-tauri/stargazers)

**[在线体验](https://tenney95.github.io/AI-Canvas-tauri/) · [下载桌面版](https://github.com/Tenney95/AI-Canvas-tauri/releases) · [分享作品与交流](https://github.com/Tenney95/AI-Canvas-tauri/discussions)**

> ⭐ **开源计划：** 当本项目的 GitHub Stars 达到 **10,000（10k）** 时，项目自有代码将转用 **[MIT License（MIT 许可证）](https://opensource.org/license/mit)**，允许自由使用、修改、分发和商用，须保留版权声明和许可文本。在此之前，仍以 [LICENSE](LICENSE) 中的当前许可条款为准。

**简体中文** · [English](README.en.md) · [日本語](README.ja.md) · [한국어](README.ko.md)

> 面向 **AI短剧创作、AI资产管理、图像/视频生成与分镜制作** 的本地优先 AI 多模态画布与可视化工作流桌面应用，集成 **ComfyUI、对话 AI Agent 与 MCP**，基于 **Tauri 2 + React 19 + React Flow 12** 构建。

AI Canvas Tauri 将文本、图像、视频、音频、逐帧动画、Markdown、分镜、360° 全景和手绘笔记组织成可连接的画布节点。你可以在同一个项目中编排生成链路、统一管理角色库、人物/场景/道具与本地素材、执行 ComfyUI 工作流、安装 JavaScript 或可信 Python 用户插件，也可以通过对话助手查询或修改画布、生成媒体、派出只读子智能体、读取授权文件并沉淀项目记忆。项目还能拆成剧集与分集，一部 AI短剧的每一集各占一张画布，角色库与素材整部剧共用。

**0.11.3 · 助手窗口与常用 Skill：** 独立助手关闭或收回时等待草稿交接与窗口真正关闭，失败保留草稿并恢复编辑；节点 `/` 一级菜单显示最近使用的 5 个可用 Skill，包含上传项与已启用智能体包，助手选择也更新这份近期记录。另含分组开合自动让位、新项目废弃原件扫描、七角色团队及 Seedream 5.0 Flash 适配，修复素材预览与部分 macOS 文件处理。旧项目保持原样，正式迁移继续关闭；新结构沿用 v4 项目包，兼容旧 v1–v3 包。含输出历史的 v4 包需 0.11.0 或支持该字段的客户端，早期 v4 客户端可能拒绝。安装包与验收范围见 [发布说明](.release-notes.md)。

![Version](https://img.shields.io/badge/version-0.11.4-6366f1)
![Tauri](https://img.shields.io/badge/Tauri-2-24c8db)
![React](https://img.shields.io/badge/React-19-61dafb)
![React Flow](https://img.shields.io/badge/React_Flow-12-ff0072)
![TypeScript](https://img.shields.io/badge/TypeScript-6-3178c6)
![License](https://img.shields.io/badge/license-source--available-f59e0b)

**在线体验：** <https://tenney95.github.io/AI-Canvas-tauri/>（首屏可直接试用，内置演示画布）

**下载：** <https://github.com/tenney95/AI-Canvas-tauri/releases>（获取桌面安装包）

[在线体验](https://tenney95.github.io/AI-Canvas-tauri/) · [下载](https://github.com/tenney95/AI-Canvas-tauri/releases) · [赞助支持](#赞助支持) · [核心能力](#核心能力) · [快速开始](#快速开始) · [项目文档](#项目文档) · [License](#license)

> 在线版适合体验画布与界面。用户插件、文件系统、凭据存储、独立窗口、3D 导演台、本地模型等能力依赖 Tauri 桌面环境；完整体验请按下方步骤启动桌面应用。

## 界面预览

![AI Canvas Tauri Screenshot](public/screenshot.png)

### 资源库

统一浏览项目文件与全局资产，按类型、文件夹和标签筛选素材。

![资源库：全局资产、文件夹与标签筛选](doc/images/asset-library.jpg)

### 资产详情与提示词

全屏预览图片，查看与编辑提示词、参考图和标签，并查看图片尺寸、文件大小与来源。

![资产详情：图片预览、提示词、标签与文件信息](doc/images/asset-preview.jpg)

### 帧动画编辑

逐帧预览与编辑动画，调整帧顺序、偏移、播放帧率和角色对齐。

![帧动画编辑：逐帧预览、偏移调整与角色对齐](doc/images/animation-editor.jpg)

## 赞助支持

<table>
  <tr>
    <td align="center" width="140">
      <a href="https://www.runninghub.ai/call-api?source=github"><img src="doc/images/sponsors/runninghub-logo.png" alt="RunningHub API" width="80" height="80"></a><br>
      <a href="https://www.runninghub.ai/call-api?source=github"><strong>RunningHub API</strong></a>
    </td>
    <td>
      <strong>感谢 <a href="https://www.runninghub.ai/call-api?source=github">RunningHub API</a> 支持本项目！</strong>
      <ul>
        <li><strong>400+ 主流模型、8000+ 版本</strong>，覆盖 Seedance、Kling、MiniMax、Nano Banana、Veo 等，并支持国际版模型访问。</li>
        <li><strong>高并发、按量付费</strong>，随用随充；Seedance 在线工具低至 <strong>0.21 元/秒</strong>。</li>
        <li><strong>从剧本到成片</strong>：无限画布、ComfyUI 与 Agent 等在线工具协同完成创作。</li>
        <li><strong>统一 API 接入</strong>：LLM、多模态、工作流 API 与 AI 应用。</li>
      </ul>
      <a href="https://www.runninghub.ai/call-api?source=github">查看模型与 API</a> · 折扣与免费测试请联系 <a href="mailto:zhenyuedong@haima.me">zhenyuedong@haima.me</a>。<br>
      <sub>模型、版本、价格、优惠及可用权限以 RunningHub 官方页面和实际开通情况为准。</sub>
    </td>
  </tr>
</table>

## 核心能力

| 能力 | 说明 |
| --- | --- |
| 多模态节点画布 | 用可连接的节点组织文本、图像、视频、音频、动画、Markdown、分镜、全景、3D 导演台与画布笔记。 |
| 分组开合让位 | 双击分组头部收起、双击文件夹展开；同排右侧内容随开合自动让位，保留原间距与手动移动。 |
| 帧动画编辑与导出 | 导入或生成 Sprite Sheet，编辑动画帧与播放效果，导出 GIF、PNG 序列帧或图集。 |
| AI 与工作流 | 连接云端与自定义模型、CCC、LibAPI 的文本/图片/视频/音频模型、ComfyUI 多服务器、RunningHub、通用工作流 API、Dreamina 和本地 ONNX 模型。 |
| 工作流参数配置 | 本地 ComfyUI 与 RunningHub 共用参数浮层，按真实声明提供比例、分辨率、步数、调度器等设置；标记 `C#` 节点编号和提示词用途，默认正文与参考素材沿用节点输入框。 |
| 云工作流输入引用 | 选择 RunningHub 工作流或 AI 应用后，输入 `@` 可在 ComfyUI 标签按类型、名称或原节点编号选择定向输入；RefMod 角色目录仍仅限本地 ComfyUI。 |
| 工作流种子与下载恢复 | 工作流数字种子支持随机或固定；新建空节点沿用最近工作流与尺寸。输出历史可重新下载原任务结果，Windows 多层素材路径与项目导出错误定位同步修复。 |
| 快捷指令编排与分享 | 高级步骤可参考原始输入或上一步结果，按顺序或依赖并发执行；复制、导出或导入 JSON 创建独立指令副本。 |
| 视频参数保持 | 切换视频型号保留已有比例和兼容的分辨率、帧率、时长及音轨设置，生成前按所选模型核对。 |
| 用户插件 | 通过本地文件、市场或 GitHub Release 安装插件，扩展工具、节点与界面。支持受限运行的 JavaScript 和拥有当前用户权限的可信 Python 插件。 |
| 剧本与原文写作 | 在主窗口或独立工作台编写大纲、分集剧本和原文，右侧工具随页签切换；原文使用普通文本编辑，支持 AI 起笔、续写和润色，候选采用后手动保存。原文与分集剧本以 TXT 保存到项目 `manuscripts` 目录。 |
| 故事关系图 | 在工作台整理人物、事件、伏笔及关系，切换关系图、时间线和列表，保留原文证据；AI 提取先预览，确认后再入图。 |
| 内置视频剪辑 | 在独立编辑器中完成多轨编排、裁剪、转场、字幕、贴纸与音量编辑，支持视频导出和 MCP 控制。 |
| 对话 Agent 与创作协作 | 助手与剧本工作台可按需求调度已授权智能体和 Skill，支持多模型团队、候选成果审阅和应用。工作台顶部「Agent协作」统一配置执行方式、成员、模型与任务权限，沿用 Plan/B/C 模式、项目记忆和只读子智能体边界。 |
| 助手窗口与常用 Skill | 独立窗口交接会话草稿，关闭失败恢复编辑；节点 `/` 一级菜单提供最近 5 个可用的上传或包内 Skill，主／独立助手选择也更新共享近期记录。选择后加入输入，不自动生成。 |
| AI 应用节点 | 由 Agent 或 MCP 创建交互应用，仅访问绑定的画布素材，可执行只读操作并保存结果。 |
| 项目资产云同步 | 通过 S3 兼容存储连接共享项目，预览并手动同步项目媒体、人物、场景和道具及关联资料；支持仅云端的清空与删除，本地资产保留。全局资产和自动同步暂不纳入。 |
| 万象 API 分组 | 按分组管理独立连接与密钥，选择已适配的文本、图片和视频模型。 |
| 角色与创作资产 | 管理项目与全局人物、场景、道具和武器；角色可绑定声音、动作与多把同库武器，资产包、复制和项目云同步保留武器关联。场景与道具支持多参考图及单图精准引用。 |
| MCP 外部控制 | 让外部 AI 工具通过本机 stdio 或 Streamable HTTP 控制画布、媒体和剪辑项目。默认关闭，远程连接需确认启用。 |
| 本地存储 | 在本地保存项目与媒体，使用独立的凭据存储管理 API Key；存储健康区分文件占用与应用数据配额，可检查新旧项目的未引用普通原件，清理前确认并复核引用；新项目不可变媒体、导入区与未完成操作涉及的范围继续保护。 |
| 图片无损压缩 | 图片节点支持 PNG / JPEG 无损压缩，仅在体积变小时创建独立副本，保留原图。 |
| 剧集与分集 | 每集使用独立画布，整部剧共享角色库、项目记忆与素材；本集角色／道具可 AI 提取到清单，确认后再添加或绑定资产库，不直接自动入库。 |
| 资产库与资源编辑 | 统一预览与编辑素材、提示词和标签，支持图片批量反推与文本/Markdown 编辑；创作资产支持多选、跨项目复制、资产包导入导出、使用位置查询、失效素材重连及不可撤销的失效记录清理；清理保留磁盘文件。 |
| 多语言界面 | 提供简体中文、English、日本語和한국어，切换界面语言时保留用户内容与编辑草稿。 |
| 3D 导演台 | 提供轻量导演台、Blender 高级编辑与 AI 镜头预演，用于构建场景、预演镜头和输出视频。 |
| 外观自定义 | 通过外观预设统一页面、画布、节点与连线，支持自定义主题及预设导入导出。 |
| 视频批次与用量统计 | 批量管理视频生成任务，记录火山方舟图片/视频节点的本地用量并导出报表；用量估算不等于官方账单。 |

功能以对应版本的桌面安装包为准。详细操作见[操作说明书](site/manual.html)，开发与集成资料见[文档导航](doc/文档导航.md)。

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
- Blender 高级编辑（可选）：Windows x86_64 或 macOS Intel/Apple Silicon，4.5 / 5.0 / 5.1 / 5.2 稳定系列；轻量导演台不依赖 Blender。
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

Web 模式适合界面开发；用户插件、原生对话框、本地文件工具、独立窗口、本地模型和 3D 导演台等能力需要 Tauri 桌面环境。

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

## 项目文档

- [操作说明书](site/manual.html)
- [模块文档导航](doc/文档导航.md)
- [开发指南](doc/开发指南.md)：环境、命令、目录、开发约定、调试和常见问题
- [架构说明](doc/架构说明.md)：核心模块、数据流、安全边界和性能设计
- [插件开发规范](doc/插件开发规范.md)：Manifest、JavaScript/Python 运行时、自定义节点、权限、安全边界、安装更新与发布规范
- [开源插件开发示例：逐帧拉片](https://github.com/luckcatlin2000/ai-canvas-video-frame-review-plugin)：参考自定义界面、授权视频抽帧、模型分析、线稿转换与分镜节点输出；插件需用户单独安装。
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

## 代码贡献

<p>
  <a href="https://github.com/zhurui0523" title="zhurui0523"><img src="https://images.weserv.nl/?url=github.com/zhurui0523.png&amp;w=128&amp;h=128&amp;fit=cover&amp;mask=circle" width="64" height="64" alt="zhurui0523" /></a>
  <a href="https://github.com/stars-one" title="stars-one"><img src="https://images.weserv.nl/?url=github.com/stars-one.png&amp;w=128&amp;h=128&amp;fit=cover&amp;mask=circle" width="64" height="64" alt="stars-one" /></a>
  <a href="https://github.com/luckcatlin2000" title="luckcatlin2000"><img src="https://images.weserv.nl/?url=github.com/luckcatlin2000.png&amp;w=128&amp;h=128&amp;fit=cover&amp;mask=circle" width="64" height="64" alt="luckcatlin2000" /></a>
  <a href="https://github.com/orlova851986-debug" title="orlova851986-debug"><img src="https://images.weserv.nl/?url=github.com/orlova851986-debug.png&amp;w=128&amp;h=128&amp;fit=cover&amp;mask=circle" width="64" height="64" alt="orlova851986-debug" /></a>
  <a href="https://github.com/Lazzz-y" title="Lazzz-y"><img src="https://images.weserv.nl/?url=github.com/Lazzz-y.png&amp;w=128&amp;h=128&amp;fit=cover&amp;mask=circle" width="64" height="64" alt="Lazzz-y" /></a>
  <a href="https://github.com/xiaozangao" title="xiaozangao"><img src="https://images.weserv.nl/?url=github.com/xiaozangao.png&amp;w=128&amp;h=128&amp;fit=cover&amp;mask=circle" width="64" height="64" alt="xiaozangao" /></a>
</p>

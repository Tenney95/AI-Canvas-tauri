# AI Canvas Tauri

[简体中文](README.md) · **English** · [日本語](README.ja.md) · [한국어](README.ko.md)

<p align="center">
  <img src="public/icons.svg" alt="AI Canvas Tauri Icon" width="140" height="140" />
</p>

> A local-first AI multimodal canvas and conversational Agent desktop application built on **Tauri 2 + React 19 + React Flow 12**.

AI Canvas Tauri organizes text, images, video, audio, frame-by-frame animation, Markdown, shot lists, 360° panoramas and hand-drawn notes into connectable canvas nodes. In a single project you can orchestrate generation pipelines, manage a character library and local assets, run ComfyUI workflows, and use the conversational assistant to query or modify the canvas, generate media, dispatch read-only sub-agents, read authorized files, and accumulate project memory. Projects can also be split into series and episodes — each episode of a short drama gets its own canvas, while the character library and assets are shared across the whole series.

![Version](https://img.shields.io/badge/version-0.9.7-6366f1)
![Tauri](https://img.shields.io/badge/Tauri-2-24c8db)
![React](https://img.shields.io/badge/React-19-61dafb)
![React Flow](https://img.shields.io/badge/React_Flow-12-ff0072)
![TypeScript](https://img.shields.io/badge/TypeScript-6-3178c6)
![License](https://img.shields.io/badge/license-source--available-f59e0b)

**Live demo:** <https://tenney95.github.io/AI-Canvas-tauri/> (try it right on the landing page, with a built-in demo canvas)

**Download:** <https://github.com/tenney95/AI-Canvas-tauri/releases> (desktop installers)

[Live demo](https://tenney95.github.io/AI-Canvas-tauri/) · [Download](https://github.com/tenney95/AI-Canvas-tauri/releases) · [Capabilities](#capabilities) · [Getting Started](#getting-started) · [Documentation](#documentation) · [License](#license)

> The web version is ideal for exploring the canvas and interface. File system, credential storage, separate windows, the 3D director desk and local models depend on the Tauri desktop environment; for the full experience, launch the desktop app using the steps below.

## Preview

![AI Canvas Tauri Screenshot](public/screenshot.png)

## Capabilities

| Capability | Description |
| --- | --- |
| Multimodal node canvas | Connect text, images, video, audio, animation, Markdown, shot lists, panoramas, director nodes, source files and canvas notes. Minimap counts, lightweight overview nodes and progressive display improve navigation while preserving source media and canvas data. |
| AI & workflows | Cloud models, custom model protocols, multiple ComfyUI servers, RunningHub cloud workflows/AI apps, generic Workflow API connections with an AutoDL H3 template, Dreamina and local ONNX inference. Parameters, uploads, progress and recovery follow each platform. |
| User plugins | Install JavaScript or trusted Python plugins from local folders, the marketplace or GitHub Releases. Plugins extend tools, nodes and host-managed UI. JavaScript uses QuickJS; Python has the current user’s permissions. Source and full revision digests bind execution; disabled or replaced revisions cannot write results back. |
| Scripts & shot production | Browse source chapters, write episodes, preserve script snapshots, revise shots, fill missing frames, prepare voice/video/director nodes and send dialogue captions and ready voice-overs to the timeline. Reference character action media with @. |
| Built-in video editing | A separate editor provides multiple tracks, trimming, splitting, transforms, transitions, text, stickers and volume controls, with passthrough or composited export. MCP also exposes project editing, background export, media probing and frame extraction. |
| Conversational Agent | Multiple conversations, streaming, Plan/B/C modes, tools, approval cards, task timelines, context compression and project memory. |
| Read-only sub-agents | Define domain roles and let the main task dispatch parallel read-only sub-agents; sanitized results return to the main task. |
| Characters & creative assets | Project/global character cards, reference images, voices and action media, plus extraction, descriptions and image binding for characters, scenes and props. |
| External MCP control | Disabled by default. Supports local stdio and Streamable HTTP with an additional configuration confirmation; on-demand tool discovery is the default. Import media, upload images in chunks, paste system content, capture the canvas and control editing projects. MCP runs autonomously, while user-choice questions still require the user. |
| Local storage & protected settings | Media is stored in project directories, structured data in IndexedDB, and API keys in the Rust credential store. Settings save changed fields with conflict checks; failures preserve drafts and offer retry/reload. Exit waits for saving. |
| Series & episodes | Each episode has its own canvas; the series shares characters, project memory and media directories. The assistant can create episodes in batches from a script. |
| Asset library & previews | Tab toggles the left asset drawer with project files, global assets, creative assets and the current node list. Locate and connect nodes from cards, browse full-screen images by display number, play floating video previews and pin output history. Includes recoverable deletion and desktop .aicanvas project packages. |
| Onboarding & help | First-run guidance, a scenario-based Help Center and an offline manual covering references, ComfyUI inputs, shortcuts and custom APIs. |
| Dual-runtime director desk | The lightweight desk installs its runtime on demand. Blender editing supports Windows x86_64 and macOS Intel/Apple Silicon with stable 4.5, 5.0, 5.1 and 5.2 series. Save-and-return validates both the camera PNG and the .blend project. |

These documents cover 0.9.7 and subsequent source updates through 2026-09-11. Released installers may not include later features. See the [user manual](site/manual.html) and [module index](doc/文档导航.md) (in Chinese) for operations, ownership and validation boundaries.

## Tech Stack

| Technology | Purpose |
| --- | --- |
| [Tauri 2](https://tauri.app/) + Rust | Desktop shell, windows, files, updates, local models and system capabilities |
| [React 19](https://react.dev/) + TypeScript 6 | UI, domain types and strict type checking |
| [React Flow 12](https://reactflow.dev/) | Node canvas, connections and view controls |
| [Zustand 5](https://zustand.docs.pmnd.rs/) | Slice-based global state management |
| [Tailwind CSS 3](https://tailwindcss.com/) | Component styling and `canvas-*` design tokens |
| [Vitest](https://vitest.dev/) | Automated testing |
| IndexedDB | Local structured data persistence |

## Getting Started

### Prerequisites

- Node.js: meet Vite 8 runtime requirements; current LTS recommended
- npm
- Rust stable toolchain
- Optional Blender editing: Windows x86_64 or macOS Intel/Apple Silicon; stable 4.5 / 5.0 / 5.1 / 5.2 series. The lightweight director desk does not require Blender.
- Platform-specific [Tauri system dependencies](https://v2.tauri.app/start/prerequisites/)

Windows builds additionally require Visual Studio Build Tools 2022 with the "Desktop development with C++" workload installed.

### Install dependencies

```bash
npm install
```

### Start the development environment

```bash
# Start the web frontend only, available at http://localhost:1420 by default
npm run dev

# Start the full Tauri desktop app
npm run tauri dev
```

Web mode is suited for UI development; native dialogs, local file tools, separate windows, local models and the 3D director desk require the Tauri desktop environment.

### Check and build

```bash
# TypeScript type checking
npm run typecheck

# ESLint
npm run lint

# Unit tests (Vitest)
npm run test

# lint + type check + tests
npm run check

# Frontend production build
npm run build

# Desktop app build
npm run tauri build
```

`package.json` is the version source. `npm run sync-version` currently updates only the Chinese README badge and `src-tauri/Cargo.toml`; check the Tauri configuration, translated READMEs, website and manual separately. See the [release guide](doc/打包与发版流程.md).

## Documentation

- [User manual (Chinese)](site/manual.html)
- [Module documentation (Chinese)](doc/文档导航.md)
- [开发指南](doc/开发指南.md): environment, commands, directories, conventions, debugging and FAQ (in Chinese)
- [架构说明](doc/架构说明.md): core modules, data flow, security boundaries and performance design (in Chinese)
- [ComfyUI 工作流集成说明](doc/ComfyUI工作流集成说明.md): import, IO node detection, content/parameter injection and result retrieval (in Chinese)
- [对话式画布助手功能方案](doc/对话式画布助手-功能方案.md)
- [对话助手 Agent 能力实施方案](doc/对话助手-Agent能力实施方案.md)
- [打包与发版流程](doc/打包与发版流程.md)

Long-term engineering boundaries are defined by [AGENTS.md](AGENTS.md); architecture decision records live in [`doc/adr/`](doc/adr/).

## License

This project is licensed under the **AI Canvas Tauri Source-Available License**; see [LICENSE](LICENSE) for the full terms.

Learning, research, internal use, modification and integration use are permitted. Unauthorized rebranding for sale, white-label distribution, source-code resale, commercial redistribution, and commercializing the project as a competing product are prohibited.

This project is not open source under the OSI definition. For commercial licensing, please contact the copyright holder.

### Third-party assets

The toolbar and properties panel of the canvas note visual design reference [Excalidraw](https://github.com/excalidraw/excalidraw); see [doc/licenses/excalidraw-MIT.txt](doc/licenses/excalidraw-MIT.txt) for its license.

## Contact

Development QQ group: 873354155

## Contributors

<p>
  <a href="https://github.com/zhurui0523" title="zhurui0523"><img src="https://images.weserv.nl/?url=github.com/zhurui0523.png&amp;w=128&amp;h=128&amp;fit=cover&amp;mask=circle" width="64" height="64" alt="zhurui0523" /></a>
  <a href="https://github.com/stars-one" title="stars-one"><img src="https://images.weserv.nl/?url=github.com/stars-one.png&amp;w=128&amp;h=128&amp;fit=cover&amp;mask=circle" width="64" height="64" alt="stars-one" /></a>
  <a href="https://github.com/luckcatlin2000" title="luckcatlin2000"><img src="https://images.weserv.nl/?url=github.com/luckcatlin2000.png&amp;w=128&amp;h=128&amp;fit=cover&amp;mask=circle" width="64" height="64" alt="luckcatlin2000" /></a>
  <a href="https://github.com/xiaozangao" title="xiaozangao"><img src="https://images.weserv.nl/?url=github.com/xiaozangao.png&amp;w=128&amp;h=128&amp;fit=cover&amp;mask=circle" width="64" height="64" alt="xiaozangao" /></a>
  <a href="https://github.com/orlova851986-debug" title="orlova851986-debug"><img src="https://images.weserv.nl/?url=github.com/orlova851986-debug.png&amp;w=128&amp;h=128&amp;fit=cover&amp;mask=circle" width="64" height="64" alt="orlova851986-debug" /></a>
</p>

# 3D 导演台按需下载运行时实施计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 从 AI Canvas 安装包移除 3D 导演台静态资源，在用户首次创建导演台节点时提示下载，并在 Windows 卸载时清理下载内容。

**Architecture:** Rust 后端从固定 GitHub Release 下载版本化 `tar.gz`，在 `appLocalDataDir/director-desk/<version>` 中校验 SHA-256、限制归档路径并分阶段安装。Tauri 注册仅服务该固定目录的 `director-desk://` 本地协议；开发与正式环境使用同一固定构建产物。前端使用 Zustand UI 状态统一承接所有节点创建入口的下载提示，并提供取消、重试和应用内清理。

**Tech Stack:** Tauri 2、Rust、reqwest、sha2、flate2、tar、React 19、Zustand、Vitest。

---

### Task 1：实现 Rust 运行时资源管理

**状态：已完成并通过定向单元测试。**

**Files:**

- Create: `src-tauri/src/director_desk_runtime.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/Cargo.lock`
- Reuse: `scripts/director-desk-release.json`

**Steps:**

1. 写单元测试覆盖 URL 解码、路径穿越拒绝、MIME、Range 和安装元数据校验。
2. 运行 `cargo test director_desk_runtime::tests --lib`，确认测试先失败。
3. 实现固定清单解析、状态查询、单任务锁、取消标记和下载进度事件。
4. 流式下载时限制 100 MB、检查磁盘、同步计算 SHA-256，并只接受清单固定 HTTPS URL。
5. 解压时拒绝符号链接、硬链接、绝对路径和父目录，限制文件数量及展开后大小。
6. 使用 staging 目录安装，校验 `index.html` 与发布元数据后切换版本目录，失败不影响旧版本。
7. 注册 `director-desk://` 协议，只允许 `director-desk` 窗口读取固定版本目录，并支持静态文件 MIME 与 Range。
8. 注册 status/install/cancel/remove Tauri 命令，重跑定向 Rust 测试。

### Task 2：接入前端下载状态与节点创建触发

**状态：已完成并通过类型、Lint 与定向测试。**

**Files:**

- Create: `src/services/directorDeskRuntimeService.ts`
- Create: `src/components/director/DirectorDeskRuntimeManager.tsx`
- Create: `src/components/director/DirectorDeskDownloadDialog.tsx`
- Modify: `src/store/store.ui.ts`
- Modify: `src/store/store.nodes.ts`
- Modify: `src/App.tsx`
- Modify: `src/components/nodes/DirectorDeskNode.tsx`
- Test: `tests/services/directorDeskRuntimeService.test.ts`
- Test: `tests/store/directorDeskRuntimePrompt.test.ts`

**Steps:**

1. 写失败测试，覆盖运行时命令映射、进度监听，以及 `addNode`/`addNodeWithEdge` 只在新建导演台时请求提示。
2. 实现运行时服务类型、状态查询、安装、取消和删除入口。
3. 为 UI slice 增加单一下载提示状态；项目加载走 `setNodes`，不触发提示。
4. 所有用户写入型 `addNode*` Action 在包含 `ai-director` 时请求提示。
5. 在 App 装配单实例 Runtime Manager：已安装则静默关闭提示，缺失则显示确认框。
6. 下载弹窗显示约 54 MB 下载/82 MB 磁盘占用、真实进度、取消和错误重试。
7. 下载完成后自动打开刚创建节点的独立窗口；节点手动打开时若资源缺失则复用同一提示。
8. 运行定向 Vitest、TypeScript 和 ESLint。

### Task 3：移除安装包内置资源并增加清理能力

**状态：已完成；生产构建确认不再捆绑资源，NSIS 安装器已成功生成。**

**Files:**

- Delete: `scripts/prepare-director-desk.mjs`
- Modify: `package.json`
- Modify: `.gitignore`
- Create: `src/components/settings/DirectorDeskStorageManager.tsx`
- Modify: `src/components/SettingsPanel.tsx`
- Create: `src-tauri/windows/nsis-hooks.nsh`
- Modify: `src-tauri/tauri.conf.json`

**Steps:**

1. 从 `npm run build` 移除构建期准备步骤并删除准备脚本。
2. 清除本地生成的 `public/director-desk` 与 `.cache/director-desk`，确认不再进入 Vite `dist`。
3. 在存储健康页展示导演台版本、磁盘占用、安装状态和“删除本地资源”操作。
4. 删除前关闭导演台窗口，失败时保留状态并显示错误。
5. NSIS `NSIS_HOOK_PREUNINSTALL` 只删除 `$LOCALAPPDATA/com.aicanvas.app/director-desk`，不删除项目、配置或其他应用数据。
6. 运行生产构建并确认 `dist/director-desk/index.html` 不存在。

### Task 4：更新架构记录与完成验证

**状态：自动化验证已完成；正式环境首次下载交互保留为发布前人工验收项。**

**验证记录（2026-07-21）：**

- `npm run typecheck`、`npm run test:typecheck`、定向 ESLint 通过。
- `npm test` 通过，共 34 个测试文件、188 个测试。
- `cargo test director_desk_runtime::tests --lib` 通过 5 个测试。
- `cargo test file_transfer::tests --lib` 通过 2 个测试，`cargo check --lib` 通过。
- `npm run build` 通过，`dist/director-desk/index.html` 不存在。
- `npx tauri build --debug --bundles nsis --no-sign --ci` 通过并生成 NSIS 安装器。
- `git diff --check`、JSON 解析与本批 25 个文本文件严格 UTF-8 检查通过。
- 全仓 `cargo fmt --check` 仍受本批之外既有 Rust 格式差异阻断；新建 Rust 模块已单独执行 `rustfmt`。

**Files:**

- Modify: `doc/adr/0003-director-desk-prebuilt-runtime.md`
- Modify: `doc/plans/2026-07-21-director-desk-production-runtime.md`

**Steps:**

1. 将 ADR 决策更新为运行时按需下载，记录自定义协议、离线、升级和卸载边界。
2. 运行 `npm run typecheck`、`npm run test:typecheck`、`npm test` 和改动文件 ESLint。
3. 运行 `cargo test director_desk_runtime::tests --lib`、`cargo test file_transfer::tests --lib` 和 `cargo check --lib`。
4. 运行生产 Vite 构建、`git diff --check` 与严格 UTF-8 扫描。
5. 在 Tauri 开发环境验证提示、取消、重试、下载完成打开、离线复用和应用内删除。

### Task 5：统一开发与正式运行路径

**状态：已完成并通过自动化验证。**

**验证记录（2026-07-21）：**

- `npm run typecheck`、`npm run test:typecheck` 和改动文件定向 ESLint 通过。
- 导演台 3 个定向测试文件共 12 个测试通过；全量 36 个测试文件、200 个测试通过。
- `npm run build` 与 `cargo check --lib` 通过，构建产物仍不包含 `dist/director-desk/index.html`。
- Tauri debug 构建通过前端构建和 capability 配置解析；最终替换 debug 可执行文件时因当前 AI Canvas 进程占用而停止（Windows `os error 5`），不是代码或权限配置错误。
- 已确认默认脚本为 `dev: vite`、`tauri: tauri`，源代码和 capability 中不存在 5178 运行引用。

**Files:**

- Modify: `package.json`
- Delete: `scripts/dev-with-director.mjs`
- Delete: `scripts/tauri-with-director.mjs`
- Delete: `scripts/ensure-director-desk.mjs`
- Delete: `scripts/start-director-desk.sh`
- Modify: `src/services/directorDeskService.ts`
- Modify: `src/services/directorDeskRuntimeService.ts`
- Modify: `src-tauri/capabilities/director-desk.json`
- Test: `tests/services/directorDeskRuntimeService.test.ts`
- Test: `tests/services/directorDeskWindowService.test.ts`

**Steps:**

1. 默认开发命令不再启动导演台源码服务。
2. Tauri 开发环境与正式环境统一检查、下载并加载固定构建产物。
3. Web-only 模式不触发下载，继续提示独立窗口只支持 Tauri。
4. 删除 5178 远程 capability 和废弃脚本，更新测试与文档。
5. 运行前端检查、生产构建和 Tauri 配置验证。

## 回滚

- Rust 安装使用版本目录和 staging，失败时删除临时文件，不覆盖已安装兼容版本。
- 前端可回滚到 `beca4e5` 恢复构建期内置资源；发布前不得同时保留内置和按需两条生产路径。
- Windows 卸载钩子只作用于导演台目录，移除钩子即可回滚，不影响其他用户数据。

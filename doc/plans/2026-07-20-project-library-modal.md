# 项目库大弹窗实施计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 将侧栏项目入口升级为紧凑项目库，并使用切换/退出时保存的真实画布快照展示项目。

**Architecture:** `ProjectLibraryModal` 继续通过 Store Action 完成新建、切换和删除。V2 在主线程采集当前 React Flow 视口的几何信息和受限媒体位图，由独立 Web Worker 使用 `OffscreenCanvas` 绘制、压缩为 480×270 WebP Data URL；`html-to-image` 仅作为兼容回退。快照作为可选项目元数据写入现有 IndexedDB 项目记录，不新增 object store，不提升 schema 版本。捕获失败保留旧快照，空画布清除快照并在 UI 中显示图标占位。

**Tech Stack:** React 19、TypeScript、Zustand、Tailwind CSS、Framer Motion、Iconify、html-to-image、现有 ModalOverlay。

---

### Task 1: 建立项目库弹窗组件

**Files:**
- Create: `src/components/ProjectLibraryModal.tsx`

**Step 1: 建立组件状态和 Store 选择器**

- 读取 `projects`、`currentProjectId`、`createProject`、`switchProject`、`deleteProject`。
- 维护搜索词、排序方式、网格/列表模式、新建输入态、待删除项目。
- 弹窗关闭时清理临时交互状态，不修改 Store 数据。

**Step 2: 实现项目搜索、排序和日期展示**

- 项目名使用本地小写匹配。
- 支持按最近更新、名称、创建时间排序。
- 空搜索结果提供清除搜索和新建项目入口。

**Step 3: 实现项目卡片和列表行**

- 当前项目使用 `aria-current`、品牌描边和“当前”标签。
- 项目 ID 映射到稳定的多色画布占位，不读取其他项目完整画布数据。
- 点击项目沿用既有切换行为；点击当前项目只关闭弹窗。
- 删除入口仅在既有规则允许时出现。

**Step 4: 实现新建与删除确认**

- 新建项目先显示名称输入，回车后调用 `createProject(name)`。
- 删除在弹窗内显示 `alertdialog`，明确项目名和不可撤销后果。
- 所有图标按钮提供可访问名称和焦点样式。

### Task 2: 接入侧栏项目入口

**Files:**
- Modify: `src/components/Sidebar.tsx`

**Step 1: 移除旧 LogoMenu 的项目业务和删除气泡**

- 删除旧窄浮层、定位计算和对应 Store 订阅。
- 保留侧栏项目按钮及 active 状态。

**Step 2: 挂载项目库弹窗**

- 点击按钮打开 `ProjectLibraryModal`。
- 通过 portal 挂到 `document.body`，避免侧栏包含块影响 fixed 弹窗。

### Task 3: 验证与交付

**Files:**
- Verify: `src/components/ProjectLibraryModal.tsx`
- Verify: `src/components/Sidebar.tsx`

**Step 1: 定向静态检查**

Run: `npx eslint src/components/ProjectLibraryModal.tsx src/components/Sidebar.tsx`

Expected: 无改动文件 lint 错误；若遇到仓库已知 ESLint 10 兼容错误，记录完整错误并继续其他检查。

**Step 2: 类型和测试检查**

Run: `npm run typecheck`

Run: `npm run test:typecheck`

Expected: 两条命令退出码均为 0。

**Step 3: 生产构建和差异检查**

Run: `npx vite build --outDir $env:TEMP/ai-canvas-project-library-build`

Run: `git diff --check`

Expected: 构建完成且差异无空白错误；构建产物只写入系统临时目录。

**Step 4: 浏览器验收**

- 启动隔离工作区开发服务器。
- 检查桌面和窄视口下弹窗尺寸、文字溢出、搜索、排序、视图切换、新建和删除确认。
- 检查控制台无新增错误，减少动效设置仍受 `ModalOverlay` 支持。

**Step 5: 提交**

```bash
git add doc/plans/2026-07-20-project-library-modal.md src/components/ProjectLibraryModal.tsx src/components/Sidebar.tsx
git commit -m "feat(ui): 将项目面板升级为项目库弹窗"
```

### Task 4: 保存真实画布快照

**Files:**
- Create: `src/services/projectSnapshotService.ts`
- Create: `src/services/projectSnapshotWorker.ts`
- Create: `tests/services/projectSnapshotService.test.ts`
- Modify: `src/types/index.ts`
- Modify: `src/services/storageService.ts`
- Modify: `src/store/store.projects.ts`

**Step 1: 安装快照依赖**

Run: `npm install html-to-image@1.11.13 --save`

Expected: `package.json` 和 `package-lock.json` 仅增加 `html-to-image`。

**Step 2: 实现受限快照服务与 Worker**

- 只捕获当前 `.react-flow`，排除 Controls、MiniMap、Panel、选择框和 attribution。
- 主线程同步采集节点、连线和媒体几何信息；媒体按缩略图尺寸等比降采样后转移给 Worker。
- Worker 使用 `OffscreenCanvas` 绘制并输出 480×270 WebP，限制最大 Data URL 体积。
- 媒体采集限制为双并发、单图 800ms、整批 1.8s；单张失败不阻断整体快照。
- 并发请求复用同一个 Promise；超时或编码失败返回 `null`，不阻断项目切换或退出。
- 不支持 Worker 时使用 `html-to-image` 兼容捕获，跳过字体嵌入和不稳定媒体表面。

**Step 3: 扩展项目元数据**

- `CanvasProject` 和 `ProjectSaveData` 增加可选 `snapshot?: string`。
- 保存记录、项目列表映射和加载路径保留快照；旧项目缺失时保持兼容。
- 不新增 IndexedDB store/index，不修改 `DB_VERSION`。

### Task 5: 接入快照生命周期

**Files:**
- Modify: `src/store/store.projects.ts`
- Modify: `src/components/Sidebar.tsx`
- Modify: `src/App.tsx`

**Step 1: 新增统一 Store Action**

- `captureCurrentProjectSnapshot()` 捕获当前项目并通过既有保存队列持久化。
- 空画布移除旧快照；捕获失败保留旧快照。

**Step 2: 接入触发点**

- 打开项目库后延迟到入场动画结束再后台刷新，避免首帧争抢。
- 切换项目时立即启动快照任务，不等待绘制和编码；任务完成后写回原项目并通过保存队列持久化。
- Tauri 退出流程先保存快照，再清理撤销目录并销毁窗口。

### Task 6: 收敛项目库布局

**Files:**
- Modify: `src/components/ProjectLibraryModal.tsx`

**Step 1: 简化工具栏和卡片**

- 使用 `p-3` 对应的 12px 视口安全边距，面板收敛到约 840×560。
- 移除网格/列表切换，仅保留搜索、排序和新建。
- 项目卡展示真实快照；缺失时显示项目图标。
- 删除按钮固定在卡片底栏，不再悬浮在预览区域。

**Step 2: 验证**

Run: `npx eslint src/services/projectSnapshotService.ts src/components/ProjectLibraryModal.tsx src/components/shared/ModalOverlay.tsx`

Run: `npm run typecheck && npm run test:typecheck && npm run test`

Run: `npx vite build --outDir <系统临时目录>`

Expected: 静态检查、测试和构建通过；桌面与窄视口无溢出，真实快照可在切换后恢复。

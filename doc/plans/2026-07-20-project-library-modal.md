# 项目库大弹窗实施计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 将侧栏现有的窄项目菜单替换为可搜索、排序并支持网格/列表视图的项目库大弹窗。

**Architecture:** 新增独立 `ProjectLibraryModal` 组件，继续通过 `useAppStore` 的既有 Action 完成新建、切换和删除。`Sidebar` 只负责入口开关；V1 不扩展 `CanvasProject`、IndexedDB schema 或共享 `ModalOverlay`，项目封面使用基于项目 ID 的稳定画布图形占位。

**Tech Stack:** React 19、TypeScript、Zustand、Tailwind CSS、Framer Motion、Iconify、现有 ModalOverlay。

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

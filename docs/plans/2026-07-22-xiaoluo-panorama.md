# XiaoLuo Panorama Integration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the AI Canvas panorama renderer with a reusable embedded core from XiaoLuo-Panorama, supporting compact node rendering and full-screen professional controls.

**Architecture:** Refactor XiaoLuo-Panorama into a host-neutral `PanoramaCore` plus its existing full viewer shell, and publish the core through a separate package export. Consume that core through a thin AI Canvas adapter while keeping canvas state, persistence, history, and overlays inside AI Canvas.

**Tech Stack:** React 19, TypeScript, Pannellum, Vite library mode, React Flow, Zustand, Vitest

---

## Completion Record

Completed on 2026-07-22.

- XiaoLuo-Panorama now exposes the host-neutral `PanoramaCore` and independent `./core` package entry.
- AI Canvas consumes the upstream HTTPS Git dependency pinned to commit `ac2f465ae68b1d6cfba4d47091c16b69cf1c3076`.
- Compact rendering uses `PanoramaCore`; fullscreen rendering lazy-loads the original upstream `PanoramaViewer` with host theme, close, direct-image loading, corner radius, and capture-delivery adapters.
- Multi-instance isolation, screenshot node creation, original fullscreen controls, light/dark themes, Escape close, and narrow viewport layout were verified in the running application.
- AI Canvas type checks, targeted ESLint, 217 tests, production build, strict UTF-8 scan, and `git diff --check` passed.
- Upstream pull request: https://github.com/Tenney95/XiaoLuo-Panorama/pull/1

Follow-up adjustment approved on 2026-07-22: keep the compact node on `PanoramaCore`, but replace the AI Canvas-owned immersive controls with the original upstream `PanoramaViewer`. The upstream component will expose only the host integration props needed for capture delivery, direct URL loading, light/dark theme mapping, and a smaller host radius. AI Canvas will consume the resulting Git commit through npm and lazy-load the full viewer only when fullscreen opens.

---

### Task 1: Create the upstream embeddable core

**Files:**
- Create: `D:/www/project/XiaoLuo-Panorama/LICENSE`
- Create: `D:/www/project/XiaoLuo-Panorama/src/components/PanoramaCore.tsx`
- Create: `D:/www/project/XiaoLuo-Panorama/src/core.ts`
- Modify: `D:/www/project/XiaoLuo-Panorama/src/components/PanoramaViewer.tsx`
- Modify: `D:/www/project/XiaoLuo-Panorama/src/index.ts`

**Step 1:** Define typed core props and an imperative handle for view updates, reset, resize, and PNG capture.

**Step 2:** Move Pannellum lifecycle ownership into the core and scope all DOM, keyboard, and animation work to the instance.

**Step 3:** Compose the existing full viewer from the core without changing its public default behavior.

**Step 4:** Run `npm run lint` and fix all TypeScript failures.

**Step 5:** Commit with `feat: 增加可嵌入的全景核心组件`.

### Task 2: Produce a consumable core package export

**Files:**
- Modify: `D:/www/project/XiaoLuo-Panorama/package.json`
- Modify: `D:/www/project/XiaoLuo-Panorama/vite.lib.config.ts`
- Modify: `D:/www/project/XiaoLuo-Panorama/src/index.css`
- Modify: `D:/www/project/XiaoLuo-Panorama/README.md`

**Step 1:** Add a `./core` export and multi-entry Vite library build.

**Step 2:** Keep `pannellum` as the core runtime dependency and keep full-viewer UI libraries outside the core entry.

**Step 3:** Document embedded and full-viewer usage, focus-scoped keyboard behavior, and host-controlled fullscreen.

**Step 4:** Run `npm run build:lib` and inspect emitted JavaScript, CSS, and declarations.

**Step 5:** Commit with `build: 增加核心组件独立导出`.

### Task 3: Integrate the core into AI Canvas

**Files:**
- Create: `src/components/nodes/panorama/XiaoLuoPanoramaViewer.tsx`
- Modify: `src/components/nodes/PanoramaNode.tsx`
- Modify: `src/styles/nodes-panorama.css`
- Modify: `package.json`
- Modify: `package-lock.json`

**Step 1:** Add the upstream package pinned to the reviewed Git commit.

**Step 2:** Implement the adapter with compact and immersive variants plus the existing screenshot contract.

**Step 3:** Replace the local Three.js viewer while preserving node upload, preview toggle, screenshot persistence, sizing, handles, and history behavior.

**Step 4:** Add full-screen controls for walking, visual correction, reset, and capture without persisting runtime controller objects.

**Step 5:** Run `npm run typecheck`, `npm run test:typecheck`, targeted ESLint, and related tests.

**Step 6:** Commit with `feat(panorama): 接入小洛全景查看器`.

### Task 4: Verify the complete user flow

**Files:**
- Modify only files required to fix defects found during verification.

**Step 1:** Run `npx vite build --outDir <system-temp-directory>`.

**Step 2:** Start the web development server and load a 2:1 panorama fixture.

**Step 3:** Verify compact drag and wheel zoom, multiple simultaneous nodes, image/360 switching, and absence of canvas gesture leakage.

**Step 4:** Verify full-screen walking, camera correction, reset, screenshot creation, Escape close, desktop layout, and narrow viewport layout.

**Step 5:** Run strict UTF-8 checks and `git diff --check` in both repositories.

**Step 6:** Prepare the upstream pull request and report the pinned commit used by AI Canvas.

### Task 5: Reuse the upstream full-viewer interface

**Files:**
- Modify: `D:/www/project/XiaoLuo-Panorama/src/components/PanoramaViewer.tsx`
- Modify: `D:/www/project/XiaoLuo-Panorama/src/index.css`
- Modify: `src/components/nodes/PanoramaNode.tsx`
- Modify: `src/components/nodes/panorama/XiaoLuoPanoramaViewer.tsx`
- Create: `src/components/nodes/panorama/XiaoLuoPanoramaFullscreen.tsx`
- Modify: `src/styles/nodes-panorama.css`
- Modify: `package.json`
- Modify: `package-lock.json`

**Step 1:** Extend `PanoramaViewerProps` with backward-compatible `theme`, `cornerRadius`, `imageLoadStrategy`, and `onCapture` props. Keep existing standalone defaults so current consumers still download captures and resolve remote URLs as before.

**Step 2:** Route viewport and architectural captures to `onCapture` when supplied, while retaining the existing download behavior when it is absent. Add semantic root classes and scoped dark-theme variables without replacing the original component layout.

**Step 3:** Run `npm run lint`, `npm run build:lib`, and `npm pack --dry-run` in XiaoLuo-Panorama. Commit and push the result to the existing pull-request branch.

**Step 4:** Pin AI Canvas to the new upstream commit with npm. Add the upstream full-viewer peer runtimes required by the root package.

**Step 5:** Keep `XiaoLuoPanoramaViewer` as the compact core adapter. Add a separately imported `XiaoLuoPanoramaFullscreen` adapter that maps the canvas theme, close action, and capture callback to the upstream component.

**Step 6:** Remove the duplicated immersive controls and their CSS from AI Canvas. Preserve node upload, image/360 switching, compact screenshot, fullscreen state, file persistence, image-node creation, and history behavior.

**Step 7:** Run AI Canvas type checks, targeted ESLint, tests, production build, strict UTF-8 validation, and `git diff --check`. Verify light and dark fullscreen styles plus narrow viewport behavior in the running application.

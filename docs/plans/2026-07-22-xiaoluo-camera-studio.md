# XiaoLuo Camera Studio Integration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a native camera-and-lighting studio tool to image nodes that creates a connected image generation node through the existing model runtime.

**Architecture:** Adapt the upstream interaction model instead of consuming its unpublished package or demo API. Keep deterministic camera/light prompt generation in a pure module, lazy-load a project-themed fullscreen React/Three.js panel, and let `ImageNode` own canvas writes and generation dispatch through the existing preset-node and generation services.

**Tech Stack:** React 19, TypeScript 6, Three.js, Zustand, React Flow, Iconify, Vitest, Tailwind/CSS canvas tokens

---

### Task 1: Define the studio prompt contract

**Files:**
- Create: `src/components/nodes/shared/image/cameraStudio.ts`
- Create: `tests/components/cameraStudio.test.ts`

**Step 1:** Write tests for camera, lighting, and dual-mode prompt output, angle normalization, and reset defaults.

**Step 2:** Run `npx vitest run tests/components/cameraStudio.test.ts` and confirm the missing module causes a failure.

**Step 3:** Implement typed camera/light state, presets, defaults, and deterministic English prompt builders.

**Step 4:** Run the focused test and confirm it passes.

### Task 2: Build the lazy-loaded studio panel

**Files:**
- Create: `src/components/nodes/shared/image/CameraStudioPanel.tsx`
- Create: `src/styles/camera-studio.css`

**Step 1:** Implement a fullscreen, dark professional control surface with camera, lighting, and dual segmented modes.

**Step 2:** Add a scoped Three.js sphere that supports pointer drag and cleans up renderer resources, listeners, and animation frames on unmount.

**Step 3:** Add presets, sliders, prompt preview/copy, reset, and a generate action that returns studio state and prompt to the host.

**Step 4:** Keep controls responsive at desktop and narrow viewport widths without overlapping the canvas.

### Task 3: Connect the image-node tool

**Files:**
- Modify: `src/components/nodes/shared/toolbar/toolbarRegistry.ts`
- Modify: `src/components/nodes/shared/image/ImageNodeToolbar.tsx`
- Modify: `src/components/nodes/ImageNode.tsx`

**Step 1:** Register the `cameraStudio` toolbar action and remove the superseded `multiAngle` tool.

**Step 2:** Add the toolbar callback and lazy-load the studio panel only when opened.

**Step 3:** Convert the studio result into a connected generator node using `createPresetNode`, preserving the source `@{nodeId:label}` reference and resolving the existing image model preference.

**Step 4:** Add the node and edge in one history operation, close the panel, and dispatch `executeGeneration` with the new node data.

### Task 4: Verify behavior and visual integration

**Files:**
- Modify only files required to fix defects found during verification.

**Step 1:** Run the focused Vitest test and `npm run typecheck`.

**Step 2:** Run targeted ESLint for all modified TypeScript and TSX files.

**Step 3:** Run `npx vite build --outDir <system-temp-directory>` and `git diff --check`.

**Step 4:** Strictly decode modified text files as UTF-8 and scan for common mojibake markers.

**Step 5:** Start the development server and verify the image-node tool on desktop and narrow viewports, including mode switching, sphere drag, reset, close, and generator-node creation.

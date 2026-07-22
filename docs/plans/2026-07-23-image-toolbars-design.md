# Image Toolbars Bottom Dock Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 将图片节点及其全屏编辑工具的命令栏统一移动到底部，并对齐 XiaoLuo-Panorama 与 XiaoLuo-PointEdit 的紧凑毛玻璃视觉风格。

**Architecture:** 保持现有 React 组件、事件与状态流不变，仅通过现有选择器调整定位和视觉。命令栏作为底部 dock；扩图参数与合成器侧栏继续作为独立参数面板；所有底部 dock 的菜单向上展开。

**Tech Stack:** React 19、TypeScript 6、CSS、Vite 8

---

## Task 1: 图片节点工具栏下移

**Files:**
- Modify: `src/styles/nodes-image.css`

1. 将 `.img-toolbar` 从节点上方移动到节点下方。
2. 对齐 16px 外圆角、6px 按钮圆角、24px 毛玻璃和克制阴影。
3. 保持宫格菜单默认向上展开，并限制窄节点下的最大宽度。

## Task 2: 全屏裁切、抠图、宫格和扩图工具栏统一

**Files:**
- Modify: `src/styles/crop.css`
- Modify: `src/styles/nodes-image.css`

1. 将 `.crop-aspect-bar`、`.matting-toolbar`、`.customgrid-toolbar` 固定到底部。
2. 统一 32px 控件高度、6px 按钮圆角、16px 外圆角和主题感知毛玻璃表面。
3. 将 `.expand-controls` 移到右侧独立参数面板，并调整舞台留白。
4. 增加窄窗口和低高度窗口规则，避免命令栏、参数面板和预览内容重叠。

## Task 3: 多图合成器底部 dock

**Files:**
- Modify: `src/styles/composer.css`

1. 将 `.composer-toolbar` 从顶部通栏改为底部浮动 dock。
2. 让 `.composer-menu` 向上展开，工具栏按钮与其他图片工具统一。
3. 保持右侧参数面板独立，并为窄窗口提供可横向滚动的紧凑布局。
4. 调整入场方向和缩放提示位置，避免与底栏重叠。

## Task 4: 验证

**Files:**
- Verify only

1. 运行 `npm run typecheck`。
2. 运行 `npm run test:typecheck` 和 `npm run test`。
3. 运行改动范围适用的构建与 `git diff --check`。
4. 严格 UTF-8 解码并扫描常见乱码字符。
5. 启动 Web 预览，检查明暗主题、窄窗口、菜单展开方向和工具栏遮挡情况。

# 高级快捷指令顺序执行 Implementation Plan

> **For Codex:** 按本计划逐项实现，每一阶段完成后运行对应验证，不扩大到任意脚本、分支工作流或后台任务恢复。

**Goal:** 保留现有基础快捷指令体验，并为高级用户提供参数化模板和确定性的多节点顺序生成。

**Architecture:** `UserPreset` 以可选高级配置向后兼容旧数据；纯函数模板服务负责参数校验与插值，顺序执行服务负责一次性创建节点链并逐步等待 `executeGeneration()`。高级编辑器和运行弹窗只负责采集配置与参数，所有共享画布写入仍通过 Zustand Store Action。

**Tech Stack:** React 19、TypeScript、Zustand、React Flow、IndexedDB、Framer Motion、现有 AI generation service。

---

## 范围与约束

- 旧预设缺少 `mode` 时按基础模式读取，不迁移、不丢字段。
- 基础模式继续支持“直接触发”和“加入提示词”。
- 高级模式仅支持线性顺序执行，第一步引用触发节点，后续步骤引用前一步节点。
- 参数类型限定为单行文本、多行文本、数字、单选和开关。
- 步骤限定为文本、图像、视频和音频生成节点，不允许任意脚本、文件操作或删除操作。
- 启动时一次性创建节点和边，只提交一次画布创建历史；每个节点生成完成时沿用 `executeGeneration()` 的节点历史和输出历史记录。
- 任一步失败立即停止，保留已经完成的结果和尚未执行的节点，不自动重试付费生成。
- 不新增依赖，不提升 IndexedDB schema 版本。

### Task 1: 数据模型与持久化兼容

**Files:**
- Modify: `src/types/index.ts`
- Modify: `src/services/indexedDbService.ts`
- Modify: `src/store/store.presets.ts`

**Steps:**
1. 定义高级预设参数、步骤、运行请求和执行模式类型。
2. 扩展 IndexedDB `PresetRecord` 的可选字段，不创建 object store 或索引。
3. 加载旧记录时回退为基础模式，加载高级记录时保留参数和步骤。
4. 运行 `npm run typecheck`，确认类型扩展不破坏旧调用方。

### Task 2: 原子节点链写入与模板解析

**Files:**
- Modify: `src/store/store.nodes.ts`
- Create: `src/services/presetTemplateService.ts`
- Create: `src/services/presetSequenceService.ts`

**Steps:**
1. 新增一次提交 nodes + edges 的 Store Action，并为每个节点分配 displayId 与项目默认设置。
2. 实现参数默认值、必填校验、模板变量提取和全量插值。
3. 根据源节点、参数和步骤构建线性节点链，使用 `@{nodeId:label}` 传递上一步结果。
4. 一次性写入节点链后逐步 `await executeGeneration()`，失败即停止。
5. 定向检查服务和 Store 文件。

### Task 3: 高级配置编辑器

**Files:**
- Modify: `src/components/nodes/shared/PresetManager.tsx`
- Create: `src/components/nodes/shared/PresetAdvancedEditor.tsx`
- Modify: `src/styles/preset-manager.css`

**Steps:**
1. 在详情区增加“基础 / 高级”模式切换，默认保持基础模式。
2. 高级模式提供参数列表，支持新增、删除、排序和类型配置。
3. 高级模式提供步骤列表，支持新增、删除、排序、节点类型、名称、模板和模型设置。
4. 保存前验证参数键唯一、必填信息完整、至少存在一个有效步骤。
5. 检查小尺寸窗口下的滚动、按钮文本和无内容状态。

### Task 4: 运行表单与触发入口

**Files:**
- Modify: `src/App.tsx`
- Create: `src/components/nodes/shared/PresetRunnerDialog.tsx`
- Modify: `src/components/nodes/shared/SlashCommandMenu.tsx`
- Modify: `src/components/nodes/shared/PromptPanel.tsx`
- Modify: `src/components/nodes/shared/TextNodeToolbar.tsx`
- Modify: `src/components/nodes/shared/AudioNodeToolbar.tsx`
- Modify: `src/components/nodes/shared/VideoNodeToolbar.tsx`
- Modify: `src/components/nodes/shared/image/ImageNodeToolbar.tsx`

**Steps:**
1. 在 preset slice 保存非持久化运行请求，只记录 presetId 和 sourceNodeId。
2. 全局挂载运行弹窗，按参数定义生成表单并展示步骤与生成次数摘要。
3. 斜杠菜单和四种节点 Toolbar 检测高级预设后打开运行弹窗；基础预设保持原路径。
4. 用户确认后启动顺序执行，关闭表单并在画布节点状态中展示进度。
5. 执行失败时展示出错步骤，后续节点保持 idle。

### Task 5: 验证

**Files:** 所有上述改动文件。

**Steps:**
1. 使用严格 UTF-8 解码并扫描常见乱码字符。
2. 运行 `npm run typecheck`。
3. 对改动的 TS/TSX 文件运行定向 ESLint；若命中已知 ESLint 10 兼容错误则如实记录。
4. 运行 `git diff --check`。
5. 使用系统临时目录运行 `npx vite build --outDir <temp>`。
6. 启动开发服务器，在桌面和窄窗口下检查基础模式、高级编辑、参数运行表单和顺序执行入口。

## 完成记录

2026-07-19 完成参数化高级快捷指令与顺序执行链：

- `npm run typecheck` 通过。
- 新增及相关改动文件的定向 ESLint 通过；`ImageNodeToolbar.tsx` 全文件检查仍命中既有的 Effect 状态更新与依赖告警，本次新增分流未扩大该问题。
- `git diff --check` 通过。
- 所有改动文本严格 UTF-8 解码通过，常见乱码字符扫描为 0。
- `npx vite build --outDir %TEMP%/ai-canvas-preset-build-20260719` 通过。
- 在 Tauri 1420×900 实际窗口验证基础/高级模式、参数行、双步骤卡片、内部滚动和固定操作栏；未保存测试数据。

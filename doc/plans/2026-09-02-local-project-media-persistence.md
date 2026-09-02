# 生成媒体本地项目持久化 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 自定义接口、批量/轮询生成以及高清超分和主体识别产出的图片、视频只将本地项目文件引用持久化到 IndexedDB。

**Architecture:** 以 `fileService` 作为唯一媒体落盘边界，统一处理 `data:`、`blob:` 和 HTTP(S) 结果，并返回可持久化的 URL 组。所有节点、批量和轮询入口只回写该 URL 组；项目序列化再作一道防线，将已有内嵌媒体迁移到项目目录。ONNX 派生输出路径直接从当前项目数据目录分配。

**Tech Stack:** TypeScript 6、Zustand、Tauri 2 fs/asset protocol、Vitest 4。

---

### Task 1: 建立统一媒体落盘契约

**Files:**
- Modify: `src/services/fileService.ts`
- Test: `tests/services/fileServiceDownload.test.ts`

**Steps:**
1. 先增加 `data:` 与 `blob:` 落盘的失败测试。
2. 让 `downloadUrlAndSave` 按 URL 类型分流到二进制写入或原生流式下载。
3. 新增可持久化 URL 规整函数：内嵌/临时 URL 落盘后全部改指本地 asset URL，远程 URL 仍可保留为来源。
4. 运行定向测试。

### Task 2: 接入所有画布生成入口

**Files:**
- Modify: `src/components/nodes/AINodeDialog.tsx`
- Modify: `src/services/generationService.ts`
- Modify: `src/services/imageBatchService.ts`
- Modify: `src/services/pollManager.ts`
- Modify: `src/utils/batchExecute.ts`
- Test: `tests/services/imageBatchService.test.ts`
- Test: `tests/services/batchExecute.test.ts`
- Test: `tests/services/pollManager.test.ts`

**Steps:**
1. 将单次、批量、批执行和异步轮询结果切换到统一落盘契约。
2. 节点与输出历史不再回写完整 `data:` / `blob:` 内容。
3. 落盘失败时不得把内嵌媒体降级写入持久化状态。
4. 运行定向测试。

### Task 3: 收紧对话产物与 ONNX 输出

**Files:**
- Modify: `src/services/ai/generationRuntime.ts`
- Modify: `src/components/nodes/shared/image/useImageNodeOnnxActions.ts`
- Test: `tests/services/generationRuntime.test.ts`

**Steps:**
1. 对话生成复用统一落盘契约，不在 `mediaResult.sourceUrl` 保留内嵌正文。
2. 超分和主体识别的输出路径从项目数据目录分配，不再默认写到输入文件旁。
3. 运行定向测试。

### Task 4: 迁移已有内嵌媒体并验证

**Files:**
- Modify: `src/services/storageService.ts`
- Test: `tests/services/storageServiceProjectLoad.test.ts`

**Steps:**
1. 为项目节点序列化增加内嵌媒体检测与项目文件迁移。
2. 迁移成功后仅持久化 `assetId + relativePath + asset URL`；失败时拒绝把大段媒体正文写入 IndexedDB。
3. 运行存储定向测试、改动文件 ESLint、`npm run typecheck`、`git diff --check` 和严格 UTF-8/乱码扫描。

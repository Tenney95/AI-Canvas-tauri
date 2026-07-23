# 生成资产提示词标签 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task.

**Goal:** 仅为今后在当前项目中生成并成功落盘的媒体资产，从生成提示词本地提取标签并持久化，且不覆盖已有标签。

**Architecture:** 新增独立的资产标签服务，使用浏览器内置分词能力提取有限数量的短标签，并通过现有稳定资产索引写入 `assetMetaV2`。节点生成复用输出历史记录入口触发，对话媒体生成在文件保存后触发；标签失败不改变生成结果。

**Tech Stack:** TypeScript 6、IndexedDB、Tauri 文件元数据、Vitest

---

### Task 1: 本地标签提取与持久化

**Files:**
- Create: `src/services/fs/generatedAssetTags.ts`
- Create: `tests/services/generatedAssetTags.test.ts`

**Step 1: Write the failing test**

覆盖中文和英文提示词提取、模型引用与 URL 过滤、数量限制、已有标签不覆盖，以及新资产标签持久化。

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/services/generatedAssetTags.test.ts`

Expected: FAIL，因为 `generatedAssetTags.ts` 尚不存在。

**Step 3: Write minimal implementation**

实现 `extractGeneratedAssetTags(prompt)` 与 `tagGeneratedProjectAsset({ filePath, projectId, prompt })`。使用 `Intl.Segmenter`，不可用时回退到正则分词；最多保留 6 个标签。资产已有标签时直接跳过。

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/services/generatedAssetTags.test.ts`

Expected: PASS。

### Task 2: 接入统一生成边界

**Files:**
- Modify: `src/store/store.historyRecord.ts`
- Modify: `src/services/ai/generationRuntime.ts`
- Test: `tests/services/generatedAssetTags.test.ts`

**Step 1: Add integration expectations**

验证只有成功、带 `filePath`、带非空提示词的记录会触发标签；对话图片、视频、音频保存成功后触发同一服务。

**Step 2: Implement minimal hooks**

节点生成在输出历史成功持久化后异步标记；对话生成在媒体文件保存成功后标记。捕获标签错误并输出不含提示词和路径的固定警告。

**Step 3: Run focused verification**

Run: `npx vitest run tests/services/generatedAssetTags.test.ts tests/services/generationRuntime.test.ts`

Expected: PASS。

### Task 3: 静态与差异检查

**Files:**
- Verify all files above

**Step 1: Run static checks**

Run: `npm run typecheck`

Run: `npm run test:typecheck`

Run: `npx eslint src/services/fs/generatedAssetTags.ts src/store/store.historyRecord.ts src/services/ai/generationRuntime.ts tests/services/generatedAssetTags.test.ts`

**Step 2: Run repository checks**

Run: `git diff --check`

对全部修改文本执行严格 UTF-8 解码并扫描常见乱码字符。


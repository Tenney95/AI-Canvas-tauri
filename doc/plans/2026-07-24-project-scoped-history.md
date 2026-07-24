# 项目级历史与结构化撤销 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use `executing-plans` to implement this plan task-by-task.

**Goal:** 输出历史按项目隔离且每个项目最多保留 16 条，画布撤销只处理节点、连线和分组等结构性变化，不回退位置、尺寸或普通内容编辑。

**Architecture:** IndexedDB 继续作为输出历史唯一持久化源，v15 为历史增加项目复合索引，并在写入、旧记录归属和项目删除时统一执行项目边界。画布历史继续保存完整快照用于恢复被删除节点，但比较和恢复时只应用结构字段，现存节点的布局与普通数据保持当前值。

**Tech Stack:** TypeScript 6、Zustand 5、IndexedDB v15、Vitest 4、React 19。

---

### Task 1: 输出历史 schema 与项目边界

**Files:**
- Modify: `src/types/index.ts`
- Modify: `src/services/indexedDbService.ts`
- Test: `tests/services/indexedDbService.test.ts`
- Test: `tests/services/imageGenerationHistory.test.ts`

**Step 1: Write the failing tests**

- 断言新数据库版本为 15，`history` 包含 `projectId_timestamp_id` 和 `projectId_nodeId` 索引。
- 写入两个项目各自的记录，断言查询、计数、节点历史和清空只影响目标项目。
- 连续写入同一项目 17 条，断言只保留时间最新的 16 条。
- 删除项目时，断言项目所属输出历史同步删除。

**Step 2: Run tests to verify failure**

Run: `npm test -- tests/services/indexedDbService.test.ts tests/services/imageGenerationHistory.test.ts`

Expected: FAIL，原因是历史记录还没有 `projectId` 复合索引和项目级 API。

**Step 3: Implement the minimal persistence changes**

- 将 `DB_VERSION` 提升到 15。
- 为历史记录增加 `projectId`，创建两个项目复合索引。
- 所有分页、计数、节点查询、删除、清空和导出 API 接收 `projectId`。
- 每次写入后使用项目时间索引删除第 17 条及更旧记录。
- 提供幂等的旧历史归属函数：仅把没有 `projectId` 且 nodeId 属于当前项目的记录写回当前项目。
- 项目删除事务增加历史 object store，并按项目索引级联删除。

**Step 4: Run tests to verify pass**

Run: `npm test -- tests/services/indexedDbService.test.ts tests/services/imageGenerationHistory.test.ts`

Expected: PASS。

### Task 2: 输出历史 Store 与 UI 项目切换

**Files:**
- Modify: `src/store/store.historyRecord.ts`
- Modify: `src/components/OutputHistoryPanel.tsx`
- Modify: `src/components/nodes/shared/image/ImageGenerationHistoryDialog.tsx`
- Test: `tests/store/historyRecord.test.ts`

**Step 1: Write the failing tests**

- 记录历史时自动注入当前 `projectId`。
- 内存数组始终裁剪为 16 条。
- 项目变化后，新项目记录不会与旧项目记录混合。
- 没有当前项目时不写历史。

**Step 2: Run tests to verify failure**

Run: `npm test -- tests/store/historyRecord.test.ts`

Expected: FAIL，原因是当前 Store 使用全局历史且内存无上限。

**Step 3: Implement Store and UI changes**

- Store 增加当前历史所属项目标识，所有 IndexedDB 调用传入当前项目 ID。
- 加载前认领可确定归属的旧记录，写入后内存最多保留 16 条。
- 输出历史面板在当前项目变化时重新加载。
- 单节点图片历史查询传入当前项目 ID。

**Step 4: Run tests to verify pass**

Run: `npm test -- tests/store/historyRecord.test.ts`

Expected: PASS。

### Task 3: 画布撤销只处理结构变化

**Files:**
- Modify: `src/store/store.history.ts`
- Test: `tests/store/history.test.ts`

**Step 1: Write the failing tests**

- 节点位置或 `nodeWidth` / `nodeHeight` 变化不会形成可撤销步骤。
- 普通标签、提示词和生成结果变化不会被撤销。
- 撤销创建/删除节点时，现存节点保留当前位置、尺寸和普通数据。
- 重新分组时仍恢复 parentId、extent、分组成员和必要坐标。

**Step 2: Run tests to verify failure**

Run: `npm test -- tests/store/history.test.ts`

Expected: FAIL，原因是当前快照比较和恢复包含全部节点字段。

**Step 3: Implement structural history semantics**

- 使用节点 ID/type/parentId、连线端点、分组成员和必要分镜字段判断结构相等。
- 提交时跳过与最近记录结构相同的快照。
- undo/redo 对目标中已存在的节点保留当前普通数据、位置和尺寸；仅恢复结构字段。
- 仅对被恢复或再次删除的节点执行文件回收站操作。

**Step 4: Run tests to verify pass**

Run: `npm test -- tests/store/history.test.ts`

Expected: PASS。

### Task 4: Verification and commit

**Files:**
- Verify all modified files.

**Step 1: Run targeted checks**

Run: `npx eslint <modified files>`

Run: `npm run typecheck && npm run test:typecheck`

**Step 2: Run regression suite**

Run: `npm test`

Run: `npx vite build --outDir <system-temp-directory>`

**Step 3: Validate repository hygiene**

Run: `git diff --check`

- 严格 UTF-8 解码并扫描常见乱码字符。
- 确认暂存区不包含 `.release-notes-v0.6.2.md` 和 `.release-notes-v0.6.3.md`。

**Step 4: Commit**

```bash
git commit -m "fix(history): 按项目限制历史并精简撤销记录"
```

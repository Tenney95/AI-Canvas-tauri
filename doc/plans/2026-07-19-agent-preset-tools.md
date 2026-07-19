# Agent 快捷指令工具实施计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 让对话 Agent 能查询、创建、修改并安全调用用户快捷指令。

**Architecture:** 快捷指令定义通过 Agent Tool Registry 暴露，读取使用 `read`，创建和修改使用 `file_write`。调用采用“创建运行节点 + 单步执行”的两阶段协议，文本步骤使用 `canvas_write`，媒体步骤使用 `media_generation`，从而保留现有 B/C 模式和逐次媒体审批。

**Tech Stack:** TypeScript、Zustand、Agent Tool Registry、IndexedDB、现有快捷指令模板与节点生成服务。

---

### Task 1: 记录安全架构决策

**Files:**
- Create: `doc/adr/0001-agent-preset-tools.md`

**Step 1:** 记录读取、写入、画布应用和生成步骤的 effect 映射。

**Step 2:** 记录拒绝“一个工具连续执行整条媒体链”的原因。

**Step 3:** 复核跨项目、revision、重试和失败停止约束。

### Task 2: 实现快捷指令 Agent 工具

**Files:**
- Create: `src/services/chat/tools/presetTools.ts`
- Reuse: `src/services/presetSequenceService.ts`

**Step 1:** 定义严格 JSON schema，限制字段、参数和步骤数量。

**Step 2:** 实现 `preset_list` 和 `preset_get`，只返回快捷指令数据，不返回本地路径或 Store 内部状态。

**Step 3:** 实现 `preset_create` 和 `preset_update`，复用快捷指令校验与 Store CRUD，并交给 `file_write` 策略逐次确认。

**Step 4:** 实现 `preset_start_run`，复用现有顺序计划构建器，校验项目、源节点、参数和 revision，原子创建带任务归属标记的运行节点。

**Step 5:** 实现 `preset_run_text_step` 和 `preset_run_media_step`，一次只执行一个节点，校验任务归属和前序状态，失败时把 Observation 返回模型。

### Task 3: 注册并记录能力

**Files:**
- Modify: `src/services/chat/tools/index.ts`
- Modify: `doc/对话助手-Agent能力实施方案.md`

**Step 1:** 注册快捷指令工具。

**Step 2:** 在实施文档中记录工具清单、权限和回滚边界。

### Task 4: 验证

**Files:**
- Verify: `src/services/chat/tools/presetTools.ts`
- Verify: `src/services/chat/tools/index.ts`

**Step 1:** 运行 `npm run typecheck`，预期通过。

**Step 2:** 对改动的 TypeScript 文件运行 ESLint，预期无 error。

**Step 3:** 运行 `npm run build`，预期生产构建通过。

**Step 4:** 静态复核所有快捷指令工具的 effect，确认媒体步骤没有自动重试或批量执行入口。

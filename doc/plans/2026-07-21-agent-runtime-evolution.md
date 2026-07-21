# Agent Runtime Evolution Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 在现有对话 Agent 上实现串行调度、安全恢复与回退、可观测性、上下文增强、结构化 Skill、只规划模式和受限专家任务。

**Architecture:** 保留 `agentRuntime.ts` 作为唯一执行循环，新增小型无状态服务承载调度、事件、评分和 Manifest 解析。可持久化状态继续收口到 `AgentTask`、会话和现有 IndexedDB store；所有权限仍由 Tool Registry 与 Policy Engine 决定。

**Tech Stack:** React 19、TypeScript 6、Zustand 5、Vitest 4、IndexedDB、React Flow 12、Tauri 2。

---

### Task 1: 文档与兼容类型

**Files:**
- Create: `doc/plans/2026-07-21-agent-runtime-evolution-design.md`
- Create: `doc/plans/2026-07-21-agent-runtime-evolution.md`
- Modify: `src/types/agent.ts`
- Modify: `src/types/chat.ts`
- Modify: `src/types/index.ts`

**Steps:**
1. 定义队列、事件、指标、检查点、专家任务、Skill Manifest 和 `plan` 模式类型。
2. 为所有新增持久化字段提供可选字段或 normalize 默认值。
3. 运行 `npm run test:typecheck`，预期通过。

### Task 2: 会话调度器与插话缓冲

**Files:**
- Create: `src/services/chat/agentScheduler.ts`
- Modify: `src/services/chat/agentRuntime.ts`
- Modify: `src/components/chat/ChatPanel.tsx`
- Modify: `src/components/chat/ChatInput.tsx`
- Modify: `src/services/chat/chatWindowService.ts`
- Test: `tests/services/chat/agentScheduler.test.ts`

**Steps:**
1. 先为同会话 FIFO、跨会话并行、取消排队项编写失败测试。
2. 实现调度器并确认测试通过。
3. 为插话 FIFO、仅活跃循环可接收、完成后清理编写测试。
4. 接入主/独立窗口发送协议和输入区操作。
5. 运行定向测试、类型检查与定向 ESLint。

### Task 3: 事件日志、安全恢复与重复写保护

**Files:**
- Create: `src/services/chat/agentLifecycle.ts`
- Create: `src/services/chat/agentJournal.ts`
- Modify: `src/services/chat/agentRuntime.ts`
- Modify: `src/services/chat/agentTaskService.ts`
- Modify: `src/store/store.agent.ts`
- Test: `tests/services/chat/agentLifecycle.test.ts`
- Test: `tests/services/chat/agentJournal.test.ts`

**Steps:**
1. 测试事件顺序、监听器隔离、脱敏和上限裁剪。
2. 在模型轮次、Policy、审批、工具和任务终态写入事件与指标。
3. 恢复时注入已完成步骤摘要。
4. 对已成功的相同写工具输入指纹返回既有 Observation，不重复执行。
5. 运行 Agent Runtime 相关测试。

### Task 4: 任务检查点与安全回退

**Files:**
- Create: `src/services/chat/agentCheckpointService.ts`
- Modify: `src/services/chat/agentRuntime.ts`
- Modify: `src/components/chat/AgentTaskTimeline.tsx`
- Modify: `src/components/chat/ChatPanel.tsx`
- Test: `tests/services/chat/agentCheckpointService.test.ts`
- Test: `tests/store/history.test.ts`

**Steps:**
1. 测试连续尾部允许回退、交错历史和 revision 漂移拒绝回退。
2. 在 canvas 写工具执行前后记录历史索引和 revision。
3. 实现任务回退 Action 和稳定错误码。
4. 在时间线提供可访问的回退按钮。
5. 运行定向测试和类型检查。

### Task 5: 指标与全局任务中心

**Files:**
- Create: `src/components/chat/AgentTaskCenter.tsx`
- Modify: `src/components/chat/ChatHeader.tsx`
- Modify: `src/components/chat/ChatPanel.tsx`
- Modify: `src/components/chat/AgentTaskTimeline.tsx`
- Modify: `src/services/chat/chatWindowService.ts`

**Steps:**
1. 消费 `usage` 事件并累计 token、模型耗时、工具耗时和 Policy 计数。
2. 实现当前项目任务中心，复用现有控制 Action。
3. 同步独立窗口所需状态和操作。
4. 运行组件类型检查和定向 ESLint。

### Task 6: 相关性记忆与可靠压缩

**Files:**
- Create: `src/services/chat/memoryRetrieval.ts`
- Modify: `src/services/chat/contextManager.ts`
- Modify: `src/services/chat/contextCompressionService.ts`
- Test: `tests/services/chat/memoryRetrieval.test.ts`
- Test: `tests/services/chat/contextCompression.test.ts`

**Steps:**
1. 测试中文/英文相关性、类别权重、时间衰减、去重和预算。
2. 把检索查询接入当前用户消息。
3. 测试结构化摘要校验、锚点保留和覆盖游标单调性。
4. 纳入活跃任务摘要并拒绝无效压缩结果。
5. 运行上下文定向测试。

### Task 7: Skill Manifest 与只规划模式

**Files:**
- Create: `src/services/chat/skillManifest.ts`
- Modify: `src/store/store.skills.ts`
- Modify: `src/services/skillPromptService.ts`
- Modify: `src/services/chat/toolRegistry.ts`
- Modify: `src/services/chat/policyEngine.ts`
- Modify: `src/components/chat/AgentModeSelector.tsx`
- Test: `tests/services/chat/skillManifest.test.ts`
- Test: `tests/services/chat/policyEngine.test.ts`
- Test: `tests/services/chat/toolRegistry.test.ts`

**Steps:**
1. 测试轻量 frontmatter 解析和旧 Skill 兼容。
2. 保存 Manifest 并把 `allowed-tools` 作为任务级工具上限。
3. 增加 `plan` 模式，Registry 过滤和 Policy 固定双重拒绝写工具。
4. 更新模式选择器和多窗口提示。
5. 运行定向测试、类型检查和 ESLint。

### Task 8: 受限专家任务

**Files:**
- Create: `src/services/chat/tools/expertTools.ts`
- Modify: `src/services/chat/tools/index.ts`
- Modify: `src/store/store.agent.ts`
- Modify: `src/components/chat/AgentTaskCenter.tsx`
- Test: `tests/services/chat/expertTools.test.ts`

**Steps:**
1. 测试角色白名单、父任务限制、深度限制、每任务数量预算和输入脱敏。
2. 注册 `agent_run_expert_review` 只读工具。
3. 子任务使用独立无工具模型轮次并持久化父子关系与结果摘要。
4. 在任务中心展示父子关系。
5. 运行专家工具定向测试。

### Task 9: 文档、回归与阶段提交

**Files:**
- Modify: `doc/对话助手-Agent能力实施方案.md`
- Create: `doc/adr/0002-agent-runtime-evolution.md`

**Steps:**
1. 每完成阶段更新状态、实际文件、检查结果和回滚说明。
2. 运行 `npm run typecheck`、`npm run test:typecheck`、`npm run test`。
3. 对改动文件运行定向 ESLint；记录既有 ESLint 10 阻断（如出现）。
4. 运行 `npx vite build --outDir <系统临时目录>`、`git diff --check` 和 UTF-8 严格解码检查。
5. 检查 `git status --short` 无意外变更。
6. 按阶段使用中文 Conventional Commit 提交。

# 自动化测试与 CI 门禁 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 为高风险 Agent、持久化、画布历史和项目恢复链路建立可重复的自动化回归测试，并阻止未通过质量检查的代码进入发布构建。

**Architecture:** 使用 Vitest 运行 TypeScript 单元与集成测试，使用 `fake-indexeddb` 在 Node 环境验证 IndexedDB schema 和升级行为。测试通过模块 mock 隔离 Tauri 文件系统、动画和网络副作用，不修改生产权限或持久化结构；GitHub Actions 分别执行前端质量检查与 Rust `cargo check`，Release 在质量任务通过后才启动多平台打包。当前 ESLint 10.4.0 与 TypeScript parser 存在仓库已知兼容错误，`lint` 脚本保留但不纳入必过 job，待独立工具链任务修复后再启用。

**Tech Stack:** Vitest、fake-indexeddb、TypeScript、Zustand、IndexedDB、GitHub Actions、Cargo。

---

### Task 1: 测试运行器与环境

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `vitest.config.ts`
- Create: `tests/setup.ts`

**Steps:**
1. 安装 `vitest` 与 `fake-indexeddb` 开发依赖。
2. 增加 `test`、`test:watch`、`test:typecheck` 和 `ci` 脚本。
3. 配置 Node 测试环境、统一 setup、mock 清理和单线程 IndexedDB 测试。
4. 运行空测试配置，确认测试发现和失败退出码正常。

### Task 2: Agent 安全边界

**Files:**
- Create: `tests/services/chat/policyEngine.test.ts`
- Create: `tests/services/chat/agentToolSchemas.test.ts`
- Create: `tests/services/chat/toolRegistry.test.ts`
- Create: `tests/services/chat/agentApproval.test.ts`

**Steps:**
1. 验证 B/C 模式与六类 effect 的固定权限矩阵。
2. 验证授权拒绝优先于模式自动执行。
3. 验证 required、unknown field、enum、长度、数值和数组限制。
4. 验证未注册/不可用工具被拒绝，合法调用通过准备阶段。
5. 验证审批通过、拒绝和中止不会绕过工具执行边界。

### Task 3: 持久化与画布事务

**Files:**
- Create: `tests/services/indexedDbService.test.ts`
- Create: `tests/store/history.test.ts`

**Steps:**
1. 验证全新数据库创建 v13 所需 object stores 和关键索引。
2. 构造旧版本数据库，升级后确认旧项目数据保留且 AgentTask/项目记忆 store 可用。
3. 验证批量删除只增加一次历史快照。
4. 验证一次 undo 恢复整批节点、边和分组。

### Task 4: 项目与任务恢复

**Files:**
- Create: `tests/store/projects.test.ts`
- Create: `tests/services/chat/agentTaskService.test.ts`
- Create: `tests/services/pollManager.test.ts`

**Steps:**
1. 验证项目切换先保存旧项目，再加载目标项目并清空画布历史。
2. 验证会话、AgentTask、项目记忆和待续生成任务只按目标项目加载。
3. 验证应用重启后运行中任务转为 paused、活动步骤回到 pending、旧审批过期。
4. 验证孤立 loading 节点转为可解释错误，过期待续记录被清理。

### Task 5: CI 与发布门禁

**Files:**
- Create: `.github/workflows/ci.yml`
- Modify: `.github/workflows/release.yml`

**Steps:**
1. PR 和 master push 执行 npm clean install、typecheck、测试类型检查、test 和生产构建。
2. Windows job 执行 `cargo check --lib`。
3. Release 增加前端质量 job，publish 使用 `needs` 等待其通过。
4. 运行 YAML 静态复核，确认发布密钥只在 publish job 使用。

**已知阻塞：** `npm run lint` 和改动文件定向 ESLint 当前均被 `scopeManager.addGlobals is not a function` 阻断。不得通过降级或替换依赖掩盖；修复工具链后再将 lint 加回 CI 必过 job。

### Task 6: 完整验收

**Steps:**
1. 运行 `npm run test:typecheck`。
2. 运行 `npm run test`。
3. 运行 `npm run check`。
4. 运行 `npx vite build --outDir <系统临时目录>`。
5. 在 `src-tauri/` 运行 `cargo check --lib`。
6. 运行 `git diff --check` 和严格 UTF-8/乱码扫描。

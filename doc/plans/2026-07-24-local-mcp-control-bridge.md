# 本地 MCP 控制桥 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use `executing-plans` to implement this plan task-by-task.

**Goal:** 为 AI Canvas 增加默认关闭、手动启用、可审计且不能绕过现有 Policy 的本地 MCP 控制能力。

**Architecture:** 官方 MCP SDK 提供 stdio 服务，Node 适配器通过带一次性令牌的 loopback JSON 协议连接 Tauri。Rust 只做会话与消息桥接；主窗口将调用绑定到专用“`MCP 控制`”对话，并复用 Tool Registry、Policy Engine、审批、AgentTask、revision 和撤销 checkpoint。

**Tech Stack:** Tauri 2、Rust 2021、Tokio、React 19、TypeScript 6、Zustand 5、Vitest 4、`@modelcontextprotocol/sdk`。

---

### Task 1: 文档与 SDK 依赖

**Files:**
- Create: `doc/adr/0004-local-mcp-control-bridge.md`
- Create: `doc/plans/2026-07-24-local-mcp-control-bridge.md`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `doc/对话助手-Agent能力实施方案.md`

**Step 1: 固定设计边界**

- 记录仅回环、随机端口、一次性令牌、主窗口单写源、专用审计会话和不可自批审批。
- 明确不修改 `tauri.conf.json`、capability、IndexedDB schema 或密钥存储。

**Step 2: 安装已授权依赖**

Run: `npm install @modelcontextprotocol/sdk`

Expected: `package.json` 和 lockfile 只增加官方 MCP SDK 及其锁定依赖。

**Step 3: 验证文档和依赖**

Run: `npm ls @modelcontextprotocol/sdk`

Run: `git diff --check`

Expected: SDK 可解析，文档严格 UTF-8，无空白错误。

### Task 2: stdio 适配器与 Tauri loopback 桥

**Files:**
- Create: `scripts/ai-canvas-mcp.mjs`
- Create: `src-tauri/src/mcp_bridge.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/Cargo.toml`
- Test: `tests/scripts/aiCanvasMcp.test.mjs`

**Step 1: 写失败测试**

- 覆盖适配器参数校验、请求 ID 关联、MCP 工具列表映射和断线错误。
- 覆盖 Rust 令牌格式、请求上限、未知方法、停止后失效和响应关联。

**Step 2: 运行并确认失败**

Run: `npm test -- tests/scripts/aiCanvasMcp.test.mjs`

Run: `cargo test mcp_bridge::tests --lib`（工作目录 `src-tauri/`）

Expected: FAIL，原因是适配器和 Rust 模块尚不存在。

**Step 3: 实现最小传输层**

- Node 适配器使用官方 `Server`、`StdioServerTransport` 和请求 schema。
- TCP 客户端为每个请求分配 ID，按换行拆帧并把结构化错误映射为 MCP 错误内容。
- Rust 绑定 `127.0.0.1:0`，校验 64 位十六进制令牌和 1 MiB 帧上限。
- Rust 只向 `main` 窗口发送去令牌请求；前端通过关联 ID 回传结果。
- stop 清空当前会话并唤醒 listener；旧 session 的请求和响应都被拒绝。

**Step 4: 运行定向验证**

Run: `npm test -- tests/scripts/aiCanvasMcp.test.mjs`

Run: `cargo test mcp_bridge::tests --lib`

Run: `cargo check --lib`

Expected: PASS。

### Task 3: 共享 Agent 工具执行与 MCP 审计控制

**Files:**
- Create: `src/types/mcp.ts`
- Create: `src/services/chat/agentToolExecution.ts`
- Create: `src/services/chat/tools/appTools.ts`
- Create: `src/services/mcp/mcpBridgeService.ts`
- Create: `src/services/mcp/mcpControlService.ts`
- Modify: `src/services/chat/agentRoundExecutor.ts`
- Modify: `src/services/chat/tools/index.ts`
- Test: `tests/services/chat/agentToolExecution.test.ts`
- Test: `tests/services/mcp/mcpControlService.test.ts`

**Step 1: 写失败测试**

- 未知工具和非法 schema 在执行前失败。
- 只读自动执行；C 模式画布写自动执行；永久保护 effect 等待应用内审批。
- 项目切换、授权撤销、会话停止和 Abort 时不得执行。
- 工具发现只返回当前上下文可用工具，不返回密钥、绝对路径或通用系统能力。
- 每个调用创建“`MCP 控制`”会话下的 AgentTask、Policy 事件、步骤、结果和画布 checkpoint。

**Step 2: 抽取共享执行器**

- 将 round executor 中“准备 → Policy → 审批 → 执行 → 重试 → checkpoint”收口为共享服务。
- 模型轮次与 MCP 入口只负责编排，不复制权限或重试判断。
- 现有 Agent 回归测试必须保持不变通过。

**Step 3: 实现 MCP 主窗口控制器**

- `tools/list` 从 Tool Registry 构建 MCP schema。
- `tools/call` 创建专用会话、消息和 AgentTask，再调用共享执行器。
- `app_get_state` 只返回脱敏项目、revision、节点数量、模型可用性和任务摘要。
- 保护调用等待既有审批卡，MCP 不注册审批解决工具。

**Step 4: 运行定向验证**

Run: `npm test -- tests/services/chat/agentToolExecution.test.ts tests/services/mcp/mcpControlService.test.ts tests/services/chat/agentRoundExecutor.test.ts tests/services/chat/agentApproval.test.ts`

Expected: PASS。

### Task 4: 手动会话设置与应用生命周期

**Files:**
- Create: `src/components/settings/McpControlSettings.tsx`
- Modify: `src/components/SettingsPanel.tsx`
- Modify: `src/store/store.ui.ts`
- Modify: `src/App.tsx`
- Test: `tests/components/mcpControlSettings.test.ts`

**Step 1: 写失败测试**

- 默认状态关闭且不生成令牌。
- 点击开启时使用 Web Crypto 生成 32 字节令牌并调用 Rust start。
- UI 只在当前组件内显示本次连接配置，不持久化令牌。
- 停止和组件卸载调用 stop；Web 模式明确显示不可用。

**Step 2: 实现设置页和初始化**

- 新增“`MCP 控制`”设置标签，使用现有 `canvas-*` token 和图标库。
- 显示状态、端口、启动命令与复制按钮；开启和停止是明确命令。
- `App.tsx` 仅在 Tauri 主窗口初始化事件监听，并在关闭前停止会话。

**Step 3: 运行定向验证**

Run: `npm test -- tests/components/mcpControlSettings.test.ts tests/services/mcp/mcpControlService.test.ts`

Expected: PASS。

### Task 5: 全量验证、文档完成记录与提交

**Files:**
- Verify all modified files.
- Modify: `doc/对话助手-Agent能力实施方案.md`

**Step 1: 静态和定向检查**

Run: `npx eslint <modified TypeScript/TSX files>`

Run: `npm run typecheck`

Run: `npm run test:typecheck`

Run: `cargo test mcp_bridge::tests --lib && cargo check --lib`（工作目录 `src-tauri/`）

**Step 2: 回归和生产构建**

Run: `npm test`

Run: `npx vite build --outDir <system-temp-directory>`

Expected: 全部通过；只记录仓库已知警告。

**Step 3: 仓库卫生**

Run: `git diff --check`

- 对所有新增和修改文本执行严格 UTF-8 解码并扫描常见乱码字符。
- 检查 `git status --short`，确认没有构建产物、缓存、令牌、端口或无关文件。

**Step 4: 更新实施方案并提交**

- 填写真实文件、命令、测试数量、手测结果和剩余风险。
- 分阶段提交说明使用中文；最终提交建议：`feat(mcp): 增加本地会话控制桥`。

### Task 6: 本机连接验收

**Files:**
- No persistent file changes unless a discovered defect requires a scoped fix.

**Step 1: 启动开发应用**

Run: `npm run tauri dev`

Expected: AI Canvas 正常启动，MCP 默认关闭。

**Step 2: 开启并连接**

- 在设置的 MCP 控制页开启会话。
- 使用页面给出的 Node 命令启动 stdio 适配器。
- 调用 `tools/list`、`app_get_state` 和一个只读画布查询。

**Step 3: 验证写入与审批**

- 在 C 模式执行一个可撤销画布写入并确认 timeline/checkpoint。
- 提交一次受保护调用，确认只有应用内审批卡可以放行。
- 停止会话后确认旧令牌和旧连接失效。

**Step 4: 录制准备**

- 保持 AI Canvas 使用紧凑窗口尺寸。
- 只在 MCP 验收通过后继续六段视频的画布操作和剪映编排。

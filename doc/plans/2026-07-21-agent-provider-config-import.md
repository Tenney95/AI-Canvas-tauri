# Agent 厂商配置导入实施计划

> **For Codex:** REQUIRED SUB-SKILL: Use `executing-plans` to implement this plan task-by-task.

**目标：** 允许对话 Agent 读取用户本轮明确提供的厂商 HTTPS 文档及其中必要的同站链接，生成不含密钥的厂商配置草稿，并在用户确认后写入名称、Base URL、模型和声明式调用协议。

**架构：** 用户 URL 先转成任务级临时授权；专用 Rust reader 负责 SSRF、DNS/IP、重定向和体积校验，前端只提取正文与同站链接。Agent 通过只读工具逐页分析并调用现有 `modelProtocolImport` 生成任务级草稿；写入工具使用新增 `config_write` effect，在 B/C 模式都必须确认，且输入 schema 明确拒绝 API Key。

**技术栈：** Tauri 2 / Rust、React 19 / TypeScript 6、Zustand 5、现有 Agent Tool Registry / Policy Engine、Vitest、Rust 单元测试。

---

## 安全与产品边界

- API Key 不进入 Agent 输入、工具 schema、Observation、审批摘要、日志或持久化草稿；新配置写入空字符串，编辑已有配置时保留原密钥。
- 只读取用户当前任务文本中明确出现的 HTTPS 起始 URL。
- 首次读取后，只授权页面正文中实际发现、与起始 URL 同源的 HTTPS 链接；禁止跨域、HTTP、凭据 URL、自定义端口和内网地址。
- Agent 逐页选择链接，不自动爬全站；单任务最多读取 8 页、最大深度 2、单页响应 1 MB、向模型提供正文 10,000 字符、累计正文 80,000 字符。
- 每个重定向都重新执行 URL、DNS 和 IP 校验，并要求最终 URL 仍与起始站点同源。
- 网页正文和链接文本始终标记为不可信资料，不能修改 Policy、工具权限、确认策略或 API Key 边界。
- `config_write` 在协作/自主模式都必须确认，不自动重试；Plan 模式不可用。
- 不新增依赖、不修改 IndexedDB schema、不放松 `tauri.conf.json`。

## 阶段 1：受限厂商文档读取

**文件：**

- 新增：`src-tauri/src/provider_docs.rs`
- 修改：`src-tauri/src/lib.rs`
- 新增：`src/services/providerDocsService.ts`
- 新增：`src/services/chat/providerDocsGrantService.ts`
- 修改：`src/services/chat/toolRegistry.ts`
- 修改：`src/services/chat/agentRuntime.ts`
- 新增：`src/services/chat/tools/providerConfigTools.ts`
- 修改：`src/services/chat/tools/index.ts`
- 新增：`tests/services/chat/providerDocsGrantService.test.ts`
- 更新：`doc/对话助手-Agent能力实施方案.md`

**步骤：**

1. 为 URL 规范化、同源判断、页面数/深度/累计正文预算写失败测试。
2. 实现任务级内存授权：从本轮用户文本提取 HTTPS 起始 URL，只接受已授权 URL；已读页面发现的同源链接可作为下一层授权。
3. 从历史 `assistant_web.rs` 的 SSRF 防护提取专用 reader，仅保留 HTTPS 页面读取，加入最终同源校验和响应限制。
4. 前端通过 `DOMParser` 删除脚本、样式、表单、导航等元素，提取正文、标题和去重后的同源链接。
5. 注册 `provider_docs_read` 只读工具，Observation 明确包裹不可信内容，并返回有限链接列表、当前深度和剩余页数。
6. 运行：
   - `npx vitest run tests/services/chat/providerDocsGrantService.test.ts`
   - `cargo test provider_docs::tests --lib`
   - `npm run typecheck`
   - 改动文件定向 ESLint、`cargo fmt --check`、`cargo check --lib`、`git diff --check`
7. 更新 Agent 实施方案阶段状态；只暂存本阶段文件和 `lib.rs` 中本阶段补丁，避免带入导演台改动。

## 阶段 2：配置草稿与确认写入

**文件：**

- 新增：`src/services/chat/providerConfigDraftService.ts`
- 修改：`src/services/chat/tools/providerConfigTools.ts`
- 修改：`src/services/chat/toolRegistry.ts`
- 修改：`src/services/chat/policyEngine.ts`
- 修改：`src/types/agent.ts`
- 修改：`src/components/chat/AgentApprovalCard.tsx`
- 修改：`tests/services/chat/policyEngine.test.ts`
- 新增：`tests/services/chat/providerConfigDraftService.test.ts`
- 新增：`tests/services/chat/providerConfigTools.test.ts`
- 更新：`doc/对话助手-Agent能力实施方案.md`

**步骤：**

1. 为多模型示例合并、不同 Base URL 拒绝、协议校验失败、API Key 字段拒绝和任务隔离写失败测试。
2. 实现 `provider_config_preview`：接收连接名称和一个或多个模型的提交/响应/轮询示例，逐项调用 `analyzeModelProtocolExamples()`，生成任务级内存草稿与安全摘要。
3. 草稿保存 `connectionId` 候选、名称、Base URL、模型分类、选中模型和 executionProfile；不保存网页正文或 API Key。
4. 新增 `config_write` effect；Policy 在协作/自主模式始终要求确认，Plan 模式拒绝，自动重试次数为 0。
5. 实现 `provider_config_apply`：输入只允许 `draftId`，确认后复核任务归属和草稿有效期，调用 `saveProviderConfig()` 与 `saveConfig()`；编辑时保留已有 API Key，新建时写入空 Key。
6. 审批卡新增“API 配置”类型和安全摘要，明确提示“不会写入 API Key”。
7. 运行定向 Vitest、typecheck、test:typecheck、定向 ESLint 和 `git diff --check`。
8. 更新 Agent 实施方案阶段状态并提交本阶段。

## 阶段 3：端到端与回归

**文件：**

- 修改：`tests/services/chat/agentApproval.test.ts`
- 修改：`tests/services/chat/toolRegistry.test.ts`
- 更新：`doc/对话助手-Agent能力实施方案.md`
- 更新：本计划完成记录

**步骤：**

1. 覆盖“用户 URL → 页面链接 → 多页读取 → 配置预览 → 审批 → 写入”的工具契约和审批生命周期。
2. 覆盖拒绝场景：模型自造 URL、跨域链接、私网/重定向、超过页数或深度、草稿跨任务复用、输入 API Key、无确认写入。
3. 运行全量 `npm test`、`npm run typecheck`、`npm run test:typecheck`、生产构建和 Rust 定向检查。
4. 严格 UTF-8 与常见乱码扫描；确认 API Key、网页正文和绝对路径未进入 AgentTask、消息、日志或长期记忆。
5. 更新完成记录并提交本阶段。

## 影响与回滚

- 影响：Agent 工具合同新增两个只读/预览动作和一个确认写动作；审批类型新增 `config_write`；Tauri 新增一个专用网页读取命令。
- 不影响：普通 API Key 设置页、现有手动文档导入、模型调用、画布历史、IndexedDB schema 和通用 `proxy_fetch`。
- 代码回滚：注销 `provider_docs_read`、`provider_config_preview`、`provider_config_apply`，移除专用 reader 和 `config_write` 分支即可。
- 数据回滚：写入结果是普通 `config.providers` 项，可在 API Key 设置页编辑或删除；无新增数据库表或不可逆迁移。

## 完成记录

- 状态：实施中。
- 阶段 1：已完成。实现任务级 HTTPS URL 授权、同源链接逐页授权、8 页/2 层/8 万字符预算、专用 Rust SSRF reader、结构化正文与链接提取，以及 `provider_docs_read` 只读 Agent 工具。
- 阶段 2：待实施。
- 阶段 3：待实施。

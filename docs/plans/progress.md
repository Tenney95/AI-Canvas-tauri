# Progress Log: 全局智能体兼容体系方案

## Session: 2026-08-27

### Phase 1: 需求与现状边界

- **Status:** complete
- Actions taken:
  - 明确用户要求从项目级调用提升为全局智能体平台。
  - 补充用户硬边界：业务智能体由用户上传，不嵌入软件或项目。
  - 读取 planning-with-files 完整规范并建立持久规划记录。
  - 复用上一轮对 AI 短剧知识库和当前 Skill/子智能体/插件边界的只读检查结果。
  - 确认本轮不实施代码、不执行外部脚本。
  - 核对 App 启动 hydration、19 个 Zustand slice、IndexedDB v20、AppConfig/ProjectSettings 以及消息和任务的 projectId 约束。
  - 识别“全局资源已经存在、运行上下文仍项目强绑定”的核心架构差距。
  - 核对默认项目创建、系统提示词装配、全局 Skill/子智能体目录和 AgentTask 创建链。
  - 识别当前 Prompt 固定注入画布上下文，需要新增上下文能力协商和 Agent 任务快照。
  - 核对文本模型解析、项目记忆和全局/项目角色库模式，形成智能体模型策略与多层记忆建议。
- Files created/modified:
  - task_plan.md（创建）
  - findings.md（创建）
  - progress.md（创建）

### Phase 2: 全局兼容架构

- **Status:** complete
- Actions taken:
  - 定义全局智能体包、安装记录、作用域绑定、运行实例和任务快照的五层模型。
  - 定义两级渐进披露、上下文能力协商和单主编排智能体原则。
  - 通过并行只读审计补齐 Runtime/MCP/持久化的精确复用边界。
  - 确认保留现有 AgentTask、Scheduler、Runtime、Registry、Policy、审批与审计作为唯一执行底座。
  - 新增“无安装快速旁路”原则：路由结果为空时直接走现有消息执行链，不注入包上下文或包工具。
- Files created/modified:
  - 无

### Phase 3: 生命周期、安全与持久化

- **Status:** complete
- Actions taken:
  - 定义 Definition、Installation、Binding、Conversation Runtime、Task Snapshot 五层持久化边界。
  - 定义用户上传的外部目录只读链接与托管包导入两种安装方式。
  - 定义安装、启停、分阶段更新、来源缺失降级、卸载不删除外部源的生命周期。
  - 定义代码脚本默认禁用、权限逐项授权、真实路径仅留原生授权层、知识正文不进 IndexedDB 的安全边界。
  - 识别 MCP 非 loopback 监听、会话 ID 代替 origin、C 模式文案漂移等前置风险。
  - 根据“无智能体不影响现有功能”的新增要求，把 Package 持久化调整为独立 Agent Catalog DB，核心 IndexedDB 首版不升级。
  - 固定通用包清单 `ai-canvas-agent.json`；旧目录通过宿主 sidecar 适配，不写回知识库。
- Files created/modified:
  - 无

### Phase 4: 分阶段实施与验收

- **Status:** complete
- Actions taken:
  - 把实施拆为通用合同、全局安装、作用域/路由、知识检索、全局 UI、能力集成、可信代码、MCP 加固等可回滚阶段。
  - 为 AI 短剧外部上传样板定义目录发现、路线隔离、按需 Skill、脚本禁用、版本快照和卸载验收。
  - 增加零智能体、禁用、包损坏、来源丢失、索引失败的原生功能回归矩阵。
- Files created/modified:
  - 无

### Phase 5: 方案交付

- **Status:** complete
- Actions taken:
  - 汇总推荐架构、范围、风险、回滚和验收门槛。
  - 保持本轮只修改规划记录，没有进入产品代码、数据库或原生安全配置实施。
  - 准备向用户提交最终推荐方案；后续架构代码实施须重新获得范围确认。
- Files created/modified:
  - 无

## Test Results

| Test | Input | Expected | Actual | Status |
|------|-------|----------|--------|--------|
| 规划范围检查 | 用户最新需求 | 全局兼容、按需调用、不实施代码 | 已固化到计划 | 通过 |
| 当前架构边界检查 | Store、DB schema、类型和 App 初始化 | 区分全局注册与项目运行 | 已确认并记录 | 通过 |
| 可选能力基线设计检查 | 未安装/禁用/损坏/缺失来源/索引失败 | 既有功能不依赖智能体层 | 已形成旁路与降级规则 | 通过（方案） |
| 统一执行链审计 | 普通聊天、独立窗口、后台、MCP | 不复制 Runtime/Policy | 已确认复用边界 | 通过（只读） |

## Error Log

| Timestamp | Error | Attempt | Resolution |
|-----------|-------|---------|------------|
| 本轮前置检查 | PowerShell 组合正则引号解析失败 | 1 | 拆分为简单正则后完成只读检查 |
| 本轮复核 | PowerShell 多分支检索正则再次解析失败 | 2 | 改为多个 `-e` 模式后完成只读检查 |

## 5-Question Reboot Check

| Question | Answer |
|----------|--------|
| Where am I? | Phase 5：方案交付 |
| Where am I going? | 向用户提交方案并等待架构实施授权 |
| What's the goal? | 设计全局安装、全局发现、按需路由的智能体兼容体系 |
| What have I learned? | 见 findings.md |
| What have I done? | 完成现状审计、兼容架构、生命周期、安全、分期和验收方案 |

## Session: 2026-08-27 Implementation

### Phase 6: 文档迁移与实施基线审计

- **Status:** complete
- Actions taken:
  - 收到用户对架构方案的明确实施授权。
  - 明确新增产品要求：上传入口放在内部助手，支持文件夹和压缩包选择。
  - 核对仓库同时存在 `doc/` 和 `docs/`，按用户指定把三份规划记录迁到 `docs/plans/`。
  - 记录实施前工作树已有的 Cargo 和生成 schema 改动，后续不得覆盖。
  - 启动助手 UI、Rust 导入边界和 Agent Catalog 三条并行只读审计。
  - 搜索现有上传/导入实现，确认 Skill 文件夹上传、项目 tar.gz 归档和 Rust 安全路径归一化可以作为首批实现参考。
  - 核对 Rust 依赖与 path policy：现有 tar.gz/sha256 能力可复用，普通 zip 尚无直接依赖；文件对话框授权路径仍需经过原生命令的双重路径校验。
  - 核对助手输入组件：现有 Skill 上传位于 `ChatInput`，智能体上传适合做成相邻但独立的 Agent 菜单；独立窗口继续遵循主窗口单写入。
  - 核对启动链：确认 Agent Catalog 必须在 `App.tsx` 独立非阻塞 hydration，不能加入项目初始化的 `Promise.all`。
  - 完成助手 UI 只读审计：首批采用 Header 智能体中心，空态仍可上传；输入框不作为唯一入口。
  - 收敛首批压缩包协议为不新增依赖的 `.aicanvas-agent/.tar.gz/.tgz`；普通 `.zip` 留作单独依赖确认项。
  - 完成全局 Catalog 审计：采用独立 DB、可选 Store hydration 和 Manifest 纯函数校验。
  - 完成原生导入审计：采用 opaque sourceId、私有 registry、staging 校验与原子安装，linked 卸载不删除用户目录。
- Files created/modified:
  - `docs/plans/task_plan.md`（由根目录迁移并追加实施阶段）
  - `docs/plans/findings.md`（由根目录迁移并记录实施边界）
  - `docs/plans/progress.md`（由根目录迁移并追加本次会话）

### Error Log

| Error | Attempt | Resolution |
|-------|---------|------------|
| `rg setup*` 在 Windows 返回非法路径 | 1 | 后续改用明确的 `tests/setup.ts` 和 `rg --files`，未修改代码 |
| `npx vitest` 访问 `registry.npmmirror.com` 遭 `EACCES` | 1 | 记录为环境/本地依赖入口问题；下一步只使用已安装 `.bin` 或冻结依赖，不重复同一命令 |
| 工作区冻结 Node 运行时同样缺少 Vitest/TypeScript | 1 | 不重装依赖；前端测试待可用本地依赖或用户授权安装后执行 |

### Phase 7-9: 首批纵向切片

- **Status:** 首批安装/管理/安全边界 complete；Phase 9 任务级运行时接入 pending
- Actions taken:
  - 分派原生安全导入、独立 Catalog 和助手 UI 三个互不覆盖的实施任务。
  - 冻结前后端命令与 Store 契约，避免并行实现产生接口漂移。
  - 明确首批不触碰已有 Cargo/schema 改动、不新增依赖、不开放任意脚本执行。
  - 复核内部助手模型/提示词调用，确认后续需显式透传任务 projectId，避免后台任务读取已切换项目的模型和画布；同时记录 C 模式提示文案漂移。
  - 已实施内部助手项目作用域收紧：任务模型解析、系统提示词、流式调用和本地规则管线显式透传 task projectId；未加载任务画布时省略节点并拒绝本地画布命令。
  - 已修正 C 自主模式切换 toast，使其与固定 Policy 的无需人工确认语义一致。
  - 新增 Agent Package v1 类型、严格 Manifest/预览/持久化记录校验，以及无清单旧目录的宿主兼容 Manifest。
  - 新增独立 Agent Catalog DB 和 Zustand slice；目录损坏或加载失败时退化为空目录，不阻塞核心项目初始化。
  - 新增 Rust linked 文件夹与 managed tar.gz 导入命令、私有 sourceId 注册表、健康探测、卸载和受限文本读取。
  - 在 AI 助手 Header/空态加入智能体中心；主窗口可选择文件夹或压缩包、查看健康、启停和移除，独立窗口不直接写目录。
  - 安装记录移除入口正文，确保 IndexedDB 只保存脱敏元数据；安装失败清理新来源，升级清理旧来源，linked 卸载不删除外部目录。
  - 明确本批不把“已启用”冒充“已按需调用”；任务级显式选择、AgentBindingSnapshot、Catalog 提示词索引和多表面接入进入 Phase 9 下一批。
  - 获取 fork 最新 `myfork/master`，确认唯一新提交只修改厂商配置草稿链且与本轮文件不重叠；安全快进 `4622b35 -> dc85e67` 后重新验证。
- Files created/modified by root in this phase:
  - `src/services/ai/assistantStream.ts`
  - `src/services/chat/assistantService.ts`
  - `src/services/chat/conversationExecutionController.ts`
  - `tests/services/assistantStreamProtocol.test.ts`
- Agent Package/Catalog/助手中心与原生安全边界文件：
  - `src/types/agentPackage.ts`
  - `src/services/agentPackages/*`
  - `src/store/store.agentPackages.ts`
  - `src/store/useAppStore.ts`
  - `src/App.tsx`
  - `src/components/chat/AgentCenterPanel.tsx`
  - `src/components/chat/ChatHeader.tsx`
  - `src/components/chat/ChatMessages.tsx`
  - `src/components/chat/ChatPanel.tsx`
  - `src/components/chat/EmptyChatState.tsx`
  - `src/components/Sidebar.tsx`
  - `src/i18n/locales/{en-US,ja-JP,ko-KR}/chat.ts`
  - `src-tauri/src/agent_package.rs`
  - `src-tauri/src/lib.rs`
  - `src-tauri/src/path_policy.rs`
  - `tests/components/agentCenterPanel.test.tsx`
  - `tests/services/agentCatalogDb.test.ts`
  - `tests/services/agentPackageImportService.test.ts`
  - `tests/services/agentPackageManifest.test.ts`
  - `tests/store/agentPackages.test.ts`

### Phase 10: 首批验证与文档

- **Status:** complete
- Actual validation:
  - `npm run typecheck`：通过。
  - `npm run test:typecheck`：通过。
  - 25 个改动 TypeScript/TSX 文件定向 ESLint：通过。
  - 本阶段 7 个定向 Vitest 文件、55 项：通过；快进 fork 后连同远端厂商配置测试共 8 个文件、71 项通过。
  - `cargo test --no-default-features agent_package::tests --lib`：10 项通过，包含注册表不持久化指令正文断言。
  - `cargo test --no-default-features path_policy::tests --lib`：6 项通过。
  - `cargo check --lib`：通过。
  - `rustfmt --edition 2021 --check src/agent_package.rs`：通过。
  - Vite 生产构建到系统临时目录：通过，仅有既有动态导入和大 chunk 警告。
  - `git diff --check`、严格 UTF-8 与常见乱码扫描：通过。
- Documentation:
  - 更新 `doc/对话助手-Agent能力实施方案.md`，新增 8.29 完成记录、限制和回滚说明。
  - 三份规划记录保持在用户指定的 `docs/plans/`。

### Implementation Error Log

| Error | Attempt | Resolution |
|-------|---------|------------|
| `npx vitest` 自动访问 npmmirror 并因沙箱网络 `EACCES` 失败 | 1 | 不重复联网调用，改用工作区本地 `.bin` |
| `npm install --offline --no-save vitest@4.1.10` 返回 `ENOTCACHED` | 1 | 停止安装；本地依赖入口恢复后直接运行定向测试，不修改依赖清单 |
| 默认 `cargo test` 在最终链接被既有 ONNX Runtime 与 VS2019 C++ 运行库不匹配阻断 | 1 | 用 `--no-default-features` 完成本阶段纯 Rust 定向测试，并另跑默认 `cargo check --lib` |
| 全仓 `cargo fmt --all -- --check` 被 `path_policy.rs` 既有未格式化行阻断 | 1 | 不格式化无关代码；新增 `agent_package.rs` 单文件 rustfmt 检查通过 |
| 首次 `git fetch myfork master` 被失效代理 `127.0.0.1:7892` 拒绝 | 1 | 本次命令显式清空 Git HTTP/HTTPS proxy 后直连成功，再按无重叠证据执行 fast-forward |

### 5-Question Reboot Check

| Question | Answer |
|----------|--------|
| Where am I? | Phase 9：任务级显式智能体选择与按需绑定待实施 |
| Where am I going? | 把已安装目录接入 AgentTask 不可变快照，再扩展普通聊天、画布、后台任务和 MCP |
| What's the goal? | 全局安装、全局发现、按需调用，同时零智能体完全旁路 |
| What have I learned? | 安装/安全目录可以独立落地，但启用状态不能替代运行时绑定 |
| What have I done? | 完成首批安装、管理、导入、安全读取、无智能体降级和助手项目作用域优化 |

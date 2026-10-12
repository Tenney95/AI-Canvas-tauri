# 对照 Codex 完善内置智能体与发布计划

**Goal:** 完善 Skill 与上下文读取、生成过程反馈、推理内容展示和失败恢复，完成检查、提交与新版本发布，再按用户要求关机。

**Architecture:** 在既有 Agent Runtime、Tool Registry、Policy、Store 和双窗口协议中增量实现。Skill 分页读取接入真实执行上下文的剩余预算；模型公开返回的推理内容、回答正文和可验证执行事件分别展示，权限判定继续由本地策略负责。

**Tech Stack:** Tauri 2、React、TypeScript、Zustand、既有流式协议解析器、Vitest 和 GitHub Actions。

## 状态与授权

- 已完成源码调查和公开仓库对照；用户已于 2026-10-12 确认范围并授权定向测试、npm run ci、cargo check --lib、可进行的界面验收与提交钩子。
- 用户已要求完善智能体、提交、发版和关机。当前正式版本为 `v0.10.4`，拟发布补丁版本 `v0.10.5`；发布前再次核对远程版本，禁止覆盖已存在标签。
- 现有工作区干净。主分支当前 CI 有图片请求运输测试的 3 项失败，需修复发布阻塞。
- 依照 `AGENTS.md`，超过 3 个文件的改动必须展示范围并等待确认；本方案同时申请本次检查、构建及提交钩子的执行授权。
- 实施中不调用付费模型；桌面端未实际验证的项目记录为待用户验证。

## 参考源码

参考 `openai/codex` 的公开提交 `a07c8ebd57feedc4cf5dfe854c8e9101de54186b`。仓库采用 Apache-2.0 许可；本项目借鉴机制并按自身协议实现。若实施时直接移植源码，需保留相应许可与归属。

| 来源 | 可借鉴机制 |
|---|---|
| [Skill 读取](https://github.com/openai/codex/blob/a07c8ebd57feedc4cf5dfe854c8e9101de54186b/codex-rs/ext/skills/src/tools/read.rs) | 有界分页、继续游标、响应预算、来源和访问身份复核 |
| [游标](https://github.com/openai/codex/blob/a07c8ebd57feedc4cf5dfe854c8e9101de54186b/codex-rs/ext/skills/src/tools/mod.rs) | 游标绑定内容指纹，不能把过期位置用于其他内容 |
| [目录渲染](https://github.com/openai/codex/blob/a07c8ebd57feedc4cf5dfe854c8e9101de54186b/codex-rs/ext/skills/src/render.rs) | 按模型窗口分配元数据预算，正文按需读取 |
| [Skill 使用说明](https://github.com/openai/codex/blob/a07c8ebd57feedc4cf5dfe854c8e9101de54186b/codex-rs/ext/skills/src/catalog_prompt.rs) | 入口读完整、参考资料按任务路由读取、避免重复全文注入 |
| [上下文压缩](https://github.com/openai/codex/blob/a07c8ebd57feedc4cf5dfe854c8e9101de54186b/codex-rs/core/src/compact.rs) | 使用实际模型预算，保留当前目标和有效近期上下文 |
| [压缩状态](https://github.com/openai/codex/blob/a07c8ebd57feedc4cf5dfe854c8e9101de54186b/codex-rs/tui/src/chatwidget/compaction.rs) | 压缩具有独立的活动状态和耗时 |
| [活动展示](https://github.com/openai/codex/blob/a07c8ebd57feedc4cf5dfe854c8e9101de54186b/codex-rs/tui/src/chatwidget/activity_presentation.rs) | 当前活动与历史细节分开，紧凑展示运行信息 |
| [事件协议](https://github.com/openai/codex/blob/a07c8ebd57feedc4cf5dfe854c8e9101de54186b/codex-rs/protocol/src/protocol.rs) | 推理摘要、正文、工具活动使用独立事件 |

不照搬 Codex 的任意 Shell、绝对路径输出、来源权限或执行环境。Skill 文件、推理文本和参考资料均不能改变本应用的 Policy。

## 已确认的不足

1. `skill_load`、`skill_read_file` 与 MCP `skill_get` 共用每任务 24,000 字符固定额度；单份参考资料可占 20,000 字符。重复内容会再次计费，长文件只返回开头，没有继续游标或段落检索。
2. Skill 额度未使用实际执行消息的剩余 token 预算，压缩后的空间也未反馈给读取额度。当前模型、上下文和工具结果已有独立预算实现，可复用而无需建立另一套配置入口。
3. 流式事件只有正文和工具增量。OpenAI 兼容接口单独返回的推理字段与 Anthropic 的 thinking 内容未进入独立展示；Gemini 的 `thought` 文本未与回答正文区分。
4. `conversationExecutionController` 的错误回调会取消缓冲并把正文替换为通用“处理失败”，已生成内容可能丢失；暂停恢复与真正请求失败的消息状态容易混淆。
5. 时间线已经有阶段和耗时，但压缩没有独立可见状态；恢复按钮随细节折叠，部分状态色和操作色使用浅色主题不易辨认的固定 Tailwind 色。
6. 现有 CI 的 `tests/services/modelRequestTransport.test.ts` 有 3 项断言未反映新的参考图和画幅提示。先核对行为，再更新正确的契约断言，不降低门禁。

## 方案选择

| 方案 | 范围与代价 |
|---|---|
| 分阶段补齐现有 Runtime（推荐） | 保持项目、窗口、权限与持久化边界，针对已确认问题完成机制和体验改进 |
| 先只改 Skill 读取 | 改动较少，对话恢复和过程展示仍需后续实施 |
| 引入独立 Codex 运行时 | 需要重新设计厂商、工具、权限和桌面桥接，本次没有替换运行时的必要 |

## 第一阶段：Skill 按需读取与上下文预算

1. 新增纯读取服务，定义分页结果和只存在内存的任务读取状态；默认每页约 4,000 字符，单页保护上限约 8,000 字符，实际返回还要满足 token 和序列化结果预算。
2. `skill_load`、`skill_read_file` 和 `skill_get` 接受可选游标与限量参数，保留原必需参数；参考资料另支持文字关键词检索，返回命中附近片段和明确的后续位置。未匹配时返回明确结果，不隐式整篇加载。
3. 游标绑定 Skill、相对路径和内容指纹；每次继续仍经现有目录和原生来源授权。资源修改、包停用、更新、授权撤销或跨 Skill 使用游标时明确拒绝。正文按 Unicode 边界切分，不切断代理对。
4. 每轮模型返回工具提案后，按当前项目模型、实际消息和预留空间计算可返回的 Skill 内容预算。同轮并发读取共用预留额度，不能分别认为自己独占全部空间；未知 MCP 客户端窗口使用保守单页预算，不伪造客户端上下文。
5. 同一有效上下文中的重复页面仅返回已读提示和读取元信息；重新读取可显式请求，仍按实际返回量计费。去重状态在压缩、恢复或上下文变更后失效，避免模型拿不到已被压缩掉的资料。
6. 额度不足返回有结构的受限结果及下一步建议，区分上下文空间、Skill 数量和文件失败；需要压缩时衔接现有压缩器，压缩仍失败则保留任务并展示真实原因，不无限循环。
7. 更新模型工具说明：完整阅读选中的 Skill 入口；参考资料按需检索和分页；看到下一游标不能宣称已完整阅读。节点和润色的既有显式展开保持当前语义。

拟新增分页合同（实现时使用领域类型而非组件重复定义）：

```ts
interface SkillReadPage {
  content: string;
  nextCursor?: string;
  complete: boolean;
  alreadyRead: boolean;
  limited: boolean;
  remainingTokens: number;
}
```

## 第二阶段：流式回复、推理内容与恢复

1. 增加独立推理增量事件，解析当前支持协议实际返回的公开推理内容，区分来源；未返回时不推断或生成假过程，不自动开启会增加开销的模型模式。
2. 推理内容不混入回答正文、下一轮模型输入、工具依据或任务摘要；展示采用有界、脱敏的内容，密钥和本地路径不能进入持久化或双窗口消息。
3. 复用 50ms 消息刷新机制处理推理和正文，关联项目、会话、消息和任务；停止或切换后迟到事件不得写入错误消息。两种窗口使用同一主窗口写入链路。
4. 模型轮次按实际事件开始和结束显示，推理展示可折叠，并注明它与执行依据的区别。非 Agent 的普通文本回复也使用相同事件。
5. 出错、暂停、取消时先保存已生成正文，再记录独立错误或恢复提示。`length` 继续保留 partial 回复，本轮工具提案不执行；写入和付费工具不新增自动重试。
6. 压缩输入超限时使用有界材料处理，保留当前目标、用户补充要求与完整近期工具轮次；不静默删除目标或重放已成功写操作。压缩失败仍可在修正模型后继续。

## 第三阶段：对话 UI 和操作反馈

1. 新增推理展示组件，沿用 UI Kit 的容器、按钮、字体和主题 token；过长内容在组件内滚动，支持展开、收起和键盘操作。
2. 活动区显示连接、分析、读取 Skill、调用工具、压缩、整理结果和等待确认等实际阶段；压缩耗时与模型/工具耗时分开，完成后收敛为简洁记录。
3. 暂停和失败时，原因与主要恢复操作保持可见，不要求先展开所有步骤。执行依据仍来自任务 Journal，修正文案中与当前 B/C/MCP 权限矩阵不一致的绝对表述。
4. 状态色、暂停提示、操作按钮和上下文环采用已有语义 token，并同时考虑明暗主题、320/400/600px 面板、长文本和减少动态效果。
5. 保持现有历史阅读位置、最新消息跳转、消息分批渲染和双窗口同步，不重启任务来切换展示形式。

## 候选文件清单

以下为本方案允许的候选范围，按实际实现需要修改，不机械触碰每个文件。新增范围、依赖、文件删除或安全权限变化仍需另行确认。

| 文件 | 目的 |
|---|---|
| 新增 `src/services/chat/skillReadService.ts` | 分页、检索、游标、重复内容与有界读取预算 |
| `src/services/chat/skillCatalog.ts` | 目录预算和任务 Skill 配额衔接 |
| `src/services/chat/tools/skillTools.ts` | 三个读取工具共用分页合同与当前授权 |
| `src/services/chat/toolRegistry.ts` | 只存在运行时的工具响应预算合同 |
| `src/services/chat/agentRoundExecutor.ts` | 实际剩余预算、推理回调与同轮预留 |
| `src/services/chat/agentRuntime.ts` | 压缩与 Skill 状态失效、任务清理 |
| `src/services/chat/contextCompressionService.ts` | 有界压缩输入与真实状态事件 |
| `src/services/chat/agentPromptGuidance.ts` | 分页、完整入口和按需参考资料说明 |
| `src/services/mcp/mcpControlService.ts` | MCP 读取响应与任务缓存清理 |
| `src/types/chat.ts` | 推理、错误和活动展示合同 |
| `src/services/ai/streamParsers.ts` | 推理与正文分流，保留已有工具解析 |
| `src/services/ai/chatApiProtocol.ts` | 非流式公开推理结果分流 |
| `src/services/ai/assistantStream.ts` | 上下文相关提示与事件传递 |
| `src/services/chat/assistantService.ts` | 普通文本流水线的推理回调 |
| `src/services/chat/conversationExecutionController.ts` | 缓冲、正文保留、停止与恢复状态 |
| `src/services/chat/agentLifecycle.ts` | 压缩活动的准确任务关联 |
| `src/services/chat/agentErrorCodes.ts` | 明确的恢复提示 |
| 新增 `src/components/chat/ReasoningPanel.tsx` | 独立、有界的模型推理展示 |
| `src/components/chat/MessageBubble.tsx` | 正文、推理和错误的布局 |
| `src/components/chat/AgentTaskTimeline.tsx` | 活动状态、可见恢复操作和主题色 |
| `src/components/chat/AgentExecutionRationale.tsx` | 执行依据可读性 |
| `src/services/chat/agentExecutionRationale.ts` | 权限说明准确性 |
| `src/components/chat/ContextUsageIndicator.tsx` | 上下文状态语义色 |
| `src/i18n/locales/en-US/chat.ts` | 对话文案 |
| `src/i18n/locales/ja-JP/chat.ts` | 对话文案 |
| `src/i18n/locales/ko-KR/chat.ts` | 对话文案 |
| 新增 `tests/services/chat/skillReadService.test.ts` | 分页、Unicode、游标失效、并发预算与去重 |
| `tests/services/chat/skillCatalog.test.ts` | 配额与任务隔离回归 |
| `tests/services/chat/skillTools.test.ts` | 两种 Skill 来源、MCP 与授权撤销回归 |
| `tests/services/chat/agentRoundExecutor.test.ts` | 预算、推理事件和工具提案守卫 |
| `tests/services/chat/agentConversationContext.test.ts` | 压缩、当前目标和近期轮次回归 |
| `tests/services/chat/conversationExecutionController.test.ts` | 流式异常正文保留、暂停与停止 |
| 新增 `tests/services/assistantReasoning.test.ts` | 各现有协议推理与正文分流 |
| `tests/services/assistantStreamProtocol.test.ts` | 流式传输回归 |
| `tests/services/chatApiProtocol.test.ts` | 非流式结果回归 |
| 新增 `tests/components/agentActivity.test.tsx` | 活动、恢复操作、推理折叠与无推理模型 |
| `tests/components/chatMessages.test.ts` | 消息渲染与历史位置回归 |
| `tests/components/agentExecutionRationale.test.tsx` | 执行依据语义与可读性 |
| `tests/services/chat/detachedChatSyncController.test.ts` | 主/独立窗口同步与迟到事件 |
| `tests/services/modelRequestTransport.test.ts` | 核对并修复当前发布门禁失败 |
| `doc/对话助手-Agent能力实施方案.md` | 简短能力说明与实际验证状态 |
| `doc/文档导航.md` | 当前专项与新发布记录入口 |
| 本文件 | 阶段状态、验收缺口与回滚 |
| 新增 `doc/plans/2026-10-11-release-0.10.5.md` | 发布门禁和远程产物证据 |
| `package.json`、`package-lock.json` | 应用版本，不改变依赖解析 |
| `src-tauri/Cargo.toml`、`src-tauri/Cargo.lock` | 应用包版本，不改变依赖解析 |
| `src-tauri/tauri.conf.json` | 仅应用版本 |
| `.release-notes.md`、`.github/workflows/release.yml` | 发布标题和实际变更说明，保留门禁和权限 |
| `README.md`、`README.en.md`、`README.ja.md`、`README.ko.md` | 发布版本徽章及必要能力说明 |
| `site/index.html`、`site/manual.html` | 版本、下载与真实操作说明 |

## 第四阶段：检查、提交、发布与关机

在用户确认范围并授权本次检查后执行；不复用其他任务的测试授权。

1. 完成每阶段代码、差异和严格 UTF-8 静态核对，记录已实现与待验证范围。
2. 在仓库根目录运行与修改对应的定向 Vitest；实际失败先定位再修复。需要更新现有错误断言时，仍保证运输协议、引用和画幅的契约覆盖。
3. 根目录运行 `npm run ci`（ESLint、应用和测试类型检查、全量 Vitest、前端生产构建）；`src-tauri/` 运行 `cargo check --lib`。若检查产生构建或缓存文件，不纳入功能提交。
4. 有条件时在 Tauri 桌面端进行下节验收；无法实测的原生、双窗口或真实模型行为如实记录，不用 Web 结果代替。
5. 核对最新正式版本和标签，按发布流程同步版本、说明、必要徽章和站点；执行已授权的提交钩子，使用中文提交说明。
6. 推送后等待同一提交的前端与 Rust CI 成功，再创建并推送新的不可变标签；等待发布质量门禁、多平台构建、签名和公开步骤。
7. 核对公开 Release、各平台安装包与签名、`latest.json` 版本和下载地址；记录发布链接及尚未实测的桌面项。
8. 发布成功且本任务文件已保存提交后，按用户要求执行 Windows 正常关机，使用短倒计时，不强制关闭有未保存内容的程序。发布失败或仍在运行时继续处理，不提前关机。

## Tauri 桌面验收

前置条件：已安装更新后的桌面端，配置可用文本模型；准备一个多级 UTF-8 Skill，入口约 12,000 字符、参考资料超过 24,000 字符；另准备可启停的智能体包。真实模型与付费能力的验收只在对应授权下运行。

1. 让助手选用 Skill，观察入口分页；应能继续读到结尾，并按任务检索参考文件中靠后的关键词，不因前几次读取累计 24,000 字符就报文件失败。
2. 重读同一页、改文件后继续旧游标、停用来源后继续读取；分别预期有界去重、游标失效提示和授权拒绝。路径逃逸和跨 Skill 游标仍拒绝。
3. 选择不同上下文模型，执行长工具链；预期页大小服从实际预算，压缩显示独立状态，压缩后可重新读取必需资料，成功写操作不重放。
4. 使用返回推理字段的模型和普通模型；预期前者独立显示实际内容，后者仅显示真实阶段，正文不混入推理内容；停止、重试和继续时内容绑定正确任务。
5. 生成部分回复后制造断网或协议错误；预期已生成正文保留，出现清晰错误与恢复入口；达到输出上限仍保留 partial，本轮工具未执行。
6. 验收暂停、审批、失败、恢复、排队与压缩期间的活动和耗时；折叠细节后主要恢复操作仍可见，用户补充要求按现有规则加入任务。
7. 核对浅色、暗色和窄面板，展开长推理和工具结果；文本可读、不撑宽页面、操作可用键盘完成，减少动态效果生效。
8. 切换会话、项目和独立窗口，观察迟到事件、历史滚动位置与最新消息入口；后台任务继续属于原会话，不因切换展示重启。

## 回滚

按阶段回退本方案的功能改动即可恢复旧行为；不新增数据库 object store、原生命令或权限，也不删除现有 Skill 资料。已发布标签保持不可变，公开后出现问题通过新补丁发布解决。

## 实施状态（2026-10-12）

- 已实现：Skill 单页字符与序列化 token 预算、游标、字面关键词检索、当前上下文去重、显式重读；任务仍限制不同 Skill 数量，取消累计 24,000 字符额度。Agent 同轮共用预算，MCP 使用保守单页预算；来源每次复核，压缩和恢复使去重失效，无可压缩空间时暂停并保留上下文。
- 已实现：OpenAI 兼容 reasoning 字段、Anthropic thinking、Gemini thought 与正文分流；推理展示限制 12,000 字符并脱敏，仅留当前会话内存和窗口快照，不保存到消息数据库、不回传模型或放入任务摘要。未自动开启厂商思考配置。
- 已实现：流式错误、暂停和停止保存收到的正文；关闭缓冲拒绝迟到增量，恢复清理旧错误；真实压缩阶段单独计时，折叠时间线仍可恢复任务，采用主题语义 token。
- 已实现：压缩源中长材料保留两端并明确标注省略；目标与近期完整工具轮次保留，宿主执行摘要和引用继续承担写入去重。无效摘要或仍超限不替换原文。
- 已验证：定向分页、读取权限、推理分流、控制器、活动组件与运输测试；Rust `cargo check --lib` 成功。全量门禁已成功，发布证据见发布专项。
- 待用户验证：真实厂商的思考配置和长任务、Tauri 原生 Skill 来源撤权、双窗口切换与实机主题/滚动。Web/组件检查不能替代桌面验收。

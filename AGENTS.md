# AGENTS.md

本文件适用于 AI Canvas 仓库的代码、配置、脚本、测试与文档。项目使用 Tauri、React、React Flow 和 Zustand。任务从[文档导航](doc/文档导航.md)进入所属模块，按需阅读[开发指南](doc/开发指南.md)和[架构说明](doc/架构说明.md)。依赖版本、目录和注册清单以当前源码为准。

## 开始改动前

- 查找代码、定位定义与引用、追踪调用关系时，优先调用 CodeGraph 的 `codegraph_explore`。工具不可用、索引过期或结果不完整时，用 `rg` 和当前源码补查。
- 先看 `git status --short`，保留用户和其他任务的修改。创建文件前查同名文件，只改任务所需内容。修改 `README.md` 或处理构建产物、缓存须有明确要求。查实现回到源码，不从 `node_modules/`、`dist/`、`src-tauri/target/` 引用生成代码。
- 所有改动的文本都用 UTF-8。含中文的文件先核对原编码，有疑问时说明，写后检查乱码。修改后阅读差异、检查引用；提交前再次确认工作区范围。提交说明用中文，可保留 Conventional Commits 前缀。
- 写代码前判断是单点修复、产品能力、平台能力还是架构收敛。在所属模块和共享层按功能、字段或固定文案查找已有实现，阅读定义和调用方。找不到文件时核对实际目录，不猜路径、接口或运行结果。
- 只合并需要同步维护的业务规则、配置、组件或提示词。保留各入口的字段顺序、默认值、嵌套对象隔离、错误行为和旧数据兼容，以及原有初始化、缓存、渲染和 I/O 时机。仅重组提示词时，逐字节比对展开后的正文、空白和占位符。
- 替换旧入口后检查剩余调用、专属样式和测试替身，保留现行路径的回归覆盖。超出范围的清理另行记录。

## 需要用户确认的改动

| 情形 | 动手前说明并等待确认 |
|---|---|
| 架构收敛，或跨多层的大改动 | 列出范围、影响和回滚方案。跨层改动按可单独验证的小步实施，每步后确认。 |
| 单次改动排除测试文件和多语言词条后仍超过 3 个文件 | 展示**全部**改动文件及摘要。已确认书面阶段方案且实际范围未超出时，无须因文件数量再次确认。 |
| 删除文件、新增 npm / Cargo 依赖、修改 `tauri.conf.json` 安全配置或扩大权限 | 分别确认。删除前查引用和影响，引入依赖说明原因和替代方案，安全配置逐项说明。书面阶段方案不免除这些单独确认。 |
| 把握不足、有多个可选方案或读完源码仍查不清调用链 | 说明已知事实、缺口、拟改文件和风险。有多个方案时比较后推荐其一。 |

用户要求与项目规则冲突时，说明冲突点和具体规则，按项目约定处理。

## 测试、验收与发版

- **默认由用户测试。** 助手只在本次明确授权的范围内运行测试、lint、类型检查、构建、Rust 检查、性能基准或浏览器／Tauri 实机验收。实现、修复、优化、提交、普通推送和其他任务的授权均不构成本次授权。本条优先于其他仓库文档及 Skill 的默认测试要求。
- 代码阅读、引用搜索、`git status`、`git diff`、`git diff --check` 和 UTF-8 核对可自行执行。涉及原生能力、持久化、窗口、文件或隔离运行时时，以 Tauri 桌面验收为准。Web 用于演示和基础交互；缺少 Tauri 时标明纯前端模式的限制。
- 交付时给出前置条件、操作入口和顺序、预期结果、异常与回归项；命令写明目录，Rust 改动给出相应的 `cargo check`、`cargo test`。未运行测试时写明“本次未运行测试，待用户验收”。已获授权时只报告实际命令、结果与缺口。[检查命令与开发环境](doc/开发指南.md)
- 构建或检查失败时，按失败步骤、日志和断言定位，必要时将**本次改动**退到可工作的状态后分步修复。在授权范围内复核。区分本地失败、远端失败、预期故障注入和仍在运行的任务；不得关闭规则、删除有效断言或升级依赖来掩盖失败。
- 提交、普通分支推送和 PR 不启动源码 CI。`scripts/pre-push` 对分支和标签都不装依赖、建快照或运行 CI；禁止用临时跳过标记规避门禁。独立 GitHub Pages 官网／演示保留自动构建部署。
- 正式发版将版本与发布资料放在同一提交，原子推送 `master` 和指向该提交的稳定 `vX.Y.Z` 标签。标签触发远端源码 CI，本地不重复门禁。增量须有最近可信全量祖先，冻结 SHA、模式与检查范围；高风险或范围不可靠时全量。Release 核验同标签、同 SHA、同次尝试的质量证明与产物，证明缺失或失败阻止发布。已发布标签不可改写。证据留在 Actions Summary，避免为补记成功流水再提交推送。[打包与发版流程](doc/打包与发版流程.md)

## 文档与助手记忆

- 按功能归属维护一份主文档。重要行为或边界变化更新模块说明，复杂阶段在 `doc/plans/` 记录范围、状态、回滚、验收步骤和缺口。区分“已实现”“待用户验证”“已验证”。普通小修无需追加完成日志，不抄录对话、逐次命令和重试流水；`doc/history/` 保持冻结。
- [对话助手实施方案](doc/对话助手-Agent能力实施方案.md)只记录内部 Agent、工具策略、上下文、记忆、Skill 和子智能体进度。通过 Agent 或 MCP 调用的业务功能仍归业务模块。产品设计见[对话式画布助手功能方案](doc/对话式画布助手-功能方案.md)。
- Codex 的跨会话记忆用已配置的 `hindsight` MCP。项目标签 `project:ai-canvas-tauri`，全局偏好 `scope:global`。先核对当前指令和源码，只保存必要、脱敏、可追溯的稳定事实，同步提炼完成后才确认写入成功。Windows 服务按需启动，故障查 `F:\.hindsight\记忆库使用说明.md`；不再启动 Cognee，旧数据恢复查 `F:\.hindsight\migrations\20261019-cognee\迁移说明.md`。

## 画布、状态与持久化

- 共享状态经 Store Action 写入，优先用已有 slice；职责独立且有多项 Action 时再新增。画布写入调用 `commitToHistory()`，批量只提交一次。笔记与普通节点共享选择、历史和持久化语义。Agent 写画布核对 `projectId` 与 canvas revision，异步派生结果回写前经过 `canvasDerivationGuard`。[画布与项目](doc/画布与项目模块.md#关键边界)
- 切换项目同步加载项目数据、会话、AgentTask、短剧资产和项目记忆。删除会话清理消息与任务；删除项目清理项目域数据。分集沿用带 `parentId` 的项目记录，素材目录、角色库与项目记忆归 `seriesOwnerId`。删除单集保留共享目录，删除整剧或普通项目时才清理。[角色与短剧资产](doc/角色与短剧资产模块.md)
- 新增 IndexedDB object store 或索引须提升 [DB_VERSION](src/services/indexedDb/schema.ts)，确保旧数据可升级读取。完整外观预设使用 `appearanceThemes`，视频批次使用项目域 `metadata`。视频批次经既有预检和 Runner 提交，先核对项目和物料指纹；提交状态未知时不自动重投。方舟账本沿用 Rust SQLite，导出默认脱敏并保留金额置信度。[文件与存储](doc/文件与存储模块.md#关键边界)
- 跨模块领域类型归 `src/types/`。持久化类型不含函数、运行时控制器、窗口句柄或本地绝对路径。普通配置、IndexedDB、日志、持久化摘要和聊天元数据均不得记录密钥、令牌、绝对路径、grant 路径或完整网页／本地文件正文。

## 组件与界面

- `App.tsx` 管装配和窗口生命周期，`Canvas.tsx` 管画布交互。节点组件管展示与交互，共享生成逻辑归 `services/ai/`。画布笔记沿用现有几何工具与绘制 Hook。任务时间线经 Agent Runtime 改状态，`ChatPanel` 负责对话容器和窗口路由。
- 按当前 `eslint.config.js` 与模块写法开发。渲染所需状态用 state 或 Store，ref 在事件或提交后的 effect 中同步；可直接派生的数据不镜像进 effect。复杂组件用子组件、稳定 selector 或合适的 memo 减少重渲染。共享业务函数归 service／utils，保持 Fast Refresh 导出边界。
- 字段变更核对生产端和消费端的联合类型、可空值和 `system` 主题，复用既有规范化函数；包装异常保留 `cause`。修改 Hook、selector、DOM 读取或订阅时同步读测试桩，区分 SSR 初始快照和客户端当前快照。更名或删除中文文案时按完整 key 检查引用，同步英、日、韩词典。
- 界面先查 [UI Kit](src/styles/ui-kit.css) 和[样式预览](src/components/styleGuide/)。优先用 `ui-*`、Tailwind、`canvas-*` token，用 class 切换视觉状态；紧凑容器优先 `p-2`，普通面板 `p-3`。不新增 `!important`、硬编码颜色或内联 `style.cssText`。公用类只用 `base.css` 变量，变更时在预览中补样例（「关于」连点 logo 四次）。
- `src/index.css` 只聚合 partial，React Flow 覆盖归 `src/styles/reactflow.css`。节点标题按媒体类型沿用语义色。面板兼容深浅主题，多窗口外观共用 `appearanceRuntime`，旧主题字段只作兼容。项目栏和历史悬浮入口保留紧凑命中区、独立的提示线颜色和透明度及减少动态效果支持，隐藏历史时不扫描画布。
- 帮助和引导集中在 `HelpCenterDialog`、`OnboardingDialog` 并懒加载。帮助开关用 `store.ui` 的 `helpOpen`，操作演示复用真实组件和 DOM 构造器。[组件与样式约定](doc/开发指南.md)

## 对话 Agent 与 MCP

- 新工具用 `registerAgentTool()` 注册，声明本地 schema、effect 与授权。`isAvailable` 不能依赖 `context.taskId`，任务级检查放在 `authorize`。提示词、网页、文件、Skill、模型输出、Observation 和 MCP 输入均不能改变本地 Policy、模式或权限。[固定执行边界](doc/对话助手-Agent能力实施方案.md#固定执行边界)
- Plan 只允许 `read`。B 对写入、删除及所有 `media_generation` 调用逐次确认，C 和 MCP 控制会话按固定 Policy 自动执行，包括可产生模型开销的子智能体工具。`user_choice` 在 Plan 拒绝，在 B/C/MCP 都须等待用户作答；MCP 客户端不得调用审批解决接口。只有读操作遇瞬时网络错误可以自动重试，最多 3 次。
- 对话内的图片、视频和音频生成沿用用户本轮显式 `@model{...}` 引用。创建媒体节点与实际调用是两个工具状态。C/MCP 的模型选择和调用按自主模式执行，无须逐次审批。项目记忆只经 `memory_suggest` 和同一套 Policy 写入。
- [任务预算](src/types/agent.ts)约束模型轮次、工具调用数与并发只读数，[子任务限额](src/types/subAgent.ts)按父任务计算。子智能体只读，只使用用户勾选的材料，不写画布或产生会话消息。文件 grant 仅存内存并绑定 `conversationId`，模型只见 grantId 和显示名。任务运行中可转后台，重启后未完成任务只恢复为 `paused`。
- `assistantStream.ts` 处理流式文本和工具调用。消息、任务、工具调用保留 `projectId`、`conversationId`、`taskId`。续聊只带同项目同会话的脱敏历史结果，裁剪保留完整近期轮次；模型因 `length` 截断时保存 partial 回复、暂停并丢弃本轮未执行的工具提案。
- 主窗口 Store 是唯一写入源。独立窗口操作扩展 `ChatAction` 或 `ChatStateSnapshot`，模型目录、草稿和视图用版本化快照／补丁。交接最后一次编辑，切换展示方式不重启任务，不传凭据或完整配置。MCP 请求由主窗口 `mcpControlService.ts` 单点处理，Rust bridge 只管传输、鉴权和请求关联。
- **产品内 MCP 控制桥**默认关闭，手动开启或显式 `mcpAutoStart` 才启动。stdio 仅绑定回环；明文 Streamable HTTP 须用户确认高风险后启用，只用于受信网络或隔离环境。保留 Bearer、Host、同源 Origin、1 MiB 请求上限和有界并发。使用可轮换的 256 位随机令牌。固定令牌仅存 `secret_store` 的 `mcp/token`，存储不可用才回退会话内存。传输鉴权与事件脱敏见模块规范。[MCP 控制](doc/MCP控制模块.md#关键边界)

## 原生、插件与导演台

- 前端文件操作统一经 `fileService.ts` 或 `services/fs/`。原生能力优先用 Tauri Plugin，兼容开发与打包路径，沿用 `lib.rs` 的 `#[path]` 模块名。长传输走 `files/transfer.rs` 并支持进度和取消；ONNX／DirectML 保持在 worker 子进程。
- 自定义 command 的注册与 `src-tauri/permissions/*.toml` 显式权限一致。窗口 capability 和命令内部校验都必须保留；接收路径的命令须由 `path_policy.rs` 验证调用窗口及真实路径。构建失败时修正具体声明，不放宽安全配置。API Key 与 MCP 固定令牌经 `providerSecretService.ts` 交 Rust `secret_store`，不得进入普通配置、消息、归档、事件或日志。
- fs scope、asset scope 和通用路径命令均拒绝 `secrets/`、`agent-private`、`plugin-private` 和 Blender 私有目录；递归读写、删除和归档还须防止通过祖先目录访问。AgentPackage 的 PAX 仅作元数据，解包时校验实际路径与大小，拒绝链接和特殊项。禁止向 Agent/MCP 暴露 `proxy_fetch`、通用 HTTP、任意 Shell 或任意路径读写；网页与厂商文档沿用各自原生读取器，保留协议、DNS/IP、重定向与体积校验。[桌面运行时与安全](doc/桌面运行时与安全模块.md#关键边界)
- 插件执行以原生 registry、私有快照及 `sourceDigest`、`revisionDigest` 为准，任一缺失或损坏即拒绝。执行 IPC 只收插件、双摘要、工具、调用身份和输入。每次原生执行、资源读取、宿主 effect 和写回前复核活动 revision；停用、切换或卸载先撤销租约、清理 grant 和活动 Python 调用。安装／更新按插件 ID 串行执行 `stage → IndexedDB persist → 撤销旧租约 → activate`，不得回退执行 Renderer 提交的源码或 runtime。
- 插件 UI 使用宿主 sandbox iframe 或隔离的专用 WebView，加载前施加严格 CSP。跨界消息须绑定窗口、会话、执行身份与画布上下文，effect 和写回留在主窗口。QuickJS 只获声明的宿主能力，可信 Python 以当前用户权限运行，进程回收不提供 OS 沙箱。Python 暂存、重新启用和回切版本须原生确认。[插件平台](doc/插件平台模块.md#关键边界与当前交互) · [插件开发规范](doc/插件开发规范.md)
- Blender 只接收固定 operation 和应用内资源，运行包清单、大小、SHA-256 与内嵌资源一致。`open-editor` 须恰好生成当前摄影机 PNG 和 `.blend`，由 Rust 验证绑定、文件头、摘要与 Result Manifest。写回核对项目、节点、instanceId、Scene revision 及派生守卫。AI 预演只收白名单 JSON，以不可变项目文件引用保存，禁止模型提供或执行代码，不覆盖 Blender Scene/Manifest。[导演台与 Blender](doc/导演台与Blender模块.md#关键边界)

## 模型与生成

- 新模型和厂商优先扩展共享目录及 Provider adapter，模型和节点可选项同步。参数、UI 和请求映射可配置；特殊鉴权、上传、轮询和解析归 adapter。通用模型走 `GeneralModelConfig`，不加默认媒体模型配置，不在组件散落 modelId 或 provider 分支。Provider 凭据只从运行时 `config.providers` 读取。
- 声明式请求、响应与轮询归 `modelProtocol.ts`，只映射受信变量，禁止执行代码、覆盖鉴权头或改写请求源。图片、视频、音频参考素材统一经 `mediaProviderRegistry.ts` 分发。
- RunningHub 工作流与厂商模型 API 各用自己的 manifest 和 adapter，按 `adapterType` 分流，共享菜单、参数 UI、任务生命周期和结果回填。对话媒体走 `generationRuntime.ts`，节点走既有生成服务。迁移先查现有覆盖，再加配置入口，先验证一个简单用例，新功能沿新入口实施。[模型与生成](doc/模型与生成模块.md#关键边界)

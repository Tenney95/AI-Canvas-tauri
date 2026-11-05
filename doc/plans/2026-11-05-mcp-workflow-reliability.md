# MCP 日常改稿与批量制作可靠性

目标：落实用户确认的生产场景优化，按项实现、中文独立提交；复用既有 Registry、Policy、项目／派生守卫、任务和媒体恢复机制。

不新增依赖、不删除文件、不放松原生权限。实现阶段按仓库默认不运行测试；2026-11-05 用户随后授权提交与测试，自动检查结果见下节，Tauri 实机验收仍待用户完成。只读协议排查结论见 [MCP 控制模块](../MCP控制模块.md)，不替代本轮验收。

## 阶段与状态

| 项 | 范围与源码入口 | 状态 |
|---|---|---|
| 1 | `canvasTools.ts`：区分无筛选与零命中，增加名称精确／包含查找、名称索引和分页；不改变写工具的目标筛选规则 | 已实现，定向自动测试通过，待 Tauri 实机验收 |
| 2 | `canvasTools.ts`：当前节点长字段有界续读、精确原文替换；保留未读文本与原有提示词引用规则 | 已实现，定向自动测试通过，待 Tauri 实机验收 |
| 3 | 调用信封携带可选读取项目与版本，创建任务前及动态加载后核对；`canvasNodeVersion.ts`、`canvasTools.ts`、`shotlistTools.ts` 补完整编辑内容指纹，覆盖 UI 手改不递增版本的情况 | 项目／版本及 3B 内容指纹均已实现，定向自动测试通过，待 Tauri 实机验收；两次扩展范围均已确认 |
| 4 | `canvasTools.ts`、`generationService.ts`、`ai/generateAudio.ts`、`shotlistService.ts`：当前生成的取消信号沿既有 GenerationLease 传到各媒体／文本分支 | 已实现，定向自动测试通过，待 Tauri 实机验收；范围已确认 |
| 5 | `canvasTools.ts`：多个节点分别提交不同 patch，整批先校验、一次历史，逐项回执 | 已实现，定向自动测试通过，待 Tauri 实机验收 |
| 6 | 复用现有 AgentTask／媒体恢复，补付费与批量写的操作编号、幂等键和部分完成回执；不新增平行恢复系统 | 6A 持久绑定／查询及 6B 批量／媒体进度均已实现，定向自动测试通过，待 Tauri 实机验收；11 份源码及计划范围已确认 |
| 7 | `shotlistTools.ts`：按稳定 ID／镜号定点读取及字段投影，保留行／文字续读和原批量写 | 已实现，定向自动测试通过，待 Tauri 实机验收 |

每项仅提交本项源码、测试与计划状态；其他任务的共享资产／存储改动保留。涉及超过三份非测试／非多语言文件时，按仓库规则另行列明范围确认。

## 验收与回退

- 第 1 项：Tauri 打开含超过 50 个节点和重名镜头的测试项目，通过 MCP 查询不存在 ID／名称，应返回零匹配；按可见名称、文件别名或内部名称查找应列出候选；分页不重复／漏项，不返回无关节点与媒体路径。组合 ID／类型／名称使用交集。取消或切换项目后旧查询失效。
- 第 2／3 项：长提示词修改末句，其余原文保留；原文多次匹配、读后人工编辑或切项目均明确拒绝，重新读取后才可继续，不自动重投写入。
- 长字段合同：`canvas_query` 使用显式 `nodeIds`／`displayIds` 恰好定位一项，指定 `textField: "prompt" | "output"` 后只返回该字段原文片段；`textOffset/nextOffset` 为 UTF-16 偏移，保持字段不变直到 `nextOffset: null`。单段最多 4000 代码单元，实际 JSON 超过 18K 时缩小，不能切开代理项对；媒体节点的 `output` 路径不可读。`canvas_update_nodes.promptEdit` 只替换唯一的 `oldText`，`newText` 可为空；不与整段 `prompt` 混用，不切入引用令牌，范围外原文和引用不变，存量长文不截断。多目标先整批验证，再一次历史提交。
- 读取后写入使用 `tools_call` 信封的 `expectedProjectId/expectedRevision`（与 name、arguments 同级），值来自刚读取的项目与版本；提供 revision 时必须同时提供 projectId。首次核对不匹配时不创建执行任务，动态加载后变化也不执行；冲突明确要求重读，写入不自动重试。实际业务参数不会收到这两个字段。不带前置条件的旧客户端继续兼容，直接原名调用仍沿原守卫；需要跨请求保护的客户端应使用带前置条件的信封。
- UI 内容指纹：普通手工修改不一定增加全局 revision，`canvas_query(detail=true)` 的每个节点、`textField` 续读及 `shotlist_read` 的整张表返回 `nodeHash`。单目标 `canvas_update_nodes` 可传 `expectedNodeHash`，异构 `updates` 每个 `patch` 各传自己的指纹；`shotlist_update_rows` 在顶层传整表指纹。配合项目／版本信封使用，任一目标不匹配整批拒绝；不带指纹保持兼容。不改变 Store 的版本语义。摘要包含完整编辑文字、项目／设置、名称、位置、尺寸和生成输入，排除运行状态与媒体产物，不缓存或持久化完整原文。读取期间、摘要期间和后续文件准备期间发生变化均拒绝混用旧快照。
- 内容指纹验收：读取长提示词／分镜表后在 UI 改末句或任一镜头，再使用旧指纹修改，应明确拒绝且不改任何目标；重新读取后成功。批量第二项指纹冲突时第一项也不改，成功批次只增加一次历史。生成进度或媒体地址更新不应使编辑指纹失效。无指纹的旧调用、原生成租约与文件保存行为回归保留。
- 第 4 项：不依赖付费任务验证取消；用定向用例检查同一个 signal 贯穿图片、批量图片、全景、视频、音频、文本、导演预演和分镜分支。取消只停止本地执行／跟踪，不承诺撤回已提交的服务商任务。
- 当前节点的生成输入快照与项目绑定租约，不用生成自身会改变的全局 revision 杀掉本批。取消／租约失效后仅当前 owner 收回 loading；旧请求不清新请求状态。音频二进制已开始写入时不删除文件，只阻止取消后的交付，原服务商回执及待保存任务继续保留。
- 第 5／6 项：不同节点异构修改一次历史；任一准备失败不得先改一部分。中断后可按操作号查询已完成／未开始项，同 key 不重复提交付费工作。
- 异构入口：`canvas_update_nodes.updates` 每项为 `{nodeId, patch}`，最多 50 项；不与顶层筛选／普通补丁／特殊修复混用，重复或缺失 ID 整批拒绝。共用单补丁校验、先准备全部文件基线，再一次历史与 revision 应用；同一规范文件路径请求不同正文时拒绝。写后文件保存不能与画布原子提交，失败保留全部草稿并逐项报告，禁止自动重投；旧顶层单补丁沿既有冲突保留草稿语义。
- 操作绑定：当前项目的 `canvas_write`／`media_generation` 可在 `tools_call` 信封携带 `operationKey`，与 `name/arguments` 同级。同项目、同 key、同工具和输入只查原回执，改输入则冲突；只有新占位通过持久化事务后才执行业务。原写入推进 revision 后，旧 key 仍可只读查询；项目不匹配仍拒绝。`mcp_operation_get` 的 `arguments` 仅传 `operationKey` 或返回的 `operationId` 之一。首个响应保留普通业务结果，回查只返回安全状态及身份，`resultAvailable:false` 不代表工作未完成。
- 操作验收：Tauri 测试项目先以固定 key 修改节点，再用原输入和原读取版本重查，应只有一份任务且不再次写入；修改输入应报 key 冲突，切项目不能查到旧项目回执。删除原任务／会话后同 key 不重建任务；重启未完成工作只报未知并引导只读核实，不能自动重投付费工作。持久化占位失败时不得启动业务。仅保存摘要身份和安全回执，不保存原 key、参数正文或完整业务结果；整项目删除可清理项目绑定，普通任务删除保留墓碑。未带 key 的旧调用继续兼容。
- 逐项回执合同：带 key 的 `canvas_run_nodes` 保留完整目标清单，每次进入生成前先持久化 `started`，结果立即逐项保存；中断后已完成／失败不回退，其余区分未开始与不确定。异构节点更新的画布提交仍只有一次历史，文件保存进度分别记录，不能把“文件未保存”解释为“画布未修改”。`media_generate` 的 `mediaStage` 区分 `preparing/started/generated/delivered`，`started` 仅表示进入本地调用，不证明服务商受理；安全回执保留消息、节点与产物身份，不新增厂商任务恢复入口。保存、交付或回执不完整时只读核实，已生成产物与原媒体恢复身份继续保留。
- 逐项验收：使用可控生成桩让多节点第一项完成、第二项挂起后取消，回查第一项仍完成、第二项不确定、其余未开始；不发起真实付费重投。媒体等待回执持久化时取消、切项目或手改占位节点，不得继续调用／覆盖新稿；生成后发生这些变化，应保留原产物并标明交付缺口。异构文本文件第一项保存后中断，已存项和草稿都保留，回执列明剩余缺口；同 key 只查询。普通无 key 生成不新增回执持久化等待。进度、身份和终态按持久化事务单调合并。
- 已知提交版本随结果登记，不借用后来编辑或其他项目的 revision；结果后的回执失败／取消仍保留原提交版本。画布提交后的回执等待也不能把后来版本重新当作文件保存基线。生成租约因手改失效而本地取消时，即使 signal 未中止且无异步服务商任务，也按不确定结果核实。
- 第 7 项：读取分散镜号、重复镜号、不存在 ID、交集、字段空数组、长对白续读；未请求的大字段不诱发续读，身份与绑定不串镜。

定向命令在仓库根目录由用户执行：第 1 项 `npx vitest run tests/services/chat/canvasTools.test.ts`；第 2 项 `npx vitest run tests/services/chat/canvasPromptEditing.test.ts`；第 3 项 `npx vitest run tests/services/mcp/mcpToolCatalog.test.ts tests/services/mcp/mcpControlService.test.ts tests/services/chat/agentToolExecution.test.ts`；第 3B 项 `npx vitest run tests/services/chat/canvasNodeVersion.test.ts tests/services/chat/canvasPromptEditing.test.ts tests/services/chat/canvasBatchUpdates.test.ts tests/services/chat/shotlistTools.test.ts`；第 4 项 `npx vitest run tests/services/chat/canvasRunNodesLease.test.ts tests/services/generationServiceReplicaLease.test.ts tests/services/chat/canvasTools.test.ts`；第 5 项 `npx vitest run tests/services/chat/canvasBatchUpdates.test.ts tests/services/chat/canvasTools.test.ts tests/services/chat/canvasPromptEditing.test.ts`；第 6A 项 `npx vitest run tests/services/mcp/mcpOperationService.test.ts tests/services/mcp/mcpControlService.test.ts tests/services/mcp/mcpToolCatalog.test.ts tests/services/chat/agentTaskService.test.ts`；第 6B 项 `npx vitest run tests/services/mcp/mcpOperationService.test.ts tests/services/chat/canvasRunNodesLease.test.ts tests/services/chat/canvasBatchUpdates.test.ts tests/services/chat/mediaTools.test.ts`；第 7 项 `npx vitest run tests/services/chat/shotlistTools.test.ts`。上述入口保留供复验。回退使用对应阶段的独立提交，不回滚项目数据或凭据。

## 自动检查记录（2026-11-05）

用户授权后，在仓库根目录实际执行：

- `npx --no-install vitest run`，参数为上方各项测试文件去重后的 13 个完整路径：490 个用例全部通过，退出码 0，无未处理异步错误。
- `npm run typecheck`、`npm run test:typecheck`：均退出码 0；测试文件调整后已复跑测试类型检查。
- `npx --no-install eslint <本轮 30 份源码／测试文件> --max-warnings=0`：退出码 0；两个调整的测试文件已再次单独检查通过。

验证中修正了两处测试准备时序：文件读取竞态用例等待真实读取开始后才模拟并发修改，并提前挂接拒绝断言；操作回执用例把完整 Store 的冷导入移至 `beforeEach`。保留真实 IndexedDB 并发事务、模块／数据库隔离及原有保护断言，没有修改生产源码、测试超时或重试策略。

以上为定向前端自动检查，不等于全量 CI 或桌面验收。本次未执行生产构建、Rust 检查或 Tauri／真实 MCP 客户端交互验收；手工改稿、跨项目、断连／重启和真实媒体任务场景仍按上方步骤验收。未推送。

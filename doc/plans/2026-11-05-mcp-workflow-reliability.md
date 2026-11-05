# MCP 日常改稿与批量制作可靠性

目标：落实用户确认的生产场景优化，按项实现、中文独立提交；复用既有 Registry、Policy、项目／派生守卫、任务和媒体恢复机制。

不新增依赖、不删除文件、不放松原生权限。本轮默认不运行测试、检查、构建或实机验收；用例留给用户执行。只读协议排查结论见 [MCP 控制模块](../MCP控制模块.md)，不替代本轮验收。

## 阶段与状态

| 项 | 范围与源码入口 | 状态 |
|---|---|---|
| 1 | `canvasTools.ts`：区分无筛选与零命中，增加名称精确／包含查找、名称索引和分页；不改变写工具的目标筛选规则 | 已实现并补用例，待用户验收 |
| 2 | `canvasTools.ts`：当前节点长字段有界续读、精确原文替换；保留未读文本与原有提示词引用规则 | 已实现并补用例，待用户验收 |
| 3 | `types/mcp.ts`、`mcpToolCatalog.ts`、`mcpControlService.ts`、`agentToolExecution.ts`：调用信封携带可选读取项目与版本，创建任务前及动态加载后核对，沿用执行中守卫 | 已实现并补用例，待用户验收；范围已确认 |
| 4 | `canvasTools.ts`、`generationService.ts`、`ai/generateAudio.ts`、`shotlistService.ts`：当前生成的取消信号沿既有 GenerationLease 传到各媒体／文本分支 | 已实现并补用例，待用户验收；范围已确认 |
| 5 | `canvasTools.ts`：多个节点分别提交不同 patch，整批先校验、一次历史，逐项回执 | 已实现并补用例，待用户验收 |
| 6 | 复用现有 AgentTask／媒体恢复，补付费与批量写的操作编号、幂等键和部分完成回执；不新增平行恢复系统 | 6A 持久绑定／查询实施中，6B 逐项进度随后；11 份源码及计划范围已确认 |
| 7 | `shotlistTools.ts`：按稳定 ID／镜号定点读取及字段投影，保留行／文字续读和原批量写 | 已实现并补用例，待用户验收 |

每项仅提交本项源码、测试与计划状态；其他任务的共享资产／存储改动保留。涉及超过三份非测试／非多语言文件时，按仓库规则另行列明范围确认。

## 验收与回退

- 第 1 项：Tauri 打开含超过 50 个节点和重名镜头的测试项目，通过 MCP 查询不存在 ID／名称，应返回零匹配；按可见名称、文件别名或内部名称查找应列出候选；分页不重复／漏项，不返回无关节点与媒体路径。组合 ID／类型／名称使用交集。取消或切换项目后旧查询失效。
- 第 2／3 项：长提示词修改末句，其余原文保留；原文多次匹配、读后人工编辑或切项目均明确拒绝，重新读取后才可继续，不自动重投写入。
- 长字段合同：`canvas_query` 使用显式 `nodeIds`／`displayIds` 恰好定位一项，指定 `textField: "prompt" | "output"` 后只返回该字段原文片段；`textOffset/nextOffset` 为 UTF-16 偏移，保持字段不变直到 `nextOffset: null`。单段最多 4000 代码单元，实际 JSON 超过 18K 时缩小，不能切开代理项对；媒体节点的 `output` 路径不可读。`canvas_update_nodes.promptEdit` 只替换唯一的 `oldText`，`newText` 可为空；不与整段 `prompt` 混用，不切入引用令牌，范围外原文和引用不变，存量长文不截断。多目标先整批验证，再一次历史提交。
- 读取后写入使用 `tools_call` 信封的 `expectedProjectId/expectedRevision`（与 name、arguments 同级），值来自刚读取的项目与版本；提供 revision 时必须同时提供 projectId。首次核对不匹配时不创建执行任务，动态加载后变化也不执行；冲突明确要求重读，写入不自动重试。实际业务参数不会收到这两个字段。不带前置条件的旧客户端继续兼容，直接原名调用仍沿原守卫；需要跨请求保护的客户端应使用带前置条件的信封。
- 第 4 项：不依赖付费任务验证取消；用定向用例检查同一个 signal 贯穿图片、批量图片、全景、视频、音频、文本、导演预演和分镜分支。取消只停止本地执行／跟踪，不承诺撤回已提交的服务商任务。
- 当前节点的生成输入快照与项目绑定租约，不用生成自身会改变的全局 revision 杀掉本批。取消／租约失效后仅当前 owner 收回 loading；旧请求不清新请求状态。音频二进制已开始写入时不删除文件，只阻止取消后的交付，原服务商回执及待保存任务继续保留。
- 第 5／6 项：不同节点异构修改一次历史；任一准备失败不得先改一部分。中断后可按操作号查询已完成／未开始项，同 key 不重复提交付费工作。
- 异构入口：`canvas_update_nodes.updates` 每项为 `{nodeId, patch}`，最多 50 项；不与顶层筛选／普通补丁／特殊修复混用，重复或缺失 ID 整批拒绝。共用单补丁校验、先准备全部文件基线，再一次历史与 revision 应用；同一规范文件路径请求不同正文时拒绝。写后文件保存不能与画布原子提交，失败保留全部草稿并逐项报告，禁止自动重投；旧顶层单补丁沿既有冲突保留草稿语义。
- 第 7 项：读取分散镜号、重复镜号、不存在 ID、交集、字段空数组、长对白续读；未请求的大字段不诱发续读，身份与绑定不串镜。

定向命令在仓库根目录由用户执行：第 1 项 `npx vitest run tests/services/chat/canvasTools.test.ts`；第 2 项 `npx vitest run tests/services/chat/canvasPromptEditing.test.ts`；第 3 项 `npx vitest run tests/services/mcp/mcpToolCatalog.test.ts tests/services/mcp/mcpControlService.test.ts tests/services/chat/agentToolExecution.test.ts`；第 4 项 `npx vitest run tests/services/chat/canvasRunNodesLease.test.ts tests/services/generationServiceReplicaLease.test.ts tests/services/chat/canvasTools.test.ts`；第 5 项 `npx vitest run tests/services/chat/canvasBatchUpdates.test.ts tests/services/chat/canvasTools.test.ts tests/services/chat/canvasPromptEditing.test.ts`；第 7 项 `npx vitest run tests/services/chat/shotlistTools.test.ts`。其他项随实现补入准确文件。当前未执行任何测试。回退使用对应阶段的独立提交，不回滚项目数据或凭据。

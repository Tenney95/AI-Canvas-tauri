# ADR-0001: Agent 快捷指令采用分步调用协议

## Status

Accepted

## Context

对话 Agent 需要查询、创建、修改和调用用户快捷指令。现有高级快捷指令会一次创建整条节点链并顺序执行，但 Agent 权限矩阵要求画布写入遵循 B/C 模式，图片、视频和音频生成每次都必须单独确认，所有写入和付费操作不得自动重试。

一个直接包装 `runPresetSequence()` 的 `preset_run` 工具只会产生一次审批，却可能触发多次媒体生成，因而会绕过逐次确认。快捷指令还必须限制在当前项目和当前 Agent 任务中，不能成为执行任意节点的旁路。

## Decision

采用两阶段协议：

1. `preset_start_run` 只解析快捷指令、校验参数并在画布创建运行节点，不调用模型。它属于 `canvas_write`，执行前校验当前项目和 canvas revision。
2. 运行节点带有快捷指令 ID、运行 ID、Agent task ID、步骤序号和总步骤数。后续工具只能执行属于当前任务的运行节点。
3. `preset_run_text_step` 只执行一个文本节点，属于 `canvas_write`。
4. `preset_run_media_step` 只执行一个图片、视频或音频节点，属于 `media_generation`，每次都经过现有审批。
5. 每个步骤必须等待前序节点成功；失败结果返回模型，由模型停止或重新规划。写入和生成工具均不自动重试。
6. 快捷指令定义读取属于 `read`；创建和修改持久化配置属于 `file_write`，始终要求确认。

## Consequences

### Positive

- 复用现有 Tool Registry、Policy Engine、Store CRUD、模板渲染和节点生成服务。
- 高级快捷指令中的每次媒体生成都有独立审批记录。
- revision 和 task 归属校验阻止旧提案或其他任务执行运行节点。
- 快捷指令失败可以作为 Observation 返回模型继续规划。

### Negative

- 高级快捷指令需要多轮模型工具调用，消耗更多工具轮次。
- 文本和媒体步骤需要两个工具 ID，模型必须按返回的 `nextTool` 调用。
- 现有节点生成服务不接收 AbortSignal，生成开始后的供应商请求仍沿用当前画布行为。

### Neutral

- 界面内原有快捷指令运行流程保持不变。
- 不提供 Agent 删除快捷指令能力；删除仍由用户在管理界面完成。

## Alternatives Considered

**用一个 `preset_run` 工具执行完整序列**

- 拒绝：一次审批可能包含多次媒体生成，违反逐次确认要求。

**让模型读取快捷指令后自行拼装普通画布工具**

- 拒绝：会重复模板、参数、模型继承和节点布局逻辑，且无法可靠约束执行顺序。

**新增复合工具专用 Policy effect**

- 拒绝：需要扩展审批类型和 UI，但仍无法表达复合调用中每个媒体步骤的独立批准。

## References

- `doc/对话助手-Agent能力实施方案.md`
- `src/services/chat/policyEngine.ts`
- `src/services/presetSequenceService.ts`

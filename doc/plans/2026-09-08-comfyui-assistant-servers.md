# ComfyUI 助手多服务器支持

## 范围与状态

用户要求继续优化 ComfyUI。本阶段助手多服务器代码已完成，定向回归通过；整仓类型检查受工作区其他改动阻断，真实服务验收未执行。主文档：[ComfyUI 工作流集成说明](../ComfyUI工作流集成说明.md)。

- 从已有设置列出服务器，通过 serverId 选择发现和校验目标；省略时沿用默认服务器。
- 校验凭证绑定服务器 ID 和当时地址，执行不接受临时地址或重新指定服务器。
- 生成后的保存凭证保留目标；保存的工作流延续 serverId。
- 配置删除或地址变化使旧凭证不可用于提交/保存，不回落到另一台服务器。
- 缓存按实际地址隔离，失败请求可重新读取；工具摘要只返回服务器名称和 ID。

## 文件与验证

- 服务：comfyServers.ts、comfyAgentService.ts、chat/tools/comfyTools.ts。
- 回归：comfyAgentService.test.ts、chat/comfyTools.test.ts，以及既有服务器绑定测试。
- ComfyUI、工作流持久化、Tool Registry 与 MCP 回归：19 个测试文件、204 项通过，覆盖服务器路由、配置变化、默认兼容、缓存隔离及保存绑定。
- 本批五个代码/测试文件的定向 ESLint 通过；七个源码/测试/文档文件的严格 UTF-8、乱码扫描、文档相对链接与差异检查通过。
- `npm run typecheck` 和 `npm run test:typecheck` 已执行，因并行 RunningHub 接入的类型与任务分派错误而失败；最后一次测试类型检查剩 4 条错误，位于 runninghubClient.ts、pollManager.ts 和 runninghubWorkflowService.ts，本批文件未报告错误。整仓编译验收仍待这些改动完成后复查。
- 不启动应用/ComfyUI，不执行真实生成；不改现有工具 effect 或审批矩阵。

## 回滚与边界

仅撤销本批源码、测试和文档差异。复用既有 serverId，无依赖或数据库升级。撤回代码不会删除已保存工作流；旧助手恢复为仅使用默认服务器。普通工作流原有的已删除绑定回落策略不在本阶段改变。

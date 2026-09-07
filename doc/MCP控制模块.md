# MCP 控制

负责外部 MCP 客户端连接、工具发现、控制会话、请求桥接和返回结果。具体业务工具复用内部 Registry、Policy 与宿主服务。

## 主要入口

| 入口 | 职责 |
|---|---|
| [mcpControlService.ts](../src/services/mcp/mcpControlService.ts) | 主窗口工具发现、控制请求和任务映射 |
| [services/mcp](../src/services/mcp/) / [types/mcp.ts](../src/types/mcp.ts) | 前端桥接、会话配置及协议类型 |
| [原生 mcp](../src-tauri/src/mcp/) | 端口、鉴权、请求关联与双传输 |
| [ai-canvas-mcp.mjs](../scripts/ai-canvas-mcp.mjs) | 本机 stdio 客户端适配器 |

## 关键边界

- MCP 默认关闭，只有手动开启或显式配置自动开启才启动。stdio 使用本机回环桥；Streamable HTTP 的高风险传输确认属于配置授权。
- 两种传输共用 Registry 与 Policy；MCP 按 C 自主模式处理，`user_choice` 仍等待用户作答，不能由客户端替用户解决审批。
- 令牌只由原生凭据存储持久化，不进入普通配置、事件或日志。HTTP 保留 Bearer、Host、Origin、请求体与并发限制；具体常量以当前原生源码为准。
- 工具必须在发现阶段可见，并在执行阶段重新校验上下文。插件窗口、导演台等业务的完整实施记录写入各自模块。

## 验证与资料

- 定向回归：[MCP 控制服务](../tests/services/mcp/mcpControlService.test.ts)。真实 stdio/HTTP 握手、鉴权失败、取消和工具发现验收与 mock 测试分别记录。
- 专项计划：[本机控制桥](./plans/2026-07-24-local-mcp-control-bridge.md)、[全面控制工具](./plans/2026-08-13-mcp-complete-control-implementation.md)、[Streamable HTTP](./plans/2026-08-20-mcp-streamable-http.md)。
- 历史：[本机 MCP](./history/2026-09-07-跨模块实施记录归档.md#mcp-local)、[全面控制](./history/2026-09-07-跨模块实施记录归档.md#mcp-full)、[HTTP 传输](./history/2026-09-07-跨模块实施记录归档.md#mcp-http)。

返回[文档导航](./文档导航.md)。

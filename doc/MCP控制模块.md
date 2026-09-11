# MCP 控制

负责外部 MCP 客户端连接、工具发现、控制会话、请求桥接和返回结果。具体业务工具复用内部 Registry、Policy 与宿主服务。

## 主要入口

| 入口 | 职责 |
|---|---|
| [mcpControlService.ts](../src/services/mcp/mcpControlService.ts) | 主窗口工具发现、控制请求和任务映射 |
| [mcpToolCatalog.ts](../src/services/mcp/mcpToolCatalog.ts) / [mcpDiscoveryTools.ts](../src/services/chat/tools/mcpDiscoveryTools.ts) | 有界目录检索、完整参数读取与 Registry 发现工具注册 |
| [services/mcp](../src/services/mcp/) / [types/mcp.ts](../src/types/mcp.ts) | 前端桥接、会话配置及协议类型 |
| [原生 mcp](../src-tauri/src/mcp/) | 端口、鉴权、请求关联与双传输 |
| [ai-canvas-mcp.mjs](../scripts/ai-canvas-mcp.mjs) | 本机 stdio 客户端适配器 |

## 关键边界

- MCP 默认关闭，只有手动开启或显式配置自动开启才启动。stdio 使用本机回环桥；Streamable HTTP 的高风险传输确认属于配置授权。
- 两种传输共用 Registry 与 Policy；MCP 按 C 自主模式处理，`user_choice` 仍等待用户作答，不能由客户端替用户解决审批。
- 令牌只由原生凭据存储持久化，不进入普通配置、事件或日志。HTTP 保留 Bearer、Host、Origin、请求体与并发限制；具体常量以当前原生源码为准。
- 固定令牌读取失败或格式异常不创建/覆盖条目；确认缺失后使用原生“预期不存在”条件创建，跨进程竞争失败只重读胜出的值。明确不可用或首次写入未确认成功时使用稳定的会话内存令牌，并在设置页标记。初始化复用配置队列并合并同窗口请求；显式轮换携带读取的精确旧值，冲突或读写失败不重启当前 bridge。设置页补读运行状态不创建令牌，优先使用实际启动令牌，忽略过期结果。原生锁及条件写入见[设置可靠性计划](./plans/2026-09-11-settings-reliability/task_plan.md)。
- 业务工具必须能通过当前目录检索，并在执行阶段重新校验上下文；发现结果不代表后续调用已获授权。插件窗口、导演台等业务的完整实施记录写入各自模块。
- 画布连线区分端口与空间排布：`canvas_connect_nodes` 固定右出左入；创建/连接工具同时要求上游放左、下游放右，建议水平间距至少 80 画布单位。连接结果（含已连接分支）及 `canvas_query(detail=true)` 返回实际端口、按分组绝对坐标计算的水平间距与 `layout.warning`。提醒不自动改线或移动用户节点，也不新增审批或硬性禁止有意回绕。

## 按需工具发现

MCP 设置中的「工具发现方式」默认按需加载，对应可选配置 `mcpToolExposure: "compact"`；旧配置缺少该字段时同样使用按需模式。`"full"` 返回全部当前可用业务工具，供已有工具延迟加载能力的客户端使用。两种传输共用此设置。切换后需要在客户端刷新工具列表或重新连接，已有对话的上下文不会自动清除。

| 初始入口 | 使用方式 |
|---|---|
| `tools_search` | 按需求、工具名或类别搜索，默认最多 5 个、上限 8 个；空参数返回类别导航，`detail: "schema"` 可同时读取完整参数 |
| `tools_describe` | 每次读取 1 至 3 个已知工具的完整说明与参数 schema |
| `tools_call` | 通过 `name` 与 `arguments` 提交一个真实工具调用；已取得参数后可直接复用，不必重复搜索 |

目录始终由 Registry 生成，不复制业务 schema，不调用额外模型。搜索摘要默认不携带参数定义；完整目录结果上限 64 KiB，超出时明确报错，不能裁断 JSON。发现结果通过瞬时 MCP 内容通道返回，避开通用模型文本的长度裁剪，不进入消息或任务持久化。

搜索和详情是注册为 `read` 的 MCP 专用工具；`tools_call` 是主窗口解包的传输信封。参数校验、effect、授权、预算、审计与取消均属于真实目标工具，只产生一次业务执行任务；通用入口不标为只读或可重试，不接受递归分发。原工具名直接调用仍兼容，内部对话助手的工具列表保持原有行为。

回退时选择「完整工具列表」并刷新客户端即可，不改变原工具权限或业务数据。

## 验证与资料

- 令牌故障回归：[会话配置](../tests/services/mcpSessionConfig.test.ts)、[设置页状态](../tests/components/mcpControlSettings.test.ts)。覆盖读取失败不覆盖、并发初始化、稳定会话降级、失败轮换保留正在运行的配置和过期查询保护。提示复用 `ui-alert--warning` 的明暗主题变量；未启动真实桌面 bridge 或做主题截图验收。

- 外部资源已补充 `file_import_media_to_canvas`、`canvas_paste_external`、`ui_capture_to_canvas`，均为 `canvas_write`，保留 Plan 拒绝、B 确认、C/MCP 自动执行的既有策略。业务边界见 [文件与存储](./文件与存储模块.md#mcp-资源导入)。`ui_capture_window` 仍是只返回瞬时图像的只读工具；截图过滤器已兼容文本节点，避免 `closest` 调用失败。
- 连线布局反馈：画布工具与 MCP 目录定向测试共 58 项通过，应用/测试类型检查和定向 ESLint 通过；覆盖分组绝对坐标、80 单位边界、已连接请求不重复写入及实际端口返回。实机查询已识别素材位于生成节点右侧造成的回绕；布局提醒不等同于阻止执行。

- 定向回归：[MCP 控制服务](../tests/services/mcp/mcpControlService.test.ts)。真实 stdio/HTTP 握手、鉴权失败、取消和工具发现验收与 mock 测试分别记录。
- 按需目录：[目录测试](../tests/services/mcp/mcpToolCatalog.test.ts)、[设置测试](../tests/components/mcpControlSettings.test.ts)、[适配器测试](../tests/scripts/aiCanvasMcp.test.mjs)。2026-09-07：六个相关测试文件共 107 项通过，应用/测试类型检查与改动文件 ESLint 通过；真实 stdio 客户端经打包资源适配器发现三个入口，并完成带参数检索和画布读取，原名调用兼容也已实测。
- 目录测试快照含 122 个当前可用业务工具，完整定义 76,669 字节、精简定义 2,446 字节，初始体积减少约 96.8%；一次带 schema 的检索结果为 1,505 字节。这是 JSON 的 UTF-8 体积，不代表模型实际 Token 或费用。实机精简目录同为 2,446 字节。
- 本次未切换远程传输，HTTP 端到端与深浅主题实际切换尚未验收；新控件复用既有 `ui-*` 与主题变量。扩展 i18n 检查发现四条既有孤儿词条，未纳入本次修复；已有图片适配器测试的 Vite/shebang 加载问题在临时原生加载配置下验证通过，不据此宣称全仓检查通过。
- 专项计划：[本机控制桥](./plans/2026-07-24-local-mcp-control-bridge.md)、[全面控制工具](./plans/2026-08-13-mcp-complete-control-implementation.md)、[Streamable HTTP](./plans/2026-08-20-mcp-streamable-http.md)。
- 历史：[本机 MCP](./history/2026-09-07-跨模块实施记录归档.md#mcp-local)、[全面控制](./history/2026-09-07-跨模块实施记录归档.md#mcp-full)、[HTTP 传输](./history/2026-09-07-跨模块实施记录归档.md#mcp-http)。

返回[文档导航](./文档导航.md)。

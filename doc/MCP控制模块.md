# MCP 控制

负责外部 MCP 客户端连接、工具发现、控制会话、请求桥接和返回结果。具体业务工具复用内部 Registry、Policy 与宿主服务。

## 主要入口

| 入口 | 职责 |
|---|---|
| [mcpControlService.ts](../src/services/mcp/mcpControlService.ts) | 主窗口工具发现、控制请求和任务映射 |
| [mcpToolCatalog.ts](../src/services/mcp/mcpToolCatalog.ts) / [mcpDiscoveryTools.ts](../src/services/chat/tools/mcpDiscoveryTools.ts) | 有界目录检索、完整参数读取与 Registry 发现工具注册 |
| [mcpSettingsScope.ts](../src/services/mcp/mcpSettingsScope.ts) / [projectTools.ts](../src/services/chat/tools/projectTools.ts) | 应用级审计白名单与启动页项目导航 |
| [services/mcp](../src/services/mcp/) / [types/mcp.ts](../src/types/mcp.ts) | 前端桥接、会话配置及协议类型 |
| [原生 mcp](../src-tauri/src/mcp/) | 端口、鉴权、请求关联与双传输 |
| [ai-canvas-mcp.mjs](../scripts/ai-canvas-mcp.mjs) | 本机 stdio 客户端适配器 |

## 关键边界

- MCP 默认关闭，只有手动开启或显式配置自动开启才启动。stdio 使用本机回环桥；Streamable HTTP 的高风险传输确认属于配置授权。
- 两种传输共用 Registry 与 Policy；MCP 按 C 自主模式处理，`user_choice` 仍等待用户作答，不能由客户端替用户解决审批。
- MCP 进入模型勾选等 `user_choice` 等待时，自动打开助手并切到对应控制对话的消息视图；已独立的助手显示、取消最小化并聚焦原窗口，窗口不可用时回到主窗口面板。后台普通调用不导航，已切换项目或对话的异步窗口结果不抢回焦点。沿用现有 Store Action 与双窗口状态同步，用户仍需亲自选择。
- 令牌只由原生凭据存储持久化，不进入普通配置、事件或日志。HTTP 保留 Bearer、Host、Origin、请求体与并发限制；具体常量以当前原生源码为准。
- 固定令牌读取失败或格式异常不创建/覆盖条目；确认缺失后使用原生“预期不存在”条件创建，跨进程竞争失败只重读胜出的值。明确不可用或首次写入未确认成功时使用稳定的会话内存令牌，并在设置页标记。初始化复用配置队列并合并同窗口请求；显式轮换携带读取的精确旧值，冲突或读写失败不重启当前 bridge。设置页补读运行状态不创建令牌，优先使用实际启动令牌，忽略过期结果。原生锁及条件写入见[设置可靠性计划](./plans/2026-09-11-settings-reliability/task_plan.md)。
- 业务工具必须能通过当前目录检索，并在执行阶段重新校验上下文；发现结果不代表后续调用已获授权。插件窗口、导演台等业务的完整实施记录写入各自模块。
- 画布连线区分端口与空间排布：`canvas_connect_nodes` 固定右出左入；创建/连接工具同时要求上游放左、下游放右，建议水平间距至少 80 画布单位。连接结果（含已连接分支）及 `canvas_query(detail=true)` 返回实际端口、按分组绝对坐标计算的水平间距与 `layout.warning`。提醒不自动改线或移动用户节点，也不新增审批或硬性禁止有意回绕。
- 连线规则前置到按需模式三个入口的描述，以及搜索、类别导航和参数读取结果的首个 `hint`；完整模式的新建节点和镜头制作工具同样前置提示。客户端取得初始工具列表即可看到方向、端口、80 单位间距、自动连线去重与操作前后核对要求。导演制作关系是“分镜表 → 导演台”和“镜头说明 → 导演台”，不反接回分镜表；视频等素材回填仍按各工具合同执行。入口描述由 MCP 目录层补充，业务 schema 仍直接取自 Registry，权限与摘要截断边界不变；客户端需刷新工具列表或重新连接才能取得更新。
- `canvas_connect_nodes` 推荐使用 `sourceIds: [输出节点 ID, ...]` 与一个 `targetId`，每次 1–50 项；旧 `sourceId` 仍兼容，两种来源参数只能提供一种。先校验整批，拒绝缺失节点、自连、素材接收端，以及导演台反接所属分镜表；多源连接复用 Store 批量 Action，拒绝隐藏、折叠分组中的节点和非普通节点。输出列表去重、已有连线跳过；只为实际写入提交一次历史并增加一次 revision。结果返回 `connections` 的实际端口、已有状态和布局提醒，以及 `createdCount`、`skippedCount`（含重复来源和已有线）；单源保留旧的 `sourceId` 与 `layout` 字段。布局提醒继续允许有意回绕，不自动搬动节点。

## 按需工具发现

导演台预演提供 `director_get_previs_schema`、`director_get_previs_scene` 与 `director_set_previs_scene`，仅在 MCP 控制上下文开放。客户端先取得合同和示例，再创建或查询 `ai-director`、选择 `ai-threejs` 并写入 `sceneJson`；读回返回完整场景，未保存时为 `null`。两项读取为 `read`，写入为 `canvas_write`，仍经 Policy 和项目/实例/派生守卫；不执行外部 JS，也不额外调用应用内模型。场景保存后的节点截图由宿主同步，完整合同与验收见[导演模块](./导演台与Blender模块.md)。

`canvas_create_nodes` 与 `canvas_update_nodes` 为视频节点设置 `aspectRatio` 时同步实际视频参数 `seedanceRatio`；`canvas_query(detail=true)` 只报告已显式设置的实际视频比例，旧节点未设时不把画框比例误报为生成比例。多图视频提示词应按 Picture 顺序写入图片节点的 `@{nodeId:label}` 引用；只有连线无法指定参考图顺序。

媒体参数随 MCP 节点创建一起写入：图片支持 `aspectRatio`、`imageSize`、`batchCount`；视频支持 `aspectRatio`、`videoLongSide`（本地工作流长边像素，如 832）、`videoResolution`（API 画质档位，如 720p）、`videoDuration`（分镜小数秒向上取整）；旧调用传数字字符串 `videoResolution: "832"` 时兼容写入长边像素，而不再错误写成 API 档位。音频支持 `audioPurpose`、音色/格式/语速、描述式语音的声音类型/节奏/秒数，以及音乐标题、歌词、BPM、时长与自动歌词开关。三类均可传已配置的 `model` ID；未传的字段才使用项目/模型默认值。`canvas_update_nodes` 对同类字段可更新，`canvas_query(detail=true)` 返回安全的参数摘要；字段传给错误的节点类型或模型 ID 未配置时，在整批写入前拒绝。参考音频通过节点引用/工作流 IO 传入，Qwen 等工作流专属参数仍由工作流配置控制。ComfyUI H3 的帧率由工作流内部 24fps 公式固定，不把通用 `videoFps` 伪装成可独立生效的 MCP 控件。

`canvas_update_nodes` 的 `label` 同步已有 `fileName` 显示别名，修复媒体标题仍显示上传临时文件名的问题；只改变显示名称，不重命名磁盘文件、不改变媒体路径。混合节点批量改名只提交一次历史快照；现有历史系统只撤销结构变化，不撤销名称或提示词，回退名称需再次更新。`canvas_query(detail=true)` 的 `displayLabel` 返回文件名别名优先的标题，供客户端核对可见名称；`label` 保持内部名称字段。

MCP 设置中的「工具发现方式」默认按需加载，对应可选配置 `mcpToolExposure: "compact"`；旧配置缺少该字段时同样使用按需模式。`"full"` 返回全部当前可用业务工具，供已有工具延迟加载能力的客户端使用。两种传输共用此设置。切换后需要在客户端刷新工具列表或重新连接，已有对话的上下文不会自动清除。

| 初始入口 | 使用方式 |
|---|---|
| `tools_search` | 按单个需求、工具名或类别搜索，默认每页最多 5 个、上限 8 个；`offset` 默认 0，用返回的 `nextOffset` 继续。空参数返回类别导航，`detail: "schema"` 可同时读取完整参数 |
| `tools_describe` | 每次读取 1 至 3 个已知工具的完整说明与参数 schema |
| `tools_call` | 通过 `name` 与 `arguments` 提交一个真实工具调用；已取得参数后可直接复用，不必重复搜索 |

目录始终由 Registry 生成，不复制业务 schema，不调用额外模型。搜索摘要默认不携带参数定义；`descriptionTruncated` 标记说明是否被裁切，值为 `false` 也不表示摘要包含参数。调用前用 `detail: "schema"` 或 `tools_describe` 读取完整定义，已知参数可直接复用。完整目录结果上限 64 KiB，超出时明确报错，不能裁断 JSON。发现结果通过瞬时 MCP 内容通道返回，避开通用模型文本的长度裁剪，不进入消息或任务持久化。

搜索结果页保留 `total` 为当前匹配工具总数，新增 `returned`、`hasMore`，仅有后续结果时返回 `nextOffset`。翻页时保持 `query/category` 不变；每页重新读取当前可用工具，不承诺跨项目或配置变动的固定快照。`offset` 超出当前匹配范围时返回空页和从 0 重查的提示；无 query/category 的类别导航不分页，仅允许省略 offset 或传 0。类别导航和 `tools_describe` 不返回分页字段。

多步骤需求应拆开检索，少量匹配或零匹配不能证明能力缺失；先查看类别并逐页浏览。工具说明遵循现有 Policy：生成节点在 Plan 模式拒绝、B 模式确认、C/MCP 自动执行。`canvas_query(detail=true)` 优先报告实际视频、音频、图片或正文，缩略图只作为无主产物时的图片预览；仅有节点类型或成功状态不会被当作产物证据，视频是否可解码仍需媒体探测工具验证。阶段记录见[发现与结果准确性优化](./plans/2026-09-11-mcp发现与结果准确性优化.md)。

搜索和详情是注册为 `read` 的 MCP 专用工具；`tools_call` 是主窗口解包的传输信封。参数校验、effect、授权、预算、审计与取消均属于真实目标工具，只产生一次业务执行任务；通用入口不标为只读或可重试，不接受递归分发。原工具名直接调用仍兼容，内部对话助手的工具列表保持原有行为。

回退时选择「完整工具列表」并刷新客户端即可，不改变原工具权限或业务数据。

## 媒体输入与视频制作工具

| 能力 | 工具与边界 |
|---|---|
| 图片上传 | `file_media_upload`（`file_write`）按 begin/append/finish/status/cancel 管理 PNG/JPEG/WebP；固定 256 KiB 分块与链式摘要，完成后由批量导入领取。仅 MCP 会话可用。 |
| 批量导入 | `file_import_media_to_canvas`（`canvas_write`）一次 1–20 项，每项使用已授权 path 或同会话 uploadId；准备成功后批量写入一次历史。 |
| 系统内容与截图 | `canvas_paste_external` 和 `ui_capture_to_canvas` 写入画布；只查看主窗口图像仍用只读 `ui_capture_window`。 |
| 剪辑工程 | `video_editor_list` / `video_editor_get` 读取；`video_editor_create` / `video_editor_update` 为 `file_write`，更新携带 expectedVersion，tracks 完整替换。仅当前项目的 MCP 会话可用。 |
| 后台合成 | `video_editor_export` / `video_editor_export_cancel` 为 `canvas_write`，`video_editor_export_status` 只读。requestKey 与版本约束避免同任务重复启动；返回 jobId 后须查询完成。 |
| 验片 | `video_media_probe` 只读探测真实媒体参数；`video_media_extract_frames` 按 1–6 个递增时间点返回瞬时图像，不持久化图像正文。 |

以上为工具摘要，调用前通过发现接口读取完整 schema。上传的会话、项目、revision、十分钟空闲失效及一次性消费由媒体服务控制；传输鉴权不能代替本地路径授权。分块字节与原始路径不进入审计摘要。

剪辑控制当前最多 300 秒、8 轨、120 片段、1080p 等像素面积、60 fps。人工剪辑窗口打开时拒绝后台修改/导出；导出期间复核工程、素材和画布，任务状态仅在应用会话内保留。工具受理不等于文件已完成；抽帧也不等于声音和剪辑质量验收。

用户步骤见[说明书：MCP](../site/manual.html#mcp-discovery)。业务实现与实机验收分别见[图片上传计划](./plans/2026-09-11-mcp图片上传导入.md)、[视频制作计划](./plans/2026-09-11-mcp-video-production/task_plan.md)及[文件与存储](./文件与存储模块.md#mcp-资源导入)。

## 验证与资料

- 令牌故障回归：[会话配置](../tests/services/mcpSessionConfig.test.ts)、[设置页状态](../tests/components/mcpControlSettings.test.ts)。覆盖读取失败不覆盖、并发初始化、稳定会话降级、失败轮换保留正在运行的配置和过期查询保护。提示复用 `ui-alert--warning` 的明暗主题变量；未启动真实桌面 bridge 或做主题截图验收。

- 外部资源已补充 `file_import_media_to_canvas`、`canvas_paste_external`、`ui_capture_to_canvas`，均为 `canvas_write`，保留 Plan 拒绝、B 确认、C/MCP 自动执行的既有策略。业务边界见 [文件与存储](./文件与存储模块.md#mcp-资源导入)。`ui_capture_window` 仍是只返回瞬时图像的只读工具；截图过滤器已兼容文本节点，避免 `closest` 调用失败。
- 连线布局反馈：画布工具与 MCP 目录定向测试共 58 项通过，应用/测试类型检查和定向 ESLint 通过；覆盖分组绝对坐标、80 单位边界、已连接请求不重复写入及实际端口返回。实机查询已识别素材位于生成节点右侧造成的回绕；布局提醒不等同于阻止执行。

- 定向回归：[MCP 控制服务](../tests/services/mcp/mcpControlService.test.ts)。真实 stdio/HTTP 握手、鉴权失败、取消和工具发现验收与 mock 测试分别记录。
- 模型选择自动导航已实现，新增主面板、独立窗口、窗口失效、项目切换与普通后台调用回归；本次未运行测试，待用户验收。桌面验收：关闭助手或停在其他对话/任务中心，由外部 MCP 调用 `provider_models_select`，应自动进入该项目的 MCP 控制对话并显示选择卡；独立窗口最小化时应恢复原窗口，切换项目后旧请求不应抢回对话；查询画布等普通调用应保持当前界面。
- 按需目录：[目录测试](../tests/services/mcp/mcpToolCatalog.test.ts)、[设置测试](../tests/components/mcpControlSettings.test.ts)、[适配器测试](../tests/scripts/aiCanvasMcp.test.mjs)。2026-09-07：六个相关测试文件共 107 项通过，应用/测试类型检查与改动文件 ESLint 通过；真实 stdio 客户端经打包资源适配器发现三个入口，并完成带参数检索和画布读取，原名调用兼容也已实测。
- 2026-09-07 的目录测试快照含 122 个当时可用业务工具，完整定义 76,669 字节、精简定义 2,446 字节，初始体积减少约 96.8%；一次带 schema 的检索结果为 1,505 字节。这是 JSON 的 UTF-8 体积，不代表模型实际 Token 或费用。实机精简目录同为 2,446 字节。
- 本次未切换远程传输，HTTP 端到端与深浅主题实际切换尚未验收；新控件复用既有 `ui-*` 与主题变量。扩展 i18n 检查发现四条既有孤儿词条，未纳入本次修复；已有图片适配器测试的 Vite/shebang 加载问题在临时原生加载配置下验证通过，不据此宣称全仓检查通过。
- 专项计划：[本机控制桥](./plans/2026-07-24-local-mcp-control-bridge.md)、[全面控制工具](./plans/2026-08-13-mcp-complete-control-implementation.md)、[Streamable HTTP](./plans/2026-08-20-mcp-streamable-http.md)。
- 历史：[本机 MCP](./history/2026-09-07-跨模块实施记录归档.md#mcp-local)、[全面控制](./history/2026-09-07-跨模块实施记录归档.md#mcp-full)、[HTTP 传输](./history/2026-09-07-跨模块实施记录归档.md#mcp-http)。

返回[文档导航](./文档导航.md)。


## ComfyUI 默认工作流输入

`workflow_create` / `workflow_update` 支持 `defaultNodes`，可包含 `prompt`、`image`、`video`、`audio`，值为对应 IO 节点 ID。例如 `{"defaultNodes":{"prompt":"19"}}`。默认目标必须存在于执行图且与 IO 类型一致；创建未提供 IO 清单时从执行 JSON 识别。

更新时该对象整体替换，省略则保留，传 `{}` 清空。需要保留其他类型时先 `workflow_get` 再合并后提交。改图导致既有默认目标失效时须同时修正或清空默认值；失败不会写入 Store。此字段仅适用于 ComfyUI，不能改写 RunningHub 或 workflow-api 的参数定义。

默认媒体输入是优先槽而非启用上传的必要条件，所有 ComfyUI 工作流的普通 @ 图片、视频、音频都会按同类引用顺序自动匹配剩余上传槽。规则见 [ComfyUI工作流集成说明](./ComfyUI工作流集成说明.md#6-默认节点-defaultnodes)。

## 启动页项目列表与打开、切换

项目导航通过同一个 Registry、Policy 与审计任务执行。启动页和已打开画布都可发现、调用以下工具；项目创建、删除、设置写入以及画布、文件、媒体工具仍要求已打开项目。

| 工具 | 参数与结果 |
|---|---|
| `project_list` | 可选 `limit`（默认 50，上限 100）、`offset`（默认 0）；返回项目/剧集/分集摘要、`currentProjectId`、`currentRootProjectId`、分页计数及 `nextOffset`。摘要含 ID、名称、类型、剧集归属、时间、`current`、`opened` 和 `openTargetId`，不返回路径、快照或正文 |
| `project_get` | `projectId`；沿用既有安全元数据和项目设置读取 |
| `project_open` / `project_switch` | `projectId`；共用 Store 的保存与加载流程，返回 `requestedProjectId`、`previousProjectId`、实际 `currentProjectId`、`alreadyOpen` 与打开的项目摘要 |

同名项目必须用列表返回的 ID 区分。剧集从启动页默认打开第一集；再次打开当前剧集保留正在编辑的分集，重复打开当前画布不重载。成功后关闭项目库弹窗，切走前保存失败、目标加载失败、请求取消或被其他切换接管均不报告成功。MCP 导航在项目创建、返回启动页、加载和其他切换期间返回忙碌提示，不自动重试写操作。取消信号只保存在运行时，目标读取结束后复核信号与切换序号，防止迟到结果覆盖当前画布。

导航任务归应用级「MCP 全局控制」审计会话，继续使用旧 `mcp-global-settings` 标识以兼容历史；旧会话标题可以保留。仅明确的设置、导航及目录白名单可独立于项目执行，导航不生成画布撤销 checkpoint，也不向其他项目工具授予权限。切换后新画布请求仍绑定实际当前项目；原 stdio/HTTP 鉴权、Policy 与取消协议保持原有边界。完整列表模式客户端需刷新目录或重新连接，按需模式的三个入口保持稳定。

按需调用示例：先用 `tools_search({"category":"project","detail":"schema"})` 读取参数，再依次调用：

```json
{"name":"project_list","arguments":{}}
{"name":"project_open","arguments":{"projectId":"列表返回的项目 ID"}}
{"name":"project_switch","arguments":{"projectId":"另一个项目 ID"}}
```

以上均为 `tools_call` 的参数对象，也兼容直接调用原工具名。列表分页通过瞬时 MCP 内容返回完整 JSON，不把项目列表正文复制进消息或任务摘要。

状态：已实现并补充回归用例，本次未运行测试，待用户验收。Tauri 桌面验收：

1. 准备两个有不同画布内容的项目（可同名）及一个含两集的剧集，在启动页开启 MCP；分别以按需/完整模式发现项目工具。读取列表及分页，检查 ID、归属、打开状态，不应出现目录或快照。
2. 用 `project_open` 打开第一个项目，再用 `project_switch` 切换第二个；检查画布、会话、Agent 任务、角色库与项目记忆。修改画布后切走再返回，确认修改已保存；用 `canvas_query` 核对实际项目内容。
3. 打开剧集应进入第一集；手动切到第二集后再次打开剧集，应留在第二集。重复打开当前项目应返回 `alreadyOpen: true`，不丢失当前编辑。
4. 传入不存在的 ID、错误参数及越界分页值应失败；列表尚在初始化时应明确提示加载中。加载失败或受控保存失败时保留旧画布，不能返回成功；导航忙碌时第二次 MCP 切换不应抢占。取消加载中的原请求后，迟到数据不应切换项目，遮罩应收起。
5. 回归启动页厂商模型选择、全局配置预览/保存、主窗口与独立助手、普通项目会话、stdio/HTTP 请求取消。未打开项目时直接调用画布/项目删除仍应拒绝；打开后新请求绑定新项目。

自动回归入口：`tests/services/chat/projectTools.test.ts`、`tests/services/chat/agentRoundExecutor.test.ts`、`tests/services/mcp/mcpControlService.test.ts`、`tests/store/projects.test.ts`。用户可在仓库根目录运行 `npm run test -- --exclude ".planning/**" tests/services/chat/projectTools.test.ts tests/services/chat/agentRoundExecutor.test.ts tests/services/mcp/mcpControlService.test.ts tests/store/projects.test.ts`；静态类型检查入口为 `npm run typecheck` 与 `npm run test:typecheck`。回滚撤销导航白名单、工具和 Store 切换补丁，无数据库迁移。

## 不依赖项目的模型设置

- 厂商文档读取、模型选择、配置预览及保存通过应用级审计会话执行（旧标题「MCP 全局模型设置」，新会话为「MCP 全局控制」），不需要加载项目，也不随项目切换失效。复用现有 Registry、Policy、AgentTask、审计摘要及凭据存储，不新增旁路保存。
- `mcpSettingsScope.ts` 的保留审计域标识仅用于既有任务/会话关联，不创建或选中 CanvasProject。必须同时匹配会话身份与封闭工具白名单才能独立于项目执行。设置请求仍只使用 `provider_docs_read`、`provider_models_select`、`provider_config_preview`、`provider_config_apply` 及目录发现；项目导航使用独立子白名单。URL 授权、配置冲突检查和本人模型选择仍由原规则约束。
- 未打开项目时 full 与 compact 发现提供厂商设置及上述项目导航能力；打开项目后恢复完整目录，画布/文件/付费生成仍须有效项目。全局选择卡自动打开助手，项目切换保留会话；该审计会话不提供普通对话输入，也不允许恢复为通用模型循环。
- MCP 控制服务初始化时沿用既有中断修复加载全局审计任务；重启后的未完成任务恢复为暂停，不自动续执行。已有审计会话继续沿用，不覆盖历史摘要。
- 已实现，待桌面验收；本次未运行测试。验收顺序：在项目库开启 MCP，发现厂商工具并选择模型，助手应自动显示勾选卡；选择后预览并保存配置。预览到保存之间切换项目，应仍保存全局设置；直接调用画布工具仍须先打开项目。普通项目会话、独立助手窗口和原有取消流程需要回归。
- 回归入口：`tests/services/mcp/mcpControlService.test.ts`、`tests/services/chat/agentTaskControl.test.ts`、`agentRoundExecutor.test.ts`。回滚撤销本批全局审计域及守卫补丁，已有厂商配置保留。

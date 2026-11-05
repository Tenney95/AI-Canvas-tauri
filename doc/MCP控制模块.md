# MCP 控制

负责外部客户端控制 AI Canvas，以及内部助手连接外部 MCP 服务。这两个方向独立；业务工具与外部调用均复用 Registry、Policy 与任务审计。

2026-11-04 六项可靠性修复已实现并分别提交，范围、桌面验收与回退见[专项计划](./plans/2026-11-04-mcp-reliability.md)：配置截图脱敏、会话撤销与超时取消、完整有界业务结果、stdio 在途限额、外部凭据保存串行化及失效会话恢复。本次未运行测试，待用户验收。

日常镜头改稿、长文局部修改、读后写一致性、取消、异构批量与操作回执按[生产流程可靠性计划](./plans/2026-11-05-mcp-workflow-reliability.md)逐项推进；每项独立提交，状态与验收缺口以该计划为准。

设置页先展示并默认选中「外部控制本应用」，右侧为「助手连接外部服务」。默认页签只决定展示内容，不开启控制会话；MCP 仍默认关闭，仅用户手动开启或显式启用 `mcpAutoStart` 后才启动。

## 助手连接外部服务

已实现，待用户桌面验收；本轮未运行测试、类型检查或构建。设置 → MCP →「助手连接外部服务」添加地址与认证，读取目录并逐工具授权；助手顶部的 MCP 入口为每个会话显式选择连接，默认不启用。通用对话、画布对话和独立窗口共用配置，主窗口唯一执行。

入口：`components/settings/McpClientSettings.tsx` / `McpConnectionEditor.tsx`、`services/mcp/mcpClientService.ts`、`chat/tools/externalMcpTools.ts` 与原生 `mcp/client.rs`。复用已安装的 TS MCP SDK 和原生 reqwest，无新增依赖或运行环境；安装包增量尚未实测。

- 首期 Streamable HTTP，只允许 HTTPS 或本机回环 HTTP，URL 不含凭据、查询参数或片段；支持 Bearer Token 与 X-API-Key。凭据经 `providerSecretService` 写入 Rust `secret_store`，请求中原生注入，不进入普通配置或独立窗口快照。
- 逐工具授权绑定名称、说明、输入/输出 schema、标注与执行元数据的 SHA-256。远端只读标注只是提示；用户确认只读才走 `read`，其余已授权操作走 `external_write`：Plan 拒绝、B 确认、C 自动，不自动重试。inbound MCP 会话不暴露这组内部助手专用工具。
- `mcp_tools_search` 按需发现、`mcp_tools_describe` 读取单个参数定义，`mcp_read_tool` / `mcp_call_tool` 执行。目录最多 256 个同步工具与 32 页，单定义 32 KiB；单次模型参数说明另受 16,000 字符预算限制，超限明确拒绝，不截断 JSON。
- 原生仅接受配置过的固定端点和有限 MCP 方法，禁止重定向；请求 128 KiB、响应 1 MiB、同时最多 8 个 HTTP 请求，单次原生超时 65 秒。SSE 响应只在收到匹配 RPC 的完整结束帧后返回；不建立后台 GET 订阅，每次调用前重新读取目录。
- SDK 仅做协议结构校验，不动态编译远端 outputSchema，保留桌面严格 CSP。远端说明、参数和结果都是不可信资料；仅文本及结构化结果进入有界、脱敏 Observation，图片和资源不自动读取，不传入服务端 instructions。
- 停用、删除、连接修订、会话撤销和画布项目切换会取消旧请求；执行前后复核授权。取消不保证撤销远端副作用，写请求错误或状态不确定时须核实远端状态，不重投。删除先停用并保存，凭据清理失败保留停用条目供重试。
- 同连接保存/移除串行，更换凭据先持久化停用的目标端点；完整操作参与退出准备。带会话 ID 的 404 会清理对应 SDK 实例，目录最多重新握手读取一次，工具执行请求不自动重投；认证错误、普通 404、取消或授权变化不重连。
- 暂不支持 OAuth、stdio、旧 HTTP+SSE、后台 MCP Tasks、resources/prompts、sampling、roots、elicitation 与 MCP Apps。

实施、桌面步骤和回退见[助手 MCP URL 连接计划](./plans/2026-10-20-assistant-mcp-client.md)。定向用例：`tests/services/mcpClientService.test.ts`、`tests/services/chat/policyEngine.test.ts` 及原生 client 内单元用例；均未运行。

## 主要入口

| 入口 | 职责 |
|---|---|
| [mcpControlService.ts](../src/services/mcp/mcpControlService.ts) | 主窗口工具发现、控制请求和任务映射 |
| [mcpToolCatalog.ts](../src/services/mcp/mcpToolCatalog.ts) / [mcpDiscoveryTools.ts](../src/services/chat/tools/mcpDiscoveryTools.ts) | 有界目录检索、完整参数读取与 Registry 发现工具注册 |
| [mcpSettingsScope.ts](../src/services/mcp/mcpSettingsScope.ts) / [projectTools.ts](../src/services/chat/tools/projectTools.ts) | 应用级审计白名单与启动页项目导航 |
| [mcpUiRuntimeService.ts](../src/services/mcp/mcpUiRuntimeService.ts) | 固定应用窗口控制、单次 DOM 截图采集及有界跨窗请求 |
| [mcpCaptureEncoding.ts](../src/services/mcp/mcpCaptureEncoding.ts) / [mcpCaptureWorker.ts](../src/services/mcp/mcpCaptureWorker.ts) | 共用 JPEG 编码预算、已采集位图的 Worker 缩放压缩与资源释放 |
| [services/mcp](../src/services/mcp/) / [types/mcp.ts](../src/types/mcp.ts) | 前端桥接、会话配置及协议类型 |
| [原生 mcp](../src-tauri/src/mcp/) | 端口、鉴权、请求关联与双传输 |
| [ai-canvas-mcp.mjs](../scripts/ai-canvas-mcp.mjs) | 本机 stdio 客户端适配器 |

## 关键边界

- MCP 默认关闭，只有手动开启或显式配置自动开启才启动。stdio 使用本机回环桥；Streamable HTTP 的高风险传输确认属于配置授权。
- 固定端口默认 `27149`，本机与 HTTP 传输共用；已有自定义端口优先，默认值不改写运行中的会话。设置页清空端口后以 `0` 保存显式随机模式，启动时仍交给系统分配，不在重启后回落到固定默认值。已实现，本次未运行测试，待用户验收：缺省配置显示 27149，已有固定端口不变；清空并保存、重开后仍留空，开启会话取得随机端口，自动开启与传输授权保持原行为。
- 用户在端口输入框把其他值改为 `4927`，按 Enter 或失焦确认时播放《无间道》天台致敬；已保存端口的加载、随机按钮和重复确认不触发。动画组件按需加载，复用 `ModalOverlay` 的焦点圈定、Esc 和遮罩关闭，约 8 秒自动结束；减少动态效果时展示静态对白并由用户关闭。纯 SVG/CSS，不读取截图、不联网、不启动或重启 MCP，会话和端口保存沿用原流程。已实现，本次未运行测试，待用户验收：Tauri 设置 → MCP，27149 改为 4927 后按 Enter，检查天台、抬手、两段对白和落款；中途按 Esc、点关闭或遮罩应退出，切换设置页清理播放，重开 4927 不自动播放；改其他值再改回可重播。回归深浅主题、小窗口、减少动态效果、非法端口、留空随机及运行中会话不被彩蛋中断。定向入口为 `tests/components/mcpControlSettings.test.ts`，可在仓库根目录运行 `npx vitest run tests/components/mcpControlSettings.test.ts`。
- 两种传输共用 Registry 与 Policy；MCP 按 C 自主模式处理，`user_choice` 仍等待用户作答，不能由客户端替用户解决审批。
- MCP 进入模型勾选等 `user_choice` 等待时，自动打开助手并切到对应控制对话的消息视图；已独立的助手显示、取消最小化并聚焦原窗口，窗口不可用时回到主窗口面板。后台普通调用不导航，已切换项目或对话的异步窗口结果不抢回焦点。沿用现有 Store Action 与双窗口状态同步，用户仍需亲自选择。
- 令牌只由原生凭据存储持久化，不进入普通配置、事件或日志。HTTP 保留 Bearer、Host、Origin、请求体与并发限制；具体常量以当前原生源码为准。
- 固定令牌读取失败或格式异常不创建/覆盖条目；确认缺失后使用原生“预期不存在”条件创建，跨进程竞争失败只重读胜出的值。明确不可用或首次写入未确认成功时使用稳定的会话内存令牌，并在设置页标记。初始化复用配置队列并合并同窗口请求；显式轮换携带读取的精确旧值，冲突或读写失败不重启当前 bridge。设置页补读运行状态不创建令牌，优先使用实际启动令牌，忽略过期结果。原生锁及条件写入见[设置可靠性计划](./plans/2026-09-11-settings-reliability.md)。
- 业务工具必须能通过当前目录检索，并在执行阶段重新校验上下文；发现结果不代表后续调用已获授权。插件窗口、导演台等业务的完整实施记录写入各自模块。
- 分镜表按需创建，不作为视频生成的默认前置。单纯制作视频直接创建 `ai-video`；需要逐镜审稿、统一时长或按表剪辑时，先查询并复用已有表。选择表流程后，按镜头行准备制作节点，关联视频成功后回填独立的生成视频列；`canvas_bind_shotlist_frame` 对视频来源绑定该成片列，对图片来源仍绑定参考画面。按需用 `video_editor_create(shotlistNodeId)` 仅以就绪成片装配顺序、时长、转场及对白字幕，缺片行跳过，全无成片则拒绝；不默认另建每镜全文文本节点，也不自动删除已有表。
- `shotlist_read` 返回每镜的精确 `mention`，`shotlist_prepare_production` 为新视频写入该胶囊，直接创建视频也可使用返回值。表→视频连接消费指定镜头，生成前融合最新景别、运镜、画面、对白、音效/音乐和备注；手动视频时长优先，额外要求写在胶囊外。稳定行 ID 不随排序改号变化；旧复制正文提示词保留，显式换成精确胶囊后才实时读取。初始发现、完整模式工具描述和执行链路沿用同一规则，需更新应用并刷新 MCP 目录。范围与桌面验收见[专项计划](./plans/2026-09-08-shotlist-production.md#精确镜头引用2026-10-21)。已实现，本次未运行测试，待用户验收；回归覆盖目录、按行准备、单次/批量生成、成片绑定及剪辑创建。
- 画布连线区分端口与空间排布：`canvas_connect_nodes` 固定右出左入；创建/连接工具同时要求上游放左、下游放右，普通节点采用紧凑布局，默认边缘水平间距 48、纵向 40 画布单位，显式排布通常保留 48–64 单位水平间距。共享入口是 `services/chat/agentCanvasLayout.ts`，助手指导、MCP 目录及普通节点布局沿用同一规则；常规新建省略 x/y，由宿主依据实际尺寸与上游引用就近避让，不移动无关已有节点。连接结果（含已连接分支）及 `canvas_query(detail=true)` 返回实际端口、按分组绝对坐标计算的水平间距与 `layout.warning`。提醒不自动改线或移动用户节点，也不新增审批或硬性禁止有意回绕。专属镜头制作、文件导入和手工布局继续沿用各自流程。本轮紧凑布局调整未运行测试，待用户桌面验收。
- 连线规则保留在按需模式三个入口的描述，以及搜索、类别导航和参数读取结果的 `hint`；入口先说明用途与调用示例，返回先列工具再给发现提示与业务规则。完整模式的新建节点和镜头制作工具也先展示自身用途，再附上相同规则。客户端取得初始工具列表仍能看到方向、端口、紧凑间距与省略坐标建议、自动连线去重和操作前后核对要求。导演制作关系是“分镜表 → 导演台”和“镜头说明 → 导演台”；视频与配音按镜头来源关联成果，制作节点不反接回所属分镜表输入，也不把整表作为各视频的普通输入。画面格仍可显式绑定真实素材。入口描述由 MCP 目录层补充，业务 schema 仍直接取自 Registry，权限与摘要截断边界不变；客户端需刷新工具列表或重新连接才能取得更新。
- `canvas_connect_nodes` 推荐使用 `sourceIds: [输出节点 ID, ...]` 与一个 `targetId`，每次 1–50 项；旧 `sourceId` 仍兼容，两种来源参数只能提供一种。先校验整批，拒绝缺失节点、自连、素材接收端，以及视频、配音、导演台等制作节点反接所属分镜表；多源连接复用 Store 批量 Action，拒绝隐藏、折叠分组中的节点和非普通节点。输出列表去重、已有连线跳过；只为实际写入提交一次历史并增加一次 revision。结果返回 `connections` 的实际端口、已有状态和布局提醒，以及 `createdCount`、`skippedCount`（含重复来源和已有线）；单源保留旧的 `sourceId` 与 `layout` 字段。布局提醒继续允许有意回绕，不自动搬动节点。

## 本机半帧接收

已修复 stdio 回环桥在 `WouldBlock` / 读取超时后丢弃已接收半帧的问题：累计字节跨轮询保留，完整换行后才进行 UTF-8 与 JSON 解析，累计上限仍为 1 MiB。Windows 接受连接后显式恢复阻塞模式，沿用 500 ms 读取超时，避免继承监听 socket 的非阻塞模式后在分包间隙丢帧。

已补充大 Base64 帧、UTF-8 字符内分片、超时恢复、连续多帧和累计大小边界的原生回归用例；本次未运行测试，待用户验收。原生修改需重新构建并重启 Tauri 才生效。桌面验收：开启本机 MCP，在同一项目用 `file_media_upload` 依次 begin、按返回的 256 KiB 块 append、finish，再通过 `file_import_media_to_canvas` 导入，逐块核对 nextOffset；回归只读查询、取消、失效令牌、超出 1 MiB 拒绝及四客户端上限。用户可在 `src-tauri/` 执行 `cargo test mcp_bridge::tests --lib`，再按开发入口重建、重启桌面端；当前运行中的旧进程不会自动获得修复。

## 按需工具发现

角色、场景和道具先查询库再复用，工具发现入口的业务规则明确库引用优先、先绑图后使用。`drama_reference_image_add` 同时覆盖项目场景/道具，资产查询返回 `imageReady`，画布详情返回同图的 `preferredMention`；MCP 创建/更新提示词会将唯一同图节点引用转换为精确库引用以减少新连线。新建项目参考图可向 `canvas_create_nodes` 传 `dramaAssetId`，生成成功后自动回填。匹配边界、全局前缀与待验收项见[角色与短剧资产](./角色与短剧资产模块.md)。客户端需刷新工具目录或重新连接以获取新合同；不更改 transport、Policy 或既有连线。

导演台预演提供 `director_get_previs_schema`、`director_get_previs_scene` 与 `director_set_previs_scene`，仅在 MCP 控制上下文开放。客户端先取得合同和示例，再创建或查询 `ai-director`、选择 `ai-threejs` 并写入 `sceneJson`；读回返回完整场景，未保存时为 `null`。两项读取为 `read`，写入为 `canvas_write`，仍经 Policy 和项目/实例/派生守卫；不执行外部 JS，也不额外调用应用内模型。场景保存后的节点截图由宿主同步，完整合同与验收见[导演模块](./导演台与Blender模块.md)。

`canvas_create_nodes` 与 `canvas_update_nodes` 为视频节点设置 `aspectRatio` 时同步实际视频参数 `seedanceRatio`，固定比例同时联动空视频框；创建省略时先继承项目视频比例再排布，显式参数优先，已有成片和自适应的边界见[画布与项目](./画布与项目模块.md#视频参数与空节点比例)。`canvas_query(detail=true)` 只报告已显式设置或继承项目设置的实际视频比例，旧节点未设时不把画框比例误报为生成比例。多图视频提示词应按 Picture 顺序写入图片节点的 `@{nodeId:label}` 引用；只有连线无法指定参考图顺序。

媒体参数随 MCP 节点创建一起写入：图片支持 `aspectRatio`、`imageSize`、`batchCount`；视频支持 `aspectRatio`、`videoLongSide`（本地工作流长边像素，如 832）、`videoResolution`（API 画质档位，如 720p）、`videoDuration`（分镜小数秒向上取整）；旧调用传数字字符串 `videoResolution: "832"` 时兼容写入长边像素，而不再错误写成 API 档位。音频支持 `audioPurpose`、音色/格式/语速、描述式语音的声音类型/节奏/秒数，以及音乐标题、歌词、BPM、时长与自动歌词开关。三类均可传已配置的 `model` ID；未传的字段才使用项目/模型默认值。`canvas_update_nodes` 对同类字段可更新，`canvas_query(detail=true)` 返回安全的参数摘要；字段传给错误的节点类型或模型 ID 未配置时，在整批写入前拒绝。参考音频通过节点引用/工作流 IO 传入，Qwen 等工作流专属参数仍由工作流配置控制。ComfyUI H3 的帧率由工作流内部 24fps 公式固定，不把通用 `videoFps` 伪装成可独立生效的 MCP 控件。

`canvas_update_nodes` 的 `label` 同步已有 `fileName` 显示别名，修复媒体标题仍显示上传临时文件名的问题；只改变显示名称，不重命名磁盘文件、不改变媒体路径。混合节点批量改名只提交一次历史快照；现有历史系统只撤销结构变化，不撤销名称或提示词，回退名称需再次更新。`canvas_query(detail=true)` 的 `displayLabel` 返回文件名别名优先的标题，供客户端核对可见名称；`label` 保持内部名称字段。

MCP 设置中的「工具发现方式」默认按需加载，对应可选配置 `mcpToolExposure: "compact"`；旧配置缺少该字段时同样使用按需模式。初始仍只注册三个入口，`tools_search` 的说明先列出当前环境工具的全量简介，再按需读取参数。`"full"` 除当前可用业务工具外也保留三个固定入口，避免客户端缓存启动页列表后无法重新发现画布能力。两种传输共用此设置。升级或切换后需要在客户端刷新工具列表或重新连接，已有对话的上下文不会自动清除。

| 初始入口 | 使用方式 |
|---|---|
| `tools_search` | 按单个需求、工具名或类别搜索；`query: "*"` 逐页浏览全部当前可用工具的名称、中文标题和简介。默认每页最多 5 个、上限 8 个；`offset` 默认 0，用返回的 `nextOffset` 继续。空参数仍返回类别导航，`detail: "schema"` 可同时读取完整参数 |
| `tools_describe` | 每次读取 1 至 3 个已知工具的完整说明与参数 schema |
| `tools_call` | 通过 `name` 与 `arguments` 提交一个真实工具调用；已取得参数后可直接复用，不必重复搜索 |

目录始终由 Registry 生成，不复制业务 schema，不调用额外模型。搜索摘要逐项返回真实工具名、中文标题、前 120 字说明、类别和 effect，默认不携带参数定义；`descriptionTruncated` 标记说明是否被裁切，值为 `false` 也不表示摘要包含参数。调用前用 `detail: "schema"` 或 `tools_describe` 读取完整定义，已知参数可直接复用。完整目录结果上限 64 KiB，超出时明确报错，不能裁断 JSON。发现结果通过瞬时 MCP 内容通道返回，避开通用模型文本的长度裁剪，不进入消息或任务持久化。

2026-11-05 初始简介改为一次列出当前环境潜在可发现工具的完整 ID、标题和短说明，按「当前可发现／需项目或上下文」分组，状态只声明一次，减少每项 JSON 字段和重复提示。头部先报告是否打开项目，给出完整 JSON 顺序：启动页先读取项目导航参数，列出并打开用户指定项目，成功后再读取画布参数；已知工具名直接 describe，不知道名称才带 query 搜索。简介沿用真实 MCP 上下文及环境可用性判断，仅展示时不套用全局执行白名单；未配置的能力或需项目激活的动态能力仍须在环境变化后重新搜索。简介不是执行授权，搜索、参数读取与调用继续使用当时的实际项目和原白名单。简介上限 64 KiB，优先缩短每项说明以保留全部 ID／标题，仍超出时明确报错，不静默丢弃后半目录；不提前下发业务参数 schema。

发现入口及类别导航不重复附加素材／连线／制作长规则；规则保留在 `tools_call`，并随创建画布、分镜制作相关的工具参数按需返回。启动页零匹配或请求画布参数时，直接说明未打开项目并给出导航恢复步骤，不能仅报告「工具未注册」或继续引导翻页。多工具参数请求仍整批校验，导航与未激活的画布工具不能混为一次成功结果。

初始简介之后保留入口用途与调用示例，长业务规则放在后面；目录响应先返回工具/类别/计数，再返回发现提示并按需附加相关业务规则。也可调用 `tools_search({"query":"*","limit":8})` 动态浏览简介，保持 query/category 不变，以 nextOffset 为 offset 继续到 hasMore=false；与 category 同传时仍只浏览该类。仅整个 query 规范化后等于 `*` 才启用全目录浏览，其余查询沿用原排序。工具可用性和允许列表仍逐页复核，未打开项目时不能取得或执行项目专用工具，不因初始简介放开权限。

本次未运行测试，待用户验收。加载本次源码后，在 Tauri 启动页开启 MCP，客户端刷新目录或新建对话：按需模式的初始简介应能看到 `canvas_query`、`canvas_update_nodes`，并标明项目或上下文要求，不含其参数 schema；未打开项目时实际读取画布参数或调用仍应拒绝。随后打开目标画布，沿用此前连接，通过 `tools_describe({"names":["canvas_query","canvas_update_nodes"]})` 取得当前参数，再用 `tools_call` 只读查询画布；在测试项目更新一个节点后重新查询，检查写入正确。完整模式应保留三个入口，客户端即使缓存启动页目录也能按需重新发现与调用。回归项目切换、空参数类别导航、分页与 category 过滤、stdio／HTTP；失败不得自动重投写入。自动化入口（仓库根目录，由用户执行）：`npx vitest run tests/services/mcp/mcpToolCatalog.test.ts tests/services/mcp/mcpControlService.test.ts`。

2026-11-05 已按用户提供的本机 stdio 配置完成只读协议排查：握手和目录透传正常，当次 `project_list` 返回无活动项目，与仅可发现项目／厂商工具一致；能够读取导航 schema，画布 schema 请求被项目作用域拒绝。重编译后成功复读精简目录，169 项候选 ID 无增减，三个入口说明合计从 27,049 降至 14,556 字符（约 46.2%，不是 Token 或模型效果指标）；启动页零匹配及混合 describe 直接返回导航恢复步骤。重编译期间连接会中断，不据此宣称连续稳定性通过。未打开或切换项目，未运行画布工具、付费模型或自动化测试；真实画布读写与较弱模型的执行表现仍待用户验收。

搜索结果页保留 `total` 为当前匹配工具总数，新增 `returned`、`hasMore`，仅有后续结果时返回 `nextOffset`。翻页时保持 `query/category` 不变；每页重新读取当前可用工具，不承诺跨项目或配置变动的固定快照。`offset` 超出当前匹配范围时返回空页和从 0 重查的提示；无 query/category 的类别导航不分页，仅允许省略 offset 或传 0。类别导航和 `tools_describe` 不返回分页字段。

多步骤需求应拆开检索，少量匹配或零匹配不能证明能力缺失；先查看类别并逐页浏览。工具说明遵循现有 Policy：生成节点在 Plan 模式拒绝、B 模式确认、C/MCP 自动执行。`canvas_query(detail=true)` 优先报告实际视频、音频、图片或正文，缩略图只作为无主产物时的图片预览；仅有节点类型或成功状态不会被当作产物证据，视频是否可解码仍需媒体探测工具验证。阶段记录见[发现与结果准确性优化](./plans/2026-09-11-mcp发现与结果准确性优化.md)。

搜索和详情是注册为 `read` 的 MCP 专用工具；`tools_call` 是主窗口解包的传输信封。参数校验、effect、授权、预算、审计与取消均属于真实目标工具，只产生一次业务执行任务；通用入口不标为只读或可重试，不接受递归分发。原工具名直接调用仍兼容，内部对话助手的工具列表保持原有行为。

回退时选择「完整工具列表」并刷新客户端即可，不改变原工具权限或业务数据。

## 窗口截图与并发

- 每个截图任务只调用一次 `html-to-image.toCanvas`；DOM 采集仍在目标窗口主线程，后续缩放与 JPEG 编码优先交给固定模块 Worker。Worker 不可用或编码超时时，先终止 Worker，再仅对同一张已过滤画布降级编码，不重新克隆 DOM；已耗尽图像预算则直接失败。
- 同一窗口按 `maxWidth`、`quality`、`redactSensitive` 复用未完成请求，脱敏与非脱敏结果不混用。采集串行执行，最多保留一个执行中与一个排队任务；跨窗请求及目标窗口等待者各有最多 4 项的上限。客户端 12 秒响应超时不代表底层 DOM 任务已取消，只有实际采集和编码结束才释放采集名额，避免超时重试堆积。
- 保留敏感元素、密码和 API Key 等过滤与显式脱敏参数，目标仍限于固定可截图窗口；JPEG/base64 返回和 2,600,000 字符预算不变。位图关闭、画布清零，Worker、计时器及事件监听及时回收；队尾不保留上次截图正文。`ui_capture_window` 仅返回瞬时图像，不持久化截图内容；`ui_capture_to_canvas` 仍走用户显式要求的素材导入流程。

已实现，本轮新增或调整的截图回归用例未运行，待 Tauri 桌面隐私与并发验收；不能以历史工具测试通过记录代替本轮验收。源码与定向用例见 `tests/services/mcp/mcpUiRuntimeService.test.ts`，大画布同类优化、桌面步骤和剩余缺口见[大画布返回与后台处理计划](./plans/2026-10-20-large-canvas-return.md)。

## 媒体输入与视频制作工具

| 能力 | 工具与边界 |
|---|---|
| 图片上传 | `file_media_upload`（`file_write`）按 begin/append/finish/status/cancel 管理 PNG/JPEG/WebP；固定 256 KiB 分块与链式摘要，完成后由批量导入领取。仅 MCP 会话可用。 |
| 原文件返回 | `file_media_download`（`read`）按当前节点 begin/read/close，返回已落盘主媒体的原字节，不转码；每块最多 256 KiB，客户端核对块 SHA-256、解码 Base64 并拼接保存。仅 Tauri 当前项目 MCP 会话可用。 |
| 批量导入 | `file_import_media_to_canvas`（`canvas_write`）一次 1–20 项；path 位于当前项目/剧集共享素材目录时只建画布引用，不重复复制，已授权外部文件仍复制入项目；也可领取同会话 uploadId。准备成功后批量写入一次历史。 |
| 系统内容与截图 | `canvas_paste_external` 和 `ui_capture_to_canvas` 写入画布；只查看主窗口图像仍用只读 `ui_capture_window`。 |
| 剪辑工程 | `video_editor_list` / `video_editor_get` 读取；`video_editor_create` / `video_editor_update` 为 `file_write`，更新携带 expectedVersion，tracks 完整替换。仅当前项目的 MCP 会话可用。 |
| 后台合成 | `video_editor_export` / `video_editor_export_cancel` 为 `canvas_write`，`video_editor_export_status` 只读。requestKey 与版本约束避免同任务重复启动；返回 jobId 后须查询完成。 |
| 验片 | `video_media_probe` 只读探测真实媒体参数；`video_media_extract_frames` 按 1–6 个递增时间点返回瞬时图像，不持久化图像正文。 |

以上为工具摘要，调用前通过发现接口读取完整 schema。上传的会话、项目、revision、十分钟空闲失效及一次性消费由媒体服务控制；传输鉴权不能代替本地路径授权。分块字节与原始路径不进入审计摘要。

剪辑控制当前最多 300 秒、8 轨、120 片段、1080p 等像素面积、60 fps。人工剪辑窗口打开时拒绝后台修改/导出；导出期间复核工程、素材和画布，任务状态仅在应用会话内保留。工具受理不等于文件已完成；抽帧也不等于声音和剪辑质量验收。

用户步骤见[说明书：MCP](../site/manual.html#mcp-discovery)。业务实现与实机验收分别见[图片上传计划](./plans/2026-09-11-mcp图片上传导入.md)、[视频制作计划](./plans/2026-09-11-mcp-video-production.md)及[文件与存储](./文件与存储模块.md#mcp-资源导入)。

## 节点原文件返回

`file_media_download` 按 `nodeId` 读取当前画布节点已落盘的图片、视频或音频主文件；不是窗口截图，不读取缩略图，不自动下载远程 URL，不接受调用方提交的路径或保存位置。主产物仍为远程、内嵌数据或 blob 时，即使残留 filePath 也拒绝；仅有缩略图且原件身份不明确时同样拒绝，提示先保存或导入。普通媒体格式沿用文件服务的分类与 MIME 识别，不支持的格式明确报错。

通过 `tools_search({"query":"file_media_download","detail":"schema"})` 取得合同后，在按需模式依次把以下对象作为 `tools_call` 参数；完整列表模式也可直接调用原工具名：

```json
{"name":"file_media_download","arguments":{"action":"begin","nodeId":"待导出的节点 ID"}}
{"name":"file_media_download","arguments":{"action":"read","downloadId":"begin 返回的 ID","offset":0}}
{"name":"file_media_download","arguments":{"action":"close","downloadId":"begin 返回的 ID"}}
```

begin 返回安全文件名、MIME、总字节数、块上限与失效时间；每次 read 按实际字节偏移返回 `data`（Base64）、`bytesRead`、块 `checksum`（SHA-256）、`nextOffset` 和 `eof`。客户端先校验解码后字节的摘要，再按偏移写入自己控制的文件，继续到 eof=true 后 close。同一偏移可重读，末块不会立刻销毁下载 ID；不自动写入客户端磁盘，也不保证聊天客户端显示附件下载按钮。Base64 原文件不能直接当作模型已看过的图像；视觉预览仍需对应图像通道。

最多保留 4 个活动或关闭中的下载，空闲 10 分钟失效。ID、路径与句柄仅存宿主内存，绑定项目、对话、节点主媒体及存储根；切换项目、节点删除/产物替换、存储根变化、取消或读取失败会回收句柄，旧结果不能回到新项目。每块前后复核文件大小与修改时间；这些元数据检查不是抵抗同大小、同时间戳篡改的完整快照保证。原文件正文只通过 `mcpContent` 瞬时返回，消息/任务摘要不保存原字节、下载 ID、文件路径或来源 URL。close 只关闭读取，不删除或修改原文件。

入口为 `chat/tools/fileTools.ts` → `mediaDownloadService.ts` → `fileService.ts` / `fs/mediaRead.ts`。复用现有文件插件权限与私有目录拒绝；未新增依赖、Rust command、下载 HTTP 端点、数据库或权限。类型与执行语义见[原文件返回方案](./plans/2026-10-26-mcp-original-media-download.md)。已实现并补充文件读取、会话及 MCP 透传回归用例；本次未运行测试，待用户在 Tauri 中分块取回 PNG/JPEG、MP4 和音频并与原文件比较完整 SHA-256，再验收取消、项目切换、文件变化、越界偏移、close 与失效。用户可在仓库根目录执行 `npx vitest run tests/services/fs/mediaRead.test.ts tests/services/mediaDownloadService.test.ts tests/services/mcp/mcpControlService.test.ts`。

## 验证与资料

- 令牌故障回归：[会话配置](../tests/services/mcpSessionConfig.test.ts)、[设置页状态](../tests/components/mcpControlSettings.test.ts)。覆盖读取失败不覆盖、并发初始化、稳定会话降级、失败轮换保留正在运行的配置和过期查询保护。提示复用 `ui-alert--warning` 的明暗主题变量；未启动真实桌面 bridge 或做主题截图验收。

- 外部资源已补充 `file_import_media_to_canvas`、`canvas_paste_external`、`ui_capture_to_canvas`，均为 `canvas_write`，保留 Plan 拒绝、B 确认、C/MCP 自动执行的既有策略。业务边界见 [文件与存储](./文件与存储模块.md#mcp-资源导入)。`ui_capture_window` 仍是只返回瞬时图像的只读工具；截图过滤器已兼容文本节点，避免 `closest` 调用失败。
- 连线布局反馈：画布工具与 MCP 目录定向测试共 58 项通过，应用/测试类型检查和定向 ESLint 通过；覆盖分组绝对坐标、80 单位边界、已连接请求不重复写入及实际端口返回。实机查询已识别素材位于生成节点右侧造成的回绕；布局提醒不等同于阻止执行。

- 定向回归：[MCP 控制服务](../tests/services/mcp/mcpControlService.test.ts)。真实 stdio/HTTP 握手、鉴权失败、取消和工具发现验收与 mock 测试分别记录。
- 模型选择自动导航已实现，新增主面板、独立窗口、窗口失效、项目切换与普通后台调用回归；本次未运行测试，待用户验收。桌面验收：关闭助手或停在其他对话/任务中心，由外部 MCP 调用 `provider_models_select`，应自动进入该项目的 MCP 控制对话并显示选择卡；独立窗口最小化时应恢复原窗口，切换项目后旧请求不应抢回对话；查询画布等普通调用应保持当前界面。
- 按需目录：[目录测试](../tests/services/mcp/mcpToolCatalog.test.ts)、[设置测试](../tests/components/mcpControlSettings.test.ts)、[适配器测试](../tests/scripts/aiCanvasMcp.test.mjs)。2026-09-07：六个相关测试文件共 107 项通过，应用/测试类型检查与改动文件 ESLint 通过；真实 stdio 客户端经打包资源适配器发现三个入口，并完成带参数检索和画布读取，原名调用兼容也已实测。
- 2026-09-07 的目录测试快照含 122 个当时可用业务工具，完整定义 76,669 字节、精简定义 2,446 字节，初始体积减少约 96.8%；一次带 schema 的检索结果为 1,505 字节。这是 JSON 的 UTF-8 体积，不代表模型实际 Token 或费用。实机精简目录同为 2,446 字节。
- 本次未切换远程传输，HTTP 端到端与深浅主题实际切换尚未验收；新控件复用既有 `ui-*` 与主题变量。扩展 i18n 检查发现四条既有孤儿词条，未纳入本次修复；已有图片适配器测试的 Vite/shebang 加载问题在临时原生加载配置下验证通过，不据此宣称全仓检查通过。
- 设计与专项：[本机控制桥](./plans/2026-07-24-local-mcp-control-bridge.md)、[全面控制工具历史](./history/2026-09-07-跨模块实施记录归档.md#mcp-full)、[Streamable HTTP](./plans/2026-08-20-mcp-streamable-http.md)。
- 历史：[本机 MCP](./history/2026-09-07-跨模块实施记录归档.md#mcp-local)、[全面控制](./history/2026-09-07-跨模块实施记录归档.md#mcp-full)、[HTTP 传输](./history/2026-09-07-跨模块实施记录归档.md#mcp-http)。

返回[文档导航](./文档导航.md)。


## ComfyUI 默认工作流输入

`workflow_create` / `workflow_update` 支持 `defaultNodes`，可包含 `prompt`、`image`、`video`、`audio`，值为对应 IO 节点 ID。例如 `{"defaultNodes":{"prompt":"19"}}`。默认目标必须存在于执行图且与 IO 类型一致；创建未提供 IO 清单时从执行 JSON 识别。

更新时该对象整体替换，省略则保留，传 `{}` 清空。需要保留其他类型时先 `workflow_get` 再合并后提交。改图导致既有默认目标失效时须同时修正或清空默认值；失败不会写入 Store。此字段仅适用于 ComfyUI，不能改写 RunningHub 或 workflow-api 的参数定义。

默认媒体输入是优先槽而非启用上传的必要条件，所有 ComfyUI 工作流的普通 @ 图片、视频、音频都会按同类引用顺序自动匹配剩余上传槽。规则见 [ComfyUI工作流集成说明](./ComfyUI工作流集成说明.md#6-默认节点-defaultnodes)。

## 启动页项目创建、列表与打开、切换

项目创建与导航通过同一个 Registry、Policy 与审计任务执行。启动页和已打开画布都可发现、调用以下工具；项目删除、设置写入以及画布、文件、媒体工具仍要求已打开项目。

| 工具 | 参数与结果 |
|---|---|
| `project_list` | 可选 `limit`（默认 50，上限 100）、`offset`（默认 0）；返回项目/剧集/分集摘要、`currentProjectId`、`currentRootProjectId`、分页计数及 `nextOffset`。摘要含 ID、名称、类型、剧集归属、时间、`current`、`opened` 和 `openTargetId`，不返回路径、快照或正文 |
| `project_get` | `projectId`；沿用既有安全元数据和项目设置读取 |
| `project_create` | 可选 `name`；省略时沿用项目自动命名，传入空白名称则拒绝。复用 Store 创建事务，已打开项目时先保存，再持久化新项目并打开；返回 `id`、`name` 和实际 `currentProjectId`，不返回目录、路径或快照 |
| `project_open` / `project_switch` | `projectId`；共用 Store 的保存与加载流程，返回 `requestedProjectId`、`previousProjectId`、实际 `currentProjectId`、`alreadyOpen` 与打开的项目摘要 |

同名项目必须用列表返回的 ID 区分。剧集从启动页默认打开第一集；再次打开当前剧集保留正在编辑的分集，重复打开当前画布不重载。成功后关闭项目库弹窗，切走前保存失败、目标加载失败、请求取消或被其他切换接管均不报告成功。MCP 导航在项目创建、返回启动页、加载和其他切换期间返回忙碌提示，不自动重试写操作。取消信号只保存在运行时，目标读取结束后复核信号与切换序号，防止迟到结果覆盖当前画布。

创建同样拒绝初始化、返回启动页或其他创建/切换期间的并发请求，项目列表读取失败且为空时也不创建。成功返回前复核新项目存在、已打开并完成加载；失败保留原画布和项目库。取消信号沿用创建事务的序号守卫：新项目尚未保存时停止后续创建；保存已经开始时不回滚落盘，完成后仅保留项目列表记录，不切换当前画布。失败、取消或超时后应先用 `project_list` 核对，不能自动重试创建，以免重复项目。

创建与导航任务归应用级「MCP 全局控制」审计会话，继续使用旧 `mcp-global-settings` 标识以兼容历史；旧会话标题可以保留。仅明确的设置、创建、导航及目录白名单可独立于项目执行，创建与导航不生成画布撤销 checkpoint，也不向其他项目工具授予权限。创建或切换后的新画布请求仍绑定实际当前项目；原 stdio/HTTP 鉴权、Policy 与取消协议保持原有边界。两种模式的三个发现／调用入口保持稳定；完整列表若要直接暴露新项目的业务函数，仍需客户端刷新目录，但可以沿用已缓存入口按需查询和调用当前项目工具。

按需调用示例：先用 `tools_search({"category":"project","detail":"schema"})` 读取参数；启动页可直接创建，已有项目可按列表 ID 打开或切换：

```json
{"name":"project_create","arguments":{"name":"新项目"}}
{"name":"project_list","arguments":{}}
{"name":"project_open","arguments":{"projectId":"列表返回的项目 ID"}}
{"name":"project_switch","arguments":{"projectId":"另一个项目 ID"}}
```

以上均为 `tools_call` 的参数对象，也兼容直接调用原工具名。列表分页通过瞬时 MCP 内容返回完整 JSON，不把项目列表正文复制进消息或任务摘要。

状态：2026-10-28 已实现启动页 MCP 创建并补充发现、全局审计、已有项目兼容、取消与失败回归用例，本次未运行测试，待用户验收。Tauri 桌面验收：

1. 启动 Tauri 桌面端并停留在启动页，等待项目列表加载完成后开启 MCP；刷新客户端目录或重新连接。分别在按需/完整模式确认 `project_create` 可发现，按需模式调用上述 `tools_search` 后用 `tools_call({"name":"project_create","arguments":{"name":"启动页创建验收"}})` 创建。应直接进入同名空白画布，返回的新项目 ID 等于 `currentProjectId`，不要求先打开已有项目；省略 `name` 应自动命名。
2. 返回启动页，用 `project_list` 确认新项目已保存且可重新打开；检查分页、ID、归属、打开状态与脱敏结果。修改画布后在已打开项目中再调用 `project_create`，回到旧项目确认修改已保存。检查创建任务归全局 MCP 审计、新的 `canvas_query` 请求归新项目，并且不产生跨项目撤销 checkpoint。
3. 用 `project_open` 和 `project_switch` 打开、切换已有项目，检查画布、会话、Agent 任务、角色库与项目记忆。打开剧集应进入第一集；手动切到第二集后再次打开剧集，应留在第二集。重复打开当前项目应返回 `alreadyOpen: true`，不丢失当前编辑。
4. 空白名称、未声明参数、不存在的 ID 及越界分页值应失败。初始化或创建/切换忙碌时第二次创建或导航不抢占；受控保存失败时保留旧画布且不返回成功。取消创建/加载中的原请求后，迟到数据不应切换项目，遮罩应收起；创建若已开始落盘，先读列表核对可能保留的新项目，不自动重试。
5. 回归启动页厂商模型选择、全局配置预览/保存、主窗口与独立助手、普通项目会话、stdio/HTTP 请求取消。未打开项目时直接调用画布/项目删除仍应拒绝；创建或打开后新请求绑定实际项目。结果与审计消息不应出现项目目录、快照或取消信号。

自动回归入口：`tests/services/chat/projectTools.test.ts`、`tests/services/chat/agentRoundExecutor.test.ts`、`tests/services/mcp/mcpControlService.test.ts`、`tests/store/projects.test.ts`。用户可在仓库根目录运行 `npm run test -- --exclude ".planning/**" tests/services/chat/projectTools.test.ts tests/services/chat/agentRoundExecutor.test.ts tests/services/mcp/mcpControlService.test.ts tests/store/projects.test.ts`；静态类型检查入口为 `npm run typecheck` 与 `npm run test:typecheck`。本次创建修复可撤销 `project_create` 全局白名单、授权、入口保护及 Store 可选取消信号；保留既有项目导航，无数据库迁移。

## 不依赖项目的模型设置

- 厂商文档读取、模型选择、配置预览及保存通过应用级审计会话执行（旧标题「MCP 全局模型设置」，新会话为「MCP 全局控制」），不需要加载项目，也不随项目切换失效。复用现有 Registry、Policy、AgentTask、审计摘要及凭据存储，不新增旁路保存。
- `mcpSettingsScope.ts` 的保留审计域标识仅用于既有任务/会话关联，不创建或选中 CanvasProject。必须同时匹配会话身份与封闭工具白名单才能独立于项目执行。设置请求仍只使用 `provider_docs_read`、`provider_models_select`、`provider_config_preview`、`provider_config_apply` 及目录发现；项目导航使用独立子白名单。URL 授权、配置冲突检查和本人模型选择仍由原规则约束。
- 未打开项目时 full 与 compact 发现提供厂商设置及上述项目导航能力；打开项目后恢复完整目录，画布/文件/付费生成仍须有效项目。全局选择卡自动打开助手，项目切换保留会话；该审计会话不提供普通对话输入，也不允许恢复为通用模型循环。
- MCP 控制服务初始化时沿用既有中断修复加载全局审计任务；重启后的未完成任务恢复为暂停，不自动续执行。已有审计会话继续沿用，不覆盖历史摘要。
- 已实现，待桌面验收；本次未运行测试。验收顺序：在项目库开启 MCP，发现厂商工具并选择模型，助手应自动显示勾选卡；选择后预览并保存配置。预览到保存之间切换项目，应仍保存全局设置；直接调用画布工具仍须先打开项目。普通项目会话、独立助手窗口和原有取消流程需要回归。
- 回归入口：`tests/services/mcp/mcpControlService.test.ts`、`tests/services/chat/agentTaskControl.test.ts`、`agentRoundExecutor.test.ts`。回滚撤销本批全局审计域及守卫补丁，已有厂商配置保留。

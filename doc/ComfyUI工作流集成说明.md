# ComfyUI 工作流集成说明

> 本文档描述 AI Canvas 如何导入、管理和执行 ComfyUI 工作流，包括 IO 节点识别、内容与参数注入规则、结果取回和编辑回写链路。
> 最后更新：2026-09-08。范围、验证与回滚见[可靠性修复](./plans/2026-09-08-comfyui-reliability.md)、[助手多服务器支持](./plans/2026-09-08-comfyui-assistant-servers.md)和[打开与编辑体验](./plans/2026-09-08-comfyui-editor-experience.md)。

## 1. 概览

ComfyUI 在 AI Canvas 里是一种 **provider**：工作流导入后会出现在生成节点的模型下拉里，选中后该次生成的 `provider` 为 `comfyui`、`requestModel` 为 `comfyui/workflow`，并带上 `workflowId`。运行时不解释工作流的语义，只做四件事：

1. 把画布上的提示词、图片、视频、音频**注入**到工作流对应的节点；
2. 把节点面板上选的分辨率、比例、帧率、时长**注入**到工作流的参数节点；
3. 提交到 ComfyUI 的 `/prompt`，用 WebSocket 展示节点进度，用 `/history` 轮询确认结果；
4. 把产物地址取回来，下载保存进项目目录。

执行路径按分类分三条：

| 分类 | 入口 | 执行函数 |
|------|------|---------|
| `ai-image` | [generateImage.ts](../src/services/ai/generateImage.ts) | `executeComfyUIGenerate` |
| `ai-video` | [generateVideo.ts](../src/services/ai/generateVideo.ts) | `executeComfyUIVideoGenerate` |
| `ai-audio` | [generateAudio.ts](../src/services/ai/generateAudio.ts) | `executeComfyUIAudioGenerate` |

`ai-text` 分类只能导入和归类，**没有执行路径** —— 文本生成不会走 ComfyUI。

## 2. 配置与连接

设置 → ComfyUI 配置连接与本地安装目录：

- **服务地址**：默认 `http://127.0.0.1:8188`，存在 `config.comfyUIUrl`。未配置时执行会直接抛「未配置 ComfyUI 服务地址」。
- **额外服务器**：`config.comfyServers` 保存服务器名称和 URL；工作流通过 `serverId` 绑定。未绑定或服务器记录已删除时回落到默认地址；可用性灯通过 `/system_stats` 探测。
- **本地安装目录**：存在 `config.comfyUIPath`，配好后可以一键启动本地 ComfyUI（Tauri 命令 `launch_comfyui`，固定使用 `--listen 127.0.0.1 --enable-cors-header`）。当前本地启动尚未关联自定义端口。

请求通过 [comfyPolling.ts](../src/services/comfyPolling.ts) 的 `comfyFetch`，出口按环境分流：

- **Tauri 桌面**：走 `corsSafeFetch` → Rust `proxy_fetch`，不受浏览器同源限制；
- **浏览器开发模式**：`http://127.0.0.1:<port>` 会被替换成 Vite 代理路径 `/api/comfyui`。

## 3. 数据模型

工作流定义见 [types/index.ts](../src/types/index.ts)：

| 字段 | 说明 |
|------|------|
| `id` | 手动导入是 `wf-<随机>`，内置工作流是固定的 `builtin-*` |
| `category` | `ai-text` / `ai-image` / `ai-video` / `ai-audio` |
| `fileName` | 原始文件名，列表里显示用 |
| `fileContent` | **API 格式** JSON 字符串，执行时解析的就是它 |
| `editableContent` | **界面格式** JSON，只用于在 ComfyUI 里打开时保住节点布局 |
| `ioNodes` | 识别出的输入/输出节点，`{ nodeId, title, type }` |
| `defaultNodes` | 各类型的默认 IO 节点，`type → nodeId` |
| `serverId` | 可选服务器绑定；恢复任务使用提交时保存的实际地址 |

两种 JSON 格式不能混用：

- **API 格式**（ComfyUI 里「导出 (API)」）形如 `{ "105:104": { class_type, inputs, _meta } }`，是提交给 `/prompt` 的格式；
- **界面格式**（「导出」）形如 `{ nodes: [...], links: [...] }`，带坐标和连线，只有它能在 ComfyUI 画布里还原布局。

两者都有 16 MiB 上限，前端 `validateSavePayload` 和 Rust `parse_workflow_save_payload` 各校验一次。

状态存在 [store.workflows.ts](../src/store/store.workflows.ts) 的 `workflows` 里，增删改都同步落 `fileService.saveWorkflow`（IndexedDB）。

## 4. 工作流从哪来

### 4.1 手动导入

工作流管理面板（设置 → ComfyUI → 管理工作流，或画布右键菜单）选 `.json` 文件，解析成功后即时识别 IO 节点并预览。**必须是 API 格式**，导入界面格式的文件会因为识别不到 `class_type` 而一个 IO 节点都认不出来。

### 4.2 内置工作流播种

[builtinWorkflows.ts](../src/services/builtinWorkflows.ts) 内置了 6 个 MiniMax H3 视频工作流（文生/图生/参考生 × 普通/Turbo），JSON 打包在 `src/assets/comfyWorkflows/` 下，界面格式放在同级 `ui/` 里。

播种按 id **逐个记账**在 `localStorage` 的 `aicanvas.builtinWorkflows.seededIds`：

- 中途出错的那一批下次启动会重来；
- 用户删掉的不会自己长回来；
- 后续版本新增的会在下次启动自动补上。

### 4.3 从 ComfyUI 编辑后保存回来

见 [§9](#9-comfyui-编辑窗口与回写)。

## 5. IO 节点识别

`extractComfyUIIONodes`（[comfyUIWindowService.ts](../src/services/comfyUIWindowService.ts)）扫一遍 API JSON，按 `class_type` 归类：

| 类型 | 匹配的 class_type |
|------|------------------|
| `image` | `LoadImage*` |
| `video` | `LoadVideo*`、`VHS_LoadVideo*`、`VHS_LoadVideoPath*` |
| `audio` | `LoadAudio*`、`VHS_LoadAudio*`、`RecordAudio*` |
| `prompt` | `CLIPTextEncode`、`*TextEncode`、`StringLiteral`、`PrimitiveString`、`ShowText`/`pysssss` |

类型规则没命中时还有一层兜底：节点的 `inputs` 里只要有名字含 `text` / `prompt` / `writing` 且值是非空字符串的输入，就算作 `prompt` 类型。`showAnything`、`PreviewAny`、`DisplayText` 这类展示节点排除在外 —— 它们的 `text` 是给人看的结果，不是提示词入口。

识别结果只是**候选清单**，用来在提示词框里 `@` 和在面板上标默认节点，不影响参数注入。

## 6. 默认节点 defaultNodes

工作流管理面板里点节点徽章可以把它设为该类型的默认节点（徽章变 ★）。语义是：

> 用户**没有** `@` 该类型的任何节点时，提示词框里的同类内容自动送进这个节点。

优先级规则在 `submitComfyUIWorkflow` 里（[comfyWorkflowService.ts](../src/services/comfyWorkflowService.ts)）：**某个类型只要被 `@` 过一次，该类型就完全按用户的赋值走，默认节点不再介入。** 类型之间互不影响 —— `@` 了提示词节点，图片的默认节点照常生效。

在 ComfyUI 里改完结构存回来时，指向已不存在节点的默认设置会被 `pruneDefaultNodes` 丢掉。

## 7. 执行链路

以视频为例，`executeComfyUIVideoGenerate` 的完整顺序：

1. **预存待续任务** —— 在提交之前写 `savePendingTask`（`submitted: false`），拿到 `prompt_id` 后才具备续查条件；
2. **解析工作流** —— 从 store 取 `fileContent` 并 `JSON.parse`，得到可改的 `workflowObj`；
3. **注入提示词** → `injectPromptsIntoWorkflow`；
4. **注入显式图片/视频** → `injectExplicitMediaIntoWorkflow`（上传后写文件名）；
5. **注入默认媒体** → `injectDefaultMediaIntoWorkflow`（图片/视频）；
6. **注入音频** → `injectAudioIntoWorkflow`；
7. **查节点声明** → `resolveVideoParamSpecs`，只为需要校验的字段问 `/object_info/{class}`；
8. **注入视频参数** → `injectVideoParamsIntoWorkflow`；
9. **提交** → `POST /prompt`，拿到 `prompt_id` 后回填待续任务（`submitted: true`）；
10. **轮询** → `/history/{promptId}`，取到产物地址后返回；
11. 上层把产物下载保存进项目目录，写回节点。

注意 `submitComfyUIWorkflow` 这个名字有点误导：它只负责**构建** `workflowObj` 并返回，真正提交的是 `promptComfyUIWorkflow`。参数注入夹在这两步之间。

## 8. 注入规则

### 8.1 提示词

`injectPromptsIntoWorkflow` 分三种情况：

| 情况 | 行为 |
|------|------|
| 指定了默认提示词节点，且没 `@` 过提示词节点 | 只写这一个节点，写它第一个存在且是字符串的键（`text` → `prompt` → `string` → `value`） |
| 没有任何 `@` 赋值，也没默认节点 | 兜底猜测：遍历所有 `text`/`prompt` 输入，**只替换看起来像占位符的值**（长度 < 10 且不含空格，例如 `t-1`） |
| 有 `@` 赋值 | 只写被 `@` 命中且在 `ioNodes` 里的节点，其余保持原值 |

显式赋值仅处理 `prompt` 类型 IO，与默认输入共用 `text → prompt → string → value` 字段顺序，只写已有的字符串字段，保留连线。无法找到可写字段时在提交前报错，不静默使用旧文本。

### 8.2 图片 / 音频 / 视频

媒体统一先上传到 ComfyUI 的 `/upload/image`（ComfyUI 只有 `/upload/image` 和 `/upload/mask` 两个上传路由，前者不校验扩展名，音频视频同样走它），再把返回的文件名写进节点：

| 类型 | 写入的输入键 |
|------|-------------|
| 图片 | `image`（并同步 `upload` 字段） |
| 视频 | `video`，没有就试 `file`（核心 `LoadVideo` 用的是 `file`） |
| 音频 | `audio`（并同步 `upload` 字段） |

**默认媒体注入会跳过不接受上传文件名的节点**（例如音频只有 `audio_file`，视频既没有字符串 `video` 也没有字符串 `file`）。显式 `@` 图片/视频无法解析素材或找不到可写字段时，在上传和提交前报错。显式视频与图片复用上传通道，回填时包含返回的子目录；未被指定的同类 IO 保持原值。

`injectDefaultMediaIntoWorkflow` 还会处理 autogrow 可选参考位：ComfyUI 的可选槽形如 `ref_images.ref_image_1`（键名带点号），用户这次带的参考图不够填满时，没轮到的槽会连同下游链路一起摘掉，避免残留的示例文件名让工作流报错。只有整条链路终点全是可选槽才摘，否则一律保留。

### 8.3 图片尺寸

`injectDimensionsIntoWorkflow`：`mapImageDimensions(imageSize, aspectRatio)` 把画质档位当**短边**（`720p`=720 / `1K`=1024 / `2K`=2048 / `4K`=4096）按比例算另一边，然后写进所有 `width`、`height` 都是数字的节点，外加 ResolutionSelector 类节点的 `aspect_ratio` + `megapixels`。

### 8.4 视频参数

`injectVideoParamsIntoWorkflow`（[comfyWorkflowService.ts](../src/services/comfyWorkflowService.ts)）按**输入名**匹配，不按 IO 节点过滤 —— 分辨率、帧率、帧数都在 latent / 合成节点上，用户不会去 `@` 它们。

认的字段是照着 ComfyUI 核心（`comfy_extras`、`comfy_api_nodes`）和常用插件的节点定义列的：

| 参数 | 输入名 | 典型来源 |
|------|--------|---------|
| 帧数 | `length` | Wan / Hunyuan / Mochi / LTXV 的 latent 节点（要求同节点有数字 `width`/`height`） |
| | `num_frames` | WanVideoWrapper 全家、`WanTrackToVideo` |
| | `video_frames` | `SVD_img2vid_Conditioning` |
| | `frame_count`、`frames` | VHS 等 |
| 帧率 | `fps` | `CreateVideo`、`SaveWEBM`、SVD |
| | `frame_rate` | `LTXVConditioning`、`VHS_VideoCombine` |
| 时长 | `duration`、`duration_seconds` | MiniMax、Kling、Vidu、Pixverse、Sora、Veo 等 API 节点 |
| 尺寸 | `width` + `height` | 任意同时是数字的节点 |
| | `aspect_ratio` + `megapixels` | `ResolutionSelector` |
| | `aspect_ratio`（纯 `16:9`） | API 节点 |
| | `resolution`（`720p` / `1920x1080`） | API 节点 |

几条关键规则：

- **只写数字**。连线过来的值是 `["3", 0]` 这样的数组，跳过 —— 写进去会把连接冲掉。
- **秒数节点优先**。先扫一遍 `PrimitiveFloat` / `PrimitiveInt` 且标题匹配 `duration|时长|秒` 的节点，写秒数。一旦命中，**帧率就不再注入** —— 这类工作流自己按秒算帧，帧率是算式里的常量，再去改它只会让时长对不上。内置的 MiniMax H3 工作流正是这种结构，所以在它们上面调帧率是不生效的。
- **分辨率是长边**。`mapVideoDimensions` 把分辨率数值当长边（和图片的短边语义相反），按比例算另一边并对齐到 8 —— ComfyUI latent 和多数视频模型都要求边长是 8 的倍数。
- **`length` 要同节点有 `width`/`height`** 才写，避免误伤其他节点上同名的 `length` 参数。

刻意**不碰**的字段：

- `LoadVideo` 系列的 `custom_width` / `custom_height` / `force_rate` / `frame_load_cap` —— 那是处理输入素材的参数，写进去会把用户传的视频改掉（按 class_type 整个节点跳过）；
- 裁剪类节点（class_type 含 `slice`/`trim`/`cut`/`crop`）的 `duration` —— 那是截取长度，不是出片时长；
- `target_width` / `final_width` 这类图像拼接工具节点的尺寸参数 —— 语义太杂。

### 8.5 combo 字段的可选值校验

`aspect_ratio`、`resolution`、`duration` 大多是 combo，各节点的可选值都不一样（Kling 只给 `720p`/`1080p`，Vidu 给 `360p`/`540p`/`720p`/`1080p`；时长有的是 `[5, 10]` 有的是 `["5s", "10s"]`）。写一个节点不认识的值，ComfyUI 会判整个任务非法直接拒掉 —— 那比「设置不生效」更糟。

所以这几个字段先问 `GET /object_info/{class_type}`（单节点查询，不是拉几 MB 的全量表）拿到可选值再写：

| 字段 | 挑法 |
|------|------|
| `aspect_ratio` | 找 `16:9` 或 `16:9 (…)` 开头的那一项 |
| `resolution` | 按长边像素挑最接近的一档；`1920x1080` 这种写法还要求朝向一致 |
| `duration` | 挑最接近的可选值（选 9 秒而节点只给 5/10 → 退到 10）；纯数字型的按声明的 `min`/`max` 收边 |

结果按 `baseUrl + class_type` 缓存 30 秒，一个工作流通常只命中一两个节点。**问不到就一律不写**，退回原来的行为 —— ComfyUI 没连上不会导致把任务写崩。

## 9. 结果取回

`/history/{promptId}` 的 `outputs` 结构各节点并不统一，[comfyOutputs.ts](../src/services/comfyOutputs.ts) 两层兜底：

1. **按已知键名**：图片 `images`/`image`，视频 `videos`/`video`/`gifs`，音频 `audio`/`audios`；
2. **按扩展名**：键名认不出时扫描其余键，按 `.mp4`/`.png`/`.mp3` 这类扩展名认领。

找到后拼成 `{baseUrl}/view?filename=…&subfolder=…&type=output`。视频按 `['video', 'image']` 的优先级找 —— `SaveWEBM`/`SaveVideo` 常把成片挂在 `images` 下。

轮询节奏：**3 秒一次，最多 1200 次（1 小时）**。失败信息从 `status.messages` 里倒着找 `exception_message` / `error` / `message`，找不到就报「ComfyUI 执行失败」。执行完成但取不到目标媒体，报「执行完成但未返回目标媒体」。

## 10. 断点续查

`savePendingTask` 在提交前落盘，`taskId` 留空、`submitted: false`；拿到 `prompt_id` 后回填 ID 和实际服务器地址。只有已记录 ID 的任务才能由 [pollManager.ts](../src/services/pollManager.ts) 继续查询。提交响应丢失或关窗时尚未记下 ID 的任务仍不能自动找回，也不会自动重新提交。

- history 请求连续失败或查询达到一小时上限：抛出 `ComfyPendingError`，保留任务并标记 `comfyRecoveryState=disconnected`。节点显示“继续查询”和“再次终止”；续查复用原 ID，不再次生成。
- 取消前先标记 `cancel_pending` 并停止本地等待。远端取消得到成功响应后清理；请求失败保留记录和重试入口。重开项目不会自动再次发送取消请求。
- 执行成功、明确执行失败、连续确认 history/queue 都不存在以及节点删除：正常清理。旧控制器退出或旧取消回执不得删除新任务。
- 恢复下载回填须复核任务、项目和 canvas derivation guard；项目或画布已变化时保留任务供再次查询。
- 已有可恢复任务时禁止覆盖提交；用户先续查或确认终止后再生成。

正常生成的实时进度保存在非持久化 UI Store，图片、动画、视频和音频节点共用 `NodeGenerationProgress`。WebSocket 失效时继续 HTTP 轮询，恢复任务当前仍以 HTTP 续查为主。

## 11. ComfyUI 编辑窗口与回写

工作流列表里点铅笔图标会开一个独立的 ComfyUI 窗口：

1. **检查数据与缺失节点** —— 先校验 API JSON；`findMissingNodeClasses` 比对 `/object_info`，最多等待 4 秒。缺失检查仅作提示，不阻止 ComfyUI 显示缺失节点；
2. **开窗与载入** —— `open_comfyui_window` 接收请求 ID 和两份 JSON。`bridge.js` 等待画布与前端启动恢复完成，实际载入已有标签的当前草稿，或为新工作流载入编辑布局。空白、损坏或载入失败的布局尝试从 API 重建；新载入的节点居中，已有草稿保留视口；
3. **确认结果** —— 原生端最多等待 60 秒，校验同源页面、请求 ID 和非空画布回执后才返回成功。打开请求串行，重复请求合并；面板显示检查、载入、成功或失败状态，失败可重试。桥接**只对 loopback 地址注入**，远程工作流自动载入明确报错，普通远程页面仍可打开；
4. **保存** —— 桥接脚本把两种格式的 JSON 打包放到 `window.__AI_CANVAS_PENDING_SAVE_PAYLOAD__`，Rust 用 `eval_with_callback` 取回来、校验（分类合法、两份 JSON 都能解析、都不超 16 MiB），再 `emit` 出 `comfyui-workflow-save` 事件；
5. **落库** —— 前端 `initComfyUIWindowBridge` 收到事件后再校验一次，已存在就更新（重新识别 IO 节点、剪掉失效的默认节点），不存在就新建。

回写接受 `wf-*`、`builtin-*` 和 MCP 创建的 `workflow-mcp-*`（`WORKFLOW_ID_PATTERN`）。既有记录原地更新，保留服务器绑定并清理失效默认输入；无效 ID 不能覆盖既有记录。

保存身份绑定 ComfyUI 的真实标签对象，切换或重命名标签不改变对应记录。未知标签按新工作流命名保存，不按同名文件推断目标。“另存到 AI Canvas”创建新记录。导出期间切换标签时拒绝该次保存；延迟保存回执只绑定发起保存的标签，打开失败不改绑当前标签。前端版本无法提供标签身份时采用新建保存，不回退到最后一次打开的记录。

面板保持打开不关：ComfyUI 那边存回来后列表会实时刷新，方便接着改默认节点。连接检查失败会返回错误，保留已有编辑窗口及未保存草稿。

### 11.1 助手动态工作流与服务器绑定

[comfyAgentService.ts](../src/services/comfyAgentService.ts) 负责助手的模型发现、动态工作流校验、执行和成功后的保存；[comfyTools.ts](../src/services/chat/tools/comfyTools.ts) 通过既有 Registry 暴露给内部助手与 MCP。

- `comfyui_discover` 的 `resource=servers` 列出设置中的有效 HTTP(S) 服务器名称和 ID，不发网络请求，也不返回服务器地址。默认服务器标记 `isDefault=true`，通过省略 `serverId` 选择；其他服务器使用返回的 ID。即使没有默认地址，只要配置了额外服务器，工具也可用。
- 查询 `models`/`nodes` 和 `comfyui_validate_workflow` 可传相同 `serverId`。省略时沿用默认服务器；显式 ID 无效时拒绝，不回落。校验凭证固定任务、项目、服务器 ID 和当时地址，执行工具只接收凭证，不接收任意地址或另选服务器。
- 节点与模型缓存按实际地址隔离，保留 30 秒、每类最多 16 个地址；失败缓存会清理。发现或校验的异步读取返回时、执行前都会重新核对配置；改址或删除服务器后须重新校验。
- 已提交任务继续在原地址查询或取消。成功后的保存凭证保留服务器绑定，保存前再次核对配置；保存的工作流写入既有 `serverId`。普通工作流保存后遇到服务器删除时仍使用原有默认回落策略。
- 工具摘要显示所选服务器名称；模型发现/校验仍为 `read`，执行为 `media_generation`，保存为 `file_write`，权限与审批遵循既有 Policy。

本阶段未改变输出数量、动态工作流任务恢复或节点参数映射规则。真实多服务器联调与生成仍需运行验收。

## 12. 已知限制

- **`ai-text` 分类不能执行** —— 能导入、能分类，但文本生成不走 ComfyUI。
- **尚无用户自定义参数映射面板** —— 尺寸按字段规则及节点声明注入，组合工作流仍需检查实际生效的字段。
- **有秒数节点时帧率不生效**，见 [§8.4](#84-视频参数)。
- **字段名不在表里的工作流不会被注入** —— 比如用 `video_length`、`seconds` 之类自定义命名的节点。
- **浏览器开发模式下**编辑窗口、保存回写、本地启动 ComfyUI 都不可用（依赖 Tauri）。
- **远程编辑窗口不注入保存桥接**，远程服务可执行工作流，但不具备与本地窗口相同的自动载入、保存回写能力。
- **多结果尚未批量交付**：当前返回首个匹配媒体；参数面板、运行前体检和多结果管理属于后续扩展。

## 13. 相关文件

| 文件 | 职责 |
|------|------|
| [src/services/comfyWorkflowService.ts](../src/services/comfyWorkflowService.ts) | 执行运行时：注入、上传、提交、轮询 |
| [src/services/comfyOutputs.ts](../src/services/comfyOutputs.ts) | 从 `/history` 输出里认领产物并拼 `/view` 地址 |
| [src/services/comfyUIWindowService.ts](../src/services/comfyUIWindowService.ts) | IO 节点识别、编辑窗口、保存回写 |
| [src/services/builtinWorkflows.ts](../src/services/builtinWorkflows.ts) | 内置工作流播种 |
| [src/services/aiDimensions.ts](../src/services/aiDimensions.ts) | 尺寸/帧数/秒数换算 |
| [src/components/WorkflowPanel.tsx](../src/components/WorkflowPanel.tsx) | 工作流管理面板 |
| [src/store/store.workflows.ts](../src/store/store.workflows.ts) | 工作流 CRUD 与持久化 |
| [src-tauri/src/media/comfyui/mod.rs](../src-tauri/src/media/comfyui/mod.rs) | 启动本地 ComfyUI、编辑窗口、保存 payload 校验 |
| [src-tauri/src/media/comfyui/bridge.js](../src-tauri/src/media/comfyui/bridge.js) | 标签身份绑定、编辑载入与保存握手 |
| [tests/services/comfyBridgeSaveIdentity.test.ts](../tests/services/comfyBridgeSaveIdentity.test.ts) | 多标签保存和异步身份回归 |
| [tests/services/comfyWorkflowEditor.test.ts](../tests/services/comfyWorkflowEditor.test.ts) | 打开回执、并发限制与缺节点检查超时 |
| [tests/components/workflowEditorInteraction.test.tsx](../tests/components/workflowEditorInteraction.test.tsx) | 加载反馈、重复点击与失败重试交互 |
| [tests/services/comfyTaskRecovery.test.ts](../tests/services/comfyTaskRecovery.test.ts) | 取消、断线、续查与过期回执回归 |
| [tests/services/comfyVideoParams.test.ts](../tests/services/comfyVideoParams.test.ts) | 视频参数注入的回归用例 |

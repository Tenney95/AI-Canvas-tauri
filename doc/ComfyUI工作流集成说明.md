# ComfyUI 工作流集成说明

> 本文档描述 AI Canvas 如何导入、管理和执行 ComfyUI 工作流，包括 IO 节点识别、内容与参数注入规则、结果取回和编辑回写链路。
> 最后更新：2026-10-11。范围、验证与回滚见[可靠性修复](./plans/2026-09-08-comfyui-reliability.md)、[助手多服务器支持](./plans/2026-09-08-comfyui-assistant-servers.md)、[打开与编辑体验](./plans/2026-09-08-comfyui-editor-experience.md)和[独立管理窗口](./plans/2026-10-11-comfyui-management.md)。

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
- **本地安装目录**：通过主窗口原生选择器保存到用途专属的私有安装授权；`config.comfyUIPath` 仅作显示镜像。私有存储由 fs 插件之后注册的隐私插件在 `Builder::build` 初始化时隔离，早于配置窗口/Renderer 创建，初始隔离失败则终止应用启动；每次读写仍复核。启动与管理恢复原生记录，正常重启无需重新选址；旧配置首次使用可原生确认一次已有目录。取消或保存失败保留旧选择，更换前需关闭管理窗口；目录离线、链接替换或记录损坏时拒绝，不改用镜像授权。
- **本地启动**：`launch_comfyui` 固定使用 `--listen 127.0.0.1 --enable-cors-header`。端口及常用参数由原生启动设置提供，按实际安装的 CLI 声明校验；通过设置页启动时，主窗口同步默认服务地址到该回环端口。源码只从所选根内的固定候选识别；Comfy Desktop 源码在 Electron 目录同级时应选包含源码的基目录。无根内源码的 Windows 安装仅支持固定启动器的默认启动兜底，不能越界进行源码/API 模式或版本管理。
- **独立管理窗口**：启动与打开页面之间的「设置」按钮打开单例 Tauri 管理窗口，提供内核标签/提交/分支、已装插件启停/更新/切换版本/可恢复卸载、官方 Git 节点目录与仓库 URL 安装，以及常用启动设置。主窗口先授权安装并由 Rust 绑定会话；窗口只获取精简外观信息，不读取全量配置或凭据。Git 节点下载后默认停用，依赖安装另经原生信任确认，不执行 `install.py`；非 Git 内核不支持版本写入。已实现，待用户验证，本次未运行测试；范围、限制与桌面验收见[专项计划](./plans/2026-10-11-comfyui-management.md)。
- **显存与缓存**：设置页可按服务器读取 `/system_stats`，并手动调用 `/free` 的“卸载模型”或“完全释放”。默认策略为“保留智能缓存”；只有用户显式选择时，任务终态后才会在队列空闲时自动释放，而且自动策略仅作用于 `localhost`、`127.0.0.1` 和 `::1`，不会清理远程或共享服务器。

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

[builtinWorkflows.ts](../src/services/builtinWorkflows.ts) 内置了 10 个 MiniMax H3 视频工作流（原有文生/图生/参考生 × 普通/Turbo、3 个 PDD，以及 12GB 极速图生视频）、DLSS5 图片与视频材质增强各 1 项、2 个 AuK、3 个 Qwen3 和 2 个 Breeze TTS 2 音频工作流。每项可独立声明分类，未声明时保留视频分类。API JSON 打包在 `src/assets/comfyWorkflows/` 下，界面格式放在同级 `ui/` 里。

**DLSS5 材质增强**

两项来自 `DLSS5_图片材质增强_工作流.json` 与 `DLSS5_视频材质增强_工作流.json`，分别注册为 `builtin-dlss5-image-enhance`（`ai-image`）和 `builtin-dlss5-video-enhance`（`ai-video`）。默认素材入口均为节点 1，无提示词入口；通过图片或视频引用提供待增强素材。图片模板的 `example.png` 清空，避免依赖示例文件。编辑图保留原布局、说明和增强参数；API 图移除说明节点、上传按钮与视频预览控件。

两项均采用 `DLSS5Settings → DLSS5EnhanceImages`，保留原始 1x、Natural、强度 1、结构强度 1.5、皮肤强度 2、自动蒙版和 M 档配置。图片通过 `SaveImage` 输出；视频采用 `VHS_LoadVideo → DLSS5EnhanceImages → CreateVideo → SaveVideo`，原音轨仍从加载节点连接到合成节点。默认整段加载、24fps、10-bit 合成，画布帧率控件沿既有规则覆盖合成帧率；应选择与源视频一致的帧率，避免变速与音画不同步。目标 ComfyUI 需提供 DLSS5 自定义节点及其运行环境、VideoHelperSuite 和图中的原生视频节点，内置模板不会安装这些依赖。

按固定 ID 增量播种，不覆盖已有工作流或恢复用户已删除项；可通过“重置内置工作流”手动恢复。验证入口为 `builtinWorkflows.test.ts`，覆盖增量播种、分类与默认输入、API/UI 连线、增强参数、素材注入和结果解析；真实增强效果与硬件兼容性仍需目标 ComfyUI 验收。回滚撤销本批注册、四份资源、测试和文档补丁；已播种的两条用户工作流记录可单独删除。

本次接入验证：内置工作流、默认输入、媒体路由、图像/视频参数、编辑打开、工作流持久化及模型选择器共 8 个测试文件、145 项通过；应用和测试类型检查、定向 ESLint、严格 UTF-8 与 JSON 检查通过。未启动 ComfyUI 或执行真实增强，未更新已安装应用。

| AuK 工作流 | 默认输入 | 输出 |
|---|---|---|
| 文生语音（`builtin-auk-tts`） | 输入朗读正文，提交时与面板声音描述组合到节点 4 的 `instruction` | FLAC |
| 参考音频与声音克隆（`builtin-auk-voice-cloning`） | 节点 10 的 `task.text`：要说的台词；节点 7 的 `audio`：通过 @ 或连线提供的参考音频 | MP3，V0 |

AuK 资源来自提供的 `AuK-文生语音.json` 和 `AuK-参考音频与声音克隆.json`；界面格式原样保留布局，执行图移除说明节点，并按节点声明转换控件和连线。依赖 ComfyUI-AuK 与 `SaveAudioAdvanced`，原模型选择为 `auk_flash_w4a8.safetensors`、`qwen_omni_w4a8.safetensors`、`auk_vae.safetensors`。模型和节点仍需在目标 ComfyUI 安装；内置工作流不会安装或启动它们。

资源保留原工作流 3 秒、种子 42 等参数。语音参数面板可覆盖本次生成时长；未设置时采用图中的时长。克隆前必须通过 @、连线或显式音频输入提供参考语音，缺少参考时在上传与提交前报错，不使用图内示例文件。`task.text` 与保存节点的 `format.quality` 使用 ComfyUI DynamicCombo 的点分隔输入格式。

验证入口：`builtinWorkflows.test.ts`、`audioSpeechSettings.test.ts`、`comfyWorkflowAudioIO.test.ts`、工作流编辑与保存回写测试。网络由测试替身模拟，未启动 ComfyUI 或执行真实生成。源码回滚撤销对应改动即可；已添加到用户工作流库的两条记录可由用户单独删除，既有视频工作流不变。

| Qwen3 工作流 | 默认输入 | 执行链路 |
|---|---|---|
| 01 原声1比1克隆（`builtin-qwen3-voice-clone`） | 节点 3 的 `target_text`：新台词；节点 1：参考音频 | ASR 转写参考语音，连接克隆节点的 `ref_text`，输出 FLAC |
| 02 文生语音抽卡（`builtin-qwen3-voice-design`） | 节点 1 的 `text`：新台词；`instruct` 保留图中的声音描述 | VoiceDesign 生成，输出 FLAC |
| 03 参考音频抽卡-支持方言（`builtin-qwen3-reference-voice-design`） | 节点 3 的 `target_text`：新台词；节点 1：参考音频 | ASR 与克隆生成源语音；节点 5 生成目标音色样本；SeedVC 转换后输出 FLAC |

三项均归 `ai-audio`，分别来自用户提供的 `Qwen3-TTS-01-原声1比1克隆.json`、`Qwen3-TTS-02-文生语音抽卡.json`、`Qwen3-TTS-03-参考音频抽卡-支持方言.json`。编辑图逐字节保留源文件，执行图按实际控件和连接转换，移除说明节点与 UI 专用控件。内置名称沿用原文件，不代表克隆相似度或方言效果已经验收。

运行依赖 [ComfyUI-Qwen-TTS](https://github.com/flybirdxx/ComfyUI-Qwen-TTS)；01、03 还依赖 [ComfyUI-QwenASR](https://github.com/1038lab/ComfyUI-QwenASR)，03 另需提供 `SeedVCVoiceConversion` 的节点包与模型。模型与插件由目标 ComfyUI 提供，内置不会安装它们。01、03 使用前须提供参考音频；原图的空输入不替换为机器上的示例文件。03 的目标音色样本正文和声音描述保留原值，默认台词只送入克隆节点，不同时改写音色样本。

Qwen 克隆台词使用精确字段 `target_text`，默认输入与显式 @ 均支持，保持 `ref_text` 转写连线。02、03 的声音设计节点在编辑图中设置了 `randomize`，默认每次提交换种子；01 的克隆种子、03 的克隆与 SeedVC 种子默认固定。语音面板可独立切换两条 TTS 链路的固定／抽卡模式。种子连线不被覆盖；无有效编辑图或旁路设置时默认固定，不改写持久化图。

Qwen 验证入口为 `builtinWorkflows.test.ts`、`audioSpeechSettings.test.ts` 和 `comfyWorkflowAudioIO.test.ts`，覆盖增量播种、API/UI 连线、参数映射、默认与显式引用、模拟音频结果、参数保存和抽卡种子；范围与回滚见[三项音频工作流接入](./plans/2026-09-15-qwen-audio-workflows/task_plan.md)。未启动 ComfyUI 或进行真实生成；第 03 项 SeedVC 节点的安装、执行和听感仍需目标环境验收。

播种按 id **逐个记账**在 `localStorage` 的 `aicanvas.builtinWorkflows.seededIds`：

- 中途出错的那一批下次启动会重来；
- 用户删掉的不会自己长回来；
- 后续版本新增的会在下次启动自动补上。

### 4.3 从 ComfyUI 编辑后保存回来

见 [§11](#11-comfyui-编辑窗口与回写)。

### 4.4 语音参数面板

`AudioParamSelector.tsx` 复用现有弹层与主题控件；`services/ai/audioSpeechSettings.ts` 统一管理声音描述、引用状态和 AuK 参数注入。按可验证的单路 `AuKGenerateEdit → AuKInstructionEncode` 结构识别能力，支持直接指令或匹配模式的 `AuKInstructionBuilder`，不依赖内置工作流 ID。

- 纯文本：男声、女声、正太、萝莉、小女孩、小男孩。正太与萝莉使用动画风格描述，小男孩与小女孩使用自然儿童声音描述。
- 带参考语音：通过 @ 音频、@ 角色声音、连线或显式音频输入识别；隐藏声音类型，以参考音色为准。可添加、替换、移除引用，移除后恢复已保存的纯文本音色；本节点已有的生成结果不会自动成为参考。
- 参考语音工作流在模型选择器后显示「角色主声音」下拉，按本项目／全局角色分组，只列出有效主声音。列表使用统一主题的自定义弹层，每行可独立试听／停止，试听不改变选择；切换试听项、关闭列表或切换节点／工作流时释放播放器。选中后作为显式音频输入，编辑台词时保留；清空后恢复 @／连线参考。项目声音保留片段引用，全局声音使用持久化音频快照，之后更换角色主声音不会自动替换已选音频。
- 两种状态均提供五档语速描述与生成时长。AuK 没有合成速度倍率输入，滑块不承诺精确倍速；克隆调速描述写入编码指令，不写入朗读台词。时长范围为 1–3600 秒，滑块常用范围 1–60 秒，数值输入可设置更长时间。
- 不自动切换工作流。纯文本图遇到参考音频、克隆图缺少参考音频时提示切换或补充引用。显式音频输入优先，其次 @ 引用，再次连线；当前克隆图仅有一个参考音频入口。
- 节点保存 `audioSpeechSettings`，弹窗、快捷和批量生成均传入统一链路并记录输出历史。按已确认边界，继续沿用现有结构撤销语义，参数值不随画布撤销恢复。
- 普通厂商原生音色 ID、格式及倍率配置保持原语义；不把六类描述式声音伪装成厂商 voice ID。只改本次提交图，保留工作流库中的源图、采样配置和保存格式。

验证包括引用增删与失效、纯文本/参考面板结构、暗浅主题容器、参数序列化、快捷及批量传递、两类 AuK 请求与原图不变。主题结构检查不替代浏览器视觉验收，真实音色与语速需在目标 ComfyUI 试听。

本阶段验证：8 个定向测试文件共 114 项通过；前端类型、测试类型、定向 ESLint、差异与严格 UTF-8 检查通过。按确认结果保留现有画布结构撤销行为。

#### Qwen3 参数

三项 Qwen 工作流也复用该入口和参考管理。`qwenSpeechSettings.ts` 按实际节点与连接识别单路合成、ASR 克隆及 SeedVC 转换，不依赖内置 ID；`QwenSpeechControls.tsx` 渲染声明字段。默认值来自工作流，只有主动编辑才覆盖。

| 工作流 | 常用设置 | 折叠高级设置 |
|---|---|---|
| 01 原声克隆 | 参考音频、合成语言、固定／随机种子、生成 token 上限 | 克隆采样、仅提取音色特征、ASR 语言／提示词／规范化、模型运行选项 |
| 02 文生抽卡 | 六类声音预设、自定义音色描述、描述式语速、语言、抽卡／固定种子、token 上限 | 采样与模型运行选项 |
| 03 参考抽卡 | 参考音频、目标音色描述；克隆和目标音色分别设置语言、种子及 token 上限 | 两组采样、目标音色样本正文、ASR、SeedVC 转换和模型运行选项 |

- 采样包含 Temperature、Top P、Top K 和重复抑制；运行选项仅开放图中已有的模型、设备、精度、注意力实现及卸载设置。VoiceDesign 仅支持 1.7B，不提供无法加载的 0.6B。
- Qwen 不提供精确生成秒数，`max_new_tokens` 是长度上限，过低可能截断。02 的语速写入声音描述；03 只引导目标音色样本语速，最终时长另受 SeedVC 长度倍率影响。01 沿用参考声音，不展示无效的描述式语速。
- 03 的新台词仍写入克隆节点；面板样本正文只改目标音色样本，显式 @ 样本正文优先于面板保存值。参考转写保持 ASR 连线。
- SeedVC 提供原图已有的音色强度、步数、CFG、参考秒数、基频调整、移调、长度倍率、种子、增益和峰值保护。用户编辑的转换参数提交前读取目标服务节点声明；声明不可用或数值超范围时明确报错，不推断未知范围。
- 参数保存在 `audioSpeechSettings.qwen[workflowId]`，切换工作流互不覆盖；“恢复此工作流默认参数”只清除此项覆盖。AuK 参数和既有快捷、批量及历史传递链路保持兼容。
- 弹层限高并可滚动，高级组折叠，下拉使用现有 Portal。实际组件独立预览覆盖暗浅主题、参考增删、种子模式、描述预设、转换开关、滚动和恢复默认；不等同于完整桌面应用或真实模型验收。

## 5. IO 节点识别

`extractComfyUIIONodes`（[comfyUIWindowService.ts](../src/services/comfyUIWindowService.ts)）扫一遍 API JSON，按 `class_type` 归类：

| 类型 | 匹配的 class_type |
|------|------------------|
| `image` | `LoadImage*` |
| `video` | `LoadVideo*`、`VHS_LoadVideo*`、`VHS_LoadVideoPath*` |
| `audio` | `LoadAudio*`、`VHS_LoadAudio*`、`RecordAudio*` |
| `prompt` | `CLIPTextEncode`、`*TextEncode`、`StringLiteral`、`PrimitiveString`、`ShowText`/`pysssss` |

类型规则没命中时还有一层兜底：节点的 `inputs` 里只要有名字含 `text` / `prompt` / `writing`，或名为 `instruction`（包括点分隔子字段），且值是非空字符串的输入，就算作 `prompt` 类型。`showAnything`、`PreviewAny`、`DisplayText` 这类展示节点排除在外 —— 它们的 `text` 是给人看的结果，不是提示词入口。

识别结果只是**候选清单**，用来在提示词框里 `@` 和在面板上标默认节点，不影响参数注入。

## 6. 默认节点 defaultNodes

工作流管理面板里点节点徽章可以把它设为该类型的默认节点（徽章变 ★）。

- 提示词：未显式指定 prompt IO 时写默认提示词节点；显式填写 prompt IO 时保持原来的逐节点赋值规则。
- 图片、视频、音频：直接在提示词里 @ 素材即可。同类按引用先后依次填写上传型 IO；有默认节点时优先填默认节点，其余按 IO 列表顺序；无默认设置也会自动匹配。
- 显式赋值的媒体槽优先保留。同一素材也出现在普通引用时不重复分配；其余普通引用继续填未显式赋值的槽。
- 无上传型输入或引用数量超过剩余槽数时，在上传和提交前报错，不静默丢弃素材。仅接受主机路径或已连线的输入不占用引用次序。
- 三种输出工作流（图片、视频、音频）均传递三类参考。ComfyUI 直接 @ 的引用优先于连线及参考面板；图片工作流的项目风格母图追加在直接引用后，并写明实际编号。RunningHub 和 workflow-api 沿用各自协议。

在 ComfyUI 里改完结构存回来时，指向已不存在节点的默认设置会被 `pruneDefaultNodes` 丢掉。MCP 可通过 `workflow_create` / `workflow_update` 的 `defaultNodes` 设置默认输入，详见 [MCP控制模块](./MCP控制模块.md)。

## 7. 执行链路

以视频为例，`executeComfyUIVideoGenerate` 的完整顺序：

1. **预存待续任务** —— 在提交之前写 `savePendingTask`（`submitted: false`），拿到 `prompt_id` 后才具备续查条件；
2. **解析工作流** —— 从 store 取 `fileContent` 并 `JSON.parse`，得到可改的 `workflowObj`；
3. **注入提示词** → `injectPromptsIntoWorkflow`；
4. **规划三类媒体槽位** → `injectMediaIntoWorkflow`，验证显式引用、可用槽及溢出；
5. **上传并回填** → 显式槽优先、普通素材顺序分配，保留上传子目录；
6. **清理空可选参考支路**，保留必填用途和原模板；
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
| 指定了默认提示词节点，且没 `@` 过提示词节点 | 只写这一个节点，写它第一个存在且是字符串的键（`text` → `target_text` → `prompt` → `string` → `value` → `instruction`）；无直接字段时查找同名的点分隔子字段 |
| 没有任何 `@` 赋值，也没默认节点 | 兜底猜测：遍历所有 `text`/`prompt` 输入，**只替换看起来像占位符的值**（长度 < 10 且不含空格，例如 `t-1`） |
| 有 `@` 赋值 | 只写被 `@` 命中且在 `ioNodes` 里的节点，其余保持原值 |

显式赋值仅处理 `prompt` 类型 IO，与默认输入共用 `text → target_text → prompt → string → value → instruction` 字段顺序；没有直接字段时，按输入顺序取第一个匹配上述名称的点分隔子字段（例如 `task.text`）。只写已有的字符串字段，保留连线。显式赋值无法找到可写字段时在提交前报错，不静默使用旧文本。

### 8.2 图片 / 音频 / 视频

媒体统一先上传到 ComfyUI 的 `/upload/image`（ComfyUI 只有 `/upload/image` 和 `/upload/mask` 两个上传路由，前者不校验扩展名，音频视频同样走它），再把返回的文件名写进节点：

| 类型 | 写入的输入键 |
|------|-------------|
| 图片 | `image`（并同步 `upload` 字段） |
| 视频 | `video`，没有就试 `file`（核心 `LoadVideo` 用的是 `file`） |
| 音频 | `audio`（并同步 `upload` 字段） |

上传输入支持已有的字符串或 null/undefined 空值，保留连线。显式引用未解析或指定不可上传输入时先报错；主机路径加载节点在自动分配时跳过。三类媒体统一保留上传返回的子目录。

`injectMediaIntoWorkflow` 在用户带来普通参考媒体时，也会尝试摘掉未填的可选参考支路，避免使用模板旧素材。只有终点均为可选输入才清理；必填用途保留。纯显式赋值保持其余非空输入；完全不传素材时也保留模板已配置的文件。

提交前还会统一检查图片、视频和音频上传节点。导入工作流把未选择文件保存为 `null` 或空字符串时，若该节点只连接到 autogrow 槽或 `/object_info` 声明的 `optional` 输入，会自动移除空连接与无用支路；必填连接、独立终点和无法确认的结构保持不变，避免为了绕过空素材而破坏工作流主体。这项清理适用于所有本地 ComfyUI 工作流，不依赖特定自定义节点名称。

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
- **显示与提交使用相同的默认时长**。未保存秒数和帧数时均为 5 秒；显式选择 3 秒就提交 3 秒。旧节点已有帧数时继续兼容换算，界面不再凭空补 77 帧显示成 3 秒。
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

### 8.6 未填充的可选媒体分支

提交副本中，`pruneUnfilledOptionalMediaBranches` 检查识别出的图片/视频/音频上传节点：文件值为 null、undefined 或空白时，只清理能够确认属于可选输入的分支。可选关系来自节点声明或支持的可选槽结构，不按用户提示词猜测。

必填连接、独立终点、非空文件名和无法识别的结构保留，让服务端给出真实错误；不会删除保存的工作流定义，也不能把缺失模型或必填素材问题变成成功。该逻辑与默认 ★ 输入、显式 @ 注入配合，详细步骤见[说明书 13.10](../site/manual.html#comfy-progress)。

## 9. 结果取回

`/history/{promptId}` 的 `outputs` 结构各节点并不统一，[comfyOutputs.ts](../src/services/comfyOutputs.ts) 两层兜底：

1. **按已知键名**：图片 `images`/`image`，视频 `videos`/`video`/`gifs`，音频 `audio`/`audios`；
2. **按扩展名**：键名认不出时扫描其余键，按 `.mp4`/`.png`/`.mp3` 这类扩展名认领。

找到后拼成 `{baseUrl}/view?filename=…&subfolder=…&type=output`。视频只认视频扩展名；`SaveWEBM`/`SaveVideo` 即使把 `.mp4` / `.webm` 挂在 `images` 下也能识别，但编码前的 `PreviewImage` PNG 不再被当成成片。

轮询节奏：**3 秒一次，最多 1200 次（1 小时）**。当 history 带 `status` 时，必须等到 `completed=true` 或 `status_str=success` 才交付输出；没有 `status` 的旧兼容服务仍按已有输出判断。失败信息从 `status.messages` 里倒着找 `exception_message` / `error` / `message`，找不到就报「ComfyUI 执行失败」。执行完成但取不到目标媒体，报「执行完成但未返回目标媒体」。

### 9.1 显存释放边界

- `/history` 记录清理与 GPU 显存释放是两回事；本项目不会通过删除 history 来“清显存”。
- “卸载模型”发送 `{ unload_models: true, free_memory: false }`；“完全释放”发送 `{ unload_models: true, free_memory: true }`。后者还会清执行缓存，下次生成需要重新加载模型。
- 自动释放前会查询 `/queue`；只要存在运行中或等待中的任务就跳过，避免一项任务结束时影响同一服务上的其他任务。
- 手动释放是整台 ComfyUI 服务级操作，允许用户针对已配置服务器主动执行；共享服务器上使用前须确认不会影响其他调用方。
- 常规连续生成建议保持默认智能缓存。只有显存需让给其他应用、工作流切换后长期占用或特定节点确有缓存异常时，才考虑卸载或完全释放；这不是每次 API 调用的必要步骤。

## 10. 断点续查

`savePendingTask` 在提交前落盘，`taskId` 留空、`submitted: false`；拿到 `prompt_id` 后回填 ID 和实际服务器地址。只有已记录 ID 的任务才能由 [pollManager.ts](../src/services/pollManager.ts) 继续查询。提交响应丢失或关窗时尚未记下 ID 的任务仍不能自动找回，也不会自动重新提交。

- history 请求连续失败或查询达到一小时上限：抛出 `ComfyPendingError`，保留任务并标记 `comfyRecoveryState=disconnected`。节点显示“继续查询”和“再次终止”；续查复用原 ID，不再次生成。
- 取消前先标记 `cancel_pending` 并停止本地等待。远端取消得到成功响应后清理；请求失败保留记录和重试入口。重开项目不会自动再次发送取消请求。
- 执行成功、明确执行失败、连续确认 history/queue 都不存在以及节点删除：正常清理。旧控制器退出或旧取消回执不得删除新任务。
- 恢复下载回填须复核任务、项目和 canvas derivation guard；项目或画布已变化时保留任务供再次查询。
- 已有可恢复任务时禁止覆盖提交；用户先续查或确认终止后再生成。

正常生成的实时进度保存在非持久化 UI Store，图片、动画、视频和音频节点共用 `NodeGenerationProgress`。WebSocket 失效时继续 HTTP 轮询，恢复任务当前仍以 HTTP 续查为主。

- 本地默认端口 8188 在 Vite 开发环境（含 Tauri dev）通过同源 `/api/comfyui/ws` 代理读取进度，保留原始 Host/Origin 供 ComfyUI 校验，避免页面来源为 `localhost:1420` 时直连被拒绝。生产环境及其他服务器仍按原地址连接。
- 百分比来自 ComfyUI 当前执行节点的 `value/max`；切换节点或任务收尾会清除旧数值，不能把单节点的 100% 当作成片完成。提交响应前收到的事件按 promptId 暂存并在绑定后匹配。
- 连接超时或断线后复用同一 clientId，最多重连三次，只恢复进度读取，不重提生成；取消或结束时清理连接、计时器及进度。
- 回归入口：[时长显示](../tests/components/videoParamSelectorProtocol.test.ts)、[H3 请求参数](../tests/services/builtinWorkflows.test.ts)、[实时进度与代理握手](../tests/services/comfyProgress.test.ts)。代理测试覆盖真实 WebSocket 握手、采样事件透传和跨站来源 403；实际模型执行不属于该自动化测试。

## 11. ComfyUI 编辑窗口与回写

工作流列表里点铅笔图标会开一个独立的 ComfyUI 窗口：

1. **检查数据与缺失节点** —— 先校验 API JSON；`findMissingNodeClasses` 比对 `/object_info`，最多等待 4 秒。缺失检查仅作提示，不阻止 ComfyUI 显示缺失节点；
2. **开窗与载入** —— `open_comfyui_window` 接收请求 ID 和两份 JSON。`bridge.js` 等待画布与前端启动恢复完成，实际载入已有标签的当前草稿，或为新工作流载入编辑布局。空白、损坏或载入失败的布局尝试从 API 重建；新载入的节点居中，已有草稿保留视口；
3. **确认结果** —— 原生端最多等待 60 秒，校验同源页面、请求 ID 和非空画布回执后才返回成功。打开请求串行，重复请求合并；面板显示检查、载入、成功或失败状态，失败可重试。本地与远程 HTTP(S) ComfyUI 均支持自动载入；桥接和工作流正文只注入配置地址同源的顶层页面，窗口拒绝跨来源导航；
4. **保存** —— 桥接脚本把两种格式的 JSON 打包放到 `window.__AI_CANVAS_PENDING_SAVE_PAYLOAD__`，Rust 用 `eval_with_callback` 取回来、校验（分类合法、两份 JSON 都能解析、都不超 16 MiB），再 `emit` 出 `comfyui-workflow-save` 事件；
5. **落库** —— 前端 `initComfyUIWindowBridge` 收到事件后再校验一次，已存在就更新（重新识别 IO 节点、剪掉失效的默认节点），不存在就新建。

回写接受 `wf-*`、`builtin-*` 和 MCP 创建的 `workflow-mcp-*`（`WORKFLOW_ID_PATTERN`）。既有记录原地更新，保留服务器绑定并清理失效默认输入；无效 ID 不能覆盖既有记录。

保存身份绑定 ComfyUI 的真实标签对象，切换或重命名标签不改变对应记录。未知标签按新工作流命名保存，不按同名文件推断目标。“另存到 AI Canvas”创建新记录。导出期间切换标签时拒绝该次保存；延迟保存回执只绑定发起保存的标签，打开失败不改绑当前标签。前端版本无法提供标签身份时采用新建保存，不回退到最后一次打开的记录。

面板保持打开不关：ComfyUI 那边存回来后列表会实时刷新，方便接着改默认节点。连接检查失败会返回错误，保留已有编辑窗口及未保存草稿。

设置页与工作流编辑入口的原生开窗请求共用串行锁。同源窗口恢复显示并复用；初始 `about:blank` 状态最多等待 5 秒，不据此关闭加载中的窗口。切换服务器时，发出关闭请求后最多等待 5 秒，确认旧 WebView 已注销才创建同名窗口；关闭被取消或状态超时会返回可重试错误，不强制销毁页面。回归入口为 Rust `comfyui::tests`，覆盖加载过渡、延迟注销与超时；真实 WebView2 的窗口显示仍需桌面环境验收。

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
- **远程编辑依赖可访问的 ComfyUI 前端**。配置地址须直接指向目标服务；跨来源登录或跳转不会在编辑窗口放行。桥接不授予远程页面通用 Tauri IPC 权限。既有工作流保存保留服务器绑定；另存的新工作流仍需在列表中选择服务器。
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


### H3 PDD 与 Breeze TTS 2 内置工作流

四项沿用内置 ID 的增量补充机制：已安装版本升级时只补新项，不覆盖用户编辑或恢复用户删除的旧项。来自用户提供的四份 API JSON；没有随附界面布局，`editableContent` 留空，打开编辑走既有 API 图导入路径。

| 模型菜单名称 | 默认输入 | 其他输入与输出 |
|---|---|---|
| MiniMax H3 PDD 图生视频 | 提示词 7；图片 27 | 视频含 H3 生成音频；单张参考图 |
| MiniMax H3 PDD 图生视频＋参考音频 | 提示词 19；图片 35；音频 28 | 音频是生成参考，不是固定原声强制配嘴；单张参考图 |
| Breeze TTS 2 声音克隆 | 台词 12；参考音频 8 | Whisper 转写原文与参考音频共同进入克隆节点，PreviewAudio 返回声音 |
| Breeze TTS 2 声音设计 | 台词 4 | 可通过工作流输入节点 5 单独填写音色描述；PreviewAudio / SaveAudioAdvanced 返回声音 |

添加参考图或音频时使用对应工作流输入；声音设计若显式填写节点 5，也需显式给节点 4 赋台词，遵循现有“已指定同类输入则不走默认值”的规则。图中原有示例文件名保留，实际生成前应提供自己的媒体。模型和自定义节点仍由所选 ComfyUI 服务提供，内置资源不会安装或启动它们。

H3 采用 Ref2VA INT8 主模型与 Ref2VA PDD 8-step 配对、Euler、Sigma Shift 12/3、24fps。依赖 MiniMax H3/PDD、ResolutionSelector 和 ComfyMathExpression 等图内节点；分辨率和时长沿用画布视频参数注入。带参考音频的源图曾把分辨率输出接到 length，内置副本已改为宽高连接 ResolutionSelector、秒数经与另一份图相同的 17n+5 公式转换帧数。两项均只提供一个图片输入，不等同于多图短剧工作流。

Breeze 依赖 ComfyUI-Breeze-TTS-2，克隆还需 whisper-large-v3-turbo；保留用户的模型与采样设置。克隆源图曾把情感描述当作参考音频原文，内置副本改接 Whisper 的 transcript 输出，并移除该未使用的情感文本节点。情绪可使用台词里的发声标签；此项不增加 Voice Direction 模式。

验证入口：`tests/services/builtinWorkflows.test.ts`，覆盖增量补充、默认输入、模拟提交后的图片/音频/台词及分辨率时长、参考转写接线、原图不被提交参数改写。真实 GPU 生成和声音试听需在目标 ComfyUI 另行验收，模拟请求不代表生成质量已验证。

本批接入验证：6 个相关测试文件共 81 项通过，应用与测试类型检查、定向 ESLint 和 release 构建通过。更新后通过 MCP 读取全部 15 项工作流，新增四份执行 JSON 与源码逐字一致，原 11 项元数据保留；未执行真实生成。

### 空视频参考的编辑预览

从 API 打开时，明确为空的 VHS 上传视频输入会同时清理独立预览参数、旧媒体地址和画面，防止控件为空却显示首个默认文件。重新选择视频恢复正常预览。只处理新载入的 API 图，不覆盖已有标签的未保存修改，也不改变有素材的输入；空分支在执行时仍由提交器移除。验证入口：`comfyBridgeSaveIdentity.test.ts`。

### ComfyUI 编辑窗口直接运行可选参考

AI Canvas 提交器和 ComfyUI 自带运行按钮是两个入口。桥接在 ComfyUI 的 queuePrompt 边界只对执行图副本清理空的 H3 参考加载节点：必须所有消费者均为 H3 对应可选参考槽，否则保留。编辑图、另存与重新打开时仍保留全部上传位置。此规则不改文件权限、不使用占位文件、不自动执行或重试。测试覆盖零素材、多素材、空音频错误连接、必填用途保护、保存及重复安装。


### H3 12GB 极速图生视频

`builtin-minimax-h3-i2v-fast-12gb` 对应 **MiniMax H3 图生视频（12GB 极速·4B）**，资源为 `minimax-h3-i2v-fast-12gb.json`。它面向 12GB NVIDIA 显卡使用 FL2VA Pruned INT8 ConvRot 主模型，以 Qwen3-VL 4B INT8 和 ClipProj v3.1 代替 32B 编码器，并使用 INT8 视频 VAE、Turbo v4 EMA 及 4 步 simple 调度。ClipProj 使用 `streaming` 模式，编码完成后将约 5 GB 编码器权重退回内存，为扩散采样释放显存；v3.1 线性投影仅约 26 MB，插件报告其画面指标与 v3 重合，并改善非英语语音发音。

模型链在 Turbo 后接原生 `ModelAttentionBackend`，选择 `comfy kitchen attention`；不与 Spectrum、EasyCache 或 Sol-Attn 叠加。极速模板默认 0.2 百万像素、5 秒、24fps、4 步，画布分辨率和时长控件仍会覆盖模板值；快速运动或更高质量可在编辑器中改为 6 步。Turbo `low_vram` 默认关闭以保留量化主模型上的细节，出现显存不足时可在 ComfyUI 编辑器中开启。

AI Canvas 直接启动本地 ComfyUI 时支持按安装目录启用 `--fast-disk`：目录中存在 `.ai-canvas-fast-disk` 标记文件，且该版本的 `comfy/cli_args.py` 声明了对应参数时才注入。它用于主模型与编码器合计接近或超过系统内存时避免 Windows 分页抖动，不对其他 ComfyUI 安装或旧版本强制开启。

实机验证（RTX 4070 Ti 12GB、32GB RAM）：0.2 百万像素、56 帧、24fps、4 步小样生成 2.33 秒视频并带音频，完整执行 198.04 秒，其中采样 148 秒；未启用 `--fast-disk` 时同一任务因系统内存耗尽与分页抖动，数分钟仍未完成第 1 步。

依赖 `ComfyUI-ClipProj`、`ComfyUI-MiniMax-H3-Turbo`、支持 cu130 INT8 ConvRot 的 PyTorch/Comfy Kitchen，以及 `ImageResizeKJv2`、ResolutionSelector、ComfyMathExpression 等既有节点。该工作流是单张首帧图生视频，不提供 Ref2VA 的多图、视频或音频自由参考能力。

### H3 PDD 自由参考内置工作流

`builtin-minimax-h3-pdd-r2v` 对应 **MiniMax H3 PDD 自由参考（图片·视频·音频可选）**，资源为 `minimax-h3-pdd-r2v.json`。采用 Ref2VA INT8 主模型、配套 PDD 8-step、Qwen3-VL 32B 编码器以及视频/音频 VAE，生成画面和音轨。

- 34 个执行节点、16 个 IO：提示词19、图片101–109、视频201–203、音频301–303。15 个媒体输入均为空文件名，无示例素材；未提供的可选支路按既有提交逻辑移除。
- 默认提示词19、图片101、视频201。音频沿 IO 顺序填充三个槽；显式指定工作流素材输入仍可使用。所有 ComfyUI 工作流均可在没有默认媒体节点时自动分配直接引用。
- 图片0–9张、视频0–3段、音频0–3段，三类总计≤12；视频与音频每段2–15秒，各类型合计≤15秒。当前这些仍是素材准备要求，未增加自动时长或混合总数校验。
- API 图导入编辑，不附加界面布局；视频只接画面参考，独立音频槽接参考声音。保持24fps、9:16模板比例和秒数到帧数的既有换算。
- 通过内置 ID 增量播种，原15项与已编辑/已删除记录不被覆盖。此前通过 MCP 导入的同名用户工作流保留，与内置项是独立记录。

验证入口：`builtinWorkflows.test.ts` 覆盖从15项升级、用户数据保留、空媒体模板、五份模型、零输入、每类数量上限、混合12份、默认提示词、三音频排序、跳空槽与提交副本不修改源图；`comfyBridgeSaveIdentity.test.ts` 覆盖编辑窗口直接运行的空参考清理。均为模拟提交验证，不代表真实推理质量或时长限制已自动验证。

本项接入检查：243 项相关测试、应用和测试类型检查、定向 ESLint、生产前端构建通过；产物包含内置注册与 JSON 资源。未执行真实生成，未更新或重启已安装应用。

统一媒体映射验证入口：`comfyDefaultIONodes.test.ts`、`comfyWorkflowAudioIO.test.ts`、`comfyMediaRouting.test.ts`、`generateVideo.test.ts`，覆盖无默认、多音频、三类型顺序、显式去重、跨类型入口、主机路径跳过和上传前溢出拒绝。模拟提交不代表真实模型生成效果已验收。

统一映射接入检查：限定正式 tests 目录的28个相关测试文件共807项通过，应用/测试类型检查、定向ESLint和生产前端构建通过。未提交真实生成，运行中的安装版需更新后才使用此逻辑。

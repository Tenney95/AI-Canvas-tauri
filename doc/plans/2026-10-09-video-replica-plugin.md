# 视频复刻插件实施计划

状态：宿主、插件、模型/ComfyUI 生成和提示词引用已实现；定向验证通过，真实桌面最终提交与成片验收仍待完成。

**目标**：在独立插件目录中组合 ReShot 控制视频处理与 video-breakdown 的结构化拉片方法，让用户从视频节点完成镜头拆解、角色/风格改写、提示词生成与控制视频输出。

**任务归属**：产品能力，依赖插件平台的通用可信 Python 任务与媒体产物能力补充。主记录归插件平台，不写入 Agent 实施方案。

**架构**：视频节点工具 + 隔离自定义 UI；分析模型由宿主调用；最终提交运行可信 Python 并原子创建派生节点。宿主只补通用执行、输入暂存和产物导入，不内置 ReShot 或拉片业务。

## 1. 产品形态与范围

- 新目录：`D:/www/project/AI-Canvas-Plugin/video-replica/`。现有父目录为空，不移动或覆盖其它项目。
- 入口挂在 `source-video` 和 `ai-video` 的工具栏及右键菜单，名称为“视频复刻”；打开镜头工作区，可由现有宿主按钮另开独立窗口。
- 不新增独立画布节点类型。现有视频操作仅支持当前节点 self 资源；独立插件节点的 incoming 视频和声明式主体无法复用这条交互链。
- 原视频需先下载/导入当前项目；普通远程 URL 不冒充本地授权视频。
- 镜头工作区：选择片段、检测镜头、抽帧、校正起止点、选择分析模型、填写目标角色/场景/风格、编辑镜头描述和生成提示词。
- 分析使用关键帧与有界镜头时间数据；保留用户修改，不重复调用付费模型，不自动重试生成或提交。
- 控制类型提供 depth、pose、canny，默认 depth；深度模型只允许 Small，默认 fast，不提供非商业 Base/Large 权重。
- 每个处理片段强制不超过 15 秒，先真实裁剪再调用 ReShot；按宿主节点与资源额度限制选择数量，超限提示缩小批次。
- 最终输出：分镜表、参考帧、复刻提示词/镜头方案，以及选中的控制视频节点。整批提交一次历史；失败或取消回收本轮暂存与未提交输出。
- 根据用户补充要求，提供“仅生成素材 / 已配置视频模型 / ComfyUI 工作流”。生成方式由用户选择，宿主把逐镜生成节点与参考帧/控制视频连线后交既有视频批次串行执行。模型或工作流必须来自当前安全目录；不承诺任意模型支持控制视频，也不自动拼接为整片。
- 替换角色、替换场景与逐镜提示词提供 `@` 选择器：连线节点、项目/全局角色及场景道具、资源库图片。插件只接收调用级不透明 token；宿主复用正式提示词解析链，在分析时展开参考文字和图片，最终写回前校验并转换规范引用。库图片变更、候选删除或调用撤销拒绝提交。

## 2. 已核对事实

- `video.inspectFrame`、`video.detectShots`、`video.extractFrames` 在 `src/services/plugins/pluginRuntime.ts` 中只接受当前视频节点 self 资源。
- `model.generate.resourceIds` 当前只接受图像；文本视觉分析可以使用派生关键帧。
- `create-node-set` 已允许视频与分镜节点类型；当前 resourceId 绑定及派生产物保存只实现图像。
- Python 默认每轮 30 秒；解释器探测与收尾计入。JSON 总量 1 MiB，字符串 256,000 字符，不能用 MP4 base64 绕过媒体导入。
- 现有 UI 提交会执行工具并完成窗口；本次不新增“执行 Python 返回中间界面结果”的平行协议。
- Windows Python 进程树已有 Job Object 回收，不启动后台常驻服务逃逸生命周期。
- 本机默认 Python 为 3.10.15，已发现 Torch、TorchVision、OpenCV、NumPy、ONNX Runtime；未发现 ReShot。ReShot 要求 Python >=3.10。包存在不代表 CUDA 或推理已经验收。

## 3. 上游组合方式与依赖

- ReShot 固定核查基线：`770d7220fe79fdf0fdaa84bdce047b90363fc1b5`，版本 0.5.0，使用 `RunConfig` / `run` / `run_many`，不完整复制仓库。
- video-breakdown 固定核查基线：`a8188e148ed07381ee91915d78da3462474c016a`，借鉴镜头 Schema、多关键帧分析及提示词结构；不安装其 macOS ARM64 脚本，不新增 Anthropic Key 或 .env。
- 新增依赖限于插件 Python 运行环境的 ReShot 和实际缺少的运行包；先核对版本，避免无关升级已有 Torch/CUDA 环境。主项目不新增 npm/cargo 依赖。
- 不在插件运行中自动 pip 安装。提供显式安装/诊断脚本，缺包、缺 FFmpeg、缺模型时明确失败。
- 深度/姿态权重由显式环境准备步骤下载并说明缓存；不把自动下载时间藏进任务超时，也不声称模型已经预装。
- 保留 Apache-2.0 和 MIT 的许可、版权及来源说明；ReShot 原始 metrics/Reporter 中的路径不写入日志、模型上下文、节点或元数据。

## 4. 宿主通用能力补充

1. 工具可声明可信 Python 执行时限。原生从活动 Manifest 与 revision 读取，普通工具保留 30 秒；本插件初始声明 120 秒，仍有硬上限和进程树取消，不能由 Renderer 在调用时加时。
2. 当前调用已授权的源视频由宿主资源租约解析；原生再次执行调用方、路径、私有目录和真实文件校验，复制到调用私有工作区。仅可信 Python 运行期获得输入/输出位置，不把真实路径写到持久化输入或模型。
3. Python 写出普通 MP4 文件与有界产物清单。原生校验调用身份、双摘要、文件位置、链接/重解析点、大小、文件头及 SHA-256；产物通过不透明 ID 返回。
4. 主窗口在当前项目/画布/插件 revision 仍有效时，把验证产物保存到项目目录并创建视频节点。普通 JavaScript 不能凭输出 JSON 或路径登记任意文件。
5. 取消、关闭、停用、升级和项目切换撤销租约，清理本轮私有工作区与未提交输出。清理仅作用于本轮新建目录；不删除用户源视频或已有项目文件。
6. 新命令仅授予既有第一方调用方，插件 iframe / 独立 WebView 不获得文件、Shell 或通用事件权限，不修改 `tauri.conf.json` 安全配置。
7. 节点集可显式声明 `video.nodeSetGeneration` 及 `output.generateVideos`；最多 6 个逐镜生成节点，每项只指定安全目录 modelId 和白名单参数。宿主解析配置身份、一次提交节点后调用既有 `startVideoBatch`，不在旧 UI 会话内等待长轮询。生成失败保留节点与已有素材；已提交任务不能回滚或自动重投，重启恢复和项目切换沿用视频批次规则。

## 5. 拟新增和修改的文件

实际编码前按 AGENTS.md 确认本清单；若实现需要清单以外的模块或额外依赖，先说明影响。

### 独立插件目录

新建于 `D:/www/project/AI-Canvas-Plugin/video-replica/`：

- `manifest.json`：API 2、视频节点工具、自定义 UI、权限与兼容声明。
- `main.py`：可信 Python 工具、镜头裁剪、ReShot 适配、结果验证和节点集数据。
- `src/ui.js`：隔离工作区源码、共享 `MentionPicker` 的薄挂载适配、镜头编辑、宿主抽帧/模型调用、提交和取消。
- `tools/build-ui.mjs`：直接引入宿主共享选择器与同份 CSS，使用既有依赖编译单文件隔离 UI。
- `ui.js`：可安装的自包含 UI 产物，编译后更新摘要。
- `requirements.txt`：固定 ReShot 基线与运行依赖说明。
- `tools/prepare-runtime.ps1`：显式环境检查与安装，避免默认升级已有模型环境。
- `tools/check-plugin.mjs`：UI 摘要更新及宿主清单校验。
- `tests/test_main.py`：裁剪边界、产物和依赖失败测试。
- `tests/ui.test.mjs`：镜头/提示词、额度、取消和过期响应测试。
- `使用说明.md`：安装、模型准备、控制视频用途与操作流程。
- `NOTICE.md`：上游来源、许可与修改说明。
- `LICENSE`：插件许可和所复用内容的适用说明。

### 宿主合同与实现

- `src/types/plugin.ts`：可信 Python 任务与媒体产物领域合同。
- `src/services/plugins/pluginManifest.ts`：严格解析时限和产物声明。
- `src/services/plugins/pluginRuntime.ts`：执行暂存、视频节点绑定及原子导入。
- `src/services/plugins/pluginResourceService.ts`：调用级输入/产物租约。
- `src/services/plugins/pluginModelCatalog.ts`：补充已导入的 ComfyUI 视频工作流安全摘要；不传凭据、服务地址或工作流正文。
- `src/services/plugins/pluginPromptReferenceService.ts`（新增）：复用既有候选来源、授权引用句柄、解析与撤销。
- `src/services/plugins/pluginUiSessionService.ts`：引用候选独立计数，不占模型额度。
- `src/services/dramaAssetPrompt.ts` / `src/services/ai/promptResolver.ts`：明确全局角色作用域，复用现有角色参考图解析，不复制项目角色。
- `src/services/nodeReferenceService.ts`：ComfyUI 的角色文本解析使用相同的全局角色作用域。
- `src-tauri/src/plugins/runtime.rs`：活动工具时限、调用工作区和取消。
- `src-tauri/src/plugins/registry.rs`：从可信 revision 校验执行声明。
- `src-tauri/src/plugins/artifacts.rs`（新增）：输入暂存、产物验证、有界读取及回收。
- `src-tauri/src/lib.rs`：保持现有模块布局，注册必要的精确命令。
- `src-tauri/permissions/allow-first-party-app-commands.toml`：仅补充与注册一致的第一方命令声明。
- `plugin-host.json`：通用能力名称与明确额度。
- `sdk/plugin-sdk.d.ts`：核对并同步公共契约；能从领域类型导出时不重复声明。

### 验证与模块文档

- `tests/services/pluginManifest.test.ts`：时限、运行时和产物声明拒绝路径。
- `tests/services/pluginRuntime.test.ts`：资源来源、过期写回、视频导入回收与原子节点集。
- `tests/services/pluginResourceService.test.ts`：租约撤销、资源归属与额度。
- `tests/services/pluginModelCatalog.test.ts`：配置视频模型、ComfyUI 目录及脱敏边界。
- `tests/services/pluginPromptReferenceService.test.ts`（新增）、`tests/services/dramaMentionPick.test.ts` / `tests/services/pluginUiSessionService.test.ts`：引用授权/撤销、全局角色与独立查询额度。
- `doc/插件开发规范.md`：通用可信 Python 任务和媒体产物合同。
- `doc/插件平台模块.md`：能力边界与验证入口。
- `doc/plans/2026-10-09-video-replica-plugin.md`：本计划、阶段状态与实际验收结论。

## 6. 实施与验证

1. 先实现最小宿主合同和拒绝路径；保留既有插件的默认行为，运行定向 Vitest、类型检查和原生测试。
2. 插件拉片和镜头编辑复用宿主真实接口；参照 UI Kit 的刻度/控件结构，隔离页面使用自身主题样式，验证深浅主题。
3. 实现 ReShot 适配和环境准备；用合成短视频验证裁剪、Canny 与真实 Depth/Pose，记录实际设备和结果，不以模拟后端替代推理验收。
4. 校验插件 Manifest、UI 摘要、Python语法和数据处理测试；检查所有新增/修改文本为 UTF-8。
5. Tauri 实机验证安装原生确认、资源句柄、取消、关闭、切项目、插件更新/停用、输出视频播放和分镜写回；Web 仅作必要界面检查。
6. 实机不可用或硬件/权重不足时保留代码与测试结果，单独列出未验收项，不声称桌面验收完成。

原生检查使用项目已有 `cargo test` 与 `cargo check`，按新增模块执行；前端验证定向测试通过后再运行相匹配的 lint/typecheck。付费分析模型调用只在有明确模型与凭据的实际验收环节执行。

## 7. 回滚与交付

- 插件单独安装与停用，不预装进主应用。
- 新能力必须显式声明；未声明的已有插件维持 30 秒与现有图像合同。
- 回滚时先停用新插件，撤销调用，恢复新增宿主合同及实现；已有项目与视频源不迁移、不删除。
- 只交付实际校验过的插件目录/安装包，说明最低宿主版本、Python依赖与模型缓存准备条件。
- 用户已确认初始范围；随后明确追加已配置视频模型与 ComfyUI 生成。追加只涉及模型目录及其测试两处现有文件，生成器、视频批次 Store 与 Tauri 安全配置继续复用。
- 用户随后明确追加替换人物/场景的 `@` 选择，并确认宿主引用服务、类型、SDK、能力与对应测试/文档的文件范围；全局角色及 ComfyUI 文本解析的现有入口已说明影响。关键帧无反馈属于附带明确修复，采用就近状态提示，不自动检测或静默添加镜头。
- 用户进一步要求直接沿用现有缩略图选择器，并确认新增插件 UI 源码/构建入口、宿主预览合同及对应测试与文档。复用纯展示组件和样式，预览只由宿主按当前候选生成，不新增依赖或放宽窗口隔离；回滚时重新载入上一个插件 revision 并撤回可选预览字段，普通引用 token 不变。

## 8. 实施状态

- 宿主私有媒体工作区、节点集视频导入及插件入口已实现；原生 77 项插件定向测试通过，默认特性 `cargo check --lib` 通过。Windows lib test 使用项目已有的测试专用 Common Controls v6 链接声明；同时修正该文件内既有时间戳测试的只读文件句柄，未改系统 DLL 或正式构建配置。
- Python 已补齐 ReShot 0.5.0 与缺少运行包，保留已有 Torch/CUDA。Small 与 DWPose 权重按官方固定 revision、大小和 SHA-256 校验缓存；本机真实短片 Depth 与 Pose 推理链、Canny 裁剪和 H.264 编码通过。合成片无人物，人体识别质量尚不作为验收结论。
- 隔离 UI 的深浅主题、窄屏布局、拆镜/抽帧/分析已完成浏览器基础验证（模拟宿主 props）；不替代桌面端安装、原生确认、文件导入与窗口生命周期验收。
- 已配置模型/ComfyUI 选择、节点集生成指令、安全模型身份解析与宿主批次后台启动均已实现。引用与相关插件宿主回归 7 文件 417 项通过，应用与测试类型检查通过；插件 UI 31 项、Python 26 项通过，主项目无新增 npm/cargo 依赖。
- 创建的分镜表和媒体按实际宽高排列，生成视频放在参考素材右侧的独立列，保留父节点相对坐标与至少 80 单位的间距；宽分镜表和竖图回归通过。引用候选只提供可供生成器解析的真实节点，重写结果受 256000 字符上限约束。
- 用户完成桌面原生信任安装；MCP 已观察插件启用、专用窗口打开并完成真实上下文桥接。用户指出 0 镜头时抽帧无明显反馈，现已增加明确步骤、操作旁状态及焦点恢复；浏览器模拟宿主实际验证了就近提示与深浅主题 `@` 交互，不代替新 revision 的桌面验证。
- 引用选择器已直接打包共享 `MentionPicker`、同份 CSS 和固定离线图标；单文件 UI 为 356195 字节。真实浏览器模拟宿主验证了深浅主题、三列缩略图卡片、搜索、鼠标/键盘插入、逐镜节点引用、关闭卸载与焦点返回，最终页面无控制台错误。预览额外覆盖普通文件读取限额、文件变更、头像裁剪同源、旋转 JPEG、超时/取消及迟到资源回收；既有 CSP、原生命令和权限未扩大。共享宿主 UI 与第三方展示依赖的许可随产物保留。
- 当前登记的 ComfyUI 服务探测返回连接拒绝，未提交工作流。插件最终素材写回、引用选取、已配置付费模型成片、真实 ComfyUI 生成以及取消/切项目/换版过程仍待桌面验收；MCP 没有插件 submit 或安装接口，原生信任更新与按钮操作需用户完成。

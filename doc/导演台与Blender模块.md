# 导演台与 Blender

负责 `ai-director` 的轻量网页、Blender 与 AI 镜头预演运行时、3D 镜头场景、任务和结果回填。Blender 阶段见[原生运行时计划](./plans/2026-08-28-director-blender-native-runtime.md)，AI 预演见[实施计划](./plans/2026-10-03-director-ai-previs.md)。

## 主要入口

| 入口 | 职责 |
|---|---|
| [directorNodeOperationService.ts](../src/services/directorNodeOperationService.ts) | 同一节点的导演操作编排 |
| [directorSceneService.ts](../src/services/directorSceneService.ts) / [directorSceneSchema.ts](../src/services/directorSceneSchema.ts) | Scene/Result 数据读写与合同校验 |
| [directorBlenderRuntimeService.ts](../src/services/directorBlenderRuntimeService.ts) | Blender 安装识别、原生任务和结果收集 |
| [macos.rs](../src-tauri/src/director/blender_runtime/macos.rs) / [macos_process.rs](../src-tauri/src/director/blender_runtime/macos_process.rs) | macOS 应用包发现、Mach-O 校验及进程组生命周期 |
| [directorDeskRuntimeService.ts](../src/services/directorDeskRuntimeService.ts) / [原生 director](../src-tauri/src/director/) | 轻量运行资源与原生执行边界 |
| [DirectorPrevisDialog.tsx](../src/components/director/DirectorPrevisDialog.tsx) / [directorPrevisRenderer.ts](../src/services/directorPrevisRenderer.ts) | AI 电影空间/简模、人物走位、镜头播放、关键帧调整与截图/MP4 输出 |
| [directorPrevisService.ts](../src/services/directorPrevisService.ts) / [directorPrevisSchema.ts](../src/services/directorPrevisSchema.ts) | 文本模型生成、白名单合同、有界输入、不可变场景文件与过期写回保护 |
| [AINodeDialog.tsx](../src/components/nodes/AINodeDialog.tsx) / [generationService.ts](../src/services/generationService.ts) / [promptResolver.ts](../src/services/ai/promptResolver.ts) | 节点输入直接生成预演、显式图片/完整分镜表引用与共用文本协议 |
| [directorTools.ts](../src/services/chat/tools/directorTools.ts) | MCP 导演台工具、Three.js 预演合同发现及场景读写 |

## 关键边界

- 三种运行时共用导演节点的选择、历史、持久化与下游媒体语义；各自维护场景，不能互相冒充。旧节点仍默认轻量网页。轻量导演台与 Blender 始终隐藏节点浮动对话框，切换到这两种运行时时立即关闭；只有 AI 镜头预演显示该输入框。
- `ai-threejs` 为主窗口的「AI 镜头预演」弹窗，复用已配置文本模型。模型只能生成有界 JSON，不能提供 JS、网页、URL、脚本或原生命令。Y-up 米制简模与 position/target/焦距/横滚关键帧支持 1–60 秒预演、人物走位、分段缓动和三种画幅；不声明物理模拟或自动避障。
- 预演阴影按物体全程运动与地面投影范围固定拟合，不随摄影机移动；旋转物体用包围球覆盖中间姿态。贴图最多 2048 并按显卡上限回退，采用有界法线偏移减少自阴影条纹；静态场景复用阴影贴图，辅助标记不投影。预览、截图和视频共用此设置。
- AI 预演可由节点浮动输入框直接生成，也可在弹窗内通过同一 MentionEditor 输入 `@` 或点击连线素材引用；仅连线不发送。整表逐行包含镜号、景别、运镜、内容、台词、时长、音效/音乐、转场、备注与绑定画面。图片走既有受限 Base64 文本/VLM 协议，需支持视觉输入的模型，最多 6 张、单张 8 MiB、合计 24 MiB。节点生成使用所选或项目默认文本模型，成功保存为预演引用，不生成普通文本输出。
- 两个生成入口共享节点加载状态、重复请求保护与取消；修改已有场景时先校验并载入当前场景。项目、实例、运行时、场景引用、提示词、模型或显式引用的节点/画面变化后不发布结果；失败保留上一场景。浮动输入框关闭后允许后台生成，弹窗发起的操作在弹窗关闭时取消；控制器只在内存。
- 预演使用独立合同和 `directorPrevisScene`，不覆盖 Blender Scene/Manifest。场景保存在 `director/previs/<SHA-256>.json`，节点只保存项目相对引用、摘要与大小；读取验证摘要、字节数与合同。文件保留到项目删除，支持撤销、重开、复制及整体导入导出。
- 预演生成/保存/媒体回写绑定项目、节点实例、运行时、场景引用与画布派生守卫。弹窗关闭会取消其发起的操作，上下文变化使在途结果失效；失败保留上一场景。截图与 24fps MP4 只渲染摄影机视角，空间辅助轨迹不进入输出；编码失败显式报错。MP4 使用高画质码率模式兼容 WebKit，导出成功后回填导演节点并在右侧创建视频素材节点，共享项目文件、继承分组坐标且只记录一次撤销；失败或结果过期不新增节点。普通运行时帧/视频 RPC 不自动回退，预演输出由面板宿主执行。
- 桌面端的 AI 预演节点已有场景但没有截图时自动补截；场景引用更新后刷新摄影机起始帧，包括 MCP 写入和节点生成。面板打开时暂缓自动截图，手动同步的当前帧保持不变。多个节点排队渲染并立即释放 WebGL，复用输出保存与派生守卫；失败保留旧图并提示手动重试，不自动调用模型或导出视频。
- MCP 可用 `director_get_previs_schema` 读取合同和完整示例，由外部大模型生成白名单场景 JSON；通过已有 `canvas_create_nodes` 创建 `ai-director`（或查询已有节点），`director_set_runtime` 选择 `ai-threejs`，再以 `director_set_previs_scene` 写入完整 `sceneJson` 字符串。`director_get_previs_scene` 返回已保存场景，未保存时为 `null`；修改前可读回场景。场景响应走 MCP 瞬时完整内容，避开模型结果截断，不把原始 JSON 放进消息或任务摘要。用户双击节点即可播放、调整和输出。
- 这三项预演工具只在当前项目的 MCP 控制会话开放；两项读取为 `read`，写入为 `canvas_write`，复用 Registry/Policy 与预演写回守卫。MCP 自主执行，无需逐次审批；不额外调用应用内模型，不执行外部 JS，不自动重试写入。场景写入后的截图由节点自动同步，不额外发起付费媒体生成。
- 网页模式可查看、播放和调整示例，场景与输出的项目文件保存需要 Tauri 桌面端；真实模型/原生存储/编码验收与前端浏览器验证分开记录。
- Blender 固定包 1.5.0 声明 Windows x86_64、macOS x86_64/aarch64 目标，版本策略接受 4.5.x、5.0.x、5.1.x、5.2.x 稳定系列，不锁补丁号；预发行版和未纳入的系列不自动放行。安装还须与应用架构匹配；版本策略不代表 Blender 官方为每个架构提供所有版本。跨平台/版本的真实桌面验收状态见专项计划。
- 唯一安装自动使用；多个安装或未发现时由系统选择器手选。Windows 选择 `blender.exe`，macOS 选择 `.app`，原生仅解析其固定 `Contents/MacOS/Blender`。手选结果只保存在本机原生私有目录；旧安装失效不阻断其他安装发现。macOS 有界扫描系统/用户 Applications、固定 Steam 路径和 PATH，不扫描整盘。
- Windows 使用 Job Object，macOS 使用专属进程组管理正常关闭、取消和超时；均复用固定参数、成果收集与结果校验。macOS 原生窗口、权限与打包验收尚未在真机执行，不能以 Windows 上的应用包/Mach-O 模拟测试替代。
- EEVEE 标识、材质/世界节点初始化和图像/视频设置按 API 差异适配；保存工程保留时间线和 Cycles 选择。前端只映射已绑定 Job 的固定失败码，区分版本、渲染能力、启动、崩溃、超时和成果错误，不展示原生诊断正文。
- Renderer 只提交固定 operation 和已验证场景引用，不提交任意可执行文件、脚本、argv、环境变量或输出路径。
- Blender 进程退出不等于结果成功；先验证文件集合、摘要和 Result Manifest，再检查项目、节点实例、Scene revision 与派生结果守卫后回填。
- 真实 Blender 预览、保存返回、故障注入和界面验收分别记录；历史“预览已接通”不能替代阶段完成标准。

## 验证与资料

- 定向回归：[Scene 服务](../tests/services/directorSceneService.test.ts)、[Blender 运行时](../tests/services/directorBlenderRuntimeService.test.ts)、[节点操作](../tests/services/directorNodeOperationService.test.ts)；原生测试按专项计划选择。
- AI 预演回归：[合同](../tests/services/directorPrevisSchema.test.ts)、[插值](../tests/services/directorPrevisRenderer.test.ts)、[生成与写回](../tests/services/directorPrevisService.test.ts)、[弹窗文件失效保护](../tests/components/directorPrevisDialog.test.tsx)。数字设置统一复用 UI Kit NumberStepper。
- 阴影修复验证：渲染插值/阴影视锥、场景合同、预演弹窗与导演节点截图/视频导出 4 个回归文件共 59 项测试通过，类型、测试类型、定向 ESLint 与临时目录生产构建通过。浏览器走廊示例的起点、跟拍中段、环绕与空间视图已检查，原人物条纹消失、地面投影保留；不同桌面 GPU 的播放性能仍需实机验证。
- 节点自动截图回归：[导演节点](../tests/components/directorDeskVideoExport.test.tsx)，覆盖已有场景补截、场景更新、手动截图保留、多节点排队、资源释放、失败和过期写回；组件测试模拟渲染器与项目文件。浏览器已验证隐藏容器生成 1920×1080 的摄影机 PNG 并释放容器；原生项目保存仍需桌面验收。
- 引用生成回归：[节点生成与真实协议请求体](../tests/services/generationPrevis.test.ts)、[完整分镜表引用](../tests/services/shotlistMention.test.ts)，覆盖显式图片/整表、图片上限、取消、项目变化及旧运行时路由；模型响应和项目文件服务使用模拟实现，实际模型生成与原生保存仍需桌面验收。
- MCP 预演回归：[导演工具](../tests/services/chat/directorTools.test.ts) 覆盖完整 MCP 发现/创建/选择/写入/读回链路、大场景完整响应、输入校验、撤销重做、取消、过期结果与脱敏；项目文件使用模拟服务，不替代桌面客户端实机验收。
- 架构决策：[双运行时与场景权威](./adr/0010-director-dual-runtime-and-blender-scene-authority.md)、[轻量运行资源](./adr/0003-director-desk-prebuilt-runtime.md)。
- 历史：[前端契约](./history/2026-09-07-跨模块实施记录归档.md#director-contract)、[协议冻结](./history/2026-09-07-跨模块实施记录归档.md#director-protocol)、[原生预览](./history/2026-09-07-跨模块实施记录归档.md#director-preview)、[新手界面](./history/2026-09-07-跨模块实施记录归档.md#director-ui)、[双 MCP](./history/2026-09-07-跨模块实施记录归档.md#director-mcp)、[保存工程模式](./history/2026-09-07-跨模块实施记录归档.md#director-saved-scene)。

返回[文档导航](./文档导航.md)。

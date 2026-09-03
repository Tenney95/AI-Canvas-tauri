# 3D 镜头台 Blender 原生运行时实施计划

> **状态：** Phase 1-A/1-B 已完成；Phase 1-C Windows Blender 5.2.1 原生运行时预览已接通，核心真机流程通过，故障注入与完整保存返回投影验收仍进行中。

**Goal:** 在不新增画布节点、不破坏现有免安装导演台的前提下，把 Blender 接入为同一 `ai-director` 节点的可选专业运行时，形成 Scene JSON → 固定 Blender Job → Result Manifest → 节点媒体回写的安全最小闭环。

**Architecture:** AI Canvas 内的“3D 镜头台”是普通用户的目标导演界面，内部继续使用唯一 `ai-director` NodeType。节点通过 `directorRuntimeKind: 'lightweight-web' | 'blender'` 选择运行时；Director Scene JSON 是可移植场景权威，`.blend` 是受 Scene revision/hash 约束的 Blender 工作产物，Result Manifest 是已验证结果文件的清单权威。Blender 只能由用途单一的 Rust commands 启动由第一方信任根解析、版本固定且经哈希或签名校验的 AI Canvas 脚本，调用方不能提供 Python、自由参数、工作目录或绝对输出路径。

**Tech Stack:** Tauri 2、Rust、React 19、TypeScript、Zustand、Vitest、Blender Application Template、Blender CLI。

**Authority:** [ADR 0003](../adr/0003-director-desk-prebuilt-runtime.md) 继续约束 `lightweight-web`；[ADR 0010](../adr/0010-director-dual-runtime-and-blender-scene-authority.md) 约束双运行时、Scene/Result 和 Blender 安全边界。

---

## 1. 已锁定产品决策

1. 产品目标名称锁定为“3D 镜头台”，对应现有 `ai-director` 节点，不创建新 NodeType；当前“3D 导演台”展示文案只在后续原入口改名任务中更新。
2. 节点菜单只有一个创建入口；运行时选择发生在同一节点内部。
3. `lightweight-web` 是长期正式免安装方案，不因 Blender 接入而降级、隐藏或淘汰。
4. 旧节点缺少运行时字段时继续解释为 `lightweight-web`；未知非空值失败关闭。
5. 两种运行时共用当前帧截图、参考视频和既有下游连线语义。
6. Blender 负责专业渲染与高级编辑，AI Canvas 负责新手导演界面、项目状态和场景协议。
7. 只有用户需要精修时才打开 Blender；截图和参考视频允许以后由后台 Job 完成。
8. Blender 内部可以使用由 Rust 第一方信任根解析、版本固定并通过哈希或签名校验的 AI Canvas 脚本，但不能形成任意 Python、Shell 或命令行入口；具体资源交付方式留到 Phase 1-C 检查点。

## 2. 本计划不包含

- 新增 Blender 专用节点、节点菜单、Store 或下游连线类型；
- 立即实现画布内人物拖放、完整时间轴或高级运镜编辑器；
- 将完整 Blender UI 作为普通用户默认界面；
- 自动安装 Blender、修改用户 Blender 配置或覆盖用户默认工作区；
- 执行用户、模型、插件、网页、Agent 或 MCP 提供的 Python；
- 接收自由 executable path、argv、cwd、env、script path 或 output path；
- 复用 Plugin API v1 可信 Python Runtime、前端 Shell capability、`open_with_app` 或 ComfyUI 启动器；
- 在未建立 Scene/Result 校验前启动 Blender；
- 承诺 Director Scene JSON 与任意 `.blend` 无损双向转换；
- 在同一批次猜测修复旧 Director 多媒体的跨项目 URL/path 配对。

## 3. 分阶段顺序

所有阶段必须独立展示精确文件清单、影响面、验收和回滚，并获得用户确认。前一阶段未通过时不得提前创建后一阶段的空壳入口。

### Phase 1-A：Director Scene/Result 纯数据层

**目标：** 在不启动 Blender 的情况下，先建立可验证、可归档、可恢复的场景与结果契约。

**候选文件范围：**

- Create: `src/types/directorScene.ts`
- Modify: `src/types/index.ts`
- Create: `src/services/directorSceneSchema.ts`
- Create: `src/services/fs/projectFiles.ts`
- Create: `src/services/directorSceneService.ts`
- Create: `tests/services/directorSceneSchema.test.ts`
- Create: `tests/services/directorSceneService.test.ts`
- Modify: `src/services/projectTransferService.ts`
- Modify: `tests/services/projectTransferService.test.ts`

**实现边界：**

1. Scene v1 使用严格字段白名单，定义坐标系、单位、时间轴、环境、实体、镜头和相机关键帧。
2. 资产引用只允许带稳定版本/hash 的受信目录资产 ID，或至少包含 `{relativePath, sha256, bytes}` 的项目文件引用；仅有相对路径、URL、绝对路径、脚本或命令均被拒绝。
3. Scene JSON 设置大小、实体、镜头、关键帧、字符串、数字和路径上限；全部数字必须 finite。
4. 节点只保存 `{schemaVersion, sceneId, revision, relativePath, sha256, bytes}` 等不可变引用，不保存完整 JSON。
5. Scene revision 文件使用完整 SHA-256 文件名，永不覆盖旧 revision；写成功并复核后才更新节点。
6. Result Manifest 绑定 `sceneRevision + sceneSha256`，并只声明固定 artifact kind 与 MIME；artifact ID 在 bundle 内唯一，文件名绑定内容哈希，截图、视频和 `.blend` 均不可原地覆盖。
7. 新渲染或高级编辑返回必须写入新 artifact 并创建新 `manifestRevision`；读取结果时独立复核路径、字节数和哈希，不能信任清单自报。
8. 项目整体归档继续使用现有格式，只补充可选嵌套引用的缺失统计；不升级 IndexedDB 或归档格式版本。
9. `directorRuntimeRegistry` 中的 Blender adapter 继续 unavailable，不增加任何进程调用。

**验收：**

- 正常 Scene/Result 可规范化、序列化、保存、加载和校验；
- 未知字段、较新 schema、路径逃逸、控制字符、超限和非 finite 数字被拒绝；
- 文件篡改、哈希不匹配、父 revision 不符和覆盖旧文件被拒绝；
- 同项目复制可共享旧快照，任一副本保存只移动自己的引用；
- 项目导出/导入能识别 Scene 和 Result Manifest 引用；
- 定向 Vitest、typecheck、ESLint、严格 UTF-8 与 `git diff --check` 通过。

**回滚：** 停止创建和读取新引用，保留节点、`lightweight-web` 和现有媒体；项目目录内已生成的 JSON 不自动删除，旧版本自然忽略可选字段。

### Phase 1-B：Blender 安装候选发现

**目标：** 只发现受限安装候选，不启动 Blender，不持久化绝对路径。

**候选文件范围：**

- Create: `src-tauri/src/blender_runtime.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/permissions/allow-first-party-app-commands.toml`
- Modify: `doc/对话助手-Agent能力实施方案.md`
- Regenerate when actually changed: `src-tauri/gen/schemas/acl-manifests.json`
- Regenerate when actually changed: `src-tauri/gen/schemas/capabilities.json`
- Regenerate when actually changed: `src-tauri/gen/schemas/desktop-schema.json`
- Regenerate when actually changed: `src-tauri/gen/schemas/windows-schema.json`

**实现边界：**

1. `discover_blender_installations` 不接收业务参数、路径或命令行。
2. command 先执行可信来源校验，并额外限制为 `main` 窗口。
3. Windows 首批只扫描受限 Program Files 根及一层固定文件名 `blender.exe`，不扫描整盘、PATH、注册表、Steam、WindowsApps 或用户目录。
4. 根目录和候选都 canonicalize；候选必须是普通文件并保持在规范根内。
5. 限制扫描根数、目录项和返回候选数量，结果稳定排序和去重。
6. 前端只获得不透明 `installationId`、展示名、来源和非权威版本提示，不获得绝对路径。
7. “发现候选”不等同于“已验证 Blender”，未发现也不能表述为“本机未安装”。
8. 不执行 `blender --version`，不新增依赖，不修改 `tauri.conf.json` 或 Shell/process scope。

**验收：** 使用注入的临时根测试固定层级、错误文件名、过深目录、链接逃逸、去重、排序、上限与稳定 ID；运行 Rust 定向测试、`cargo check --locked --lib`、ACL 集合核对、严格 UTF-8 和差异检查。测试结果不得表述为真实本机 Blender 检测。

**回滚：** 移除发现模块、command 注册、ACL 条目和对应生成差异；没有进程、安装文件、配置或数据库需要清理。

### Phase 1-C：固定资源与 Blender Job 最小闭环

**目标：** 用固定请求清单驱动截图、参考视频和高级编辑打开，安全回收 Result Manifest。

**前置：** Phase 1-A/1-B 通过；固定 `.blend` 模板、Application Template 和第一方脚本已经确定版本、来源、哈希与打包方式。若需要修改 `tauri.conf.json` resources，必须单独展示安全配置检查点。

**当前实施状态（2026-08-28）：** 固定资源最终采用 Rust `include_bytes!` / `include_str!` 编译内嵌并按 manifest 校验，因此没有修改 `tauri.conf.json`。Windows 首批锁定 Blender 5.2.1 LTS；Rust native runner、项目内存 grant、opaque Job、Windows Job Object、同节点高级编辑/截图/视频、Result Manifest 回收、设置页手选及 Steam canonical 路径修复已经接通。Application Template、单帧、短视频、两次高级编辑保存与 `.blend` 续接已取得真机证据，AI Canvas 原节点也已真实启动 Steam Blender。真实超时、崩溃、应用退出进程树回收和完整保存返回投影仍需补齐可重复证据，所以本阶段继续标记进行中。

**用途单一 commands：**

```text
start_blender_job
get_blender_job_status
cancel_blender_job
collect_blender_job_result
```

**允许的结构化输入：**

```text
installationId
operation = open-editor | render-frame | render-video
projectGrantId / projectId / directorInstanceId
sceneId / sceneRevision / sceneSha256
```

`start_blender_job` 不接收 `jobId`，由 Rust 生成并返回不透明 ID；`get_blender_job_status`、`cancel_blender_job` 和 `collect_blender_job_result` 才能接收该 ID，并且只能用于 Rust 状态表查找，不能直接构造文件或目录名。

**禁止的输入：** executable path、Python 源码、script path、raw args、working directory、environment、URL、任意文件路径或输出路径。

**实现边界：**

1. `main` 窗口先通过用途单一的授权流程建立 Rust 进程内 project grant：项目根 canonicalize 并通过路径策略后绑定 `projectId`，前端只持有不透明 `projectGrantId`；Job command 不接收项目路径，任何 Renderer ID 都不能直接拼接为路径。
2. `installationId` 只查询内存安装记录。每次 Job 启动前重新解析和 canonicalize 候选，确认仍是允许安装根内的普通文件；发现结果本身永远不升级为“可信 Blender”。
3. Rust 独立生成 `jobId` 和实际 Job 目录映射；status/cancel/collect 只用不透明 ID 查表。可执行文件和 Job 目录由 installation 复核、project grant 与 Scene 引用共同派生。
4. Template、启动 `.blend` 和脚本来自应用只读资源，启动前校验版本和哈希。
5. 参数由 Rust 内部完整构造，直接使用 `Command::new(...).arg(...)`；禁止 Shell 和字符串拼接命令。
6. 后台操作固定使用 `--background`；全部操作固定使用 `--disable-autoexec`，并按版本兼容矩阵选择 Application Template 与参数顺序。
7. Python 只执行应用固定脚本；脚本只读取单一受限请求清单并向 Rust 派生 Job 目录写入结果。
8. Job 状态存内存并绑定 project grant、项目、节点实例和 Scene revision；进度事件只发给主窗口且不包含绝对路径。
9. 取消、超时、崩溃和应用退出必须终止并回收子进程；参考 ONNX Worker 的 wait/kill/Drop 生命周期，不复用其业务协议。
10. 宿主独立校验 Result Manifest 与每个 artifact 的 canonical containment、链接逃逸、类型、数量、大小和流式哈希；Result Manifest 永远不能直接创建或覆盖 Scene。
11. 固定脚本若返回 portable Scene proposal，宿主必须将其与 Manifest 分离，重新执行 Scene schema、父 revision/hash 和不可变保存校验；纯 Blender 专有编辑只产生新的 `.blend` artifact 与 Manifest。
12. 结果通过 canvas derivation guard 回写同一节点现有截图/视频字段和结构化引用，不创建新节点。

**验收：**

- 固定测试资源完成请求 → 进度 → 结果 → 节点投影闭环；
- 用户输入不能改变可执行文件、脚本、参数序列、工作目录或输出目录；
- Scene revision 变化、项目切换、节点删除、超时、取消和崩溃不会把旧结果写回当前项目；
- 篡改脚本/template、越界路径、链接、错误 MIME、超限或哈希不匹配全部失败关闭；
- `lightweight-web` 在 Blender 缺失、失败和回滚时保持正常；
- Rust/前端定向测试、typecheck、ESLint、构建、严格 UTF-8 和差异检查通过。

**真机启用门：** Phase 1-C 分为两个连续门槛。C1 完成实现、fake runner 和自动化检查后，`blender` 仍保持 unavailable。C2 必须由用户单独明确授权启动本机 Blender，并逐项通过：启动前候选重新验证和固定版本/架构握手、真实当前帧与参考视频渲染、高级编辑保存并返回、新 artifact/Manifest 校验、取消、超时、Blender 崩溃和应用退出后的进程回收，以及项目/节点/Scene 过期结果拒绝。只有 C2 全部通过才能把 adapter 标记 available；未授权或任一步失败都保持 unavailable，不能用编译、mock 或临时目录测试代替。

**回滚：** 禁用或移除 Blender Job commands 与 adapter，使 `blender` 恢复 unavailable；保留 `lightweight-web`、Scene JSON、Result Manifest、`.blend` 和已验证媒体，不删除用户产物。

### Phase 1-D：结构化 Director artifact 与跨项目复制

**目标：** 在 Scene bundle 已稳定后，消除旧平行 URL/path 数组和单 `filePath` 的多媒体歧义。

1. 定义按 kind 区分的图片、视频、`.blend` 与清单引用。
2. 跨项目复制先校验源哈希，再复制到目标项目相对目录并生成新引用；完成前不得把源引用自动绑定到目标项目同名文件。
3. 图片只回填图片字段，视频只回填视频字段，不再用一个文件 URL 重写全部媒体。
4. 旧节点只做可验证的最佳努力迁移；无法恢复配对的条目标记缺失，禁止猜测。
5. 本阶段不得与 Phase 1-A 或 Blender 进程启动合并实施。

### Phase 2：Blender 导演模式（固定模板资源）

**目标：** 为选择高级编辑的用户提供低门槛 Blender 工作区，不覆盖其个人 Blender 配置。

**当前实施状态（2026-08-30）：** Phase 2-A 进行中。首批在现有 `startup.blend` 分区内增加只对 AI Canvas editor session 生效的 Properties/Scene 导演操作台，提供基础模型、轻量场景、协议镜头、焦段、景深、灯光、用户手选本地模型和保存返回；主 3D View 右下角增加基于 Blender `GPUOffScreen.draw_view3d` 的圆角实时相机预览、关闭与重开，离屏刷新限制在约 8 FPS。不新增节点，也不改变 Job/Result schema。

**Phase 2 完整目标：**

- 一个大尺寸 3D 视图；
- 左侧场景、人物和道具库；
- 右侧镜头属性；
- 底部简化时间轴；
- 顶部“保存并返回 AI Canvas”；
- Eevee/低采样预览；
- 固定、可恢复的工作区布局；
- 镜头、人物站位与基础运镜预设。

Phase 2-A 尚未包含正式人物/道具资产库、项目模型资产化、简化时间轴、基础运镜、Blender 内直接截图/视频同步或 Scene JSON 双向同步。用户手选 OBJ/FBX/GLB/GLTF 只进入当前 `.blend`；FBX/OBJ 的 sidecar 贴图可能保持外部引用。

固定资源由 Rust 编译内嵌、私有版本目录安装并按 bytes/SHA-256 校验；`1.2.0` 与旧 `1.1.0` / `1.0.4` 目录隔离，不写入或替换用户全局 Blender 配置。操作台数据使用 first-party owner collection/material/World，清理不触碰 Director Scene 或用户数据；用户在 Blender 文件选择器中手选路径不升级为 Tauri/Agent/MCP 任意路径能力。预览只自绘圆角外壳与交互，真实摄像机画面、视图层和色彩管理继续走 Blender 内部组件；Blender 的编辑区仍为矩形，未为小窗拆出第二个 View3D。未来 Blender 版本兼容矩阵仍需逐版本验证。

验收必须区分固定资源/Rust 测试、Blender 5.2.1 真机、普通 Blender 不受影响和节点保存返回。回滚恢复旧固定包引用即可，保留用户 artifact、旧私有资源与 `lightweight-web`。

### Phase 3：AI Canvas 内快速导演

**目标：** 普通用户主要在 AI Canvas 内完成导演工作，Blender 默认作为后台引擎。

- 场景模板、人物和道具选择；
- 近景、中景、全景、过肩、俯拍、仰拍等镜头预设；
- 焦段、景深、机位高度；
- 推进、拉远、横移、环绕和跟随；
- 只显示镜头、人物动作和关键帧的简化时间轴；
- 一键同步当前帧和生成参考视频；
- 需要精修时从同一节点进入 Blender 高级编辑。

本阶段仍不新增节点类型；全部能力写回同一 `ai-director` 的 Scene revision 和结果引用。

## 4. 统一安全边界

- Renderer 只能调用用途单一的 Director/Blender commands，不能获得通用进程、Shell、Python 或文件能力。
- `director-desk` 第三方窗口不得调用 Blender commands；原生命令同时受 capability ACL 和 Rust caller guard 保护。
- Scene、Result、`.blend`、网页、插件和模型输出全部是不可信数据，不能改变权限、脚本、运行参数或确认策略。
- 所有文件访问必须绑定项目相对引用、规范路径包含关系、允许类型、数量、大小和哈希。
- 模型、Agent、MCP 和插件不获得安装路径、项目绝对路径、Job 目录或 Result 绝对路径。
- 不自动下载或安装 Blender，不自动安装第三方 Blender 插件或依赖。
- 不执行 `.blend` 内嵌脚本，不加载未批准的启动文件，不复用用户全局 autoexec 设置。
- 日志、进度事件和错误不得包含绝对路径、环境变量、完整 Scene 正文或脚本正文。

## 5. 阶段验收总则

每阶段必须记录：

- 精确修改、新增和生成文件清单；
- 是否影响依赖、数据库、Tauri capability、`tauri.conf.json`、安装包资源和用户数据；
- 定向单元测试、类型、Lint、构建、Rust 和差异检查的真实结果；
- 未执行的本机、窗口或 Blender 端到端手测；
- 当前 `lightweight-web` 回归证据；
- Blender、Python、资源安装和进程是否实际发生；
- Blender adapter 是否仍为 unavailable；若标记 available，必须附用户授权的真机 C2 验收证据；
- 单独本地提交和可恢复回滚点。

不得把静态 schema 测试、临时目录扫描或 mock 进程描述为真实 Blender 安装、启动或渲染验收。

## 6. 总体回滚

1. 任一阶段失败时先让 Blender adapter 回到 unavailable，不修改节点类型或自动切换运行时。
2. `lightweight-web` 保持长期可用，继续执行 ADR 0003 的固定发布、下载和本地协议方案。
3. 已有 Scene JSON、Result Manifest、`.blend`、截图和参考视频不因功能回滚被删除。
4. 停止读取较新可选引用不需要降低 IndexedDB 或重建项目数据库。
5. 临时 Job 目录只能在确认属于应用创建、无活动进程且不含用户权威文件时清理。
6. 不使用 `git reset --hard`、数据库降级或广泛目录删除作为产品回滚策略。

## 7. 当前开放问题

- Blender 5.2.1 之后稳定版本的固定资源和 Python API 兼容矩阵；
- 后续大型人物/道具资产包的签名、授权、体积和按需更新策略；
- 运行中的 Blender 若需直接请求截图/视频，是否建立新的用途受限 IPC；
- 外部模型 sidecar 贴图的 `.blend` 可移植性，以及项目模型库 grant/复制协议；
- Blender 专有数据与新 Scene revision 发生冲突时的用户提示和合并策略；
- 不可变 revision 与孤儿 Job 文件的空间配额、识别和回收周期；
- `.blend` artifact 的大小上限和项目整体导入导出上限；
- macOS/Linux 的安全安装发现、签名、沙箱和进程回收差异。

这些问题只能在对应阶段检查点解决，不得由模型、脚本或运行时自行选择。

## 参考

- [ADR 0003：3D 导演台使用按需下载运行时](../adr/0003-director-desk-prebuilt-runtime.md)
- [ADR 0010：3D 镜头台双运行时与 Blender 场景权威边界](../adr/0010-director-dual-runtime-and-blender-scene-authority.md)
- [Blender Application Templates](https://docs.blender.org/manual/en/latest/advanced/blender_directory_layout.html)
- [Blender 命令行参数](https://docs.blender.org/manual/en/5.1/advanced/command_line/arguments.html)
- [Blender Windows 安装方式](https://docs.blender.org/manual/en/4.2/getting_started/installing/windows.html)

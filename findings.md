# 插件优化发现

## 2026-09-03 Git 发布发现

- 当前分支为 `master`，相对本地跟踪的 `origin/master` 领先 44 个提交。
- 工作区包含本轮插件资源/UI/CSP 的代码、文档、测试夹具、6 个已确认删除项和三份过程记录；尚无暂存内容。
- 既有仓库发布约定记录显示 `myfork/master` 是用户 fork、`origin/master` 是上游基线；仍需用当前 `git remote -v` 与托管平台状态实时复核后再推送/建 PR。
- `src-tauri/Cargo.toml` 显示为修改状态，提交前需要核对真实差异，避免把仅行尾或索引状态误纳入提交。
- 当前远程已实时确认：`myfork` 为 `luckcatlin2000/AI-Canvas-tauri`，`origin` 为上游 `Tenney95/AI-Canvas-tauri`。
- 既有上游 PR #15 曾使用同一 head/base；创建前应先检查它是否仍开放，若开放则推送 `myfork/master` 即会更新该 PR，不能重复创建。
- Git 的 `http.proxy` 与 `https.proxy` 当前均指向被用户明确排除的 `127.0.0.1:7892`；环境变量代理为空。所有远程 Git 命令必须显式使用 `-c http.proxy= -c https.proxy=` 覆盖。
- 当前系统未安装 GitHub CLI `gh`；不为本次发布新增依赖，改用现有凭据支持的 GitHub API或已登录网页。
- 公共网页抓取未能可靠返回 PR #15 状态，因此不以搜索缓存作为发布依据。
- 已用 `git -c http.proxy= -c https.proxy=` 成功刷新两个远程；上游 `origin/master` 从 `00a054b` 前进到 `6bd898c`，并取得 `v0.9.1`、`v0.9.2` 标签。
- 刷新后本地 `master`、`origin/master` 与 `myfork/master` 都精确指向 `6bd898c`（“统一音频节点工具栏样式”），不存在提交分叉；这与用户指定的起点一致。
- GitHub API（`-NoProxy`）确认 PR #15 已于 2026-08-30 合并并关闭，因此本轮需要在推送新提交后创建新的 PR，不能更新 #15。
- 当前真实 tracked diff 为 39 个文件、约 2159 行新增/1259 行删除，内容均落在插件资源租约、主窗口内 UI、原生注册/协议、相关测试和文档范围；另有 8 个新文件（含三份过程记录、两个服务、两个测试和 UI bootstrap）。
- `src-tauri/Cargo.toml` 虽在工作区状态中显示 `M`，但不出现在 `git diff --name-status` 或 diff 统计中，属于内容未变化的索引/行尾状态，不应强行纳入提交。
- `Cargo.toml` 的 working blob 与 `HEAD` blob 均为 `5643b42b...`，已确认字节内容完全相同。
- `tests/components/toolbarRegistry.test.ts` 在暂存刷新后也与 `HEAD` blob 完全一致，因此它与 `Cargo.toml` 都不是实际提交内容；最终真实 staged 文件数为 47。
- 仓库 `core.hooksPath=scripts`，`pre-commit` 只执行版本徽章同步与暂存 TS/TSX 的 ESLint，不运行测试或构建；本次可正常保留门禁，无需 `--no-verify`。
- 新 PR 已创建为 `Tenney95/AI-Canvas-tauri#16`，head/base 精确为 `luckcatlin2000:master` → `Tenney95:master`，状态为 open。

## 2026-09-03 关联资源与主窗口 UI 实施发现

- 当前节点工具只传 Manifest 声明的目标节点字段，不带连线资源；插件节点的一跳入边仅折叠为 text/image/video/audio/json 值或媒体 URL。
- 当前文件 grant 只覆盖用户手选文本文件，绑定维度缺少项目、插件完整 revision、调用/UI 会话、边和画布 revision。
- `BaseNodeData` 的本地媒体 URL 可能是编码绝对路径的 Tauri asset URL；新资源契约不能把它继续当成文件能力或直接暴露给插件 UI。
- 当前包私有快照只有主入口和可选 UI 入口，尚无 Manifest 资源清单、完整包摘要和包资源读取接口。
- 普通节点工具表单已经使用主窗口 `ModalOverlay`；自定义 UI 分支才跳到独立 `WebviewWindow`，因此交互层可复用现有宿主弹窗。
- 第三方自定义代码不能直接 import 到主 React DOM；宿主声明式 UI 优先，高级 UI 必须经过隔离容器和专用 Broker。
- 当前右键入口只以必填字段判断是否需要弹窗，`dialog.ui` 无必填字段时会绕过 UI 直接执行。
- 本次用户已经确认上述架构方向并授权开始实施；仍需按阶段维护精确文件清单和验证证据。
- 用户确认当前尚无第三方插件，Manifest、资源权限、可信 Python 与自定义 UI 全部直接收敛为唯一的 Plugin API v1，不建立历史版本分支。
- 当前端口类型只有 text/image/video/audio/json；媒体端口可以保留旧 value 并附带 resource sidecar，任意文件还需要新增 `resource` 端口及 MIME/大小约束。
- 当前 `NodePluginInvocationInput` 与 `PluginNodeInvocationInput` 都没有资源字段；资源 sidecar 可作为新增可选字段保持旧运行时代码兼容。
- 当前 `files.read` 同时承担手选文件字段与 `file.readText`；不能改变它的旧含义，应新增细分权限。
- `PluginFileGrantSummary` 只有 grantId、名称、大小和扩展名；内部 grant 仅有 pluginId、nodeId、path，确认缺少 revision/project/invocation/edge/canvas 绑定。
- 资产索引已有 `resolveIndexedAssetPath(assetId)`，项目文件层已有拒绝 symlink、严格 relativePath、size/SHA-256 复核和不可变写入；新插件资源解析应复用这些边界，而不是新建宽泛路径 API。
- `pluginRuntime` 已为整次调用生成 `invocationId` 并在每轮执行前后复核 `sourceDigest`，适合把资源租约绑定到同一 invocation；当前 `buildInvocationInput` 和 `buildPluginNodeInputs` 都是同步函数，资源解析会需要预先异步 mint。
- 当前媒体端口值由 `imageUrl/videoUrl/audioUrl` 直接产生；本地 URL 与远程 URL 要区分：远程值可保留兼容，本地文件能力改为资源句柄与受限预览。
- 插件安装路径当前只把 `main.js/main.py` 与可选 UI 文本传入 Store/Rust；拖入目录时虽枚举全部文件，但未收集 Manifest 声明资源。
- 原生注册表以 `sourceDigest` 作为 revision 目录键；UI 单独按 `uiDigest` 内容寻址。若要让 manifest/resources 参与版本租约，需要新增完整 `revisionDigest`，同时保留 `sourceDigest` 作为入口源码校验与旧记录兼容字段。
- `store.plugins` 已按插件 ID 串行 stage/persist/revoke/activate，资源字节应作为 stage 输入的一部分并在同一事务内落入私有快照。
- 原生现有 UI 读取会在每次读取时复核启用状态、活动 uiDigest、`ui.custom` 权限和磁盘摘要，可复用同样模式实现包资源读取。
- `src/services/plugins/pluginRegistryService.ts` 不存在；注册调用实际直接位于 `src/store/store.plugins.ts`，后续不再查找该错误路径。
- API v1 通过 `runtime` 与固定入口区分 QuickJS JavaScript 和可信 Python；资源契约对两种 runtime 使用同一份 Manifest 结构，并以细分权限显式 opt-in。
- `pluginManifest` 的路径校验、UI integrity 校验模式可以直接复用到 `resources[]`；资源条目还需唯一 id、媒体类型、字节上限和 SHA-256。
- 原生 stage 当前接收 JSON manifest、源码文本、可选 UI 文本；资源可以作为有界 `{id, bytes/base64}` 列表传入，但媒体资源不应走 JSON/base64。首批包资源应限定为小型文本/配置资源，或新增 Channel/文件路径授权后再扩展二进制。
- 现有运行时测试 mock 只模拟 invoke/Store/模型，自动资源 resolver 应设计成可独立测试并在 runtime 测试中 mock，避免把 Tauri fs 细节混入图路由测试。
- 代码已有统一的本地媒体识别约定：`asset://`、`asset.localhost`、`file:`、`blob:`、`data:` 均视为本地/内联；插件资源 sidecar 只应 mint 落盘项目文件，data/blob 继续作为受限值处理但不是文件 grant。
- `registerCanvasDerivation` 已提供 projectId、sourceNodeId、baseRevision；资源租约可直接绑定该 guard 的 baseRevision，并在每次 `resource.readText` effect 前用 Store 复核项目、revision、节点与边。
- `storageService` 已有 asset URL 反解路径实现但为私有函数；新 resolver 应优先使用 node.data.assetId/relativePath/filePath，避免从展示 URL 反解路径作为权威来源。
- `executeHostEffect` 目前只把 pluginId/nodeId 交给文本 grant 服务；需增加 sourceDigest、projectId、invocationId、baseRevision 与 edge/resource 复核上下文。
- GitHub 市场安装需要按 release tag 同步下载 Manifest 声明的 UI 与包资源，并逐项复核大小和摘要；该链路现已纳入 Plugin API v1 安装输入。
- 浏览器文件夹拖入已经拥有每个 `File` 对象，Tauri 原生拖入拥有完整路径列表；可统一转换为有界 `PluginPackageResourcePayload {id, bytes:number[]}` 后交给 Rust，避免把源路径写入 IndexedDB或运行输入。
- Store 测试精确断言 stage IPC 入参；新增 `packageResources` 必须仅在实际存在时发送，确保旧插件测试和调用形状不变。
- `BaseNodeData` 顶层主资产由 filePath/assetId/relativePath 表示；director 与 storyboard 还存在多资源字段。首批自动授权先覆盖节点主资产和插件节点手选字段，复杂多产物必须后续以显式资源描述器接入，不能递归扫描任意对象。
- `extractFilesFromNodeData` 可提供显示名/媒体分类，但 size 固定为 0，不能作为安全授权权威；mint 时仍需对解析后的项目内路径执行 lstat。
- 当前 Plugin UI bridge 直接把声明字段原值送入自定义 UI，未经过 `toPluginJson`/本地 URL脱敏；主窗口 Modal 收敛时需统一使用 runtime 的安全 context 构造器。
- 当前 `PluginNode` 把临时 grant summary 持久写入 `pluginValues`；执行前必须重新验证 grant 是否仍在内存，失效则提示重新授权，不能把旧 grant 摘要自动转为资源租约。
- 项目 `tauri.conf.json` 的 bundle target 为全平台；经用户单独确认，全局 CSP 已在 Windows 的 `http://plugin-ui.localhost` 之外精确加入 macOS/Linux `convertFileSrc` 使用的 `plugin-ui:` 脚本源，其它 CSP 能力不变。
- 当前锁定 Tauri 2.11.2，已经包含官方 iframe IPC invoke-key 修复；自定义 UI bootstrap 仍增加运行时失败关闭检查，任何 `__TAURI__`、`__TAURI_INTERNALS__` 或 `isTauri` 注入都会阻止第三方 bundle 加载。
- 主窗口 iframe 解决额外系统窗口的交互负担，但不承诺独立 CPU/内存隔离；`ui.custom` 应明确提示过重脚本可能影响主窗口，常规参数优先用宿主声明式表单。
- 初版 UI submit 重新调用工具时会换发 invocation 与资源 ID，导致自定义 UI 选中的 opaque handle 无法在提交阶段继续使用；现已改为沿用同一 guard、invocation、资源与受信媒体集合，关闭 Modal 后再统一撤销。
- 自定义 UI 始终是不可信 JavaScript，即使主入口是可信 Python，也不能因此跳过 UI 的媒体来源校验；Python 的宽权限只适用于原生 Python 入口本身。
- UI 初版把声明字段内任意 HTTP 文本都加入媒体白名单，可能让普通文本 URL 冒充真实媒体输入；现改为复用运行时按节点类型识别媒体载体的同一收集逻辑。

## 已确认事实

- 自定义插件节点的输出 Handle 使用 `plugin-out-<portId>`，输入 Handle 使用 `plugin-in-<portId>`。
- 当前 `buildPluginNodeInputs` 读取了目标输入 Handle，但没有使用来源边的 `sourceHandle`，因此插件节点的多个输出会退化为通用节点值。
- 插件沙箱没有直接提供 `fetch`，但插件返回的 `imageUrl`、`videoUrl`、`audioUrl` 或媒体端口字符串会由宿主 UI 加载；需要校验这些引用是否来自宿主已给插件的输入或宿主本轮生成结果。
- 第一批优化保持在前端插件运行时、对应测试和开发规范内；原生插件信任注册、签名和更新链属于后续架构阶段。
- 初始 `git status --short` 显示大量与本任务无关的既有改动；三份目标产品文件当前干净。

## 当前决策

- 对有完整插件元数据的插件节点连接，按 `sourceHandle` 定位来源输出端口并校验来源/目标端口类型。
- 对旧连线、普通节点或无法识别的来源 Handle，保留现有通用值回退，避免破坏历史项目。
- 只限制会触发宿主媒体加载的字段或 `image`/`video`/`audio` 端口；普通文本和 JSON 中的 URL 不作为本批网络能力处理。
- JavaScript 的 `http/https` 媒体引用必须精确匹配真实媒体输入或宿主本轮媒体模型 effect 返回的引用；不从文本、JSON、文件正文、插件字段默认值或操作参数授予媒体来源。
- Python 已明确是可信本机代码并可自行联网，本批不对其附加 QuickJS 的远程媒体来源约束。
- 媒体载体覆盖 URL/URLs 顶层字段、已知嵌套媒体容器、媒体节点 `output`、自定义媒体端口，以及画布笔记颜色中的 CSS `url(...)`。
- 嵌套容器按真实媒体路径提取（如 `shotlistRows[].frame.url`），不会把分镜对白中的普通 URL 错判为媒体来源。
- 常见位图、音频和视频 `data:` 维持可用；SVG/HTML 等可执行或可嵌套外链的内联媒体被拒绝。

## 待验证

- 现有测试通过 hoisted mock 提供 `invoke`、Store、模型服务和 Store Action；可直接构造多节点/边并断言传给原生命令的 `input.inputs`。
- 宿主 `model.generate` effect 的媒体结果收口为 `effectResult.value.url`；该 URL 可以在 effect 完成后加入本轮允许集合。
- 目标文件严格 UTF-8 状态已确认；现有 `pluginRuntime.test.ts` 基线为 7/7 通过。

## 代码细节

- 三份目标产品文件已用严格 UTF-8 解码成功。
- `validateResult` 当前只做声明字段与受保护字段检查；它适合增加可选的媒体来源集合参数。
- `validatePluginNodeResult` 能按声明的 output id 过滤结果，但尚未按 output port type 检查媒体字符串来源。
- `outputPatch` 只会把 `image`、`video`、`audio` 端口的字符串映射为可加载媒体字段，因此可在写回前针对这三类端口实施精确限制。
- 节点工具除五个直接媒体字段外，还可能写入含可加载 URL 的 `directorCaptureUrls`、`storyboardOverrides`、`shotlistRows`、`videoReferences`、`annotation` 和 `mattingMask`；媒体来源检查应覆盖这些顶层载体并递归检查其中的 URL 字符串。
- 输入校验原先在 derivation guard 注册之后、`finally` 之前执行；本批把 guard 注册移动到同步输入验证之后，避免错误连线留下未清理的 pending guard。
- 最终差异只涉及三份已确认产品文件；规划记录另外保存在根目录三份 Markdown 中。工作区其他插件外文件仍属于既有并行改动。
- 最终安全复审额外发现并验证了三项加载面：`ai-markdown.output` 中实际渲染的图片、画布笔记颜色的 CSS 转义、显式插件端口的缺失来源；均已失败关闭并有回归测试。

## 未提交改动审计（进行中）

- 现有过程记录确认插件运行时安全修复只应涉及三份产品文件；根目录三份 Markdown 为过程记录。
- 当前工作区另有原生插件信任注册、Blender 运行时和多项 Rust 系统能力改动，不能与上述三文件修复未经审阅混为一个提交。
- 当前仅完成来源分流判断；是否完整、有用及可提交仍需以实际差异、引用与验证为准。
- 实际内容差异为 21 个已跟踪文件，另有 2 个产品候选新文件（原生注册表 Rust 模块与 ADR）和 3 个过程记录；其余若干 Rust 文件仅被 `git status` 标记，但 `git diff` 无正文变化。
- 已分成三个候选提交：A. 插件端口/媒体来源安全修复；B. 原生插件信任注册表与执行租约（架构收敛）；C. Blender 编辑保存回传最新帧与界面反馈。
- B 组新增 Rust 私有注册表、摘要绑定、stage/activate/ensure/disable/remove 命令、Python 调用取消与进程树托管，并联动权限、路径拒绝、Store 和 UI；属于必须单独审核确认的架构改动。
- `.gitignore` 同时新增 `.planning` 与 `.cargo`；`.planning` 与当前根目录过程记录没有直接对应关系，需单独判断是否为有意仓库策略。
- C 组 Blender 改动形成闭环：模板在“保存并返回”时原子保存 `.blend`、渲染当前帧 PNG、生成双产物清单；Rust 校验 `open-editor` 必须恰有当前帧和 `.blend`；前端把帧持久化为最新导演台预览，并把内置运行时提升为 `1.3.2`。
- A/B 两组在 `pluginRuntime.ts` 与其测试中交织：端口/媒体安全修复与原生 `sourceDigest` 执行租约共同参与调用前、effect 间和写回前校验，机械拆分风险高；若提交，宜作为同一插件安全阶段审阅，提交说明可按架构主线概括。
- 机器默认 Rust 测试被既有 ONNX Runtime 1.24.2 与 VS2019/MSVC v142 ABI 不匹配阻断；改用已知兼容的 `--no-default-features` 后，注册表 19 项、插件运行时 13 项、Blender artifact 3 项、资源 4 项均通过，`cargo check --lib` 通过。
- 全仓前端 `npm run check` 的 lint、类型和测试类型阶段通过；全量 Vitest 为 233 个文件通过、4 个失败，失败均位于候选文件之外：2 个 MCP 测试解析错误、1 个 i18n 孤儿词条、1 个宫格测试 mock 缺失。候选三文件定向测试仍为 63/63 通过。
- 9 个仅状态异常的 Rust 文件工作区 blob 与 `HEAD` blob 哈希完全相同，应排除；这也解释了全仓 rustfmt 会报告候选范围外的既有格式基线。
- `.cargo/config.toml` 是本机 Cargo 网络配置，`.planning/` 是规划工具目录；将两者加入 `.gitignore` 有用，但根目录 `task_plan.md`、`findings.md`、`progress.md` 仍不应作为产品提交。

## 五份长期文档同步（已完成，待提交）

- `README.md` 当前只把 3D 导演台描述为固定资源与截图回传，未说明同一节点可选择轻量网页或 Blender 高级编辑，也没有用户插件能力入口；适合补两条简明能力与插件开发规范链接，不写内部命令或私有目录细节。
- `AGENTS.md` 的目录树缺少 `services/plugins/`、`store.plugins.ts`、`types/plugin.ts`、`plugin_registry.rs`、`plugin_runtime.rs` 与 `blender_runtime/`；Tauri 规则也尚未固化原生插件注册表、执行身份、私有目录和 Python 取消边界。
- `doc/开发指南.md` 已有 Blender 双运行时调试与资源更新说明，但安全边界仍只有凭据、路径、Agent、工具和 MCP；需要加入插件安装/执行注册链、文档/ADR 路由，并说明 `open-editor` 保存返回现在要求 `.blend + 当前帧` 双产物。
- `doc/插件开发规范.md` 已经包含本次绝大多数真实契约：端口精确路由、远程媒体来源、原生摘要注册、租约、安装/更新/停用/卸载和常见错误；主要缺口是结尾未链接 ADR-0010，以及可加强“源码摘要不是完整包签名”的 P0 限制提示，避免重复大段正文。
- `doc/架构说明.md` 尚无插件服务层/原生注册表章节，Rust 能力表和目录树缺少插件模块；Blender 链路仍把保存返回概括成统一结果投影，没有写明 `open-editor` 双产物和最新帧进入导演台预览。
- 审计发现两处与当前 `AGENTS.md` 安全矩阵直接冲突的旧文案：架构说明仍称文件写入、永久删除、媒体生成等“始终需要确认”；开发指南仍称 `agent_run_sub_agent` 不对 MCP 开放。当前代码/规则是 C 自主模式与 MCP 会话所有 effect 自动执行，产生模型开销的子智能体工具也对 MCP 开放，MCP 不能调用审批解决接口。
- README 把 MCP 描述为复用“审批”，容易让用户误以为无人值守 MCP 会等待人工确认；应明确它复用 Tool Registry、Policy 与任务审计，但按最大权限自动执行，并提示只对可信本机客户端手动开启。
- Blender 固定资源的当前 manifest 是 `packageVersion: 1.3.2`、`createdWithBlenderVersion: 5.2.1 LTS`；长期规则不应在 `AGENTS.md` 写死包版本，开发/架构文档应以 manifest 与 Rust 常量同步为准。
- 原生插件执行的真实入参已经收敛为 `pluginId + sourceDigest + toolId + invocationId + input`；`source` 和 `runtime` 只在 stage 时进入 Rust，普通执行从私有注册表读取并复核。
- README 只应说明“SHA-256 绑定用户批准的精确源码”，不能把摘要写成代码签名、安全审计或作者身份证明；可信 Python 也不能描述为 Manifest 沙箱。
- README 的轻量导演台与 Blender 必须分开表述：应用按需下载的是固定轻量导演台资源，不会下载 Blender；Blender 高级编辑使用用户已有的 Windows x86_64 Blender 5.2.1，保存返回的新增承诺仅是 `.blend` 与当前镜头，不扩大为结构化 Scene 无损同步。
- README 只更新中文会让 `README.en.md`、`README.ja.md`、`README.ko.md` 暂时存在能力描述差异；用户本轮明确限定 `README.md`，翻译文件不越界修改。
- `doc/adr/` 当前已有两个以 `0010-` 开头的 ADR 文件；新增链接必须使用完整文件名和标题，不能只写含糊的“ADR-0010”。
- 源码复核确认 `src/services/indexedDb/schema.ts::DB_VERSION` 当前为 20，`useAppStore.ts` 当前聚合 21 个 slice；AGENTS/开发指南/架构说明中的 17 和 19 均已过期。
- `path_policy.rs` 当前同时拒绝 secrets、`agent-private`、`plugin-private`、Blender 私有目录及其祖先重叠；架构说明的“安全闸分三层”需要扩展为私有目录总边界。
- MCP 当前不是仅本机一次性会话：默认关闭但可配置 `mcpAutoStart`，端口可固定或随机；stdio 适配器只连 `127.0.0.1`，远程 `streamable-http` 监听 `0.0.0.0` 的 `/mcp`。
- MCP 256-bit 固定令牌以 `mcp/token` 条目进入 Rust `secret_store` 并可轮换；凭据存储不可用时才退化为当前会话令牌。令牌不进入 IndexedDB、普通配置、Event 或日志，stdio 通过环境变量、HTTP 通过 Bearer 发送。
- Streamable HTTP 验证 Bearer、Host 和同源 Origin，限制 1 MiB 请求体与 4 个并发；它是明文 HTTP，不能把 Token 当作加密，只适合受信网络或隔离环境。
- MCP 两种传输均固定使用 C 自主模式，八类安全矩阵 effect 不逐次审批；`user_choice` 仍需 AI Canvas 用户作答，客户端不能调用审批解决接口。
- 开发指南当前版本头和架构说明版本头仍为 0.6.13 / 2026-07-31，应同步为项目版本 0.9.0 和本次日期；README 徽章已是 0.9.0。
- 五份目标文档现已同步完成；最终扫描未再发现 0.6.13、v17、19 slices、一次性 MCP 令牌、仅 loopback 或 Plan 下等待 `user_choice` 等旧语义。
- 本地 Markdown 链接、严格 UTF-8、代码围栏、关键源码事实与差异空白检查均通过；翻译 README 未在本轮用户清单内，保持不动。

# 全仓代码质量审查与精简建议

最新状态：2026-11-16，第五批 Q40～Q41、第六批 Q42～Q44 已提交为 `c89b36b9`；本轮第七批 Q45 面板孤儿样式、Q46 闲置导出与 Q47 重复媒体键表清理已实现，按用户要求单独提交。第七批源码与样式净减 153 行，三批累计净减 793 行；本次未运行测试，待用户验收，范围与桌面步骤见文末。

2026-11-15 记录：第一批已提交为 `19c6b3b2`，第二批 Q26、Q25、Q28 布局、Q31、Q39 已提交为 `6c46dccc`，第三批 Q33～Q38 已提交为 `5dbc443a`；第四批 Q24 已实现并按用户要求提交，Q32 经实际核算保留现状。本轮用户要求普通推送 `master`，不发版本标签；各批仍有用户验收缺口，未运行本轮测试或质检。实际范围、净减、桌面步骤和剩余项见文末；此前基于 `e2023a8b` 的复查快照及早期行号保留当时事实，不代表当前未处理清单。

日期：2026-10-30。状态：静态审查完成；Q01 自动回归与部分桌面交互已验证，真实生成等场景待验收；Q02 与 Q03 运行时保护已实现、尚未运行测试；Q04 闲置模块及专属样式已清理，Q05 音视频工具栏预设执行、Q06 历史筛选、Q07 参考媒体串行处理、Q08 模型协议基础逻辑及 Q09 四组局部重复已合并，均待用户验收；Q10～Q17 已于 2026-10-31 实现，相关自动回归 535 项通过，桌面验收待完成。

2026-10-31 续查初稿：以 `e53ddcdf` 所在工作区源码为准，新增 Q12～Q17。随后用户授权全部优化，实施结果见下方“Q10～Q17 实施结果”；问题描述及带行号证据保留为修改前的审查快照。Q12～Q14 的行为风险优先于 Q10／Q11 的低收益统一。初稿阶段仅阅读源码、搜索引用与比对重复片段；实施阶段已修改代码，但未执行测试、lint、类型检查、构建或实机验收。上文各批次的测试状态是当时记录；后续发布门禁另见 [0.10.22 发布专项](./2026-10-31-release-0.10.22.md)，不能代替本轮新增场景的验收。

建议先收敛模型默认值和节点几何计算，再清理闲置模块、合并同领域重复函数。前两项已经存在实现差异；全仓建立通用抽象或批量拆分大文件的收益较低，影响面更难控制。

## 范围与依据

- 使用 Ponytail、Code、React 最佳实践、React Flow Code Review 与 Security Auditor Skill。
- 全仓进行文件清点、函数体及代码片段比对、导入关系分析、依赖引用搜索；对下列问题追踪真实调用链。扫描结果是静态候选，未把名称相似直接当作重复功能。
- 主要覆盖 `src/` 的 1,029 个源码与样式文件、原生侧 `src-tauri/src/` 的 74 个文件、8 个工程脚本和 581 个测试文件；同时核对根配置、SDK、页面启动脚本及 npm 锁文件。
- 第三方源码、构建产物、缓存和生成的 MCP 适配器不作为精简对象。翻译词条、模型目录与测试用例不因文本相似而批量删除。
- 最初全仓审查仅做静态核对；后续经用户授权执行的 Q01 自动检查与桌面交互见下文。未运行全仓检查、Cargo、构建或性能基准，未进行联网依赖漏洞核验。其余条目的“已确认”仍指源码与调用关系已确认，不代表功能实测通过。

## 优先处理的行为风险

### Q01 P2 模型偏好在展示与执行之间存在分叉

原问题：NodeMenu 新建文本／音频未写入历史模型身份，选择器却从 localStorage 显示历史模型；[generationService.ts](../../src/services/generationService.ts) 只读取节点或项目默认值，因而可能显示已选、实际拒绝生成。四个新建 Hook 另有各自的偏好解析。

已实现：

- [modelPreferenceService.ts](../../src/services/modelPreferenceService.ts) 统一偏好读写和类型回退。UI 新建按“当前项目默认 → 本类型历史偏好 → 对应文本／图片类型兜底 → 未选”解析，保留完整 `model/provider/workflowId`。
- [NodeMenu](../../src/components/NodeMenu.tsx)、[Sidebar](../../src/components/Sidebar.tsx)、[双击／导入 Hook](../../src/hooks/useNodeCreation.ts)、[快捷键](../../src/hooks/useKeyboardShortcuts.ts)、[右键菜单](../../src/hooks/useCanvasContextMenu.ts) 与[连线新建](../../src/hooks/useConnectionDropMenu.ts) 共用该解析，在现有 Store Action 提交节点时写入身份；四份重复加载函数已移除。
- [ModelSelector](../../src/components/nodes/shared/ModelSelector.tsx) 只显示调用方实际绑定值，不读取历史偏好冒充当前选择，也不通过 Effect 回填旧节点或临时表单。显式清空继续保持未选；用户真实选择时才保存偏好，`persistPreference=false` 继续不保存。
- 图片／视频空节点的既有参数偏好回填只复用共享读取器，没有扩展到其他类型；未修改生成执行器、Agent／MCP 工具或模型授权。源媒体导入不自动绑定，导演台继续使用自己的模型入口。
- 偏好为损坏 JSON、非对象或无效模型引用时安全降级，不自动改写存储；项目默认工作流完整保留 `workflowId`。无依赖、权限或数据库迁移。

2026-10-30 验证结果（用户已授权测试）：

- 5 个定向 Vitest 文件、63 项用例通过，覆盖偏好优先级、完整节点绑定、工作流身份、损坏存储、选择器受控展示与源媒体导入边界。
- `npm run typecheck`、`npm run test:typecheck` 与本批 13 个 TS／TSX 文件的定向 ESLint 均通过。检查发现的 React 编译器 memo 依赖问题已修正；修正后两套类型检查、定向 ESLint 与选择器 16 项用例复跑通过。
- 在当前 Tauri 开发窗口的“测试”画布，通过右键菜单新建音频／图片临时节点。未绑定音频显示“选择模型”且生成按钮禁用；图片继承已有模型偏好，清空后关闭重开仍保持未选；后续新建图片仍继承原偏好。临时节点与清空动作均已撤销，原香水节点和连线保留，未发起生成请求。
- 该项目原有文本默认模型已隐藏，本次未修改项目配置。项目默认／文本与音频历史偏好／工作流优先级由自动回归覆盖，尚未在此画布完成对应桌面实测。其他新建入口的完整桌面遍历、保存重开、跨项目／独立窗口与真实模型调用仍待验收；未运行构建。

Tauri 桌面剩余验收：

1. 准备可用的文本和音频模型，各选择一次保存偏好；当前项目不设默认模型。分别通过浮动菜单、侧栏、快捷键、右键及连线菜单新建，检查显示与节点实际绑定一致，手动生成时不再提示未选择模型。
2. 为项目设另一文本／音频模型及图片工作流，再新建节点；预期项目默认优先，工作流选择与真实 `workflowId` 一致。动画自带提示词不能使历史图片偏好抢占项目默认。
3. 清除当前节点模型后关闭重开、保存重开，预期保持未选；打开旧的无模型节点或空反推／预设表单时不展示虚假的历史选择，真实已绑模型不被改写。
4. 回归源图片／视频／音频导入、预设步骤显式选择、临时润色选择、分镜与全景类型目录，以及主／独立助手的实际绑定。切换项目、撤销／重做与保存重开保持原语义；Agent／MCP 不新增 UI 偏好回退。

已执行的回归命令（仓库根目录）：`npx vitest run tests/services/modelPreferenceService.test.ts tests/components/nodeMenuModelPreferences.test.tsx tests/components/modelSelectorWorkflows.test.tsx tests/hooks/useNodeCreation.test.tsx tests/services/projectSettingsService.test.ts`。类型检查命令为 `npm run typecheck` 与 `npm run test:typecheck`；修正后的选择器复跑命令为 `npx vitest run tests/components/modelSelectorWorkflows.test.tsx`。

回滚：撤销本项共享偏好解析、UI 调用及对应回归差异；已有节点、项目默认和 localStorage 存储格式不迁移、不清理。Q02～Q11 不在本次实现范围。

### Q02 P2 节点尺寸计算存在多套优先级

原问题：[共享包围盒](../../src/utils/nodeBounds.ts) 只读业务估值，吸附与分组命中则各有实测／样式／业务值的回退顺序，默认尺寸也有重复实现；[压缩副本](../../src/services/imageLosslessCompression.ts) 按共享包围盒右边界放置，可能与放大后的原图重叠。新建分组还按节点数组预计算尺寸，却按选择顺序使用，顺序不同时会错配不同节点的尺寸。这些是源码结论，未做桌面复现。

实施方案（2026-10-30，已实现）：

1. 在现有 `nodeBounds.ts` 增加纯尺寸读取入口。宽高分别选择有效正数：`measured` → React Flow `width/height` → `initialWidth/initialHeight` → 数值或 px 样式 → 业务卡片／笔记尺寸 → 类型默认。前两项描述已有显示边界；没有实测值的节点按后续声明估算，不将估算写回节点。百分比、auto 和相对单位不能脱离容器解析，跳过。
2. [吸附](../../src/hooks/useNodeSnap.ts)、共享包围盒、[分组命中](../../src/store/store.nodes.ts) 和[新建分组包围盒](../../src/store/store.groups.ts) 共用 `getNodeSize()`；吸附父链仍使用 Map，几何位置与历史提交沿用原路径。新建分组直接读取当前节点尺寸，不再用数组下标关联选择顺序。逐镜排版和折叠展开的目标尺寸保留原职责，Q03 父链循环保护不在本项处理。
3. 默认尺寸按生成／源媒体同类解析；过滤非有限值、零和负值，笔记缺少卡片镜像字段时可按自身尺寸估算。读取过程不改写节点，不新增持久化字段、依赖或权限。
4. 新增 [nodeBounds 回归](../../tests/utils/nodeBounds.test.ts)，补充 [groupFolders](../../tests/store/groupFolders.test.ts) 和 [imageLosslessCompression](../../tests/services/imageLosslessCompression.test.ts)，覆盖优先级、异常值、音频／笔记／未挂载分组、嵌套坐标、反向选择与压缩副本放置。

状态：已完成源码、引用、UTF-8 和差异空白静态核对；提交时复用既有钩子执行本批 7 个 TS 文件的定向 ESLint。本次未运行测试、类型检查、构建或桌面验收，待用户验收；Q01 的既有结果不代表 Q02 已验证。

Tauri 桌面验收：

1. 在测试项目准备不同宽高的图片、音频和画布笔记，缩放图片后分别拖拽对齐与平均分布；吸附线、间距手柄应贴合当前显示边界，音频不因旧卡片高度产生额外间距。
2. 以不同顺序选中两个大小明显不同的节点创建分组，分组应包住同一内容范围；撤销／重做保留位置和成员。把未生成音频移到展开分组的边缘，按节点中心判定入组；回归嵌套分组移动、折叠展开及隐藏子节点不参与吸附。
3. 对放大的组内可压缩 PNG／JPEG 执行“无损压缩”。实际产生副本时，应位于原图当前右边缘外 40 个画布单位，纵坐标与原图绝对坐标一致；没有压缩收益时沿用不创建副本的行为。
4. 保存重开项目，再检查音频、笔记、分组和图片首次挂载前后的尺寸恢复；比例／auto 样式无法独立换算时安全采用业务估值。异常数值和未实测场景优先由下列定向回归覆盖。

回归命令（仓库根目录，尚未执行）：`npx vitest run tests/utils/nodeBounds.test.ts tests/hooks/useNodeSnap.test.ts tests/store/groupFolders.test.ts tests/services/imageLosslessCompression.test.ts tests/components/distributionGapHandles.test.tsx`。类型检查按需执行 `npm run typecheck` 与 `npm run test:typecheck`。

回滚：撤销共享尺寸读取及四处接入、对应回归和文档差异；节点记录与项目存储格式不迁移。Q03 的独立实施状态见下文。

### Q03 P2 两处父级遍历缺少循环终止条件

原问题：[nodeBounds.ts](../../src/utils/nodeBounds.ts) 和 [useNodeSnap.ts](../../src/hooks/useNodeSnap.ts) 曾各自通过无 visited 集合的 `while (pid)` 累加父级偏移；[store.nodes.ts](../../src/store/store.nodes.ts) 另有带循环保护的同类逻辑。A 的父级为 B、B 的父级为 A 时，前两处自身无法结束遍历。这是静态控制流结论，未实际加载损坏归档。

实施结果（2026-10-30）：

1. `nodeBounds.ts` 的 `getParentOffset()` 统一父链偏移计算，visited 从当前节点 ID 开始；每个祖先至多累加一次，自引用、祖先重复或父节点缺失时终止。保留已找到祖先的偏移，不改写父链。
2. `getNodeBounds()` 支持数组和 Map 查找；吸附直接复用共享包围盒与 `NodeBounds` 类型，移除重复的父链、包围盒实现和类型声明。Map 直接按 ID 查父节点，不重新转成数组；原预计算、回调、视口裁剪和尺寸规则沿用。
3. 分组 `absoluteNodePosition()` 复用共享偏移，移除本地重复遍历；未变更 Store Action、历史提交和持久化结构。
4. [nodeBounds 回归](../../tests/utils/nodeBounds.test.ts) 同时覆盖数组／Map 的自引用、两节点循环、上游祖先循环、缺失父级、合法多级链和当前传入位置，另含 2,000 层 Map 父链；异常用例限制查询次数，保护失效时直接失败，避免挂住测试进程。[groupFolders](../../tests/store/groupFolders.test.ts) 补充历史自引用分组不重复累加自身坐标的回归。

状态：运行时终止保护已实现，完成源码、引用、UTF-8 与差异空白静态核对；提交时复用既有钩子执行本批 5 个 TS 文件的定向 ESLint。本次未运行测试、类型检查、构建或桌面验收，待用户验收。

边界：运行时截断只保证本项几何遍历结束，不表示异常父链可由整个 React Flow 或其他模块合法加载。[projectTransferService.ts](../../src/services/projectTransferService.ts) 的归档形状检查尚未校验节点父链，归档入口的拒绝／修复策略仍需独立处理；本次不变更导入合同，也不自动修复历史数据。

Tauri 桌面验收：

1. 准备含合法嵌套分组、图片、音频和笔记的测试项目，拖动组内节点进行边缘／中心吸附和平均分布；父组移动后再操作，预期祖先偏移只累加一次，不出现坐标漂移。
2. 新建、拖入／拖出普通分组，回归成员关系、绝对位置及撤销／重做；组内图片生成压缩副本时仍按当前绝对右边缘放置。保存重开后合法项目布局应一致。
3. 自引用、循环、缺失父节点与深链由本次纯几何／Store 定向回归验收，检查有限返回、坐标约定与原记录不变；这不替代归档入口和其他模块的坏数据验证。

回归命令（仓库根目录，尚未执行）：`npx vitest run tests/utils/nodeBounds.test.ts tests/hooks/useNodeSnap.test.ts tests/store/groupFolders.test.ts tests/services/imageLosslessCompression.test.ts tests/components/distributionGapHandles.test.tsx`。类型检查按需执行 `npm run typecheck` 与 `npm run test:typecheck`。

回滚：撤销共享父链保护、吸附／分组接入、对应回归及文档差异；无数据库迁移、依赖、权限或原始节点记录变更。

## 已确认的精简候选

### Q04 P3 四个模块未找到使用入口

2026-10-30 已按用户要求重新核对并删除：

| 已删除文件 | 静态核对依据 | 当前使用入口 |
|---|---|---|
| `src/components/ProjectSwitchOverlay.tsx` | 无导入、重导出或组件使用点 | [App.tsx](../../src/App.tsx) 通过 `showProjectSplash`／`splashReady` 使用 `SplashScreen`，仍读取 `switchingProjectName` |
| `src/components/nodes/shared/VideoNodeControls.tsx` | 无导入或组件使用点；七个专属 CSS 类及两项视频进度／音量变量只由本文件使用 | [VideoNode.tsx](../../src/components/nodes/VideoNode.tsx) 使用公共 [VideoPlayer.tsx](../../src/components/shared/VideoPlayer.tsx) |
| `src/services/ai/providers/runninghubImage.ts` | 旧包装函数 `generateRunningHubImagesBatch` 及参数类型无仓内调用或重导出；项目为 private 包，无此模块的发布入口 | [mediaProviderRegistry.ts](../../src/services/ai/mediaProviderRegistry.ts) 注册 [runninghubMedia.ts](../../src/services/ai/providers/runninghubMedia.ts) 的标准 Adapter |
| `src/components/shared/mascot/loadingText.ts` | `createLoadingText` 与 `LoadingText` 类型无导入或调用点 | [Mascot.tsx](../../src/components/shared/mascot/Mascot.tsx) 的加载状态使用 `createOrbitRibbons` 彩带动画 |

删除前实数为四个模块 444 行，并删除 [nodes.css](../../src/styles/nodes.css) 中 153 行独占控件规则（含悬浮、聚焦、滑块和减少动态效果分支），合计 597 行，包含注释与空行。同步移除目录清单和架构说明中的过期入口。此数字表示源码维护量，不代表生产包一定减少相同体积，未引用模块可能已被构建工具排除。

静态核对覆盖仓内源码、测试、SDK、脚本、配置、入口与文档中的文件名、导出符号、动态加载和专属选择器；当前 `import.meta.glob` 只加载工作流 JSON，不为上述四个模块提供入口。已经排除误报：[mcpCaptureWorker.ts](../../src/services/mcp/mcpCaptureWorker.ts) 由 [mcpUiRuntimeService.ts](../../src/services/mcp/mcpUiRuntimeService.ts) 通过 `new Worker(new URL(...))` 加载，继续保留。共享 Store 字段、视频播放器、翻译词条、标准 Adapter、动画与 Three.js 依赖不在本次删除范围。

本次未运行测试，待用户验收；未执行 ESLint、类型检查、构建或桌面实测。仅完成引用复核、差异空白检查及 UTF-8 编码确认。

Tauri 桌面验收（准备两个现有项目、可播放的本地视频及已有 RunningHub 模型配置）：

1. 从项目库打开项目，再通过项目栏切换到另一项目；预期加载遮罩正常完成、画布可交互，快速连续切换不会残留遮罩。
2. 打开已有视频节点，检查紧凑预览和全屏播放器的播放／暂停、进度拖动、静音及音量调节；预期控制正常、画面比例不变，深浅主题与减少动态效果下无样式缺失。
3. 打开 RunningHub 图片／视频／音频模型选择与参数面板；预期目录和参数正常。需要验证真实提交时使用既有生成入口，成功／失败与恢复仍由标准 Adapter 处理（会产生模型调用费用）。
4. 在既有模型请求期间观察吉祥物；预期显示当前彩带加载态，完成后恢复，性能模式和关闭动态效果的行为保持原样。

回滚：恢复这四个文件、对应专属 CSS 及本节相关文档差异；无数据或配置迁移。

### Q05 P3 音频和视频工具栏重复执行预设

原问题：[AudioNodeToolbar.tsx](../../src/components/nodes/shared/AudioNodeToolbar.tsx) 与 [VideoNodeToolbar.tsx](../../src/components/nodes/shared/VideoNodeToolbar.tsx) 重复编排读取最新节点和预设、判断顺序预设、解析动作、创建节点与边及启动生成。

2026-10-30 已实现：

- 既有 [presetAction.ts](../../src/components/nodes/shared/toolbar/presetAction.ts) 增加 `executeToolbarPreset`，点击时从同一份最新 Store 快照读取源节点、预设及写入 Action。源节点或预设已失效时直接结束；顺序预设优先交给 `requestPresetSequence`，不提前创建节点或调用模型。
- 普通预设继续经 `resolvePresetAction`／`createPresetNode` 解析与派生，通过 `addNodeWithEdge` 一次提交节点和连线及历史，再将含 `@{源节点:名称}` 的完整提示词与新节点数据交给 `executeGeneration`。保留 direct／insertPrompt 在工具栏中派生并生成的既有行为、模型与工作流解析及后处理参数。
- 两个工具栏保留 `stopPropagation`、稳定回调和各自按钮交互，移除重复业务体、仅执行时需要的 Action 订阅和多余类型转换。文本、图片、全景工具栏及 Agent／MCP 调用保留原入口；无依赖、配置或持久化迁移。
- 在 [presetNodeWorkflow.test.ts](../../tests/components/presetNodeWorkflow.test.ts) 补充两种媒体共 8 个回归场景，覆盖最新提示词／预设、替换／追加、源引用与 ComfyUI 身份、一次历史及生成、顺序预设分流和已删除目标。用例已编写，尚未执行。

Q05 已提交为 `3b70ec9a`，提交钩子完成 4 个 TS／TSX 文件的定向 ESLint。回归用例尚未运行，类型检查、构建与桌面实测仍待用户验收；实现阶段仅完成调用链、差异、UTF-8／原 BOM 与换行及空白静态核对。

Tauri 桌面验收（准备测试项目、音频／视频素材节点、可用模型，以及对应的普通和顺序预设）：

1. 分别选中音频和视频节点，保持工具栏显示，更新源提示词、名称及预设模板后点击预设；预期只新增一个对应生成节点和一条连线，提示词采用最新内容并保留源节点与已有素材引用，原始素材不变，生成只启动一次。
2. 普通预设分别使用 direct 与 insertPrompt；预期模板替换／追加规则、模型覆盖和 ComfyUI 工作流身份与原行为一致。一次撤销移除本次派生节点及连线，重做恢复；保存重开后引用和连线仍正确。
3. 点击顺序预设，预期先打开既有运行配置，确认前节点数及连线数不变；取消不发起模型调用，确认后按原 Runner 执行。回归视频截帧、全屏及反推，音频播放、转录和语音识别，以及工具栏编辑与更多菜单。

自动回归由用户在仓库根目录执行：`npx vitest run tests/components/presetNodeWorkflow.test.ts tests/services/presetSequencePlan.test.ts tests/services/presetSequenceRunner.test.ts`；类型检查可执行 `npm run typecheck` 与 `npm run test:typecheck`。以上命令本批均未运行。

回滚：恢复两个工具栏、共享 `presetAction.ts`、相应回归用例和本节文档差异。

### Q06 P3 历史筛选规则重复

[store.historyRecord.ts](../../src/store/store.historyRecord.ts) 和 [indexedDbService.ts](../../src/services/indexedDbService.ts) 的 `matchesHistoryQuery` 函数体相同；本批调用链复核还确认 [OutputHistoryPanel.tsx](../../src/components/OutputHistoryPanel.tsx) 的筛选与之同义。

2026-10-30 已实现：

- 新增 [historyQuery.ts](../../src/utils/historyQuery.ts) 的纯函数 `matchesHistoryQuery`，只引用领域类型，不加载 Store 或数据库。节点类型仍精确匹配；关键词去首尾空白、忽略大小写，在提示词／输出／模型／节点名称中任一命中。空条件表示不限，不扩展到供应商、错误信息或参数字段。
- [Store](../../src/store/store.historyRecord.ts) 新增记录、[面板](../../src/components/OutputHistoryPanel.tsx) 内存列表、数据库分页及导出共用该函数，删除原两份谓词及面板中的同义规则。`HistoryQuery` 移至 [types/index.ts](../../src/types/index.ts)，数据库服务保留类型重导出，既有导入路径可继续使用；保留持久化记录的字符串类型兼容性。
- 项目隔离仍由各调用入口负责，查询身份比较、分页游标、倒序读取、失效素材过滤和每项目 16 条保留策略均沿用原实现，无数据、索引或配置迁移。
- 在 [imageGenerationHistory.test.ts](../../tests/services/imageGenerationHistory.test.ts) 补充一项集成回归，使用 9 组查询条件对比内存筛选、每页 2 条的数据库游标读取与完整导出，覆盖四个搜索字段、大小写、首尾／纯空白、类型与关键词组合、未命中、旧类型字符串、项目隔离和相同时间戳排序。用例已编写，尚未执行。

Q06 已提交为 `b0ad129c`，提交钩子完成 6 个 TS／TSX 文件的定向 ESLint。回归用例尚未运行，类型检查、构建与桌面实测仍待用户验收；实现阶段仅完成调用链、差异、UTF-8／原 BOM 与换行及空白静态核对。

Tauri 桌面验收（准备两个有现存生成历史的项目，当前项目包含文本、图片、视频和音频记录）：

1. 打开「输出历史」，分别搜索某条记录的提示词、输出、模型与节点名称；改变关键词大小写并添加首尾空格，预期命中相同记录，按原倒序排列。
2. 组合选择节点类型与关键词，再试纯空白、无结果和「全部」；预期类型与关键词同时生效，清空搜索后恢复该类型记录。对各筛选结果导出 JSON，核对记录范围及顺序与面板一致。
3. 保持筛选时等待已有生成任务完成；匹配的新记录进入列表，不匹配的记录在切换到对应条件后可见。回归历史面板固定／展开、查看原节点、删除记录及清空操作。
4. 切换到另一项目并重复筛选，预期只显示及导出当前项目记录；重开面板后结果正确。分页边界与同时间戳数据由上述每页 2 条的集成用例补充验收。

自动回归由用户在仓库根目录执行：`npx vitest run tests/services/imageGenerationHistory.test.ts tests/store/historyRecord.test.ts`；类型检查可执行 `npm run typecheck` 与 `npm run test:typecheck`。以上命令本批均未运行。

回滚：恢复 Store、数据库服务、面板和领域类型中的本批差异，移除共享筛选文件及新增回归，恢复相关文档状态；无需回滚数据。

### Q07 P3 参考媒体串行处理重复

[generateVideo.ts](../../src/services/ai/generateVideo.ts) 和 [apimartMedia.ts](../../src/services/ai/providers/apimartMedia.ts) 的 `mapSequentially` 完全重复，后续 `resolveImageUrlsSequentially` 也相同。

2026-10-30 已实现：

- 新增 [referenceMediaPreparation.ts](../../src/services/ai/referenceMediaPreparation.ts)，原样迁入并导出 `mapSequentially` 和 `resolveImageUrlsSequentially`。串行映射逐项开始前检查取消，透传原取消原因，首个失败即结束；保持输入顺序、重复项、原下标与空数组语义，不引入额外并发或重试。
- 两个调用方移除本地副本并导入共享函数，所有业务调用及参数保持原样。图片仍每次以单张数组交给 `resolveImageUrlArray`，完整传递厂商与 signal；首尾帧、参考角色及图片／视频／音频映射顺序不变。火山引用分支原有的单张图片解析继续保留。
- 现有 [referenceImageUpload.ts](../../src/services/ai/referenceImageUpload.ts) 的最多两项并发、[batchUtils.ts](../../src/services/ai/batchUtils.ts) 的部分成功合同均继续独立使用；它们不替代本项串行路径。请求级 Data URL 总预算、上传限制、模型提交、轮询与暂停恢复不变，无依赖或数据迁移。
- 新增 [referenceMediaPreparation.test.ts](../../tests/services/referenceMediaPreparation.test.ts) 的 6 个回归场景，覆盖前项等待、重复输入及下标、失败停止且不重试、开始前／项间取消及原因透传、空输入、逐张图片解析与厂商／信号传递。用例已编写，尚未执行。

Q07 已提交为 `ff5b5d57`，提交钩子完成 4 个 TS 文件的定向 ESLint。回归用例尚未运行，类型检查、构建与桌面实测仍待用户验收；实现阶段仅完成调用链、迁移文本、UTF-8／原 BOM 与换行及差异空白静态核对。

Tauri 桌面验收（准备测试项目、已有的通用视频模型协议与 APIMart 配置、两张可区分图片及视频／音频参考素材，优先使用可控测试接口）：

1. 通用视频协议分别加入本地和远端图片、视频、音频；预期素材按既有顺序和原连接策略准备，图片逐张处理，提示词引用编号与对应素材一致，准备完成后才进入原模型提交流程。
2. 使用当前 APIMart 配置中支持首尾帧／多参考的模型，组合首帧、尾帧和普通参考；预期角色与顺序保持，音视频仍沿用原公共上传入口。回归火山方舟已有图片／视频／音频参考及虚拟人像素材路径。
3. 在可控接口中阻塞第一份素材，预期后一份尚未开始；令第二份素材准备失败或中途取消，预期停止后续项、保留原错误／取消表现，不因合并新增提交重试。
4. 回归空参考、单张图片、原始模型引用顺序，以及超出既有媒体预算时的拒绝；生成后的查询／暂停／继续保存沿用原任务身份。最大两项并发的其他图片路径仍按原策略工作。

自动回归由用户在仓库根目录执行：`npx vitest run tests/services/referenceMediaPreparation.test.ts tests/services/generateVideo.test.ts tests/services/apimartGen.test.ts tests/services/referenceImageUpload.test.ts tests/services/mediaReferenceMemoryGuards.test.ts`；类型检查可执行 `npm run typecheck` 与 `npm run test:typecheck`。以上命令本批均未运行。

回滚：恢复两个调用方中的本地函数及导入，移除共享模块与新增回归文件，并恢复本节相关文档状态；无数据回滚。

### Q08 P3 模型协议基础逻辑未完全收口

原问题：RelayOn／LIBAPI 的规范协议比较函数相同；Shared／Response 重复声明危险路径集合，Body 重复 MIME 正则；对象形状判断散落在多个子模块，其中 JSON 成员与 unknown 成员的类型收窄不同。本批进一步确认 Import 的危险字面量键集合也与共享集合完全相同。

2026-10-30 已实现：

- [modelProtocol.ts](../../src/services/ai/modelProtocol.ts) 承接原样迁入的 `comparableProtocol`，复用既有解析入口，递归排序对象键后比较完整规范协议；数组顺序仍有意义，无法解析或不适用的协议继续返回 undefined。[RelayOn](../../src/services/ai/providers/relayonModelManifest.ts)／[LIBAPI](../../src/services/ai/providers/libapiModelManifest.ts) 仅改为导入，型号识别、严格合同匹配、旧模板兼容和用户自定义分支均保留。
- [modelProtocolShared.ts](../../src/services/ai/modelProtocolShared.ts) 保留唯一 MIME 正则和危险路径集合；[Body](../../src/services/ai/modelProtocolBody.ts)／[Response](../../src/services/ai/modelProtocolResponse.ts) 直接复用，[Import](../../src/services/ai/modelProtocolImport.ts) 将危险键集合以原局部名导入。常量内容不变，路径的自身属性检查、multipart 元数据处理及原错误分支不变。
- 共享 `isRecord` 保留原运行时对象形状检查，增加已知 `ProtocolJsonValue | undefined` 与 unknown 输入的两个类型重载。Body／Import 的输入已经是 JSON 域类型，继续保留 JSON 成员收窄；Response／[Runtime](../../src/services/ai/modelProtocolRuntime.ts) 的未知数据仍只得到 unknown 成员，不借浅层对象判断递归认定 JSON 合法性。四处本地实现已移除，无新增泛型断言或宽泛类型转换。
- 比较函数留在已依赖解析器的协议入口，共享基础模块不反向依赖入口；未新增文件、依赖、厂商合同、鉴权策略或数据迁移。
- 在现有 [modelProtocol.test.ts](../../tests/services/modelProtocol.test.ts) 补充 9 个回归场景，覆盖对象键序／数组顺序、输入不被改写、无法比较的配置、JSON／unknown 成员类型、三个危险路径段，以及校验与 multipart 编码对三种非法 MIME 的拒绝。用例已编写，尚未执行；类型断言仍待测试类型检查。

Q08 已提交为 `f1fa71df`，提交钩子完成 9 个 TS 文件的定向 ESLint。回归用例尚未运行，类型检查、构建、厂商调用与桌面实测仍待用户验收；实现阶段仅完成引用、调用链、迁移文本、UTF-8／原 BOM 与混合换行及差异空白静态核对。

Tauri 桌面验收（准备已有的 RelayOn／LIBAPI 测试模型配置、自定义协议与可控测试接口）：

1. 打开既有内置模型的协议编辑入口，仅调整 JSON 对象字段顺序，核对原能力及生成变量转换仍能识别；改变引用数组顺序时保留新顺序。修改提交路径、响应路径或其他合同内容后，预期按用户自定义协议处理，不被内置快照覆盖。
2. 回归已保存的 RelayOn 旧模板及 LIBAPI 型号别名，核对原兼容行为；未配置或缺少自定义协议时沿用原拒绝／未识别结果，不误用某一厂商合同。
3. 使用响应预览和协议校验，分别输入含 `__proto__`、`prototype`、`constructor` 的路径；预期均被拒绝或无匹配，普通自身字段、数组通配和数字下标继续可用。
4. 导入既有 cURL／Fetch／JSON 示例并预览 JSON、form-urlencoded 与 multipart 请求；核对变量、文件名、凭据／Base64 脱敏及危险字段处理。合法 MIME 正常编码，含换行、缺少子类型或夹带参数的非法声明不被接受。
5. 使用可控接口回归同步结果、异步查询、参考媒体、取消与暂停恢复；错误和未知响应不因共享对象判断而被当作成功结果。

自动回归由用户在仓库根目录执行：`npx vitest run tests/services/modelProtocol.test.ts tests/services/modelProtocolImport.test.ts tests/services/relayonModelManifest.test.ts tests/services/libapiModelManifest.test.ts`；类型检查可执行 `npm run typecheck` 与 `npm run test:typecheck`。以上命令本批均未运行。

回滚：恢复现有协议入口、Shared、Body／Response／Runtime／Import、两个厂商清单中的本批差异，以及相应回归与文档状态；无数据回滚。

### Q09 P3 其他适合顺手合并的小重复

2026-10-30 已实现：

| 领域 | 共享入口与调用方 | 保留边界 |
|---|---|---|
| ComfyUI 响应错误处理 | [comfyQuery.ts](../../src/services/comfyQuery.ts) 导出原样迁入的 `assertComfyResponse`，工作流执行、资源管理及助手 JSON 读取共用 | 成功时不读正文；失败读一次，正文不可读按空内容回退，文案仍包含动作／HTTP 状态及前 200 字符。提交专用 `formatComfyPromptError` 和轮询鉴权错误不替换，短查询超时预算不变 |
| ComfyUI 工作流文件名清洗 | [comfyUIWindowService.ts](../../src/services/comfyUIWindowService.ts) 导出原清洗函数，[comfyAgentService.ts](../../src/services/comfyAgentService.ts) 导入复用 | 非法字符、空白、默认名及 `.json` 后缀处理不变；窗口回传校验、会话／项目保存凭证、服务器绑定和原生写入授权仍留在各自调用方 |
| 视频元素资源释放 | [canvasVideoPreviewCache.ts](../../src/components/nodes/shared/video/canvasVideoPreviewCache.ts) 的既有 `releaseCanvasVideo` 接口委托 [viewportVideoResource.ts](../../src/components/shared/viewportVideoResource.ts) | 原 HTMLVideoElement／null 签名不变，仍依次暂停、移除 src、调用 load；封面调度、取消、Blob 与媒体资源租约不变 |
| 字节数组相等判断 | [projectFiles.ts](../../src/services/fs/projectFiles.ts) 导出原 `bytesEqual`，[directorSceneService.ts](../../src/services/directorSceneService.ts) 在既有导入上复用 | 只比较视图长度与逐字节内容；路径授权、不可变写入、哈希、规范序列化及场景／结果清单绑定继续由原调用方校验 |

未新增模块、依赖或数据迁移，未将不同错误合同、文件权限或资源所有权合并。

在现有 [comfyQuery.test.ts](../../tests/services/comfyQuery.test.ts) 新增 3 项响应读取回归，在 [canvasVideoPreviewCache.test.ts](../../tests/components/canvasVideoPreviewCache.test.ts) 新增 1 项释放顺序及 null 回归；[mediaPreviewMemoryGuard.test.ts](../../tests/components/mediaPreviewMemoryGuard.test.ts) 改为检查公共释放委托，避免要求业务文件保留重复实现。用例已编写／更新，尚未执行。

本次未运行测试，待用户验收；提交时复用既有钩子对本批 11 个 TS 文件执行定向 ESLint，通过后提交。未执行类型检查、构建、真实请求或桌面实测；实现阶段仅完成调用链、迁移文本、UTF-8／原 BOM 与混合换行及差异空白静态核对。

Tauri 桌面验收（准备测试项目、已有 ComfyUI 工作流及完成后的保存入口、可播放视频和导演场景副本）：

1. 读取 ComfyUI 显存状态、执行工作流及取消排队任务，核对成功结果与原来一致。在可控接口返回错误／不可读正文时，核对动作、HTTP 状态、正文截断及回退文案；鉴权失败和工作流提交的专有错误仍按原类型与提示处理。
2. 分别从 ComfyUI 独立窗口和助手保存工作流，名称包含空格、中文、路径字符及已有大小写 JSON 后缀，核对原文件名规则。过期保存凭证、切换项目／服务器、无写入授权时仍按原边界拒绝，失败不显示保存成功。
3. 视频在紧凑预览与全屏间切换，关闭、改源、移出视口或取消封面提取后应停止旧播放并释放旧源；回归封面缓存复用、减少动态效果和性能模式，原租约与 Blob 释放行为不变。
4. 在测试项目保存并重开导演场景及结果清单，核对场景引用保持匹配；通过测试副本或现有回归核对不可变内容冲突、错误哈希、非规范字节及场景绑定异常仍被拒绝。

自动回归由用户在仓库根目录执行：

- ComfyUI：`npx vitest run tests/services/comfyQuery.test.ts tests/services/comfyMemory.test.ts tests/services/comfyAgentService.test.ts tests/services/comfyWorkflowSaveBack.test.ts tests/services/comfyWorkflowAudioIO.test.ts`。
- 视频资源：`npx vitest run tests/components/canvasVideoPreviewCache.test.ts tests/components/mediaPreviewMemoryGuard.test.ts tests/components/viewportImage.test.tsx`。
- 项目文件及导演场景：`npx vitest run tests/services/aiAppProjectFiles.test.ts tests/services/directorSceneService.test.ts`。

类型检查可执行 `npm run typecheck` 与 `npm run test:typecheck`。以上命令本批均未运行。

回滚：恢复本批 8 个业务文件、3 个回归文件和审查／索引差异；无需回滚数据。

### Q10 P3 分组节点的 memo 边界不一致

[GroupNode.tsx:74](../../src/components/nodes/GroupNode.tsx#L74) 直接导出函数，其他主要自定义节点及自定义边使用 `memo`。它已有细粒度子节点数量与封面 selector，不应为添加 memo 而重新订阅整张画布。

已补齐组件 memo；实际收益仍需在多分组、大画布拖拽场景观察渲染次数，不声称已测得性能提升。

### Q11 P4 动画依赖入口可以统一，当前没有重复核心版本证据

[PanoramaViewer.tsx:28](../../src/components/nodes/panorama/internal/PanoramaViewer.tsx#L28) 使用 `motion/react`，项目其余多数地方使用 `framer-motion`；`package.json` 同时直接声明两者。

锁文件中 `motion` 与 `framer-motion` 均为 12.43.0，后者只有一份解析记录。因此可以统一导入入口、减少一个直接依赖声明，但不能据此宣称当前打包了两套动画核心。现已统一入口并同步两份依赖清单，未运行安装或构建。

## 2026-10-31 续查：优先修复行为分叉，再合并小重复

2026-10-31 用户已授权实施全部剩余项（Q10～Q17）。按 Code／Writing Plans 的小步实施方式沿用本专项：先共享导入准备与过期保护，再收敛批量参数、排队校验和并发，最后合并厂商查询及局部工具并统一 memo／动画入口。主要影响画布菜单、节点创建 Hook、批量执行器、共享生成服务、图片批次服务、火山视频查询、文件选择、搜索导航和项目风格读取；Q11 仅移除 `motion` 直接声明及无其他引用的锁记录，保留 `framer-motion` 及其传递依赖版本。各批补充相关回归源码；依仓库规则本轮不自动运行测试、lint、类型检查或构建，也不自动提交。无数据库迁移与原生权限变更，回滚以本批源码及锁文件差异为单位，保留已生成素材和待续任务。

本轮对前端及原生源码做重复片段候选检索，重点追踪菜单上传、拖拽导入、批量生成、普通生成、轮询恢复、自动保存与画布渲染。以下结论是源码可确认的路径差异，尚未通过运行复现；不是新一轮完整安全审计或性能基准。原生侧已有 Cargo 与生成权限描述的工作区修改未纳入本轮修改。

### Q12 P2 菜单文件导入重复，文本读取和异步回填边界缺失

证据：

- [NodeMenu.tsx:146](../../src/components/NodeMenu.tsx#L146) 与 [Sidebar.tsx:179](../../src/components/Sidebar.tsx#L179) 各自实现约 50 行上传、分类、尺寸计算和建节点逻辑。文本分支把 `result.dataUrl` 直接写入 `output`；[fileService.ts:1454](../../src/services/fileService.ts#L1454) 在桌面项目中返回复制后的 `assetUrl`，浏览器分支返回 Base64 data URL，均不是文件正文。
- [TextNode.tsx:278](../../src/components/nodes/TextNode.tsx#L278) 直接显示 `data.output`，Store 插入过程也不解码文本；对比原生拖拽的 [useNodeCreation.ts:425](../../src/hooks/useNodeCreation.ts#L425)，那里明确读取字节并用 `TextDecoder` 解码。同一个 UTF-8 `.txt` 文件，经菜单上传会得到 URL，经拖拽才得到正文。
- 两个菜单在文件选择／复制和图片尺寸读取之后直接调用 `addNode`，没有复核发起时的项目和 revision。若处理期间从项目 A 切到 B，文件可能保存于 A，节点却插入当前 B；[store.nodes.ts:899](../../src/store/store.nodes.ts#L899) 的 Action 写入当前 Store，不携带上传项目身份。

建议把两个菜单的素材准备与建节点收为一个入口：文本显式读取正文，媒体保留 URL；异步链复用 [registerCanvasImport](../../src/services/canvasDerivationGuard.ts#L54) 的项目、revision 与取消边界，在写入前复核并清理登记。一次导入仍只产生一次历史快照。不要直接套用 Agent 导入的所有限制，UI 与 Agent 的权限、批量上限和文本入口不同。

同类排查边界：原生拖拽当前仅 Markdown 路径登记导入守卫（[useNodeCreation.ts:415](../../src/hooks/useNodeCreation.ts#L415)），普通文本和媒体分支也应纳入异步切项目回归，不能把整个拖拽入口视为已经保护。

验收：在 Tauri 中通过两个菜单分别上传含中文的 `.txt`、图片和视频，正文／素材应正确，撤销一次移除新增节点；导入大文件或等待图片解码时切项目、撤销，过期导入不得写入新画布。取消选择、读取失败与拖拽入口也需回归。扩展现有 `tests/components/nodeMenuModelPreferences.test.tsx`、`tests/hooks/useNodeCreation.test.tsx` 或同领域用例覆盖两个菜单；上述场景本轮未执行。

### Q13 P2 批量生成与普通生成存在参数和可执行条件分叉

入口为 [GroupNode.tsx:139](../../src/components/nodes/GroupNode.tsx#L139) 和 [MultiSelectToolbar.tsx:273](../../src/components/canvas/MultiSelectToolbar.tsx#L273)。两者进入 [batchExecute.ts:65](../../src/utils/batchExecute.ts#L65) 的独立单节点执行器，只有 `workflow-api` 分支委托给 `executeGeneration`。

已确认的差异：

- 批量直接使用节点原始 `prompt`；普通入口在 [generationService.ts:286](../../src/services/generationService.ts#L286) 和 [AINodeDialog.tsx:445](../../src/components/nodes/AINodeDialog.tsx#L445) 合并项目风格、节点风格与分类型提示词后缀。因此相同节点单独生成与分组生成会使用不同提示词。风格母图已有底层注入，这项缺口指文字风格与后缀，不能扩大为所有参考素材都失效。
- [batchExecute.ts:167](../../src/utils/batchExecute.ts#L167) 固定调用单张 `generateImage`；后者 [generateImage.ts:60](../../src/services/ai/generateImage.ts#L60) 固定传数量 1，忽略节点 `batchCount`。普通入口处理多图数量及串行多图策略。
- 批量图片／视频／音频参数不传 `runninghubModelParameters`；普通入口有传递，例如 [generationService.ts:540](../../src/services/generationService.ts#L540)。[runninghubMedia.ts:249](../../src/services/ai/providers/runninghubMedia.ts#L249) 使用该字段组装参数，批量会丢掉用户填写的模型专属参数。
- [batchExecute.ts:444](../../src/utils/batchExecute.ts#L444) 一律要求非空提示词及节点自身模型身份；普通入口 [generationService.ts:277](../../src/services/generationService.ts#L277) 允许云工作流／RunningHub 的无提示词任务，并有项目默认模型解析。批量入口可能提前跳过单独可以执行的节点。

建议让批量层负责筛选、顺序与结果汇总，逐步复用普通生成的参数准备和单节点执行；先迁移图片／视频，再覆盖文本、音频、动画和全景。保留批量一次历史、通知汇总、工作流顺序、旧任务恢复与派生结果守卫，避免简单委托造成重复历史或逐节点 Toast。对话 Agent 的 `generationRuntime` 保持自身授权边界，不一起替换。

验收：同一节点分别从普通入口、分组和多选入口执行，对比风格／后缀、数量、RunningHub 参数、无提示词工作流及项目默认模型；失败、取消、历史与恢复任务行为一致。先用 mock 捕获请求，实际付费生成由用户决定。主要回归入口为 `tests/services/batchExecute.test.ts`、`tests/services/projectSettingsService.test.ts`、`tests/components/generationEffects.test.tsx` 与 `tests/services/imageSingleRequestBatch.test.ts`。

### Q14 P2 批量排队期间修改节点，后续仍使用旧数据

[batchExecute.ts:574](../../src/utils/batchExecute.ts#L574) 从开始时传入的 `nodes` 构建队列，[第 620 行](../../src/utils/batchExecute.ts#L620) 逐个传入旧节点对象；[第 70 行](../../src/utils/batchExecute.ts#L70) 直接使用旧 `node.data`，直到 [第 109 行](../../src/utils/batchExecute.ts#L109) 才以实时 Store 登记当前 revision 的守卫。

触发场景：A、B 有依赖顺序，A 运行期间用户修改 B 的提示词或模型。B 出队时仍发送旧参数，却用修改后的画布 revision 建立守卫；旧请求有机会通过校验并回填到已修改节点。队列初建时的 `loading` 筛选也不能证明 B 到出队时仍未被其他入口启动。此项适用于未委托普通入口的批量路径。

建议队列保存明确的节点身份与输入基线，出队时重新取当前节点并复核项目、输入和运行状态；已变化的项跳过并给出原因，不能把旧输入包装成新 revision 的有效请求。复用已有指纹／派生守卫，不新增另一套画布版本体系。

验收：用受控 Promise 让 A 暂停，在等待期间修改 B 的 prompt／model、删除 B、从单独入口启动 B 或切项目，然后释放 A；B 不得提交旧输入或重复启动，跳过项应可辨认。再确认上游正常输出更新不会误判全部下游失效。用 `tests/services/batchExecute.test.ts` 增加这些场景即可，不需要真实模型请求。

### Q15 P3 独立节点批量执行没有并发上限

[batchExecute.ts:628](../../src/utils/batchExecute.ts#L628) 对全部孤立节点直接 `Promise.all`，另有连通节点队列同时运行。选中较多互不连线的节点时会同时开始全部上传／模型请求，既有工作流串行规则只约束工作流节点。

建议复用 [runBatchTasks](../../src/services/ai/batchUtils.ts#L10) 的有限 worker 池，从小并发值开始；上限应统计连通队列与孤立队列的合计，同时保留部分成功、稳定统计与工作流顺序，不自动重投付费请求。当前没有吞吐基准或线上限流证据，收益表述仅限“约束请求峰值”，不承诺速度提升。

验收：mock 多个孤立任务和一条依赖链，记录同时进行的任务数；混合成功／失败、切项目、用户取消时，未开始项不继续提交，统计与顺序正确。延续 `tests/services/batchExecute.test.ts`，同步调整其原先全部并发的预期。

### Q16 P3 火山视频首次查询与恢复查询重复维护同一协议

[generateVideo.ts:1021](../../src/services/ai/generateVideo.ts#L1021) 与 [pollManager.ts:1725](../../src/services/pollManager.ts#L1725) 重复实现同一任务查询 URL、Bearer 请求、408／504 判断、成功视频地址和 `completion_tokens` 提取、失败／取消状态及轮询间隔。

建议在厂商层共享只读查询与响应解析，首次提交和恢复入口继续分别持有任务 receipt、账本、项目守卫与交付状态。两处 `onFetchError` 一处显式写 `throw`、另一处采用同值默认，目前不是行为差异；不要为了合并把“查询重试”扩大为“付费提交重试”。

验收：用相同响应覆盖成功、缺失地址、失败、远端取消、HTTP 408／504、鉴权失败和用量字段缺失；首次路径与恢复路径的协议解释一致，保存失败仍保留原任务。沿用 `tests/services/pollManager.test.ts` 与 `tests/services/volcengineVideoModels.test.ts`。

### Q17 P3 三组可以小步合并的局部重复

| 重复位置 | 最小合并方向 | 保留的边界 |
|---|---|---|
| [webSearchService.ts:35](../../src/services/webSearchService.ts#L35) 与 [webTools.ts:27](../../src/services/chat/tools/webTools.ts#L27) 的 Google RSS／Bing URL 构造 | 共享搜索入口构造和顺序 | 自动聚合与模型导航的调用、任务授权、来源登记仍分别保留，不合并 URL 安全策略 |
| [fileService.ts:532](../../src/services/fileService.ts#L532) 与 [skillFiles.ts:52](../../src/services/fs/skillFiles.ts#L52) 的浏览器文件选择 | 共享 input 创建、change／cancel／focus 的收尾 | 保留文件种类与大小限制、Skill UTF-8 校验；仅浏览器降级路径，Tauri 文件对话框不变 |
| [generateImage.ts:132](../../src/services/ai/generateImage.ts#L132) 私有风格母图读取与 [projectSettingsService.ts:318](../../src/services/projectSettingsService.ts#L318) 已有纯函数 | 读取当前项目后调用现有纯函数 | 不改启用开关、首位参考图顺序、去重或 ComfyUI 排除条件 |

这些属于维护性收益，不作为已发现功能错误。建议拆成小提交；浏览器选择器的返回焦点、选择成功和取消竞态需要一并回归。既有用例入口：`tests/services/webSearchService.test.ts`、`tests/services/chat/webTools.test.ts`、`tests/services/fileServiceSkillUpload.test.ts`、`tests/services/projectStyleReference.test.ts`、`tests/services/referenceImageTransport.test.ts`。

本轮建议顺序：Q12 → Q13／Q14 → Q15 → Q16／Q17 → Q10／Q11。Q13 与 Q14 修改同一批量执行器，实施时协调范围，分别保留可验证场景。Q10～Q17 已按下节实现；本次未运行测试，待用户验收。

## Q10～Q17 实施结果（2026-10-31）

状态：八项已实现，补充/调整回归源码；用户已要求提交并推送，本批提交门禁沿用既有钩子的暂存 TS/TSX 定向 ESLint。2026-10-31 用户授权测试后，专项 18 个测试文件的 483 个用例通过，另有分组与全景 2 个测试文件的 52 个用例通过；类型检查、构建与 Tauri 实机验收仍未运行。已完成调用链、引用、差异空白及 UTF-8/BOM 静态核对；静态复核不能代替运行验证，历史发布门禁也不能作为本批通过证据。

| 项目 | 实现与保留边界 |
|---|---|
| Q10 | `GroupNode` 使用 `memo`，保留既有细粒度 selector；未测量渲染收益。 |
| Q11 | 全景查看器统一使用 `framer-motion`，移除 `motion` 直接声明及锁文件包装记录；其余动画核心和传递依赖版本保持不变，没有执行依赖安装。 |
| Q12 | 两个菜单共用 `sourceFileImportService`，桌面文本读取资产文件字节、浏览器解码 data URL，再写入正文；在选择之前绑定项目/revision，读取与尺寸解析后复核。原生拖放媒体的复制/回填路径合并，保留即时占位、尺寸、Markdown 类型和最近使用记录，普通文本也受守卫保护。画布支持的扩展名移至 `sourceFileType`，不借用资产浏览器更宽的分类规则。 |
| Q13 | `batchExecute` 只管理调度，生成交给 `generationService`；准入与单节点共用 `generationInput`，支持项目默认、显式取消模型、空提示词云工作流/RunningHub、源节点类型适配、风格/后缀、多图及模型参数。帧动画分支迁入执行器并保留宫格与处理参数快照；多图仍分节点交付，单次上限为一的模型仍逐张提交。外层一次历史，内层瞬时回填、汇总提示，产物历史保留实际模型。 |
| Q14 | 排队快照绑定项目/revision、节点数据与类型、有效模型/工作流、项目设置和连线。每项执行前复核；删除、修改、切项目、撤销或已在生成的节点计为跳过，不提交旧参数。上游正常产物回填不改变下游自身快照。 |
| Q15 | 复用 `runBatchTasks`，依赖/工作流串行链占一个名额，与独立节点合计最多 3 个节点任务；底层模型的单节点多图策略保持原有语义。继续处理部分失败，保留成功结果和稳定统计，不自动重试付费请求，不新增批次取消入口。 |
| Q16 | `volcengineVideoQuery` 共享原任务 GET 查询、状态/用量解析、查询超时和取消；首次提交与恢复各自保留 receipt、账本、项目守卫和交付状态。 |
| Q17 | 搜索 URL 构造由 `webSearchService` 导出复用；通用上传/Skill 上传共用 `fs/core` 浏览器选择器并一次清理监听器和定时器；风格母图读取复用已有纯函数。授权、URL 安全策略、文件限制、风格启用及参考顺序保持原边界。 |

Tauri 桌面验收（准备可回滚测试项目、中文文本/Markdown/媒体、可用测试模型与已配置的工作流）：

1. 分别从右键菜单、侧栏上传文本和媒体，核对正文、尺寸及源节点身份；取消选择不建节点。原生拖入多文件后核对占位、落点和最近使用记录；在选择/复制/图片测量期间切换项目或撤销，迟到成功及错误均不得写入另一项目或被删除节点。
2. 对同一图片/视频/音频输入分别用单节点与分组/多选生成，核对项目默认模型、风格、分类后缀和 RunningHub 参数；显式清空模型仍拒绝，云工作流和 RunningHub 支持原有空提示词规则。图片数量 3 应生成三个节点，单图模型逐张提交；一次撤销还原本次结构变化。帧动画、全景及音频语音参数按旧功能回归。
3. 让依赖链前项保持运行，分别修改/删除后项、让后项单独开始生成、切换项目及撤销，再释放前项；未开始项应按变化跳过，不发旧请求。正常上游完成后，下游使用当前产物并按拓扑和工作流展示编号执行。
4. 混合至少 6 个独立节点和一条依赖链，核对最多 3 个节点任务同时执行、单项失败后其他项仍完成、汇总成功/失败/跳过正确。运行中切换项目后无新任务提交，原异步模型任务沿用既有暂停/恢复规则。
5. 回归火山视频首次查询和原任务恢复：成功、失败/取消、超时、鉴权错误、无用量及缺少 URL；保存失败仍保留原任务，不重投。回归全景查看/关闭动画、分组选择/缩放/折叠、搜索导航与风格母图禁用。浏览器演示模式只验选择成功/取消/返回焦点收尾，不替代桌面文件验收。

2026-10-31 在仓库根目录执行以下前三组对应的 18 个测试文件，合并重跑结果为 483/483 通过；另执行 `npx vitest run tests/components/panoramaInternalization.test.ts tests/store/groupFolders.test.ts`，52/52 通过。首次运行有 5 项失败：3 项因批量测试模拟的旧项目 ID 覆盖实时状态，已修正并重跑通过；图片全屏保存的 2 项超时，在 11 项定向重跑和完整重跑中均通过，未确认其首次超时原因。以下类型检查与桌面验收尚未执行：

- 导入/文件选择：`npx vitest run tests/services/sourceFileImportService.test.ts tests/hooks/useNodeCreation.test.tsx tests/components/nodeMenuModelPreferences.test.tsx tests/services/browserOpenFile.test.ts tests/services/fileServiceSkillUpload.test.ts`
- 批量/生成：`npx vitest run tests/services/batchExecute.test.ts tests/services/imageSingleRequestBatch.test.ts tests/services/imageBatchService.test.ts tests/services/generationProjectDefaults.test.ts tests/services/generationServiceReplicaLease.test.ts tests/services/audioSpeechSettings.test.ts tests/components/nodeCriticalInteractions.test.tsx`
- 查询及公共规则：`npx vitest run tests/services/volcengineVideoQuery.test.ts tests/services/pollManager.test.ts tests/services/webSearchService.test.ts tests/services/chat/webTools.test.ts tests/services/projectStyleReference.test.ts tests/services/referenceImageTransport.test.ts`
- 源码和测试类型：`npm run typecheck`、`npm run test:typecheck`；全景依赖入口可在验收环境安装锁文件依赖后运行既有构建。

回滚：恢复本批前端、测试、两个依赖清单及对应文档差异；不修改原生权限、数据库版本、已生成文件和待续任务记录。原生 Cargo/生成 schema 的已有工作区改动不属于本批。

## 保留的边界与暂缓的重构

- 原生公网 IP 纯判断已在第三批 Q36 复用，见文末；[agent/web.rs](../../src-tauri/src/agent/web.rs) 与 [agent/provider_docs.rs](../../src-tauri/src/agent/provider_docs.rs) 的 URL 策略仍不同：普通网页允许 HTTP(S) 标准端口，厂商文档只允许 HTTPS 443。不能整体合并或放松入口限制。
- 插件前端租约、Rust 活动 revision、资源摘要和最终写回检查分别位于不同信任边界；相似检查不能按普通重复逻辑删除。
- `registry.rs`、`pluginRuntime.ts`、`pollManager.ts`、`MentionEditor.tsx` 等大文件适合按稳定职责逐步收口。`registry.rs` 的总行数还包含大量内嵌单元测试，不能直接把文件总行数当作业务逻辑规模或要求一次拆完。
- 依赖导入扫描没有找到完全无人引用的直接运行依赖；这只证明存在引用，不能替代依赖漏洞检查或生产包体积分析。

## React Flow 审查门槛

| 检查项 | 静态结论 |
|---|---|
| Provider 边界 | 画布内容及相关 Hook 位于 `Canvas.tsx:1882` 的 Provider 内；Portal 保留组件上下文 |
| nodeTypes／edgeTypes 稳定性 | 在 `Canvas.tsx:141`、164、173 行的模块作用域定义 |
| 自定义节点与边 memo | 主要节点与边已有 memo；GroupNode 已按 Q10 补齐，性能效果待实测 |
| 重计算与交互回调 | 关键路径使用 selector、缓存、useMemo 与 useCallback；实际热点与收益仍待性能观察 |
| 节点与边更新 | 沿用 Store Action 与不可变更新；批量写入已有 `addNodesWithEdges`，不能为精简改成循环单次写入 |
| data 更新接口 | 本项目以 Zustand 为权威，复用 Store Action；不直接改成 React Flow 自身写入接口 |
| 连线几何 | 已有共享模型、路径与裁剪模块；不建议重新建立第二套几何层 |
| fitView | 使用初始视口选项及显式事件入口，未发现每次 render 都调用的模式；聚焦路径存在 400ms 过渡 |
| 容器、样式与端口 | 画布容器具有尺寸，默认样式已导入，端口使用 Position 常量 |
| 交互隔离与类型 | 主要交互复用 nodrag／nopan 与领域 Props；全组件可访问性及拖拽交互未做实机遍历 |

## 已完成修改与验收入口

文件头处理共 936 个文件：新增 927 处职责或回归用例说明，将 9 处已有说明移到 import 前。第三方与生成文件未改。保留 UTF-8、BOM、原换行方式和脚本 shebang。

最初文件头整理的静态核对确认：移除新增注释、将搬移注释放回原处后，原始文件字节摘要一致，差异空白检查通过。该批只改注释；后续 Q01～Q09 修改与验收缺口见上文。

以下为全仓剩余验收，未执行全仓检查或原生检查；Q01 的定向结果见上文：

1. 在仓库根目录执行 `npm run check`，检查前端 lint、源码与测试类型及现有回归；若出现仓库规则记录的 ESLint 工具链错误，单独记录，不修改依赖绕过。
2. 在 `src-tauri/` 执行 `cargo check --lib`，确认原生源码与构建脚本编译。
3. 使用既有 Tauri 开发入口打开画布、文本／音频节点、资产库、ComfyUI 管理和插件设置；确认页面可打开、交互与原版本一致，文件头不会进入产品显示内容。
4. Q01 继续补齐上述桌面剩余场景，Q02／Q03 按各自步骤执行尺寸、父链与布局验收，Q04 回归项目切换、公共视频播放器、RunningHub 入口与吉祥物加载态，Q05 回归音视频工具栏普通及顺序预设，Q06 回归历史面板筛选、分页及导出，Q07 回归参考媒体准备顺序、取消、失败与预算边界，Q08 回归合同比较、协议导入／编码和安全校验，Q09 回归 ComfyUI 响应／保存、视频释放和文件内容校验；不能用静态核对替代功能验收。

## 建议实施批次

1. **默认模型与几何行为收敛**：Q01 自动回归与部分桌面交互已验证，真实生成等场景仍待验收；Q02 与 Q03 运行时保护已实现、尚未运行测试；归档坏父链的入口策略仍待独立处理，保留源码与测试的独立回退点。
2. **闲置入口与局部重复清理**：Q04 闲置模块与专属样式清理、Q05 音视频工具栏预设执行合并、Q06 历史筛选共享、Q07 参考媒体串行准备共享、Q08 协议基础逻辑收口及 Q09 四组局部重复合并已实现，尚未运行测试。
3. **低收益统一与热点重构**：Q10、Q11 已实现；大模块只有在具体维护需求或性能证据出现时再按职责拆分。

Q01～Q17 的实施范围与验收状态分别见上文；“保留的边界与暂缓的重构”仍为建议，不构成额外架构改动、删除文件、新增依赖或运行测试的授权。

## Q18 局部重复续查与精简（2026-11-06）

状态：两处局部等价清理已实现，完成调用链、差异、UTF-8 和差异空白静态核对；本次未运行测试，待用户验收。未运行 lint、类型检查、构建、性能基准或桌面交互。工作区其他任务的模型适配、计划索引及生成文件不属于本批。

| 源码 | 精简内容 | 保留语义 |
|---|---|---|
| [assetImageDetails.ts](../../src/services/assetImageDetails.ts) | `resolvePromptImageReferences` 内统一三类引用的去重和返回字段构造，净减 25 行 | 资源、角色和节点仍按原分支解析；同 URL 保留首次出现的 ID、名称和位置，缺失引用跳过；指定参考图、动作媒体、历史回退、取消与错误处理沿用原逻辑 |
| [store.config.ts](../../src/store/store.config.ts) | `setProviderKey`、`setProviderUrl` 委托已有 `setProviderConfig`，净减 25 行 | 新连接默认值、空 Key、已有连接其他字段、冻结检查、凭据变更标记、RunningHub 别名及 dirty/revision 继续经过原包装 `set`，每次 Action 仍只更新一次 |

源码合计净减 50 行，含空行；未新增模块、依赖或存储迁移，未调整模块边界。参考图解析的顺序和查找次数、Store 写入次数不变，没有新增网络或磁盘操作；尚不能据此宣称包体积或运行性能已实测改善。

Tauri 桌面验收：

1. 准备包含节点、资产和角色图片引用的测试项目，在资产库打开图片详情与参考图预览。混用三类引用、让同一 URL 重复出现，预期按提示词出现顺序显示且只保留第一项；指定参考图失效不自动替换为主图，已删除节点仍按原历史回退，关闭预览或切换项目后不回填旧结果。
2. 在设置中编辑测试连接的 Key、地址及其他字段，保存并重开应用，核对地址、模型选择和连接身份保持正确；清空 Key 后保存并重开仍为空。回归 RunningHub 站点切换、设置保存失败和凭据不可读提示，不应重复保存或把 Key 写入普通配置。现有自动回归涉及 Key 更新和持久化；两个快捷 Action 的新连接默认值、空值及 URL 更新仍缺直接回归，不能把设置界面验收当作这些入口的直接覆盖。

自动回归供用户在仓库根目录执行：`npx vitest run tests/services/assetImageDetails.test.ts tests/store/config.test.ts tests/services/configSecretStorage.test.ts tests/components/apiKeyDeletionPersistence.test.tsx`；类型检查按需执行 `npm run typecheck` 与 `npm run test:typecheck`。以上命令本批均未运行。

续查的角色动作媒体转换、会话项及视频时长滑条已在下述 Q19 实现，验收状态与 Q18 分开记录。角色声音播放生命周期、Agent Policy 与插件 revision 检查涉及资源所有权、延迟加载或信任边界，继续保留；大文件行数不是删除这些保护的依据。

回滚：仅撤销本批两个源码文件和本节文档差异；无配置、数据库或素材回滚。更早批次与其他任务的改动保留。

## Q19 角色媒体与重复渲染精简（2026-11-06）

状态：三项已实现，新增角色转换的直接回归用例；本次未运行测试，待用户验收。仅完成调用链、源码差异、UTF-8 和差异空白静态核对，未运行 lint、类型检查、构建、性能基准或桌面交互。

| 范围 | 共享实现与保留边界 | 业务源码净减 |
|---|---|---|
| [CharacterAssetDialog.tsx](../../src/components/CharacterAssetDialog.tsx)、[CharacterLibraryPanel.tsx](../../src/components/CharacterLibraryPanel.tsx)、新增 [characterActionMedia.ts](../../src/components/character/characterActionMedia.ts) | 两个入口共用节点转动作素材；视频优先、GIF/MIME、名称回退、素材身份、原始 URL 和 ID 规则保留，ID 直接复用轻量 `store.utils`；不引入 Store 运行时 | 62 行 |
| [ConversationList.tsx](../../src/components/chat/ConversationList.tsx) | 置顶与普通会话共用普通渲染函数，保留 `ConversationItem` 类型、key、Fragment、AnimatePresence、订阅与事件回调 | 15 行 |
| [VideoParamSelector.tsx](../../src/components/nodes/shared/VideoParamSelector.tsx) | 两份滑条共用普通渲染函数；input 和填充仍使用夹取后的值，刻度按各入口原值激活，未指定时长仍为 0% 填充且无激活刻度 | 22 行 |

业务源码合计净减 99 行，含新增共享文件及空行；与 Q18 累计净减 149 行。数字不含回归和文档，不代表生产包体积或实测性能收益。未增加依赖、持久化字段、原生命令、网络/磁盘操作或 Store 订阅，也未改动其他任务的模型协议文件。

时间戳统一在有效媒体完成类型识别、构造结果前采样一次；保留 `createdAt === updatedAt`，无媒体不读取时钟或生成 ID。角色收录弹窗原先在同步解析开始时采样，现在与角色库同样在构造结果前采样。角色库筛选仍使用原来的转换调用，未顺带改变临时 ID 分配或绑定流程。

新增 [characterActionMedia.test.ts](../../tests/components/characterActionMedia.test.ts) 覆盖缺失节点/媒体、视频优先及文件名/路径/URL 扩展名顺序、GIF 与 data MIME、来源身份和 URL 原样保留、名称与缩略图回退、单次 ID/取时及不修改输入；尚未执行。会话列表本批没有新增直接交互回归，视频沿用现有组件回归，不能用静态核对替代桌面验收。

Tauri 桌面验收（使用测试项目、已有角色、图片/GIF/视频节点、至少两条会话及可配置的视频模型，不必发起模型生成）：

1. 分别通过节点角色收录弹窗的「动作素材 → 添加到动作库」和角色库已有动作的画布节点选择入口绑定同一组图片、GIF、视频；预期类型、名称、预览、重复提示及添加后隐藏节点保持原行为，保存重开后仍可用。回归仅有缩略图、没有媒体、已删除节点、取消选择及切换项目不写入旧目标。
2. 在助手列表操作置顶与普通会话的选择、重命名、取消置顶、搜索、归档和删除，预期当前项、任务状态与编辑状态正确；主窗口和独立窗口分别检查，动画与减少动态效果下层级不变。
3. 在视频参数中分别检查通用模型「模型默认」、有界时长滑条及 ComfyUI/RunningHub 旧节点的帧数/FPS 换算；未指定时长不误显示为已选，拖动/点刻度后按原秒数更新，切换 FPS 不改变已确认秒数。回归最小/最大值、旧越界值、禁用状态、失焦保存及深浅主题。

自动回归供用户在仓库根目录执行：`npx vitest run tests/components/characterActionMedia.test.ts tests/store/dramaAssets.test.ts tests/services/dramaMentionPick.test.ts tests/components/videoParamSelectorProtocol.test.ts`；类型检查按需执行 `npm run typecheck` 与 `npm run test:typecheck`。以上命令本批均未运行。

回滚：仅撤销上述五个业务源码文件、本批新增回归及本节文档差异；不回退 Q18 或其他任务的改动，无数据迁移需要回滚。

## 2026-11-06 续查：Q20～Q25

以下是 2026-11-06 的实施与审查快照。后续 Q23 已在第一批、Q25 已在第二批实现；当前剩余项与保留理由见文末第四批核对，不以本节旧状态重新派工。

状态：Q20～Q22 已实现并补回归，Q23～Q25 仍为审查候选。已完成源码、引用、UTF-8 和差异空白静态核对；本次未运行测试，待用户验收。未运行 lint、类型检查、构建、性能基准或桌面实测。模型、Agent、生成执行器及发布准备的并行工作区改动未纳入本批。以下业务源码净减均扣除共享实现，不计测试和文档，不代表包体积或实测性能收益；未实现条目仍为估算。

| 条目 | 当前证据与最小业务文件范围 | 业务源码净减 | 状态与建议 |
|---|---|---|---|
| Q20 角色查找 | [store.dramaAssets.ts:70](../../src/store/store.dramaAssets.ts#L70) 的私有纯函数复用 14 处作用域/ID 查找；仅此文件 | 33 行 | 已实现，待用户验收 |
| Q21 图片保存 | [ImageNode.tsx:339](../../src/components/nodes/ImageNode.tsx#L339) 的共享保存流程供裁切与合成的两个稳定回调使用；仅此文件 | 49 行 | 已实现，待用户验收 |
| Q22 数据库键游标删除 | [indexedDbService.ts:731](../../src/services/indexedDbService.ts#L731) 的私有循环复用六个函数的 10 组键游标删除；仅此文件 | 43 行 | 已实现，待用户验收 |
| Q23 旧截图辅助 | [projectSnapshotService.ts:23](../../src/services/projectSnapshotService.ts#L23)、[:94](../../src/services/projectSnapshotService.ts#L94) 的旧过滤表、过滤函数和同步编码函数，仅旧测试引用；业务仅此文件，另调整对应测试 | 约 35 行 | 可清理，先核对兼容约定 |
| Q24 视频窗口发送 | [videoEditorWindowService.ts:299](../../src/services/videoEditorWindowService.ts#L299) 起七个发送方法重复导入、事件目标及 envelope；仅此文件 | 约 15～30 行 | 次优先，收益有限 |
| Q25 手工选区删除 | [useCanvasContextMenu.ts:198](../../src/hooks/useCanvasContextMenu.ts#L198)、[useKeyboardShortcuts.ts:288](../../src/hooks/useKeyboardShortcuts.ts#L288) 重复删除编排，拟归入 [store.nodes.ts](../../src/store/store.nodes.ts)；三个文件 | 纯去重约 30～40 行；修复后的实际值待定 | 单独设计，中风险 |

Q20～Q22 本批业务源码实际净减 125 行，含空行及私有共享实现；修改三个业务文件、三个现有回归文件与本文，没有新增模块、依赖、数据库版本或持久化字段。具体边界：

- Q20 只共享纯查找，接收原调用位置取得的 Store 快照，不缓存角色或改变 `get()`/`state` 的采样点。参考图、头像、声音、动作及来源节点 Action 的保存、取消和派生守卫继续由各调用方负责。`tests/store/dramaAssets.test.ts` 新增四个参数化场景，覆盖同 ID 项目/全局角色分别编辑、从正确库生成声音节点，以及目标作用域缺失时不跨库保存或创建节点；尚未执行。
- Q21 保留两个稳定回调入口和独立 pending ref，只合并保存函数；文件命名、提示文案、`ensureFresh`、`clearPending`、历史提交与完成/取消顺序不变。扩图另有模型请求、进度和失败合同，不并入。`tests/components/nodeCriticalInteractions.test.tsx` 原裁切用例复用为两种操作共 12 个参数化场景，调用真实组件的 `onStart/onSave` 与派生守卫，覆盖保存/尺寸读取期间过期、两阶段异常、普通/默认项目、命名、元数据优先和回填/历史/提示顺序；尚未执行。空结果、保存返回 null、新旧 ref 交错、两操作并行及真实跨渲染回调身份仍未直接覆盖，不能将静态一致性当作实测通过。
- Q22 只共享 `onsuccess` 内的 `store.delete(cursor.primaryKey)` 与 `cursor.continue()`，保留原 request、事务、索引范围、错误与终态处理。范围为 `deleteProjectFromDb` 的五组循环，以及 `clearAllHistoryEntries`、`deleteNodeHistoryEntries`、`deleteConversationMessages`、`permanentlyDeleteConversation`、`deleteProjectMemories` 各一组。不覆盖 `pruneProjectHistory` 的保留区跳跃或 AgentTask 删除的 MCP 墓碑写入。原有键游标、作用域隔离与事务中止回滚用例保持；`tests/services/imageGenerationHistory.test.ts` 新增两个参数化场景，确认空范围连续清理完成且不影响现有项目/节点记录；尚未执行。

Q23 的实际入口是 `store.projects.ts → captureCurrentCanvasSnapshot → projectSnapshotWorker.ts`。旧 `shouldIncludeProjectSnapshotNode`、`encodeProjectSnapshot` 及专属常量只供 `tests/services/projectSnapshotService.test.ts` 的旧用例使用；删除时保留同模块仍在使用的数据 URL 校验、矩形换算及 Worker/媒体/几何回归。源码明确保留过兼容语义，因此先核对当前调用和兼容用途，不能仅凭函数较旧就删。预计另可减少约 40 行专属旧测试。

Q24 必须保留“先动态导入 event，再构造/浅拷贝 payload”的时机。直接把预构造 message 传入 helper 会提前读取 `result/request`，不能当作严格等价；可用内部消息构造回调保留时序，并固定主窗口/编辑器的事件配对，继续透传导入与发送错误。保留七个语义化导出，不新增任意窗口目标或通用消息入口。现有 `tests/services/videoEditorWindowService.test.ts` 需补 ready、模型列表请求、AI 转场请求、发送失败及等待导入期间修改输入的时序用例。

Q25 是修复行为分叉伴随精简，不能直接调用现有 `deleteNodesBatch`：

> 2026-11-15 复核：下述“Hook 只保留顶层 filePath”的问题已不适用于当前源码；两个 Hook 已共用 `collectKeepPaths` 和 `createNodeFileDeletionContext`。本项尚存的删除编排、组裁剪及异步写回问题以文末复查为准，不再把已解决的引用保护重复列为待实施。

- 两 Hook 仅保留存活节点顶层 `filePath`，Store 的 `collectKeepPaths` 还保护宫格、分镜、导演台和聊天产物引用，并排除 `artifactId` 节点文件。Hook 可能将仍被这些位置引用的同项目文件移入撤销暂存区；这是静态风险，尚未复现，底层项目归属校验仍在。
- Hook 不处理删除最后成员后的空组及 `data.groupId` 映射，Store 的 `pruneDeletedNodesAndEmptyGroups` 会处理，同时保留手工空组，文件清理也会暂存对应组目录。
- 既有批量 API 只取前 50 个显式根节点，不处理独立选中边，且选择清空与历史提交时机不同。应单独设计手工选区删除 Action，保留完整节点/边选择、即时清选择及一次撤销，批量 API 的限额继续保留。

Q25 现有下游回归为 `tests/store/history.test.ts`、`tests/services/gridAssetRoundTrip.test.ts` 和 `tests/services/fsTrash.test.ts`；两个 Hook 需补直接入口回归。桌面必须覆盖超过 50 节点、纯边/混合选择、组后代/最后成员、手工空组、共享素材、连续删除、动画期间切项目和一次撤销。

继续暂缓：角色声音播放的状态归属与 Effect 清理依赖不同，保留差异后只约净减 20～30 行且缺直接回归；ComfyUI 图片/音频/视频的待恢复状态、视频暂停和 finally 身份清理不同，整段统一会增加可变上下文；跨库复制合并只约净减 15～22 行。本轮扫描未发现足以支持再批量删除大模块的确定证据。

### Q20～Q22 验收与回滚

Tauri 桌面验收前准备测试项目、项目与全局各一份角色、可编辑图片、两份含历史/会话/记忆数据的测试项目；涉及永久删除时先导出备份。按以下顺序验收：

1. 分别在项目/全局角色库追加参考图、设头像、添加/编辑/移除声音与动作，再从参考图/声音创建画布节点。预期编辑与媒体来源属于所选库，另一库保留原内容；保存重开后仍正确。角色已删除时操作应按原方式提示或拒绝，不借用另一库。
2. 对同一图片分别裁切与合成，确认仍创建独立结果节点，原图不被覆盖，结果文件名、像素尺寸、显示尺寸和完成提示正确；保存重开、撤销/重做仍可用。分别取消、在处理中切项目或删除源节点/占位节点，迟到结果不得写回其他项目；用可控保存/测量失败核对占位清理和失败提示，过期操作不显示成功。扩图入口继续按原行为工作。
3. 分别清理节点历史、项目历史、删除会话/消息/项目记忆及测试项目，预期只清目标范围，另一个项目与会话的数据仍可读；空范围连续清理正常完成，项目删除仍清理其关联数据。事务中止与失败回滚、MCP 墓碑及历史保留区优先由现有自动回归覆盖，不通过 UI 测试伪造通过结论。

自动回归供用户在仓库根目录执行：`npx vitest run tests/store/dramaAssets.test.ts tests/components/nodeCriticalInteractions.test.tsx tests/services/chatMessageSequence.test.ts tests/services/imageGenerationHistory.test.ts`；按需执行 `npm run typecheck` 与 `npm run test:typecheck`。以上命令本批均未运行，桌面功能与性能仍待用户验收。

回滚仅撤销本批三个业务文件、三个回归文件以及本文 Q20～Q22 状态差异；无数据迁移，不回退 Q18/Q19、Q23～Q25 审查或并行发布准备的改动。此处 Q23～Q25 为当时未实施项，后续结果见文末。

## 2026-11-15 全仓业务精简复查

审查时状态：静态审查完成，以下为实施前快照；当时未修改业务源码，未运行测试、lint、类型检查、构建、性能基准、桌面验收或模型调用。基线 `e2023a8b`，审查开始时工作区干净。各批后续实现与剩余项核对见文末。目标是保留现有业务能力、减少重复维护；源码行数、打包体积和运行速度分别衡量，不把删除行数当作性能证明。

审查期间另有发版工作流、工程脚本、相关规则和发布文档的并行改动出现；本任务仅修改本文及计划索引，保留其他改动。清点是审查时快照，发版流程后续差异不作为本轮去重结论或验收证据。

### 覆盖与主要结论

- 清点 Git 跟踪的 TS/TSX/JS/JSX/MJS/Rust/Python/CSS：`src/` 1,355 个文件、373,159 行，`src-tauri/src/` 92 个文件、66,217 行，工程脚本 17 个文件、2,721 行；另清点 798 个测试文件、199,788 行及工作流、依赖配置。均为物理行，包含空行、注释、内嵌测试和数据，不等于业务有效代码量。
- 对非第三方、非翻译、非样式的源码做跨文件连续片段比对；对服务、Store、工具函数用 TypeScript AST 比对函数体；核对本地导入、动态导入及 Worker URL，再人工跟踪下列候选的调用链。样式核对相关公共类与实际组件，未做全仓动态 class 可达性证明。
- `src/services/` 149,150 行、组件 121,630 行、Store 15,421 行是主要维护面；翻译 24,885 行、第三方源码 11,502 行单列保留。大文件只是定位线索，不以拆文件、压行、批量 memo 或删除翻译作为精简成果。
- 最值得处理的是节点新建/删除的行为分叉、同领域纯映射、已有公共函数未复用及重复目录数据。没有找到足够证据支持大批删除模块或直接移除大型依赖。
- 这是全仓静态扫描加重点调用链复核，未逐行人工证明全部源码，也未验证运行时性能、真实模型、跨平台编译或所有外部插件。各条“确认”指源码证据，不代表运行验收。

### 先处理两处行为分叉

**Q26：新建节点默认数据仍有六套入口。** [NodeMenu.tsx:99](../../src/components/NodeMenu.tsx#L99)、[Sidebar.tsx:133](../../src/components/Sidebar.tsx#L133)、[右键:77](../../src/hooks/useCanvasContextMenu.ts#L77)、[快捷键:47](../../src/hooks/useKeyboardShortcuts.ts#L47)、[连线新建:259](../../src/hooks/useConnectionDropMenu.ts#L259)、[双击:43](../../src/hooks/useNodeCreation.ts#L43) 各自拼装初始 data。音频在前两个入口为 280×160，部分其他入口为 260×140；全景 `previewMode` 等字段也有差异。Q01 已共享模型偏好读取，这里是剩余的节点初始数据，不能再把偏好收口算作新成果。

建议仅共享纯 UI 初始数据构造，复用 `getPreferredNodeModel` 和现有 Store 插入路径；定位、连边、入口交互及一次历史提交留在原调用方。先列出每个字段差异，确需保留的入口差异显式覆盖，不在精简时静默统一尺寸。Agent/MCP 显式模型授权、源素材导入和插件节点构造继续走各自合同。估计净减 120～200 行，与 Q27 有重叠，最终只按实际差异计数。

**Q25 复核：四处删除流程仍重复，重点已转为 Store 收口和过期保护。** [右键删除:199](../../src/hooks/useCanvasContextMenu.ts#L199)、[键盘删除:286](../../src/hooks/useKeyboardShortcuts.ts#L286)、[单点 Action:1561](../../src/store/store.nodes.ts#L1561)、[批量 Action:1592](../../src/store/store.nodes.ts#L1592) 仍各自组织后代展开、停轮询、文件暂存、历史与退出动画。两个 Hook 已共享文件保留路径和删除上下文，但仍直接 `useAppStore.setState` 裁剪组；Store 则使用 `pruneDeletedNodesAndEmptyGroups`，规则不同。

四处动画完成回调未见对启动时项目/画布版本的最终复核，旧删除可能对动画结束时的当前状态生效；切项目、导入复用 ID、撤销/重做的影响仍须复现。这是静态风险，不能宣称已复现数据丢失。建议在 Store 增加手工选区删除 Action，内部共享编排并校验操作归属/失效状态，Hook 只提交选区；保留纯边、混合选择、即时清选择及一次撤销。不能直接改调有 50 个根节点限额的 `deleteNodesBatch`，也不能让正常版本变化误取消合法删除。预计纯收敛约 70～110 行，增加必要守卫后实际净减可能更小。

### 新增精简清单

下表行号均为本轮基线；所有行数是扣除拟新增共享代码后的估计，不包含测试/文档。优先级表示实施顺序，安全相关项即使代码很短也须单独验收。

| 编号/顺序 | 真实重复与合并方向 | 收益及必须保留的边界 |
|---|---|---|
| Q27 第一批 | [useNodeCreation.ts:64/92/116](../../src/hooks/useNodeCreation.ts#L64) 的 `addImageNode/addVideoNode/addAudioNode` 没有生产调用；[Canvas.tsx:825](../../src/components/Canvas.tsx#L825) 只取拖放/双击入口。删三方法及返回属性 | 约 78 行；音频方法仅有旧偏好测试，需将断言移至真实入口；保留拖放、原生导入及双击。与 Q26 不重复累计 |
| Q28 第一/二批 | [TextNodeToolbar.tsx:64](../../src/components/nodes/shared/TextNodeToolbar.tsx#L64) 的预设执行委托现有 [executeToolbarPreset:243](../../src/components/nodes/shared/toolbar/presetAction.ts#L243)；五种工具栏的 zone/button/more/divider 展示循环随后共享 | 两部分合计约 65～100 行；文本先接已有函数，布局另做小提交。保留编辑态、隐藏项、插件/图片历史弹窗；全景当前没有相同顺序预设分支，不直接套用 |
| Q29 第一批 | [imageParameterMappings.ts:79](../../src/services/ai/imageParameterMappings.ts#L79)、[audioParameterMappings.ts:66](../../src/services/ai/audioParameterMappings.ts#L66)、[videoParameterMappings.ts:50](../../src/services/ai/videoParameterMappings.ts#L50) 的字段复制循环同构 | 约 15～25 行，仅共享已解析 mapping 到输出的纯循环；各领域 resolver/键类型/静态字段保留。`false/0` 保留，`null/undefined/空字符串/空数组` 排除；不合并完整生成器 |
| Q30 第一批 | [runninghubModelManifest.ts:245](../../src/services/ai/providers/runninghubModelManifest.ts#L245) 等多组完整 `parameters` 数组完全相同，抽命名参数组并为每模型复制 | 文件 478,227 字节；301 个可直接解析条目中有 31 组重复，按紧凑 JSON 计多余参数文本 36,052 字节，尚未扣提取开销。保守估计净减约 25～30KB；不是打包收益。保留全部 347 个端点顺序/字段和独立可变引用 |
| Q31 第二批 | [agentRoundExecutor.ts:1197](../../src/services/chat/agentRoundExecutor.ts#L1197) 与 [agentToolExecution.ts:128](../../src/services/chat/agentToolExecution.ts#L128) 重复 Policy 决策事件、指标及步骤记录 | 约 70～110 行，只共享记录、步骤构造和审批结果更新；模式采样、Policy 计算、审批等待、取消、授权后二次核对、检查点和真实执行继续由各入口负责；不能用一个万能执行器替代两条生命周期 |
| Q32 顺手/暂缓 | [pluginResourceService.ts:201/237](../../src/services/plugins/pluginResourceService.ts#L201) 的普通资源和包资源 lease 重复登记调用身份 | 仅约 10～15 行，限同模块私有登记函数，不值得单建抽象层；路径/mtime/source 与 packageResourceId/SHA256 分支保持独立。上下文检查、双摘要、调用/项目/节点/版本绑定及读取时复核都保留 |
| Q33 原生专批 | [path_policy.rs:327/336](../../src-tauri/src/path_policy.rs#L327) 已有 `is_link_or_reparse`；插件 registry/artifacts、原生媒体、缩略图、Comfy 安装/去重、Blender 等至少 11 处仍有等价本地函数 | 约 85～115 行，直接复用现有函数；各调用方的目录链、授权、私有目录、文件身份及业务错误全部保留，不把判定函数当完整路径授权 |
| Q34 原生专批 | [path_policy.rs:169/174/187](../../src-tauri/src/path_policy.rs#L169) 已有转换；[package.rs:194](../../src-tauri/src/agent/package.rs#L194)、[registry.rs:1635](../../src-tauri/src/plugins/registry.rs#L1635)、[installation.rs:43](../../src-tauri/src/media/comfyui/installation.rs#L43)、[installer.rs:106](../../src-tauri/src/media/comfyui/installer.rs#L106)、[runner.rs:1371](../../src-tauri/src/director/blender_runtime/runner.rs#L1371) 重复 verbatim/UNC 处理 | 约 45～60 行；复用纯路径转换。canonicalize 失败时回退原路径、组件路径或报错的不同合同不能一并改掉 |
| Q35 原生专批 | [muse.rs:89](../../src-tauri/src/media/muse.rs#L89)、[volcengine_tos.rs:188](../../src-tauri/src/media/volcengine_tos.rs#L188)、[media_source.rs:101](../../src-tauri/src/media/comfyui/media_source.rs#L101)、[sync.rs:9](../../src-tauri/src/files/object_storage/sync.rs#L9) 四套系统安全随机数读取 | 约 35～50 行；共享底层字节读取，各业务保留包装和错误映射。Muse/TOS 24 字节、Comfy/S3 32 字节及 UUID 格式保持；随机源失败继续拒绝，不以弱随机兜底 |
| Q36 后续 | [web.rs:323/350/364/446](../../src-tauri/src/agent/web.rs#L323) 与 [provider_docs.rs:55/72/86/278](../../src-tauri/src/agent/provider_docs.rs#L55) 重复公网 IP 和同源纯判定 | 约 40～55 行；优先复用已有 `web::is_disallowed_ip`。保留 URL/端口、DNS 混合记录、重定向和 fake-IP 策略差异，不合并完整读取器 |
| Q37 后续，中风险 | [codex_process.rs:14](../../src-tauri/src/agent/codex_process.rs#L14)、[plugins/runtime.rs:232](../../src-tauri/src/plugins/runtime.rs#L232)、[management.rs:344](../../src-tauri/src/media/comfyui/management.rs#L344) 三份 Windows Job Object 创建/绑定/终止/释放 | 约 50～75 行；仅提取底层句柄。各运行时可执行文件身份、启动参数、输出上限、取消/超时和进程树回收时序独立。Blender suspended-start 不纳入 |
| Q38 顺手处理 | [Blender job.rs:1216/1231](../../src-tauri/src/director/blender_runtime/job.rs#L1216) 与 [result.rs:217/230](../../src-tauri/src/director/blender_runtime/result.rs#L217) 的 SHA256 和 scene ID 纯校验 | 约 15～25 行，领域内部复用即可；一般 opaque ID 可接受大写/冒号，继续独立，不建立通用验证框架 |
| Q39 后续，中风险 | [chatWindowService.ts:641/672/709](../../src/services/chat/chatWindowService.ts#L641) 三套请求等待中的 Promise、settled 防重、超时、listener 安装/释放与发送编排 | 约 20～35 行，限同文件私有等待器。保留各自响应身份、20/30 秒超时、返回值/抛错、文本上限与 windowFrame；listener 安装完成后再发送，晚装监听须释放，超时不得自动重投 |

Q28 布局证据为 `AudioNodeToolbar.tsx:148`、`VideoNodeToolbar.tsx:182`、`PanoramaNodeToolbar.tsx:106`、`TextNodeToolbar.tsx:143` 及 `shared/image/ImageNodeToolbar.tsx:347`，均位于 `src/components/nodes/shared/`。只共享展示循环，继续使用 UI Kit 和既有工具栏配置，不再造工具栏框架。

Q30 样例：speech 的 245/246/250 行、mureka 的 346/348/349 行、youchuan 的 195/229 行、wan3 的 386/388 行。统计未包含 46 个含模板函数的条目，也不意味着其余相似字段可强行共享。仓内未找到该快照的生成器，当前 manifest 是共享权威；已存在 [完整目录 SHA256 回归](../../tests/services/runninghubModelManifest.test.ts#L14) 和独立枚举副本断言。提取后最终序列化目录必须保持原摘要，不能更新基线来掩盖行为变化。

### 旧候选与暂缓项

本小节保留复查时的候选依据；Q23 已完成，其他条目以文末第四批核对为当前状态。

- **Q23 仍成立**：`projectSnapshotService.ts:23/30/44/94/102` 的旧过滤表、DOM 过滤和同步编码只被旧测试使用；实际入口走 Worker。可删约 35 行业务及相应旧专属测试，保留数据 URL 校验、几何/媒体装载与 Worker 回归。
- **Q24 仍为小收益候选**：视频窗口发送 envelope 可在同模块共享，估计 15～30 行；保持先 await 动态导入 event、后构造 payload 的时机，保留语义化导出及固定窗口/事件对，不扩展任意目标消息入口。
- 资产搜索窗与主侧栏的标签/分类查询约可减 10～25 行、添加菜单约 15～25 行，但两个窗口的配置保存和加载所有权不同。已有 `AssetThumb` 与视频预览 Hook，后续只顺手复用纯函数/小菜单，不合并整个资产窗口。
- Aigcsi 与 Relayon 的目录匹配函数体相同，但仅约十行，闭包各自绑定已核对目录；IDB request Promise 包装和存储 CRUD 日志包装也重复但收益有限。先不新增跨模块框架；尤其 `loadPresets` 抛错而 `loadSkills/loadStyles` 降级空列表，不能按外观相似合并错误合同。
- 没有入边的 `projectRepository.ts`、`projectModelMigration.ts` 仍承担旧源只读/备份准备和演练；`projectModelFixtureHost.ts` 是隔离夹具入口。`scripts/project-model-boundaries.json` 记录其保留/移除条件，不能据生产导入数为零直接删除。`videoEditor/rulerTicks.ts` 只是两行兼容重导出，收益不足。
- 新旧项目库和 v3/v4 交换路径继续保留，正式迁移仍关闭；目前只共享同一合同的纯逻辑，不以精简为由启用迁移、删旧库或合并恢复流程。现行数据库版本以源码为准，旧规则中的 v22 已落后于 `indexedDb/schema.ts` 的 v27。
- 网页与厂商文档的 DNS 混合记录处理不同；Blender 先挂起创建、绑定 Job 后恢复线程；归档/凭据/S3 各有耐久和原子发布合同。上述差异是业务和安全边界，保留。
- 原生大型依赖均发现实际调用；动画库也没有“只因用了两种动画工具就能删其中一种”的证据。CI 已使用平台矩阵，不为合并 checkout/setup 片段改动正式发布门禁。

### 分批实施与验收

1. **第一批，直接删除和已有实现复用**：Q23、Q27、Q28 的文本预设部分、Q29、Q30；每项独立提交，保留行为和目录摘要。先迁移真实入口回归再删只验证旧方法的用例。Q30 只做数据提取，不顺带更新厂商目录。
2. **第二批，节点与 Agent 收敛**：Q26、Q25 分别实施，随后 Q28 布局、Q31、Q39；Q32 收益小，等相关功能修改时顺手处理。两个行为分叉优先安排设计与验收；新增共享函数先限定在所属领域，避免新的“万能服务”。
3. **第三批，原生基础件**：Q33～Q35 各做最小替换，完成静态收敛后再做 Q36～Q38；实现结果与剩余验收见文末。需要重新编译桌面端并在相关系统验收，Web 展示不能替代。

每批从独立测试项目开始；删除/归档/恢复前先导出备份，准备普通项目、剧集多画布、共享素材及至少两个可切换项目。以下为实施后的验收要求，不是已执行结果；各批实现状态见文末：

| 范围 | 操作顺序及预期 | 异常与回归 |
|---|---|---|
| 新建/清理/缩略图 | 依次通过浮动菜单、侧栏、右键、数字快捷键、连线、双击及拖放创建；模型身份/参数与明确的尺寸合同一致，单节点新建保持一次撤销，批量导入保留既有历史粒度；保存重开能恢复 Worker 缩略图 | 源素材不误绑模型，取消拖放无写入；缩略图 Worker/媒体失败沿用降级；删三闲置方法不影响真实拖放 |
| 选区删除 | 单节点、纯边、混合、超过 50 节点、组后代、最后成员与手工空组依次删除；每次一次撤销/重做，存活引用和共享文件保留 | 连续 Delete、生成中删除、动画期间切项目/撤销/导入同 ID；旧完成回调不得影响新状态，文件暂存/恢复合同保留 |
| 工具栏/参数/目录 | 五种工具栏检查长按编辑、zone 顺序、更多菜单、插件/历史弹窗；模型参数切换检查必填、枚举、默认值；347 项目录最终 JSON 摘要不变 | `0/false` 不丢失，空值过滤一致；顺序预设取消、目标删除/切项目不触发迟到生成；深浅主题与减少动态效果正常；真实生成另按授权执行 |
| Agent/插件 | 在 Plan/B/C 和 MCP 入口分别检查允许、拒绝、待确认、取消；事件/指标/步骤恰好一次；插件项目资源和包资源都可按原授权读取 | 变更模式、审批期间切项目、停用/更新插件、双摘要变化、invocation 过期必须拒绝，错误资源不跨版本回写；确认策略不变 |
| 独立助手等待器 | 独立助手发送、收回/关闭、回读团队产物及受管理操作，核对同请求只完成一次，原返回值与错误保持 | 主窗口关闭、切项目、延迟安装 listener、超时、身份不匹配及迟到 ACK 不完成其他请求；保留草稿和未确认提示，不自动重投 |
| 原生路径/随机数 | AgentPackage 导入、插件安装、缩略图、Comfy 目录、Muse 会话、TOS/S3 授权依次检查；普通/UNC 路径及原身份格式保持 | 链接/reparse/私有目录仍拒绝；缺文件与 canonicalize 失败错误保持；随机源失败拒绝，业务令牌不能互换；跨平台分别验收 |
| 后续原生项 | 网页/文档分别读取并检查同源跳转；Codex/Python/Comfy 正常退出、取消、超时及应用退出；Blender 合法 scene ID/摘要成功 | localhost、mapped IPv6、fake-IP、混合 DNS、跨源跳转维持原策略；绑定失败回收子进程；Blender suspended-start 和一般 opaque ID 合同独立 |

已有定向回归入口供后续实施复用；若用户授权执行，在仓库根目录运行以下对应批次命令，本轮均未运行：

```powershell
npx vitest run tests/services/projectSnapshotService.test.ts tests/hooks/useNodeCreation.test.tsx tests/components/nodeMenuModelPreferences.test.tsx tests/services/mediaParameterMappings.test.ts tests/services/runninghubModelManifest.test.ts
npx vitest run tests/store/history.test.ts tests/services/gridAssetRoundTrip.test.ts tests/services/fsTrash.test.ts tests/services/videoEditorWindowService.test.ts
npx vitest run tests/services/chat/agentToolExecution.test.ts tests/services/chat/agentRoundExecutor.test.ts tests/services/pluginResourceService.test.ts
```

现有下游用例不能替代六种新建入口、两个删除 Hook 的直接回归；实施时需补其调用时序和过期场景。Rust 检查与三平台桌面验收须按实际改动范围另行授权，不因列出建议命令就自动执行。

回滚按批撤销代码与对应回归，不改数据库/归档格式、不清旧数据。只保留实际 diff、行为变化和验收缺口；完成后回填每项净减及验证结果，不以本轮估计提前记为完成。

## 2026-11-15 第一批实施结果

状态：用户已确认按方案实施第一批并保留原有功能，五项已完成源码修改和静态复核，并按后续要求本地提交；本次未运行测试，待用户验收。未运行 lint、类型检查、构建、性能基准、Tauri 或模型调用，未推送。第二批的默认数据/删除流程、工具栏布局及全部原生项尚未纳入本次提交。

### 完整文件范围与实际变化

业务源码共 8 个文件；下表相对本批改动前计算，包含新增共享函数，不含测试/文档。字节统一按 UTF-8、LF 换行统计，避免工作区 CRLF 与 Git LF 的差异影响比较。

| 项目 | 业务文件 | 已实现内容与净变化 |
|---|---|---|
| Q23 | [projectSnapshotService.ts](../../src/services/projectSnapshotService.ts) | 删除旧 DOM 过滤表、同步编码及两个无生产消费者的导出，净减 35 行；保留 `captureCurrentCanvasSnapshot`、Worker 编码、媒体读取与失败降级 |
| Q27 | [useNodeCreation.ts](../../src/hooks/useNodeCreation.ts) | 删除仅暴露但生产未调用的 `addImageNode/addVideoNode/addAudioNode` 及返回属性，净减 79 行；双击、浏览器/原生拖放及其历史粒度保持 |
| Q28 文本部分 | [TextNodeToolbar.tsx](../../src/components/nodes/shared/TextNodeToolbar.tsx) | 预设执行委托已有 `executeToolbarPreset`，净减 16 行；保留事件拦截、点击时读最新节点/预设、顺序预设优先和节点/边/生成顺序；布局未改 |
| Q29 | [imageParameterMappings.ts](../../src/services/ai/imageParameterMappings.ts)、[audioParameterMappings.ts](../../src/services/ai/audioParameterMappings.ts)、[videoParameterMappings.ts](../../src/services/ai/videoParameterMappings.ts)、新增 [parameterMappings.ts](../../src/services/ai/parameterMappings.ts) | 三种媒体保留领域解析器/类型/配置表，只共享字段复制循环；合计净减 7 行。保留 `0/false`、空值过滤、静态值覆盖和数组引用，未引入通用生成器 |
| Q30 | [runninghubModelManifest.ts](../../src/services/ai/providers/runninghubModelManifest.ts) | 31 组完全相同参数以纯字面量工厂复用，64 个端点各自创建独立嵌套对象，不额外保存可变模板数组或引入克隆步骤；净减 30,362 字节，行数增加 33 行 |

业务合计净减 **104 行、35,702 字节**；其中 Q30 是目录数据文本去重，不能用行数衡量收益。没有新增依赖、原生命令或持久化字段，没有迁移或删除用户数据；没有性能或包体积实测结论。

另修改现有 5 个回归文件，合计行数不变：

- [projectSnapshotService.test.ts](../../tests/services/projectSnapshotService.test.ts)：删除三个只验证旧辅助的用例和专属桩，保留 26 个有效用例，包括真实 Worker 编码预算、WebKit 降级、媒体与几何。
- [useNodeCreation.test.tsx](../../tests/hooks/useNodeCreation.test.tsx)：文本偏好改走实际双击入口，源媒体不绑定历史模型的断言迁到 PNG/MP4/MP3 原生拖放；真实菜单音频偏好已有 `nodeMenuModelPreferences.test.tsx` 覆盖，未重复新增。
- [presetNodeWorkflow.test.ts](../../tests/components/presetNodeWorkflow.test.ts)：共享执行器的四类既有场景扩展至 `ai-text`；保留源引用、顺序预设、过期来源/预设和派生参数断言。
- [mediaParameterMappings.test.ts](../../tests/services/mediaParameterMappings.test.ts)：补三类媒体 `0/false` 与空值、动态值覆盖静态默认且不污染默认、参考数组身份回归。
- [runninghubModelManifest.test.ts](../../tests/services/runninghubModelManifest.test.ts)：保留完整 347 项合同原 SHA-256 基线，新增参数及嵌套对象跨端点独立性的递归回归。

文档只更新本文和 [计划索引](./计划索引.md)。本批共 8 个业务文件、5 个现有回归文件及 2 个文档；工作区其他发版流程和规则改动保留。

### 静态结论与验收缺口

已核对删去方法/导出的生产消费者、文本工具栏与共享预设的调用顺序、参数复制条件、差异空白及 UTF-8/BOM。Q30 将工厂调用在源文本中替回原字面量后，与改动前源码在换行统一后完全一致，347 端点顺序、其他字段及 46 条原模板表达式未改；这属于源码差异核对，**没有执行目录导入或哈希断言**。文本工具栏组件到执行器的委托也只有源码证据，没有运行真实点击验收。

Tauri 桌面验收请准备独立测试项目、有效文本/音频模型偏好、本地 PNG/MP4/MP3、普通及顺序文本预设、RunningHub 配置；按以下顺序操作：

1. 双击画布创建文本，再通过已有菜单创建图片/视频/音频，核对实际模型绑定与原参数；拖入三种本地媒体，预期仍为 source，不被历史模型自动绑定。回归取消、复制失败、复制期间切项目，以及单节点撤销/重做；多文件导入保持原历史粒度。
2. 在文本节点执行普通、自定义及顺序预设，预期读取最新提示词/预设，派生节点带原来源 `@` 引用，节点与边共同撤销；顺序预设先进入原编排。编辑/清空预设、删除来源后不应借旧闭包执行；真实模型提交会计费，按需单独验收。
3. 在项目库检查含图片、文字和分镜的画布缩略图，切换画布、保存重开；正常显示，跨域/Comfy 图片失败与 Worker 不可用继续沿原路径降级，不影响保存。
4. 检查图片/视频/音频参数：`0/false`、空输入、参考媒体、透明 PNG 与音乐默认值按原合同处理；切换 RunningHub speech、mureka、wan3 等相同参数组端点，名称/顺序/默认/必填和旧 ID 恢复保持，修改一端点参数不污染另一端点。真实请求体及完整目录摘要仍需下列回归执行后才能确认。

如由用户执行，在仓库根目录运行以下定向回归；助手本轮未执行：

```powershell
npx vitest run tests/services/projectSnapshotService.test.ts tests/store/projects.test.ts tests/hooks/useNodeCreation.test.tsx tests/components/nodeMenuModelPreferences.test.tsx tests/components/presetNodeWorkflow.test.ts tests/services/mediaParameterMappings.test.ts tests/services/runninghubModelManifest.test.ts tests/services/runninghubMedia.test.ts tests/services/modelCapabilityTemplateCompatibility.test.ts
```

需要类型/构建检查时再按授权执行 `npm run typecheck`、`npm run test:typecheck` 和 `npm run build`。本批仅按上列 13 个源码/回归文件撤销对应差异即可回滚；已有数据和目录合同不迁移，其他工作区改动不随之回退。

## 2026-11-15 第二批实施结果

用户已要求先提交第一批、再实施第二批并保留原有功能，后续要求提交第二批并继续第三批。第一批提交为 `19c6b3b2`（`refactor: 完成首批代码精简与模型参数去重`），仅包含该批 15 个文件；版本同步提示无需写入，未运行测试或质检，其他发版改动保留。以下第二批以此提交为基线，已实现并完成静态交叉复核，按用户要求本地提交为 `6c46dccc`（`refactor: 收敛节点操作与工具栏及助手生命周期`），共 33 个文件、未推送；**本次未运行测试，待用户验收**。Q32 小收益登记与第三批原生候选未纳入第二批提交。

### 完整业务范围与保留边界

共 19 个业务文件，按 UTF-8/LF 统一口径，包含新增共享实现后净减 **306 行、8,758 字节**。节点默认值与删除链共 10 文件净减 130 行；工具栏 6 文件净减 45 行；Agent/聊天窗口 3 文件净减 131 行。该数字不含回归和文档，不表示包体积或运行速度已实测改善。

| 项目 | 完整业务文件 | 已实现与保留语义 |
|---|---|---|
| Q26 | [NodeMenu.tsx](../../src/components/NodeMenu.tsx)、[Sidebar.tsx](../../src/components/Sidebar.tsx)、[useCanvasContextMenu.ts](../../src/hooks/useCanvasContextMenu.ts)、[useKeyboardShortcuts.ts](../../src/hooks/useKeyboardShortcuts.ts)、[useConnectionDropMenu.ts](../../src/hooks/useConnectionDropMenu.ts)、[useNodeCreation.ts](../../src/hooks/useNodeCreation.ts)、新增 [uiNodeCreationData.ts](../../src/services/uiNodeCreationData.ts) | 共用初始数据构造，模型读取、落点/连边/历史仍留原入口。保留浮动/侧栏音频 280×160、其他入口 260×140；浮动全景/Markdown 280×160、侧栏全景 300×200、右键等入口 Markdown 280×200；role/previewMode 缺省、source 参数抑制、导演台角色、分镜表偏好及独立三行、宫格维度与数组全部沿用；Agent/MCP 与源文件导入不接 UI 默认值 |
| Q25 | [store.nodes.ts](../../src/store/store.nodes.ts)、上述右键/快捷键两个 Hook、[fs/trash.ts](../../src/services/fs/trash.ts)、[nodeAnimations.ts](../../src/utils/nodeAnimations.ts) | 手工选区调用新 `deleteSelectedCanvasElements`，与单点/批量 API 共用后代展开、停轮询、文件暂存、组裁剪及历史。手工不限 50，批量 API 仍限 50 根；纯边/混选立即清选择，一次历史；新选择保留，手工空组保留，最后成员与 groupId 映射按原 Store 规则处理 |
| Q28 布局部分 | [AudioNodeToolbar.tsx](../../src/components/nodes/shared/AudioNodeToolbar.tsx)、[VideoNodeToolbar.tsx](../../src/components/nodes/shared/VideoNodeToolbar.tsx)、[PanoramaNodeToolbar.tsx](../../src/components/nodes/shared/PanoramaNodeToolbar.tsx)、[TextNodeToolbar.tsx](../../src/components/nodes/shared/TextNodeToolbar.tsx)、[image/ImageNodeToolbar.tsx](../../src/components/nodes/shared/image/ImageNodeToolbar.tsx)、新增 [ToolbarZones.tsx](../../src/components/nodes/shared/toolbar/ToolbarZones.tsx) | 只共享分区、按钮/更多菜单与分隔线循环，不增加 DOM 包装。保留各外层 class/长按事件、分隔 class、zone/button key、编辑态和插件/图片历史弹窗；按钮业务与全景预设行为不变，无新增样式 |
| Q31 | [agentRoundExecutor.ts](../../src/services/chat/agentRoundExecutor.ts)、[agentToolExecution.ts](../../src/services/chat/agentToolExecution.ts) | 共用 Policy 决策记录、步骤构造和审批结果更新；模型入口初始指纹继续单独赋值。模式读取、Policy/authorize、上下文捕获、预算、等待前 approvalId、拒绝/取消、动态导入、read 并发与 write 串行留原位，不合并两个执行生命周期 |
| Q39 | [chatWindowService.ts](../../src/services/chat/chatWindowService.ts) | 私有等待器共享超时、防重复完成和晚装监听清理；三个语义入口保留完整响应身份、20/30 秒、120,000 字上限、windowFrame/sequence、返回/抛错和监听后发送顺序。Team/Managed 同步 listen 异常仍转固定连接错误，message 保留原来直接调用语义；超时不自动重投 |

Q25 异步守卫绑定原项目、原生 runtime/project/canvas epoch 或旧结构 parent/revisionScope/exchangeEpoch，并观察历史重置/跳转及目标消失。普通画布 revision、位置/进度更新和历史追加/满 50 条裁剪不会误取消。失效立即退订，正常或异步拒绝在文件/退场都落定后退订，同步异常也清理；临时运行状态不持久化。

静态复核补齐了两条实际执行链：旧结构 `deleteNodeFiles` 现在也把可选删除上下文传到真实 rename 前，失效或新增引用时保留文件，无上下文的历史兼容调用不变；退出动画在完成时清理本次捕获的真实元素 class，以小型 WeakMap 计数处理重复/重叠退出，不按当前同 ID 查询新 DOM。正常 130ms、减少动效、无 DOM 及等待退场的合同不变，取消删除后不会永久残留退场样式。

### 回归源码与静态证据

调整/新增 11 个回归文件，测试源码净增 595 行；没有把它们计入业务净减，也没有运行：

- [nodeMenuModelPreferences.test.tsx](../../tests/components/nodeMenuModelPreferences.test.tsx)、[canvasGridCreation.test.tsx](../../tests/components/canvasGridCreation.test.tsx)、[useNodeCreation.test.tsx](../../tests/hooks/useNodeCreation.test.tsx)：补字段/缺省、尺寸、source、导演台/分镜表与双击断言，保留真实右键删除的共享文件用例。
- [history.test.ts](../../tests/store/history.test.ts)：覆盖手工/单点/批量、纯边、超过 50、分组、同 ID 一次重载、runtime/exchange epoch、切走切回、撤销重做、满容量历史、普通更新、并发删除、ID 重用、新选择及订阅异常清理。
- [fsTrash.test.ts](../../tests/services/fsTrash.test.ts)：补旧结构文件/整组在 mkdir 等待后失效或出现新引用时不移动，以及有效上下文正常暂存；原新结构、共享、撤销暂存回归保留。
- 新增 [nodeAnimations.test.ts](../../tests/utils/nodeAnimations.test.ts)：捕获元素、重复/重叠、同 ID 重挂载的两种结束顺序、清理与删除回调/等待顺序、减少动效和无 DOM。
- 新增 [toolbarZones.test.tsx](../../tests/components/toolbarZones.test.tsx)，调整 [imageLosslessCompressionToolbar.test.tsx](../../tests/components/imageLosslessCompressionToolbar.test.tsx)：布局排序/隐藏/插件/空区/分隔，原压缩手工测试驱动只显式展开新纯组件边界，不泛化执行其他 Hook 组件。
- 新增 [canvasSelectionDeletion.test.ts](../../tests/hooks/canvasSelectionDeletion.test.ts)：Delete/Backspace/纯边委托，保留拦截顺序，空选区、输入、弹窗、无项目不吞键。
- [agentRoundExecutor.test.ts](../../tests/services/chat/agentRoundExecutor.test.ts)、[chatWindowListener.test.ts](../../tests/services/chat/chatWindowListener.test.ts)：两个实际工具入口的批准/拒绝、初始指纹、步骤时间/脱敏/事件/指标；三等待器超时后迟到监听释放且不发送、同步监听异常，以及产物完整身份、上限和错误。

已完成引用/调用时序、差异空白、UTF-8 与相关测试桩静态核对，并交叉复核删除生命周期、字段差异和组件边界；这些不是功能实测结论。侧栏/数字快捷键/连线的完整交互、真实模型/文件系统、动画与双窗口时序仍待桌面验收。文档仅更新本文、计划索引和画布模块边界，共 19 个业务文件、11 个回归文件、3 个文档；其他工作区发版改动保留。

### Tauri 桌面验收与回滚

准备独立测试项目和导出备份、普通项目及多画布作品、可播放本地媒体、文本/音频偏好、普通与顺序预设、已有插件和团队产物；按以下顺序验收：

1. 依次通过浮动、侧栏、右键、数字键、连线、双击创建可用节点，核对上表入口差异、真实模型/workflowId、角色和默认字段；图片/动画/导演台/分镜/宫格原参数保留。源媒体拖放不自动绑模型；落点、连边方向、单次撤销及多文件导入历史粒度保持。
2. 删除单节点、纯边、混选、超过 50 节点、组及最后成员，检查共享文件/分镜/聊天引用、artifact、手工空组、暂存和撤销/重做；API 批量仍限 50。连续删除及动画中新选择不被旧回调清掉；正常移动/生成进度和其他编辑不使合法删除失效。
3. 在退出/暂存期间切项目并切回、同 ID 导入或重开、撤销重做，预期旧操作不修改新状态或移动仍在使用的文件；取消后存活节点可见可点，无残留 `node-exiting`。普通/减少动效下都检查。纯时序、异常和订阅清理还须运行对应回归，不能仅凭 UI 推断。
4. 五种工具栏分别检查长按编辑、改分区/顺序、隐藏项的更多菜单、插件、图片历史/压缩及全景切换；深浅主题下结构与原来一致，切选中状态时已有弹窗保持。普通/顺序文本预设沿用第一批语义。
5. 普通助手与 Registry/MCP/团队入口分别检查 B 批准/拒绝、等待中降级 Plan、C/MCP 自动写入和必答选择；事件/指标一次，停止、只读并发和写入顺序不变。真实模型/媒体调用按需执行并核对费用。
6. 独立助手发送、收回/关闭、读取团队产物、受管理保存，核对正确 ACK 才完成、草稿保留；旧 session/request/scope 等不匹配和超时不误报成功、不重投。断连/超大产物仍使用原提示，迟到监听释放。

如由用户执行，在仓库根目录按模块运行；本轮助手均未运行：

```powershell
npx vitest run tests/components/nodeMenuModelPreferences.test.tsx tests/components/canvasGridCreation.test.tsx tests/hooks/useNodeCreation.test.tsx tests/hooks/canvasSelectionDeletion.test.ts tests/store/history.test.ts tests/services/fsTrash.test.ts tests/utils/nodeAnimations.test.ts
npx vitest run tests/components/toolbarZones.test.tsx tests/components/imageLosslessCompressionToolbar.test.tsx tests/components/nodeToolbarShell.test.tsx tests/components/toolbarRegistry.test.ts tests/components/nodeCriticalInteractions.test.tsx
npx vitest run tests/services/chat/agentRoundExecutor.test.ts tests/services/chat/agentToolExecution.test.ts tests/services/chat/chatWindowListener.test.ts tests/services/mcp/mcpControlService.test.ts
```

类型、lint 和构建仍须按授权范围另行执行。回滚只撤销本节清单相对 `19c6b3b2` 的对应差异及新增 helper/回归文件，不用全工作区 reset/restore，不回退第一批或其他发版改动；无数据库/归档迁移和用户数据清理。

## 2026-11-15 第三批实施结果

第二批已按用户要求提交为 `6c46dccc`，随后实施 Q33～Q38。第三批已完成源码修改和静态交叉复核，按用户要求单独本地提交为 `5dbc443a`（`refactor: 合并原生路径随机源与进程基础件`），共 31 个文件、未推送；**本次未运行测试，待用户验收**。未执行 Cargo、lint、构建或桌面实机验证，不以源码对照代替编译及功能验收。Q32 未纳入第三批。

### 业务范围与保留边界

共 28 个 Rust 源文件，包含两个新增内部基础件和 `lib.rs` 注册；排除内联测试后，业务源码净减 **291 行**。含内联回归的源码整体净减 193 行，UTF-8/LF 口径净减 5,458 字节；不表示包体积或性能已实测改善。无新增依赖、原生命令、权限或存储格式迁移。

| 项目 | 源码范围 | 已实现与保留语义 |
|---|---|---|
| Q33/Q34，净减 173 行 | [path_policy.rs](../../src-tauri/src/path_policy.rs)、[package.rs](../../src-tauri/src/agent/package.rs)、[registry.rs](../../src-tauri/src/plugins/registry.rs)、[artifacts.rs](../../src-tauri/src/plugins/artifacts.rs)、[native_project_media.rs](../../src-tauri/src/files/native_project_media.rs)、[thumbnail_cache.rs](../../src-tauri/src/files/thumbnail_cache.rs)；Comfy 的 [installation.rs](../../src-tauri/src/media/comfyui/installation.rs)、[installer.rs](../../src-tauri/src/media/comfyui/installer.rs)、[model_dedupe.rs](../../src-tauri/src/media/comfyui/model_dedupe.rs)、[model_dedupe_links.rs](../../src-tauri/src/media/comfyui/model_dedupe_links.rs)、[model_dedupe_history.rs](../../src-tauri/src/media/comfyui/model_dedupe_history.rs)；Blender 的 [mod.rs](../../src-tauri/src/director/blender_runtime/mod.rs)、[resources.rs](../../src-tauri/src/director/blender_runtime/resources.rs)、[runner.rs](../../src-tauri/src/director/blender_runtime/runner.rs) | 12 个本地链接判定委托已有 `is_link_or_reparse`，五组路径转换复用已有 `simplify_verbatim/canonicalize_simplified`。Windows reparse 与 Unix symlink 语义保留；各自目录链、私有目录、授权、身份检查仍在原位，转换不提供授权；规范化失败时的回退和原错误映射保持 |
| Q35，净减 28 行 | 新增 [secure_random.rs](../../src-tauri/src/platform/secure_random.rs)，[muse.rs](../../src-tauri/src/media/muse.rs)、[volcengine_tos.rs](../../src-tauri/src/media/volcengine_tos.rs)、[media_source.rs](../../src-tauri/src/media/comfyui/media_source.rs)、[sync.rs](../../src-tauri/src/files/object_storage/sync.rs) | 仅共享系统随机字节读取，Windows 仍为 `SystemFunction036`，Unix 仍为 `/dev/urandom` 完整读取；Muse/TOS 24 字节、Comfy/S3 32 字节、小写 hex、Muse UUID v4 位及各业务失败文案不变。无弱随机回退 |
| Q36，净减 44 行 | [web.rs](../../src-tauri/src/agent/web.rs)、[provider_docs.rs](../../src-tauri/src/agent/provider_docs.rs) | 文档读取器复用已有公网 IP、IPv4/IPv6 和同源纯判定。网页读取遇混合 DNS 整组拒绝，文档读取过滤非公网地址；mapped fake-IP、URL/端口、DoH、重定向、固定地址连接和体积限制仍由原读取器分别处理 |
| Q37，净减 32 行 | 新增 [process_job.rs](../../src-tauri/src/platform/process_job.rs)，[codex_process.rs](../../src-tauri/src/agent/codex_process.rs)、[runtime.rs](../../src-tauri/src/plugins/runtime.rs)、[management.rs](../../src-tauri/src/media/comfyui/management.rs) | 只共享 Windows Job Object 创建、配置、绑定、终止与 RAII 关闭；配置/绑定失败仍释放句柄，各业务原错误保持。可执行身份、参数、输出预算、取消/超时、父级 Drop 与 Child 回收留原位；无新增 Send/Sync 承诺。Comfy 保留原包装 API，Blender 挂起启动流程独立 |
| Q38，净减 19 行 | [job.rs](../../src-tauri/src/director/blender_runtime/job.rs)、[result.rs](../../src-tauri/src/director/blender_runtime/result.rs) | Blender 内部复用 64 位小写 SHA256 与最多 128 字节的 scene ID 谓词；首尾及中间字符规则不变。允许大写、冒号与边缘标点的一般 opaque ID 继续独立 |
| 内部模块注册，增加 5 行 | [lib.rs](../../src-tauri/src/lib.rs) | 用显式 `#[path]` 注册两个基础件，Job Object 模块仅 Windows 编译；不变更既有 crate 根业务模块名与 IPC 注册 |

回归源码补充于既有内联测试：路径转换和普通条目/Unix symlink、Windows reparse 位；四种随机包装的原格式；公网/保留地址和 mapped fake-IP 差异；Blender ID、摘要边界及 opaque ID 宽规则。Job Object 保留既有生命周期回归，没有用仅镜像实现的用例代替真实进程验收。

静态核对包含实际引用、替换前后函数正文、错误映射、平台 cfg、UTF-8 与差异空白；交叉复核未发现阻塞问题。Windows API 句柄签名与当前依赖源码相符、错误路径具有 RAII 所有权，仅是源码结论。随机源实际读取、拒绝分支、链接/UNC 文件系统、进程树和三平台编译均未验证。

### Tauri 桌面验收与回滚

前置条件：准备可丢弃的测试项目与备份、含本批 Rust 改动的 Tauri 构建、已授权普通目录；按需准备 UNC 共享、现有 AgentPackage/插件、Comfy 安装及独立测试账号。涉及费用的真实请求由用户选择执行。

1. 依次导入 AgentPackage、安装/读取插件、保存项目媒体并重开缩略图，再检查 Comfy 安装、模型去重及历史恢复。普通路径和 Windows UNC 应沿用原结果；缺失/不可解析路径保持原错误或原回退。链接、junction/reparse、私有目录及越权祖先仍拒绝，取消不能新增授权或破坏现有素材。
2. 在 Muse 会话与任务、TOS 上传、Comfy 媒体读取、S3 同步入口各完成一次已有流程，确认身份格式与作用域保持、退出/取消/锁冲突处理正常。随机源故障必须拒绝而非产生身份；故障注入与格式边界另用原生回归核对，不能仅凭一次成功请求推断。
3. 普通网页与厂商文档分别读取公网地址并检查同源跳转；localhost、私网、保留网段、映射 IPv6 仍按原规则拒绝。混合 DNS、fake-IP 与跨源/端口跳转分别按两读取器的既有合同验收，不要求两入口返回相同错误或采用相同回退。
4. Windows 分别回归 Codex、可信 Python 插件与 Comfy 管理/依赖/控制台的正常完成、取消、超时和关窗/退出；所属子进程树应回收，创建/配置/绑定失败保留原文案。macOS/Linux 回归原 Unix 进程组路径；Blender 发现/启动/取消/收集继续走独立挂起启动及 Manifest/项目/版本校验，不把进程退出当作成功。
5. Blender 场景正常保存、收集仍成功；非法/超长 scene ID 和非小写摘要拒绝，合法 opaque job ID 不被误套 scene 规则。保存重开项目，确认结果仍仅写回对应项目、节点与活动 revision。

可选自动化由用户按需执行：运行目录为仓库的 `src-tauri/`；以下命令本轮均未运行。

```powershell
cargo check --lib
cargo test --lib path_policy::tests
cargo test --lib assistant_web::tests
cargo test --lib provider_docs::tests
cargo test --lib muse::tests
cargo test --lib volcengine_tos::tests
cargo test --lib comfyui::media_source::tests
cargo test --lib project_asset_storage::sync::tests
cargo test --lib blender_runtime::job::tests
cargo test --lib blender_runtime::result::tests
```

其他原生回归及三平台编译仍按用户授权范围执行，以上单测不能替代真实 Windows Job Object/UNC 与各平台桌面验收。回滚只撤销本节 28 个源码文件相对 `6c46dccc` 的差异、两个新增基础件及本批文档；保留后续并行提交、其他任务和前两批改动，不做全工作区 reset/restore，不清理用户数据。

## 2026-11-15 第四批实施与剩余项核对

第三批已按用户要求单独提交为 `5dbc443a`；提交钩子确认版本一致、无需改写，未运行测试或质检。本批继续处理 Q24，复核 Q32 及方案的暂缓候选；代码已实现，按用户要求单独提交并普通推送 `master`，实际提交及远端状态以 Git 记录为准。**本次未运行测试，待用户验收**。工作区原有生成 schema 改动未纳入本批，也未由本任务修改。

### Q24 视频窗口发送收敛

仅修改 [videoEditorWindowService.ts](../../src/services/videoEditorWindowService.ts) 和既有 [videoEditorWindowService.test.ts](../../tests/services/videoEditorWindowService.test.ts)。同文件私有 `postWindowMessage` 共享绑定、动态导入和固定两方向发送；业务源码净减 **33 行、640 字节**（UTF-8/LF），回归源码净增 92 行。没有新增模块、依赖、权限或用户数据变更，也未改视频生成与编辑工程逻辑。

- 七个异步语义导出与签名全部保留，编辑器的五种请求固定发主窗口消息通道，主窗口的两种响应固定发编辑器宿主通道，不开放任意目标或事件。
- 先取得原 binding，再等待 event 模块；宿主方向在导入后按原 binding 二次复核，随后构造消息。子窗口仍使用导入前取得的绑定；`result/request` 仍在导入后才浅拷贝，`models` 仍是原数组引用。转场响应的 `expectedBinding`、错误透传和无自动重试均保留。
- 打开/复用窗口时的特殊 session 发送、监听解析、订阅和原生目录授权不纳入共享发送器，继续保留独立生命周期。

新增 10 个参数化回归场景，覆盖 ready/模型请求固定路由、导入让出期间输入变化、发送后浅副本、模型数组引用、宿主绑定撤销先于消息构造及两方向发送错误原对象透传。完成调用链、测试桩、UTF-8、差异空白与独立静态交叉复核，未发现剩余阻塞问题；动态导入失败只有无 catch 的源码透传证据，未直接故障注入覆盖。以上均不表示测试通过或桌面功能已验收。

### 当前方案清单

| 范围 | 当前处理状态 | 剩余工作 |
|---|---|---|
| Q01～Q22 | 已实现；Q01、Q10～Q17 有各自历史部分验证 | 依各节完成剩余桌面/真实模型与异常场景验收，旧结果不覆盖新改动 |
| Q23、Q27、Q28 文本、Q29、Q30 | 第一批 `19c6b3b2` 已实现 | 按第一批步骤验收，不能把旧候选描述重新计为未实施 |
| Q25、Q26、Q28 布局、Q31、Q39 | 第二批 `6c46dccc` 已实现 | 删除时序、工具栏、Agent 与双窗口待验收 |
| Q33～Q38 | 第三批 `5dbc443a` 已实现 | 原生编译、真实路径/随机源/进程与各平台桌面待验收 |
| Q24 | 第四批已实现并按用户要求提交 | 下述窗口发送回归与桌面验收 |
| Q32 | **未实施，经复核明确保留** | 两种资源只重复少量身份字段。严格等价的私有构造器实际只省 0～2 行、76～81 字节，还新增用于展开的临时对象；保留普通路径/mtime/source 与包资源 ID/SHA 的独立分支及所有校验，原 10～15 行收益估计不成立 |

其他保留或待独立设计的事项：

- **资产添加菜单、资产筛选**：搜索窗和主侧栏的添加菜单可单独受控复用，预计净减 10～18 行，但加载、配置、取消与父级关闭入口继续独立；暂不为此新增组件。分类计数/名称与标签匹配扣除共享实现后仅约 5～10 行，不合并两个窗口的完整筛选与扫描。
- **Aigcsi/Relayon 目录匹配**：保留语义化导出、目录 Map、类型与导入后只约净减 0～4 行。精确 ID、远端顺序、首连接身份、深克隆及各自归一化仍独立；不新增跨厂商匹配框架。
- **Q03 坏父链归档策略**：运行时有限遍历已做，归档入口选择拒绝或修复仍需独立设计；这会改变导入合同，不混入保留现有行为的精简批次，也不自动修复历史数据。
- **明确保留的边界**：项目迁移夹具/旧库/备份演练及兼容交换格式继续保留；新旧库迁移不因此开启。插件跨信任边界复核、两网页读取器的 DNS/fake-IP 策略、Blender 挂起启动和归档/凭据/S3 的原子与耐久合同均不按重复实现删除。其余声音播放/Comfy 恢复流程和数据库日志包装继续保留既有状态与失败差异。

当前编号清单没有遗漏的高收益去重项；Q32 和上述低收益候选是明确保留或暂缓，不标为已实现。仍待用户验证的功能不能因为去重完成就标为验收通过。

### 第四批验收与回滚

前置条件：准备可丢弃的含视频项目，使用包含本批前端改动的 Tauri 桌面端；配置可用视频模型，真实转场调用由用户按需执行。

1. 从视频节点打开独立剪辑窗口，检查 ready、模型列表刷新与原工程加载；重复打开同一节点应复用正确会话，关闭重开后正常接收。旧实例/项目绑定消息仍被拒绝。
2. 分别导出视频和当前帧，主画布应收到正确素材、名称、尺寸与时间信息；保存重开及撤销/重做沿用原行为。检查失败时提示仍正常，不自动重复发送或重做外部操作。
3. 请求 AI 转场，核对主窗口收到首尾帧与模型参数，pending/成功/失败响应只返回原请求与原窗口；请求期间切项目、删除目标或重开同 ID 节点，迟到响应不得写回新上下文。
4. 消息等待导入期间输入变化、宿主撤销先于 payload 构造、数组引用和发送错误透传由定向回归核对。窗口销毁、导入/发送故障与真实双窗口时序仍需实机验收。

如由用户执行，在仓库根目录运行 `npx vitest run tests/services/videoEditorWindowService.test.ts`；按需另行执行 `npm run typecheck` 与 `npm run test:typecheck`。这些命令本轮均未运行，Web 展示不能替代 Tauri 窗口验收。回滚只撤销上述两个代码/回归文件和本批文档相对 `5dbc443a` 的差异，保留第三批及其他任务，不回退项目数据。


## 2026-11-16 第五批：不可达旧界面清理与预览拆分

已实现，本次按用户要求统一提交。**本次未运行测试，待用户验收**；未运行 lint、类型检查、构建或桌面验收。原有两个生成 schema 未由精简任务修改，本次一并纳入用户授权的提交。

- **Q40 删除不可达旧背景代码**：`SettingsPanel.tsx` 的 `legacyBackgroundUiEnabled` 固定为 `false`，删除其整段 JSX、专属状态、ref、常量、处理器和导入，1184 → 847 行。原背景模块 `backgroundService.ts`（227 行）和选项 `backgroundOptions.ts`（17 行）失去唯一业务入口，同步删除；删除只覆盖该旧服务的专属测试及失效 mock，共 144 行。现有外观上传仍走 `themeAssets`，旧配置字段及 `appearanceMigration.ts` 保留，模型参考图和图片节点压缩不属于此次删除范围。
- **Q41 拆分外观预设节点预览**：`AppearanceSettings.tsx` 中连续的预览种子、空节点模板和 `PresetSingleNodePreview` 搬到 `AppearancePresetNodePreview.tsx`，母文件 2254 → 1869 行，新文件 390 行；合计仅增加 5 行模块连接代码。组件仍只读原 `theme/index/realNodes`，不接 Store、不新增副作用，原调用位置、DOM、样式及节点挑选逻辑保留。

按 UTF-8/LF 实际文件行数计算，业务源码净减 **576 行**，连同退役测试共净减 **720 行**，不含文档。完成引用/动态入口核对、调用链、UTF-8 和差异空白静态核对；搬移块去掉新增导出后与原文一致，母文件其余函数及 JSX 逐字一致。现有 `appearanceSettings.test.tsx` 覆盖预设、真实节点与空画布预览入口；本轮未执行，以上静态结论不代表功能已验证。

第五批保留的 `pollManager.ts` 厂商查询块随后由第六批 Q43 拆分；`indexedDbService.ts` 工具栏布局仓储仍保留原位，会话仓储拆分见 Q42。项目保存/切换与媒体恢复不因文件较长而机械拆分；APIMart 两处查询存在错误处理差异，不作为等价重复直接合并。

### 第五批 Tauri 验收与回滚

前置：使用包含本批改动的 Tauri 桌面端，准备一个空项目和含图片、视频、文本、音频、分镜节点的可丢弃项目，以及一张有效背景图。

1. 打开“设置 → 常规”，依次核对语言、启动页、窗口尺寸、画布交互及自动 @ 设置，修改一项后关闭重开，值应保留。常规页仍不显示旧背景控件；保存失败时沿用原错误/重试入口。
2. 在空画布和已有节点的画布分别打开“设置 → 外观”，逐个查看预设卡片。空画布仍显示原空节点模板；分别只保留一种节点核对真实名称、编号、提示词或缩略图，选取规则、布局及配色应保持一致。深浅主题、窄窗口和键盘选择均需回归。
3. 在外观页上传、更换、移除画布背景图，调整现有参数，保存预设、切换并重启，图片及参数应恢复；无效或不支持的图片仍报错且不覆盖已有外观。旧配置迁移用副本或既有夹具核对，确认原颜色/图片可转换为完整快照。

供用户按需执行，运行目录为仓库根目录：`npx vitest run tests/components/settingsPersistence.test.tsx tests/components/appearanceSettings.test.tsx tests/services/appearance.test.ts tests/services/appearanceThemeService.test.ts`；类型检查入口为 `npm run typecheck` 与 `npm run test:typecheck`。这些命令本轮均未运行，自动化结果不能替代桌面验收。回滚只撤销本批源码、专属测试及相关文档差异并恢复删除的旧模块，不回退其他任务或用户配置，无数据库迁移。


## 2026-11-16 第六批：服务职责拆分与孤儿样式清理

已实现，本次按用户要求统一提交。**本次未运行测试，待用户验收**；未执行 lint、类型检查、构建、实机验收或模型调用。精简实施范围仅下列 5 个源码/样式文件及模块文档；本次提交同时包含六项算法性能优化和原有生成 schema，各项实施与验收范围仍分别记录。

- **Q42 会话仓储拆分**：`indexedDbService.ts` 2898 → 2642 行，独立 `indexedDb/chatConversationRepository.ts` 277 行。5 项会话 API 和 2 项记录类型保持原入口重导出，内部消息读写仅导入类型；元数据覆盖保护、组合包选择 CAS、工作台分集绑定、分支事务和脱敏预算均原样保留。沿用既有 schema，不升级数据库。
- **Q43 恢复查询拆分**：`pollManager.ts` 2968 → 2853 行，独立 `pollManagerQueries.ts` 121 行，承接 APIMart 查询/结果解析与 RunningHub 标准模型查询/轮询。管理器其余正文保持原样，仍负责状态、项目/revision 守卫、暂停、交付及热更新运行时；查询没有反向依赖管理器。新增导入放在原 helpers 导入后，保留原依赖求值顺序。请求、HTTP/业务错误、408/504 暂停、结果顺序及取消信号不变，没有借拆分合并语义不同的 APIMart 查询。
- **Q44 孤儿设置样式**：`settings.css` 2202 → 2111 行，删除全仓无消费者的旧导航、动作/覆盖按钮、预设徽标、存储选中态、协议按钮及变量列表规则。当前组件使用既有侧栏、UI Kit 按钮和 chip；共用 `.provider-protocol-json-help code` 字体、动态厂商徽标及仍用于外观布局预览的背景样式保留。

两个大入口合计移出 371 行，新增模块合计 398 行；加上删除 91 行孤儿样式，**本批业务源码与样式净减 64 行**，未通过搬移量冒充净删除量。与第五批累计净减 640 行，不含退役测试和文档。完成逐字搬移比对、原入口与依赖/mock 核对、UTF-8、差异空白及独立静态交叉复核；这些证据不表示类型检查或测试通过。既有会话 CAS/分支/绑定及媒体恢复测试入口保留，RunningHub 工作流用例不能替代旧标准模型查询的桌面验收。

### 第六批 Tauri 验收与回滚

前置：使用包含本批改动的 Tauri 桌面端，准备可丢弃的普通/剧集项目、已完成助手轮次的会话，以及带原任务 ID 的旧项目 APIMart／RunningHub 标准模型记录。

1. 新建、切换、改名、归档及回收站恢复会话，重启后核对消息数、顺序、标题和原项目归属。从已完成助手轮次创建资料分支，应只复制原边界内资料，不重放工具或旧审批；未完成轮次/已删除来源拒绝，失败不留下半个分支。
2. 工作台会话核对分集绑定，切换组合包或团队配置后继续发送/改名并重开，较旧元数据不得覆盖新选择；非法改绑仍拒绝。并发选择冲突、分支写入失败与回滚由下列隔离数据库用例核对。
3. 从原节点/任务恢复入口继续查询 APIMart 图片/视频/音频、RunningHub 标准模型图片；沿用原任务 ID，只查询与保存，不新增生成提交。核对单项/多项结果、空结果、明确失败、408/504、网络中断、取消、切项目和删除节点，错误提示、可续取状态及过期结果拒绝保持原行为；开发热更新不另起恢复请求。既有 RunningHub 工作流回归仍单独保留。
4. 深浅主题及窄窗口下打开设置侧栏、外观预设、存储健康、厂商模型和协议编辑器，核对选中/悬浮/禁用/已配置状态、变量按钮和帮助文字等宽字体；键盘聚焦及自定义外观不应出现视觉回退。

供用户按需执行，运行目录为仓库根目录：`npx vitest run tests/services/indexedDbService.test.ts tests/services/chat/workbenchConversationScope.test.ts tests/services/chat/conversationBranchService.test.ts tests/services/pollManager.test.ts tests/components/appearanceSettings.test.tsx`；类型检查入口为 `npm run typecheck` 与 `npm run test:typecheck`。本轮均未执行，真实桌面及厂商异常场景仍待用户验收。回滚仅合回上述两个搬移块、移除两个新模块、恢复本批删除样式及相关文档差异；不回滚第五批、其他任务或用户数据。


## 2026-11-16 第七批：无消费者代码与重复声明清理

已实现，基于 `bd242132`，本批按用户要求单独提交。**本次未运行测试，待用户验收**；未运行 lint、类型检查、构建、性能基准、桌面应用或模型。实施只涉及以下 6 个源码/样式文件，不改权限、依赖、数据库或用户数据。

- **Q45 面板孤儿样式**：`panels.css` 2756 → 2656 行，删除 `wf-panel-close`、`wf-hint-code`、`assets-panel-close`、`assets-card-info`、`assets-card-cat-tag`、`assets-folder-row`、`assets-node-media-badge` 及无消费者变体。保留动态工作流类型类、浅色共用的 `assets-card-tag` / `button` 和现行关闭控件样式。
- **Q46 闲置导出**：删除 `imageUtils.resolveContentImageUrls`（18 行）、`indexedDbService.getLegacyAssetMeta`（10 行）、`storageQuota.isStorageUnderPressure`（7 行）和 `distributionGeometry.adjustAdjacentNodeGap`（12 行）。确认源码/测试/脚本/SDK无调用及按名称访问，也无模块导出枚举或公共包合同。`LegacyAssetMetaRecord`、旧索引迁移、`STORAGE_PRESSURE_RATIO`、图片上传/有序映射和真实 `adjacentGap` 算法仍有使用并保留；这里只删除入口已空的包装。
- **Q47 ComfyUI 媒体键表**：`comfyWorkflowService.ts` 两份图片/视频/音频输入键表字面量、键顺序完全一致，均只有只读 `.find` 消费者，删除重复表，复用 `MEDIA_LOADER_INPUT_KEYS`，净减 6 行。上传槽的值类型筛选与空参考分支的存在性/空值判断继续各自处理，不合并这两种判定。

按 UTF-8/LF 实际文件计算，本批源码与样式净减 **153 行**，没有新增模块或改动测试。完成调用链、namespace/动态导入与样式动态类核对、其余正文逐字比对、UTF-8 及差异空白静态核对；自动化和实机结果仍待验证。外观控件或全局资产 CRUD 还可按职责拆分，但纯搬移会增加接线代码，本轮优先落地实质删除项；项目模型迁移夹具与既有兼容入口继续保留。

### 第七批 Tauri 验收与回滚

前置：使用包含本批改动的 Tauri 桌面端，准备含不同尺寸节点的测试项目、工作流及素材侧栏，并为 ComfyUI 准备带上传槽/可选参考分支的已有工作流。

1. 深浅主题、窄窗口及自定义外观下打开工作流面板、素材侧栏和外部文件夹，核对关闭按钮、分类/标签、节点媒体预览、文件夹标签及悬浮/聚焦状态；现有标签及动态输入类型配色不应变化。
2. 对不同尺寸的多个节点执行平均分布，再用 Shift 拖动间距手柄，核对两侧节点与共同中心、撤销/重做和保存重开；已有实际布局算法与调用保持一致。
3. ComfyUI 分别使用图片、`video` / `file` 视频槽和音频槽，检查显式素材与普通引用的上传、去重与槽位不足提示。无素材的可选分支仍可摘除，必填分支/独立输出及未知结构保留；主机路径或连线不能被上传文件名覆盖。旧资产索引标签迁移和存储健康占用/压力展示一并回归。

供用户执行，运行目录为仓库根目录：`npx vitest run tests/services/comfyDefaultIONodes.test.ts tests/services/comfyWorkflowAudioIO.test.ts tests/services/comfyMediaRouting.test.ts tests/components/distributionGapHandles.test.tsx tests/services/indexedDbService.test.ts tests/services/storageHealth.test.ts`；按需执行 `npm run typecheck` 与 `npm run test:typecheck`。本轮均未运行，自动化不能代替上述桌面和真实 ComfyUI 验收。回滚仅恢复本批 6 个文件的删除块及键表引用和相关文档，不回退前批提交或用户数据。

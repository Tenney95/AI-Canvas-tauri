# 剧本故事关系图：MiroFish 借鉴与实施方案

> 日期：2026-11-06，实施收尾：2026-11-07。状态：完整首期功能与回归用例已实现并提交；用户已追加授权推送，按仓库规则执行完整前端 CI。实际自动化结果见第 8 节，Tauri 桌面与真实模型仍待用户验收。
> 来源：用户要求在剧本中增加关键点与各种关系的图谱，并明确指定参考 [666ghj/MiroFish](https://github.com/666ghj/MiroFish)。截图用于展示图谱交互方向，示例数据不是本项目材料。

**目标：** 在剧本工作台新增「故事关系图」，记录人物、关键事件、伏笔及其关系，能够编辑、按分集查看、追溯原文，并从用户选定稿件中按需提取候选。

**架构：** 图归属整部剧，分集作为来源与发生范围；主窗口 Store 负责条件保存，主/独立工作台共用视图和协议。使用已有 React Flow 与 IndexedDB 项目记录，不增加依赖、数据库表、原生命令或权限。

主模块：[画布与项目](../画布与项目模块.md)。相关边界：[剧本工作台独立窗口与选集解耦](./2026-11-06-script-workbench-window.md)、[角色与短剧资产](../角色与短剧资产模块.md)、[项目交换与三方合并](./2026-10-30-project-import-update-merge.md)。

## 1. 参考项目与取舍

调研固定提交：`7657031ac01184afe2cb220f5ee3545573b5e843`。只读取官方公开仓库和源码；GitHub 连接器当前返回 Unknown tool，改用官方 GitHub 页面与 API 读取。

| 官方入口 | 已核对的机制 | 本项目采用方式 |
|---|---|---|
| [README](https://github.com/666ghj/MiroFish/blob/7657031ac01184afe2cb220f5ee3545573b5e843/README-ZH.md) | 建图、实体/人格配置、仿真、报告与交互串联，包含《红楼梦》案例 | 首期交付创作资料图；多 Agent 剧情推演单列后续阶段 |
| [GraphPanel.vue](https://github.com/666ghj/MiroFish/blob/7657031ac01184afe2cb220f5ee3545573b5e843/frontend/src/components/GraphPanel.vue) | 节点/关系详情、类型图例、缩放拖动、多重关系曲线及标签显示 | 用现有 React Flow 独立实现，支持筛选与局部展开 |
| [graph_builder.py](https://github.com/666ghj/MiroFish/blob/7657031ac01184afe2cb220f5ee3545573b5e843/backend/app/services/graph_builder.py) | 节点、关系事实、属性、有效时间与来源关联 | 另定义剧本分集、稿件版本、原文证据和剧情顺序 |
| [ontology_generator.py](https://github.com/666ghj/MiroFish/blob/7657031ac01184afe2cb220f5ee3545573b5e843/backend/app/services/ontology_generator.py) | 本体先于抽取，当前业务提示面向社交媒体模拟 | 固定剧本领域 schema，覆盖事件、伏笔与设定 |
| [zep_graph_memory_updater.py](https://github.com/666ghj/MiroFish/blob/7657031ac01184afe2cb220f5ee3545573b5e843/backend/app/services/zep_graph_memory_updater.py) | 模拟活动继续进入图记忆 | 后续推演结果保存为独立候选分支，不混入已确认原稿事实 |

重要语义：MiroFish 的 `episodes` 是 Zep 来源标识，不是本产品分集 ID；`valid_at` 等字段也不能直接当作剧情发生时间或因果证据。

[许可证](https://github.com/666ghj/MiroFish/blob/7657031ac01184afe2cb220f5ee3545573b5e843/LICENSE)为 AGPL-3.0。本方案参考机制并独立实现，首期不复制其源码、样式、提示词或资源，也不引入 Vue/D3、Flask、Zep Cloud 和 OASIS。后续若提出具体代码复用，再单独确定范围与许可安排。

## 2. 首期界面与行为

工作台顶部现有页签后增加「故事关系图」，主窗口与现有独立工作台均可用。切换关系图、分集或出处仅改变工作台视图，画布仍通过既有画布入口切集。

| 区域 | 首期内容 |
|---|---|
| 工具栏 | 搜索、本集/全剧/选定分集范围、节点/关系类型筛选、关系/时间线切换、标签开关、适配视图、全屏、新增、提取 |
| 中部图谱 | 分类着色的节点、带说明的关系；缩放、平移、拖动、选择、邻接高亮，支持同一对节点存在不同关系 |
| 右侧详情 | 名称、别名、说明、确定性、发生/有效分集、绑定资产、证据；编辑、关联、查看出处与局部删除确认 |
| 时间线 | 复用同一份事件/伏笔数据，按分集和叙事顺序展示关键点；另行保留故事内时间说明 |
| 提取预览 | 明示材料和模型，启动/取消、阶段进度、候选比较、别名映射、逐项采纳或丢弃 |

所有工具栏与表单优先使用 UI Kit `sm` 控件，复用真实 `Select`、`NumberStepper` 和模型选择器；深浅主题均引用主题变量。长名称可截断但详情可读完整内容，状态使用文字与图标区分。提供列表/详情入口和键盘操作，减少动态效果时不做视口飞行动画。

初始布局采用确定性分类/环形分组，保留用户拖动的位置；打开图谱不持续运行物理模拟。默认按当前集和所选节点显示相关范围，可扩展一层邻接、切换全剧。统计分别显示总量与可见量，避免将大量无筛选连线挤成一团。

### 2.1 记录什么

| 节点 | 典型内容 |
|---|---|
| 人物 | 身份、别名、目标、与正式角色资产的可选绑定 |
| 关键事件 | 冲突、选择、转折、揭露、高潮等标签与叙事顺序 |
| 伏笔 | 埋设、推进、回收状态及关联事件 |
| 设定 | 世界规则、限制、人物已知/未知的信息 |
| 地点、道具、组织 | 可选绑定正式场景、道具、组织语义；没有正式资产也能独立记录 |

关系预设包括人物关系、参与、发生于、持有、归属、先后、导致、埋设、回收、相关；可编辑关系说明，区分有向/无向。人物关系允许环，同一对节点可有不同关系与有效范围。关系没有原文支持时标记为人工说明或推断；时间先后、共现和因果分别记录，不自动互相转换。

例：人物甲参与「隐瞒真相」，该事件埋设「旧信」，「旧信」在后续事件中回收，并改变甲乙之间的信任关系。每条连接都能说明“是什么关系、哪一集发生、依据在哪里”。

## 3. 数据、保存与恢复合同

### 3.1 归属与边界

- 在 `ProjectSeriesInfo` 增加可选 `storyGraph`，旧项目缺失时为空。新领域类型集中于 `src/types/storyGraph.ts`，不在组件内重复声明。
- 图格式含 `schemaVersion: 1`、稳定图 ID、单调 `revision`、节点、关系和有界布局位置。选择、悬浮、拖拽中间态、AbortController、窗口句柄及模型凭据不持久化。
- 节点引用稳定内部 ID；可选正式资产引用包含资产种类与业务 ID。已有 `DramaCharacter.relationships` 的名称关系只作为导入候选，不能按同名自动合并人物或反向覆盖正式资产。
- 初始上限：500 节点、1,500 关系、整个正式图 UTF-8 JSON 最多 1 MiB；名称 120 字、说明 1,000 字、每项最多 4 条证据、每条摘录最多 240 字。超过容量拒绝写入并保留原图，不静默截断用户数据。
- 默认可见图最多 200 节点/400 关系，超过时提示收窄筛选，并保留真实总量。图范围、详情和后续分页通过明确 DTO 获取，不能把截断结果误当整张图保存。

### 3.2 原文证据与关系变化

证据为 `{episodeId, part, sourceHash, start, end, quote}`，首期 `part` 限已保存的分集大纲/正文。`start/end` 使用当前字符串的 UTF-16 偏移，`sourceHash` 是该材料版本摘要。只保存有界摘录，不把整篇稿件塞入节点、日志或模型调用摘要。

- 原文摘录必须在捕获版本中逐字匹配；无法核对的 AI 输出不能冒充已验证证据。
- 人工记录、AI 候选/推断、用户采纳分别标记；“用户采纳”不等于已经由原文证明。
- 稿件变更后证据显示“来源已变化”，保留用户记录；不可把旧位置直接当成当前出处。若当前稿件存在唯一同文摘录，可提供重新定位建议，更新绑定仍须用户确认。
- 叙事顺序与故事内时间分开记录。人物关系的起止分集表达演变，未指定结束不自动推断永久有效。
- 查看出处仅调用工作台选集/页签/定位动作；如正文有草稿，沿用现有保存/保留/取消保护，不丢弃草稿。

### 3.3 条件保存

通过 Store action `updateStoryGraph(seriesId, patch, expectedRevision, guards)` 修改共享状态；提交只接受有界领域 patch，不接收整份任意项目对象。所有者身份、工作台会话、归档代际和 revision 必须匹配。

图写入、`updateSeriesInfo` 与项目自动保存复用按所有者串行队列，并在持久化事务中读取最新记录、条件更新 `series`。普通保存不得携带旧 `series` 覆盖较新的图；图编辑也不得覆盖较新的全剧剧本。只有持久化成功才更新已保存基线并向独立窗口回执；失败保留编辑状态供重试。

必要时在 `indexedDbService.ts` 补充图 revision 的条件 patch，复用现有 projects 表；不新增 DB store/index、不提升 DB_VERSION。图编辑不写主画布 `nodes/edges`，也不改变画布撤销历史。

### 3.4 项目归档

保存/重开、摘要、复制、旧归档新建导入、新版导入更新、三方合并、恢复点均需覆盖：

- 对图执行统一归一化、容量和引用校验，不直接 `as ProjectSeriesInfo` 信任外部数据。
- 导入/复制重新映射来源分集和正式资产 ID；图内部 ID 作为图内稳定标识处理。删除/缺失的来源或资产保留为断开引用提示，不链接到同名或其他项目对象。
- `series.script`、`series.originalWork`、`series.storyGraph` 分为独立合并槽。第一版整张图作为一个原子冲突单元，不能从两版本各取半份节点/边拼出悬空关系。
- 所有导入路径使用同一领域适配；导入更新后图 revision/代际推进，旧窗口和旧抽取结果不能继续写入。恢复失败沿用已有归档恢复机制，不自动清空图或原稿。
- 正式图可随项目归档；提取中的候选、任务运行态、窗口视口与模型调用参数不进入可交换快照。
- 图 `revision` 是本机并发令牌：可交换规范快照/语义摘要排除其无意义漂移，目标项目还原时重建本机令牌；导入更新以 `exchangeEpoch` 撤销旧窗口和候选。相同内容重复导入应保持幂等，不能仅因本机 revision 提升而产生新冲突。

## 4. AI 提取与窗口合同

### 4.1 显式按需提取

用户点击提取后，明确选择已保存的当前集或勾选分集、大纲/正文以及一个已有文本模型。材料存在未保存草稿时先处理草稿，不自动读取用户未选择的全剧材料。

主窗口冻结 `seriesId + episodeIds + sourceHashes + graphRevision + sessionId + modelFingerprint`。优先复用现有 `generateText` 与模型配置/凭据链路；按文本段落有界分块，每块最多 12,000 字，每批最多 8 次顺序调用，开始前显示调用上限。超过一批的材料由用户另行继续，不能后台无限扩展。

模型只返回白名单 JSON：候选节点、关系和匹配原文的证据，不执行生成的脚本/命令。重复人物、别名与既有图的匹配进入映射预览，人工修改的正式记录不被模型覆盖。

模型侧证据只需返回原文 `quote`；宿主在冻结的当前分块逐字唯一匹配，计算完整稿件 UTF-16 偏移并绑定分集、正文类型和摘要，不要求模型计算偏移或复制摘要。重复摘录不能自动选第一处；旧格式完整证据仍须位置及来源全部准确。若摘录不存在、不唯一或旧位置不准，该整条节点/关系移除全部证据并标为 `certainty: unknown`，保留候选供审阅；合法 `explicit` 却无证据时同样降级，不能把非法 certainty 或来源身份错误混入降级逻辑。候选列表显示待核实数量、每项确定性及无证据提示，不默认勾选；用户显式采纳后仍保留待核实状态，可在详情中手动绑定原文。明确提供了错误分集、稿件类型或摘要的证据、非法字段、断边和过期上下文仍拒绝。仅允许剥离完整回复的单层 JSON 围栏，不从混杂说明或多个 JSON 中挑选片段；原始回复按实际 UTF-8 字节计量，候选对象仍保持 128 KiB 上限。

候选先在预览中显示，不直接写正式图。逐项勾选后一次采纳当前选择，界面明确说明本批未选项不进入正式图、结束预览；提交失败仍保留候选和选择。采纳时重新核对来源摘要、图 revision、项目和会话；来源/图发生变化则要求重新比较。取消、协议/解析错误、失联或来源变化均保留正式图；付费调用不自动重试。候选保持在主工作台会话内，关闭并丢弃候选需明确提示；首期不承诺重启恢复抽取任务或候选。

### 4.2 主/独立工作台

- 扩展 `WorkbenchEditorTab`、固定 `ScriptWorkbenchAction` 与快照 DTO。主窗口是唯一图写入与模型调用方。
- 图视图只投影当前筛选子图的简要节点/关系（名称、类型、短说明、位置和引用 ID）、计数与 revision；单次图 DTO 不超过 256 KiB，完整详情/证据/候选按需读取。单次写 patch 不超过 64 KiB，维持现有整个请求上限，禁止放大窗口事件权限。
- 保留 `sessionId/requestId`、请求去重、revision、保存后确认及旧会话拒绝；展示切换不重启提取，不重复付费。
- 关系图自身全屏使用现有工作台内的布局切换，不新增 Tauri 窗口或原生命令。
- 表单显示前先由主窗口确认编辑租约，保存/明确丢弃并关闭详情后释放；详情打开或图写入未完成时阻止关闭、切页/分集和内嵌/独立展示交接。全屏保留同一表单 DOM，旧保存回执按编辑器身份处理，不能关闭后来打开的详情。
- 快照与请求基线包含归档 `exchangeEpoch`，空图 ID 同样区分代际；取消绑定运行 ID，丢弃/采纳绑定候选 ID。同剧内切换所看分集只改变视图，提取仍复核冻结材料，不因此重复调用模型。

## 5. 实施步骤与完整文件清单

实施遵守当前 `AGENTS.md`；下列 **48 个文件**范围已获用户确认：业务文件 24、测试 17、词条 3、文档 4。此前悬浮入口、紧凑控件、浅色按钮等未提交改动和四个生成 schema 文件均保留；实施期间出现的其他助手上下文并行改动也保留，不作为本功能实施范围或验证结论。

### P1：领域合同、条件保存与归档

1. 定义有界 schema、证据和 patch；明确关系环、多重关系、稳定 ID、容量及来源规则。
2. 补齐 Store/IndexedDB 条件保存与普通 series 保存合并保护。
3. 同步保存/加载、摘要、复制、新旧导入、原子合并槽和恢复，编写相应回归用例。

### P2：两种工作台的关系图与时间线

1. 独立 `ReactFlowProvider`、受控图与模块顶层稳定 nodeTypes/edgeTypes，不导入整个 `Canvas.tsx`。
2. 实现图谱、详情编辑、邻接筛选、时间线和证据定位，复用 UI Kit 最小控件。
3. 使用自定义语义边 path 类，避开主画布 `.react-flow__edge-path` 既有强覆盖；不新增 `!important`。
4. 接通受限窗口 action/投影、条件保存确认与关窗交接。

### P3：按需提取与候选审阅

1. 冻结所选材料/模型/版本，分块与调用预算，接入取消和有界 JSON 校验。
2. 实现候选比较、同名/别名映射、逐项采纳和来源变更拒绝，不自动覆盖人工记录。
3. 补齐失败/取消、重复请求、源文变化和 revision 冲突用例。

### P4：文档与用户验收

同步词条与模块边界，保留“已实现/待用户验证”状态；默认只编写回归用例和静态核对。测试、构建、真实模型、提交推送须按用户后续明确授权执行。

### 5.1 拟新增业务文件（9）

| 路径 | 职责 |
|---|---|
| `src/types/storyGraph.ts` | 版本化领域类型、有界归一化、patch 合同 |
| `src/services/storyGraphService.ts` | 图范围、条件 patch、证据检查、过滤与稳定布局投影 |
| `src/services/storyGraphExtractionService.ts` | 材料冻结、模型预算、结构化候选和证据验证 |
| `src/components/storyGraph/StoryGraphPanel.tsx` | 图谱、工具栏、筛选、交互和提取预览编排 |
| `src/components/storyGraph/StoryGraphNode.tsx` | 主题化节点、类型与确定性标识 |
| `src/components/storyGraph/StoryGraphEdge.tsx` | 多重关系曲线、方向与独立 path 类 |
| `src/components/storyGraph/StoryGraphDetails.tsx` | 节点/关系表单、正式资产绑定与证据详情 |
| `src/components/storyGraph/StoryGraphTimeline.tsx` | 同一图数据的分集/叙事顺序视图 |
| `src/styles/story-graph.css` | 仅关系图作用域、主题变量与减少动态效果适配 |

### 5.2 现有业务文件修改（15）

| 路径 | 改动 |
|---|---|
| `src/types/index.ts` | `ProjectSeriesInfo.storyGraph?` |
| `src/types/scriptWorkbench.ts` | 页签、图 DTO、固定 action 与定位状态 |
| `src/store/store.projects.ts` | 条件图 action、所有者队列、series 合并与恢复 |
| `src/services/storageService.ts` | 图保存/读取归一化及旧保存保护 |
| `src/services/indexedDbService.ts` | 复用项目事务的 revision 条件 patch |
| `src/services/indexedDb/projectSummary.ts` | 安全恢复有界图，保持列表字段白名单 |
| `src/services/projectTransferService.ts` | 旧归档导入导出、分集 ID 映射 |
| `src/services/projectArchiveValidation.ts` | 外部图结构、容量及坏引用校验 |
| `src/services/projectArchiveSerialization.ts` | 导出副本只保留正式图，不含运行态 |
| `src/services/projectExchangeDomain.ts` | 新版快照捕获/还原、分集/资产引用映射与校验 |
| `src/services/projectMergeService.ts` | series 三个原子槽及图整体冲突选择 |
| `src/services/projectImportService.ts` | 新建/更新/独立分支导入后的图与代际处理 |
| `src/services/scriptWorkbenchWindowService.ts` | 图 action 白名单、有界快照、去重确认 |
| `src/components/ScriptWorkbench.tsx` | 懒加载新页签、主窗口调度、出处定位与投影 |
| `src/index.css` | 引入关系图 partial |

### 5.3 测试文件（17，编写但本次不运行）

新增：

- `tests/services/storyGraphService.test.ts`
- `tests/services/storyGraphExtractionService.test.ts`
- `tests/components/storyGraphPanel.test.tsx`

修改已有：

- `tests/store/projects.test.ts`
- `tests/services/storageServiceProjectLoad.test.ts`
- `tests/services/indexedDbService.test.ts`
- `tests/services/scriptWorkbenchWindowService.test.ts`
- `tests/components/scriptWorkbench.test.tsx`
- `tests/services/projectTransferService.test.ts`
- `tests/services/projectArchiveValidation.test.ts`
- `tests/services/projectArchiveSerialization.test.ts`
- `tests/services/projectArchiveRoundTrip.test.ts`
- `tests/services/projectExchangeRoundTrip.test.ts`
- `tests/services/projectMergeService.test.ts`
- `tests/services/projectImportService.test.ts`
- `tests/services/projectImportPersistence.test.ts`
- `tests/services/projectImportRecoveryService.test.ts`

### 5.4 词条与文档（7）

- `src/i18n/locales/en-US/series.ts`
- `src/i18n/locales/ja-JP/series.ts`
- `src/i18n/locales/ko-KR/series.ts`
- `doc/plans/2026-11-06-script-story-graph.md`（本方案）
- `doc/plans/计划索引.md`
- `doc/画布与项目模块.md`
- `doc/文件与存储模块.md`

若实际源码证明需要清单之外的业务修改，先说明新增职责、文件与影响；不把本清单当成修改其他 Agent、MCP、依赖或权限的授权。

## 6. 验收与回退

前置：Tauri 桌面端、至少两集的无敏感测试稿件。先验收人工记录和保存；AI 步骤由用户显式选择模型后启动，会产生该模型的调用用量。

1. 从内嵌与独立工作台打开关系图，新增人物、事件、伏笔并连线，编辑关系说明，拖动、缩放、筛选、切时间线；重开后正式记录和布局保留。
2. 画布停在 A 集，工作台查看 B 集图证据并定位 B 集正文，画布仍在 A；回归未保存草稿的保存/取消保护。
3. 修改证据对应原稿，关系保留并显示来源变化；同名不同人物不被自动合并，多关系与人物环仍可编辑。
4. 同时编辑全剧剧本和图，模拟两个视图保存/重复请求与图 revision 冲突；旧结果不覆盖新图，保存失败不显示已保存。
5. 导出/新建导入/复制/导入更新，核对分集与正式资产引用、图冲突原子选择、中断恢复和重开；坏图与超限数据失败关闭。
6. 显式提取所选稿件，检查预算、进度、取消、候选和原文证据；解析错误、取消、源文变化、网络失联均不改正式图、不自动重投。切换显示方式不重复调用。
7. 深浅主题、长中文/英文名、极长关系说明、空图、断开引用、窄窗、键盘与减少动态效果；大图筛选显示真实总量，图拖动不影响主画布历史。

定向命令供用户按需执行，运行目录为仓库根目录：

```powershell
npx vitest run tests/services/storyGraphService.test.ts tests/services/storyGraphExtractionService.test.ts tests/components/storyGraphPanel.test.tsx
npx vitest run tests/store/projects.test.ts tests/services/indexedDbService.test.ts tests/services/storageServiceProjectLoad.test.ts
npx vitest run tests/services/scriptWorkbenchWindowService.test.ts tests/components/scriptWorkbench.test.tsx
npx vitest run tests/services/projectTransferService.test.ts tests/services/projectArchiveValidation.test.ts tests/services/projectArchiveSerialization.test.ts tests/services/projectArchiveRoundTrip.test.ts
npx vitest run tests/services/projectExchangeRoundTrip.test.ts tests/services/projectMergeService.test.ts tests/services/projectImportService.test.ts tests/services/projectImportPersistence.test.ts tests/services/projectImportRecoveryService.test.ts
```

用户后续要求推送时按现有 pre-push 执行完整 `npm run ci`；本方案不自动授权 Rust 检查、桌面验收或真实模型调用。

回退：关闭关系图入口并保留正式图字段，旧项目继续可用；不删除图、原稿、角色资产或恢复点。旧版本忽略未知字段不等于能够安全编辑新图；需要恢复图时由当前支持版本读取，不能用回退过程清空用户资料。

## 7. 后续阶段（本次范围外）

- 助手/MCP 读取图与提交候选 patch，沿用 Registry/Policy、项目范围和用户当前模式。
- 图谱上下文供结构、主笔、连续性审阅等 Agent 使用；建议先作为候选修订，采纳仍经主窗口条件保存。
- 「如果人物作出另一种选择」的独立剧情分支、多 Agent 推演和比较；模拟事实与正式剧本分开。
- 更大的图按测量结果决定存储拆分、索引和布局引擎，届时单独设计迁移；首期不为未来规模引入平行运行时。

## 8. 实施状态

| 范围 | 当前状态 |
|---|---|
| 领域合同与保存 | 有界 schema/patch、主 Store/数据库条件保存、普通保存护图和安全摘要已写入 |
| 归档与恢复 | 分集/资产身份映射、断开引用歧义拒绝、canonical 排除本机 revision、整图原子冲突槽与还原令牌已写入 |
| 图谱界面 | 工作台新页签、关系/时间线/列表、手动编辑、详情/来源状态、全屏和编辑租约已写入 |
| AI 候选 | 显式文本模型、按源分块、最多 8 次顺序调用、取消、候选映射/选择、源版本复核和显式续批已写入 |
| 回归与文档 | 对应行为/边界用例、三语词条与模块说明已写入；已核对源码、引用、UTF-8 与差异 |
| 应用与测试类型 | `npm run typecheck`、`npm run test:typecheck` 均通过；定向 ESLint 通过 |
| 回归与推送门禁 | 保存/导入/插件、任务控制、结果回读、节点及图谱交互和词条的 14 文件、452 条定向 Vitest 通过；完整 `npm run ci` 由 `scripts/pre-push` 强制通过后才推送 |
| 桌面与真实模型验收 | 尚未运行，待用户按第 6 节验收；自动化结果不代替桌面与提取质量结论 |

首期功能提交为 `908be3f5`。没有安装依赖、增加数据库表/版本或新增原生命令/权限。提交推送收尾修正了 Hook 依赖与异常原因、图谱组件/领域类型重名、枚举推断、可选任务归属和组合包摘要缺失的处理，并对齐会话消息分页返回值、固定会话身份及结果分段回读的回归断言。缺少文本模型的旧管线请求明确失败，不再误记调用结果未知；插件启用先核对自身摘要。组件测试沿用仓库现有 Node 测试边界，不增加 DOM 依赖；不放宽校验或推送门禁。未运行本地 Rust 检查、桌面应用或产品模型。真实模型兼容与费用、长稿提取质量、深浅主题/多窗口和大图操作仍待用户验收。

### 2026-11-07：提取候选兼容修复（待验收）

用户先后反馈「故事关系图候选格式或容量无效」和「图谱证据与本次原文不一致，请重新提取」。源码确认原解析会拒绝完整 JSON 围栏，证据依赖模型填写摘要及绝对偏移，且原始回复被再次 JSON 序列化后计量会虚增容量；上一轮仍会因单条摘录不匹配终止整批，本轮改为对应记录待核实、清空证据，其余候选继续。未取得该次原始响应，不能认定具体是哪条摘录/字段触发；不模糊匹配、不绑定猜测出处。来源身份、正式图校验、取消/代际守卫及无自动重试不变，未增加模型调用。不完整 JSON、结构/字段、错误来源、容量及空材料各有明确提示。

本次未运行测试，待用户验收；前述首期 CI 记录不代表本轮补丁已验证。回归用例已补入 `tests/services/storyGraphExtractionService.test.ts` 与 `tests/components/storyGraphPanel.test.tsx`。桌面端加载本轮代码，保存原稿后选择本集正文提取，应进入候选预览；匹配失败的条目显示「待核实/尚无原文证据」，没有伪造引用，其他有效证据仍能定位。手动勾选采纳待核实条目，正式图仍保留待核实状态，可在详情补证据；采纳前原图不变。核对跨分块中文/emoji/换行定位、主/独立工作台与深浅主题；回归取消、来源变化、错误来源拒绝和失败后原图保留。空白所选稿件应提示先保存材料。仓库根目录可运行 `npx vitest run tests/services/storyGraphExtractionService.test.ts tests/services/storyGraphService.test.ts tests/components/storyGraphPanel.test.tsx tests/i18n/i18n.test.ts`。

### 2026-11-07：图谱取消选择（待验收）

选中是图谱面板自身的受控状态；原实现没有空白点击入口，重复点击会重新读详情，关闭详情也未清除选中，导致高亮和关联淡化残留。现在点击图谱空白、重复点击同一节点/关系或关闭详情，都经过原导航/未保存确认，等待宿主释放编辑租约后清除详情和选中。列表/时间线复用相同切换，保存、删除或定位原文关闭详情时也同步清除；保存中互斥和旧异步完成守卫保持。

本次未运行测试，待用户验收。桌面主/独立工作台分别选中卡片，点击空白、再次点击同一卡片及关闭详情，应恢复当前筛选范围内的正常显示，且不改正式图。回归节点/关系、列表/时间线、全屏及深浅主题；修改详情后取消选择应先确认，「返回编辑」保留原输入和选中，「丢弃编辑并继续」才清除。宿主释放失败或保存未完成时不得丢弃编辑。回归入口为 `tests/components/storyGraphPanel.test.tsx`，仓库根目录命令 `npx vitest run tests/components/storyGraphPanel.test.tsx`。

### 2026-11-07：卡片与点阵形态（待验收）

用户本轮明确授权直接实施、不再确认文件范围。关系图工具条新增 UI Kit 分段「卡片 / 点阵」，默认卡片。点阵使用语义彩色圆点、轻量名称和细连线；方向、自环、并行关系、选中/关联高亮、详情和原文入口沿用既有逻辑。两种形态复用同一 React Flow/编辑器，切换不关闭未保存详情、不丢候选勾选，不调用模型或写正式图；节点尺寸更新后自动适配视图，减少动态效果下适配时长为零。

点阵布局由 `storyGraphService.ts` 的 `layoutStoryGraphConstellation` 对当前投影计算：稳定 ID 排序、固定初始化、80 轮有界静态布局，无持续仿真、计时器或新依赖，最多 200 个可见节点。断开节点、自环和并行关系有确定处理。点阵拖动只改组件内临时位置，绑定图 ID/revision，图版本改变后失效；不触发 `onPatch` 或脏标记。切回卡片使用原先的位置与保存路径，拖动中的形态/展示页签暂不可切换，避免把点坐标误写为卡片布局。形态及临时位置不进入 Store、归档、数据库或窗口协议；新打开的工作台仍默认卡片。

源码入口为 `types/storyGraph.ts` 的展示类型、`StoryGraphPanel.tsx`、`StoryGraphNode.tsx`、`StoryGraphEdge.tsx`、`styles/story-graph.css` 和上述纯布局函数；补英/日/韩词条及两个既有回归文件，未新增依赖、数据库版本或原生权限。此前提取与取消选中修复和四个原有生成 schema 改动保留。

本次未运行测试，待用户验收。桌面端准备含多类节点/关系且已有卡片拖动位置的图谱：切「点阵」应看到彩色圆点网络，缩放、平移、选择/取消及详情正常；拖动点后切回「卡片」，卡片原位置不变，切换本身不保存图。详情输入未保存时往返切换，草稿和选中不丢；候选预览的勾选同样保留。检查方向、自环、同一对节点的多条关系、空图/单点/断开节点、筛选与图版本变化、主/独立工作台、全屏/窄窗、深浅主题和减少动态效果。快速切换/离开图谱时旧适配回调应取消；卡片拖动仍按原条件保存。自动化入口（仓库根目录，供用户执行）：`npx vitest run tests/services/storyGraphService.test.ts tests/components/storyGraphPanel.test.tsx tests/i18n/i18n.test.ts`。回退时固定展示为卡片即可，正式图和卡片布局无需迁移或删除。

独立窗口空白修复：原 React Flow 基础样式仅由主画布导入，独立工作台不加载该模块，导致计数正常但缺少节点/视口定位样式。`StoryGraphPanel.tsx` 现显式加载同一供应商样式，不依赖主画布，不修改窗口快照、权限或图数据。本次未运行测试，待用户验收：桌面端打开已有图谱再点「独立窗口」，卡片和点阵均应显示节点与连线；检查「适配视图」、缩放/拖动、收回后再次分离、主画布及深浅主题。首次打开、空图和单点也应正常，无需重新提取。

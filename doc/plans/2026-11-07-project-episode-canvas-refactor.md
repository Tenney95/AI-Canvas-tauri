# 项目、分集与画布数据模型重构方案

> 日期：2026-11-07。状态：**P0～P5 阶段代码已实施；P6 隔离演练和 P7 前置审计进行中，正式激活与旧数据清理均未实施**。
> 用户已继续授权 P5，重点项目导入导出、旧数据兼容和失败恢复。正式数据库仍为 v27、正式项目包仍为 v3；v4 与新模型写入只允许隔离 fixture。正式迁移、恢复写入和激活开关保持关闭，未迁移真实数据，未接入正式界面/启动。
> 两轮方案复审见第 16 节；P0/P1、P2、P3 的当时范围见第 17～19 节；P4 与后续修复见第 20 节；P5 的实际范围与未验收项见第 21 节。代码已写入不代表迁移、恢复、桌面行为或原生停写已验收通过。
> 主模块：[画布与项目](../画布与项目模块.md)。架构取舍：[ADR-0012](../adr/0012-project-episode-canvas-model.md)。存储、Agent/MCP、插件、导演台仅在本方案维护必要协同边界。

## 1. 目标与范围

把“作品的数据所有者”“分集创作资料”“实际画布文档”分开，解决身份混用、项目摘要过重、最后一集删除连带整剧、配置复制后无法表达继承等问题。新版应能继续打开现有项目，保留现有引用和创作效果，并对迁移中断、旧归档、旧任务及旧窗口给出明确恢复路径。

本方案的推荐默认值：

1. 项目身份稳定。普通项目增加分集时不更换项目 ID，不迁移会话和项目记忆的所有者。
2. 普通项目直接拥有一张主画布；剧集项目拥有零到多个分集，每集首期严格一张画布。不创建虚构分集，不扩展一集多画布。
3. 剧集可以没有分集。删除分集不删除整剧、原著、资产和记忆；删除整剧是独立操作。
4. 新分集支持“项目默认设置＋本集覆盖”。旧分集按原设置效果固定迁移，不自动改成继承。
5. 保留旧项目、分集、画布、节点、资产和历史身份。拆表不搬素材目录，不重写不可变产物和协作历史。
6. 使用现有 React/Zustand、IndexedDB、Worker 和 Tauri 文件边界，不引入第二套数据库或云服务。

不纳入：实时多人协作、季/多级项目树、多画布分集、全局素材云同步、自动恢复付费提交、通用脚本迁移引擎，以及与此目标无关的 UI 重做。

## 2. 当前事实与问题依据

以下为本次核对的源码事实，不代表已复现运行故障：

| 当前实现 | 源码入口 | 影响 |
|---|---|---|
| CanvasProject 同时表示普通项目、剧集容器和分集；没有明确身份判别 | src/types/index.ts；src/store/store.utils.ts | 顶层记录是否拥有画布要看其他记录；类型允许不合理字段组合 |
| 父剧集保存空 nodes/edges/groups，子集保存真实画布 | src/store/store.projects.ts 的 createSeriesLibraryRecord、promoteProjectToSeries | 容器被迫使用画布的序列化与保存流程 |
| 资产、会话和记忆归剧集；任务与多数画布历史按旧画布 projectId 绑定 | src/store/store.chat.ts；src/services/episodeWorkspaceScope.ts | projectId 在不同合同中含义不同，不能全局替换 |
| ProjectSummaryRecord 含完整 episodeScript、episodeOutline、清单和 series；getAllProjects 使用摘要表 getAll | src/services/indexedDb/projectSummary.ts；src/services/indexedDbService.ts | 列表读取同时加载正文和故事图；开销大小尚未测量 |
| 完整记录与摘要在同一个 IDB 事务双写 | src/services/indexedDbService.ts 的 saveProjectToDb | 当前已有一致性保护，不能误判为两份数据必然不同步 |
| 删除最后一集级联删除父剧集与共享目录 | src/store/store.projects.ts 的 deleteProject；tests/store/projectSeries.test.ts | 共享资料不能独立于分集存在 |
| 新分集复制剧集 settings，后续独立 | src/store/store.projects.ts 的 addEpisodes | 不能直接表达全剧默认值与本集显式覆盖 |
| 普通项目升级为剧集、整剧删除是跨记录步骤 | src/store/store.projects.ts | 存在部分完成窗口，需事务与恢复设计；本轮未注入故障验证 |

版本必须分别看待：当前源码 DB_VERSION 为 **27**；归档外层 formatVersion 为 **3**；exchange bundle version 为 **1**；canonicalVersion 为 **1**。现行规则文档中的旧数据库版本概览不能代替 schema.ts。实施当天重新核对版本，使用当时的下一版本，不在本方案预占数据库版本号。

## 3. 备选路线与推荐决策

| 路线 | 优点 | 代价 | 结论 |
|---|---|---|---|
| 仅给 CanvasProject 增加 kind，保持大记录和原保存链 | 改动较小、便于短期收敛 | 摘要体积、跨域保存、共享生命周期仍未解决 | 作为过渡 DTO，不作为终态 |
| 明确领域对象，增加分域仓储；经兼容层分阶段替换旧调用 | 身份、读写和生命周期可以各自约束；可保持旧 ID | 需要迁移账本、协议适配和跨模块核对 | **推荐** |
| 一次更换全部 ID、目录、数据库及归档合同 | 新系统表面整齐 | 引用和回滚风险高，无法小步验收 | 不采用 |

目标是职责分开，而非每个字段都拆一张表。首期维持一集一画布，用明确关系和仓储事务解决问题，不建立无限层级或通用实体系统。

## 4. 目标领域模型

~~~mermaid
flowchart TD
  P["Project：作品与共享归属"] -->|"standalone，0 或 1"| C["CanvasDocument：普通主画布"]
  P -->|"series，0 到多集"| E["Episode：分集身份与排序"]
  E -->|"首期恰好 1 张"| EC["CanvasDocument：分集画布"]
  P --> PD["ProjectContent：原著引用、全剧剧本、故事图、正式资产"]
  E --> ED["EpisodeContent：大纲、剧本、创作要点、本集清单"]
~~~

### 4.1 职责与字段

| 对象 | 核心内容 | 不应包含 |
|---|---|---|
| ProjectRecord | id、name、kind、时间、dataFolder、受限 storageBindings、defaultSettings、lastOpenedCanvasId、持久化 epoch | 分集正文、nodes/edges、base64 缩略图、运行时授权 |
| ProjectContent | projectId、原著相对引用、全剧剧本、故事图、正式 dramaAssets、可选 standaloneCreative、各领域 revision | 画布坐标、真实分集的正文副本、插件运行时 |
| EpisodeRecord | id、projectId、canvasId、name、orderRank、displayNo、settingsPolicy、组合包/团队配置、revision | nodes/edges、全剧资产副本、完整剧本文本 |
| EpisodeContent | episodeId、outline、script、scriptFile、creative、assetRoster、revision | 全剧共享内容、画布状态 |
| CanvasDocument | id、projectId、episodeId 或 null、nodes、edges、groups、持久化 epoch 和正文 revision | 全剧资料、会话、正式资产副本 |
| CanvasPreview | canvasId、现有 WebP 快照、生成版本与时间 | 画布正文、原著和剧本 |

原文仍以现有项目内 TXT 为权威，ProjectContent 保存定位引用；分集剧本延续“数据库正文＋同步 TXT 稿件”的既有产品语义，不在这次拆表中擅自改为只存文件。二者保存继续使用回执、摘要冲突和补偿流程，不能宣称文件与 IDB 具有单一事务。

ProjectContent 暂以单条记录承载现有共享资料；提供分域读取 API。列表不读该表。只有实际测量证明故事图/资产/全剧剧本相互拖累时，再拆独立大对象表，不先建立通用文档框架。

这里的“分域读取”仅是接口职责，不承诺 IndexedDB 对单条对象做字段投影：读取该行仍会克隆行内全部内容。所有更新必须在写事务内读取最新行，仅对目标域应用补丁并核对该域 revision，不能把之前加载的整份 ProjectContent 回写覆盖其他域。故事图 CAS 继续复用这一语义；若实测需物理拆表，另按读取量决定。

兼容例外必须有可用落点：旧 v1 孤立分集导入时会清除 parentId，却保留 episodeOutline/episodeScript/episodeScriptFile/episodeCreative 等。因此，顶层旧记录带这些已知字段时，仍可映射为 standalone，但其资料进入 ProjectContent.standaloneCreative，复用创作正文类型并有独立 revision，不能丢弃、混入全剧 script 或只封存在未知字段中。组合包/团队覆盖、清单和 TXT 引用按源字段一并保留。

standaloneCreative 是普通项目的合法创作资料，UI 以“主画布文稿”读取/保存，任务目标为 Project 下的该文稿域，不伪造 Episode。之后转剧集时，在同一事务将它移到真实第 1 集的 EpisodeContent/集级配置，正文、TXT 和来源身份保持连续；v4 往返必须保留该域。

CanvasPreview 按需读取，项目列表只保留封面指向或 hasPreview；默认取上次画布或首集预览，不把每张预览重新复制进根项目摘要。

### 4.2 必须维持的不变量

- Project.kind 显式为 standalone 或 series，不因子集数量临时变化而变化。
- standalone 可暂时没有画布，正常创建入口同时创建主画布；有画布时只能有一张 episodeId=null 的主画布，不存在 Episode。
- series 可有零集；每个正常 Episode 必须属于一个 Project，且精确引用同项目内的一张 Canvas。创建、删除该 Episode 与 Canvas 在同一业务事务完成。
- 同一 Canvas 不同时属于两集；不支持跨项目移动分集或共用画布。
- 普通项目增加第一批分集时，在同一事务把原主画布绑定到新建“第 1 集”，再创建请求中的新集。项目 ID、原画布 ID、原节点和所有共享资料不变。
- 分集 ID、画布 ID 是两个领域身份。迁移旧数据时允许两张表使用相同原始字符串，新代码通过类型和显式字段区分，禁止靠字符串是否相同推断对象。
- orderRank 仅表示顺序，displayNo 表示用户可见集号，name 表示名称。排序不靠改名实现，换序不改正文和引用。
- 同项目的画布 revision、分集正文 revision 与项目共享内容 revision 分开；不能用一个项目 revision 代替全部并发控制。
- 所有共享状态变更通过 Store Action，仓储负责原子提交；画布修改继续一次业务动作只 commitToHistory 一次。

### 4.3 配置继承与旧效果保持

拟新增判别式设置策略：

~~~ts
type EpisodeSettingsPolicy =
  | { mode: 'legacy-pinned'; snapshot: ProjectSettings }
  | { mode: 'inherit'; overrides: ProjectSettingsPatch };
~~~

- 新建分集默认 inherit：按“应用兜底 → 项目默认 → 本集显式覆盖”解析，节点自己的覆盖/锁定规则继续复用现有生成解析器。
- 旧分集一律 legacy-pinned，snapshot 使用该集旧 settings；旧 settings 缺失时用空对象，仍按旧规则回退到应用默认，**不能意外继承父剧集 settings**。
- 旧普通项目的 settings 进入 Project.defaultSettings，保持现有行为。
- UI 明确区分“项目默认设置”和“本集设置”；旧集显示“沿用旧集独立设置”，用户显式切换继承前显示有效设置差异，不在升级时批量切换。
- ProjectSettingsPatch 不采用无约束深度合并。每个字段声明 inherit/set/clear；模型及提示词后缀按媒体种类合并，风格母图引用作为原子组，数组整体替换。inherit 使用项目默认；set 使用本集值；clear 以显式 tombstone 屏蔽该字段的项目默认，转到应用兜底，无应用值则为空。删除覆盖记录表示 inherit，不能与 clear 混同。
- 例：项目图片默认模型为 A，应用默认模型为 B，本集 inherit 得到 A，clear 得到 B；本集 clear 母图表示不注入项目母图，不删除共享图片文件。此 tombstone 必须参与持久化、归档和三方比较，不能在序列化时当成缺失值丢掉。
- 新增分集、Agent 和普通 UI 使用同一有效设置解析器。母图持久化使用可迁移引用，绝对路径与运行时 URL 只在加载后投影；旧无法安全归属的引用进入未解析状态，保留旧材料而非猜路径。

## 5. 身份与导航兼容合同

### 5.1 旧数据身份映射

本节是**本机原地升级**的保号规则，不适用于导入为新项目、独立复制或兼容副本；这些操作的身份矩阵见 10.4。不能把升级时的保号策略套到外部包上覆盖本机同 ID 项目。

| 旧数据 | 新 Project | 新 Episode | 新 Canvas | 保留规则 |
|---|---|---|---|---|
| 普通顶层项目 P | id=P | 无 | id=P，episodeId=null | 跨表可同值，已有画布历史无需重写 ID；旧 episode* 资料另映射 standaloneCreative |
| 剧集 owner S | id=S | 由已有子集生成 | 不把 owner 的空画布建成第零集 | 共享归属与目录保持 S |
| 分集 E，parentId=S | 所属 S | id=E | id=E，episodeId=E | 旧分集/画布 ID 全保留 |
| 新建项目/分集 | 正常分配类型明确的 ID | 正常分配 ID | 正常分配 ID | 不要求新 ID 延续跨类型同值；立即登记旧接口兼容定位 |

新增 LegacyProjectBinding，记录旧记录 ID、旧角色、projectId、episodeId、canvasId、旧 epoch、来源和迁移版本；键包含旧接口的身份域。映射持久化且幂等，同一源记录重跑不生成新 ID。

同一旧 P 既可作为项目 P，又可作为画布 P，这是分域映射，不是冲突。旧接口按工具合同解析，禁止一个全局 resolveProjectId 自动把所有值变成 owner。

节点、边、分组、镜头行、资产卡片及子项、对话、消息、任务、文件身份、导演 instanceId、AI App instanceId 均原样保留。不全局替换正文字符串、胶囊 token 或未知 JSON 的 ID。

### 5.2 内部执行上下文

新合同使用显式的 ProjectContext、EpisodeContext、CanvasContext：

- ProjectContext：projectId＋projectEpoch＋dataModelGeneration。
- EpisodeContext：以上字段＋episodeId＋episodeRevision/正文 hash。
- CanvasContext：以上字段＋canvasId＋可选 episodeId＋canvasRevision＋canvasEpoch。
- 新版 Task.target 为 project / episode / canvas 的判别式；新版 AgentTask.projectId 与会话 projectId 表达真正的 owner，新 task 另存执行目标。这里描述新版领域合同，**不表示批量改写旧持久任务的 projectId**。

任务拥有分集正文范围，不等于拥有该集画布权限。旧 canvas_write 仍必须精确匹配当前 canvasId、revision 和有效性守卫，不能只比较 owner 相同。

旧每条记录自己的 exchangeEpoch 分别保存到对应新实体并提升失效代际；不能用全剧 max(epoch) 冒充每张画布的旧代际。激活新模型时推进 dataModelGeneration，旧运行时 guard 和升级前的写入上下文全部失效。兼容写入必须携带调用者原先读取的明确版本上下文，具体见 9.1；不能只靠服务端盖上新 generation 就接受缓存旧请求。协作规范内容版本不因本机数据库代际变化而被改写。

### 5.3 Store 与窗口

Store 保留一个全局聚合入口。项目 slice 管根项目与导航，节点/历史 slice 管当前 Canvas；分集元数据/详情优先并入项目领域，只有实现后职责与 Action 数量确有需要才拆新 slice。

- activeProjectId 与 activeCanvasId 分开；画布对应的活动分集由关系派生，避免再持久化一份容易漂移的同义状态。
- 工作台 selectedEpisodeId 独立，允许画布在 A、工作台编辑 B；查看出处和保存稿件不切画布。
- 项目 ready 与画布 ready 分开。空项目是项目上下文，activeCanvasId=null；不能当成全局模式，也不能用空 nodes/revision=0 冒充加载成功。
- lastOpenedCanvasId 指向仍有效画布才恢复；否则选择首个有效集或显示空项目，不自动创建新画布。
- 主窗口仍是唯一持久化、模型与文件执行源。聊天/工作台独立窗口 DTO 升版，快照带明确身份、sessionId、序号及正文版本，保留草稿交接和脏稿保护。
- 不为窗口展示切换重启任务，不把配置凭据或完整画布送给纯展示窗口；不兼容窗口先保留草稿并重新握手，拒绝旧版本写请求。

## 6. 持久化与正常业务事务

### 6.1 拟新增 stores

同一个 IndexedDB 增加以下表，名称为拟议值；现有 projects/projectSummaries 在观察期保留冻结，不在新路径双写：

| 表 | 主键/必要索引 | 用途 |
|---|---|---|
| projectRoots | [generation, id] | 根项目轻量元数据，直接提供项目列表 |
| projectContents | [generation, projectId] | 共享创作详情 |
| episodes | [generation, id]；[generation, projectId, orderRank] | 当前项目的分集元数据列表 |
| episodeContents | [generation, episodeId] | 按集加载正文/清单 |
| canvasDocuments | [generation, id]；[generation, projectId]、[generation, episodeId] | 按需加载画布正文 |
| canvasPreviews | [generation, canvasId] | 按需加载封面 |
| legacyProjectBindings | [generation, namespace, legacyId]；projectId、canvasId | 旧接口及历史定位 |
| archiveHistoryBindings | [destinationProjectId, sourceNamespace, kind, archiveOriginId] | 跨模型版本稳定指向已有历史行；属于来源关联侧表，不随业务回滚倒退 |
| projectModelMigrations | operationId/记录键；阶段和 owner | 迁移清单、校验摘要、断点与异常 |

沿用 metadata 保存 activeDataModel、generation 和删除 tombstone；原有 chat/history/task/asset/交换表先保留，按版本适配其 scope。所有新表行持有目标 generation，仓储必须显式用 active generation 查询；暂存 generation 不对普通读写开放。旧接口的身份域 namespace 至少区分 legacy-root、legacy-episode 和 legacy-canvas；新增 API 如需要稳定旧画布别名，分配一次并落盘，禁止每次调用随机产生。

迁移 ledger 的 operationId 唯一绑定一个目标 generation；激活 manifest 声明全部表的精确键集合、每个 owner 覆盖范围和内容摘要，核对既不能少行，也不能多行。重跑仅清理本次 operation/generation 的待替换记录，不影响旧源或其他已保留 generation。不能仅凭根项目数量相同就激活遗留孤儿行。

archiveHistoryBindings 的迁移候选先登记到 ledger 暂存清单；全局激活时以完成 manifest 声明可读，后续新来源映射与历史行同事务写入。它与旧 task/回执侧表一样不按当前 generation 直接删除，保留来源 provenance；重复源冲突必须人工处理，不能旧 binding 指向另一份历史行时覆盖。

新建索引不能只做 TypeScript 声明；实际升级和已有实例补索引都要覆盖。

新增字段先定义领域类型，仓储和 DTO 从领域类型显式派生。特别核对 creationProfile/teamProfileOverride、TXT 引用与未来扩展字段，避免多份手工白名单遗漏。未知字段保留在隔离的旧材料中，未声明为业务字段前不自动执行或递归注入。

### 6.2 仓储职责

拟新增 src/services/indexedDb/projectRepository.ts，提供 listProjects/listEpisodes、按需读取内容、保存 Canvas、条件保存 Episode/Project 内容、创建/排序/删除的聚合事务。组件与工具不直接选表；旧 fileService/project DTO 在边界适配，不让新业务继续依赖 parentId 推断身份。

正常写入的原子边界：

| 操作 | 同一 IDB 事务 | 文件/运行时协调 |
|---|---|---|
| 建普通项目 | Project＋主 Canvas＋导航/兼容映射 | 目录初始化失败保持可恢复状态，不伪造素材可用 |
| 普通项目转剧集 | Project.kind＋首集关系＋原 Canvas 绑定＋新增分集/Canvas＋映射 | 先保存当前画布和稿件；不搬目录/会话/记忆 |
| 保存画布 | 准确 Canvas＋必要轻量版本 | 不重存全剧正文/资产；保留历史一次提交语义 |
| 保存分集资料 | Episode 元数据/内容＋其 revision | TXT 先准备、条件提交、失败补偿，沿用现有摘要保护 |
| 更新故事图/共享资产 | ProjectContent 中对应域 revision＋必要索引 | 保留故事图 CAS 与资产租约；不能普通保存恢复旧图 |
| 排序 | 两集或整个排序批次＋排序版本 | 不再逐集独立保存后留下半次换序 |
| 删除分集 | 分集、Canvas、关联状态、tombstone、导航更新 | 先停止任务/撤销租约；共享媒体保留 |
| 导入更新/恢复 | 新业务表＋交换映射/修订＋恢复点＋可选历史＋操作完成标记 | 媒体先暂存发布，提交后投影及清理可恢复 |

### 6.3 删除边界

删除分集只删除该集业务对象与其 Canvas，清理直接依附该 Canvas 的可丢弃运行/索引记录；项目会话和共享资产不级联删除。付费提交回执、MCP 幂等绑定、审计任务、账本及必要输出历史保留，并把目标标为 tombstoned；legacy binding 继续用于历史定位但永远不能据此复活 Canvas 或重投调用。会话中的旧画布来源可保留历史标记，不把共享会话整体删掉。

新删除流程不得沿用旧项目删除的“一并抹去全部任务/回执”清单。运行租约撤销、业务数据逻辑删除、计费/幂等审计留存分别声明；是否永久清除历史由独立明确操作决定。

故事图、来源证据或制作引用指向被删分集时，显示依赖影响；采用现有“来源缺失”语义保留历史证据，需移除的强引用由用户明确选择。不能静默删除整个故事图，也不能留下被当作有效授权的悬空目标。

删除整部项目是单独入口，列出分集和共享资料影响。IDB 逻辑删除整批提交，并在同一事务新增持久化目录清理 journal；文件处理在提交后复用既有移入系统回收站能力。当前回收站入口不等于已有跨重启清理待办，也不承诺应用内完整项目恢复，本专项需要补足 journal 与恢复协调。

清理 journal 保存 operationId、ownerId、generation、删除代际、目录的不透明绑定和 phase；删除后可由该记录安全定位，不依赖已删除 ProjectRecord。重试前复核目录仍是原归属，且未被新建/恢复项目复用；不确定时保留目录并提示，不执行删除。失败保留 tombstone 和待办，不能把已完成逻辑删除但文件未处理报告为“本地数据未清理”。不降低现有删除 effect/确认规则。

删除最后一集后保持 series kind，显示“暂无分集”，允许原文、资产、项目设置、会话、记忆与新建分集。项目根没有被删，目录保持不动。

## 7. 现有数据库迁移流程

### 7.1 上线前提与备份

必须先有可读回的迁移备份、恢复入口和故障恢复用例，再允许正式用户进入新模型。备份不是日志、聊天附件或 Agent 摘要；只在应用管理的本地恢复区保存必要数据，界面仅显示操作编号、数量、版本及错误原因，不输出正文、凭据或本机绝对路径。

区分两类材料：

- 迁移恢复材料：冻结旧 projects/projectSummaries、受迁移影响的关联记录与 metadata、schema/index 信息，以及 pollManager 的 localStorage 键 ai_canvas_pending_tasks 原始字节、映射清单、版本和校验摘要。除原始只读源外，在升级前通过旧结构读路径生成独立可读回副本；不能把与源同一个事务/同一份可变对象误当独立备份。
- 旧版应用降级材料：需要完整应用数据库恢复及安全恢复流程，单个 .aicanvas 只覆盖项目业务和可选历史，不等于整库备份。旧库格式恢复不得重置凭据目录或覆盖其他用户文件。

备份容量不足、写入/读回失败时不启动迁移。预检估算旧源、新 generation、备份、转换修订与暂存的合计空间，并在每批写入/首次冻结文件前处理实际配额失败；估算成功不代表后续一定有空间。素材目录不参与本次模型搬迁，记录目录映射及必要存在性检查，不为拆表复制整套大型媒体。恢复功能必须说明后续外部文件变动不在数据库快照内；不得承诺备份了未实际冻结的素材字节。

迁移备份采用独立版本化格式 project-model-backup-v1，不能伪装成普通项目交换包。manifest 记录操作编号、源 DB/schema、每张受影响表/metadata 键的覆盖范围、索引定义、分块数量、字节数和 SHA-256；记录按 cursor 分块写入 UTF-8 材料，Blob/TypedArray 等非普通 JSON 值使用显式类型标签和独立二进制条目，不能 JSON.stringify 后悄悄丢失类型。完成标记最后发布，启动迁移前重新读取并验证全部材料。恢复端按固定格式校验范围、摘要、相对路径与容量，不能将备份当成任意表/任意路径执行指令。

只备份本专项影响的项目及关联数据，凭据目录和 API Key 不进入该项目恢复格式；全局配置/其他数据不被清空重建。旧二进制所需整库恢复与这份项目模型备份分开，未覆盖的全局材料不能宣称已备份。

升级程序应在提升数据库版本前完成旧格式备份准备与写入冻结；重构现有 openDB 初始化入口以避免“先不可逆升级，再尝试备份”。多平台备份写入/读回和新版恢复入口为必做；完整旧格式整库恢复若不能在 P0/P1 落地，明确列为不支持旧二进制直接降级，不阻止用户通过新版恢复已备份的项目数据，不宣传完整无损降级。

### 7.2 状态机与并发屏障

~~~text
preflight → backed_up → schema_ready → staging → verifying → ready → activated
    失败 → failed（旧源保持）     异常材料 → quarantined（显式恢复/选择后继续）
~~~

1. 主窗口取得应用级迁移独占，停止接收新的 Agent/MCP 写入、后台付费提交和媒体轮询/交付写回，等待已接受的保存队列完成，交接/关闭独立编辑窗口。迁移协调器必须先于 pollManager.loadAll 及其他启动恢复器执行；该函数目前读任务时也可能写回 localStorage，不能当作只读预检。无法安全暂停的原生 Job 必须结束或取消后再继续，不能先改数据再等待。
2. 未完成任务按现有暂停/不确定状态保留；撤销插件会话、文件 grant、Director Job 绑定与异步派生 guard。迁移不迁活跃运行时对象，也不触发模型调用。
3. 完成独立备份与读回，关闭旧连接。onupgradeneeded 只新增 stores/index，不做文件 I/O、网络、异步哈希或全库 getAll 大对象迁移。保留 onversionchange 关连接、blocked 提示，不能绕过仍占库的旧实例。
4. 新库打开后处于 migration 状态，所有已适配写入口必须检查 activeDataModel/generation；尚未激活不得普通自动保存、导入、媒体回写或后台清理。
5. 使用 cursor/分批准备，逐 owner 构建映射。源正文以完整 projects 为准，摘要只是缓存；不从摘要替代缺失正文创建空画布。
6. 每个批次把准备好的新记录、绑定和进度清单在同一事务提交，所有行使用该 operation 的目标 generation；新表此时是不可见暂存。整部剧可以分批准备，避免一次结构化克隆全部画布。每个 owner 完成后记录期望实体集合与校验结果。
7. 全部 owner、关联记录和引用完成核对，实际行集合/摘要与最终 manifest 完全一致后，在一个事务提交最终完成标记并切 activeDataModel/generation。应用只有这时才能从新仓储进入 ready；不使用“新表找不到就回读旧表”的正常运行 fallback。
8. 激活失败或应用中断后依据 ledger 继续同一操作。source fingerprint、旧 ID、目标 ID 和 adapterVersion 一致才复用暂存；不一致则撤销该暂存批次并重新准备，不删原始源。

Ledger 至少包含 operationId、sourceSchemaVersion、targetModelVersion、adapterVersion、源 owner/记录身份与摘要、目标实体集合、备份位置的不透明引用、阶段、异常类别及完成摘要，不保存运行时令牌或原始调试日志。它不是只有 migrated=true 的标志。

事务提交前复核源记录 epoch 和完整内容一致性，不能仅看 updatedAt。哈希在 Worker/事务外准备，事务内通过已冻结来源和同步一致性比较做最后复核，不能 await 文件/crypto 后假设 IDB 事务仍存活。

旧应用实例不认识新迁移锁，不能仅取得新程序自己的锁就假设全机已停写。预检要求其他实例退出，升级连接遇到 blocked 即停止；拿到升级后的冻结源后，再逐表/键核对升级前备份覆盖与摘要。若发现备份后仍有旧写入，保留较新的源并重新生成相应旧格式备份、读回核对后才暂存，不能用旧备份覆盖新增编辑，也不能沿用已失效的 source fingerprint。

必须补充可验证的停写证据：旧 schema 的 onversionchange 只关闭 IDB，旧进程的 pollManager 仍可能写 localStorage，因此“没有 blocked”“IDB 连接释放”和一次摘要一致均不能证明旧实例已退出。P0/P1 需完成原生升级/冷启动协调，确认共享同一数据 profile 的旧应用进程、WebView 和独立窗口全部退出，再取得该 profile 的迁移独占；无法证明时保持迁移阻断，不在旧实例运行中在线切换。Web 演示环境不具备这一证据时只提供导出/恢复指引，不自动执行本地库迁移。不能把引入新版本锁误当旧版本已参与该锁。

### 7.3 分类与异常策略

| 旧资料状态 | 处理 |
|---|---|
| 顶层记录有直接子集 | 建 series；每个子集拆为 Episode＋Canvas；owner 空画布不创建 Canvas |
| 顶层无子集且无剧集资料 | 建 standalone＋原主 Canvas，即使画布为空也不猜它是孤立剧集 |
| 顶层带 episode* 文稿或集级配置 | 建 standalone 并显式填充 standaloneCreative；保留 TXT/清单/配置，可继续编辑和导出，不能当未知字段丢弃 |
| 顶层无子集但有明确 series 资料 | 保留为零集 series；若同时存在真实画布内容则进入异常，不能丢画布 |
| parentId 指向缺失 owner、多级父链、环 | 冻结原记录并列入恢复清单，不按同名绑定，不默认升格或摊平 |
| 剧集 owner 自身有非空 nodes/edges/groups | 进入异常清单；用户可明确恢复为独立画布/新增恢复集，不能静默当空容器 |
| 集号缺失/重复/有缺口 | 保留旧显示数据；按迁移前实际排序冻结 orderRank，记录原顺序。重复集号不导致身份合并 |
| 子集重复保存正式资产 | 先按现有 owner 权威；差异副本保存为待恢复材料，不静默并库或丢弃 |
| 父 dataFolder 缺失、子目录独立或旧 ID 回退 | 按每个旧资料域实际解析结果登记 storageRootRef；保留既有物理位置，不把全部子集强制解析到 owner ID |
| 只有摘要、正文缺失/损坏 | 保留摘要和旧材料，标记无法加载，不生成空正文覆盖原资料 |
| 已知可迁移但缺少素材 | 结构与引用照常保留，标明离线/缺失，迁移不触发清理，不伪造预览 |
| 未知未来版本、无法识别的执行字段 | 拒绝将其激活为可执行业务数据，保留来源并提示所需版本 |

异常不触发自动破坏性修复。有效项目可继续暂存，但全局切换前必须确保每条旧记录都有有效映射或明确的只读隔离归属。用户可在恢复页明确选择隔离异常项目后使用其余项目；界面应报告部分隔离，不能声称所有数据迁移成功。隔离项目的资产不得进入垃圾回收候选。

顺序转换先记录迁移前 listEpisodes 的实际结果，明确同集号的稳定次序；不靠迁移后重新排序猜测原顺序。所有源记录及恢复记录用 UTF-8 保存，中文正文、名称、BOM 和 TXT 换行方式不在迁移中重写。

### 7.4 文件与目录保持

- 预检对每条旧记录和引用域记录实际目录解析结果。当前 withInheritedDataFolders 仅在父 dataFolder 存在时继承；父字段缺失时，子集可能仍使用自己的 dataFolder 或子集 ID目录。不能把“业务归属 owner”误当“旧文件必在 owner 目录”。
- 普通单根项目沿用原 dataFolder；存在旧多根时，在 Project 的受限 storageBindings 和 legacy binding 中保留 storageRootRef，指向已核实、相对应用数据根的旧目录定位。Canvas/分集文稿/共享资产各按原解析域选择 rootRef，同名相对路径不跨根合并。不持久化 grant 或任意绝对路径，也不靠扫描同名文件猜根。
- 不重命名目录，不改变 manuscripts、imports、分组目录，不迁原生私有目录，不移动全局/外部资产。
- 保留 TXT 的 fileName、relativePath、digest、sourceName，保留原著引用与文件字节；迁移不补写缺失 TXT。后续显式保存才走现有同步/唯一命名/摘要冲突流程。
- AI App definition、Blender Scene、Result Manifest 与其他不可变项目产物的路径、大小和摘要保持原值。不因换表重生成 JSON 后沿用旧摘要。
- 文件改名/移动必须显式识别模型与 generation：只更新活动 generation 的可变内容/Canvas 及允许修改的关联记录，同时核对事务内 activeDataModel/generation。旧 projects、非活动 generation、隔离材料、迁移备份、导入恢复点和不可变交换快照均排除原地重写。metadata 采用允许修改的键分类，不能沿用扫描全部 metadata 的通用递归替换。
- 现有 mediaRelocations.ts 的表清单和全表 cursor 不能只追加新表了事。恢复旧材料时，仅在工作副本上按经过验证的路径 journal 投影，再核对文件身份/摘要；冻结来源及其校验值保持不变。路径改动也不能让缓存旧 generation 的后台写入恢复有效。
- 全部文件路径仍通过 fileService、现有相对路径校验和 Rust path_policy；升级模型不放宽 capability、私有目录、符号链接或路径授权。

## 8. 关联数据迁移清单

仅迁项目表不够。以下各项必须有适配器和回归样本，按字段合同处理，不执行全文 ID 替换：

| 数据 | 目标归属与兼容动作 |
|---|---|
| 普通会话/消息、项目记忆 | Project owner；原 conversation/message/memory/source ID 不变，分集来源单独标记 |
| MCP 控制会话 | 保留原 mcp-control-旧画布ID 的会话 ID及回执关联；增加 owner 与明确 Canvas target，不从新 owner 重建会话 ID |
| AgentTask/团队/子任务 | 保留 taskId、父子关系、累计预算与阶段；工作台 target 依据现有 workbenchTarget/teamRun.target 转 Episode，其余已知画布任务转 Canvas；不能识别的暂停待定位 |
| 任务审批与历史工具结果 | 保留审计展示和关联，不把旧审批转成新模型下的执行授权；恢复时重新核对作用域与代际 |
| 输出历史 history | 原 projectId 是旧画布身份，原值通过 canvas alias 查询；不合并同剧不同集的 node/history |
| Agent canvasCheckpoint/撤销历史 | 显式 canvasId＋history generation＋revision 连续性；旧 checkpoint 可展示，不跨迁移代际直接回退。现有未持久化撤销栈不伪造成可恢复历史 |
| Canvas WebP、visual descriptions | 归 Canvas；保留 fingerprint 范围，不能把同剧的唯一索引合到 owner |
| 视频剪辑工程 | 保留原复合 ID（旧画布ID::nodeId）、媒体和工程状态，查询适配 Canvas scope |
| 视频批次/复刻任务 | 保留 video-batches、video-replica-jobs 的旧键及指纹、回执、unknown 状态；不自动重投 |
| 通用媒体 pending tasks | 备份并冻结 localStorage 的 ai_canvas_pending_tasks；适配 MediaTaskReceipt/MediaTaskContext.projectId、history.recoveryTask 和消息关联；taskId、attemptId、已提交/提交不确定/待交付状态不变 |
| 方舟用量账本 | Rust SQLite 的 app_project_id 保留旧画布 ID；项目汇总由 Project→Canvas 集合读取，不改写历史费用或价格快照 |
| 资产索引/元数据/S3 | 项目 owner、assetId、源目录、sharedProjectId、generation、outbox/conflicts 保留；不触发自动上传/远端删改，不重新匹配同名资产 |
| MCP operation binding | 保留 bindingId、operationId/taskId、keyDigest/inputDigest、sequence 和状态；旧 key 按旧 Canvas 命名空间查，不能重算后新建付费任务 |
| 项目交换身份/快照 | 保留 lineage、逻辑 ID、墓碑、原不可变 revision 与摘要；仅本机位置映射适配 |
| 导入 operation/recovery metadata | 旧 ProjectSaveData[] 先经版本适配再恢复；保留冻结素材和引用，不把旧恢复点当新结构直接覆盖 |
| last-active-project/默认项目 | 旧画布 ID 解析为 Project＋Canvas；default 是旧特殊身份，按实存记录处理，不在重跑时另建默认副本 |
| project-deleted/输出历史迁移标记 | 保留原键防迟到写复活，新类型化 tombstone 并存；已退役 ID 不重新发号 |
| 插件、Director、AI App | 持久节点/定义/场景身份保留；运行租约、grant、进程和窗口不迁移，重新建立且绑定准确 Canvas |

实际核对入口包括 schema.ts、indexedDbService.ts 的删除级联清单、pollManager.ts、types/aiTypes.ts、videoEditorRepository.ts、videoBatchRepository.ts、plugins/pluginVideoReplicaJobRepository.ts、billing/volcengineBillingService.ts、mcp/mcpOperationService.ts、indexedDb/mediaRelocations.ts。实施时对每个 store/metadata/localStorage key 形成覆盖清单，未分类项视为迁移缺口，不用通用递归改写兜底。

### 8.1 旧关联记录的版本适配

首期冻结旧 task/operation/binding 的原 projectId 字段和强关联，不单独把 task.projectId 改成 owner。无 schemaVersion 的旧记录视为 legacy-scope-v1，由读取适配器派生 ownerProjectId＋targetCanvasId/targetEpisodeId，原值只用作旧合同身份。旧 mcp-control 会话 ID及其归属定位按相同版本读取。新创建的记录使用显式 schemaVersion=2 与 owner＋target 合同。

已有记录后续状态更新继续通过其版本对应的完整仓储合同，不让新版领域 DTO 整条覆盖旧记录。MCP 的 task/operation/binding/conversation 关联按版本验证；不能沿用 projectId 全等的旧校验去比较新版 owner 与旧 Canvas。若将来统一物理升级这组记录，必须作为单独原子迁移处理并保留原键，不能分批只改其中一表。

查询层对旧记录按该项目的旧 Canvas/owner alias 集合读取，对新版按 owner/target 索引读取，按原 taskId/operationId 去重；分页、排序和游标也带 schema/scope 版本，不能先分页一个旧 Canvas 再误称已列出全剧任务。旧历史材料的版本读取不等于正常业务表缺行时回退旧项目表。

### 8.2 localStorage 媒体任务边界

本次不顺便搬迁整个媒体队列表。ai_canvas_pending_tasks 保留原键和旧回执，通过带版本的读取适配器派生明确目标，新任务写新版记录；读取旧格式不得先执行破坏性 normalize/writeback。损坏或未来格式保留原串并提示恢复，不把解析成空数组视为已无任务。

IDB 与 localStorage 不构成原子事务：迁移暂存阶段不改该键，最终激活由 IDB marker 决定，激活后媒体恢复器才读取兼容视图。备份记录该键摘要；若迁移中来源改变，停止切换并重新核对。若后续确需物理重写该键，必须另有两阶段 journal，不能夹在激活事务中假称原子完成。

confirmed/submitted 只允许按原回执继续查询；submit_unknown 只允许核实/人工恢复；delivery_pending 可恢复已有产物下载/消息交付，均不得重新提交收费请求。原 Canvas 已删除时不得回写节点，保留历史/聊天交付入口并显示目标已删除。任务租约必须绑定新模型下核实后的 owner/Canvas 或消息身份，旧 hash/回执正文不重写。

## 9. MCP、CLI、Agent 与原生边界

### 9.1 接口兼容矩阵

| 合同 | V1/旧接口 | 新合同 |
|---|---|---|
| project_list/get/open | 保留原根/分集定位；有画布时保持旧字段语义；零集项目返回 currentProjectId=null 并附 activeProjectId/contextKind，不能把根 ID冒充画布 | 明确项目列表、分集列表和 openProject/openCanvas |
| canvas_* 的 projectId / expectedProjectId | **继续解释为旧画布身份**，按 alias 精确匹配当前 Canvas | expectedContext：projectId、canvasId、revision、epoch/generation |
| episode_* | 原分集 ID 保留，只授权正文/清单等既定域 | projectId＋episodeId＋正文版本/hash |
| 工具 read/write context | 由工具分类适配旧 scope，不提升为整剧写权限 | 判别式 Project/Episode/Canvas context |
| 幂等操作查询 | 原画布命名空间和 receipt 可查 | 新请求使用明确目标 scope；查旧任务复用原绑定 |
| 工作台 RPC/聊天快照 | 不兼容写请求拒绝并交接草稿，不猜版本 | 带协议版本、明确目标、session/sequence/revision |

scripts/ai-canvas-cli.mjs、MCP tool catalog、Rust bridge 信封、工具 Registry schema 和应用内调用必须同步核对。旧 ID 语义、读取和历史回执兼容至少覆盖新模型首个稳定发布系列；**完全不支持新版本上下文的旧客户端不能无条件保留写入能力**，需明确升级提示，不能把此边界宣传成所有旧客户端零改动可写。

复审修正：不为本次数据重构新增“绑定一条物理连接的随机 contextToken”前置机制。现有 CLI 每次请求后关闭连接，这会使分两次执行的读取/写入无法复用 token；写前自动刷新 token 又会把缓存旧意图改绑到当前目标。采用可跨连接传递的、版本化 expectedContext，沿用既有传输鉴权与 Policy。expectedContext 是并发条件，不是授权凭据。

上下文判别式为 global / project / episode / canvas。global 仅携带本数据 profile 的 modelGeneration 与必要目录版本，支持启动页创建/打开项目，不要求已有 owner/Canvas；project 加 projectId/projectEpoch；episode 和 canvas 再加入准确目标及版本/hash。旧信封扩展或 V2 都必须明示 schemaVersion，兼容层按原 ID 语义转换，绝不由当前选择补写缺失目标。

升级撤销旧服务端请求队列和运行时会话。所有新的变更请求须提交调用者先前读到的 generation 及该工具需要的精确前置条件；CLI 只原样传递，跨进程调用仍有效。缺失或过期返回 CONTEXT_REFRESH_REQUIRED，由客户端重新读取、重新判断原意图后显式重发，不能客户端/服务器自动改写旧请求并执行。内部 Agent 也使用任务启动时捕获的 typed context，不能切画布后自动改绑。

没有 Canvas 的 project_open 成功只表示项目打开，返回 contextKind=project、activeProjectId 和空的旧画布字段；旧客户端若要求画布，返回明确 NO_ACTIVE_CANVAS，不能自动创建画布满足旧协议。

operation_get 等纯回执查询不要求变更前置条件，也不要求目标仍是活动 Canvas。通过原 operation/binding 定位 owner，再验证属于当前 Project 的历史范围；已删除的 Canvas 可以返回只读 tombstone 回执。整 Project 已删除的记录通过任务中心/恢复页建立的明确只读审计上下文读取，不能借历史 alias 获得文件或画布写权限。原 operationKey 的新提交仍要有效写上下文，不把查询例外扩展为重投权限。

### 9.2 权限与运行时

Plan/B/C/MCP effect、user_choice、媒体显式选模、重试规则、预算、记忆确认和子智能体只读边界全部保持。对象拆分不增加权限。

空项目可以读取/编辑项目资料、原文、资产、项目记忆与会话，创建分集，打开工作台和发起其权限内的项目文本任务。首期没有 Canvas 时不发起新的媒体生成，**包括 deliveryMode=chat 的付费生成**，避免引入新的无画布计费/提交合同；已有项目在 Canvas 就绪时保留 chat/canvas/both 三种交付。旧的仅聊天交付任务仍可按原回执查询/恢复已有结果，不能因目标无画布就丢失或自动重投。

没有 Canvas 时 canvas_*、画布截图、插件节点 UI 和 Director Job 同样不可用；工具发现和 authorize 对相同上下文给出一致结果，不能因无 Canvas 切换成全局授权。

CanvasDerivationGuard、插件 UI 租约及原生 WebView 登记、Blender Job/result 回填同时绑定 Project 归属与 Canvas 目标。保留插件双摘要、真实窗口/session、nodeId、instanceId、Scene revision、artifact 校验；Renderer 和 Rust 的身份合同必须同时适配，不把 owner ID 当结果投影权限。

重启后未完成任务保持 paused/unknown 等既定恢复状态，不自动恢复付费提交；modelRounds、toolCallCount、tokens、resumeCount 和父子组预算原样保留。切项目、切集和切窗口不刷新预算。

## 10. 项目归档与三方合并兼容

### 10.1 版本策略

推荐终态原生格式为：外层 .aicanvas **v4**、规范快照 **canonical v2**、exchange bundle **v2**。Bundle v2 明确支持跨 canonical 版本祖先与迁移修订；这是拟新增合同，当前解析器不支持。

仅内部拆表、仍可完整投影为旧根＋子集时，保留 v3 适配器用于过渡验证和受限兼容导出。涉及零集剧集、继承/clear 语义、Project/Episode/Canvas 独立身份或其他 v3 无法完整表示的内容，不输出伪装成无损的 v3 包。

| 输入/输出 | 新版处理 |
|---|---|
| v1 旧包 | 先走现有旧格式校验；孤立分集按独立项目导入并提示缺失，不按 parentId 绑定本机整剧 |
| v2 旧包 | 转新领域结构，可新建导入；无可靠祖先不伪造三方基线 |
| v3 旧包 | 按 canonical v1 验证业务正文、文件和 exchange-state/head 一致后适配；保留原 lineage、版本图及逻辑身份 |
| v4 新包 | 严格校验新归属、顺序、引用闭包、容量和跨版本修订；导出前仍用接收端校验器自检 |
| 旧应用读 v4 | 明确拒绝并提示升级，不能忽略新字段后再次导出 |
| 新版导出 v3 | 同 lineage 导出必须证明当前正文及所有必要修订/祖先均可被旧 bundle1/canonical1 验证；存在必要 canonical2 历史时拒绝。可另行显式创建独立 lineage 的“兼容副本”，列出语义/历史损失，不冒充原协作分支 |
| 未知未来版本 | 失败关闭，保留原包，不尝试降级解析 |

首个正式激活新模型的版本应同时具备 v4 导入、导出、恢复与校验。只完成内部仓储阶段不能先放开新版独有语义，再让用户无法导出或恢复。

“当前画面能投影”不足以证明 v3 无损。不得为兼容导出回退旧 head、截断已接受父链、改写 canonical2 修订或删除必要祖先。激活后产生新规范历史的项目默认使用 v4；兼容副本是明确新来源，不影响原项目已接受版本。

### 10.2 逻辑身份与跨版本历史

- 本机 ID 与协作逻辑 ID继续分离。迁移旧 scope/kind 时建立持久化类型映射；原节点/文件/分集逻辑 ID不因拆表被识别为全量删除重建。
- canonical v1 修订的原始正文、revisionId、contentDigest、父链均不可原地修改。新规范转换产生新的 v2 迁移修订，保留同 lineage 并将原 head 作为明确版本化父引用。
- Bundle v2 的修订标识应携带 canonicalVersion；摘要覆盖版本、父引用和 adapterVersion 等实际合同。不能把新正文装进旧 revisionId，也不能靠时间推断父关系。
- 查共同祖先时先验证各修订原文与摘要，再通过确定性适配器把 B/L/R 投影到同一比较模型。投影是派生比较视图，不冒充原始修订；迁移默认值必须来自各自快照，不能套用当前本机设置。
- 只改存储、没有业务变化时，适配前后的语义比较应为空。跨规范合并成功生成新 v2 head，保留双方可证明父链与冲突选择结果。
- 无完整基线正文、转换不完整、父链丢失/循环、多个不可比较祖先或未知版本时，停止自动三方合并，使用现有补材料/人工比较流程。不从实体缺失推断删除。
- 保留逻辑删除墓碑和重复导入识别；导入同一版本不重复建立实体，不因升级重置已接受远端状态。

v1→v2 的新增逻辑实体 ID（例如从旧集 scope 拆出的 Canvas）必须由旧 lineage/逻辑 scope 和冻结的 adapterVersion 确定性派生，或由双方已有的明确映射证明；不能用新本机 ID/随机数生成后声称是同一逻辑对象。无法从旧材料证明的顺序、归属或历史映射不得伪造为“升级无变化”，应显示明确冲突或人工关联。

### 10.3 归档文件与恢复点

v4 保留现有受限 tar/gzip、assets 路径及摘要能力；拟提供明确版本化的 project/episodes/canvases/contents/交换 JSON。具体 JSON 清单在 P0 定义，所有表示同一内容的正文与 sidecar 必须一致，避免双权威。

Rust project_archive.rs 当前不解释业务 manifest 版本，可复用其封包、UTF-8 文本、大小及路径保护；新增业务格式并不意味着放宽条目/体积、PAX/GNU 解析、链接、私有目录或调用方检查。是否需调整原生 JSON 名单/预算按实际实现核对，不能假定只改前端就能发布。

旧导入恢复点保存的是旧整组 records，恢复前经旧格式适配并验证冻结素材。恢复仍经新聚合事务，先建立恢复前恢复点，再产生新修订，提升 epoch；不能倒退到原 exchangeEpoch。

明确区分：CanvasPreview 是封面；交换 checkpoint 是协作不可变修订；导入 recovery 是业务/文件恢复点；Agent canvasCheckpoint 是依赖历史连续性的执行回退。四者不能互代。

### 10.4 原地迁移、导入与复制的身份矩阵

| 操作 | 本机 Project/Episode/Canvas 与目录 | lineage/逻辑身份 | 运行与审计 |
|---|---|---|---|
| 本机模型升级 | 原 ID和实际目录保留 | 原来源和不可变历史保留，新增确定性类型映射 | 本机回执/预算保留，运行时撤销 |
| 归档导入为新项目 | 分配新本机根/集/图 ID和新目录；按类型映射全部引用，不能占用包内同 ID本机条目 | 合法同来源包可延续 lineage，逻辑身份不因本机换号变化 | 仅可选追加脱敏历史，不导入可执行任务/凭据/云绑定 |
| 更新已有项目 | 保留选定本机目标及其映射，新增实体再发本机 ID；不覆盖目标目录位置 | 依据共同来源/基线合并；不按名称或数组位置匹配 | 当前本机提交事实不被包内数据覆盖 |
| 独立复制/兼容副本 | 新本机身份和目录；节点等域内 ID按完整适配规则保留或重映射 | 新 lineage；不把原已接受版本宣称成副本的共同历史 | 不复制运行授权、MCP 幂等键或收费运行状态 |
| 恢复旧业务内容 | 保留当前本机身份和经核实的当前目录，写新恢复 generation | 当前 lineage 下产生后继修订；不回滚已接收父链 | 按第 11 节单调保留真实提交事实 |

普通导入不等于独立复制；同来源多个本机副本仍需用户选择更新目标。现有 v1/v2 的 restoreProjectArchive 逐条保存分支、v3 的 applyProjectImport 分支和 duplicateProjectArchive 都必须接入新聚合仓储/操作 journal，不能只改其中一条链。已知字段、节点/文件引用、故事图、TXT、历史来源和只读绑定均经过相同领域适配，不使用字符串全局替换。

### 10.5 导出的一致捕获与发布

1. 先处理本项目所有受保护草稿：保存/明确放弃，或明确导出仅包含已保存内容，不能把未保存工作台稿件静默当成包内最新稿。等待该项目保存队列，捕获 active generation 和项目身份。
2. 在**一个只读 IDB 事务**中获取 Project、ProjectContent、全体 Episode/EpisodeContent/Canvas、必要历史绑定及交换状态的完整快照，包含实体集合和每域版本。拆表后不能继续独立多次 get 拼装；可选历史捕获每个会话的消息 sequence/版本边界及可见行集合，分页读取限于该边界，行被修改/删除则重捕获，不能把多页不同时刻材料当作同一快照。
3. 由固定 Worker 对该快照生成规范正文与归档 JSON；跨事务/序列化/媒体扫描前后复核 generation、实体集合及域版本，变化则重新捕获或明确失败。字节/文件摘要对应实际入包文件，不能用旧摘要打包新字节。
4. 区分本机准备修订与成功交接：允许存不可变准备材料，但新 exchange 状态需分别表达 localHead 与已发布操作/已交接锚点。prepareExchangeExport 的 checkpoint 成功不等于输出文件已发布；导出取消/Worker 失败/打包失败不能推进已发布标记，也不回退有效本机编辑。
5. 使用固定 exportOperationId 和 prepared → packing → published → registered 状态；原生继续临时文件、条目/摘要复核后发布。发布成功但登记回执丢失时，按原不透明输出授权和包摘要核实同一文件，不能盲目覆盖/重复发布；无法重新核实时保留待确认状态，不猜成功。

v4 同时检查原始条目数、JSON 总大小、规范快照大小、修订数/祖先闭包和媒体总量。旧 v3 接近现有限额时，新增类型/迁移修订的开销也必须在激活前试算并经真实序列化校验；不能升级成功后才发现原项目无法完整导出。超限先保留旧权威/恢复导出能力并说明缺口，不静默裁剪历史、不降低安全预算绕过校验。

### 10.6 导入操作中断与媒体收尾

新建导入、更新、独立复制统一使用 prepared → media_publishing → media_ready → db_committed → projected → finalized 状态。预览取消不产生可见项目、不改目标文件；提交前复核目标 generation/epoch、完整实体集合/域版本、当前 head 和预览内容摘要。包在预览后变化、目标新增/删除集或任一相关域更新，均重新预览，不沿用旧选择覆盖。

Journal 持久化 operationId、目标身份/代际、新分配 ID映射、暂存/发布目录不透明引用、文件大小/摘要、预期 state 和阶段。原生只发布本操作新目录，不覆盖已有媒体。新业务表、history origin 绑定、交换修订/状态、恢复点、目录清理待办和 committed 标记在同一 IDB 事务提交。

失败/重启按实际标记判定：数据库未提交，只能撤销本操作未被引用的新增 ID/媒体，原项目与恢复点不变；数据库已提交，不得因为前端返回失败删除已引用媒体，也不能再次执行同一合并。重新读取已提交状态投影 Store/窗口，迟到旧自动保存仍被 epoch 拒绝。无法确定目录是否仍被活跃/恢复/隔离资料引用时保留并提示，清理不是扫描 imports 后全部删除。

恢复点制作与入包素材清单分开：恢复副本、迁移备份、失败暂存和审计材料不能被顺手导出。正常附件及当前有效 imports 仍按现有文件范围保留，不能为排除恢复材料而漏掉用户未挂节点的普通项目附件。

### 10.7 归档历史的稳定来源与已删除目标

历史追加去重不能只依赖迁移后的 owner 重新生成行 ID。现行 stable 历史 ID包含 projectId，旧分集历史迁到根归属后，后续同 lineage 新包会可能生成另一组 ID。拟新增 archiveHistoryBindings，以稳定目标项目身份＋来源 namespace＋kind＋archiveOriginId 映射到既有 conversation/message/memory ID；迁移时从旧资料建立映射，后续追加先查映射并维护来源闭包，不按可变 owner 重算已有行 ID。

映射、历史行与来源引用在同一导入事务更新；同一来源不能因包版本变化或归属转换重复追加，也不能覆盖用户改过的本机历史。来源不明或同一 origin 有歧义时展示冲突，不按同名/正文相同合并。只导入记忆不导聊天时继续标记 source unavailable，不伪造本机会话。

删集后保留的工作台会话/故事证据必须可往返。v4 为历史目标提供显式 retired/tombstoned 逻辑身份（kind、logicalId、owner 和不可执行状态），与活动实体引用闭包分开。工作台历史目标为 active 或 retired 的判别式；失效集仍保留只读出处，导入不创建恢复集，不删除绑定把会话降成普通可执行会话。

该历史目标描述是已接受历史的显示材料，不是删除证明、跨项目关联授权或执行 target。显式内容恢复重新出现同一逻辑实体时，原 retired 历史仍可共存并保持只读，不能据活动实体存在就重新激活旧会话绑定。v4 收件校验、可选历史导入、三方合并、再次导出均需认识此表示；v1/v2/v3 的旧规则仍按原格式校验，不放松旧解析器以接受未知版本。原生运行任务、文件 grant、插件信任和凭据不随历史传播。

### 10.8 旧多根素材与不可变文件

旧多根项目导出按 7.4 的真实 rootRef 收集各根的有效材料。文件逻辑身份至少区分来源 rootRef＋相对路径，同路径不同根不覆盖、不按同名字节猜合并；同字节可去重物理载荷，但逻辑资产继续独立。

v4 包仅携带安全归档路径和逻辑 rootRef，不携带本机绝对目录。新建导入将来源根映射到新项目下已授权的相对子根，更新导入沿用本机已验证根映射；同名冲突使用本操作唯一安全路径。不可变 Scene/Result Manifest/AI App JSON正文不因目录变化被重写，内部相对引用由其根上下文解释，字节与摘要保持一致。若该产物无法无改写适配，导入前明确拒绝该项，不能发布出接收端无法还原的包。

多根收集、同名路径、TXT/导演产物与普通附件必须有完整往返样本；旧 v3 不能无损表示时走已声明的拒绝/独立兼容副本路径，不隐去第二个素材根后称导出成功。

## 11. 中断恢复、回滚与降级边界

| 阶段/故障 | 处理 | 可以承诺的范围 |
|---|---|---|
| 预检/备份失败 | 不升级、不改源，提示修复空间/连接后重试 | 原格式继续可用 |
| 已加新表，暂存未完成 | 新程序留在恢复页，复用 ledger 继续或清理本次暂存；不对旧源做逆向猜测 | 旧源完整，模型尚未激活 |
| 激活事务中断 | IDB 标记/数据提交原子判断，重开核对 marker，不靠 UI 上次进度猜结果 | 只读取一个确定权威 |
| 激活完成但尚无新写入 | 新程序可经受控流程恢复旧逻辑数据；generation 仍推进，旧租约不复活 | 业务内容可恢复到迁移点 |
| 激活后已有新编辑 | 先制作并读回专用恢复前安全备份，再按 11.1～11.3 恢复内容及协调副作用 | 用户作品编辑可回退，真实提交/预算/回执不倒退；材料不足不能声称完整恢复 |
| 文件提交/清理不确定 | 查原有 receipt/日志/摘要，保留原文件，清理可重试 | 不猜成功、不自动重复付费调用 |
| 需要旧二进制降级 | 使用升级前完整数据库备份与经验证的旧格式恢复流程；否则使用兼容包在独立数据环境导入 | 旧程序不能直接打开提升版本后的同名 IDB；保留旧表不解决 VersionError |

首版不承诺任意新版内容无损降级到旧二进制。未实现并验证完整旧库恢复时，产品只能承诺新版恢复入口及明确范围的兼容导出，不宣传“一键无损降级”。备份/恢复未验证是发布阻塞项，不能让用户手动删除数据库试错。

### 11.1 恢复不是把全部关联表倒回旧快照

迁移备份和恢复前备份的保存范围可包含审计数据，但恢复执行器必须分域处理：作品内容、结构和配置可按用户选择恢复；任务/operation/binding、付费提交回执、累计预算、已确认结果、unknown/delivery_pending 和本机审计墓碑不得退回更早的事实。没有某条记录不等于“未提交”。SQLite 账本保持原样。

回滚前先停止全部写入和媒体恢复器，创建并读回**专用的恢复前安全备份**，覆盖当前新模型、身份/墓碑、相关 IDB 侧表、localStorage 原队列与操作 journal。普通 .aicanvas 不包含全部任务/绑定/队列，不能替代该安全备份。备份失败则不回滚。

恢复合并按原 taskId/attemptId/operationId/bindingId 做版本校验：同一身份保留可证明的较新 sequence 和累计计量；分支状态无法判定时保留两份证据并置为需核实，不用简单状态大小排序。旧 key 的绑定不可释放。恢复后被移除的新建 Canvas/分集仍保留审计 alias/tombstone，历史可查但不能重新执行。

### 11.2 恢复事务与跨存储中断

恢复过程独立使用 restoreOperationId 和状态机 prepared → staged → idb_committed → side_stores_reconciled → ready，明确 restoreScope 为单项目或全体项目。先核对当前 generation、数据集合、协作 head 和媒体闭包，不把 activeDataModel 指回过时逻辑版本，不清空整库重建。

单项目恢复复用当前 active generation 的项目聚合提交，事务内只替换该项目的工作副本并提升相应 epoch/revision；其他项目及其别名不变。**不能只写一个项目到新 generation 就切换全局指针**，否则其他项目会不可见。模型级全体恢复才准备新的完整 generation，manifest 必须覆盖所有保留项目，包括不选择恢复的当前项目；完整核对后才能全局切换。

IDB 原子提交恢复业务、单调审计合并、交换修订/墓碑、必要 marker 和恢复 journal；提交前仍复核实际来源，失败保持当前权威。暂存准备不能给正常读写提供回退路径。

IDB 提交后若 localStorage 合并未完成，重启进入恢复页并根据 journal 幂等续接，禁止正常轮询、写入和新收费请求；不能因为新 generation 已存在就解除启动屏障。localStorage 保留当前真实提交证据并合并旧证据，不恢复成迁移前原串。无法定位的目标转为只读待核实，不丢队列。所有侧存储核对完成才标 ready。

恢复后，受影响项目/实体 epoch、stateVersion 及各域保存 revision 均推进到大于当前值，不能直接恢复备份中的旧计数；全体模型恢复还推进 dataModelGeneration，局部恢复保留全局 generation 并使用项目 epoch 使旧目标失效。协作业务恢复仍产生当前 head 的新后继修订，不回退已接收的父链、lineage 或重复导入标记。

### 11.3 素材与目录的可恢复边界

模型迁移不复制整套媒体，只能保证迁移时不改其字节。激活后若发生重命名、搬目录、覆盖或删除，数据库旧快照本身不足以恢复原文件。恢复前必须将引用投影到当前已验证目录/路径 journal，并按资产身份、大小和摘要检查闭包；不能把旧 dataFolder 原样写回后误读已改名目录。

应用控制的文件破坏性操作，在迁移备份/导入恢复点仍引用该版本时，需先冻结待覆盖/删除字节或保持可恢复的版本，成功后才修改当前文件；只在首次必要变更时保留相应版本，不为拆表提前复制全库。目录清理也必须检查这些 pin，不能只检查当前活跃节点。系统回收站不能替代具有明确身份与摘要的恢复版本。

用户从外部改变/删除文件不受应用事务控制。缺少原字节或摘要不符时，先列出准确项目/分集/节点及文件身份，阻止宣称完整恢复；用户可明确选择保留当前文件或接受带缺失标记的部分恢复。未得到明确选择不覆盖当前有效数据，也不自动从网络重新生成媒体。

旧 projects/projectSummaries 与绑定/备份不在首个迁移版本自动清除。后续仅在独立清理任务中，经稳定窗口、恢复演练及明确用户清理操作后退役；不按启动次数自动删除，不把缓存清理扩展为删除唯一恢复材料。迁移隔离材料和未确定执行状态始终排除自动垃圾回收。

## 12. 分阶段实施计划

P0～P5 阶段代码已写入，实际范围见第 17～21 节；以下阶段的退出条件仍须用户验收，不以代码写入替代检查结果。自动化和 Tauri 验收由用户执行或在用户明确授权后执行。推送时按仓库规则由 pre-push 运行完整 npm run ci，不能以本表作为额外 Rust/桌面测试授权。

| 阶段 | 具体任务与主要文件 | 退出条件 |
|---|---|---|
| P0 合同冻结 | 拟新增 src/types/project.ts、projectMigration.ts；盘点所有 store/metadata/外部合同；定义孤立分集文稿、多根目录、历史来源/已删目标、expectedContext、v4 JSON/跨版本修订与恢复范围；补齐本方案和 ADR | 旧数据类型均有归属和映射，启动停写证据/归档往返及恢复边界冻结；用户确认产品行为 |
| P1 仓储接口与备份 | 拟新增 src/services/indexedDb/projectRepository.ts、projectModelMigrationRepository.ts，以及 src/services/projectModelMigration.ts、projectModelCompatibility.ts；旧仓储背后实现新领域读模型；实现备份与读回/恢复准备；不激活新表 | 通过旧数据得到等价领域结果，正常业务仍由旧唯一写入路径处理 |
| P2 新表与迁移器 | 修改 indexedDb/schema.ts、projectSummary.ts、storageService.ts、indexedDbService.ts；实现 staging/ledger/异常隔离/activation、分批幂等、可验证停写、冻结源过滤及来源映射 | 所有旧样本有结果；断电/配额/旧进程残留失败能恢复；开发开关下保持新模型未对日常业务激活 |
| P3 业务与界面 | 拆 store.projects.ts 的领域保存；调整 store.utils、节点/历史自动保存、Header、SeriesRail、SessionProjectTabs、ProjectLibraryModal、ProjectSettingsPopover、ScriptWorkbench | 零集剧集、稳定普通项目转换、按需内容读取、旧设置固定与新集继承、原子换序/删除可验收 |
| P4 跨域与原生 | 调整 chat/Agent/团队上下文与窗口 DTO、MCP catalog/control/operation、CLI、canvasDerivationGuard、插件 UI、Director/AI App/账本查询/视频工程；更新 mediaRelocations | 每个旧 ID 命名空间可定位；旧请求不会跨集写入；原生与前端合同一致，运行时租约不迁移 |
| P5 归档与恢复 | 修改 projectTransferService、projectExchangeFormat/Domain、projectMerge/ImportService、indexedDb projectImport/ExchangeRepository、archive validation/serialization、必要 Worker 与 Rust适配；统一所有导入/复制分支及发布/恢复 journal | v1～v4、原子捕获/发布、新建/更新/复制、历史去重/删除目标、旧 recovery、单调回执及多根素材全部有覆盖 |
| P6 激活与发布验收 | 在可丢弃数据库/项目副本演练全流程；统一开启 activeDataModel；发布说明列出兼容边界与恢复入口 | P0～P5 全部完成，备份可恢复；前端门禁及明确授权的原生/桌面验收有实际证据，无阻塞缺口 |
| P7 稳定期收尾 | 收敛旧 DTO/适配器调用、补弃用说明；观察读取边界和恢复案例，规划单独的旧数据清理 | 不再有新业务直接访问旧表；清理需另行授权，不自动删除备份 |

P1～P5 可以分提交开发，但不发布半套可写迁移。禁止旧表、新表长期双写，也禁止用运行时 fallback 掩盖漏改的消费者。全部新写入口、接口与恢复适配完成前，正式激活开关保持关闭。

### 12.1 文件归属与改动约束

| 范围 | 现有入口及拟改职责 |
|---|---|
| 类型与 Store | src/types/index.ts、chat.ts、agent.ts、scriptWorkbench.ts、plugin.ts、projectExchange.ts；src/store/store.projects.ts、store.chat.ts、store.agent.ts、store.history.ts、useAppStore.ts |
| 保存与目录 | src/services/storageService.ts、fileService.ts、fs/core.ts、fs/projectFiles.ts、indexedDb/schema.ts、projectSummary.ts、mediaRelocations.ts |
| 编辑与生成 | projectSettingsService.ts、episodeScriptFileService.ts、episodeEditorSessionService.ts、episodeWorkspaceScope.ts、shotlistService.ts、seriesSourceService.ts、storyGraphService.ts |
| 任务/工具/窗口 | services/chat/toolRegistry.ts、tools/projectTools.ts/seriesTools.ts/canvasTools.ts、workbenchAgentInvocationService.ts、teams/*、agentCheckpointService.ts；scriptWorkbenchWindowService.ts、chatWindowService.ts |
| MCP/CLI | services/mcp/mcpControlService.ts、mcpToolCatalog.ts、mcpOperationService.ts；scripts/ai-canvas-cli.mjs 及已有适配器 |
| 交换/恢复 | projectTransferService.ts、projectExchangeFormat.ts、projectExchangeDomain.ts、projectMergeService.ts、projectImportService.ts、indexedDb/projectImportRepository.ts、projectExchangeRepository.ts |
| 原生与产物 | plugins/pluginUiSessionService.ts、director*Service.ts、aiApps/aiAppService.ts；src-tauri/src/plugins/window.rs、director/blender_runtime 的 Job/grant 绑定，按实际合同最小调整 |
| 其他引用域 | pollManager.ts、types/aiTypes.ts、indexedDb/videoEditorRepository.ts、videoBatchRepository.ts、plugins/pluginVideoReplicaJobRepository.ts、billing/volcengineBillingService.ts；回执与账本历史不改写 |

不改 README，不修改构建产物/缓存，不放松 Tauri 安全规则，不借本次重构升级依赖。UI 复用既有 UI Kit，新增入口同时核对深浅主题、键盘及空状态。

## 13. 验证与验收方案

### 13.1 自动化覆盖设计（P0～P4 已补回归源，均未执行）

| 组别 | 必须证明的行为 | 复用/拟新增入口 |
|---|---|---|
| 映射与等价性 | 普通项目/剧集拆分后数量、正文、引用、设置、ID与文件定位等价；二次迁移无重复 | 拟新增 tests/services/projectModelMigration.test.ts、projectModelCompatibility.test.ts |
| 合法旧例外 | v1 孤立分集直接导入与已导入顶层记录均保留文稿/TXT/配置；父目录缺失、子独立目录/旧 ID回退，同路径不同字节不串文件 | projectTransferService.test.ts、新迁移/归档 fixtures；禁止只测现代单根样本 |
| 迁移故障 | 备份失败、每个暂存批次中断、源变化、激活前后崩溃、旧实例仅关闭 IDB后继续写 localStorage、空间不足、重复启动 | 同上＋拟新增 projectModelRecovery.test.ts；用真实 IDB 事务语义及原生停写证据补充 mock |
| 异常旧数据 | 断父链、环、owner 非空画布、重复集号、缺失正文、未知字段、隔离项目不被清理 | 迁移 fixtures 不使用真实用户文件/凭据 |
| 摘要边界 | 项目列表不读取内容/Canvas 表；分集列表不读剧本；预览按需；大量正文不进入导航快照 | 拟新增 projectRepository.test.ts、组件读取范围断言；不以耗时阈值代替结构断言 |
| 配置 | 旧集缺设置仍回退应用、不意外继承父；新集继承、set/clear/母图原子组和节点覆盖一致 | projectSettingsService.test.ts、generationProjectDefaults.test.ts |
| 业务事务 | 转剧集不换根 ID、画布保存不覆全剧内容、换序半失败回滚、删末集保留根、删整剧清理失败可重试 | tests/store/projectSeries.test.ts、projects.test.ts、projectAssetSyncPersistence.test.ts |
| 会话/任务/MCP | 旧 key 原回执可查、旧任务/绑定字段一致、同剧两集同 key 不合并、旧版本条件拒绝、CLI 跨请求保留原 expectedContext、启动页可创建/打开、预算不重置 | mcp/mcpOperationService.test.ts、chat 工具/团队/Checkpoint 和 CLI用例 |
| 通用媒体恢复 | localStorage 原串备份、loadAll 读写冻结、未知/损坏材料不清空、submit_unknown/delivery_pending 不重投、删除目标仍可读回执 | pollManager.test.ts、outputHistoryRecovery.test.tsx、mediaTaskStatus.test.tsx；覆盖 IDB/localStorage 中断边界 |
| 归档/合并 | v1/v2/v3→新模型，v4 往返，旧 hash 不变，迁移无伪差异，混版本共同祖先、墓碑/依赖与重复导入 | projectArchiveRoundTrip.test.ts、projectExchangeRoundTrip.test.ts、projectImportRecoveryService.test.ts 等 |
| 归档操作与历史 | 捕获中新增/删集、序列化后改稿、打包/发布后回执丢失；三类导入失败不留半项目；旧分集历史升级后接收对方后续包不重复，删集/末集带历史可往返 | projectTransferService.test.ts、projectImportPersistence.test.ts、projectImportRepository.test.ts、Worker/原生发布用例 |
| 恢复安全 | 恢复前读回失败阻断；迁移后新收费/unknown回执不倒退；只恢复一项目不隐藏其他项目；IDB已提交但localStorage失败能续接；旧目录/文件字节变化先核对 | 拟新增 projectModelRecovery.test.ts、旧恢复点/媒体及账本查询回归 |
| 冻结来源 | 活动项目改名/重连仅更新当前 generation；旧 projects、非活动 generation、隔离资料、恢复点和不可变历史的字节/摘要不变 | mediaRelocations及来源摘要覆盖用例，不只断言新表已加入清单 |
| 文件/原生合同 | TXT 外部修改、目录保持、重定位 journal、新表引用覆盖、插件/Director 迟到结果拒写 | episodeScriptFileService.test.ts、projectAssetScanRelocations.test.ts、pluginUiSessionService.test.ts、directorBlenderRuntimeService.test.ts |

对迁移失败应逐个持久化边界注入错误；对正常 fixture 比较迁移前后业务语义与原始 ID，不用只验证“产生了新表”的镜像测试。大型数据按 cursor 批次与峰值读取量核对，不在本轮宣称性能提升比例。

### 13.2 用户可执行命令

本次未执行以下命令；完整迁移器和剩余用例实现后，在仓库根目录按实际范围运行。当前 P0/P1 的准确入口见第 17.3 节：

~~~powershell
npx vitest run tests/services/projectModelMigration.test.ts tests/services/projectModelCompatibility.test.ts tests/services/projectModelRecovery.test.ts tests/services/projectRepository.test.ts
npx vitest run tests/store/projectSeries.test.ts tests/store/projects.test.ts tests/services/projectSettingsService.test.ts tests/services/generationProjectDefaults.test.ts
npx vitest run tests/services/projectArchiveRoundTrip.test.ts tests/services/projectExchangeRoundTrip.test.ts tests/services/projectImportRecoveryService.test.ts tests/services/mcp/mcpOperationService.test.ts
npm run typecheck
npm run test:typecheck
~~~

前四个拟新增测试文件当前不存在，不能在本方案阶段运行并声称通过。推送按既有门禁自动执行 npm run ci；涉及 Rust 合同变化的检查与 Tauri 实机验收另由用户明确授权，前端 CI 不能代替原生验证。

### 13.3 Tauri 桌面验收顺序

前置：使用可丢弃的应用数据副本，准备一个普通项目、至少两集的剧集、带原著/故事图/资产的项目、含任务/幂等回执/视频工程的项目、v1/v2/v3 项目包及旧恢复点。验收开始前确认能恢复该副本，不在唯一真实工作目录演练删除和数据库还原。

1. **升级预检与重启**：观察备份、进度、占库提示；在暂存阶段中断后重启。预期续接同一次迁移，无额外默认项目/分集，旧素材目录名和字节不变。
2. **普通项目与转剧集**：打开旧普通项目、编辑保存、增加分集。预期根项目 ID不变，原画布成为第 1 集，原会话/记忆/资产和节点引用保留。
3. **旧剧集兼容**：逐集检查大纲、剧本、TXT、清单、模型/画风与母图。旧集不因项目默认变更而漂移；显式改继承后新规则生效。
4. **工作台/窗口**：画布 A、工作台 B，保存 B；独立窗口编辑、收回、关窗并重开。预期不切错画布、不丢草稿、不重启任务；迟到旧 DTO 被拒绝。
5. **零集剧集**：删除测试项目最后一集。预期原著、全剧资料、正式资产、会话和记忆仍在；可以建新集，画布工具明确不可用。
6. **任务/原生对象**：查旧 MCP operationKey、用量与视频工程；切集后尝试旧请求。预期原回执仍可查、无重复付费提交、跨集写入被拒，插件/Director 重新建立租约后正常使用。
7. **项目包往返**：分别导入旧包、导出/导入 v4，执行同来源往返更新及重复导入，再从旧恢复点恢复。预期身份/素材完整、旧修订摘要不变、无伪删除重建，epoch 不倒退。
8. **异常与回滚**：在副本上模拟配额/文件/迁移失败、损坏父链和旧二进制降级。预期保留源材料，清楚区分隔离/失败/恢复成功；新编辑丢弃范围必须可见，不能自动重置数据库。
9. **回归**：画布撤销、自动保存、项目切换、资产改名/移动、分组文件、全局资产、深浅主题、键盘及退出重开。Web 只做必要展示，原生文件和窗口结论以 Tauri 为准。
10. **旧形态与历史往返**：旧 v1 孤立分集分别从项目包导入和从已存在数据库升级；父目录缺失的多根项目包含两个同名不同字节文件。检查正文/TXT/预览和再导出。升级旧分集历史后导入同来源后续包，不产生重复会话/记忆；删目标集与删末集后携历史导出，在新环境导入并再次导出，已删绑定仍只读，不复活分集。
11. **回滚副作用与范围**：迁移后创建新集并保留已提交/提交不确定的测试回执，在副本环境恢复旧内容。预期新目标转墓碑而原 key仍已占用、预算不归零，其他未恢复项目仍可见；IDB提交后故意中断侧存储恢复，重启必须继续恢复而非启动新提交。实际收费验证只在另行明确授权后进行，不为验收自动付费。

## 14. 发布阻塞项与待评审决策

下列产品行为仍是后续实施目标；P0/P1 只落实合同和准备能力，没有启用这些新业务路径：

- 普通项目保留直接画布结构；剧集可零集；删末集不删根项目。
- 旧集固定原设置，新集继承项目默认；旧集改继承由用户显式选择。
- ID/目录保留＋分域兼容映射；不改写历史账本、不可变产物与旧协作修订。
- 新模型原生导出 v4，并提供受限 v3 兼容投影；旧客户端不能读新版语义时明确拒绝。
- 新旧表单权威切换，观察期保留旧源；新版恢复与旧二进制降级分开承诺。

实施前仍须冻结：旧进程/profile 停写证据、备份/新版恢复入口与单调侧表规则、局部/全体恢复范围、旧二进制降级支持范围、v4 JSON/跨规范父引用/历史目标的完整 schema、多根素材与不可变文件的映射、现有 metadata 全量分类、异常数据恢复交互。这些是 P0/P1 的明确交付物，不作为猜测实现的空间。

未完成备份恢复演练、旧 ID 幂等回执适配、localStorage 媒体队列冻结与恢复、新旧归档/已删历史目标及多根素材往返、原 expectedContext/代际屏障或原生合同核对，均不得激活正式用户迁移。阶段文档分别记录“已实现”“实际检查结果”“待桌面验收”，不得把本次方案评审标成迁移已完成。

## 15. 相关资料

- [画布与项目模块](../画布与项目模块.md)、[文件与存储模块](../文件与存储模块.md)、[角色与短剧资产](../角色与短剧资产模块.md)。
- [独立工作台与选集解耦](./2026-11-06-script-workbench-window.md)、[原文和分集 TXT](./2026-11-07-manuscript-txt-files.md)、[故事关系图](./2026-11-06-script-story-graph.md)。
- [项目导入更新与三方合并](./2026-10-30-project-import-update-merge.md)、[ADR-0011](../adr/0011-project-archive-three-way-merge.md)、[ADR-0012](../adr/0012-project-episode-canvas-model.md)。

## 16. 再次复审结论与实施阻塞项

以下均为**方案缺口及文档修正**，不是已复现的迁移故障；本轮没有运行测试、导入导出或用户数据迁移。

| 级别 | 发现与触发 | 已修正的方案合同 | 源码核对依据 |
|---|---|---|---|
| P1 | 合法顶层旧记录仍有分集稿件，新模型原来没有落点 | standaloneCreative 显式承载，转剧集原子迁移，旧 v1/本地数据均可往返 | projectTransferService.ts:546–558；projectTransferService.test.ts:725–735 |
| P1 | 父 dataFolder 缺失时，旧子集可使用自己的目录/ID；统一到父会断素材 | 冻结逐域真实 rootRef，多根归档按逻辑文件分开，不静默归一 | store.projects.ts:165–169；fs/core.ts:469–490 |
| P1 | 旧实例释放 IDB后仍可写 localStorage，blocked 不等于停写 | 冷启动/profile 独占需可验证旧进程退出；否则阻断激活 | indexedDb/schema.ts:225–228；pollManager.ts:901–911 |
| P1 | 扩充重定位表清单会同时扫描冻结源、非活动代和全部 metadata | 仅活动代可变记录及允许键可改；恢复对副本投影 journal | indexedDb/mediaRelocations.ts:24–25、256–281、327–338 |
| P1 | 回滚普通项目快照可能抹去迁移后付费/幂等事实；旧文件也未必仍在 | 专用恢复前备份、单调回执/预算、恢复 journal、媒体版本/目录闭包；局部恢复不切全局代 | projectTransferService.ts:353–360；mcp/mcpOperationService.ts:98–123；projectImportService.ts:380–426 |
| P1 | 历史行 ID包含旧归属，升级后接收后续包会重算去重身份 | 稳定来源 binding 指向原行 ID，原子维护来源关系 | projectImportService.ts:220–240；indexedDb/projectImportRepository.ts:134–140 |
| P1 | 删集保留工作台会话，但原收件校验拒绝缺失 target，合法状态无法带历史往返 | v4 retired 历史目标/只读绑定，不造分集、不擦绑定 | projectImportService.ts:255–263；projectTransferService.ts:423–430 |
| P1 | 拆表导出可能读到不同时间的内容，准备修订成功不等于包已发布 | 同事务捕获＋全域版本复核；新建/更新/复制统一事务；发布/导入 journal；容量预检 | projectTransferService.ts:309–375、477–644、662–675；projectImportService.ts:118–138、309–376 |
| P2 | 连接绑定随机令牌与单请求 CLI/启动页不匹配，属于额外协议复杂度 | 去掉该前提，使用 global/project/episode/canvas 的可跨连接 expectedContext；不自动刷新旧意图 | scripts/ai-canvas-cli.mjs:127–158；chat/tools/projectTools.ts 的全局导航入口 |

文档层面的这些缺口已补齐。仍需在 P0/P1 冻结精确 schema 和跨平台停写/备份实现，并在实施后完成上述失败注入、旧包及双机往返、局部/全体恢复演练；本次复审不构成这些能力已实现或验收通过的证据。

## 17. P0/P1 实际实施状态

2026-11-07 已按用户指令实施以下准备层；**本次未运行测试，待用户验收**。未调用真实用户数据库/文件备份、未运行应用、lint、类型检查、构建或迁移。

### 17.1 已实现文件与入口

| 范围 | 实际文件/接口 | 行为 |
|---|---|---|
| P0 领域合同 | src/types/project.ts、projectMigration.ts | 分离根项目/分集/画布、正文域、legacy-pinned、rootRef、typed expectedContext、历史目标和阶段；只读投影没有激活授权 |
| P0 归档合同 | src/types/projectArchiveV4.ts | 冻结 v4/canonical2/bundle2、混合版本父引用、普通文稿/已删目标、条目清单及导入/复制身份矩阵；runtimeEnabled=false，不修改当前 v1～v3 解析器 |
| P1 旧数据适配 | src/services/projectModelCompatibility.ts 的 projectLegacyRecords/readLegacyProjectAggregate | 保号、旧文稿与 TXT、旧设置、画布/文稿真实目录分别定位；坏链/坏图/owner 冲突整组件隔离，原始材料单独保留 |
| P1 只读仓储 | src/services/indexedDb/projectRepository.ts 的 createLegacyProjectRepository | 目录从真实 projects 生成轻量返回值；按项目在同一只读事务读取完整关系组件，不让损坏摘要或截断坏链制造健康项目 |
| P1 来源盘点 | src/services/indexedDb/projectModelMigrationRepository.ts | openExistingProjectDatabase 不传新版本号，缺库中止建库、未来版本拒绝；readLegacyMigrationSnapshot 同事务 cursor 读 schema/key/原值，并原串读取媒体队列；未知表/键、异常 autoIncrement/schema 或队列变化阻断完整状态 |
| P1 备份格式 | src/services/projectModelBackup.ts | 独立 project-model-backup-v1；类型化保留 undefined/稀疏数组/日期/二进制与共享引用等，逐文件 SHA-256；敏感字段、损坏队列、键不一致、非法引用/超限拒绝，不脱敏后假称原值完整 |
| P1 文件端口 | src/services/fs/projectModelBackupFiles.ts，经 fileService 导出 | 固定应用恢复区 project-model-backups/操作号，目录/条目拒绝链接与越界，独占创建、有限读取，完成标记最后发布；不进入项目素材目录、不自动清理失败材料；asset 协议显式拒绝该恢复区 |
| P1 准备编排 | src/services/projectModelMigration.ts | prepareProjectModelBackup/inspectProjectModelBackup 完成全套读回才报告成功；prepareProjectModelRestore 仅列范围、未恢复项目和保留侧表策略，不返回可直接写库的旧对象；失败保留安全操作号供定位 |

18 个项目关联 stores 与 11 个明确无关/全局 stores 已在来源清单分类；metadata 按已知 exact/prefix 分类，未知项阻断，不扫描 config/凭据或把未知资料默默漏出备份。恢复准备明确当前任务/绑定/预算/队列需保留并协调，不释放旧 key，不执行恢复覆盖。

### 17.2 明确的阶段边界

- 当前 DB_VERSION 仍为 27，所有新模型表均未建立；未改自动保存、项目切换、工具写入、窗口协议或 startup 初始化。现有写入权威不变。
- 项目导入导出、复制、三方合并和旧恢复入口仍使用既有运行实现；原生项目包仍为 v3，v4 仅有合同，不能声称新版往返已实现。P5 才接入新格式和 journal。
- P1 是**有界内存准备**，不是大库流式迁移：默认来源总量估算 256 MiB，可设置到最多 1 GiB；单记录/单文件最多 128 MiB，备份编码总量最多 1 GiB，另有文件/记录/深度上限。超限拒绝，不截断。P2 激活前必须解决超限项目的安全分批方案。
- 备份读回成功只证明当前存储材料可读、摘要及类型结构一致。现有 fs 插件没有显式同步耐久发布接口，P1 不声称硬断电耐久；报告固定 durability=read-back-only、quiescence=not-established、canActivate=false。
- 原生 profile 停写证据、耐久发布屏障、大库分批与迁移/恢复 journal 的真正执行仍是 **P2 正式激活前的硬门禁**。它们未建立时，即使备份完整也不能升级/激活。不是用用户布尔值冒充证据。
- 恢复准备固定 canApply=false，并要求恢复前安全备份、媒体核对和停写。没有执行回滚、删除目录或恢复计费任务的路径；取消在写入、异步读回和完成标记前后复核，已经发布的材料保留供独立检查。
- 不提供迁移 UI、自动入口或旧二进制降级；本阶段调用只面向后续集成和测试。停止在 P0/P1，不提前实施 P2～P7。

### 17.3 未执行的验收入口

以下六份回归源已补充，**未运行**。在仓库根目录由用户执行，或后续明确授权后执行：

~~~powershell
npx vitest run tests/services/projectModelCompatibility.test.ts tests/services/projectRepository.test.ts tests/services/projectModelMigrationRepository.test.ts tests/services/projectModelBackup.test.ts tests/services/projectModelBackupFiles.test.ts tests/services/projectModelMigration.test.ts
npx vitest run tests/services/projectTransferService.test.ts tests/services/projectArchiveRoundTrip.test.ts tests/services/projectExchangeRoundTrip.test.ts tests/services/projectImportRecoveryService.test.ts
npm run typecheck
npm run test:typecheck
~~~

重点样本：旧 v1 孤立分集/顶层文稿；无父目录、空白目录和画布/TXT 多根；多层/环/缺父关系；陈旧/缺行摘要；源字段不变和幂等保号；未知 metadata/schema、配额/预算阻断；Map/普通字段凭据拒绝；undefined/Blob/view 共享 buffer 类型保真；材料被篡改、读回失败、取消及缺完成标记；单项目恢复准备不隐藏其他项目、不覆盖迁移后的收费任务。

Tauri 桌面回归前置：用可丢弃项目/数据副本，正常打开普通项目和至少两集的剧集，检查画布、稿件、目录、会话、设置与切集；导出当前 v3 包并在独立测试项目导入，预期保持原行为，且启动不会生成新模型数据或备份目录。本阶段没有迁移按钮；实际备份文件端口、asset 拒绝和重启/失败读回需后续在明确授权的桌面验收中核对，自动化不替代原生结论。

仅做了代码阅读、接口交叉审查、UTF-8/差异静态核对。无测试或性能结果；不得把 P0/P1 准备代码标为正式用户数据迁移已通过。

## 18. P2 实际实施状态

2026-11-07 用户继续授权 P2，明确保持正式迁移关闭、不迁移真实用户数据、暂不运行测试。本节记录实际开发范围；第 17 节是上一阶段的历史边界，不能把 P2 的原生端口与 P1 的普通读回准备接口混用。

### 18.1 已实现入口与安全边界

| 范围 | 实际入口 | 当前行为 |
|---|---|---|
| 固定隔离范围 | src/types/projectModelJournal.ts | 数据库只能是 ai-canvas-model-fixture- 加安全标识；隔离暂存版本 28，正式 schema.ts 仍为 27。根项目/正文/分集/画布/预览/binding/journal 的表与索引有实际定义 |
| 原生冷维护 | src-tauri/src/files/project_model_safety.rs、lib.rs、vendor/tauri/src/webview/exclusive_environment.rs | 只在显式 debug 冷启动路径建立维护窗；创建业务 WebView 前关闭默认窗口创建，维护页不加载主应用、Store、轮询或业务脚本。Windows WebView2 exclusive environment 排除既有 profile 使用者；新 fs2 锁只串行维护，不冒充旧版停写证据 |
| 原生权限 | project-model-maintenance 专用权限/capability、path_policy.rs | 绑定唯一维护 WebView、原生租约与安全 profile/op 身份；不接收任意 profile 或绝对路径。普通业务窗不能取得租约；正式 profile 证明路径只读，不发迁移或备份写权限 |
| 耐久备份桥 | src/services/projectModelNativeSafety.ts | 独立 fixture 恢复区，独占新操作/条目；原生重验 manifest/complete/每项摘要并同步材料后，最后发布独占 durable seal。继续时重新验证 seal 和完整类型解码，不接受 Renderer 自报成功 |
| 源摘要与准备 | projectModelSourceFingerprint.ts、projectModelStaging.ts | 稳定源摘要排除操作号/制作时间；源 schema、索引、行、文件摘要和 LS 原串仍参与。先完成耐久备份和支持类型预检，才允许隔离库建新表 |
| 暂存与 journal | indexedDb/projectModelStagingRepository.ts | schema_ready → staging → verifying → ready，分批新行与 nextRow/sequence 同事务提交；所有旧来源表的 schema/key/精确原值在同批事务内复核。新行带 operation/generation，映射不重新发号，epoch 提升但不激活 |
| 原源冻结 | indexedDb/mediaRelocations.ts | 同事务冻结 marker 阻止旧媒体写入链；旧递归扫描不加入新表，修复 metadata 只修改 asset-image，原导入恢复点/journal、MCP 回执、墓碑与未知材料保留。该局部保护不替代全 profile 原生停写 |
| 显式恢复/撤销 | stageProjectModelFixture 的 resume、rollbackProjectModelFixtureStaging | 继续必须同操作/代际/备份/adapter/源摘要；ready 也重新核对全部目标集合及摘要。撤销只删本次未激活行，保留 journal/备份/旧源/其他 generation，不倒回收费任务或 localStorage |

PROJECT_MODEL_STAGING_CAPABILITIES 固定 productionMigration/automaticMigration/activation/restoreWrites=false。没有环境变量、配置项或调用参数可以打开正式执行。stage/rollback 在任何 IDB/文件/IPC 调用前拒绝正式库或任意库名；fixture 名称还必须与原生 lease 的 profileId 一致。

普通启动仍走旧业务；未接 P2 协调器、未加正式数据库新表、未改自动保存/项目切换/导入导出/v4 收发。实际没有启动维护模式、备份或迁移真实用户数据。

### 18.2 中断、失败和撤销

| 中断位置 | 恢复依据与允许动作 |
|---|---|
| 备份写入、读回或 seal 前失败 | 不升隔离库；未完成材料保留，不能复用目录覆盖。新操作可重做备份，不能把缺 seal 当成功 |
| 已有耐久备份，隔离库升版前后中断 | 同操作 resume 重新读回原材料及 seal；schema-only 状态可依据该备份重新 prepare，缺备份/来源变化则停止。保留新表不等于旧二进制可降级打开 |
| 批次配额/事务失败 | 当前批次原子中止，已提交 nextRow/sequence 是断点；普通事务失败可显式继续，不重建 ID、不重写原备份。记录失败本身也失败时依旧以最后已提交 journal 为准 |
| 用户取消 | 不继续后续批次，不自动撤销已提交批次；保留最后稳定断点，必须显式 resume 或撤销。异步摘要/读回/最后原生 proof 等待之后再次检查取消 |
| 源 IDB/LS 改变、目标冲突或摘要/集合校验失败 | 终止性 failed 不可被重试改成普通事务失败；不报告 ready，不改旧源。修复材料或撤销后，使用新的操作和 generation 重新准备 |
| 原始数据异常 | 整个关联组件隔离、原材料保留，quarantined 不代表迁移成功；不会用摘要补造缺失正文 |
| ready 后重启或材料损坏 | 重新检查全部目标行/键集合、manifest 和来源；不信任上次阶段。无任何 activeDataModel 写入入口 |
| 未激活撤销 | 核对原生租约、耐久备份、operation/generation 与无活动模型标记后，同事务删除本次暂存并记 rolled_back、解除自己的冻结；不删除备份，不把旧内容/任务覆盖回当前源 |
| journal 损坏、未知活动标记或清理归属不明 | 失败关闭并保留材料；不猜测已激活状态、不删除整库或目录、不重投付费请求 |

本阶段只实现**未激活迁移撤销**。激活后业务内容恢复、单调审计协调、协作后继修订及媒体版本闭包仍需 P3～P5，正式开关不能因 P2 ready 而开放。任何单项目业务恢复也不能借 P2 的新 generation 暂存来切换全局指针。

### 18.3 当前限制与发布门槛

- 冷停写证据当前只实现 Windows WebView2 路径，其他平台明确拒绝维护操作；同时要求足够新的运行时接口、真实 UserDataFolder 与请求目录一致，并在 BrowserProcessExited 后永久撤销本次租约。真实既有 profile 的证明入口不提供迁移写能力，既有目录/环境不符则拒绝。不支持平台的原生方案及所有桌面证据仍是正式发布门槛。
- 耐久端执行系统同步/发布屏障；尚未实机验收，不宣传硬件、网络盘或任意文件系统的绝对断电保证。Windows 受管根拒绝不支持的卷；与 P1 durability=read-back-only 明确区分。
- P2 仍为有界内存开发实现，来源默认 256 MiB、codec 总量最多 1 GiB等限制继续生效；原生 IPC 单条最多 8 MiB，在 Array.from/写入前拒绝超限，不截断、不降低格式安全预算。大 Blob/大单条不支持，尚无流式大库迁移承诺。
- 事务内精确源比较不支持 Blob 等无法同步读取字节的值；源已独立保真备份，协调器在隔离库升版前阻断，不能丢掉字段后继续。缺 metadata 的古老 schema 当前亦在升版前拒绝，保留旧权威，后续补适配样本。
- 暂存分批，不代表整个管线按流式驻留：journal 保留来源比较材料与目标清单，空间不足靠独占文件预检与实际 IDB 事务错误停止。大库分块/完整容量与性能证据、全业务与原生调用方适配、v4 往返及激活后恢复全部完成并验收前，不允许正式激活。
- 本轮没有迁移执行 UI：维护页只提供隔离原生环境，编排函数是显式开发/测试 API。桌面端整链演练需专用 fixture harness 调用，不通过普通页面加载业务 Store；本轮也没有启动该 harness。

### 18.4 未执行的验收入口

本次只做静态阅读、跨模块交叉审查、UTF-8 与差异核对；**未运行测试、lint、类型检查、构建、维护程序或 Tauri 应用**。以下回归源已补充，由用户执行或另行授权：

~~~powershell
npx vitest run tests/services/projectModelStagingRepository.test.ts tests/services/projectModelStaging.test.ts tests/services/projectModelSourceFreeze.test.ts tests/services/projectModelMigrationRepository.test.ts tests/services/projectModelBackup.test.ts
npm run typecheck
npm run test:typecheck
~~~

原生单元用例位于 project_model_safety.rs，需另行授权后运行 Rust 检查/测试；本轮不执行 cargo check/test，也不通过构建间接验收。

桌面验收必须使用可丢弃 fixture profile/数据库，先备好副本。顺序与预期：

1. 普通启动，打开/切换旧普通项目与多集剧集，导出 v3 并作为新项目导入：预期原行为保留，没有正式新表、迁移目录或自动备份。其余项目、稿件/TXT、多根素材、会话和设置均保留。
2. Windows debug 冷维护隔离 profile：预期只有静态维护页，没有画布/轮询/MCP/插件业务；第二实例或旧 profile 使用者存在时拒绝取得独占证据。普通窗口、伪造 lease、错误 profile 和 release 模式都应拒绝。
3. 小型合法 fixture 包含普通稿件、两集剧集和侧表/LS 原回执；显式执行暂存：预期先有读回及 durable seal，再仅隔离库升至 28；原源字节和身份不变，完整集合达到 ready，正式激活仍不可用。
4. 分别在写文件、seal、schema-only、每批提交前后、校验和最后 proof 等待时注入失败/取消并重开：预期同 op 按已提交断点继续；未知/缺失/篡改材料或源变化阻断，不重投任务；ready 后删除暂存行也必须阻断。
5. 暂存后在可丢弃源加入另一项目、新收费回执及 unknown 队列，再撤销：预期只删除本操作暂存、journal 记 rolled_back，其他项目/代际/新回执/队列/旧导入恢复点/原备份均保留；重复撤销幂等。出现活动标记时拒绝撤销。
6. 原生核对链接/重解析点、私有目录祖先、越界/重复路径、超限/配额、seal 缺失和后台导航/关窗撤销租约；完成实际系统中断演练后再记录平台支持结论。仅 mock 的用例通过不能替代这些原生证据。

## 19. P3 实际实施状态

2026-11-07 按用户指令实施保存、选择/切换、排序和删除，继续保持正式迁移关闭。本轮没有运行任何测试、类型检查、lint、构建或应用，也没有操作真实用户数据库或素材。

### 19.1 新模型业务与旧路径的范围

| 路径 | 实际入口 | 行为 |
|---|---|---|
| 隔离业务接管 | types/projectModelBusiness.ts、indexedDb/projectModelBusinessRepository.ts | beginProjectModelFixtureBusinessSession 先核对 P2 ready 全集合，再同事务 CAS 安装轻量 business marker；只接受已有 fixture v28 新表，不创建正式表，不写 activeDataModel |
| 业务导航 | listProjects/listEpisodes、openProject/selectProject、readProjectContent/readEpisodeContent/readCanvas/readPreview | 明确 activeProjectId/activeCanvasId/activeEpisodeId 与 project/canvas 上下文，记录有效 lastOpenedCanvasId，失效时选首集；零集剧集返回 project 上下文，不造空画布；普通项目缺画布及孤儿/双向不一致均拒绝。列表不读取正文/完整迁移 journal |
| 分域保存 | saveCanvas/saveEpisodeContent/saveProjectContent、updateProject/updateEpisodeSettings | 项目 epoch 与对应画布/正文/分集 revision 条件写入；只写当前域，画布保存不覆盖稿件/共享资料。完整输入同步捕获，signal 仅运行时使用；稿件引用、故事图、清单、凭据与可迁移引用检查不由任意扩展对象绕过 |
| 转换/新增 | convertStandaloneToSeries、createEpisode | 普通转剧集保留 Project 与 Canvas 原 ID/目录/共享资料；standaloneCreative 原子转到首集。旧效果固定 legacy-pinned，新集 inherit；新增身份与已退役身份冲突拒绝 |
| 排序/删集 | reorderEpisodes、deleteEpisode | 按完整成员/版本一次事务提交，orderRank 与 displayNo 分开；删集同事务删除其 Canvas/正文/预览，提升 epoch，保留 retired alias 与 tombstone。删末集后 Project.kind 仍为 series，共享资料/目录/侧表仍在，允许再新增 |
| 删除整剧 | fixture deleteProject | 核对项目与会话 revision，移除该项目聚合，保留旧源、侧表及历史 binding；另登记 cleanup journal，canDeleteFiles=false，不执行目录删除或审计回滚 |
| 有效设置 | services/projectModelSettings.ts | 应用→项目→分集三态解析；旧 pinned 不继承父，clear 回应用，母图按组替换；显式空后缀与 clear 区分，枚举复用现有目录，原 policy/tombstone 不被解析视图改写 |
| 旧格式生命周期 | indexedDb/legacyProjectLifecycleRepository.ts、store.projects.ts | 两集换序同事务从原记录打补丁并推进代际，保留正文/未知字段/旧目录；删除集合一次提交业务/摘要与 tombstone，保留回执/队列/对话/记忆/交换历史/素材目录。缺号/重号不借排序悄悄重编号 |
| 旧路径保存/切换 | store.projects.ts、storageService.ts、indexedDb/projectSummary.ts、indexedDbService.ts | current/owner 保存保留 creationProfile、teamProfileOverride、revisionScope，旧摘要缺 scope 时使用完整记录；故事图 CAS 与迟到封面同事务检查模型门禁。等已接受保存/稿件队列排空再排序/删除；切换/删除替补复核序列、目标、owner、epoch，失败不以空资料覆盖 |
| 旧界面/工具 | SeriesRail、ProjectLibraryModal、seriesTools/projectTools | 加载/结构更新期间限制操作，整剧删除明确分集影响与资料保留；旧末集删除按钮禁用，Store 与低层事务同样拒绝。删除工具复查实际结果，失败不能报告成功；effect 权限不变 |
| 旧归档边界 | legacyProjectWriteGuard、projectTransferService/projectImportService、projectExchangeRepository/projectImportRepository | 文件 effect 前只读预检，提交 checkpoint/导入业务/操作 journal 时同事务再次检查；遇源冻结、活动模型或 business fixture 标记拒绝旧写入，未放宽 v1～v3 解析器 |

P3 仍不向正式应用切换新数据源。Header、标签、工作台及多窗口/Agent 的最终新模型装配必须与 P4 上下文及 P5 归档合同共同收齐；不能把 fixture API 视为已经完成整条正式桌面业务验收。本轮旧界面仍使用旧 Store 语义，仅上述安全收敛立即进入代码路径，没有启用新的继承编辑器或零集主界面。

### 19.2 旧格式删末集与导入导出的取舍

当前 v3/canonical1 仍以旧根记录和子记录表达画布，没有独立的零集剧集/Canvas 身份合同。结构上 episodeCount=0 不等于语义上可无损往返；现有旧导航还会把没有子集的根当作普通画布。不能为显示“删除成功”而把整剧资料作为普通空画布重新导出，也不能提前开放本机能存却不能无损导出的正式新语义。

因此，新模型 fixture 实现真正的“删除末集保留零集整剧”；正式旧格式采取安全拒绝，任何入口都不再把 parent 加入删末集集合。用户可在项目库单独选择删除整剧。等 P5 的 v4 及全链路完成并验收后，才允许正式进入零集新模型。旧 v1 孤立分集、原顶层文稿、旧多根目录与已接受修订继续沿用既有校验和适配；本阶段不重算来源身份、不把未知新结构塞进旧包。

旧模型普通转剧集仍保留既有 owner 映射行为；“保原根 ID”的新转换由 fixture 新模型实现，本轮不对真实项目做结构转换迁移，也不把旧转换悄悄改成半套新身份合同。

### 19.3 中断、迟到写入与审计

- 业务 marker 记录 operation/generation、接管时 source journal sequence、源/目标 manifest 摘要及自身 revision。导航只读轻量 marker/freeze；P2 任意继续、失败写回和撤销遇 business marker 都拒绝，防止把后来作品当成可删暂存。
- 新业务每次 mutation 在同一事务推进 session revision/dirty；结构变更推进项目 epoch，各正文域单独推进 revision。standaloneCreative 清空仍保留空域的 revision/rootRef，不能让旧 revision=0 草稿在清空后复活。
- 排序/逻辑删除失败不产生半批，新模型不回读旧表补洞。旧路径排序屏障排空已接受保存，并推进被交换两集 exchangeEpoch，队列外旧快照也不能把顺序写回。删除 tombstone 阻止迟到旧保存复活。
- 删除前撤销派生结果和停止 Agent；失败时作品未删，已停止任务不自动重启。删除真正提交后才执行 stopPollingForDeletedProjects，避免失败把活项目永久封禁。该函数只撤本进程租约/轮询，不读写 localStorage；同 nodeId 的另一项目控制器不能被误停。
- 本地队列的 submit_unknown/已付费 taskId/attemptId 等证据不随业务删除清空。晚到的真实提交回执仍可保留，不能概括承诺“删除后所有回调都不写队列”；旧 loadAll 的格式适配边界及完整历史目标恢复仍归 P4/P5。SQLite 用量账本不改。
- 目录、审计和 recovery 不自动清理。旧界面删除确认明确“移除项目记录，历史回执和素材文件保留”；本阶段不新增永久清理能力，不承诺一键恢复整个被删项目。

### 19.4 未执行的验收入口

以下仅提供给用户执行，或后续明确授权后执行；本次均未运行。

~~~powershell
npx vitest run tests/services/projectModelBusinessRepository.test.ts tests/services/projectModelSettings.test.ts tests/services/legacyProjectLifecycleRepository.test.ts tests/services/legacyProjectWriteGuard.test.ts tests/services/pollManager.test.ts tests/services/chat/seriesTools.test.ts tests/store/projectSeries.test.ts tests/store/projects.test.ts
npx vitest run tests/services/indexedDbService.test.ts tests/services/projectTransferService.test.ts tests/services/projectImportRepository.test.ts tests/services/projectExchangeRepository.test.ts tests/services/projectArchiveRoundTrip.test.ts tests/services/projectExchangeRoundTrip.test.ts
npm run typecheck
npm run test:typecheck
~~~

桌面验收以可丢弃的普通项目/多集剧集副本为前提。普通正式路径与 fixture 路径分别验收，不把 mock 或 fixture 结果替代桌面结论：

1. 旧项目与已导入 v1/v2/v3 项目：编辑画布、稿件/TXT、创作配置后切集/切项目再重开，预期字段、目录、旧独立设置、共享资料均保留。模拟保存失败/目标 owner 缺失/迟到读取，预期留住当前有效内容、不覆盖成空对象。
2. 旧两集或多集剧集排序：快速连续操作并模拟第二行写入失败，预期整次换序成功或原顺序完整；原文、稿件、故事图、画布及未知字段不被覆盖，重开顺序一致。缺号/重号样本拒绝并保留原集号。
3. 旧路径只剩一集：UI、Store、Agent/MCP 删除均拒绝，根项目/共享资料/素材/回执仍在，工具返回失败。单删普通分集及从项目库删除整剧是独立操作；真正删除后审计/素材仍保留，失败不永久禁止原项目查询。
4. 对已耐久备份并达到 P2 ready 的可丢弃 fixture，显式接管 business session：列表只读轻量元数据，画布/正文/封面按需读取；P2 resume/rollback 和旧格式归档入口拒绝接管标记，不能丢掉之后的编辑。
5. Fixture 普通转剧集：根/原 Canvas ID 与目录不变，原文/资产仍在，顶层稿件进入首集，旧设置 pinned、新集 inherit。测试 clear、set 空后缀、母图原子替换与新项目默认变化，不应改旧集效果。
6. Fixture 删集/删末集：双向关系和各域版本一致才提交；末集删除后整剧仍在、activeCanvasId=null、contextKind=project，可再建分集，旧内容/画布租约拒绝。过期排序成员、孤儿 Canvas、失败事务或坏输入均不能部分提交。
7. 导出当前旧 v3 包并导入/更新/复制，核对正文、TXT、素材与历史来源；冻结/业务 marker 情况在文件 effect 前阻断、事务内再防迟到切换。新模型零集不宣称旧格式无损导出，v4 正式收发仍未开放。

阶段代码仅经静态阅读、接口交叉审查、UTF-8 与差异核对；**本次未运行测试，待用户验收**。正式迁移/激活仍关闭，无自动备份、真实数据迁移或原生验收结论。

## 20. P4 实际实施状态

2026-11-07 按用户指令实施跨执行域上下文，未运行测试、类型检查、lint、构建、CLI 实际调用或桌面应用，没有迁移真实用户数据。正式 DB27、v1～v3 项目包读取和 v3 导出继续沿用原合同；正式迁移、恢复应用、激活和自动入口仍关闭。

### 20.1 上下文与执行边界

| 范围 | 实际入口 | 已实现行为 |
|---|---|---|
| 共享上下文 | types/projectExecutionContext.ts、services/projectExecutionContext.ts | 严格解析 global/project/episode/canvas；schemaVersion=2、modelGeneration、owner/目标 epoch 与专用 revision 分开。legacy modelGeneration=0，runtimeEpoch 在同进程/HMR及不同 CLI 连接间稳定，重启失效；它是并发前提，不是鉴权令牌。不执行外部 getter，不接受未知字段、未来 schema、空白身份或控制字符 |
| 隔离业务只读出口 | projectModelBusinessRepository.readExpectedContext/listLegacyBindings | 同一受保护只读事务从新表取得真实 generation、owner 与目标版本；零集返回项目条件，已删 Canvas 拒绝取得活动条件。退役 alias 可读，只用于历史定位 |
| Agent 与团队 | agentProjectContext、store.agent、agentToolExecution/agentRoundExecutor、teams/* | 新任务保存身份 scope，外部 v2 条件按原值保存；动态加载、审批/排队、耐久 dispatch 前及结果 await 后复核。旧任务不批量写回 scope，读取时只派生本次执行前提。工作台的 Canvas A 与同剧 Episode B 分开；B 正文权限不提升为 A/B 画布写权限。团队原稿 hash、阶段租约、模型指纹与条件保存继续生效 |
| 结果与回退 | agentResultService、fs/projectFiles、agentRewindService、store.history | 项目派生产物在排队/路径准备/真正写入和读回后核原租约；已失效引用不能作为新结果。旧 checkpoint 缺少原运行历史证明、进程变化或 epoch 变化时仅供查看；回退把租约带入异步 undo 内部，避免等待文件恢复时转而撤销新画布 |
| MCP/CLI | mcpProjectContext、mcpControlService/mcpToolCatalog/mcpOperationService、ai-canvas-cli.mjs | v2 信封携带上次读取的 expectedContext，不与旧 expectedProjectId/expectedRevision 混用；缺少/过期条件拒绝 mutation，不自动刷新旧意图。工具发现与派发使用相同目标要求。旧信封的 projectId/expectedProjectId 仍是旧 Canvas alias，原 MCP 会话、operationKey 摘要命名空间和 sequence 不变 |
| 多窗口 | projectWindowContext、chatWindowService/detachedChatSyncController、scriptWorkbenchWindowService、ChatPanel/ChatWindow/ScriptWorkbenchWindow | v2 窗口 session、已发布 snapshotRevision、请求 sequence 和目标条件共同校验。旧写请求或过期目标拒绝并请求同步；普通打字不因自身画布 revision 更新丢稿。发送、收回、关闭等待主窗口处理确认，拒绝/超时保留本地草稿，不把事件发送成功当成交接成功 |
| 原生与插件 | canvasDerivationGuard、plugins/*、director*、aiApps/*、Rust project_execution_context/plugins/window/blender_runtime | 派生 guard、插件会话、真实 Frame/WebView、导演窗口与 Blender grant/Job 捕获准确 owner＋Canvas 条件；切换、同 ID 替换和撤销后拒绝迟到写回，旧运行时对象不恢复成新租约。保留双摘要、Policy、模型/节点/instanceId、Scene revision、路径/SHA/Result Manifest 等原授权和产物校验 |
| 视频剪辑 | videoEditorWindowService/videoEditorService/videoEditorControlService、videoEditorRepository、VideoEditorWindow/VideoNode | 原工程键和 automationRevision/CAS 保留；窗口 instance 绑定原 Canvas 条件，旧窗保留读取/草稿且写入失败关闭。工程保存同事务核旧写门禁及原 Canvas/owner epoch；导出、截图与 AI 转场回传复核原窗口租约，文件入口在异步准备后、真正写入前再次核原条件，不把 typed context 写进工程记录 |
| 历史与账本 | projectExecutionCompatibility、agentTaskService.readOwnerLegacyAgentTaskViews、queryOwnerBillingRuns、Rust billing | 旧记录只派生 owner/Canvas/Episode 只读视图，未知或歧义不猜目标；包括退役 alias。任务先汇总原 alias 再去重排序；SQLite 用 alias 集合在原 app_project_id 列统一分页/求和，原费用与价格快照不重算。聚合上限明确拒绝，不返回伪完整结果；空集合不退化成全账本，新聚合条件不能用于清理 |
| 待续媒体 | pollManager.readPendingMediaTaskViews/registerPendingTaskContextGuard、mediaTools | 查询使用不落盘投影，坏源/未知执行版本明确报错，不把解析失败当空队列。旧 RunningHub 单图、消息和工作流恢复在 await 前取得本进程目标租约，切走再切回不复活旧回调。原队列键、taskId/attemptId、submit_unknown 和既有续查行为保留，不借查询重新付费 |

**新模型正式执行仍失败关闭**：当前 Agent/MCP 执行器背后的任务、会话和 operation 仓储仍是默认 DB27。携 modelGeneration>0 的请求在访问这些仓储/发起 effect 前明确返回 PROJECT_MODEL_EXECUTION_DISABLED，不能因为有 fixture typed DTO 就把隔离资料的同名 ID写入正式旧库。新表只读上下文可供隔离宿主核对，整条正式 Store/UI/执行仓储装配仍属于 P5/P6 激活门禁；不宣称新模型已能在正式应用运行。

无 Canvas 时媒体生成（含 chat 交付）、画布截图、插件节点 UI、Director 等不可用；项目文本、项目资料和原任务只读查询保留。global 是启动/应用级条件，不把空项目提升为全局权限。Plan/B/C/MCP、user_choice、显式媒体选模和最大预算规则没有放宽。

### 20.2 旧 ID、任务回执与失败恢复

- 不修改旧 taskId、conversationId、父子任务、MCP bindingId/keyDigest/inputDigest、sequence、媒体 attemptId、视频工程 `旧CanvasID::nodeId`、video-batches/video-replica-jobs 键、SQLite app_project_id 或原交换身份。不把 owner 字段套进仍按 Canvas 定位的旧接口。
- modelRounds、toolCallCount、resumeCount、tokens、团队 callsUsed/budgetTokensUsed 和原预算上限继续累加。切集、窗口交接、失败恢复和只读历史聚合均不归零，不从新项目身份重建付费任务。
- 材料组装、会话摘要和执行 checkpoint 压缩同样沿用整段冻结 scope；不能在 await 读历史后捕获新 epoch 并调用压缩模型。压缩真实返回的用量和 dispatch 继续结算，过期摘要不写进替换后的会话。
- 工具已明确返回时先结算真实 dispatch 结果，再判断是否能交付；迟到结果交付失败保留原任务的脱敏结果/回执，通过瞬时 effectOutcome 结算 MCP，不能降成未知并自动重投。真实 submit_unknown/dispatched 则继续保持不确定，必须按原回执核实。团队已完成模型调用但缺少可接纳产物时也阻止普通继续重复提交原阶段；原有一次格式修正仍按原预算累计。
- 旧未完成任务仍按既有启动修复进入 paused/unknown；不会升级旧审批或持久对象成为当前授权。旧任务缺原 scope 时可以在既有恢复入口建立本次只读查询/执行前提，但不能声称已证明旧运行历史，也不能据此使用跨进程检查点回退。
- P2 journal、耐久备份、停写确认和 P3 business marker 的保护未放宽。P4 不执行迁移或回滚；撤销业务内容不能撤销真实收费/提交事实。关窗/重启撤销内存租约，保存失败保留草稿/原回执，不通过清空队列、恢复旧预算或删审计记录“修复”。旧媒体恢复读写也先核已知执行版本，坏源/未来格式阻断保存，不能由空数组覆盖；已知旧数组继续既有规范化恢复，不声称整个旧恢复器已变为只读。
- mediaRelocations 继续受旧写门禁与 metadata 白名单限制；不为新表运行扫描递归改写，不触碰冻结源/备份/恢复点。v4 导入导出、恢复 journal、活动新模型媒体/视频工程仓储的最终路由必须与 P5/P6 一起验收；本轮不绕过旧 v1～v3 归档校验或提前开放零集正式导出。
- 剪辑窗口不热切工程；发现另一个工程或已撤租的现存窗口时拒绝改绑，保留窗口供用户保留草稿后手动关闭再重开。IndexedDB 与已发出的系统文件写入/原生传输不能组成原子事务：最后复核后已发出的写可能完成，过期结果仍拒绝关联工程或投影画布，不自动删用户文件、不重投模型。

### 20.3 未执行的验收入口

以下仅供用户在仓库根目录执行，或后续明确授权后执行；本轮均未运行。新增与更新的回归源覆盖上下文解析、同 ID/跨集失效、回执/预算保留、窗口草稿、插件/导演台/AI App 与待续任务。Rust 单元回归源位于相应模块，本轮也没有运行 cargo check/test。

~~~powershell
npx vitest run tests/services/projectExecutionContext.test.ts tests/services/projectExecutionCompatibility.test.ts tests/services/projectWindowContext.test.ts tests/services/projectModelBusinessRepository.test.ts tests/services/volcengineBillingStorage.test.ts
npx vitest run tests/store/agentProjectContext.test.ts
npx vitest run tests/services/chat/agentProjectContext.test.ts tests/services/chat/agentToolExecution.test.ts tests/services/chat/agentRoundExecutor.test.ts tests/services/chat/agentRuntimeDiagnostics.test.ts tests/services/chat/contextCompression.test.ts tests/services/chat/agentTaskService.test.ts tests/services/chat/agentRewindService.test.ts tests/services/chat/agentDurabilityService.test.ts
npx vitest run tests/services/mcp/mcpControlService.test.ts tests/services/mcp/mcpOperationService.test.ts tests/services/mcp/mcpToolCatalog.test.ts tests/services/chat/mediaTools.test.ts tests/services/pollManager.test.ts
npx vitest run tests/services/chat/detachedChatSyncController.test.ts tests/services/scriptWorkbenchWindowService.test.ts tests/services/canvasDerivationGuard.test.ts tests/services/pluginRuntime.test.ts tests/services/pluginResourceService.test.ts tests/services/pluginUiSessionService.test.ts tests/services/pluginUiWindowService.test.ts tests/services/pluginVideoReplicaJobService.test.ts tests/services/directorDeskWindowService.test.ts tests/services/directorNodeOperationService.test.ts tests/services/aiAppService.test.ts tests/services/aiAppRuntime.test.ts
npx vitest run tests/services/chat/chatWindowListener.test.ts tests/services/chat/teamArtifactService.test.ts tests/services/chat/teamInvocationService.test.ts tests/services/chat/teamRuntimeProjectContext.test.ts tests/services/chat/teamModelExecutor.test.ts
npx vitest run tests/services/videoEditorRepositoryProjectContext.test.ts tests/services/videoEditorService.test.ts tests/services/videoEditorWindowService.test.ts tests/services/videoEditorAiTransitionService.test.ts tests/services/fileServiceSaveAs.test.ts
node --test tests/scripts/aiCanvasCli.test.mjs
npm run typecheck
npm run test:typecheck
~~~

桌面验收先准备可丢弃 profile 和旧项目副本，不使用真实收费任务重放。顺序及预期：

1. 旧普通项目/多集剧集正常保存、切换、v3 导出再导入；原文/TXT、共享资料、旧独立设置和素材位置仍保留。没有自动升库、迁移、备份或新模型激活；带 generation>0 的 MCP mutation 在访问默认任务仓储前拒绝。
2. 通过两个不同 CLI 连接读取并提交同一 v2 条件；未变时可复核，切集/同 ID 导入更新/恢复、重启后旧条件拒绝，不自动读取新条件重投。旧 expectedProjectId仍比较原 Canvas；启动页可列出/创建/打开项目。
3. 分别在审批、保存 dispatch、模型返回、工具返回和引用落盘期间切到另一集或导入同 ID 新版本；原结果不能写新目标，原任务预算和真实回执保留。查询原 operationKey不会新建任务；退役目标审计只读，不允许恢复/重投。
4. 主窗显示 A、工作台选 B，发起单 Agent/团队任务；只能读取/条件保存 B 正文。切换作品、替换 B或撤销窗口 session 后旧请求拒绝；没有可接纳产物的已完成调用不在普通继续时重新付费。旧检查点不跨进程或 epoch 撤销当前画布。
5. 聊天/工作台独立窗口编辑并收回/关闭；草稿在主窗口 ACK 后交接。注入旧协议、过期 snapshot、重复 sequence、ACK 丢失和主窗不可用，预期不误写目标且本地草稿保留；超时不自动重发付费或保存请求。
6. 插件内嵌/原生窗口、后台分段/视频批次、轻量导演台、Blender、AI App 与视频剪辑在创建窗口、动态加载、collect、文件对话框和最后投影前切集；预期租约撤销、迟到事件拒绝，原摘要/路径/产物检查仍有效，回执查询和预算不重建。同 ID 导入后旧剪辑窗不能覆盖新工程；未来工程版本不能被当作缺失重建。A→B→A、关窗/HMR/重启都不能给旧运行对象签新授权。
7. 查询旧媒体队列、已删集回执和 owner 费用汇总；查询不改 pending 原串，坏源可见且不当空队列。续查期间切集后不得写到同 nodeId 的另一集；旧未知提交不能重投。全剧费用包含退役 Canvas，分页及总额按原行计算，聚合清理请求拒绝。隔离零集样本仍能查原任务，新媒体/截图/插件/Director均不可用。

**本次未运行测试，待用户验收**。源码静态核对不构成跨窗口、原生进程、耐久恢复、真实费用或归档往返的验收证据；上述门禁通过前，正式迁移继续关闭。

### 20.4 P4 缺陷修复与静态复查

2026-11-07 修复 `1dd201d7` 静态审查确认的四项缺陷，并补齐剪辑控制夹具。以下为已实现、待用户验证的状态，不是运行验收结论。

- Agent 工具的最小成功步骤、脱敏摘要与真实 dispatch 结论在同一次任务快照保存中结算，再保存大结果或交付；保存屏障失败停止后续调用。旧版“成功回执存在但原成功步骤缺失”的非只读记录在重启修复、普通继续和相同请求提交边界保守阻断，裁剪不能删除这类防重证据；不修改成功结论、原 ID、预算或已有 settledAt，只读瞬时失败重试沿用原规则。
- AI 转场使用独立的请求跟踪身份，真实生成入口取得原远端 taskId/attemptId；同请求并发在同步登记边界排他，已保存请求只查原回执。返回的安全 HTTP 结果先写原待续记录，再复核交付租约；其他结果先保存原项目文件，并仅记录安全文件名。RunningHub 使用真实锚点校验提交、独立跟踪回执，Dreamina 不再删除未交付转场回执；恢复分支在普通节点/消息写回前截获结果。原视频节点的“取回 AI 转场”仅查询、下载原任务，由用户重新取得画布派生租约后创建素材节点；不会重新生成、自动改绑旧剪辑窗口或覆盖锚点任务。事件发送成功不当作剪辑器接纳成功，已取回标记也不隐藏再次取回入口，避免窗口拒收或画布自动保存前中断后无法找到原结果。未知提交及损坏队列失败关闭，已删锚点不自动投影；没有远端 ID 的不确定提交仍需到原平台核对，存储失败也不承诺可以恢复唯一内嵌结果。
- 旧模型普通画布的原著/全剧稿等 series 元数据不再被当作无画布容器的证明；仅实际子分集关系改变旧根的画布判定。新模型零集继续依赖权威 project 上下文，不能借旧适配器恢复出虚构画布。
- 聊天窗口及工作台的真实新 WebView 各取得新窗口会话，业务 session、任务身份与草稿语义保持原规则。HELLO/request_sync 不产生新授权，快照、请求、回复及关闭事件均核对原窗口会话；同一真实窗口重连从主窗口已接受序号继续。旧响应不能关闭新窗口或清除新草稿；关闭还取消等待中的打开操作，并防止旧销毁回调清掉新窗口句柄。聊天原生命令只增加固定 URL 会话参数，未扩大 capability 或路径权限。
- `tests/services/videoEditorControl.test.ts` 通过 fake IndexedDB 显式准备 owner/Canvas 项目及各自 exchangeEpoch，仓储写入传入捕获的 CanvasContext。保留并发 CAS、旧人工作业版本、工程键与权限断言，并补缺失上下文、错误归属、owner/Canvas 过期后原工程不变的回归源。

修复同时补充 Agent durability/round/control/restart、旧画布派生、转场真实生成回执及恢复、双窗口会话/重开/迟到响应的回归源；这些文件均未执行。正式 DB_VERSION 仍为 27，正式迁移/恢复写入/激活开关保持 false，未调用 fixture 迁移、真实备份、恢复或项目导入导出；P2 停写确认、耐久备份、journal 和 P3 business marker 门禁均未放宽。v1～v3 读取、v3 导出及 v4 未开放边界维持原合同。

交叉静态复查额外修正了窗口打开等待取消/旧销毁句柄交错、同转场请求并发提交、事件已发送却隐藏恢复入口、过期签名 URL 不重新查询原任务，以及同步结果被误当作远端可查询任务的问题。真实协议回归夹具保留参考素材校验，补全首尾帧变量。已保存到项目文件的结果优先读原文件；只有具备原查询合同的转场才在主动取回时刷新地址，不用生成接口冒充恢复。

普通 Provider 清理不再移除已提交或未知提交的转场身份；明确失败的转场回执保留 terminalFailure，重复旧事件不能把原远端任务变成新生成。未提交且无不确定证据的准备记录仍可沿既有逻辑移除，不能把它伪装成已经收费。最后一轮调用链与交叉静态复查未发现仍待修复的确定阻断项；36 个任务文件严格 UTF-8 核对无替换字符，任务差异的 `git diff --check` 无空白错误。以上均未执行测试或类型检查。

后续验收仍以 Tauri 桌面端的可丢弃 profile 和旧项目副本进行，先不用真实收费任务重放：

1. 普通旧画布上传原著/全剧稿后，确认生成、派生导入和剪辑入口仍可用；旧多集根及权威零集样本仍无可写画布。v3 导出、导入副本后字段与媒体关联保持一致。
2. 在工具返回后、大结果交付前模拟保存失败/重启，确认原成功事实、步骤、预算和回执保留；普通继续不重复提交旧写入。旧成功缺步骤快照明确要求核对，只读瞬时错误仍按原预算重试。
3. 转场提交期间切集或关闭旧剪辑窗，再返回原视频节点主动取回，预期使用原 taskId 查询/下载并创建新素材节点，既不重新付费也不写新分集或旧剪辑工程。另核对重复 requestId 并发、未知提交、下载失败、磁盘失败及原锚点删除，原回执不被清空。
4. 聊天与工作台编辑多次后关闭、收回、重开，新窗口首个请求正常；同窗重连继续递增序号。注入旧会话 HELLO/RPC/ACK、打开等待中关闭、旧销毁迟到、旧付费结果迟到，预期拒绝旧写入、保留草稿并不关闭新窗口。

针对新增源码的命令入口（在仓库根目录，当前不执行）为 `npx vitest run tests/services/videoEditorControl.test.ts tests/services/videoEditorAiTransitionService.test.ts tests/services/scriptWorkbenchWindowService.test.ts tests/services/chat/chatWindowLifecycle.test.ts tests/services/chat/chatWindowListener.test.ts tests/services/chat/detachedChatSyncController.test.ts tests/services/chat/chatReferencePreviewService.test.ts tests/services/chat/agentDurabilityService.test.ts tests/services/chat/agentRoundExecutor.test.ts tests/services/chat/agentTaskControl.test.ts tests/services/chat/agentTaskService.test.ts tests/services/projectExecutionContext.test.ts tests/services/canvasDerivationGuard.test.ts`；原生及归档回归沿用 20.3 的未执行入口。

**本次未运行测试，待用户验收**。本轮静态阅读和交叉复查不能代替类型、自动化、原生窗口、真实存储故障及项目归档往返验收。

## 21. P5 归档与恢复实际实施

本节记录 2026-11-07 的 P5 代码范围。进入本阶段前，上一轮四项缺陷及剪辑夹具上下文修复已提交为 `3fe5f186`；本节随 P5 实现及后续 Rust 编译修复按用户要求一并本地提交，未推送。没有运行测试、类型检查、lint、构建、Rust 检查或桌面程序，也没有调用真实迁移、备份、项目导入导出或恢复。

### 21.1 格式、身份和旧包

- `projectArchiveV4.ts` 实现 v4 manifest、正文 sidecar、canonical2 head 和素材清单的同一收件校验。条目名称、UTF-8 字节数、SHA-256、实体引用、工作台历史目标和素材闭包必须一致；未知字段、重复身份、双权威及缺失材料失败关闭。序列化沿用固定 Worker，并再次经过同一接收器。
- `projectExchangeV2Format/Domain`、`projectMergeV2Service` 保留 canonical1 原修订和原摘要，canonical2 通过带版本父引用连接旧图；没有共同完整基线、未知 adapter 或无法证明旧根／路径映射时拒绝自动合并。v2 历史不能装进 v3 包后伪装成可降级。带点或保留名称的 JSON 字段独立合并，同 mediaId 的不同摘要不得互相覆盖。
- `readProjectModelArchive` 接收 v1～v4；v1/v2 经过原校验与确定性适配，旧孤立分集文稿保留，v3 保原 lineage／canonical1 图，只追加 adapter 修订。新建分配本机作品／分集／画布／根身份，更新沿用当前身份和目录；独立复制建立新 lineage。`archiveHistoryBindings` 用来源命名空间、类型与稳定 origin 去重，不用名称／正文猜身份，不覆盖已有本机历史编辑；退役目标只保留阅读材料，不复活分集或执行授权。

### 21.2 一致捕获和发布

- 新模型 `projectModelTransferRepository` 在同一只读事务捕获作品、各正文域、分集、画布、预览、旧 ID 绑定、协作状态与有界历史。JSON／媒体准备后复核捕获 token；导出 journal 为 `prepared → packing → published → registered`，未发布不得推进协作 head。
- 正式旧路径 `projectArchiveRepository` 同事务捕获整剧、各集历史和协作图；导出检查所有分集的受保护工作台稿件并持锁打包。只保存当前画布不能绕过另一集的脏稿或失联稿件。`projectArchiveRoots` 在旧 v3 导出／更新／恢复前检查真实第二素材根及其当前 imports 引用，无法无损表达时明确拒绝，不静默漏文件或把子目录改绑到主根。
- 同作品未完成导出串行；准备事务核对 expected exchange，导入不能越过尚未登记的外发分支。原生归档先在私有发布记录内冻结原操作，再独占发布输出，提供 opaque publicationRef 和真实包摘要。前端 journal 不保存输出绝对路径。发布后业务编辑可以继续，但登记只 CAS 原协作状态，不能覆盖业务 working copy 或倒退另一条已接受分支。
- 发布结果未知只通过 `reconcileProjectArchiveExport`／fixture `recoverExport` 核对原生原回执，不重新 pack、覆盖文件或冒称未发布。仅尚未进入原生副作用的 prepared 可显式撤销；packing/published 保留核对。内部复制的临时包不登记为源项目外发、不推进源 head。

### 21.3 导入 journal、多根素材和恢复

- 新模型统一 `prepared → media_publishing → media_ready → db_committed → projected → finalized`。首次准备冻结 intent、分配的 ID、目标聚合、来源相对暂存引用、原包文件映射和恢复证明；重试只推进原 journal，不重新合并、生成 ID 或创建第二份安全备份。已提交直接读取原结果，界面投影失败不删媒体、不降回旧画布 ready。
- 各素材根保留独立 rootRef。更新不重绑现有 dataFolder／storageBindings，新增文件发布到各根本操作唯一的 imports 子目录；一根发布成功而另一根失败时，重启先核对已有目录字节，再处理缺失根，全部核验后才能提交数据库。fileBindings 双向投影逻辑路径与本机路径；素材 JSON／Scene／Manifest 的字节与摘要保持不变，不对提示词或完整正文作字符串替换。恢复点和失败发布残留不作为普通附件再次出包。
- 旧 v1/v2 新建、v3 新建／更新及旧恢复均登记阶段，正文、摘要、历史、恢复点和版本用单事务提交，不再逐行保存后反向删除。v3 发布前冻结首次完整提交与媒体清单，v1/v2 解包后、数据库提交前冻结首次分配；旧 CAS 源记录仅存精确摘要，续行先重新读取核对，合法遗留绝对媒体路径不另写入 journal。`resumeProjectImportOperation` 只核原媒体后继续原提交，尚未冻结完整材料的旧 prepared 明确拒绝自动恢复。已提交／提交状态未知通过结构化结果保留原 operationId；当前受影响画布阻断旧状态写入。原操作读回失败不能推断数据库未提交，更不能清理已发布媒体。关闭预览立即撤销运行中提交，但有未成功确认尝试时保留原暂存来源。
- `projectModelPreRestoreBackup` 使用独立 `project-model-fixture-backup-v2`，捕获 fixture 业务及审计侧表、journal 和 pending-task localStorage，写入原生耐久目录、读回校验并封存。恢复准备核完整来源；真正提交前再次核原 sealed 备份和业务 CAS，允许等待期间预算／真实回执前进并原样保留。媒体仍保留原位，不把这份数据库／队列备份称为媒体全量副本；原预览的完整根／文件／字节／摘要清单另以 sourceMediaDigest 冻结并在备份及提交前复核，缺失引用或外部改动即拒绝恢复，不清理旧字节。旧 `project-model-backup-v1` 的格式／表白名单不放宽，旧迁移和 staging 恢复拒绝误用 fixture-v2。
- `restore-content` 直接恢复所选业务快照，保留本机根、当前审计／预算／队列及已接受 lineage，以新的内容域 revision／结构 epoch 和后继修订提交；不把恢复执行成三方合并，不恢复旧任务授权，不切全局 generation。此接口只恢复单作品业务内容，不是全库回滚入口。

### 21.4 正式门禁、回退和验收缺口

正式 `DB_VERSION=27`，`productionMigration/automaticMigration/activation/restoreWrites=false`，v4 `runtimeEnabled=false`。v4 的真实文件适配只允许 `ai-canvas-model-fixture-*` v28 与相匹配的原生 cold-maintenance lease；目录限定在独立 fixture 资产根，不能把真实项目 dataFolder 作为 fixture 源。缺少 lease、专用备份验证器、可信媒体／发布验证器或未知提交状态均失败关闭。

本轮不将正式 Store、Agent／MCP 执行仓储切到新表，不开放真实数据迁移、全库恢复、旧二进制降级或自动清理待核对素材。正式 UI 的 v4 路由、新模型执行仓储和平台停写能力继续是 P6 激活前门禁。回退代码须先检查本轮 journal 和原输出，保留发布文件、暂存与备份；不能删 journal、回退预算或把正式 DB27 改为 v28 代替回滚。本轮没有执行这些操作。

**本次未运行测试，待用户验收**。新增／更新的回归源码覆盖 v1/v2 adapter 与跨版本祖先、v4 篡改／引用／多根、事务 CAS、来源冻结、同操作重试、已提交投影失败、发布状态未知和恢复备份。静态阅读、UTF-8 与差异核对不构成这些用例通过。

用户随后编译反馈归档回归源的一处逗号式 `let` 语法错误，以及维护模块三处调用未启用 `unstable` 的 `Manager::webviews()`。已拆分变量声明，并在现有 vendored Tauri 的 `Manager` 补充只读 `managed_surface_counts()`，分别核对启动前 `(0,0)` 和维护时 `(1,1)` 的窗口／WebView 全量计数，再复核实际宿主及唯一 WebView 的固定维护标签。不能改用会过滤纯窗口和子 WebView 宿主的 `webview_windows()` 冒充全量证明；未开启新依赖特性或窗口权限。此修复尚未重新编译，不能据此宣称 Rust 构建或维护停写已验证。

后续验收使用可丢弃 fixture 和项目／素材副本；禁止拿真实用户库试迁移。Tauri 桌面端依次验证：

1. 读取普通 v1、孤立分集 v1、带两集的 v2／v3，转为 fixture v4 后重新导入、导出；核对旧 ID 映射、全剧／各集原稿、画布、共享资产、中文、附件和不可变产物字节。零集整剧可往返，未来格式与损坏材料拒绝。
2. 两素材根放同名不同字节文件；新建、更新与独立复制后根归属不串，目录绑定保留。当前引用的新 imports 文件纳入，恢复点／失败残留排除。预览后改素材或子集正文应拒绝旧提交；工作台另一集未保存／失联应阻断导出。
3. 在各 journal 阶段模拟取消、配额不足、响应丢失与重启；某一素材根已发布时核原目录后续行，同操作 ID 与目标映射不变。数据库已提交但界面失败时仅重读／重投影，不重合并或清理媒体；读取 marker 失败显示待核对。
4. 打包发布后丢响应，再通过原 operation 核对文件登记；未知／丢失输出不自动重发。并发第二次导出／导入不能抢先推进 head，准备态可撤销，内部复制不产生外发 checkpoint。
5. 恢复前故意令备份写入、读回、封存或提交前复验失败，正文应完整保留。成功内容恢复后当前审计、收费回执、预算、pending task 与 SQLite 不回退，旧 canvas／正文条件失效，accepted lineage 保留；篡改备份与将 fixture-v2 交给旧恢复器均拒绝。

自动化入口供用户在仓库根目录执行：`npx vitest run tests/services/projectArchiveV4.test.ts tests/services/projectExchangeV2.test.ts tests/services/projectModelTransferRepository.test.ts tests/services/projectModelArchiveService.test.ts tests/services/projectModelArchiveNativePort.test.ts tests/services/projectArchiveFixtureFiles.test.ts tests/services/projectArchiveRepository.test.ts tests/services/projectTransferService.test.ts tests/services/projectImportService.test.ts tests/services/projectImportResumeService.test.ts tests/services/projectImportRepository.test.ts tests/services/projectImportRecoveryService.test.ts tests/services/projectImportPersistence.test.ts tests/services/projectArchiveRoundTrip.test.ts tests/services/projectModelBackup.test.ts tests/store/projects.test.ts`。恢复前专用备份回归也包含在 transfer 仓储用例中。原生归档／备份与真实窗口／断电语义须在明确授权的桌面演练中另验，前端 mock 不替代该证据。

### 21.5 2026-11-07 用户授权测试结果

用户授权在当前打开的桌面项目和隔离测试环境验收。桌面端可看到原 EP000 画布的文本与图像，从 EP000 切到 EP001 再切回成功，界面出现保存成功提示；项目库可打开，项目文件面板显示 104 个文件，角色库显示 6 个本项目角色并可切换预览。导出入口打开了保存对话框，本次取消，尚未完成实际打包和导入往返；未对真实项目执行删除、覆盖或数据迁移。

正式源码仍使用 DB27 和旧 `projects` 仓储，迁移、激活、恢复写入及 v4 正式运行开关均为 false。现有画布可打开不能证明已完成新模型转换；本次未直接读取该用户数据库的激活标记，也没有执行转换。

在仓库根目录执行的两个隔离 Vitest 批次存在重叠，不能将结果相加：

- 项目模型、迁移与 fixture 仓储 9 文件：7 通过、2 失败；82 项中 68 通过、14 失败。
- 项目归档、导入恢复与 Store 21 文件：16 通过、5 失败；已收集 429 项中 417 通过、12 失败，另有 2 个失败文件因源码解析错误未能收集用例。

实际执行命令（仓库根目录）：

```powershell
npx vitest run tests/services/projectModelCompatibility.test.ts tests/services/projectModelSettings.test.ts tests/services/projectModelMigrationRepository.test.ts tests/services/projectModelMigration.test.ts tests/services/projectModelSourceFreeze.test.ts tests/services/projectModelStagingRepository.test.ts tests/services/projectModelStaging.test.ts tests/services/projectModelBusinessRepository.test.ts tests/services/projectModelTransferRepository.test.ts
npm run test -- tests/services/projectArchiveV4.test.ts tests/services/projectExchangeV2.test.ts tests/services/projectModelTransferRepository.test.ts tests/services/projectModelArchiveService.test.ts tests/services/projectModelArchiveNativePort.test.ts tests/services/projectArchiveFixtureFiles.test.ts tests/services/projectArchiveRepository.test.ts tests/services/projectImportRepository.test.ts tests/services/projectImportResumeService.test.ts tests/services/projectImportService.test.ts tests/services/projectImportRecoveryService.test.ts tests/services/projectImportPersistence.test.ts tests/services/projectArchiveRoundTrip.test.ts tests/services/projectTransferService.test.ts tests/services/projectArchiveValidation.test.ts tests/services/projectArchiveSerialization.test.ts tests/services/projectExchangeFormat.test.ts tests/services/projectExchangeRoundTrip.test.ts tests/services/projectMergeService.test.ts tests/services/projectChatExport.test.ts tests/store/projects.test.ts
```

已定位两个需修复的源码阻断：`projectModelArchiveService.ts` 的断言换行在测试转换时产生语法解析错误，使两个 v4 编排测试文件无法运行；P2 迁移 journal 中用于比较的普通 `token` 字段被备份编码器当作凭据拒绝，使 fixture 恢复前安全备份失败。不能为此直接放宽通用凭据过滤。其余失败涉及错误文案断言、同步抛错断言，以及旧 canvas epoch／`revisionScope` 和正文容器测试夹具，需要修正或复核后重跑。本轮未修改上述源码，未执行完整构建、Rust 检查或原生故障注入；不能将局部通过解读为完整验收通过。

### 21.6 阻断修复与相关测试重跑

用户授权修复上述问题并继续测试。已修正 v4 归档模块的 TypeScript 解析错误；fixture 备份 v2 对 P2 journal 两处固定比较字段使用可逆编码，读回保留原 `token` 值及 P2 比较合同。旧 v2 空 journal 继续使用原编码，避免现存备份证明的指纹漂移。v1 及普通业务、metadata 的通用凭据检查未放宽；新增覆盖旧 journal 精确往返、伪造／嵌套凭据拒绝、失败／回滚后的历史证据及业务运行后审计前进。

修正错误文案、同步异常断言和 canvas 版本／规范字段等测试夹具后，以下合并上次两批范围并增加备份测试的命令在仓库根目录执行：

```powershell
npx vitest run tests/services/projectModelCompatibility.test.ts tests/services/projectModelSettings.test.ts tests/services/projectModelMigrationRepository.test.ts tests/services/projectModelMigration.test.ts tests/services/projectModelSourceFreeze.test.ts tests/services/projectModelStagingRepository.test.ts tests/services/projectModelStaging.test.ts tests/services/projectModelBusinessRepository.test.ts tests/services/projectModelTransferRepository.test.ts tests/services/projectArchiveV4.test.ts tests/services/projectExchangeV2.test.ts tests/services/projectModelArchiveService.test.ts tests/services/projectModelArchiveNativePort.test.ts tests/services/projectArchiveFixtureFiles.test.ts tests/services/projectArchiveRepository.test.ts tests/services/projectImportRepository.test.ts tests/services/projectImportResumeService.test.ts tests/services/projectImportService.test.ts tests/services/projectImportRecoveryService.test.ts tests/services/projectImportPersistence.test.ts tests/services/projectArchiveRoundTrip.test.ts tests/services/projectTransferService.test.ts tests/services/projectArchiveValidation.test.ts tests/services/projectArchiveSerialization.test.ts tests/services/projectExchangeFormat.test.ts tests/services/projectExchangeRoundTrip.test.ts tests/services/projectMergeService.test.ts tests/services/projectChatExport.test.ts tests/store/projects.test.ts tests/services/projectModelBackup.test.ts
```

结果：**30 文件、525 项全部通过**。测试使用 fake IndexedDB 和模拟原生端口，不能替代原生耐久性、断电、真实文件或桌面导入导出验收。本轮未运行类型检查、完整构建、Rust 检查或桌面交互；正式 DB27、迁移／激活／恢复写入开关和 v4 正式运行开关不变，未迁移真实用户数据。此前 21.5 的失败数保留为当次记录，不代表本次重跑结果。

## 22. P6 隔离演练与 P7 前置收敛

本轮保留正式 DB27、关闭正式迁移／自动迁移／激活／恢复写入和 v4 运行开关；仅操作可丢弃 fixture，不读取或迁移真实用户数据库。P6 正式业务接线与发布验收、P7 旧消费者收敛与稳定期观察尚未完成；不能删除旧表、备份或恢复材料。

隔离生命周期回归连接 P1 旧源读取和备份编码、P2 暂存及 journal、P3 业务仓储：模拟配额失败、备份篡改和按原操作续接，检查旧源、备份、后到预算／任务回执、媒体队列及其他 generation；还检查普通项目转剧集、删除末集保留剧集，以及业务接管后拒绝旧写与 P2 回滚。仓库根目录运行以下命令，7 文件 72 项通过；其后仅调整导入别名，单独复跑该新文件 3 项通过：

```powershell
npx vitest run tests/services/projectModelFixtureLifecycle.test.ts tests/services/projectModelStaging.test.ts tests/services/projectModelStagingRepository.test.ts tests/services/projectModelBusinessRepository.test.ts tests/services/projectModelTransferRepository.test.ts tests/services/projectModelBackup.test.ts tests/services/projectModelMigration.test.ts
```

归档集成把真实 fixture 业务／传输仓储、归档服务和原生端口编排串接，覆盖两素材根同名异内容、导入发布和导出回执丢失后的续接、同源更新与历史去重、删除末集后的零集往返。隔离测试发现 `imports` 目录大小写变体下当前引用可能漏出归档；已与 Rust 扫描规则对齐为大小写不敏感识别，并保留实际路径拼写。以下命令在仓库根目录运行，18 文件 309 项通过；随后增加已接受附件断言，单独复跑集成与原生端口 2 文件 9 项通过：

```powershell
npm run test -- tests/services/projectArchiveRoundTrip.test.ts tests/services/projectArchiveValidation.test.ts tests/services/projectArchiveV4.test.ts tests/services/projectArchiveSerialization.test.ts tests/services/projectArchiveRepository.test.ts tests/services/projectArchiveFixtureFiles.test.ts tests/services/projectModelArchiveService.test.ts tests/services/projectModelArchiveNativePort.test.ts tests/services/projectModelArchiveIntegration.test.ts tests/services/projectModelTransferRepository.test.ts tests/services/projectModelBackup.test.ts tests/services/projectModelBackupFiles.test.ts tests/services/projectImportService.test.ts tests/services/projectTransferService.test.ts tests/services/projectExchangeV2.test.ts tests/services/projectExchangeRoundTrip.test.ts tests/services/projectExchangeFormat.test.ts tests/services/projectExchangeRepository.test.ts
npm run test -- tests/services/projectModelArchiveIntegration.test.ts tests/services/projectModelArchiveNativePort.test.ts
```

在 `src-tauri` 目录分别运行 `cargo test --lib project_archive::tests -- --test-threads=1` 和 `cargo test --lib project_model_safety::tests -- --test-threads=1`，临时目录原生文件测试分别为 31 项和 4 项通过。这些 Rust 单元测试实际操作临时文件；上述前端集成使用 fake IndexedDB 和内存文件／IPC／租约替身。两类证据不能组合冒充真实 Tauri 端到端验收，也不能证明跨进程停写、真实窗口重启、断电和文件系统耐久性。旧 v1～v3 包到新模型的完整桌面往返仍须在独立 fixture 中验收。

P7 前置清单 `scripts/project-model-boundaries.json` 登记 33 个已识别的旧表、旧门面和备份依赖模块，标注收敛优先级、保留原因和移除前提；`scripts/audit-project-model-boundaries.mjs` 只读检查已登记访问类型、部分新模型回退写法和当前正式开关。在仓库根目录运行 `node scripts/audit-project-model-boundaries.mjs`，扫描 1180 个源码文件未报告违规；`npm run test -- tests/scripts/projectModelBoundaries.test.mjs` 的 8 项通过。扫描范围为 `src` 和 `scripts` 中的 JS／TS，且仅识别已知静态表名、门面及有限语法，不覆盖所有动态访问、任意别名、已有模块内同类新增访问或原生行为；清单通过不证明 P7 完成，也不授权清理。

后续正式激活前仍须完成 Store/UI、Agent／MCP 执行仓储和正式归档的统一模型路由，并在独立 Tauri profile 验证真实冷启动、停写、原生备份读回、各故障点续接及回滚。P7 应在正式切换后继续收敛消费者并观察恢复案例，单独确认保留期、降级和清理范围；保留原幂等回执、预算、journal 和备份，禁止将此次前置审计视为允许自动删除的依据。

### 22.1 桌面烟雾验证

用户授权桌面测试后，在当前已打开的旧项目中观察 EP000 → EP001 → EP000 切换，两集画布均可显示。这不能证明旧数据已转换。另用现有 debug 可执行文件启动独立 fixture 维护窗口，页面显示正式迁移关闭且不加载业务脚本；窗口存续时 fixture 锁独占、退出后锁释放。该二进制未重新构建，源码身份未复核；此结果仅为维护入口烟雾测试，不能代替当前源码的维护窗口验收或迁移／回滚／归档端到端测试。正常主窗口仍保持原有项目与运行状态。

进一步隔离复现发现：同一文件被大小写不同的路径引用时，原生重复路径检查会拒绝导出；旧 head 附件或其素材根缺失时，导出和恢复前备份可能错误地把附件视为删除。现对原生验证指向同一真实文件的别名进行合并，并在打包前和发布前复核别名身份及素材摘要；不同真实文件仍失败关闭。旧 head 的文件绑定、素材根和文件必须在嵌套根过滤后仍可定位，否则阻断导出及恢复前备份。文件系统未全程加锁，最终复核与发布之间仍存在外部并发变更的短暂窗口，不能声称跨进程原子冻结。

仓库根目录执行 `npx vitest run tests/services/projectModelArchiveIntegration.test.ts tests/services/projectModelArchiveNativePort.test.ts tests/services/projectModelArchiveService.test.ts tests/services/projectModelArchiveMissingAssets.test.ts`，4 文件 27 项通过；测试使用模拟 IPC 和隔离素材。修复后在 `src-tauri` 目录重跑 `cargo test --lib project_archive::tests -- --test-threads=1`，34 项通过，包括 Windows 临时目录别名及发布前文件变化阻断。独立缺失附件用例还覆盖嵌套根和主／非主根映射，不能代替真实桌面导入导出。

全量测试进一步发现旧 Agent 任务的大结果在交付时可能被误判上下文变化。新结果在引用和持久文件中冻结原执行上下文；旧持久结果只有在原文件和已保存任务的作用域相符时才能恢复，没有原始证明时失败关闭，不使用当前项目重绑定。读写期间分别核对实时任务与冻结上下文；并发读取在异步操作后重新核算剩余预算，避免重复发放；结果清理撤销在途读取，停止任务或撤回 `agent_result_read` 授权后不交付迟到正文。带运行期 epoch 的租约在重启后可能失效；异常路径若允许同 ID、同 epoch 重建，现有持久身份无法区分，仍需上游身份合同与恢复策略补充证明。此处不把不明身份结果静默绑定到当前画布。

持久结果重启后不会恢复原工具的内存授权回调；目前已知项目持久结果来自 `series_get_state`，回读仍校验任务和上下文，但不会重新执行原工具的授权或 allowlist。原工具授权变更后的回读策略需要单独设计和验证，不能宣称重启后已重新核准原授权。

### 22.2 2026-11-08 桌面控制桥验收

用户授权测试后，使用当前运行的 Tauri 开发版本机 MCP 控制桥，在新建测试项目中实际执行以下操作并回读结果：

- 普通项目新建、重命名、设置修改与保存；文本节点中的中文、换行和 emoji 保留。
- 普通项目转为剧集并追加两集，原记录作为第 1 集保留节点；新增分集继承设置，A 集后续修改的提示词后缀不影响 B 集。
- A／B 集各自写入节点，保存、切走再打开后内容独立保留；从其他测试项目打开剧集进入第 1 集，在同剧 B 集再次打开剧集时保留 B 集。
- 全剧剧本和项目角色在同剧分集间共享；独立对照项目不包含这些角色、画布或设置。章节目录及按版本读取有效，正文更新后旧章节引用被拒绝。
- 过期 revision 与跨分集的旧上下文写入被拒绝；跨集查询原画布的操作回执只返回只读审计。项目列表分页返回连续偏移且两页 ID 不重复。

原有两个项目未打开或写入，前后列表中的名称和更新时间一致。保留「桌面验收-项目结构-1108-改名」（3 集）与「桌面验收-隔离对照-1108」供复核，结束时停留在测试 B 集、主面板关闭。以上是桌面进程真实工具调用及保存后重新打开的证据，没有重启应用，不证明冷启动恢复。运行上下文的 modelGeneration 为 0；正式新模型迁移、激活和 v4 运行边界没有打开。

发现截图验收缺口：`ui_set_layout(panel=characters)` 与 `ui_get_layout` 均报告角色库已打开，但两次 `ui_capture_window` 截图都未包含该弹窗。源码中 `mcpUiRuntimeService.renderCurrentDocument` 优先采集 `#root`，而 `ModalOverlay` 将角色库挂到 `document.body`，因此该截图不是完整窗口可见内容，不能据此判定角色库显示失败或视觉验收通过。本次只记录问题，未修改截图实现。

同次测试授权下，在仓库根目录执行以下命令，42 文件、613 项通过；它们使用隔离 IndexedDB／模拟端口，不作为桌面真实归档往返的证据：

```sh
npx vitest run tests/services/projectModel*.test.ts tests/services/projectArchive*.test.ts tests/services/projectTransferService.test.ts tests/services/projectImport*.test.ts tests/services/projectExchange*.test.ts tests/services/projectMergeService.test.ts tests/services/projectChatExport.test.ts tests/services/episode*.test.ts tests/store/projects.test.ts tests/scripts/projectModelBoundaries.test.mjs
node scripts/audit-project-model-boundaries.mjs
```

边界审计扫描 1179 个源码文件、登记 33 个旧依赖模块，未报告违规，仍明确正式激活未就绪。`src-tauri` 中 `cargo check --lib` 通过；`cargo test --lib project_model_safety::tests -- --test-threads=1` 为 4 项通过；`cargo test --lib project_archive::tests -- --test-threads=1` 为 29 项通过、2 项失败。失败的 `round_trips_long_chinese_paths_and_preserves_bytes` 和 `rejects_complete_asset_path_byte_overflow_before_replacing_export` 均在创建 fixture 目录时返回路径过长，尚未进入归档调用；8 层中文目录加本机临时目录及 fixture 前缀约为 1088 字节，超过本机 PATH_MAX=1024。须修正跨平台夹具后重跑，不能视为原生归档已完整通过。Rust 测试编译另报告 `native_rendering.rs` 的 `GPU_MEMORY_ARGUMENT` 未使用警告，普通 lib 检查未报告该警告。

待验收：正式模型激活、旧数据实际迁移、分集换序／删除末集、项目复制、桌面归档导入导出往返、原生对话框、冷启动和故障恢复，以及弹窗的实际视觉与鼠标交互。本次公开控制桥没有提供项目归档／复制／换序的执行入口；没有用内部 Store 调用或真实数据迁移绕过这些边界，也未调用付费模型。此前浏览器尝试只新建了单独的浏览器测试项目，用户明确要求桌面后已停止，未计入上述桌面通过项。

### 22.3 截图／跨平台夹具修复与原文、剧本保存验收

截图采集根改为 `document.body`，保留既有敏感元素过滤、尺寸和编码预算，覆盖 Portal 弹窗；补充根节点外弹窗的回归。在当前 Tauri 开发版重新打开角色库，截图已显示弹窗及测试角色。仓库根目录运行 `npx vitest run tests/services/mcp/mcpUiRuntimeService.test.ts`，12 项通过。

原生归档的长中文路径往返夹具缩短每层目录名，仍覆盖超过 255 字节的中文路径及文件字节往返；超长完整归档名用既有多根映射指向短路径真实文件，继续验证拒绝超限路径、保留原导出及清除临时包，不放宽生产校验。`src-tauri` 中运行 `cargo test --lib project_archive::tests -- --test-threads=1`，31 项通过，上节两项 macOS 夹具失败已消除。

用户另行明确授权 AppleScript 后，仅按当前开发进程定位桌面控件，在新建的「桌面验收-原文剧本-1108」测试剧集中通过实际编辑器操作：

- 新建并保存 `原文.txt`，169 个字符、2 章；通过 `series_read(part=original)` 从真实文件回读，与输入全文逐字一致，中文、换行、引号和 emoji 保留。
- 新建并保存本集剧本 138 个字符，通过 `episode_read(part=script)` 回读一致；全剧剧本通过剧集栏编辑器保存 107 个字符，`series_read(part=script)` 回读一致。
- 切到对照集后，原文和全剧剧本内容一致，对照集的本集正文仍为空。再切到其他测试项目并返回，重新打开原文、本集剧本与全剧剧本编辑器，三份全文均与原输入一致；原文和本集界面显示已保存。

保留测试剧集及两集记录，结束时停在第 1 集工作台的原文页；原有两个用户项目的名称、更新时间未变化。本轮没有在保存这些新正文后重启应用，不把切换重开当成冷启动恢复验证；正式迁移、激活和付费模型调用仍未执行。

### 22.4 项目内容扩展回归与待修复问题

用户继续授权桌面测试后，在 `a8b67cde` 对应的当前 Tauri 开发版操作测试项目，未改动产品源码、开启正式新模型或调用付费模型。原有四个 schema 生成文件的未提交改动保留。以下结论适用于正式 DB27、`modelGeneration=0` 的现有运行路径，不代表新模型激活验收。

已验证范围：

- 通过桌面原生保存对话框导出原文／剧本测试剧集，检查 v3 归档包含两集、正文和素材条目，两份文稿 TXT 的 SHA-256 与输入一致；再通过原生打开对话框导入为新项目。导入副本的原文、全剧剧本和本集剧本全文均一致，副本命名为「桌面回归-项目内容-1108」。
- 分集上移再下移后正文仍跟随原分集 ID；更新单个创作字段不覆盖正文。临时分集追加、删除及回读正常。在独立空白测试剧集中删除至最后一集，再次删除被当前旧格式规则阻止，回读确认最后一集仍保留。
- 人物、场景、普通道具和武器卡片创建成功；人物武器关联在桌面绑定弹窗中已选中。切集和切换项目后重开，四类资产仍属于同一剧集，独立对照项目不包含它们。删除本轮测试武器后，人物的 `weaponIds` 已清空。
- 桌面原文章节浏览显示两章；搜索第二章后列表只保留匹配章，点击可切换。最终回读原文、全剧剧本及当前已保存的测试本集稿件，与各自预期全文一致。原有「项目1」「项目2」未打开或写入，前后列表的名称及更新时间一致。

在仓库根目录执行以下相关回归，29 文件、628 项通过；这些隔离测试不能代替下列桌面缺陷的验收：

```sh
npx vitest run tests/store/projects.test.ts tests/store/dramaAssets.test.ts tests/services/originalWritingService.test.ts tests/services/episode*.test.ts tests/services/storyGraph*.test.ts tests/services/scriptWorkbenchWindowService.test.ts tests/services/projectTransferService.test.ts tests/services/projectImport*.test.ts tests/services/characterWeapons.test.ts tests/services/dramaAsset*.test.ts tests/components/scriptWorkbench.test.tsx tests/components/originalWritingEditor.test.tsx tests/components/storyGraphPanel.test.tsx tests/components/episodeAssetPanelSnapshot.test.tsx tests/components/projectImportDialog.test.tsx
```

实际复现的待修复问题：

1. **项目复制失败**：启动页复制包含文稿的测试剧集，以及复制新建空项目，各尝试一次，均提示「项目复制失败」且没有新增副本。开发版 Web Inspector 的既有错误为「路径未获授权，请先在设置中添加该目录」，目标包含内部 `.duplicate-` 临时归档名。`projectTransferService.duplicateProjectArchive` 在基础目录创建临时包并执行 temporary 打包；普通导出经保存对话框授权后成功。后续需修复内部临时归档的授权流程，不能放宽通用路径边界。
2. **未保存稿与 MCP 保存可无提示互相覆盖**：在导入副本第一集的工作台修改本集剧本但不保存，再用新读取的 episode 上下文调用 `episode_update_script` 保存另一份正文；调用成功，工作台仍保留旧基线上的草稿。随后点击工作台「保存本集」也成功，没有冲突提示，回读确认刚才 MCP 保存的新稿被覆盖。`seriesTools` 的更新路径和 `ScriptWorkbench.saveDraft` 未传递加载时正文基线；`updateEpisodeCreative` 的正文 hash 条件检查仅在调用方提供 `options.expected` 时生效。测试只改动副本，没有用户正文损失。
3. **独立工作台无法保存、关闭或收回**：在测试本集稿件追加未保存内容后切到独立工作台，textarea 全文交接正确；未继续编辑，点击关闭、收回主窗口或保存本集，均被「工作台窗口上下文已变化，请刷新核对；修改仍保留在本窗口，未自动重试」阻断，关闭时也没有正常的草稿处理提示。回读确认新草稿未保存，切走其他测试项目再返回后异常窗口仍在。`scriptWorkbenchWindowService` 的上下文比对拒绝了请求；对真实 `sameProjectWindowContext` 函数做隔离运行，两个语义相同、仅对象键顺序不同的上下文得到 false，属于已验证的比较缺陷，但未采集实际私有 RPC payload，不能断言它是该窗口故障的唯一根因。

异常独立窗口及未保存测试稿保留；草稿另存系统临时目录的 `ai-canvas-detached-regression-recovery-1108.txt`，结束前读取窗口与备份，均与预期逐字一致。主窗口停在导入副本第一集。没有强制关闭窗口、杀进程或把刷新请求记为重载成功。本轮仅测试和记录，以上三个新问题尚未修复或提交。

剩余验收：故事关系图位于工作台内，独立窗口异常使其桌面手工编辑／保存／重开流程受阻，不能由自动化通过推断可用；原文编辑取消／草稿关闭、完整工作台交接、冷启动持久化及故障恢复仍未完成。正式迁移、激活、v4 实际往返与付费生成不在本轮通过范围。

### 22.5 三项桌面缺陷修复实现（待验收）

用户授权修复 22.4 的三个问题后，完成以下源码修改，尚未提交。没有运行测试、lint、类型检查、构建或桌面交互验收；22.4 的 628 项通过发生在本次修复之前，不能作为这些修改的通过证据。

- 项目复制的临时包改放系统默认的应用数据目录，不跟随用户自定义素材根；先确保目录存在，使用非隐藏的 `duplicate-*.aicanvas` 文件名，成功与打包失败仍共用原清理逻辑。继续复用原打包／导入链路，不登记源项目外发，不修改 Rust 路径策略、capability 或私有目录保护。新增自定义素材根下的复制路径断言及临时目录创建失败用例。
- 本集正文、大纲、创作字段三个 Agent／MCP 写工具均接入已有 `withEpisodeEditorWrite` 和 `prepareEpisodeEditorRebase`。活动／失联脏稿和保存中的稿件阻止外部写入，实际保存成功后才同步干净编辑副本，失败不清草稿；锁在完成或异常时释放。工作台另随恢复缓存保存首次编辑时的正文／大纲／创作字段基线，在串行保存入口复核，基线已变化则保留草稿并提示，不把旧副本覆盖回去。保存期间的新修改继续保留，并以已保存的规范化创作字段更新后续基线。英、日、韩提示同步新增。
- 窗口上下文改用既有按值比较函数，忽略 JSON 键顺序；只沿用原先允许变化的画布 revision，项目／分集／画布身份、epoch、runtime 和正文条件字段仍参与比较。工作台草稿签名也按固定字段顺序生成，避免原生事件重排正文对象后误判脏稿。补充键顺序变化、真实租约变化，以及带末次草稿的保存／关闭／收回 RPC 往返用例。

**本次未运行测试，待用户验收。** 可在仓库根目录执行定向回归及前端类型检查：

```sh
npx vitest run tests/services/projectTransferService.test.ts tests/services/projectWindowContext.test.ts tests/services/scriptWorkbenchWindowService.test.ts tests/services/episodeEditorSessionService.test.ts tests/services/chat/seriesTools.test.ts tests/components/scriptWorkbench.test.tsx
npm run typecheck
```

Tauri 桌面验收前保留现有未保存测试稿及其临时备份，使用测试项目副本，依次核对：

1. 启动页复制空项目和含原文／本集剧本的两集剧集，各新增且只新增一个独立副本；核对正文、分集与素材，源项目不变。切换到自定义素材目录后重复，复制仍可完成；应用临时目录不可写时应报告失败，不能创建半成品项目。
2. 工作台修改本集剧本后不保存，调用本集正文、大纲和单个创作字段的 MCP 写工具，应拒绝并保留两侧已有内容。先保存或明确丢弃草稿后再发起新写入，应成功，干净工作台同步新稿，不残留旧编辑副本。
3. 留有恢复缓存的未保存稿时，若其他合法入口已更新保存内容，再保存旧稿应提示冲突并保留草稿；不得覆盖新内容。正常保存后继续编辑与再次保存应成功；保存期间发生的新输入仍保留，下一次保存不因前次字段规范化被误判冲突。
4. 修改本集正文后切到独立工作台，全文保持一致；分别验证保存、收回主窗口及关闭。关闭脏稿应出现正常处理提示，选择继续编辑仍保留原稿，保存并继续后回读一致；收回再独立显示不得丢失末次输入。跨项目、跨分集或旧 epoch 的请求仍应拒绝；故事关系图手工保存／重开与原文关闭取消继续补验。

本轮仅做源码、引用、差异空白和 UTF-8 静态核对；没有清理异常独立窗口、恢复备份或原有四个 schema 生成文件改动。独立窗口故障的完整根因与桌面恢复效果仍须以上述重验确认，不以比较函数修改代替实际验收。

### 22.6 连接前关闭与独立窗口层级补充修复

用户随后反馈工作台停在「正在连接主窗口」，前窗无法关闭且遮挡主窗口。源码确认：连接器尚未收到首帧时已经注册系统关闭拦截，再把关闭消息交给可能已不存在的宿主；同时创建参数的 `parent: 'main'` 会使 macOS 子窗口保持在主窗口前面。

现仅在收到首帧后注册关闭握手，连接前没有可编辑稿件的窗口沿用系统原生关闭，不再等待主窗口消息；移除未初始化关闭事件和父窗口参数。收到稿件后仍通过主窗口处理关闭和脏稿确认，主窗口继续持有保存与模型执行权。没有扩大工作台 capability 或放宽路径、凭据与写入权限。新增组件回归覆盖首帧前不拦截、首帧后保留草稿关闭握手；窗口服务回归核对创建参数不含 parent。

用户要求提交推送时另发现 `scripts/pre-push` 的 Git 文件模式为 `100644`，会被 Git 忽略；现已改为 `100755`，继续执行原有完整 `npm run ci`，不删减门禁。上一组三项修复已实际通过全仓 lint、应用与测试类型检查、710 文件 12,722 项测试和生产构建；该结果早于本节窗口补丁，不能代替本节验证。推送连接在检查期间断开，后续同步使用 SSH 保活并照常执行门禁。

本节桌面行为仍待用户验收：在开发版保留必要草稿备份后，分别验证「打开独立工作台但首帧未到／主窗口回启动页时点击系统关闭」「前后窗口交替点击可独立聚焦」「已载入脏稿时关闭仍需明确处理」。定向入口为仓库根目录 `npx vitest run tests/components/scriptWorkbenchWindow.test.tsx tests/services/scriptWorkbenchWindowService.test.ts`；整体推送门禁仍为 `npm run ci`。没有启动或重启桌面应用来代替用户验收，也未删除旧测试草稿。

包含窗口补丁的完整门禁中，窗口回归通过，整轮共 710 文件通过，旧上传内存测试的两项失败阻止推送。首项在原生请求尚未启动时就断言已启动，未处理的原任务随后影响下一项隔离测试；该文件单独运行 17 项通过。现将固定微任务次数替换为等待真实 mock 原生调用，并在推进超时前立即挂接拒绝断言，底层结算后排空异步任务；保留超时取消、未结算隔离和恢复串行上传的全部业务断言，不修改上传生产实现。修复后定向运行上传内存、工作台窗口组件和窗口服务三个测试文件，41 项通过；整体结果以重新执行的完整门禁为准。

### 22.7 修复后的桌面复测与剩余反馈缺陷

此前修复已提交推送至 `cf9979fb`，最终完整前端门禁实际通过全仓 lint、应用与测试类型检查、711 文件 12,724 项测试和生产构建。用户要求继续测试后，本轮使用当前 Tauri 开发版、已授权的 AppleScript 桌面控件和本机 MCP，在测试副本中执行以下复测；没有重新运行自动化、修改产品源码、开启正式新模型或调用付费模型。

已验证：

- 启动页分别复制空白单集剧集和含原文／剧本／资产的两集剧集，各只新增一个独立根与对应分集，复制不再报路径授权失败。保留「桌面回归-复制对照-1108 副本」和「桌面回归-项目内容-1108 副本」供复核。含文稿副本初次回读的原文、全剧剧本和本集正文与源稿逐字一致，人物、场景和道具名称保留。
- 工作台存在未保存剧本时，本集正文、大纲、单个创作字段的三个 MCP 写入均未改动保存内容，本地草稿也未丢失；错误反馈另见下文。通过工作台保存后，新发起的 MCP 正文写入成功，干净工作台同步新稿，之后继续编辑、保存和重新打开均正常。
- 未保存末次输入交接到独立工作台后全文一致。用系统标题栏关闭按钮触发正常的「继续编辑／放弃修改／保存并继续」提示，取消后稿件完整；保存并继续后独立窗口确实退出，回读正文一致。脏稿收回主窗口时窗口退出、稿件完整且仍未保存，随后保存成功；干净稿关闭不出现伪脏稿提示。
- 独立工作台和主窗口经 AXRaise 与控件交互可交替进入前台；原生 `AXFocusedWindow` 跟随切换，主窗口进入前台时窗口顺序也变为主窗口在前。此结论来自实际两个原生窗口，不以 DOM 截图代替焦点核对。
- 画布保持在第一集，工作台切到第二集并携稿独立显示，保存仅写入第二集；第一集正文逐字不变，当前画布仍为第一集。再次收回主窗口成功。
- 故事关系图手工新增两条关键事件和一条有向关系，保存后切换其他测试项目再返回，列表中的两条记录、关系及记录说明均保留；第二集选择全剧关系可见同一组记录。未调用提取模型。
- 原文修改后关闭、选择继续编辑，草稿完整保留；再次关闭并明确放弃，重新打开及文件回读仍为原保存版本。随后保存新原文，文件回读逐字一致，另一集也能读取共享原文。副本最终原文 201 字符、全剧剧本 107 字符、第一集正文 252 字符、第二集正文 63 字符；源测试项目的原文和正文未受副本修改影响。
- 主窗口返回启动页时，已连接且干净的独立工作台正常清理，最终只剩主窗口并获得焦点。原有「项目1」「项目2」未打开或写入，前后列表中的名称和更新时间一致。

**剩余缺陷：脏稿冲突被误报为结果未知。** 在未保存稿存在时，三个 MCP 写入均返回 `code=2`，正文为「工具已进入调用但结果未知，请先核实原操作；不会自动重投」，而非明确的草稿冲突拒绝。已读回确认保存正文、大纲与创作字段均未变化，工作台草稿完整，随后本地保存及干净状态的新写入正常；未重投那些结果未知的原写入。

源码中 `episodeEditorSessionService.assertEpisodeEditorReady` 在调用写入回调之前抛错，`seriesTools.writeEpisodeContent` 让异常继续上抛；`agentRoundExecutor` 对已登记 dispatch 的非 read 工具异常统一进入 `TOOL_OUTCOME_UNKNOWN`。因此保护生效，但调用方无法从结果知道本次是写入前的明确拒绝。这一反馈问题本轮仅记录，尚未修复；后续应区分可证明未开始写入的冲突与真正的副作用未知，不能把全部写异常都改成可重试失败。

仍未完成：首帧始终未到且宿主失联的桌面故障注入、应用临时目录不可写、缓存草稿与其他合法入口并发提交的专门 CAS 场景，以及本轮新稿的冷启动恢复。正常返回启动页的清理通过不等于已复现并验收所有失联路径。正式迁移、激活、v4 实际往返与付费生成仍不在通过范围。结束时停在启动页，测试内容均已保存，无独立工作台遗留；原有四个 schema 生成文件改动继续保留。

### 22.8 脏稿拒绝反馈修复实现（待验收）

用户授权修复 22.7 的剩余反馈缺陷后，在编辑会话守卫中增加专用 `EpisodeEditorWriteBlockedError`，保留原脏稿／失联稿件／保存中拒绝条件和提示。三个分集写工具复用的 `writeEpisodeContent` 仅在实际写回调尚未开始、且异常属于该专用类型时，返回 `EPISODE_EDITOR_WRITE_BLOCKED`、明确原因及 `retryable=false` 的结构化失败。

通用执行器和副作用未知处理没有调整。写入回调开始后，即使再抛出同一专用错误，也继续上抛，由原执行链保留 `TOOL_OUTCOME_UNKNOWN`、暂停与禁止自动重投；不按报错文案猜测写入事实，不重分类或清理既有未知结果任务。已保存稿件、工作台本地稿和外部写入权限边界沿用原实现。

回归源码覆盖三个工具的脏稿拒绝、保存中／失联编辑会话、同集写锁冲突、成功后的干净副本同步，以及写入开始后的普通／专用错误继续上抛。另在完整 MCP 调用链中核对明确冲突返回错误码、任务为 failed 且响应消息为 done，而写入后异常仍 paused/unknown 且只调用一次。

**自动化已验证，桌面待验收。** 实现阶段仅做静态核对；用户随后授权提交推送，本次修复已通过推送钩子的完整 `npm run ci`：全仓 ESLint、应用与测试类型检查、711 个测试文件／12,732 项 Vitest，以及生产构建。此前桌面通过结论不能代替本次改动的桌面验收。定向回归入口为仓库根目录：

```sh
npx vitest run tests/services/episodeEditorSessionService.test.ts tests/services/chat/seriesTools.test.ts tests/services/mcp/mcpControlService.test.ts tests/services/chat/agentRoundExecutor.test.ts
npm run typecheck
npm run test:typecheck
```

桌面验收继续使用测试副本和用户已开启的 MCP 服务：在工作台修改本集正文但不保存，先读取对应 episode 上下文，再分别发起正文、大纲和创作字段写入，应明确返回 `EPISODE_EDITOR_WRITE_BLOCKED` 与未保存稿原因，不应将该次任务暂停为 `tool_outcome_unknown`；读回保存内容和本地草稿均应保持原样。保存或明确丢弃后，重新读取上下文并由用户发起新的写入，应成功并同步干净工作台。正在保存／失联稿件仍应阻止外部写入。副作用开始后的异常边界使用上述隔离测试验证，不在用户真实数据上注入存储故障。

### 22.9 P6 隔离宿主与 P7 边界补强（待验证）

继续实施 P6／P7 时保持正式 DB27、正式迁移／自动迁移／激活／恢复写入及 v4 运行开关关闭，不迁移真实用户数据。新增显式 `project-model-fixture-host` Cargo feature：仅 Windows debug 构建、以 `--project-model-maintenance-selftest=<fixture-id>` 冷启动时，原生维护窗口才加载内嵌的固定隔离脚本。普通维护页仍禁止脚本；原有 capability、正式数据库入口及通用文件权限没有扩大。脚本绑定唯一 fixture profile 和原生租约，使用固定合成旧项目、Agent 任务及媒体队列；不接受用户文件、数据库或任意路径作为测试输入。构建脚本限制输入模块与外部调用，产物仅写入 Cargo 构建目录。

宿主编排实际 P2 fixture 暂存和原生备份接口：首次注入第二批事务异常并显示 `restart-required`；冷重启取得新租约后，按原 operation 续接或复核已提交回滚，并验证备份、合成源记录、后到的合成任务预算与队列。账本和队列均为原始固定样本时，也允许经 P2 再次核验后续接中断于 `staging`／`verifying` 的原操作；跨存储中断只有已知且可验证的固定样本状态才续接，其余失败关闭并保留材料。这是为后续验收准备的入口，不代表真实配额、断电、完整正式 v27 schema、真实 MCP 绑定或激活后恢复已验证；尚未接入 v1～v4 的原生归档往返，首次初始化和未知 checkpoint 仍可能需要人工核对。

项目持久 Agent 结果新增原工具授权复核：只对来源可证明、零参数且仍符合持久策略的 `series_get_state` 恢复，在读取前后、缓存回读和结果交付前重新检查任务、工具和当前授权；未知来源、权限撤销或缺少原上下文证明继续失败关闭，原文件及历史回执保留。引用／上下文按值比较以兼容键顺序变化，并发读取同一持久结果时复用一致缓存项。此范围不承诺任意历史工具结果均可重启恢复；运行期 epoch 和同 ID／同 epoch 重建仍有上一节所列限制。

P7 旧依赖清单增加按文件、命名作用域、操作和目标的静态调用数量上限；已登记模块新增可识别的旧表／旧门面调用须重新审查，减少调用时报告待收紧余量。隔离宿主单独归类为合成 fixture 消费者。动态别名、未知门面、同一作用域等量替换及未收紧的历史余量仍需人工审查；旧兼容入口没有删除，P7 未进入正式切换后的稳定期。

**本次未运行测试、lint、类型检查、构建或桌面验收，待用户验收。** 相关回归源码入口：

```powershell
npx vitest run tests/services/projectModelFixtureRecovery.test.ts tests/scripts/projectModelBoundaries.test.mjs tests/services/chat/agentResultService.test.ts tests/services/chat/agentToolExecution.test.ts tests/services/chat/resultTools.test.ts tests/services/chat/agentRoundExecutor.test.ts tests/services/mcp/mcpControlService.test.ts
npm run typecheck
npm run test:typecheck
```

授权桌面隔离演练后，在 Windows 的 `src-tauri` 目录使用独立构建目录，避免覆盖正在运行的应用；以下 PowerShell 中两个变量须在两次启动间保持不变：

```powershell
$fixtureTarget = Join-Path $env:TEMP ('ai-canvas-fixture-build-' + [guid]::NewGuid().ToString('N'))
$fixtureId = 'p6-' + [guid]::NewGuid().ToString('N')
cargo build --bin ai-canvas-tauri --features project-model-fixture-host --target-dir $fixtureTarget
$fixtureExe = Join-Path $fixtureTarget 'debug/ai-canvas-tauri.exe'
& $fixtureExe "--project-model-maintenance-selftest=$fixtureId"
```

仅当首次窗口显示 `restart-required`，正常关闭后以同一命令重开，应显示 `complete`；第三次重开只读复核迁移与回滚状态，但 22.10 的归档容器探针可能另行创建固定合成材料。`blocked`、编译失败或任何非预期结果均须保留隔离材料并排查，不能改用真实 profile 或开启正式迁移。首次实际构建、WebView/ACL、真实跨进程停写、持久化与故障行为均待验证。Rust 回归入口为 `src-tauri` 目录的 `cargo test --lib --features project-model-fixture-host --target-dir $fixtureTarget project_model_safety::tests -- --test-threads=1`；它不替代桌面演练。

### 22.10 隔离断点和归档容器补强（待验证）

保持正式 DB27 和迁移／激活／恢复写入及 v4 运行开关关闭。本次没有打开真实数据库、运行迁移、导入导出或访问真实项目素材。

- 首次初始化仅接受固定三表的完全空白状态或完整原始合成样本；样本初始化与核验在同一 IndexedDB 事务中进行。部分写入、陌生 schema 或未知队列保留并阻断。若预期故障已写入 journal 而界面阶段尚未写入，仅在新的冷启动租约下核验原始样本、队列和已封印备份后续接。备份未封印、journal 未生成和其他未知阶段仍可能阻断，不能推断所有中断均可自动恢复。
- Windows debug 且显式启用 fixture feature 时，维护宿主在独占 fixture profile 后用固定合成材料调用原生归档容器打包和解包，核对 v1～v4 标记下的条目、双素材根同名不同字节、ready／published 回执文件与包摘要；不接受页面传入路径或项目数据，不扩大普通窗口命令权限。JSON 为占位材料，**不证明 v1～v4 业务解析、原生对话框、正式命令授权或发布回执丢失后的恢复**。同一 fixture 最多保留八次探针材料，失败或达到上限时保留材料并报告 `archiveContainers: false`，迁移恢复可继续；`true` 只表示本次容器探针完成。
- P7 静态审计补充可解析的动态导入、简单门面别名、计算属性和表名数组／展开，并按词法遮蔽追踪绑定；补登记短剧素材导出的旧项目读取和旧协作仓储事务。运行时赋值、跨文件转发、未知门面和同作用域等量替换仍需人工审查。原有旧业务路径与恢复材料继续保留，清单和调用预算均须实际运行审计后再确认。

**本次未运行测试、lint、类型检查、构建或桌面验收，待用户验收。** 验收时先按 22.9 的隔离流程使用全新 fixture ID；每次窗口应独立检查 `archiveContainers`，只有 `true` 表示本次合成容器检查完成，`false` 不代表容器检查通过。中断初始化、故障 journal 与跨存储续接须分别在可丢弃 fixture 中演练，保留 blocked 材料。前端定向回归和类型检查沿用 22.9；归档原生回归还需在 `src-tauri` 目录使用同一隔离 `$fixtureTarget` 执行：

```powershell
cargo test --lib --features project-model-fixture-host --target-dir $fixtureTarget project_archive::tests -- --test-threads=1
```

仍需完成真实 v1～v4 业务归档往返、正式发布回执恢复链、完整真实 schema 与多平台停写演练、Store／UI 与 Agent／MCP 正式仓储路由、激活后恢复及稳定期观察；缺少实际证据前不能开放正式迁移或退役旧材料。

### 22.11 结构完整性与恢复边界补强（待验证）

继续保持正式 DB27、迁移／自动迁移／激活／恢复写入及 v4 运行开关关闭。本轮没有打开真实用户数据库、项目目录或归档，也没有执行迁移或恢复。

- P2 隔离暂存撤销先核验原生封印和备份，从备份重新投影并核对 journal 暂存计划、原操作、manifest／来源摘要及源 schema，再复核租约；删除暂存行的事务中条件比较 journal 版本和备份身份，并逐表核对已提交的暂存行。缺失、多余或变化的行均保留并中止撤销；后到任务、预算及队列不回退。该条件检查依赖合法写入按合同推进 sequence，不等于已验证真实断电或跨进程停写。
- fixture 业务仓储检查已索引分集的操作归属和排序唯一性；读取／保存／删除正文前核对正文的 generation 和操作，产生分集上下文前核对画布及双向关系，整剧删除也在事务中核对正文。异常中止事务并保留记录；这些仍是隔离仓储能力，没有接入正式 Store/UI。
- 正式归档发布确认与固定 fixture 共用 `prepared → ready → 文件身份及摘要核验 → published` 核心。合成探针保留原 published 回执，再模拟标记缺失并核验同一操作，不重新打包；正式命令原有窗口、路径授权及锁保留。22.10 所述探针现已覆盖这一合成恢复核心，但正式 IPC、系统对话框、真实进程中断及 v1～v4 业务格式往返仍未验收。
- 旧存储健康扫描和清理在使用旧项目引用前以及文件删除前复核冻结／活动模型标记；扫描中标记变化不产出可清理结果。回收站总量与可清理量分别统计；用户发起清理时按需为选中的非空文件捕获内容摘要，确认后每次删除前重新核对摘要以及旧项目、历史、恢复点和实时引用，包含已知相对路径字段。未确认、新增、变化、空文件或被引用的文件保留。该检查只是失败关闭的预检，IndexedDB 与文件删除并非同一事务，也没有覆盖全部媒体版本 pin 和备份闭包，不能替代正式激活前的跨进程停写与清理设计。

另补 v1 孤立分集、v2 剧集、v3 旧修订经隔离仓储导入并再导出 v4 的集成测试源码，以及损坏修订保留原材料的断言；没有实际执行，不能当作业务往返已通过。

**本次未运行测试、lint、类型检查、构建或桌面验收，待用户验收。** 用户可在仓库根目录运行 `npx vitest run tests/services/projectModelBusinessRepository.test.ts tests/services/projectModelStagingRepository.test.ts tests/services/projectModelStaging.test.ts tests/services/projectModelArchiveIntegration.test.ts tests/services/storageHealth.test.ts tests/services/projectThumbnailExclusion.test.ts`，并按 22.9～22.10 的独立 Windows fixture 构建和原生回归步骤验收。正式模型路由、完整归档业务往返、真实故障恢复和稳定期清理仍需完成及验证，不能因这些准备代码而开放正式迁移。

### 22.12 新建项目与旧项目并存（实施中）

用户明确要求：新建项目直接采用项目／分集／画布分离的结构；已有项目继续按原结构使用，不自动转换。新建项目使用新结构不代表开放旧数据正式迁移，也不允许在新旧表间双写同一作品。

旧流程的 `currentProjectId`、持久化、图片文件、Agent／MCP 和 v3 归档均把旧项目 ID 当作画布 ID；隔离业务仓储还依赖迁移 journal 与源冻结，不能直接用于正式新建，否则会冻结旧作品或产生不能重开的半项目。现已增加独立新库及新旧来源识别：新库原子创建项目根、共享内容和画布，支持零集剧集、保根转剧集、分集新增／排序／删除及条件保存；联合目录以轻量身份核对旧源和新源同 ID、墓碑冲突或读取失败，不依前缀猜测或回退到另一边。下述接口和接线尚待本轮测试验收；跨两个 IndexedDB 的检查不是原子写入授权，实际写入仍需原子身份权威或可恢复协调。

新库现提供按需读取项目、目标画布与正文的接口，通过单调项目版本检查多次读取是否属于同一次提交；自动保存所需的画布、共享资料及分集正文也有单事务条件写入接口。导航投影保留项目、分集、画布的独立身份，以及相互独立的显示集号和排序；删除整项时保留身份墓碑和文件材料，删除最后一集保留剧集根。原生素材根增加用户目录及归属校验；Windows 素材字节读写有受限接口，尚需验证目录句柄与中断恢复。归档已接新模型投影、绑定目录的文件端口、素材冻结、历史捕获及可恢复传输 journal，具体边界见下文。

当前桌面 Store 已将新建和默认作品创建接入独立新库；列表、打开、切换、自动保存、项目与分集名称、设置、正文和排序／删除按明确的新旧身份分流。旧项目继续使用原库，删除新剧最后一集保留剧集根；画布运行时上下文与编辑 revision 同步。素材通过显式的画布／作品归属解析新根，常用文件引用在保存时相对化并在重开时恢复；跨集素材浮层、独立资源搜索和使用位置查询已分流新旧项目。新项目可导出 v4 和创建独立副本；导入对话框可接收符合转换校验的 v1～v4 包并将新副本写入新库，旧包更新已有旧项目仍走原有流程。新导入和导出保留原操作 journal、素材暂存及回执，存储健康提供按操作 ID 续接或核验的入口。

**补充实现，待用户验证：** 新项目同源更新已接入素材和分集结构变更：先保存独立归档备份并读回，冻结独立来源和 journal，再分阶段发布素材、核验摘要，最后在严格耐久事务中比较原聚合并提交画布、分集、剪辑工程、墓碑和恢复点。用户需要明确选择保留本机或项目包中的剪辑工程；可在存储健康按原操作继续，或撤销未提交操作并保留材料。旧任务、预算与聊天不随更新回滚。

恢复点保存原本机聚合与剪辑，恢复前逐项核验原素材及独立备份；原分集／画布已经退役时，恢复会在可验证映射闭包内分配新逻辑和本机身份，保留原墓碑、历史任务和原生正文；含未知身份引用时拒绝。带 `assetId` 的恢复采用新项目库中的 `na2` 副本索引，和项目、剪辑、恢复点及回执同事务提交；索引仅持久化受控根与相对路径。全局素材先冻结原字节和元数据为项目副本，恢复不改写原全局索引或旧素材。带索引的恢复素材发布到本次操作的新目录，避免同路径多身份及元数据混淆。旧恢复点未冻结素材元数据时继续保留原身份；原素材缺失且无法证明历史元数据时拒绝重绑，不推断原标签或提示词。未知历史剪辑以及会丢失本机字段的更新仍明确拒绝。未变化的本机节点原样保留；变化内容如无法证明不丢本机字段则拒绝。

当前作品本身引用的文件缺失时，只对当前权威协作 head 和所选恢复点均证明同一文件 ID、根、路径、大小及 SHA-256 的情形建立缺失备份证明。先复制原字节到新操作目录，备份读取端以该受控副本提供原逻辑文件，原缺失路径不覆盖；续接和公开提交入口重新核验缺失事实、来源恢复点及副本摘要。参考图重新冻结后，便携投影使用新文件，原缺失证明仍对原冻结状态核验。全局素材的同操作发布只在完整目录清单、大小和摘要相同时复用，发布成功但响应丢失时不覆盖原副本；原全局来源独立核验。权限错误或未知版本不能当作缺失，也不能用另一版本素材替代。

新项目 V4 包可携带活动与已退役画布的剪辑工程，历史工程只绑定墓碑、不能取得编辑权限；新建导入按新本机身份保留，未知或冲突的历史工程更新仍拒绝。新增可选 `asset-metadata.json` 附件，以逻辑文件 ID 携带标签、图片提示词与参考图，不携带本机素材 ID 或绝对路径；附件参与 manifest 大小和摘要校验。图片参考图按原固定块链摘要及独立文件原始 SHA-256 双重核验，冻结到所属项目主根或子根，恢复和导入均按文件绑定重映射。旧素材的参考图继续位于应用目录，`na2` 参考图按受控项目根解析。更新默认保留同一文件的本机元数据，不以不同字节的同名文件套用旧标签。旧版应用可能拒绝新增附件，新读取端继续接受缺少附件的旧包。

Agent 显式继续只在原持久身份及代际满足时重新绑定运行租约，不重置模型轮次、工具次数、预算或原回执；显式请求的 revision 条件继续核验。新画布检查点绑定捕获时的运行租约，重启或重新加载画布后不能凭相同数值重放旧历史。已有项目派生结果文件仍需验证原工具授权、文件摘要和原任务范围，不能因重新绑定而扩大历史结果权限。

共享素材同步为 `na2` 源在同一新库事务冻结索引、标签和图片元数据基线；旧库提交入口独立核对原 journal 与收据，只跳过已证明的原生只读／不变条件，新目标仍使用新身份，不向旧库写入 `na2` 镜像。终止标记继续与旧库提交争用同一事务，阻止迟到提交。固定恢复副本的旧改名、移动、修复和清理入口仍拒绝直接改写，需先复制为普通素材。

剪辑异步转场已接独立新库账本，覆盖声明式异步模型、火山和具备明确首尾帧合同的 APIMart 模型，冻结原工程、接缝、模型协议及原远端任务 ID；查询返回后先保存产物及真实时长，再以原工程 CAS 和 automationRevision 提交插入及时间轴重排。火山沿原费用任务更新用量，不以恢复生成新计费任务。工程已变化时保留产物，不覆盖用户剪辑；已保存产物可不依赖远端凭据再次核验后插入。状态未知须用户核对，结束跟踪不代表服务商已取消，迟到 ID 不重新取得投递权限。

火山、APIMart、GRSAI H3、无引用 Comfy 视频和仅凭原任务 ID 可重建查询的声明式异步协议已接独立耐久任务账本；声明式单结果覆盖图片、视频和音频，绑定原站点及查询协议摘要，Comfy 还核验原工作流。图片／音频采用独立版本的完整输入指纹，旧视频沿用原算法。Agent、MCP 和对话沿同一工具策略接入 `chat`／`canvas`／`both`，纯对话任务不创建隐藏节点，提交前核验原消息已耐久保存；产物与完成回执先提交新库，再按原会话消息幂等投影。原消息媒体槽已占用时在付费前拒绝复用。火山另支持一张经原生读取和 SHA 校验的项目内 source-image 连线。其他远端或多图、未冻结素材和自定义样式引用在提交前拒绝；文件核验与数据库提交并非同一物理事务。切集、持久代际变化或另一窗口取得新租约阻断旧投递；提交未知不自动重投。已完成媒体与已保留剪辑产物进入归档文件闭包，不把任务或预算作为可回滚内容。没有原任务 ID、查询依赖提交响应其他字段，或原站点／协议无法核实时，仍需核对原平台。未适配的提供商与批量协议继续在付费前拒绝；新账本不自动重建用户已删除的旧媒体历史条目。各实现及回归源码未运行测试，也未经过桌面验收。

APIMart 图片另接多提交／多任务／多候选账本：每次 POST 之前先耐久标记该槽位可能已提交，全部原 task ID 与每个 task 的完整本机候选集合分别保留，不按请求张数截断返回结果。重启只查询原任务；可证明未发出的槽位记录为未开始，未知提交须用户核对后才能交付已确认部分。全部候选与原节点／本批稳定节点身份在同一画布事务发布，对话按稳定序号投影，候选全部进入归档文件闭包。部分失败、未知或未开始的数量进入 UI 与 Agent／MCP 回执，不能把局部成功描述为整批成功；全部本机候选齐全时可无凭据离线交付。迟到 task ID 仅补记，不改变已经交付的候选身份或重新取得投递权限。

媒体画布交付使用专用条件事务，不再借用会拒绝活动 Agent／加载节点的项目更新屏障，也不重新激活整个画布。提交期间订阅画布编辑与切换，中止时保留文件及原任务；成功后保留运行租约并追加一次历史。排队在交付之后执行的旧自动保存重新取当前视图，防止旧快照覆盖已交付结果。

声明式同步单结果也区分为本机产物合同：调用前建立耐久记录，不伪造远端任务 ID；结果以内容摘要文件保存后，可在重启时只核验原文件并完成原目的地交付，不再请求 Provider。尚未取得本机产物且没有远端 ID 的未知调用仍需核对，不能自动重投。设置中的恢复入口同时列出媒体与剪辑回执；已提交任务的原节点或剪辑锚点不可用时，仍可由用户核对后结束本机跟踪并保留原回执与产物，不取消远端任务。结束跟踪后再次显式取回仍须原持久身份有效，且原节点／消息没有后续任务，不能跨任务或新代际写入。

**其他边界：** 新旧库身份冲突检查并非跨库原子授权；旧库历史等记录的捕获与新库更新提交不在同一事务，仍需核对并发写入屏障。更新仓储在提交前独立读回备份、原素材和已发布文件，之后在事务中复核 journal 与项目版本；文件校验与事务之间仍有替换窗口。存储健康清理、非 Windows 内嵌媒体、目录认领和搬迁中断恢复仍需处理。正式旧数据迁移、自动迁移及迁移激活开关保持关闭，本轮没有操作真实用户数据。

当前定向回归入口（仓库根目录，使用 fake IndexedDB 或测试替身）：`npx vitest run tests/services/nativeProjectRepository.test.ts tests/services/nativeProjectNavigation.test.ts tests/services/projectModelRouter.test.ts tests/store/nativeProjectView.test.ts tests/store/projects.test.ts tests/services/storageServiceProjectLoad.test.ts tests/services/projectImportService.test.ts tests/services/projectArchiveV4.test.ts`。这些测试不能替代独立 Tauri profile 下的新旧项目往返、素材检查及中断恢复验收。

本轮新增回归源码入口（同目录，尚未运行）：`npx vitest run tests/services/nativeAssetRepository.test.ts tests/services/nativeAssetReferenceFiles.test.ts tests/services/nativeMissingAssetBackup.test.ts tests/services/nativeProjectArchiveGlobalAssets.test.ts tests/services/projectArchiveAssetMetadata.test.ts tests/services/nativeSharedAssetSources.test.ts tests/services/nativeEditorMediaTaskRepository.test.ts tests/services/nativeEditorProtocols.test.ts tests/services/nativeMediaTaskRepository.test.ts tests/services/nativeImageBatchRepository.test.ts tests/services/nativeMediaMessages.test.ts tests/services/nativeMediaMessageBatch.test.ts tests/services/nativeModelProtocolTask.test.ts tests/services/nativeComfyRecovery.test.ts tests/services/chat/agentResumeContext.test.ts tests/components/nativeProjectRecovery.test.tsx`。`tests/store/nativeProjectView.test.ts` 同时覆盖活动任务交付、编辑／切集中止、旧自动保存重基与重复回执后的持续保存；`tests/services/projectModelArchiveIntegration.test.ts` 包含仅被素材元数据引用的旧根闭包回归。

桌面验收前置为独立 Tauri 数据环境、合成两集项目、测试模型接口或本地工作流，不能用真实用户目录注入故障：

1. 添加本机与全局素材、标签、图片提示词及参考图，保存剪辑工程；导出后更新分集结构并更新导入，检查本机元数据选择、剪辑和原全局素材，删除最后一集仍保留作品根。
2. 在隔离目录删除可由恢复点证明版本的素材，再恢复；检查新文件／素材身份、参考图和标签均完整，原缺失路径未被覆盖。改动摘要、权限或文件版本时应拒绝；中断后在存储健康用原操作 ID 续接，不生成新操作替代未知提交。
3. 发起带原任务 ID 的媒体调用，切集、重启后返回原画布／对话续查；测试接口不应因恢复再次收到生成 POST，产物只进入原目的地。同步已保存产物应可离线交付，无已保存产物的未知请求不得自动重投。APIMart 图片返回多个 task 和超出请求张数的候选时，检查全部候选进入画布、对话与归档；混入失败／未知子提交时回执需如实显示，删除候选消息后重开不应重建。交付中编辑或切集应中止；交付前排队的自动保存不得覆盖新结果。
4. 发起剪辑转场后改变工程或删除锚点，检查结果保留但不覆盖工程；存储健康仍可核对并结束跟踪。原工程未变时取回后按真实时长重排，旧窗口不能覆盖新工程。Agent 显式继续保持累计预算，旧画布检查点不能回退重启后的新历史。

**本次未运行测试，待用户验收。** 源码接线、静态核对与实际桌面验收分开记录；正式迁移相关开关保持关闭。

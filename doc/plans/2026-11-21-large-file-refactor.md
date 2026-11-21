# 大文件盘点与业务目录拆分方案

### 🔎 Large-file scan — 83

2026-11-21，拆分前的盘点基线为 `53f67e73`。工作区按业务拆分达到 1500 物理行的自研文件。以下盘点和详细方案记录拆分前的基线，实际落地与验收见末尾的[分模块落地记录](#分模块落地记录)。

| 口径 | 结果 |
|---|---|
| 用户指定的文件长度 | Git 跟踪、自研功能源码 ≥1500 物理行共 **35** 个。另有 14 个独立测试、3 个 CSS、6 个词典及 1 个官网手册页面。物理行包含空行、注释及 Rust 内嵌测试。 |
| 技能默认发现范围 | 源码 >1000、独立测试 >2000 估算代码行，命中 **83** 个。其中功能源码 62 个、独立测试 8 个、CSS 7 个、语言词典 6 个。完整原表见文末。 |
| ⚠️ Approximate counts | 本机无 `tokei`，扫描器使用内置算法排除空白及识别到的注释，HTML 不在其语言表内。35 个物理行候选均可在原表定位，其中 32 个也达到 1500 估算代码行。 |

项目安装目录为 `.agents/skills/large-file-refactor/`，随项目现有忽略规则保存在本地。`skills-lock.json` 登记了上游提交和目录内容哈希。其他检出可使用仓库的锁文件恢复技能。核对上游版本见 [large-file-refactor 源码](https://github.com/paulrberg/dot-agents/tree/2cc00850ea4e989dc334b2a30179c6b79940c9a8/skills/large-file-refactor)。

在仓库根目录执行以下命令可复现本次扫描。

```sh
uv run .agents/skills/large-file-refactor/scripts/large-file-refactor.py .
```

## 建议实施顺序

| 顺序 | 交付单元 | 为什么排在这里 |
|---|---|---|
| 1 | 剧本工作台的分集创作表单 | 有真实的独立业务入口，两份文件即可交付。主窗和独立窗都能用同一套操作验收。 |
| 2 | 项目 Store 的旧项目重命名，然后按需要提取分集创作 | 最近 100 次提交中该文件涉及 12 次修改，覆盖日常开发热点。先处理单一操作及回滚，再触及共享队列。 |
| 3 | 模型传输测试按请求与交付分组 | 16 个顶层测试组已有语义边界。适合与下一次厂商接入或传输测试维护同步进行。 |
| 4 | 插件注册表的落盘恢复，再拆依赖图 | 尺寸排名第一，最近 100 次提交中直接改动 0 次；含 52 个内嵌测试。排在有原生桌面验收条件的批次。 |

### 第一批 · 分集创作表单（已实现，待验收）

- 修改 `src/components/ScriptWorkbench.tsx`，保留 `ScriptWorkbenchView` 的命名导出、草稿、切集、保存和窗口消息分发。八个字段的唯一一组 `CreativeField` 调用在同一表单。
- 新增 `src/components/workbench/EpisodeCreativeForm.tsx`，与现有大纲面板、文章助手同目录。迁入 `CreativeField` 和八个字段，沿用 `WorkbenchCreativeDraft`，由父组件传编辑与润色回调、禁用状态。保留字段顺序、时长最小值、空白判定、两个无 AI 按钮的字段，以及 `edit_creative`、`polish` 消息的参数。

**验收**　在有两集的桌面项目中打开剧本工作台，修改「核心冲突」，保存后切集再切回。分别在主窗和独立窗确认字段内容、空字段「AI 生成」、非空字段「AI 润色」，以及团队执行模式下的 AI 按钮状态。相邻回归为 `tests/components/scriptWorkbench.test.tsx`、`tests/components/scriptWorkbenchWindow.test.tsx`，这两份用例未逐项覆盖八个字段与润色消息。获本次测试授权后可在仓库根目录执行 `npm test -- tests/components/scriptWorkbench.test.tsx tests/components/scriptWorkbenchWindow.test.tsx`。回滚时把表单及字段组件移回原位置，恢复父组件的原调用。

## 扫描前三名的详细方案

### ✂ Split justified · 项目 Store

**尺寸排名 2，实施顺序 2。** `src/store/store.projects.ts` 同时负责项目切换、旧项目重命名、分集创作、导入与保存。项目库、分集改名对话框和剧本工作台通过同一组 Store Action 调用。初审跟踪了 `renameProject`、`updateEpisodeCreative`、`updateStoryGraph`、`drainProjectSaveQueue`，以及旧项目边界登记表的按文件、作用域和调用数检查。

| 批次 | 完整拟改文件 | 移动范围及保留的契约 |
|---|---|---|
| 2A · 旧项目重命名 | 修改 `src/store/store.projects.ts`、`scripts/project-model-boundaries.json`，新增 `src/store/projects/renameLegacyProject.ts` | 提取旧项目目录改名、节点与分镜引用路径回填、失败还原。新模块登记为对应旧模型消费者，仅迁移原 `renameProject → loadProjectData` 的两次调用额度。统一入口继续处理原生项目、分集写入串行与共享保存队列。 |
| 2B · 分集创作 | 修改 `src/store/store.projects.ts`、`scripts/project-model-boundaries.json`，新增 `src/store/projects/episodeCreativeActions.ts` | 迁入分集创作资料加载、大纲、创作字段和本集资产清单更新。随原调用者移动 `rollbackFile` 的旧读取登记。故事图 CAS 继续按自己的作用域登记。集中管理的写入队列、热更新时复用的 Map、版本和切换序号由原持有者传入或读取。 |

**验收**　先对活动和非活动的旧项目分别改名，核对节点及分镜素材仍可打开。模拟保存失败时目录名和引用应成套恢复。分集改名后共享目录仍能访问；原生项目继续进行版本校验。2B 验证连续保存同一集、切集期间保存和旧版本写入拒绝。实施前后在仓库根目录按授权运行 `npm test -- tests/store/projects.test.ts tests/store/projectSeries.test.ts tests/store/nativeProjectView.test.ts tests/store/projectAssetSyncPersistence.test.ts tests/scripts/projectModelBoundaries.test.mjs`。每批将提取的实现和对应登记一并还原即可回滚，无需数据迁移。

### ✂ Split justified · 模型请求传输测试

**尺寸排名 3，实施顺序 3。** `tests/services/modelRequestTransport.test.ts` 混合厂商请求构造、异步回执/交付和通用网络边界。16 个顶层 `describe` 共用传输替身、全局 `fetch` 保护与 Zustand 初始状态重置。最近 100 次提交中该文件直接改动 0 次，更早的 MiniMax H3 接入及统一结果交付均在此增加过覆盖。

| 完整拟改文件 | 归属 |
|---|---|
| 修改 `tests/services/modelRequestTransport.test.ts` | 保留通用传输边界、标准图片错误与凭据处理，兼容现有定向测试入口。 |
| 新增 `tests/services/modelRequestTransport/imageRequestContracts.test.ts` | 图片请求构造。接收 GPT Image 2.6、ToAPIs 参考上传、上传身份、RelayOnAPI 两组、图片快捷模板及 CCC Gemini 旧路由，相关 multipart 断言随组移动。 |
| 新增 `tests/services/modelRequestTransport/mediaTaskDelivery.test.ts` | 媒体任务交付。接收 MiniMax、Amam、CCC 异步与同步兼容、RunningHub 提交失败、Bearer 结果交付、LibAPI 图片与音频各组。 |
| 新增 `tests/services/modelRequestTransport/transportFixture.ts` | 共用响应构造及每例初始化、清理。每个套件自行提升 `vi.mock` 和传输替身，再将句柄传给准备函数。 |

**迁移与验收**　先抽公共准备，后逐组移动。新目录中的源码导入路径随层级调整。保持每例默认拒绝未模拟的网络请求、重置 Store 和还原 spy。获测试授权后先记录原套件展开的用例标题和数量，再在仓库根目录运行 `npm test -- tests/services/modelRequestTransport.test.ts tests/services/modelRequestTransport/imageRequestContracts.test.ts tests/services/modelRequestTransport/mediaTaskDelivery.test.ts`，对照每组标题、状态及参数化用例数，并各自单独运行以检查隔离。Vitest 现有发现规则覆盖这些文件。任一组发生顺序依赖时，可将该组及私有夹具移回原套件。

### ✂ Split justified · 原生插件注册表

**尺寸排名 1，实施顺序 4。** `src-tauri/src/plugins/registry.rs` 共 5104 物理行，其中第 3429 行起的 1676 行是内嵌测试模块。持久化、依赖图、激活和租约有不同的维护原因。已按 `lib.rs` 的 `#[path]` 注册追踪 `crate::plugin_registry` 调用、运行时及窗口入口，核对 `read_registry_at`、`write_registry_at`、`restore_registry_backup` 和依赖图的四个函数。

| 批次 | 完整拟改文件 | 移动范围及保留的契约 |
|---|---|---|
| 4A · 注册表持久化 | 修改 `src-tauri/src/plugins/registry.rs`，新增 `src-tauri/src/plugins/registry/persistence.rs` | 提取读写、格式与大小校验、备份恢复。复用 `files/registry_write.rs` 的写入方式。父模块持锁，保留调用顺序、损坏判定及路径校验错误。 |
| 4B · 插件依赖图 | 修改 `src-tauri/src/plugins/registry.rs`，新增 `src-tauri/src/plugins/registry/dependencies.rs` | 提取依赖校验、版本指纹、反向依赖撤销和候选激活的依赖检查。保留父模块的命令入口、双摘要核验、撤销租约与终止在途执行的顺序。 |

**验收**　在 `src-tauri/` 目录按授权运行 `cargo check`、`cargo test plugin_registry::tests`。现有用例覆盖原子写入、中断后备份恢复、非法路径不能当作损坏修复，以及缺少依赖、循环依赖和指纹变化。Tauri 桌面上用可停用的测试插件安装、重启、切换版本，再停用被依赖插件，核对依赖方状态。每批单独回滚父模块声明与子模块即可，磁盘格式、IPC 和权限不涉及迁移。

## 35 个功能源码文件的业务目录归属

下表的「目标目录」指将来承接提取实现的位置。原有公开入口可继续留在原路径。标记「拟建」的目录仅在首个有明确职责的模块落地时创建。以下其余条目是候选，表中列明的方向需在排期时核对具体文件清单。

| 业务 | 当前文件 | 物理行 / 技能估算行 | 目标目录 | 拆分判断 |
|---|---|---:|---|---|
| 剧本与分集 | [src/components/ScriptWorkbench.tsx](../../src/components/ScriptWorkbench.tsx) | 2587 / 2522 | `src/components/workbench/` | 先提取分集创作表单，窗口和草稿由工作台协调。 |
| 项目管理 | [src/store/store.projects.ts](../../src/store/store.projects.ts) | 4389 / 4061 | `src/store/projects/`（拟建） | 先旧项目重命名，再分集创作。导入预览、执行和恢复可在后续形成独立一组。 |
| 素材与角色库 | [src/components/AssetsPanel.tsx](../../src/components/AssetsPanel.tsx) | 2152 / 2007 | `src/components/assets/` | 文件浏览、素材卡片及操作。复用已有预览与文件夹导航，面板保留项目切换时的请求校验。 |
| 素材与角色库 | [src/store/store.dramaAssets.ts](../../src/store/store.dramaAssets.ts) | 2096 / 1943 | `src/store/dramaAssets/`（拟建） | 按项目与全局资产、绑定参考图、角色声音及动作素材区分 Action，保留对画布和资产的成套写入。 |
| 素材与角色库 | [src/components/CharacterAssetDialog.tsx](../../src/components/CharacterAssetDialog.tsx) | 1765 / 1354 | `src/components/character/` | 先分节点采集与角色资料编辑，头像裁剪随编辑工作流。 |
| 素材与角色库 | [src/components/CharacterLibraryPanel.tsx](../../src/components/CharacterLibraryPanel.tsx) | 1505 / 1434 | `src/components/character/` | 分离角色动作素材绑定和项目/全局角色浏览，复用已有动作素材逻辑。 |
| 画布、节点与引用 | [src/components/nodes/shared/MentionEditor.tsx](../../src/components/nodes/shared/MentionEditor.tsx) | 2686 / 2507 | `src/components/nodes/shared/` | 先抽引用候选菜单，复用已有来源、历史和 DOM 选区工具。输入法、选区恢复和编辑器 ref 留在编辑器。 |
| 画布、节点与引用 | [src/store/store.nodes.ts](../../src/store/store.nodes.ts) | 2191 / 1978 | `src/store/nodes/`（拟建） | 先评估分镜帧和视频节点绑定。删除节点与媒体回收、历史提交继续成组。 |
| 画布、节点与引用 | [src/components/Canvas.tsx](../../src/components/Canvas.tsx) | 1933 / 1732 | `src/components/canvas/` | 优先吸附线、等距标记和连线落点预览。React Flow 投影、拖动与历史提交共同验收。 |
| 模型、工作流与任务交付 | [src/services/pollManager.ts](../../src/services/pollManager.ts) | 3035 / 2652 | `src/services/ai/polling/`（拟建） | 按厂商拆原任务恢复。热更新状态、回执归属和交付去重留给同一个调度器。 |
| 模型、工作流与任务交付 | [src/services/comfyWorkflowService.ts](../../src/services/comfyWorkflowService.ts) | 2069 / 1738 | `src/services/comfyWorkflow/`（拟建） | 优先工作流分支裁剪和参数注入，复用已有 comfyWorkflowParameters、comfyPolling、comfyOutputs。 |
| 模型、工作流与任务交付 | [src/components/settings/ModelProtocolEditor.tsx](../../src/components/settings/ModelProtocolEditor.tsx) | 2057 / 1969 | `src/components/settings/modelProtocol/`（拟建） | 分请求映射、轮询/结果映射和协议试跑；沿用现有试跑工具。 |
| 模型、工作流与任务交付 | [src/components/nodes/AINodeDialog.tsx](../../src/components/nodes/AINodeDialog.tsx) | 1550 / 1430 | `src/components/nodes/` | 先提取模型参数编辑。提交、取消、节点身份及派生结果回写组成另一个验收单元。 |
| Agent 与外部控制 | [src/services/chat/tools/canvasTools.ts](../../src/services/chat/tools/canvasTools.ts) | 2898 / 2741 | `src/services/chat/tools/canvas/`（拟建） | 先只读查询，再操作节点、连线和分组。保留注册顺序、项目与 revision 校验、授权和批量历史提交。 |
| Agent 与外部控制 | [src-tauri/src/agent/package.rs](../../src-tauri/src/agent/package.rs) | 1887 / 1733 | `src-tauri/src/agent/package/`（拟建） | 包读取与解包、来源登记可分开；解包全过程复用同一套路径、类型和大小校验。 |
| Agent 与外部控制 | [src-tauri/src/mcp/bridge.rs](../../src-tauri/src/mcp/bridge.rs) | 1662 / 1527 | `src-tauri/src/mcp/bridge/`（拟建） | 后置。先评估协议解析；请求关联、会话关闭和并发计数保留在桥接入口。 |
| 项目文件、媒体与存储 | [src/services/indexedDbService.ts](../../src/services/indexedDbService.ts) | 2690 / 2438 | `src/services/indexedDb/` | 按全局角色/短剧资产、输出历史、MCP 任务选一个仓储先移。保留旧库入口和事务范围。 |
| 项目文件、媒体与存储 | [src/services/indexedDb/nativeProjectRepository.ts](../../src/services/indexedDb/nativeProjectRepository.ts) | 2463 / 2299 | `src/services/indexedDb/nativeProject/`（拟建） | 分集/画布读写与导入、更新、导出分组。写前校验和事务提交共同维护。 |
| 项目文件、媒体与存储 | [src-tauri/src/files/project_archive.rs](../../src-tauri/src/files/project_archive.rs) | 2373 / 2181 | `src-tauri/src/files/project_archive/`（拟建） | 按归档物料检查、打包解包及发布回执分组，保留解包验证和临时文件清理。 |
| 项目文件、媒体与存储 | [src-tauri/src/files/transfer.rs](../../src-tauri/src/files/transfer.rs) | 2326 / 2174 | `src-tauri/src/files/transfer/`（拟建） | 区分流式下载与资产目录复制/移动。进度、取消和临时文件清理贯穿整个操作。 |
| 项目文件、媒体与存储 | [src/services/fileService.ts](../../src/services/fileService.ts) | 2000 / 1638 | `src/services/fs/` | 沿用媒体读取、项目文件和素材移动模块。可先迁节点导出，保留前端文件门面。 |
| 项目文件、媒体与存储 | [src-tauri/src/files/wsagent_shared.rs](../../src-tauri/src/files/wsagent_shared.rs) | 1888 / 1776 | `src-tauri/src/files/` | 复用 wsagent_peer、wsagent_entities 与 wsagent_media。协调层区分互联会话与 SQLite 记录。 |
| 项目文件、媒体与存储 | [src/services/storageService.ts](../../src/services/storageService.ts) | 1774 / 1582 | `src/services/storage/`（拟建） | 区分项目媒体序列化/恢复、配置装载和预设持久化，保留运行时凭据读取边界。 |
| 项目文件、媒体与存储 | [src-tauri/src/files/native_project_media.rs](../../src-tauri/src/files/native_project_media.rs) | 1752 / 1572 | `src-tauri/src/files/native_project_media/`（拟建） | 项目根绑定与平台文件访问分开评估；真实路径验证和读写放在同一受控入口。 |
| 插件平台 | [src-tauri/src/plugins/registry.rs](../../src-tauri/src/plugins/registry.rs) | 5104 / 4785 | `src-tauri/src/plugins/registry/`（拟建） | 注册表持久化、依赖图两批独立交付，见详细方案。 |
| 插件平台 | [src/services/plugins/pluginRuntime.ts](../../src/services/plugins/pluginRuntime.ts) | 2366 / 2254 | `src/services/plugins/` | 区分节点集验证、宿主 effect 和工具编排。执行与写回均复核有效 revision 和租约。 |
| 插件平台 | [src-tauri/src/plugins/runtime.rs](../../src-tauri/src/plugins/runtime.rs) | 1721 / 1581 | `src-tauri/src/plugins/` | 后置。可分执行适配与活动调用管理，保持活动调用登记、撤销和取消同步。 |
| 导演台与 Blender | [src-tauri/resources/blender-runtime/v1/scripts/startup/bl_app_templates_user/ai_canvas_director/__init__.py](../../src-tauri/resources/blender-runtime/v1/scripts/startup/bl_app_templates_user/ai_canvas_director/__init__.py) | 2646 / 2367 | `src-tauri/resources/blender-runtime/v1/scripts/startup/bl_app_templates_user/ai_canvas_director/` | 后置。可按场景、摄影机、灯光、控制面板拆，register/unregister 集中。须同步 resources.rs 的内嵌资源、包清单、大小和 SHA-256。 |
| 导演台与 Blender | [src-tauri/src/director/blender_runtime/mod.rs](../../src-tauri/src/director/blender_runtime/mod.rs) | 2094 / 1905 | `src-tauri/src/director/blender_runtime/` | 可先分 Windows 安装发现，保留原生命令和项目授权入口。 |
| 导演台与 Blender | [src-tauri/src/director/blender_runtime/runner.rs](../../src-tauri/src/director/blender_runtime/runner.rs) | 1750 / 1631 | `src-tauri/src/director/blender_runtime/` | 区分进程运行与产物校验，先对照已有 result.rs。验收摄影机 PNG、.blend 与结果清单的一致性。 |
| 桌面装配 | [src-tauri/src/lib.rs](../../src-tauri/src/lib.rs) | 2497 / 2272 | `src-tauri/src/` | 保留窗口和命令注册装配。仅将完整业务实现放回所属模块，例如独立聊天窗口会话。 |
| 本地推理 | [src-tauri/src/media/onnx/mod.rs](../../src-tauri/src/media/onnx/mod.rs) | 2199 / 1910 | `src-tauri/src/media/onnx/` | 按模型准备、worker 生命周期及图像/语音任务评估；复用 worker.rs 和 asr，确认平台清理顺序。 |
| 外观与样式预览 | [src/components/styleGuide/StyleGuideSections.tsx](../../src/components/styleGuide/StyleGuideSections.tsx) | 1877 / 1620 | `src/components/styleGuide/` | 按现有六个样式预览章节拆示例，保留注册顺序、锚点与导航。 |
| 外观与样式预览 | [src/components/settings/AppearanceSettings.tsx](../../src/components/settings/AppearanceSettings.tsx) | 1869 / 1781 | `src/components/settings/appearance/`（拟建） | 按主题预设、背景与玻璃、配色分组。已有组件预览继续复用，草稿刷新时序由原面板控制。 |
| 视频剪辑 | [src/components/videoEditor/VideoEditorWindow.tsx](../../src/components/videoEditor/VideoEditorWindow.tsx) | 1701 / 1515 | `src/components/videoEditor/` | 先分导出状态和失败反馈，保留窗口通信与历史提交顺序。 |

**样式与资源**　`src/styles/ui-kit.css`、`panels.css`、`settings.css` 已有明确入口。如确需拆分面板样式，以具体面板为单位，并保留导入先后、选择器优先级和主题效果。六份设置/节点语言词典已按 locale 和功能归档，维持当前目录。官网 `site/manual.html` 为手册，随章节内容维护。独立测试按被测用例归属，Rust 内嵌测试按 Rust 模块一起验收。

## 技能扫描原表

| Rank | LOC | Language | Path |
| ---: | ---: | --- | --- |
| 1 | 4785 | Rust | `src-tauri/src/plugins/registry.rs` |
| 2 | 4061 | TypeScript | `src/store/store.projects.ts` |
| 3 | 3523 | TypeScript | `tests/services/modelRequestTransport.test.ts` |
| 4 | 3275 | TypeScript | `tests/services/modelProtocol.test.ts` |
| 5 | 3193 | TypeScript TSX | `tests/components/nodeCriticalInteractions.test.tsx` |
| 6 | 2741 | TypeScript | `src/services/chat/tools/canvasTools.ts` |
| 7 | 2680 | TypeScript | `tests/services/pluginRuntime.test.ts` |
| 8 | 2652 | TypeScript | `src/services/pollManager.ts` |
| 9 | 2576 | CSS | `src/styles/ui-kit.css` |
| 10 | 2522 | TypeScript TSX | `src/components/ScriptWorkbench.tsx` |
| 11 | 2507 | TypeScript TSX | `src/components/nodes/shared/MentionEditor.tsx` |
| 12 | 2438 | TypeScript | `src/services/indexedDbService.ts` |
| 13 | 2435 | CSS | `src/styles/panels.css` |
| 14 | 2367 | Python | `src-tauri/resources/blender-runtime/v1/scripts/startup/bl_app_templates_user/ai_canvas_director/__init__.py` |
| 15 | 2355 | TypeScript | `tests/services/generateVideo.test.ts` |
| 16 | 2338 | TypeScript | `tests/store/projects.test.ts` |
| 17 | 2299 | TypeScript | `src/services/indexedDb/nativeProjectRepository.ts` |
| 18 | 2272 | Rust | `src-tauri/src/lib.rs` |
| 19 | 2254 | TypeScript | `src/services/plugins/pluginRuntime.ts` |
| 20 | 2219 | TypeScript | `tests/services/pollManager.test.ts` |
| 21 | 2181 | Rust | `src-tauri/src/files/project_archive.rs` |
| 22 | 2174 | Rust | `src-tauri/src/files/transfer.rs` |
| 23 | 2042 | TypeScript TSX | `tests/components/assetsPanelDrawer.test.tsx` |
| 24 | 2038 | CSS | `src/styles/settings.css` |
| 25 | 2007 | TypeScript TSX | `src/components/AssetsPanel.tsx` |
| 26 | 1978 | TypeScript | `src/store/store.nodes.ts` |
| 27 | 1969 | TypeScript TSX | `src/components/settings/ModelProtocolEditor.tsx` |
| 28 | 1943 | TypeScript | `src/store/store.dramaAssets.ts` |
| 29 | 1910 | Rust | `src-tauri/src/media/onnx/mod.rs` |
| 30 | 1905 | Rust | `src-tauri/src/director/blender_runtime/mod.rs` |
| 31 | 1781 | TypeScript TSX | `src/components/settings/AppearanceSettings.tsx` |
| 32 | 1776 | Rust | `src-tauri/src/files/wsagent_shared.rs` |
| 33 | 1738 | TypeScript | `src/services/comfyWorkflowService.ts` |
| 34 | 1733 | Rust | `src-tauri/src/agent/package.rs` |
| 35 | 1732 | TypeScript TSX | `src/components/Canvas.tsx` |
| 36 | 1638 | TypeScript | `src/services/fileService.ts` |
| 37 | 1631 | Rust | `src-tauri/src/director/blender_runtime/runner.rs` |
| 38 | 1620 | TypeScript TSX | `src/components/styleGuide/StyleGuideSections.tsx` |
| 39 | 1582 | TypeScript | `src/services/storageService.ts` |
| 40 | 1581 | Rust | `src-tauri/src/plugins/runtime.rs` |
| 41 | 1572 | Rust | `src-tauri/src/files/native_project_media.rs` |
| 42 | 1566 | TypeScript | `src/i18n/locales/en-US/settings.ts` |
| 43 | 1531 | TypeScript | `src/i18n/locales/ja-JP/settings.ts` |
| 44 | 1531 | TypeScript | `src/i18n/locales/ko-KR/settings.ts` |
| 45 | 1527 | Rust | `src-tauri/src/mcp/bridge.rs` |
| 46 | 1515 | TypeScript TSX | `src/components/videoEditor/VideoEditorWindow.tsx` |
| 47 | 1485 | TypeScript | `src/i18n/locales/en-US/nodes.ts` |
| 48 | 1474 | TypeScript | `src/i18n/locales/ja-JP/nodes.ts` |
| 49 | 1474 | TypeScript | `src/i18n/locales/ko-KR/nodes.ts` |
| 50 | 1434 | TypeScript TSX | `src/components/CharacterLibraryPanel.tsx` |
| 51 | 1430 | TypeScript TSX | `src/components/nodes/AINodeDialog.tsx` |
| 52 | 1354 | TypeScript TSX | `src/components/CharacterAssetDialog.tsx` |
| 53 | 1340 | Rust | `src-tauri/src/director/blender_runtime/job.rs` |
| 54 | 1330 | TypeScript TSX | `src/components/nodes/shared/PromptPanel.tsx` |
| 55 | 1326 | TypeScript | `src/services/chat/agentRoundExecutor.ts` |
| 56 | 1313 | Rust | `src-tauri/src/agent/web.rs` |
| 57 | 1305 | TypeScript | `src/services/ai/modelProtocolImport.ts` |
| 58 | 1281 | CSS | `src/styles/character-library.css` |
| 59 | 1268 | TypeScript | `src/components/nodes/shared/defaultModels.ts` |
| 60 | 1267 | Rust | `src-tauri/src/media/dreamina.rs` |
| 61 | 1247 | TypeScript TSX | `src/components/chat/ChatPanel.tsx` |
| 62 | 1243 | Rust | `src-tauri/src/plugins/window.rs` |
| 63 | 1209 | TypeScript | `src/services/fs/sharedAssetSync.ts` |
| 64 | 1194 | TypeScript | `src/services/ai/generateVideo.ts` |
| 65 | 1193 | TypeScript TSX | `src/components/nodes/ShotlistNode.tsx` |
| 66 | 1168 | TypeScript TSX | `src/components/settings/PluginSettings.tsx` |
| 67 | 1161 | TypeScript | `src/services/chat/providerConfigDraftService.ts` |
| 68 | 1160 | TypeScript | `src/services/chat/detachedChatSyncController.ts` |
| 69 | 1128 | TypeScript TSX | `src/components/nodes/shared/VideoParamSelector.tsx` |
| 70 | 1115 | CSS | `src/styles/preset-manager.css` |
| 71 | 1111 | Rust | `src-tauri/src/media/comfyui/mod.rs` |
| 72 | 1101 | CSS | `src/styles/nodes.css` |
| 73 | 1091 | Rust | `src-tauri/src/files/thumbnail_cache.rs` |
| 74 | 1086 | Rust | `src-tauri/src/media/sprite_processing.rs` |
| 75 | 1048 | CSS | `src/styles/prompt.css` |
| 76 | 1034 | TypeScript | `src/services/ai/providerCatalogService.ts` |
| 77 | 1033 | TypeScript | `src/services/chat/tools/mediaTools.ts` |
| 78 | 1032 | TypeScript TSX | `src/components/nodes/VideoNode.tsx` |
| 79 | 1026 | TypeScript | `src/services/fs/storageHealth.ts` |
| 80 | 1021 | Python | `src-tauri/resources/blender-runtime/v1/jobs/ai_canvas_director_job_v1.py` |
| 81 | 1017 | TypeScript TSX | `src/components/DramaAssetsPanel.tsx` |
| 82 | 1008 | TypeScript TSX | `src/components/shared/mascot/Mascot.tsx` |
| 83 | 1003 | TypeScript TSX | `src/components/settings/ProviderConnectionDialog.tsx` |

## 分模块落地记录

复扫按物理行计数。基线的 59 个候选包含 35 个功能源码、14 个独立测试、6 个词典、3 个样式和 1 个手册页面。工作区复扫结果为 0 个达到 1500 行的同口径文件，新拆出的源码最大 1486 行。Git 暂存区为空。

以下文件组用于后续独立提交。相应测试迁移随同业务模块提交。拆分及回滚涉及的源文件和新增模块应成组处理。

| 模块 | 实现归属 | 桌面验收 |
|---|---|---|
| 剧本工作台 | `ScriptWorkbench.tsx` 与 `components/workbench/` | 主窗和独立窗保存分集草稿，切集后读回，关系图定位到对应分集和正文。 |
| 项目管理与仓储 | `store.projects.ts`、`store/projects/`、`scripts/project-model-boundaries.json`、新项目仓储入口和 `indexedDb/nativeProject/` | 旧项目和原生项目分别打开、改名、切集、保存、导入或恢复，核对素材引用、事务顺序和历史。旧项目调用额度随原 Action 迁移。 |
| 素材与角色 | `AssetsPanel.tsx`、`components/assets/`、`CharacterAssetDialog.tsx`、`CharacterLibraryPanel.tsx`、`components/character/`、`store.dramaAssets.ts` 与 `store/dramaAssets/` | 素材抽屉切项目、过滤及拖放，选择节点收纳角色参考图、声音及动作，核对项目和全局库状态。 |
| 画布与 Agent | `Canvas.tsx`、`components/canvas/`、`store.nodes.ts`、`store/nodes/`、引用编辑器，以及 `chat/tools/canvasTools.ts` 与 `chat/tools/canvas/` | 平移、缩放、吸附线、分组与连线，使用 @ 引用和输入法，再检查批量更新及撤销。 |
| 模型与任务 | 生成弹窗、设置中的模型协议编辑器、`comfyWorkflowService.ts` 与 `comfyWorkflow/`、轮询和厂商恢复模块 | 检查参数编辑与请求预览，原有异步任务按同一回执续查，核对取消及结果回填。 |
| 文件与存储 | `fileService.ts` 与 `fs/`、`storageService.ts` 与 `storage/`、`indexedDbService.ts` 与独立仓储，及 `src-tauri/src/files/` 的归档、传输、原生媒体、WSAGENT 测试 | 文件流传输与取消、旧稿和素材读回、Agent 授权文件、配置加载和素材回收。 |
| 插件与桌面运行时 | `plugins/registry.rs` 与其目录、插件运行时、`lib.rs` 和 `network/`，以及 MCP、Agent 包、本地推理的独立模块 | 插件安装、停用、版本切换与依赖失效，验证原生代理、MCP 和 ONNX 入口。 |
| 导演台与 Blender | Windows 安装发现和运行器用例，以及模板 `__init__.py`、`camera_preview.py`、`scene_geometry.py`、`runtime-manifest.json`、`resources.rs` | 运行包从 1.5.0 升至 1.5.1，安装到新版本目录。用 Tauri 打开 Blender，验证摄影机预览开关、场景组件及人物白模、保存并返回。回退时运行包清单、内嵌摘要和 Python 文件需一起回退。 |
| 外观、词典和手册 | 外观设置和样式预览、`src/styles/`、英日韩设置/节点词典、`site/manual.html` 与 `site/manual.js` | 对照深浅主题、控件样式和菜单翻译，打开本地手册核对目录和搜索。 |
| 视频剪辑 | `components/videoEditor/VideoEditorWindow.tsx` 及同目录导出模块 | 按原入口导出到文件和画布，回归取消、失败提示、截图和无损拼接。 |

### 复测结果

- 在仓库根目录使用 Node.js 22.22.0。ESLint、应用及测试类型检查和生产构建均通过。Vitest 按四个分片全量运行，15,413 项全部通过。素材目录测试等待 IndexedDB 刷新完成，三个组件测试套件使用与当前 React Reconciler 版本匹配的宿主。
- 在 macOS arm64 的 `src-tauri/` 目录，`cargo check --lib --locked` 通过。`cargo test --lib --locked` 使用默认临时目录，并发与串行各 672 项通过。另用 `cargo test --lib --locked streams_176_mib_without_allocating_the_model_in_memory -- --ignored` 执行了默认跳过的压力用例，通过。
- 在仓库根目录运行 Blender Python 回归，35 项通过。前一轮在真实 Blender 5.2.4 后台验证了模板加载、渲染和保存第 2 帧，产物大小及摘要与回执一致。Tauri 桌面节点回填、实际视频剪辑导出和 Windows 实机仍待验收。

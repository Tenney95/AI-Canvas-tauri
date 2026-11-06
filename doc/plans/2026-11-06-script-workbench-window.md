# 剧本工作台独立窗口与选集解耦

日期：2026-11-06。状态：用户已确认完整方案，首版代码已实现，待用户验收；仅完成静态核对，未运行测试、类型检查、构建、桌面交互或模型调用。

用户要求：在剧本工作台标题栏增加独立窗口按钮；工作台左侧选择分集只切换工作台的数据，画布分集继续由剧集栏的分集列表切换。不是底部逐镜视频批次工作台。

## 交付行为

- 工作台维护自己的剧集、分集和页签，初次打开以当前画布分集定位；同剧集内查看其他分集不调用 `switchProject`。大纲、正文、创作要点、诊断、角色/道具和团队任务统一读取工作台选中集。
- 保留切集/关闭前的保存、放弃、继续编辑流程，以及保存期间新输入的版本保护。非画布当前集保存复用现有元数据读盘、补字段、保存路径，不用其他分集的画布节点覆盖当前图。
- 标题栏的独立窗口按钮使用 UI Kit 公用按钮；成功创建且握手后才隐藏内嵌展示。独立窗口关闭/收回交接最后草稿，失败保留原工作台，不重启团队任务。两种展示共用视图与控件。
- 主窗口是数据、文件保存和模型任务的唯一执行源；独立窗口只接收所需的脱敏快照并发送有会话/版本身份的操作，不加载完整配置、凭据或第二份项目持久化。
- 角色/道具和绑定分集的团队可在当前已加载剧集内操作准确目标；保留清单 revision、正文/上游 hash、编辑会话与异步新鲜度检查。普通 Agent/MCP 的画布权限不放宽。
- 生成本集分镜属于画布写入。工作台选中集与画布当前集不同时明确提示通过剧集栏切换，不能在按钮里暗中换图或向错误画布创建节点。
- 新窗口标签固定为 `script-workbench`，专用 capability 仅开放事件监听、注销与定向发送；原生标题栏沿用系统行为，关闭始终通过主窗口固定窗口接口处理。不加入 `default.json` 的广泛权限或 `path_policy` 可信文件调用方，不新增依赖、原生命令或修改 `tauri.conf.json`。

## 实际代码范围

| 文件 | 改动 |
|---|---|
| `src/components/ScriptWorkbench.tsx` | 独立选集、统一目标、窗口入口、复用视图和受控跨窗动作，保留稿件保护 |
| `src/components/SeriesRail.tsx` | 保留主窗口宿主、内嵌/独立展示交接；剧集栏原画布切集不变 |
| `src/RootView.tsx` | 懒加载独立工作台视图 |
| `src/components/ScriptWorkbenchWindow.tsx`（新增） | 纯展示窗口、快照接收、动作与关闭/收回握手 |
| `src/services/scriptWorkbenchWindowService.ts`（新增） | 固定标签创建/聚焦、主窗同步、请求响应、超时和草稿交接 |
| `src/types/scriptWorkbench.ts`（新增） | 跨窗口 DTO、允许的动作及版本合同 |
| `src/components/series/EpisodeAssetPanel.tsx` | 所选同剧集分集数据与操作上下文，不冒用当前图节点 |
| `src/components/series/EpisodeAssetPicker.tsx`、`src/types/episodeAssets.ts` | 资产选择器共用界面与按需快照合同，独立窗口不直读项目库 |
| `src/components/SeriesSourceBrowser.tsx` | 复用章节界面，通过主窗口按需读取与准备章节分析 |
| `src/services/episodeAssetService.ts` | 目标分集与同剧集授权、异步结果校验 |
| `src/services/episodeWorkspaceScope.ts`（新增） | 同剧集准确目标的纯作用域判断，给稿件、清单与工作台团队共用 |
| `src/store/store.projects.ts` | 同剧集准确目标的清单及团队条件保存，保留串行和回滚边界 |
| `src/services/chat/teams/teamInvocationService.ts` | 仅工作台精确目标的同剧集团队发起与原任务定位 |
| `src/services/chat/teams/teamResultApplyService.ts` | 工作台目标快照、应用/恢复及编辑会话检查 |
| `src/services/chat/agentTaskControl.ts` | 绑定分集的工作台团队继续，普通任务权限保持原规则 |
| `src/services/chat/agentRoundExecutor.ts` | 审批后再核对同一工作台目标，仅两个团队 `file_write` 工具接受同剧集例外 |
| `src/store/store.agent.ts` | 异集任务加载按版本合并，迟到磁盘快照不得覆盖较新运行阶段/预算 |
| `src/services/episodeEditorSessionService.ts`（复用，未修改） | 跨展示方式继续使用主窗唯一草稿登记与锁定，不另建心跳或持久化 |
| `src-tauri/capabilities/script-workbench.json`（新增） | 仅该标签所需三个事件权限，窗口关闭由主窗执行 |
| `doc/画布与项目模块.md` | 产品行为、源码与验收入口 |
| `doc/桌面运行时与安全模块.md` | 独立窗口权限与主窗口执行边界 |
| 本专项、`doc/plans/计划索引.md` | 实际状态、缺口、验收入口与回退 |
| `src/i18n/locales/en-US/series.ts`、`ja-JP/series.ts`、`ko-KR/series.ts` | 新窗口和选集提示词条 |
| `tests/components/scriptWorkbench.test.tsx`（新增） | 所选集展示、分镜画布要求、离开剧集后的只读保留 |
| `tests/services/scriptWorkbenchWindowService.test.ts`（新增） | 监听顺序、会话/版本、最后草稿交接、回复绑定和断开清理 |
| `tests/services/episodeAssetService.test.ts`、`tests/store/projects.test.ts`、`tests/services/chat/teamInvocationService.test.ts`、`tests/services/chat/agentTaskControl.test.ts` | 同剧集准确目标、最窄审批与冲突回归 |
| `tests/services/episodeWorkspaceScope.test.ts`、`tests/services/episodeAssetRoster.test.ts`、`tests/components/episodeAssetPanelSnapshot.test.tsx`、`tests/store/agentTaskLoading.test.ts` | 同剧集域、清单串行、跨窗字段投影与迟到任务加载 |

新增测试只编写、不自动运行。普通小修不重复写其他专项进度；先前 UI Kit 两个组件的改动和其他任务已有改动保持原样。

## 当前实现边界

- `ScriptWorkbenchView` 是内嵌与独立窗口共用的显示层；`ScriptWorkbench` 主窗控制器保留唯一稿件、所选集和业务操作。重复打开聚焦固定窗口，主窗宿主在隐藏内嵌后继续保留。
- 窗口先安装监听再握手，创建/握手受超时约束；状态递增版本、编辑递增序号，最后草稿随保存/切集/关闭请求一起交接。待处理确认、重命名和提取预览另校验相关版本，不能将旧按钮动作套在新内容上。
- 非当前集保存等待已有保存、读盘后再检查，在实际队列提交前再核对；导航一旦离开原画布即失效，切走再切回也不能让旧完整记录恢复有效。带条件的批次独立保序，不与普通自动保存合并；稿件、清单与重命名共用分集串行边界。旧任务加载也不能覆盖较新运行阶段与预算。
- 主窗口只投影展示所需的稿件、模型选项、资产字段和外观；角色/道具、章节浏览、提取预览与成果读取通过受限 RPC，子窗不读文件/凭据、不自行执行模型或写库。画布拖动不触发整份坐标/节点正文同步。
- 工作台当前仅在其原剧集仍加载时允许业务操作；画布离开该剧集则保留稿件并提示回到原剧集，拒绝旧写入。意外卸载后的未确认稿件可在本次运行中按剧集恢复；该内存缓存不跨应用重启，不承诺主进程终止后恢复未保存稿。
- 请求体上限 2 MiB，超限保留子窗编辑并提示，不静默截断。真实 Tauri 窗口、网络/模型异常、关闭时序、视觉和键盘行为尚未实机验证。

## 验收与回退

用户在 Tauri 桌面端使用含两集的可丢弃项目：画布停在 A，工作台选 B，核对稿件、诊断、清单与任务属于 B，而画布和剧集栏当前项仍是 A；保存 B 后重开核对只改 B。带新草稿切集、保存失败、保存期间继续输入不得丢稿。通过剧集栏切换画布后，工作台在同剧集内保持自己的选集。

打开独立窗口应只出现一个工作台，模板/预算沿用公用 Select/NumberStepper。主窗与独立窗分别编辑、保存、收回、关闭、连续点击、重开，最后编辑不能丢失或重复提交任务；同时验收深浅主题、窄窗、键盘与减少动态效果。跨剧集/删除分集/主窗退出时拒绝旧操作。非当前图的生成分镜不自动换图。

用户可在仓库根目录运行以下定向用例与类型检查；命令未由助手执行，不能据此视为通过：

```powershell
npx vitest run tests/components/scriptWorkbench.test.tsx tests/services/scriptWorkbenchWindowService.test.ts tests/services/episodeWorkspaceScope.test.ts tests/components/episodeAssetPanelSnapshot.test.tsx tests/services/episodeAssetService.test.ts tests/services/episodeAssetRoster.test.ts tests/store/projects.test.ts tests/store/agentTaskLoading.test.ts tests/services/chat/teamInvocationService.test.ts tests/services/chat/agentTaskControl.test.ts
npm run typecheck
npm run test:typecheck
```

窗口创建/握手超时、重复请求、迟到确认和最后编辑关闭仍须按上述桌面步骤验收；当前自动化用例不代表已覆盖全部原生故障分支。**本次未运行测试，待用户验收。**

回退关闭独立入口并恢复内嵌展示，保留稿件与任务；新增 capability 可随入口一并撤回，无数据库升级或用户内容删除。运行验证仍按仓库授权规则执行，当前没有测试通过结论。

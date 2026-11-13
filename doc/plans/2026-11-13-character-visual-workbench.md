# 角色形象工作台

状态：角色生图、三视图、文字及画笔改图、MJ 专用通道、小红书单图导入、多图定妆拼接、识图与引用更新均已接入。待桌面验收。本次未运行测试。

## 入口与使用流程

在「新建角色／编辑角色」右侧「参考图」栏，保留「添加图片」，在旁边增加「生成角色形象」。打开工作台后沿用当前角色草稿，可以用已填写的身份、简介、外观和默认服装生成初稿，也可以先从角色参考图、项目／全局素材库选图，或本地上传、粘贴图片。每张输入图可标记本次用途（脸型、发型、服装、体型、风格），提交前展示实际会发送的图片顺序和用途。左侧角色表单、声音、RefMod 和火山方舟继续使用原入口。

工作台上方展示候选图和生成历史，本次单底图生成可以并排对比。下方编辑提示词、选择模型和参考图。用户可「加入参考图」或「加入并设为主视觉」，两者都先回到角色草稿，最后用「保存角色」提交。首张参考图沿用现有默认主视觉规则，已有主视觉时由用户决定是否切换，头像独立设置。工作台素材可仅供本次生成使用。

模型入口复用图片节点的 `ModelSelector`，按相同厂商分组、启用配置及图片工作流展示，不再使用独立厂商白名单。比例、分辨率、质量和背景复用 `QualityRatioSelector`，RunningHub 与工作流复用原参数组件。切换模型保留兼容参数并回退不兼容值，模型参数未声明时可进入原连接设置。`auto` 在界面显示为「自适应」，提交时保留原参数值。生成期间锁定选择，工作台不覆盖画布节点的模型偏好。参数弹层支持视口挂载和独立焦点。已实现，待桌面验收；本次未运行测试。

角色生图沿用图片节点的厂商适配器、声明式协议、原生接口、网页会话和工作流，工作台仅提交显式选择的图片，参考图数量与传输方式仍按模型合同约束。历史支持恢复未保存角色的任务和候选，角色表单以当前草稿为准。有已保存任务 ID 时可「继续查询并保存」，只查询原作业并补存产物；同步请求未返回图片或任务 ID 时保留未知状态，不能伪造续查或自动重发。核对原任务后可结束跟踪，重新生成需显式提交。

「用 MJ 出图」使用已配置的万象 RelayOnAPI Midjourney，同步单次提交、最多一张参考图、期望四个候选，部分交付保留实际产物。画笔蒙版使用已配置的 OpenAI 官方 GPT Image 编辑接口，透明区对应画笔修改范围，PNG 与方向归一后的底图同尺寸且小于 4 MB。蒙版随本次编辑保存在内存，历史保留任务与提示词。蒙版范围对模型提供编辑指引，具体像素结果以候选预览为准。[OpenAI Docs 图片编辑](https://developers.openai.com/api/reference/python/resources/images/methods/edit)

## 功能与实施顺序

| 阶段 | 功能 | 交付行为 |
| --- | --- | --- |
| 1 | 角色生图、素材选取、生成历史 | 复用角色定妆提示词，允许手改提示词并按配置选择兼容模型。可显式调用已配置的文本模型优化提示词，对比并采纳后再提交生图。预览和对比候选图，记录实际模型、提示词、参考图、任务状态及结果。提示词历史可重新载入编辑；再次生成由用户提交。Midjourney 模型列在「用 MJ 出图」通道。 |
| 2 | 用选中图做三视图、按描述改图 | 两个动作均从单张选中底图起步。三视图使用 AI Canvas 已有「正脸特写＋正／侧／背」设定板模板，采纳为 `turnaround`。按描述改图提供前后对照，结果另存为候选。可用画笔限定范围的局部重绘单独接入支持蒙版的模型，验收该模型对遮罩和非编辑区域的实际处理。 |
| 3 | 小红书找参考 | 从工作台直接打开小红书窗口。用户打开图文笔记、翻到目标照片后，点击窗口标题栏的「导入当前图片」，图片自动选为本次参考并带来源返回工作台。 |
| 4 | 多图定妆与拼接 | 正背全身合图、四分之三侧脸、正面近脸分别生成、保留版本并单张重做；选两到三张裁切后可预览并保存为候选。使用工作台现有同步图片模型。 |
| 5 | 按选中图更新角色设定与项目引用 | 视觉模型提出外观、默认服装建议，逐项对比并写入角色草稿。目标图保存为角色参考图后，可预览并勾选改绑当前画布的结构化引用。其他分集与历史中已识别的使用位置供查看，自由文本与剧本保留原文。 |

WSAGENT 的「一键出形象」是 Krea2 LoRA 多步骤定妆流程，和单次生成三栏图是两个入口。其「局部修改」提交底图和文字描述。其「按选中图更新全项目」会识图并尝试写回多份文档。AI Canvas 以自己的角色、素材和引用身份来承接这三项操作。

## 实现边界

- **角色和素材**。新增工作台由 `CharacterAssetDialog` 打开，角色编辑器持有草稿，生成与导入由独立组件和服务承接。沿用 `CharacterReferenceImage`、现有参考图数量限制和角色保存链路。结果先落受管素材或暂存区，采纳时为新图分配稳定参考 ID。项目角色按剧集资产归属保存，全局角色使用全局资产目录。素材已落盘、候选可采纳、角色已保存各自显示真实状态，角色保存失败可重试原结果。切项目、切角色、关闭草稿或底图变化时，迟到结果归原任务，禁止写入当前草稿。
- **生成和恢复**。复用图片节点的模型目录、参考图能力、协议与适配器，提交前固定角色归属、底图、参数和输入列表，角色工作台仅使用显式参考图。共享提交边界分发受信角色目的地，项目／剧集角色沿用原生角色账本，旧项目及未打开项目的全局入口使用自己的角色历史和候选目录。新角色可先生成再保存卡片，关闭后仍可找回草稿任务。「任务回执」展示本机与服务商 ID；已留存原 ID 的查询或保存中断显示「等待续查」，没有远端 ID 的未知提交继续保留待核对状态，不自动重发。未采纳候选由历史持有，保存角色后才进入正式资产包与共享流程。角色候选沿用现有 PNG／JPEG／WebP、大小和像素校验，真实服务商及工作流交付仍须桌面验收。
- **旧连接的参考图兼容**。自定义 OpenAI 兼容连接的 `gpt-image-2` 和 `gpt-image-2-2026-04-21` 在角色工作台使用参考图时，缺少参考图请求配置且沿用标准图片协议的连接，默认向原服务提交一次 `/images/edits` Multipart。显式协议、参考图方式和数量限制优先。图片通过同一个请求直传原连接，继续使用现有任务回执。服务商明确拒绝时显示 HTTP 状态，其他提交状态沿用现有核对流程。真实第三方请求待桌面验收。[OpenAI 图片编辑](https://developers.openai.com/api/reference/typescript/resources/images/methods/edit)
- **小红书导入**。点「小红书找参考」直接打开或聚焦浏览窗口。macOS 将「导入当前图片」放在标题栏，Windows 和 Linux 放在系统标题栏下方的顶部工具栏。按钮复用 UI Kit 小号主按钮和工作台打开时的深浅主题。选中照片并点击导入，成功后回到工作台，图片加入本次参考并带笔记链接；失败时窗口保持打开，顶部显示原因。可在工作台将原图加入角色参考图，随「保存角色」持久化。网页复用小红书专用本机浏览资料，关闭窗口或重启应用后可继续使用网站仍有效的登录状态。macOS 14 及以上使用 WebKit 独立持久化资料，较旧 macOS 使用临时浏览资料。网页排除宿主 IPC、插件脚本及本地资产协议。导入按钮与页面使用独立视图，导入请求只发给发起会话的工作台。图片下载校验站点、图片域、公网地址、大小和可解码格式，按内容去重。工作台历史和本机角色卡只保存规范笔记地址。跨库资产包、云共享和项目归档沿用原来源字段策略。
- **影响范围**。设为主视觉后，依赖角色默认图的后续请求读取新主图；明确指定旧图 ID 的引用继续指向旧图。复用现有资产使用位置扫描，正式改绑仅覆盖用户勾选、作用域与版本仍一致的可编辑目标。批量改绑先准备回退点，写入前复核身份和版本，按实际保存回执显示成功或冲突。全局角色的主图更新不触发跨项目批量改写。

## 桌面验收

1. 在仓库根目录运行 `npm run tauri dev`，通过「设置 → API Key」配置支持的同步图片模型。分别从项目角色、剧集角色和全局角色的新建／编辑入口进入工作台，覆盖未打开项目时的全局入口。验证草稿文字生图、从素材库选图和粘贴图，比较候选、载入历史提示词、采纳并保存，重开后检查图片用途、主视觉、头像和历史归属。
2. 在角色工作台用未配置参考图方式的自定义 `gpt-image-2` 选一张小红书或本地参考图，确认「生成候选图」可用。点击后核对原连接只收到一次图片编辑请求，明确拒绝时在历史中显示 HTTP 状态。再为自定义模型设置服务商支持的 Multipart 或内联 JSON，确认显式配置优先。用其他未配置参考图请求的自定义模型，确认仍提示原因并保留选图。使用已有参考图验证三视图和按描述改图，比较脸型、发型、服装及版式。模拟失败、重复点击及切项目，确认可以找回已提交结果，且候选不会进入其他角色。
3. 提交后关闭工作台，从同一个角色重开历史。未保存角色可从新建角色中的「恢复生成草稿」找回。对仍在生成、已完成和提交状态未知分别核对历史，确认只有已保存的候选可采纳，核对原任务动作只更新本机跟踪状态。
4. 点击「小红书找参考」，确认直接打开网页窗口。在支持持久化的平台登录一次，关掉网页再打开，然后完全退出 AI Canvas 并重启，确认两次重开都保留仍有效的登录状态。使用浅色和深色主题分别打开小红书窗口，确认「导入当前图片」采用 UI Kit 小号主按钮，缩放窗口时保持在顶部。打开有多张图片的笔记，翻到第二张后点击导入，确认带来源链接返回工作台且图片已选中。回到发现页、断网或导入期间翻页时，应在顶部看到失败提示并可重试；关闭工作台后，原窗口和在途结果应随会话清理。配置 OpenAI 官方兼容连接，在「按描述改图」涂抹局部并提交，对比蒙版范围和候选；检查空蒙版、换底图及切换不兼容模型。配置 RelayOnAPI 的 Midjourney，核对单次提交与实际候选数，关闭重开后从原历史采纳。
5. 多图定妆先生成缺少的视角，再重做其中一张、回选旧版本、裁切并预览。选两张和三张各保存一次拼接候选，验证重开后都可作为角色参考图。
6. 项目改绑准备同名角色、默认主图引用、指定旧图引用和历史结果。识图仅采纳一个字段，确认草稿预览和保存；选已保存的目标图预览引用变更，勾选其中一个节点，确认按 ID 命中、其他分集只读，撤销可恢复原引用。预览后改动节点应提示重新预览。
7. 在桌面端启用不同厂商图片模型和图片工作流，对照图片节点核对完整菜单、厂商标识、比例、分辨率、质量、背景及专用参数；普通入口显示完整目录，MJ 标签只作快捷筛选。切换模型检查兼容参数保留、不兼容参数回退，覆盖 `1K`／`1k` 历史值及 `auto`。缩小窗口、滚动、按 Tab 和 Escape，确认面板可见、焦点返回且只关闭当前层。生成期间参数禁用，历史可载入本次参数；三视图、画笔改图、无可用配置及深浅主题都需验收，普通图片节点仍应保持可用。

## 图片节点全模型接入（2026-11-13，已实现，待用户验证）

用户已确认完整实施范围。已移除工作台的厂商白名单并加入受信角色任务目的地，提交意图、远端身份和候选保存归原角色任务。同步、异步、原生和工作流分支已接入，历史增加继续查询／补存。依据为本轮源码差异及调用链静态核对；尚未执行类型检查、自动化测试、付费生成或桌面验收，不代表任何厂商的真实调用已经通过。

### 目标与决定

- 模型目录直接沿用图片节点的启用配置、厂商分组与媒体目录，不再使用角色工作台的厂商白名单。现有图片工作流同时纳入，保持模型 API 与工作流各自的适配器。MJ 入口作为快捷筛选，普通入口不再借此隐藏图片模型。
- 在共享执行入口增加受信的角色任务目的地，绑定项目／剧集归属或全局角色、角色／草稿 ID、operationId、冻结输入摘要及配置身份。继续使用现有 Provider、上传、协议、轮询与下载实现；不创建临时画布节点，不改变普通节点的交付目标。
- 提交前耐久保存操作意图；收到真实任务 ID 后先落回执，再开始查询。角色回执保留原连接、查询合同摘要和有界恢复字段，不保存密钥、完整请求、完整响应或本地绝对路径。恢复只查询原任务、补存原产物；未知提交不能自动重发。
- 项目角色延续原生角色任务账本及作品／角色身份校验；旧项目和全局入口沿用已有角色历史及严格事务。使用同一调用期上下文对接上述存储归属，不向 Store 或 IndexedDB 保存控制器、回调和运行时句柄。
- 同步、异步、网页会话及工作流各自复用原查询合同。恢复前核对连接与协议摘要；连接变化、角色归属变化或结果不完整时保留原回执并给出可操作状态，不能把进程退出或 HTTP 成功等同于候选已保存。
- 模型参数使用图片节点现有控件和参数来源，覆盖比例、分辨率、质量、背景、RunningHub 参数及工作流参数。参考图与蒙版按所选模型实际能力约束，不通过隐藏整家厂商规避差异。按描述改图和三视图同样遵守能力限制。
- 候选逐张保存后登记内容摘要及相对路径；已保存部分可找回，继续查询不能重复添加同一产物。生成完成、候选已保存、加入角色草稿和保存角色继续分别结算。切角色、切项目或关闭窗口不得把旧任务投递到新草稿。

### 分阶段实施与完整预期文件清单

以下保留已确认边界与实际实现入口。通过共享分发已覆盖的适配器沿用原正文，未机械修改全部预期文件；落盘静态核对另发现续存与独占创建冲突，在原候选文件服务中补齐幂等处理。本项无新增依赖、Rust／Tauri 安全配置或 README 修改。测试和英／日／韩词条另列。

1. **建立角色任务执行合同和耐久回执。**
   - 复用 `src/types/aiTypes.ts` 的角色生成入口，在 `src/types/media.ts` 声明参数及可持久化恢复描述，区分运行时对象。
   - 新增 `src/services/characterImageTaskContext.ts`：注册真实调用期上下文，向共享执行器提供提交前复核、回执留存和角色结果交付。
   - 新增 `src/services/characterImageTaskRecovery.ts`：按已有适配器查询原任务，复核配置身份并汇总候选，不含生成重提交分支。
   - 修改 `src/services/nativeCharacterImageTask.ts`、`src/services/characterVisualHistory.ts`、`src/services/characterVisualWorkbenchService.ts`：兼容旧回执，保存新恢复身份，处理项目／全局归属、重复输入、部分产物及继续查询。
2. **把共享执行入口接到角色目的地。**
   - 修改 `src/services/ai/generateImage.ts`：移除工作台专有厂商排除，沿用各模型真实请求和参考素材合同。
   - 修改 `src/services/ai/modelProtocolRuntime.ts`：声明式同步／异步协议使用相同受信变量和原任务恢复字段，支持角色交付。
   - 修改 `src/services/nativeBuiltinImageTask.ts`、`src/services/nativeApimartImageSubmission.ts`、`src/services/nativeGeneralAsyncTask.ts`、`src/services/nativeWorkflowTasks.ts`：在既有提交与回执边界分发角色任务，复用查询及下载逻辑；普通画布入口继续使用原基线和交付守卫。
   - 修改 `src/services/nativeWorkflowExecution.ts`：识别受信角色上下文，不把普通回调或 Renderer 布尔值当成提交授权。
3. **对齐所有图片通道的实际提交和续取。**
   - 修改 `src/services/ai/apimartGen.ts`、`src/services/ai/providers/standardImage.ts`、`src/services/ai/providers/volcengineImage.ts`、`src/services/dreaminaService.ts`：同步结果、APIMart／通用异步任务、CCC 任务和即梦原生任务使用上述角色目的地；不绕过原通道校验。
   - 复用 `src/services/comfyWorkflowService.ts`、`src/services/workflowApi/workflowApiAdapter.ts`、`src/services/ai/providers/runninghubWorkflow.ts`、`src/services/ai/providers/runninghubMedia.ts`、`src/services/ai/providers/museMedia.ts` 的原提交、上传和查询；共享执行标识及工作流分发负责角色任务的 ID 留存和返回交付，无须另写 Provider 请求。网页会话继续使用原发送确认和原任务查询。
   - 修改 `src/services/fs/characterVisualFiles.ts`：续存时复用相同字节的已有文件，其他内容的同名文件失败关闭，由角色服务分配未占用编号。原生候选使用独立暂存名及既有内容摘要目录，按摘要去重；最多保留 128 张实际候选，不按请求张数截断额外产物。
4. **统一工作台入口和状态呈现。**
   - 新增 `src/components/character/CharacterVisualGenerationSettings.tsx`：组合已有模型、参数和工作流控件，避免在工作台主组件堆积 Provider 分支。
   - 修改 `src/components/character/CharacterVisualWorkbench.tsx`、`src/components/character/CharacterVisualMultiView.tsx`：使用完整目录及同一参数合同，补继续查询／补存状态，保持结果采纳和草稿归属。
5. **记录状态与验收缺口。**
   - 修改本专项 `doc/plans/2026-11-13-character-visual-workbench.md`，按阶段区分已实现和待用户验证。
   - 修改 `doc/模型与生成模块.md`，只记录共享执行目的地边界并链接本专项。
   - 修改 `src/i18n/locales/en-US/character.ts`、`src/i18n/locales/ja-JP/character.ts`、`src/i18n/locales/ko-KR/character.ts`，同步实际新增和移除的状态文案。

已新增 `tests/services/characterImageTaskContext.test.ts`、`tests/services/characterImageTaskRecovery.test.ts`、`tests/services/characterVisualModels.test.ts`、`tests/services/characterVisualFiles.test.ts`、`tests/components/characterVisualGenerationSettings.test.tsx`，覆盖受信目的地、单作业防重、无生成重提的原任务查询、合同变化拒绝、部分结果、完整模型目录及候选幂等写入。既有普通节点回归入口为 `nativeBuiltinImageTask.test.ts`、`nativeGeneralAsyncTask.test.ts`、`nativeApimartImageSubmission.test.ts`、`nativeWorkflowTasks.test.ts`、`apimartGen.test.ts`、`museMediaSubmission.test.ts`。所有用例均未在本轮执行。

用户可在仓库根目录执行 `npm run typecheck`，以及 `npx vitest run tests/services/characterImageTaskContext.test.ts tests/services/characterImageTaskRecovery.test.ts tests/services/characterVisualModels.test.ts tests/services/characterVisualFiles.test.ts tests/components/characterVisualGenerationSettings.test.tsx tests/services/nativeBuiltinImageTask.test.ts tests/services/nativeGeneralAsyncTask.test.ts tests/services/nativeApimartImageSubmission.test.ts tests/services/nativeWorkflowTasks.test.ts tests/services/apimartGen.test.ts tests/services/museMediaSubmission.test.ts`。这些检查不能替代下面的 Tauri 桌面验收。

### 验收与回滚

桌面验收前准备各已配置通道中至少一个图片模型；付费调用由用户显式操作。先比较图片节点和工作台的完整目录及参数，再分别验收无参考图、单图／多参考图、三视图和按描述改图。覆盖 APIMart、火山方舟、CCC、GRSAI、LibAPI、ToAPIs、RelayOnAPI／MJ、Amam、自定义协议、RunningHub、即梦、Muse，以及已经导入的图片工作流；具体可用性以图片节点同一配置下的实际支持为准。

提交后分别关闭工作台、退出应用、断网和中断查询，重开时应显示同一 operationId 和远端任务 ID，继续查询只取原任务并补存候选。覆盖未知提交、明确拒绝、部分结果保存失败、连接变更、删除／重建角色、项目／分集切换、全局角色且未打开项目，以及模型缺少某项参考图能力。普通图片节点的生成、恢复、保存和任务身份必须保持可用。最后检查深浅主题、键盘焦点及参数面板防裁切。

回滚仅撤销本节任务目的地、分发分支和界面接入，保留模型配置、角色素材、回执和本机候选，不删除数据库或覆盖用户配置。新代码兼容没有恢复字段的旧角色回执；恢复描述本身带版本。旧版无法查询新增恢复字段时应保留数据库并恢复本轮代码后续查，不能把新记录当作未提交任务重发。本轮未新增 object store、数据库结构升级或凭据迁移。

## 源码核对入口

- AI Canvas 的角色草稿与保存见 `src/components/CharacterAssetDialog.tsx`、`src/store/store.dramaAssets.ts` 和 `src/services/characterLibraryService.ts`。参考图身份和定妆提示词见 `src/types/dramaAssets.ts` 与 `src/services/dramaAssetPrompt.ts`。
- 工作台界面见 `src/components/character/CharacterVisualWorkbench.tsx`，角色历史和候选交付见 `src/services/characterVisualWorkbenchService.ts` 与 `src/services/nativeCharacterImageTask.ts`。生图复用 `src/services/ai/generateImage.ts`，设定板模板见 `src/components/nodes/shared/slashCommands.ts`。
- 使用位置与隔离窗口参考见 `src/services/assetUsageService.ts`、`src-tauri/src/media/muse.rs`。
- 小红书宿主与会话见 `src-tauri/src/media/xiaohongshu_reference.rs`、`src/services/characterXiaohongshuReference.ts` 与 `src/components/character/CharacterVisualWorkbench.tsx`，隔离使用现有 vendored Tauri 的 guest 分支。识图和批量改绑见 `src/services/characterVisualProjectUpdate.ts`，拼接和画笔转换见 `src/services/characterVisualComposition.ts`。
- WSAGENT 的交互入口位于 `apps/workspace/src/domains/generation/components/MediaGenerationWorkspace.tsx` 和 `CharacterAppearanceDialog.tsx`。小红书位于 `apps/workspace/electron/src/xhs-workspace.ts` 与 `xhs-image-import.ts`，项目文档写回位于 `services/server/internal/service/generation/generation_visual_definition.go`。

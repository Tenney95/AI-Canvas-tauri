# 异步媒体交付与原任务恢复

## 目标与范围

补齐 CCC 异步图片响应，并让图片、视频、音频沿用同一套任务交付边界：取得远端任务 ID 不等于完成，本地保存和目标回填都成功才结束任务。沿用 `pollManager` 的 PendingTask，不新增队列、数据库、依赖或原生权限。

用户已确认任务、厂商适配、节点、批量、主窗口对话及 MCP 的实施范围，并补充确认普通对话控制器及其回归用例。独立对话窗口继续回主窗口操作恢复；同步接口没有任务 ID 时不伪造可恢复任务。

## 实施边界

1. 查询期限覆盖请求与响应正文读取，超时中止该次查询；普通文本流及同步生成不套用查询期限。
2. 已提交任务遇到断网、超时、结果映射或下载保存异常时暂停，保留连接、项目与原任务身份。提交响应丢失且没有 ID 时显示“提交状态未知”，不自动重发。
3. 结果返回携带项目、跟踪目标、任务 ID 和执行身份回执；调用方持久化并通过 Store 成功回填后精确确认。旧回执不得清理新任务。
4. 同一节点再次生成前将未交付旧任务移到恢复节点；恢复只查询或下载已有任务。分阶段音乐恢复到歌词时只回填歌词，后续音乐由用户显式生成，状态不确定时禁止盲目重放。
5. CCC 仅对已确认厂商身份使用文档中的任务查询结构，保留旧同步返回兼容。取得异步 ID 后不因产物不足自动补交图片请求；未知厂商不猜查询路径。
6. 任务记录不保存凭据、本地路径或完整请求正文。原有画布派生守卫、专用取消协议与站点身份继续有效。
7. RunningHub、工作流 API 和 ComfyUI 继续沿用各自专用提交及取消流程；本批将已有 ComfyUI 任务接入对话交付恢复，不改其首轮提交服务，不承诺恢复没有留下任务记录的 ComfyUI 中断。RunningHub／工作流 API 的纯消息任务仍在重开原项目、加载原会话后专用恢复，尚未接入通用手动恢复按钮；通用 MCP 列表不将这些任务标为可直接续查。同步接口没有远端 ID 时也无法补出原任务查询能力。

## 当前状态

- 已补齐共享任务回执、CCC 异步图片适配、节点及批量交付、主窗口普通对话与 Agent/MCP 恢复入口，并补充回归源码。
- 2026-10-23 经用户追加授权进行复核：21 个相关测试文件、680 项用例通过；本批文件定向 ESLint、应用 TypeScript 类型检查及差异／UTF-8 静态核对通过。
- 测试 TypeScript 检查仍报告其他并发任务新增的 `tests/components/promptPolishPanel.test.tsx` 两处 props 断言类型错误，本批未修改该文件，不能将全仓测试类型检查记为通过。
- 本次未运行构建、桌面验收或付费请求。各真实渠道的字段兼容、响应正文中断、磁盘失败及多入口恢复仍需按下列步骤验证；自动化回归不能代替真实桌面交付验收。

## 复核修复

- 旧批次移入恢复节点后，原节点退出旧分组，旧任务恢复不会覆盖随后生成的单张图片。
- 查询取消保留原 `AbortError` 与调用方原因；保留 ComfyUI 断线任务恢复和本轮开始时间。
- CCC multipart 只有参考素材准备完毕、即将发起生成 POST 时才标记提交已发送；准备失败保留真实素材错误。
- APIMart 音乐明确的提交 HTTP 拒绝与状态未知分开处理；失败或中断均不重发生成。
- 节点直接续取对话任务时按需安装消息交付处理器；通用恢复能力判断由任务核心复用，工具不虚报支持的任务种类。
- 普通对话的 RunningHub 产物在消息保存并复核原任务身份后才清理记录，保存失败保留原任务。

## 桌面验收

前置：使用 Tauri 桌面端，配置可用的异步图片、视频、音频连接，准备一个测试项目。真实生成产生厂商费用，由用户自行选择执行。

1. CCC 文生图及带参考图生成，等待完成：预期识别任务 ID，查询完成后图片保存并显示；返回旧同步图片结果时仍可交付。
2. 任务已提交后断网：预期结束持续加载并保留原任务；恢复网络点击继续查询，厂商后台不新增生成任务。
3. 查询超时或响应正文不结束：预期本次查询可中止，节点进入暂停状态，重新打开项目仍能续取。
4. 让项目目录暂不可写：预期上游成功但本地交付未完成，保留恢复入口；恢复写入后续取并保存，成功回填后清理记录。
5. 暂停后再次生成：预期旧任务保留到独立恢复节点，新旧结果互不覆盖；旧回执不会清掉新任务。
6. 批量生成部分任务完成、部分查询失败：预期保留未交付任务，不为缺少的产物自动重发生成。
7. 主窗口对话和 MCP 执行媒体生成：预期绑定原消息及项目，失败后可列出并续取原任务，不写入其他会话；独立窗口仍回主窗口操作。
8. 提交响应在返回 ID 前中断：预期显示提交状态未知，提示去平台核对；不声称未提交、不自动重投。上游明确失败继续显示失败。

## 回滚

撤销本批代码即可回滚；新增任务字段为可选兼容字段，不清空原有记录，不迁移数据库。保留其他任务的未提交改动。

## 音频结果查询收口

2026-11-18 已接入共享查询，待用户验收。本批未运行自动化检查或真实厂商调用。

- 兼容 `/tasks` 的首次取回、旧回执续查及原生恢复均使用 `queryCompatibleMediaTask` 查询原 ID。音频签名地址保留字面逗号。交互入口沿用首条产物，原生恢复验证并保存有序的完整候选。查询 408／504 保留原任务以便续查。
- 旧 APIMart 音频回执复用 APIMart 任务请求和媒体解析，兼容原 `audios` 及旧的 `images` 字段。FlowMusic 和 Suno 的 `/music/tasks` 查询共用终态判断并识别取消。歌词查询只读取原阶段，下一阶段仍需现有授权的生成入口。
- ComfyUI 共用音频优先、视频兜底的候选类型顺序。动态工作流保留其末位图片兜底，新旧调用方沿用各自的候选数量和保存归属。三部分可独立回滚，沿用原回执结构。

在配置可模拟异步结果的 Tauri 测试项目中，分别验证兼容 `/tasks` 音频、原 APIMart 音频回执、FlowMusic 与 Suno。先检查首次取回，再让查询超时或项目目录暂不可写，恢复后点击「继续查询」。确认同一任务 ID、一次生成提交，且带逗号的签名地址可保存。检查歌词续查只回填歌词、取消结果正确结束，以及 ComfyUI 同时返回多个音轨和视频时按原目标交付。

在仓库根目录执行定向模拟验证：

```powershell
npx vitest run tests/services/apimartGen.test.ts tests/services/pollManager.test.ts tests/services/nativeGeneralAsyncTask.test.ts tests/services/apimartMusic.test.ts tests/services/nativeBuiltinAudioRecovery.test.ts tests/services/mediaProviderRegistry.test.ts tests/services/comfyOutputs.test.ts tests/services/comfyTaskRecovery.test.ts
```

## 生成轮询取消与回执归属

2026-11-18 首批改动已落地，待用户验收。本次未运行自动化检查或桌面验收。

- APIMart、兼容 `/tasks`、火山方舟、CCC、GRSAI、声明式模型协议、即梦和工作流把调用方信号交给 `registerNodePolling`。已取消的信号在登记前退出，清理使用本次登记返回的信号。无跟踪 ID 的调用沿用调用方信号。RunningHub 与 Workflow API 保留按消息登记的任务，Muse 沿用已有网页和原生取消流程。
- ComfyUI 文本、图片、视频和音频沿用工作流各自的回执。调用方取消时，本轮仍持有登记才更新恢复状态。节点已被取消或替换时，旧执行不能修改后续登记的回执。
- 即梦原生图片和视频的轮询登记覆盖等待阶段。停止等待后，已提交的 CLI 任务仍可记录迟到的任务 ID。旧项目的即梦清理按本次任务 ID 和尝试 ID 匹配，并保留视频转场回执规则。已有回执继续通过原任务 ID 查询，续查不重新提交。

桌面验收使用可记录请求的测试连接。在兼容 `/tasks` 的节点启动旧任务续查，再模拟同节点收到一个已取消的调用，确认原查询继续取回结果。用 ComfyUI 提交视频，查询中取消调用方，再续查，核对两次查询对应同一个 ID、生成只提交一次。用即梦原生入口在 CLI 返回前停止等待，核对迟到的 ID 仍可在重开后续查。分别回归普通画布节点、RunningHub 与 Workflow API 的纯消息结果归属，以及无跟踪 ID 的调用。回滚可单独撤销本批代码，无需变更或清空任务记录。

在仓库根目录执行定向模拟验证。

```powershell
npx vitest run tests/services/pollManager.test.ts tests/services/comfyTaskRecovery.test.ts tests/services/apimartGen.test.ts tests/services/apimartMusic.test.ts tests/services/grsaiMedia.test.ts tests/services/nativeBuiltinImageTask.test.ts tests/services/dreaminaResult.test.ts
```

## 节点音频交付与原生产物保存

2026-11-18 两批改动待用户验收。本次未运行自动化测试和 Tauri 桌面验收。

- **节点音频交付。** 旧项目音频节点及源音频节点的弹窗入口接入 `executeGeneration`，和画布生成共用保存、回填原节点、写输出历史和确认回执的流程。弹窗在调用前核对项目、节点及输入快照，旧项目仍要求明确选择模型。其他节点类型继续沿用各自的路由。
- **原生产物保存。** 通用任务、工作流、内置图片、音乐和剪辑转场共用单个 URL 的保存、文件路径检查与内容摘要核验。各调用方仍决定原画布、下载授权、候选顺序和何时结算回执。内置图片按原任务 ID 取回时，下载接收取消信号，摘要核验前后也检查取消。同步接口只有首个响应可取结果时，先在原画布留存结果，之后按既有流程交付。

桌面验收使用可观察生成与查询次数的测试连接。

1. 在旧项目的音频节点弹窗和画布分别触发生成。检查两种入口都向对应模型传入音色或音乐参数，各提交一次生成、回填原节点、写入一条输出历史。再检查源音频节点、工作流和原生项目的音频节点。项目设置了默认模型而旧弹窗的节点还未选模型时，确认弹窗提示选择模型。
2. 暂停音频结果下载或切换画布、替换节点，确认结果只交付给原节点。恢复可续查的任务，核对原任务 ID 和提交次数。
3. 用多个候选验收原生通用任务、工作流、内置图片、音乐和剪辑转场。核对原画布目录、候选顺序和摘要身份。下载内置图片时取消或切项目，回到原画布续查，生成提交数保持一次。同步接口的首返结果在切走后应留存在原画布，可在重开后交付。

两批可分别撤销代码回滚，沿用既有回执和目录布局。在仓库根目录执行对应的定向模拟验证。

```powershell
npx vitest run tests/components/nodeCriticalInteractions.test.tsx tests/services/audioSpeechSettings.test.ts tests/services/generationServiceReplicaLease.test.ts
npx vitest run tests/services/nativeMediaLocalResult.test.ts tests/services/nativeGeneralAsyncTask.test.ts tests/services/nativeWorkflowTasks.test.ts tests/services/nativeBuiltinImageTask.test.ts tests/services/nativeBuiltinAudioRecovery.test.ts tests/services/nativeEditorProtocols.test.ts tests/services/nativeEditorMediaTaskRepository.test.ts
```

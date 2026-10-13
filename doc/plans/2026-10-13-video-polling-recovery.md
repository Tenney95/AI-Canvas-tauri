# 视频轮询暂停与手动恢复

状态：已实现，待用户桌面验收。本次未运行测试、lint、类型检查、构建或真实厂商调用。

## 行为与范围

- 自定义声明式、通用异步、APIMart、GRSAI H3 和火山方舟的视频任务取得远端 ID 后，本地等待预算耗尽或查询超时进入暂停。保留 ID、连接身份、查询/下载描述和原始生成输入标量，不记录凭据或参考素材路径。
- 视频节点及提示词窗口提供同一个「重试」入口，只查询/下载原任务，不再次提交生成。重试仍超时回到暂停；本地保存失败保留恢复入口。上游明确失败继续按失败处理。
- 暂停时可从提示词窗口再次生成。旧任务先移到独立的「待恢复」视频节点，原节点用于新生成；各自结果不会互相覆盖。复用既有画布 Action、一次历史快照和每节点一条待续记录，不升级数据库。
- 重启或切回项目时，暂停任务等待用户重试。正在正常查询的旧记录沿用原恢复流程。查询及保存回填复核项目、任务和画布版本；恢复历史记录使用原始模型和提示词。
- 无显式预算的云视频查询每轮最多等待 30 分钟；声明式协议使用自己的次数/时长限制，未声明时长时使用上述预算。预算耗尽不表示远端取消。
- 提交阶段未取得 ID 的超时不能凭空恢复，不自动重提。同步生成、图片/音频任务、ComfyUI、RunningHub 和云工作流保留各自策略。视频批次统计仍使用其原有状态展示，节点保留恢复入口。

## 实现入口

`pollTask.ts` 区分本地超时和远端失败；`pollManager.ts` 管理暂停、手动续查、恢复节点和保存结果。各生成适配器保留已提交视频记录，节点生成入口在本地交付完成后清理。`VideoTaskStatus.tsx` 供画布节点和 `AINodeDialog` 共用。

## 桌面验收

前置：打开 Tauri 桌面端的测试项目，配置一个可返回任务 ID 的异步视频模型及有效 Key。自定义协议的轮询限制可临时设为 `maxAttempts: 1`、`intervalMs: 1000`，便于在上游仍处理时暂停；验收后恢复原配置。

1. 在视频节点输入提示词并生成。上游仍处理中时，节点应恢复可交互状态，显示「查询已暂停，任务已保留」和「重试」，没有红色失败提示或失败输出历史。
2. 等上游完成后点击重试，核对服务商记录：使用同一个任务 ID，没有第二次生成提交；视频下载保存到原节点，暂停入口消失。重复快速点击应只有一次续查；上游仍未完成时应再次暂停。
3. 暂停后关闭应用并重新打开项目，或切换项目后切回。暂停任务应保留，不自行查询；手动重试仍使用原 ID。
4. 暂停后修改提示词/模型并再次生成。应出现保存旧任务的独立恢复节点，原节点生成新视频；旧节点重试得到原视频及原始输入历史，新视频不被覆盖。连续多次暂停再生成时，恢复节点不应完全重叠。
5. 在续查/下载过程中切换项目、删除节点或更改画布版本，旧结果不得写到新项目或新任务。保留下来的原任务能在返回后继续查询。
6. 模拟查询 HTTP 408/504、轮询预算耗尽和本地保存失败，已知任务应保留；上游明确 `failed`/`cancelled` 则显示真实失败。缺 Key 或连接被删除时不能发起生成替代恢复；修复配置后可继续查原任务。
7. 回归正常一次完成、取消生成、同步视频、图片/音频、ComfyUI 和 RunningHub 原恢复入口。提交超时但没有 ID 不得出现虚假的重试查询按钮。

回归用例位于 `pollTask.test.ts`、`pollManager.test.ts`、`modelProtocol.test.ts`、`apimartGen.test.ts`、`grsaiMedia.test.ts`、`batchExecute.test.ts`、`generationServiceReplicaLease.test.ts` 和 `videoTaskStatus.test.tsx`。如需命令验收，在仓库根目录运行：

```powershell
npx vitest run tests/services/pollTask.test.ts tests/services/pollManager.test.ts tests/services/modelProtocol.test.ts tests/services/apimartGen.test.ts tests/services/grsaiMedia.test.ts tests/services/batchExecute.test.ts tests/services/generationServiceReplicaLease.test.ts tests/components/videoTaskStatus.test.tsx
```

## 回滚

撤销本批源码、用例与文档补丁即可，不迁移配置、数据库或凭据。任务仍使用既有待续记录格式；独立恢复节点及已经保存的视频保留。回滚前应先取回需要的暂停任务，因为旧版本不会识别新增暂停标记。

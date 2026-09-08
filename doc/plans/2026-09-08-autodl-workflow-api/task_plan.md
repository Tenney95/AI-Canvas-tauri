# 工作流 API 独立类别与 AutoDL H3 接入

状态：实现完成。主要接入代码已纳入 `5549aaf`；本次提交补齐导入失败提示、翻译与模块文档。按用户要求停止后续测试，未打包或发布，未调用付费生成接口。

任务类型：平台能力，包含设置入口的产品能力。主归属为「模型与生成」。

## 使用方式

1. 在「设置 → API Key → 添加连接」中选择「工作流 API · AutoDL」。
2. 填写 AutoDL ComfyUI 分组的原始 Token 和站点根地址，设置默认时长、画质、比例及可选随机种子后保存。
3. 在视频节点的工作流列表选择「H3 多图多音频生视频（升级画质）」，引用图片和音频，填写提示词并生成。

连接检查只检查配置格式，不调用模型目录或创建计费任务，也不声称 Token 权限已经验证。工作流定义及默认参数使用现有工作流 Store，连接凭据仍由现有凭据服务管理。分享导出不含 Token，导入后重新绑定连接。

首批提供工作流 `minimax_h3_zm_u24` 的固定模板；其他工作流需要补充明确的 manifest 和输入合同。

## 接口合同

依据：[AutoDL.Art 官方 ComfyUI API 文档](https://autodl.art/docs/comfyui_api/)及用户提供的 H3 工作流输入、输出详情。通用文档核实于 2026-09-08，H3 的具体参数以用户给出的工作流详情为准。

| 项目 | 实现 |
|---|---|
| 提交 | POST /api/v1/comfyui/comfyui_workflow/minimax_h3_zm_u24 |
| 查询 | GET /api/v1/comfyui/comfyui_workflow/result/{task_id} |
| 鉴权 | Authorization 原样填写 Token，不加 Bearer |
| 请求体 | JSON，不添加 model |
| 图片 | 1–9 张；ref_image_0 至 ref_image_8，每项为 URL 字符串 |
| 音频 | 0–3 段；ref_audio_0 至 ref_audio_2，每项为 URL 字符串 |
| 提示词 | 1–10000 字符 |
| 时长 | 1–15 秒整数，默认 5 秒 |
| 画质与比例 | 480p/768p 与竖屏、横屏、1:1 组合为接口的六个枚举 |
| 随机种子 | 可选安全整数，保留 0，未填写则省略 |
| 完成状态 | 兼容 SUCCESS 和 completed，状态比较不区分大小写 |
| 输出 | 提取视频结果并复用现有资产保存；完成但无视频结果时明确报错 |

提交前检查素材数量、输入格式、时长及枚举；不静默裁剪，不发送空字段或嵌套数组。本地素材复用现有临时公网 URL 上传服务，设置中说明上传行为。公网 URL 直接使用；不把本地路径、data URL 或明显的本机/私网 URL 直接交给上游。该工作流不开放参考视频和首尾帧专属语义。

## 与 RunningHub 的复用

已检查 `243a629 feat(runninghub): 接入云工作流与 AI 应用及任务恢复`，复用以下已有实现：

- `WorkflowDefinition`、工作流 Store 和 IndexedDB 工作流记录；新增 `adapterType: workflow-api` 与 manifest，没有平行的工作流数据库。
- `workflowExecutionService.ts` 的工作流绑定，以及从 RunningHub 提取的云产物保存和已保存结果读取辅助函数；RunningHub 原导出保持兼容。
- `PendingTask`、取消信号、轮询调度、项目/节点写回保护和恢复回填机制。
- 视频节点、批量执行、对话及 Agent/MCP 的媒体生成入口、素材引用收集和凭据存储。

AutoDL 的鉴权、编号输入、业务码、查询路径与状态解析保留独立适配器。没有套用 RunningHub 的上传或取消接口，也没有把工作流转换成普通模型请求。

## 源码范围

| 范围 | 主要入口与行为 |
|---|---|
| 合同与配置 | `types/workflowApi.ts`、`workflowApi/autodlWorkflowManifest.ts`、`workflowApiConfig.ts`；固定模板、能力、默认值与严格校验 |
| 执行与恢复 | `workflowApiAdapter.ts`、`pollManager.ts`、`workflowExecutionService.ts`；提交、查询、保存及恢复 |
| 类型与持久化 | `types/index.ts`、`types/aiTypes.ts`、`types/media.ts`、`types/runninghub.ts`、`catalogRepository.ts`、`store.workflows.ts` |
| 连接设置 | `providerCatalogService.ts`、`providerConnectionTransfer.ts`、`testConnection.ts`、`ApiKeySettings.tsx`、连接对话框及其表单、`ProviderWorkflowSection.tsx` |
| 生成入口 | `generateVideo.ts`、`generationRuntime.ts`、`videoRequestResolver.ts`、`generationService.ts`、`batchExecute.ts` |
| 节点与工作流 UI | `defaultModels.ts`、`ModelSelector.tsx`、`VideoParamSelector.tsx`、`PromptPanel.tsx`、`AINodeDialog.tsx`、`WorkflowApiTaskStatus.tsx`、`WorkflowPanel.tsx` |
| 对话与工具 | `conversationExecutionController.ts`、`detachedChatSyncController.ts`、`tools/mediaTools.ts`、`tools/canvasTools.ts` |
| 文案与记录 | 英、日、韩设置词典，本计划与模型模块文档 |

工作区同时存在 RunningHub 标准模型扩展及 Cargo 配置改动；本任务仅加入 AutoDL 的局部差异，未回滚或覆盖其他任务工作。未新增依赖，未修改 Tauri 安全配置或新增 IndexedDB object store。

## 任务生命周期边界

- 付费 POST 不自动重试；提交前登记尝试身份，已拿到任务 ID 时及时保存。
- 提交状态未知时保留记录，用户可到平台核对并补充任务 ID；禁止通过重新生成冒充恢复。
- 「停止等待」中止本地上传/等待/查询，不声称已取消平台任务。
- 恢复只查询已有任务，或继续保存已经取得的输出；保存成功后才清理匹配的任务记录。
- 旧尝试、项目切换和失效节点不得覆盖新状态；对话恢复绑定原项目、会话和消息，消息尚未加载时等待。
- 记录包含必要查询描述和身份关联，不包含 Token、媒体正文或运行时控制器。

## 已完成的检查与验收缺口

以下为用户要求停止测试前已经取得的结果，不代表最后收尾差异再次全量验证：

- 前端类型检查及测试类型检查通过。
- 最近一次定向 Vitest：14 个测试文件、185 项通过，覆盖 AutoDL 参数与传输、配置分享、工作流持久化、RunningHub/ComfyUI 恢复和既有视频/对话入口。
- 已执行的分批定向 ESLint 通过；其后少量导入错误处理、文案和停止等待相关收尾未重新运行整套检查。
- 使用真实连接表单在浏览器预览检查深色常规窗口、浅色窄窗口、参数保存及非法时长提示；预览保存使用隔离回调，不写入真实凭据。
- 后续补充的两条停止/提交竞态用例尚未运行；用户要求后没有再执行测试或生产构建。
- 没有真实 AutoDL Token 权限、付费生成、本地素材上传到上游或桌面打包环境的实测结果。

普通自定义模型协议的通用数组判定问题不在本次修改内。本次解决的是该工作流要求逐项编号 URL 字段的协议兼容。

## 回滚

按本计划列出的功能范围撤销 AutoDL 局部差异，保留其他任务改动、用户配置、任务记录及媒体资产。设置中可停用该连接以阻止新生成。无法识别的新工作流记录应报不支持，不能回退为普通模型 API。保存失败或提交状态未知的记录应先完成查询或由用户核实平台状态，再清理。

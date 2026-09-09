# 通用工作流 API 与 AutoDL H3 模板

状态：通用工作流 API 扩展已实现（2026-09-09），按用户要求纳入本次提交。前端类型检查和改动文件 ESLint 通过；按用户要求未运行测试、真实上传、付费调用或构建。此前固定 H3 接入已提交。

任务类型：平台能力，包含设置入口的产品能力。主归属为「模型与生成」。

## 使用方式

1. 在「设置 → API Key → 添加连接」中选择「工作流 API」，填写连接名称、平台地址及该平台需要的 API Key / Token；可添加多个平台连接。
2. 添加自定义工作流或可选的 AutoDL H3 模板，填写工作流名称与输出类型，通过「编辑调用路径与参数映射」配置提交、查询、鉴权、请求体和响应路径。
3. 在「能力与参数 JSON」声明参考图片、视频、音频数量，以及参数类型、默认值、范围和枚举。节点的「工作流输入」按这些声明显示控件。
4. 在对应图片、视频或音频节点选择保存的工作流，引用素材并生成。一个连接可保存多个工作流。

连接检查只检查配置格式，不调用模型目录或创建计费任务，也不声称 Token 权限已经验证。工作流定义及默认参数使用现有工作流 Store，连接凭据仍由现有凭据服务管理。分享导出不含 Token，导入后重新绑定连接。

AutoDL H3 是可编辑的起步模板。新版工作流复用自定义接口的声明式协议，支持同步 JSON 结果或异步提交与查询，从响应中提取媒体 URL；提交和查询仍受连接同源约束。旧版固定 H3 定义保持可执行，编辑并保存后转为新定义。

## 可选 AutoDL H3 模板合同

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

新版工作流 adapter 复用现有 modelProtocol 的模板、鉴权、同源请求、响应解析和轮询；平台差异存为配置，不通过平台名称分支处理。工作流仍使用独立任务身份、恢复和产物保存，不转成普通模型请求。旧版 AutoDL 适配路径保留兼容。

## 源码范围

| 范围 | 主要入口与行为 |
|---|---|
| 合同与配置 | `types/workflowApi.ts`、`workflowApi/autodlWorkflowManifest.ts`、`workflowApiConfig.ts`；v1 兼容及 v2 声明式能力、参数、模板与严格校验；通用定义见 `workflowApiDefinition.ts` |
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

## 先前固定 H3 阶段的检查记录

以下为用户要求停止测试前已经取得的结果，不代表最后收尾差异再次全量验证：

- 前端类型检查及测试类型检查通过。
- 最近一次定向 Vitest：14 个测试文件、185 项通过，覆盖 AutoDL 参数与传输、配置分享、工作流持久化、RunningHub/ComfyUI 恢复和既有视频/对话入口。
- 已执行的分批定向 ESLint 通过；其后少量导入错误处理、文案和停止等待相关收尾未重新运行整套检查。
- 使用真实连接表单在浏览器预览检查深色常规窗口、浅色窄窗口、参数保存及非法时长提示；预览保存使用隔离回调，不写入真实凭据。
- 后续补充的两条停止/提交竞态用例尚未运行；用户要求后没有再执行测试或生产构建。
- 没有真实 AutoDL Token 权限、付费生成、本地素材上传到上游或桌面打包环境的实测结果。

当前阶段的引用覆盖校验同时接受完整数组与完整的逐项编号映射；多图却只映射 `.0` 仍会在提交前报错。

## 通用工作流 API 扩展（2026-09-09）

用户要求取消平台及 H3 工作流锁定，按现有自定义接口方式自由配置平台、路径和参数。本阶段属于平台能力扩展，沿用现有工作流记录与执行边界。

- [x] 复用声明式协议编辑器、模板变量、请求构建和响应解析；支持自定义提交/查询路径、鉴权、请求体、任务 ID、状态与结果映射。
- [x] 工作流连接可管理多个命名工作流，输出可选图片、视频、音频，参考素材上限及输入参数按各工作流声明；AutoDL H3 保留为可选模板及旧配置兼容。
- [x] 串起配置保存/分享/导入、节点/批量/对话/Agent 调用与恢复。恢复绑定提交时协议，不能因编辑配置改变旧任务的查询合同；未知提交不自动重提。
- [x] 更新模块说明及使用范例。按用户既有要求，不执行额外测试、真实上传、付费生成或打包；执行前端类型、改动文件 ESLint、严格 UTF-8 与差异检查。

实际修改范围：工作流类型及 workflowApi 服务、连接目录/分享/设置表单、现有协议变量/映射复用入口、工作流 Store 与执行绑定、三类媒体生成入口和节点参数、对话工具参数与任务恢复、相关文案及本计划。无新依赖、文件删除或安全配置修改。现存上传修复与 Cargo 改动保留。

回滚：撤销本阶段局部差异，保留旧版 AutoDL manifest 和已有任务记录；新版自定义协议在旧版本中应明确不支持，不回退到普通模型请求。

## 本地素材上传修复

添加 H3 模板时的面板崩溃已修复：模板通过专用 Authorization 鉴权通道设置空前缀，原样发送 Token，避免命中自定义 Header 的保留字段校验。卡片渲染捕获协议解析错误并局部提示，不再让整个设置面板失败；无效协议仍禁止保存和执行。

- Windows 的 `http(s)://asset.localhost/...` 曾被统一媒体入口的 HTTP 提前返回分支误判为公网地址，导致跳过上传并触发工作流公网 URL 校验。
- 修正 `uploadService.ts`：Tauri 本地 HTTP 地址进入现有上传链路，`blob:` 素材同样识别为需上传的本地媒体；真正的公网地址仍直接使用。本地地址按 URL 主机名识别，避免路径中出现 `asset.localhost` 的公网链接被误上传。
- 按用户要求未追加测试或实际上传/计费调用；修复覆盖统一解析入口的图片、音频和视频素材，不改变工作流提交协议。

## 参数配置示例

能力 JSON 中的参数可声明如下；此结构属于应用的输入定义，不会直接提交给上游：

```json
{
  "references": { "image": { "min": 1, "max": 9 }, "audio": { "min": 0, "max": 3 } },
  "parameters": {
    "duration": { "type": "integer", "label": "时长（秒）", "min": 1, "max": 15, "default": 5 },
    "seed": { "type": "integer", "label": "随机种子" }
  },
  "prompt": { "required": true, "maxLength": 10000 }
}
```

请求体按平台字段映射，例如 `"duration": "{{parameters.duration}}"`、`"seed": "{{parameters.seed}}"`、`"ref_image_0": "{{imageUrls.0}}"`。支持数组的平台可使用 `"images": "{{imageUrls}}"`。参数保留数字及布尔类型，未填写的可选编号字段自动省略。H3 模板已包含九个图片和三个音频编号字段、六种分辨率枚举及其正确的提交/查询路径。

任务恢复使用提交时保存的协议和已解析查询配置；修改新工作流的调用路径不会改变旧任务的查询路径。仍需保留原连接、输出类型和节点绑定。此阶段未执行行为测试或真实平台调用，相关运行时验收仍待完成。

## 回滚

按本计划列出的功能范围撤销 AutoDL 局部差异，保留其他任务改动、用户配置、任务记录及媒体资产。设置中可停用该连接以阻止新生成。无法识别的新工作流记录应报不支持，不能回退为普通模型 API。保存失败或提交状态未知的记录应先完成查询或由用户核实平台状态，再清理。

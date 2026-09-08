# 工作流 API 独立类别与 AutoDL H3 接入方案

状态：代码与离线集成回归已完成，界面与真实服务验收待补。按用户要求与 RunningHub 标准模型改动一起提交到本地 master。

任务类型：平台能力，包含设置入口的产品能力。主归属为「模型与生成」。

## 目标与使用方式

在「设置 → API Key → 添加连接」中新增独立的「工作流 API」类别。首个执行适配器接入 AutoDL.Art ComfyUI API，提供「H3 多图多音频生视频（升级画质）」模板，工作流 ID 为 `minimax_h3_zm_u24`。

用户填写连接地址与 ComfyUI 分组的 Token，启用工作流后，在视频节点选择该工作流，连接图片和音频、填写提示词、选择时长与画质并生成。配置界面使用「工作流 ID / 输入参数 / 结果类型」术语。输出结果类型仍为视频，接入类型独立标记为工作流 API；不增加一个无法路由到视频节点的媒体类型。

第一批完成这条已提供完整输入合同的工作流。后续 AutoDL 工作流通过新增 manifest 描述接入，不根据名称猜测参数和能力。普通模型接口、本地 ComfyUI 图和 RunningHub 工作流继续走原有适配器。

## 已核实的请求合同

依据：[AutoDL.Art 官方 ComfyUI API 文档](https://autodl.art/docs/comfyui_api/)与用户提供的 H3 工作流输入、输出说明。官方页面核实于 2026-09-08；页面给出的示例工作流不是本次 H3 多参考工作流，其具体输入能力以用户提供的详情为准。

| 项目 | 本次合同 |
|---|---|
| 服务地址 | `https://autodl.art` |
| 提交 | `POST /api/v1/comfyui/comfyui_workflow/minimax_h3_zm_u24` |
| 鉴权 | `Authorization: <Token>`，原始 Token，不自动添加 Bearer |
| 请求编码 | JSON；请求体不要求 `model` 字段 |
| 提示词 | `prompt`，必填，1–10000 字符 |
| 图片 | 1–9 张，依次写入 `ref_image_0` 至 `ref_image_8`，每个值是 URL 字符串 |
| 音频 | 0–3 段，依次写入 `ref_audio_0` 至 `ref_audio_2`，每个值是 URL 字符串 |
| 时长 | `duration`，整数 1–15 秒，默认 5 秒 |
| 分辨率 | `480p竖`、`768p竖`、`480p横`、`768p横`、`480p(1:1)`、`768p(1:1)`，默认 `768p竖` |
| 随机种子 | `seed`，可选整数；不填写时省略，由工作流决定随机种子 |
| 提交任务 ID | `data.task_id` |
| 查询 | `GET /api/v1/comfyui/comfyui_workflow/result/{task_id}`，使用提交实际返回的 ID |
| 状态 | `data.status`；处理官方的 `QUEUED/RUNNING/SUCCESS/FAILED`，并兼容用户示例的 `completed`，比较时统一大小写 |
| 结果 | `data.results` 中的视频输出 URL；完成但没有视频结果时明确失败 |
| 业务错误 | 检查顶层 `code`，保留 `msg` 中的可读错误，不把业务失败当作持续排队 |

空的可选图片、音频、seed 字段省略；不发送空字符串、null 或嵌套数组。禁止超过上限后静默裁剪素材。该工作流未声明参考视频输入，不开放参考视频能力。

## 当前实现与缺口

- `providerCatalogService.ts` 的连接定义已支持独立类型与本地目录；`ProviderConnectionDialog.tsx` 负责连接选择和保存。可扩展现有入口。
- 视频节点与对话生成最终可到达 `generateVideo.ts`。现有连线、提示词引用与角色素材收集可以复用，工作流执行在进入普通模型协议前按明确的适配器类型分流。
- 普通协议的 `modelProtocolRuntime.ts` 当前多项覆盖检查只承认整数组引用；全部列出 `.0/.1/...` 也可能被误拦。新工作流适配器按 manifest 校验输入槽位及实际发送数量，不依赖这条模型数组判定。普通模型协议校验的泛化修复不混入本批。
- 通用视频协议将本地音频转为 data URL；本工作流需使用 URL 交付。现有 `uploadService.ts` 已支持图片、音频的 `publicUrl` 模式，可复用上传、缓存、超时与取消。
- `testConnection.ts` 的一般兜底会探测模型目录。官方没有提供已核实的无副作用 Token 验证接口，因此本类别只能检查本地配置，不能伪称密钥已验证，也不能靠创建计费任务验证连接。
- 配置同步和分享解析均显式挑选字段，新增 manifest 必须在 Store、分享导入及重新打开时保留；未知或损坏的 workflow 配置必须拒绝执行，不回退为模型 API。

## 实施边界

1. 新增独立的 workflow manifest 和 adapter。manifest 声明工作流 ID、输出类型、输入上限、参数及枚举映射；adapter 处理 URL 素材、提交、查询、业务错误和结果校验。
2. 上层复用现有连接存储与媒体选项列表，增加明确的 workflow 描述字段。内部用于菜单索引的通用记录不等于请求中的模型参数，提交不携带 `model`。
3. 视频节点沿用已有时长、分辨率和比例控件。manifest 将 `480p/768p` 与横、竖、方形组合映射为接口的六个枚举；默认设置为 5 秒、768p、竖屏。seed 在工作流配置中可选填写。
4. 输入数量、时长、提示词及格式错误在上传和提交之前拒绝。图片/音频顺序与节点引用顺序一致，所有素材作为普通参考输入，不自动冒充首尾帧。
5. 公网 URL 直接传递；本地图片和音频复用当前临时上传服务（非 APIMart 的媒体当前走 Uguu）。设置中明确说明本地素材会上传为临时 URL；不把 data URL、文件路径或 localhost 地址当成上游可读 URL。临时 URL 有效期和上传大小限制仍可能导致上游取材失败，需真实接口验收。
6. 复用现有受控 HTTP、同源请求构建、凭据服务、轮询调度和资产保存。新增工作流任务恢复分支，保存任务 ID、连接关联和必要的查询描述，不保存 Token 或素材正文。付费提交不自动重试。
7. 节点及对话/MCP 媒体生成共用同一执行分流。第一批不扩展「助手依据任意网页自动创建工作流」能力；新类别界面不复用会创建普通模型配置的导入按钮。
8. 无新增 npm/cargo 依赖，无 Tauri 安全配置修改，无文件删除、发布或付费调用。新状态落入现有配置、任务存储，不新增 IndexedDB object store。

## 拟修改文件清单

### RunningHub 提交后的范围收敛

用户明确要求继续实施并检查 `243a629 feat(runninghub): 接入云工作流与 AI 应用及任务恢复` 的可共用代码。该提交已提供 `WorkflowDefinition.adapterType`、工作流持久化、云任务记录及支持预保存结果的恢复回填。

- AutoDL 直接扩展现有 `WorkflowDefinition` 为 `adapterType: workflow-api`，沿用工作流 Store，不再把工作流复制进 `GeneralModelConfig`；原清单中的通用模型同步/分享扩展由第二阶段据此缩减。
- 第一阶段额外涉及 `src/services/workflowExecutionService.ts`、`src/types/runninghub.ts`、`src/services/ai/providers/runninghubWorkflow.ts`：将既有产物类型和保存实现收口为两个适配器共用的小型辅助函数，保留 RunningHub 原导出和调用行为。
- AutoDL 鉴权、输入编号、业务码及查询结果单独实现；不复用 RunningHub 的请求体、上传接口或取消接口。
- 第一阶段先交付 manifest、输入校验、提交/查询、节点任务恢复和共享产物保存，并回归 RunningHub。新类别、节点及对话入口的集成仍在第二阶段。

新增文件在调查时均不存在，以下是计划路径，不代表已经实现。

| 文件 | 改动摘要 |
|---|---|
| `src/types/workflowApi.ts`（新增） | 工作流 manifest、适配器类型、输入参数与可恢复查询描述 |
| `src/types/index.ts` | 连接选项和媒体配置增加 workflow manifest 字段，保留现有四类输出类型 |
| `src/services/workflowApi/autodlWorkflowManifest.ts`（新增） | H3 工作流参数、素材上限、默认值、枚举及端点合同 |
| `src/services/workflowApi/workflowApiAdapter.ts`（新增） | 参数校验、URL 素材准备、原始 Token 提交、查询、错误和视频结果处理 |
| `src/services/ai/providerCatalogService.ts` | 新增工作流 API 连接类别与本地模板目录 |
| `src/store/store.config.ts` | 保存、同步和重新载入 workflow 配置 |
| `src/services/ai/providerConnectionTransfer.ts` | 分享导出/导入保留并校验 workflow 字段，排除凭据 |
| `src/services/ai/generateVideo.ts` | 在模型协议执行前分派工作流 adapter，复用素材收集 |
| `src/services/pollManager.ts` | 增加工作流任务类型与恢复分支，保留现有项目和节点写回约束 |
| `src/services/testConnection.ts` | 工作流类别不探测 `/models`，不发起计费验证 |
| `src/components/settings/ApiKeySettings.tsx` | 连接摘要使用工作流名称和数量 |
| `src/components/settings/ProviderConnectionDialog.tsx` | 新类别选择、编辑和保存路由 |
| `src/components/settings/providerConnection/ProviderConnectionForm.tsx` | 工作流连接信息、Token 说明和配置检查状态 |
| `src/components/settings/providerConnection/ProviderWorkflowSection.tsx`（新增） | 工作流模板启用、参数配置与摘要；复用现有 UI 控件 |
| `src/i18n/locales/en-US/settings.ts` | 新界面文案 |
| `src/i18n/locales/ja-JP/settings.ts` | 新界面文案 |
| `src/i18n/locales/ko-KR/settings.ts` | 新界面文案 |
| `tests/services/workflowApiAdapter.test.ts`（新增） | 多素材映射、枚举、鉴权、异步状态、业务错误、取消和无重复提交 |
| `tests/services/workflowApiConfig.test.ts`（新增） | 配置分享、回读和非法 manifest 拦截 |
| `tests/components/providerWorkflowSection.test.tsx`（新增） | 新类别交互、表单校验与文案 |
| `tests/services/generateVideo.test.ts` | 视频入口分流与原有自定义模型兼容 |
| `tests/services/pollManager.test.ts` | 工作流任务恢复、取消、异常与结果回填 |
| `tests/services/providerCatalogService.test.ts` | 工作流目录不调用模型目录接口 |
| `tests/store/config.test.ts` | Store 往返保留工作流字段 |
| `tests/components/providerConnectionForm.test.tsx` | Token 表单与无副作用配置检查 |
| `doc/模型与生成模块.md` | 工作流入口、边界及实际验证结论 |
| 本方案文件 | 状态、验收缺口和回滚结论 |

`pollManager.ts` 当前已有其他任务改动。实施前必须重读其当前差异，只加入本任务的分支和类型，不覆盖 ComfyUI 的取消、恢复和保存逻辑。若该文件继续变化，先合并明确的局部差异并重新验证相关恢复测试。

## 阶段与验收

- [x] 阶段 0：核对官方通用协议、用户工作流合同、配置/执行/查询/恢复调用链；完成可审核方案。
- [x] 阶段 1：类型、manifest、adapter 和任务恢复已实现，合同与恢复定向测试通过。
- [ ] 阶段 2：独立类别、配置持久化与分享、视频入口和文案已实现，集成回归通过；深浅主题、普通及窄窗口界面验收待补。
- [ ] 阶段 3：汇总实际结果与未完成项；真实 AutoDL 调用需有可用连接凭据和用户指定的测试素材，不以 mock 结果替代上游实测。

核心验收：

- 单图无音频、2 图 2 音频、9 图 3 音频均逐字段完整发送；第 10 图、第 4 音频、无图和非法时长均在上传/提交前报错。
- 六种分辨率映射准确，可选字段未填时省略，Token 原样注入，请求中没有 `model`。
- 查询绑定真实 task_id；排队、运行、两种成功标记、失败、空结果、非 Success 业务码、HTTP 401/429/5xx 与取消均有明确结果；恢复只查询，不重新提交。
- 保存后重新打开、分享配置后重新导入、节点生成和对话/MCP 生成保留同一执行类型与完整参数。
- 既有自定义模型、ComfyUI 和 RunningHub 的路由及任务恢复不受影响。
- 执行前端类型检查、测试类型检查、定向 Vitest、改动文件 ESLint、`git diff --check` 与严格 UTF-8 检查；生产构建输出到 G 盘任务临时目录。新界面验证深浅主题、普通和窄窗口。

## 风险、未知与回滚

- 官方通用示例以 `SUCCESS` 表示完成，用户工作流示例为 `completed`，需要兼容两者并实测，不用其中一个覆盖另一个。
- API 详情只说明 URL 输入，没有已核实的 AutoDL 专用素材上传接口和只读 Token 校验接口；第一批使用现有上传服务，并如实显示配置检查的能力范围。
- `pollManager.ts` 存在并行修改，局部补丁和恢复回归为必需验收项。
- 回滚只撤销本批明确的代码差异，移除本批入口；不删除用户配置、节点数据和媒体资产。旧版本不能执行新 workflow 记录时须提示不支持，不转成普通模型请求。必要时在设置中停用新连接；新任务记录需保留可识别的失败/暂停提示。
- 合并提交前：前端类型检查、全仓测试类型检查、改动文件 ESLint、28 个文件的 700 项定向测试及前端生产构建通过。测试涵盖本适配器、配置入口、RunningHub、ComfyUI 与共享媒体链路；生产构建仍有大 chunk 和静态/动态导入混用提示。未进行真实账户生成、上传、桌面打包或 AutoDL 界面视觉验收。

# RunningHub 平台能力完善

## 阶段与范围

本任务属于平台能力。用户已批准阶段 A 的文件范围与分阶段实施方案：先交付云工作流和 AI 应用，阶段报告后确认阶段 B 的模型扩展。不新增依赖、Store、IndexedDB object store 或原生权限；不删除文件，不调整 Tauri 安全配置。

| 阶段 | 状态 | 内容 |
|---|---|---|
| A：工作流与 AI 应用 | 实现及离线验证完成，真实服务验收待补 | 定义导入、参数映射、节点/对话调用、官方上传、任务恢复与结果保存 |
| B：标准模型扩展 | 待阶段确认，未实施 | 对照官方目录补齐模型、操作、渠道及各自参数和执行合同 |

## 阶段 A 的产品行为

- 设置区分别管理工作流 API Key 与模型 API Key，连接测试使用只读账户接口。保存的云定义显式选择连接；运行时从现有凭据配置取 Key。
- 工作流管理区支持本地 ComfyUI、RunningHub 工作流和 RunningHub AI 应用。可从官方链接/ID 读取，或导入 API JSON、curl 示例中的 JSON 请求体；不执行示例脚本，不保存原始定义或鉴权字段。
- 云定义保存明确的远端 ID、输出类型、参数、素材映射、实例、队列和可选输出节点。长 ID 按字符串处理，数字和布尔参数保留 `0`、`false`；不明确的提示词或素材字段由用户核对映射。
- 保存后在图像、视频、音频节点、预设和对话 `@model` 目录可选；独立对话窗口使用同一连接判断。Agent/MCP 可用 `media_workflow_parameters` 读取定义，再以 `media_generate.workflowInputs` 覆盖参数；既有模型引用与 Policy 不变。
- 云工作流只展示自身参数；比例、分辨率、时长应映射到相应节点字段。通用媒体工具若显式传入这些通用选项会提示改用工作流参数，避免静默忽略。
- 本地图片、视频、音频经 RunningHub 官方上传；按字段要求传返回的文件名或 URL，同次调用的相同素材复用上传。任务显示上传、排队、生成、保存阶段。
- 按输出类型及可选输出节点筛选，保存全部匹配产物，首个产物作为节点/对话主结果。节点详情可查看其余产物。
- 已知远端任务 ID 在断网和保存失败后保留，恢复只查询和保存，不重复提交。提交响应丢失时保留不确定状态；节点入口支持平台核对后补充 ID，或确认远端结束后清理本地记录。
- 本地停止等待与远端取消分别处理。取消接口接受请求不等于任务已取消，只有查询到终态才清理记录；若已经生成完成则保留保存入口。
- 恢复前复核项目、节点、工作流与画布 revision。纯对话任务回填原消息，不创建画布节点；画布先恢复、原对话后加载时等待消息加载再同步已有产物。

## 源码与兼容边界

| 入口 | 职责 |
|---|---|
| [runninghub.ts](../../src/types/runninghub.ts) | manifest、参数、产物和任务消息关联类型 |
| [runninghubWorkflowService.ts](../../src/services/runninghubWorkflowService.ts) | 链接/定义导入、凭据字段过滤、参数校验 |
| [workflowExecutionService.ts](../../src/services/workflowExecutionService.ts) | 工作流来源及凭据连接解析 |
| [runninghubClient.ts](../../src/services/ai/providers/runninghubClient.ts) | 固定接口、HTTP 错误、官方上传及成功码合同 |
| [runninghubWorkflow.ts](../../src/services/ai/providers/runninghubWorkflow.ts) | 提交、状态查询、输出、保存与取消 |
| [RunningHubWorkflowImport.tsx](../../src/components/runninghub/RunningHubWorkflowImport.tsx) / [RunningHubParameterFields.tsx](../../src/components/nodes/shared/RunningHubParameterFields.tsx) | 定义管理和每次调用参数控件 |
| [pollManager.ts](../../src/services/pollManager.ts) | 原节点及原对话的持久任务恢复 |

`WorkflowDefinition`、IndexedDB 的工作流记录和节点数据仅增加可选字段；缺少 `adapterType` 的旧工作流继续作为 ComfyUI 执行，不升级 DB schema。原有 4 个只有 ID、没有可靠输入合同的内置云工作流保留 ID 定义，但不作为可执行菜单项展示，需要导入明确参数后使用。已有标准图片模型保持兼容，本阶段未新增标准模型。

首批参数支持字符串、有限数字、布尔值及同类型枚举；复合值、访问密码、文本/3D 产物不在阶段 A 范围。原始工作流中的连接关系不作为可覆盖参数持久化。产物过期或远端不可访问仍可能无法恢复；纯对话任务需原消息所在会话重新加载后才能回填。浏览器模式没有桌面文件落盘保证。

## 接口依据

- [用户提供的说明书](https://runninghub.feishu.cn/wiki/Vc77w5EaUirOY5kyTQNcrr7GnUd)、[官方 API 索引](https://www.runninghub.cn/runninghub-api-doc-en/llms.txt)。
- [工作流提交](https://www.runninghub.ai/runninghub-api-doc-en/api-425761093.md)、[读取 API 定义](https://www.runninghub.ai/runninghub-api-doc-en/api-425761094.md)、[AI 应用调用](https://www.runninghub.cn/runninghub-api-doc-en/api-425761096.md)、[取消任务](https://www.runninghub.cn/runninghub-api-doc-en/api-425761095.md)。
- 提交/查询接口使用 `code=0`；`/openapi/v2/media/upload/binary` 使用 `code=200`，读取 `data.filename` 与 `data.download_url`。AI 应用定义通过 `/api/webapp/apiCallDemo` 读取；只提取参数，不采用返回脚本中的 URL 或鉴权配置。

## 验证与验收缺口

前端类型检查、测试类型检查、39 个改动代码/测试文件 ESLint、20 个测试文件的 209 项定向测试、前端生产构建均通过；差异和严格 UTF-8 检查通过。测试覆盖导入与持久化、长 ID、零值/布尔值、三类媒体上传、正确凭据、排队、取消、不确定提交、断网、保存失败、过期回写、对话延迟加载和本地 ComfyUI 兼容。Vitest 使用 `--exclude '.planning/**'` 排除任务临时目录中的仓库快照。

离线浏览器预览使用真实组件及内存样例：检查明暗主题、320 px 参数面板、长名称换行、来源切换、空名称校验与编辑保存。未启动桌面软件，未使用真实密钥或执行付费生成，不能视为 RunningHub 真实账户及打包桌面验收通过。

生产构建成功，仍有大 chunk、视频编辑模块及 RunningHub 恢复模块的静态/动态导入混用提示；后者是恢复入口使用动态 import，但适配器同时被生成入口静态引用，不能据此宣称实现了独立代码分包。

阶段 A 的剩余验收：以用户可访问的工作流/应用，明确单次预算后验证真实定义权限、图片/视频/音频上传、任务状态、取消及桌面落盘。测试失败不得通过自动重复付费提交绕过。

## 阶段 B 的待办与覆盖策略

核查时官方标准模型索引有 380 个操作/渠道条目，并非 380 个独立模型。阶段 B 需逐条记录模型 ID、操作、渠道、输入、参数限制、文档与覆盖状态，只有执行合同完整的条目进入可用菜单；新模型不自动全部启用，不重置已有选择。

- 图片：Seedream 5、Qwen Image 2/3、FLUX/F-2、Wan、MJ/Niji、Nano Banana 与 GPT 图像系列。
- 视频：Seedance 2/2.5、Kling、Vidu、Veo、Sora、Wan、Grok、MiniMax H3、HappyHorse、SkyReels、Gemini Omni。
- 音频：MiniMax Speech 2.8、Music 2.6、Suno 5.5、Mureka、豆包、Qwen3 TTS。

以上为核查候选系列，尚未接入。编辑、延长、动作控制、声音克隆等操作需相应输入界面；3D、分层等缺少产物承载的操作单列产品范围，不以文生入口冒充覆盖。

## 回滚

按阶段撤销本任务的明确差异；共享文件仅撤销 RunningHub 分支，保留并行 ComfyUI、APIMart 等改动。保留已有配置、模型选择和工作流记录，不重置数据。旧版本忽略新增可选字段；新增云定义回滚后暂不可执行，但不删除用户记录。本阶段按用户要求做本地 Git 提交，不推送或发布；阶段 B 另行确认。

返回[模型与生成模块](../模型与生成模块.md)。

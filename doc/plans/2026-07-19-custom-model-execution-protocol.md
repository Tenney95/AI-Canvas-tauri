# 通用模型执行协议实施计划

> **执行要求**：按本计划逐步实施；每一阶段先补失败测试，再实现最小可用能力并运行对应检查。禁止把 Provider 特例散落到节点组件，禁止执行用户脚本，禁止把 API Key 写入协议配置、任务或日志。

**目标**：允许用户为每个文本、图片、视频和音频模型独立配置端点、鉴权、请求头、请求体、尺寸映射、同步结果或异步轮询规则，并为 OpenAI 兼容协议提供安全预设。

**架构**：连接配置继续只保存服务地址与密钥；模型配置保存不含凭据的声明式执行协议。统一协议执行器负责模板渲染、鉴权注入、危险请求头拦截、同源校验、提交、轮询和结果解析。普通文本节点可使用同步自定义协议；对话助手与 Agent 只接受显式声明为 OpenAI SSE 兼容的文本协议，避免把任意 JSON API 误当成支持流式和工具调用的接口。

**技术栈**：TypeScript 6、React 19、Zustand 5、Vitest、现有 `pollTask` 与 `pollManager`。

---

### 任务 1：协议领域类型与兼容边界

**文件**：
- 修改：`src/types/aiTypes.ts`
- 修改：`src/types/index.ts`
- 修改：`tests/services/modelProtocol.test.ts`

**步骤**：
1. 在现有 version 1 协议上增加鉴权、静态请求头、文本结果路径、提交错误路径和 OpenAI SSE 格式声明，保持旧配置可读取。
2. 扩展标准模板变量：文本消息、流式开关、工具、图片尺寸、宽高、视频参数、批次数量和音频参数。
3. 明确同步媒体必须配置 URL 结果路径，同步文本必须配置文本结果路径；异步媒体继续使用任务 ID 与轮询结果 URL。
4. 为旧协议兼容、非法字段和能力边界补测试。

### 任务 2：受控声明式协议执行器

**文件**：
- 修改：`src/services/ai/modelProtocol.ts`
- 修改：`tests/services/modelProtocol.test.ts`

**步骤**：
1. 实现 Bearer、自定义 Header、Query 参数和无鉴权四种模式，密钥只在运行时注入。
2. 支持请求级静态 Header；拦截 `Host`、`Origin`、`Cookie`、`Content-Length`、`Authorization` 等危险或与鉴权冲突的 Header。
3. 未提供的完整模板变量自动省略所在对象字段、数组项、查询参数或请求头；字符串内部缺失变量仍报错。
4. 支持 `resultTextPath`、`resultUrlPath`、通配数组路径、提交错误路径、异步状态/结果/错误/进度路径。
5. 轮询持久化鉴权描述和静态 Header，但不持久化 API Key。
6. Tauri 中的非流式协议复用原生 `proxy_fetch` 绕过 WebView CORS；浏览器模式保留标准 `fetch`，OpenAI SSE 流式调用不经过缓冲代理。
7. 保持同源路径、阻断原型链片段、限制轮询间隔，不允许任意脚本或跨域端点。

### 任务 3：预设与尺寸变量

**文件**：
- 修改：`src/services/ai/modelProtocol.ts`
- 修改：`src/services/ai/generateImage.ts`
- 修改：`src/services/ai/generateVideo.ts`
- 修改：`src/services/ai/generateAudio.ts`

**步骤**：
1. 提供 OpenAI Chat、OpenAI 同步图片和 Agnes 异步视频预设。
2. 图片入口提供 `imageSize`、`aspectRatio`、`size`、`width`、`height`、`n`、`batchCount`、`imageUrls`。
3. 视频入口提供 `videoResolution`、`videoFrames`、`videoFps`、`seedanceResolution`、`seedanceRatio`、`seedanceDuration`，以及兼容别名 `width`、`height`、`frames`、`frames8n1`、`fps`、`duration`。
4. 通过请求体模板支持厂商常见尺寸形式：`size: "1024x768"`、独立 `width/height`、`resolution/aspect_ratio` 以及任意嵌套字段。
5. 保留 Agnes 的 `8 * n + 1` 帧数归一化，用户可在高级协议中选择原始帧数或归一化帧数。

### 任务 4：文本生成与对话流式协议

**文件**：
- 修改：`src/services/ai/generateText.ts`
- 修改：`src/services/ai/assistantStream.ts`
- 新增：`tests/services/generateTextProtocol.test.ts`
- 新增：`tests/services/assistantStreamProtocol.test.ts`

**步骤**：
1. 通用文本节点配置执行协议时，使用自定义端点、请求体和 `resultTextPath`；未配置时保持原 OpenAI 兼容逻辑。
2. 对话助手解析模型协议；只有 `streamFormat: "openai-sse"` 的协议允许复用现有 SSE 与 `tool_calls` 解析器。
3. 对话助手请求继续由本地代码提供 `messages`、`stream`、`tools` 和 `toolChoice`，协议只负责安全映射。
4. 自定义同步文本协议若未声明 OpenAI SSE 能力，在 Agent/对话调用时给出明确错误，不静默伪装能力。

### 任务 5：可视化协议编辑器

**文件**：
- 修改：`src/components/settings/ModelProtocolEditor.tsx`
- 修改：`src/components/settings/ProviderConnectionDialog.tsx`
- 修改：`src/styles/settings.css`

**步骤**：
1. 文本、图片、视频和音频模型都显示调用协议设置入口。
2. 高级自定义提供“表单配置 / JSON”两个视图，二者编辑同一份协议并实时校验。
3. 表单覆盖协议模式、鉴权、提交方法与路径、路径基准、请求头、请求体、尺寸映射示例、同步结果路径、异步任务与轮询字段。
4. 请求头和请求体使用 JSON 子编辑器；结果路径使用普通输入框，降低用户理解成本。
5. 提供当前模型类别可用变量列表，不展示 API Key，不允许在协议中引用密钥变量。
6. 检查窄窗口布局、键盘焦点、错误状态和保存后重新打开的持久化结果。

### 任务 6：完整验证与阶段记录

1. 运行 `npm run typecheck`。
2. 运行 `npm run test:typecheck`。
3. 运行协议、文本、对话和轮询定向测试，再运行完整 Vitest。
4. 对所有改动的 TS/TSX 文件运行定向 ESLint。
5. 运行 `git diff --check`、严格 UTF-8 解码和常见乱码扫描。
6. 使用系统临时目录运行 Vite 生产构建。
7. 在桌面和 480px 窄窗口验证表单/JSON 切换、错误阻止保存和持久化。
8. 按项目阶段规则更新相关实施记录；不提交代码，除非用户明确要求。

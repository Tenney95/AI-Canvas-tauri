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

### 任务 7：本地协议测试台

**目标**：让用户在保存自定义协议前检查模板渲染结果，不发送网络请求、不暴露真实 API Key。

**文件**：
- 修改：`src/services/ai/modelProtocol.ts`
- 修改：`src/components/settings/ModelProtocolEditor.tsx`
- 修改：`tests/services/modelProtocol.test.ts`

**步骤**：
1. 为请求预览补失败测试，覆盖 URL、Query、鉴权脱敏、缺失变量省略与零网络请求。
2. 在协议层提供只使用固定掩码密钥的可序列化预览函数，复用生产请求构建和校验逻辑。
3. 在高级自定义编辑器增加可编辑的示例变量 JSON，以及方法、相对 URL、Header 和 Body 预览。
4. 示例变量或协议无效时显示就地错误，不影响现有协议表单的保存校验状态。
5. 运行定向测试、类型检查、定向 ESLint、差异与 UTF-8 检查，并验证桌面和窄窗口布局。

**完成记录（2026-07-20）**：
- 已提供零网络请求的本地预览，复用生产请求模板渲染与校验逻辑，鉴权值固定脱敏为 `********`。
- 已在高级自定义表单中加入分类示例变量，以及方法、相对 URL、Header 和 Body 预览。
- 已通过 17 项协议定向测试、54 项全量测试、前端/测试类型检查、定向 ESLint、生产构建和 UTF-8 检查。
- 已验证桌面与 480px 窄窗口无横向溢出，示例 JSON 错误通过 `aria-describedby` 与输入框关联。

### 任务 8：可配置轮询与查询重试

**目标**：为异步模型查询提供有上限、可恢复、可配置的轮询策略，同时保证付费提交请求永不自动重试。

**文件**：
- 修改：`src/types/aiTypes.ts`
- 修改：`src/services/ai/modelProtocol.ts`
- 修改：`src/components/settings/ModelProtocolEditor.tsx`
- 修改：`tests/services/modelProtocol.test.ts`

**步骤**：
1. 扩展轮询配置：最大次数、最大时长、重试状态码、连续错误重试次数、退避策略、最大延迟、`Retry-After` 和网络错误开关。
2. 补失败测试，覆盖配置校验、503 恢复、重试上限和 `Retry-After` 延迟；确认提交请求不参与重试。
3. 将配置解析到可恢复轮询描述中，不持久化 API Key 或运行时计时器。
4. 查询失败时仅对声明的 HTTP 状态或瞬时网络错误重试；成功查询后重置连续错误计数。
5. 在高级自定义表单加入紧凑的轮询策略设置，并保持旧协议缺省值兼容。
6. 运行定向/全量测试、类型检查、定向 ESLint、生产构建、UTF-8 和桌面/窄窗口验证。

**完成记录（2026-07-20）**：
- 已支持最大轮询次数、最长时长、HTTP 状态码、连续错误次数、固定/线性/指数退避、最大延迟、`Retry-After` 和网络错误重试。
- 默认查询重试状态为 408、429、500、502、503、504，最多连续重试 3 次；付费提交请求仍不重试。
- 查询成功后会重置连续错误计数；任务取消和最长时长在额外退避期间仍然生效。
- 已通过 23 项协议定向测试、60 项全量测试、前端/测试类型检查、定向 ESLint、生产构建和 UTF-8 检查。
- 已验证表单与 JSON 双向映射，以及桌面和 480px 窄窗口无横向溢出。

### 任务 9：请求编码与多形态响应

**目标**：兼容不使用 JSON 请求体或 URL JSON 结果的厂商接口，同时保持声明式配置、同源限制和可恢复任务边界。

**文件**：
- 修改：`src/types/aiTypes.ts`
- 修改：`src/services/ai/httpTransport.ts`
- 修改：`src/services/ai/modelProtocol.ts`
- 修改：`src/components/settings/ModelProtocolEditor.tsx`
- 修改：`tests/services/httpTransport.test.ts`
- 修改：`tests/services/modelProtocol.test.ts`

**步骤**：
1. 为提交请求增加 JSON、Form URL Encoded 和 Multipart Form Data 三种编码；轮询请求支持 JSON 与 Form URL Encoded。
2. Multipart 文件通过受控 `$file` 声明引用模板变量，只接受 Base64 data URL，不读取任意本地路径，也不发起额外网络请求。
3. 扩展 Tauri HTTP 传输层以透传字符串、ArrayBuffer、TypedArray、Blob 与 URLSearchParams 字节，继续复用现有 `proxy_fetch`，不修改 Rust 安全配置。
4. 同步响应支持 JSON URL、JSON Base64、原始文本和原始二进制；Base64 与二进制统一转换为现有媒体链路可消费的 data URL。
5. 异步提交和轮询响应保持 JSON，禁止把运行时二进制结果写入可恢复任务描述。
6. 在高级自定义表单加入请求体编码、Multipart 文件字段、响应类型、Base64 路径与 MIME 类型设置，并让本地预览隐藏文件 Base64 正文。
7. 运行定向/全量测试、类型检查、定向 ESLint、生产构建、UTF-8 和桌面/窄窗口验证。

**完成记录（2026-07-20）**：
- 已完成三种提交编码、两种轮询编码、受控 Multipart 文件和 Tauri 原始字节透传。
- 已完成 JSON Base64、原始文本与原始二进制响应解析；旧协议仍默认使用 JSON 请求和 JSON 响应。
- 本地预览只显示文件 MIME 与字节数，不显示 Base64 正文或真实 API Key。
- 已验证 1280px 与 480px 布局无横向溢出，表单控件可切换且控制台无警告或错误。
- 已通过 36 项协议/传输定向测试、71 项全量测试、前端/测试类型检查、定向 ESLint 和生产构建。
- 高级协议表单已统一使用 28px small 控件；“返回值结构”支持粘贴响应示例并校验 URL、文本、Base64、任务 ID、状态、错误和进度路径，Base64 预览不显示正文。

### 任务 10：version 2 嵌套响应配置

**决策**：新建和重新保存的协议使用 `version: 2`。提交响应统一配置在顶层 `response`，轮询响应统一配置在 `poll.response`，媒体结果路径收口到 `response.result`。version 1 仅作为兼容输入，由协议解析器在内存中升级为 version 2；执行器和编辑器不同时维护两套业务分支。

**兼容与回滚**：
- version 1 的 `responseType`、`result*Path`、`errorPath`、`taskIdPath` 和轮询扁平响应字段继续可读。
- 不提升 IndexedDB 版本，不批量改写已保存配置；旧配置只在用户重新保存时自然转为 version 2。
- `ResolvedModelProtocolPoll` 保持现有内部持久化结构，应用更新前已提交的异步任务仍可恢复。
- 若迁移阶段出现问题，可停止新写入 version 2；version 1 兼容解析器和现有持久化数据不需要回滚。

**目标 JSON**：
```json
{
  "version": 2,
  "mode": "async",
  "submit": { "method": "POST", "path": "/videos", "body": {} },
  "response": {
    "type": "json",
    "taskIdPath": "video_id",
    "errorPath": "error.message"
  },
  "poll": {
    "method": "GET",
    "path": "/agnesapi",
    "response": {
      "statusPath": "status",
      "successValues": ["completed"],
      "failureValues": ["failed", "error"],
      "result": { "urlPath": "url", "mimeType": "video/mp4" },
      "errorPath": "error",
      "progressPath": "progress"
    }
  }
}
```

**实施步骤**：
1. 补充 version 2 预设结构、version 1 自动升级、嵌套字段校验和执行结果测试。
2. 增加 version 1 输入类型、version 2 规范类型与单向升级函数；`parseModelExecutionProtocol()` 始终返回 version 2。
3. 将提交、轮询、响应预览和错误解析改为只读取规范化的嵌套响应配置。
4. 将表单和 JSON 双向编辑改为 version 2；响应示例继续只在本地预览，不进入持久化协议。
5. 运行定向/全量测试、类型检查、定向 ESLint、生产构建、严格 UTF-8 与桌面/480px 界面验证。

**完成记录（2026-07-20）**：
- 新预设和高级表单已统一写入 version 2，JSON 中明确显示顶层 `response` 与 `poll.response.result`。
- version 1 配置继续可执行，并在加载后单向规范化为 version 2；version 2 混用旧扁平响应字段会明确报错。
- `ResolvedModelProtocolPoll` 与 IndexedDB schema 未调整，既有异步任务恢复格式保持兼容。
- 已通过 39 项协议/传输定向测试、76 项全量测试、前端/测试类型检查、定向 ESLint 和生产构建。
- 已复现 Agnes JSON 配置场景，确认表单/JSON 往返不丢失响应字段，1280px 与 480px 无横向溢出且控制台无警告。

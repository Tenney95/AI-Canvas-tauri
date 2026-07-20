# 模型协议智能导入实施计划

> **For Codex:** 使用 `executing-plans` 按任务逐项实施和验证。

**目标：** 允许用户粘贴不同平台的接口文档示例，安全地识别连接地址、模型、分类、提交请求、同步/异步响应和轮询规则，并在确认后应用到自定义厂商草稿。

**架构：** 导入器先把 Fetch、Axios、cURL、Python requests/httpx、Raw HTTP 和 JSON 转换为统一的请求/响应中间结构，再通过可解释的候选评分生成 version 2 声明式协议。UI 只展示解析结果并原子应用到当前表单；粘贴原文不持久化、不执行、不发起网络请求，真实鉴权值不导入。

**技术栈：** React 19、TypeScript 6、Vitest、现有声明式模型协议与 Tailwind/canvas token。

---

## 约束与决策

- 不新增 npm/cargo 依赖，不解析或执行任意 JavaScript、Python、Shell。
- API Key 只推断鉴权方式；`Authorization`、token、key 等值在预览中脱敏且不写入配置。
- 首版支持 OpenAPI JSON 的请求/响应片段；OpenAPI YAML 只提取代码块并提示手动确认。
- Webhook、预签名上传、多阶段上传、加密签名和厂商 SDK 方法若无法映射到现有协议，必须给出明确警告。
- 导入结果先写入弹窗草稿，用户仍需点击“添加厂商/保存修改”；提供撤销本次导入。
- 回滚只需移除导入面板和导入服务；现有配置类型、IndexedDB schema 与执行器均不改变。

## 任务 1：解析合同与测试样例

**文件：**
- 新增：`tests/services/modelProtocolImport.test.ts`
- 新增：`src/services/ai/modelProtocolImport.ts`

**步骤：**
1. 写 APIMart Fetch + 双响应样例失败测试，断言 baseUrl、模型、分类、变量映射和异步路径。
2. 写 Agnes cURL、OpenAI 同步图片、Python requests、Raw HTTP 样例测试。
3. 写密钥脱敏、混合代码块、低置信度冲突和不支持能力警告测试。
4. 运行 `npx vitest run tests/services/modelProtocolImport.test.ts`，确认测试先因模块缺失失败。

## 任务 2：多格式适配器与统一中间结构

**文件：**
- 新增：`src/services/ai/modelProtocolImport.ts`

**步骤：**
1. 提取 Markdown 标题、围栏代码块、URL、JSON 和请求代码片段。
2. 为 Fetch/Axios、cURL、Python requests/httpx、Raw HTTP 建立受控适配器。
3. 统一为请求、响应、来源证据、警告和置信度结构。
4. 识别共同 baseUrl、请求方法、query、headers、body encoding 和模型分类。
5. 通过字段语义与示例值映射模板变量；未知字段保留静态值并降低置信度。
6. 推断任务 ID、状态、进度、错误、URL/文本/Base64 路径和轮询任务占位符。
7. 调用 `validateModelExecutionProtocol()` 校验最终协议，失败时禁止应用。
8. 运行定向测试并修复到全部通过。

## 任务 3：导入预览面板

**文件：**
- 新增：`src/components/settings/ProtocolImportPanel.tsx`

**步骤：**
1. 实现粘贴输入、解析按钮、清空/关闭操作和本地错误状态。
2. 展示连接、模型、请求、响应、置信度和警告；不回显鉴权值。
3. 允许用户修改模型分类，并在应用前明确显示将覆盖的草稿字段。
4. 使用现有 canvas token、12px 表单字体和 small 尺寸控件；窄窗口改为单列。

## 任务 4：接入自定义厂商配置

**文件：**
- 修改：`src/components/settings/ProviderConnectionDialog.tsx`

**步骤：**
1. 仅为 `custom-openai` 显示“从接口文档导入”。
2. 应用结果时更新 baseUrl，合并并勾选模型，写入 custom executionProfile。
3. 保留连接名称和用户已填写的 API Key，不覆盖其他模型。
4. 保存导入前快照，支持一次撤销；切换厂商或关闭窗口时清理原文和快照。
5. 自动打开导入模型的协议编辑器，便于继续校验和微调。

## 任务 5：完整验证

**步骤：**
1. 运行 `npx vitest run tests/services/modelProtocolImport.test.ts tests/services/modelProtocol.test.ts`。
2. 运行 `npm run typecheck` 与 `npm run test:typecheck`。
3. 运行改动文件定向 ESLint。
4. 运行全量 `npm test` 和临时目录生产构建。
5. 运行 `git diff --check`、严格 UTF-8 与常见乱码扫描。
6. 在 1280px 与 480px 验证粘贴、解析、分类调整、应用、撤销和错误状态，检查控制台无错误。

## 完成记录

- 状态：已完成。
- 已支持 Fetch、Axios、cURL、Python requests/httpx、Raw HTTP、OpenAPI JSON 与混合 JSON 响应。
- 已完成共同 baseUrl、模型分类、模板变量、同步结果、异步任务、轮询占位符和嵌套数组结果路径推断。
- Authorization、Header/Query Key 仅用于推断鉴权方式；真实值不进入结果。请求体鉴权、Webhook、YAML 和不完整异步流程会明确阻止应用。
- 导入表单已拆分为提交请求、提交响应、轮询请求、轮询响应四块结构化输入；提交请求与响应必填，启用异步轮询后轮询请求与响应必须成对填写。
- 桌面端请求/响应采用左右双栏，窄于 700px 自动切换为单栏；已完成高/中/低置信度预览、分类重算、草稿应用、API Key 保留和一次撤销。
- 已通过 9 项导入测试、43 项协议定向测试、92 项全量测试、定向 ESLint 和生产构建；当前前端/测试类型检查被工作区另一组 `projectSnapshotService.ts` 未提交改动中的既有类型错误阻断（缺少 `sourceHeight`、`sourceWidth`），本阶段未越界修改。
- 已验证 1280px 与 480px 的四块输入、轮询切换、识别、分类调整、应用和撤销；无横向溢出或浏览器控制台错误。

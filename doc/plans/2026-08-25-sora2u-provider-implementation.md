# Sora2U 内置厂商实施计划

> **执行要求：** 按任务顺序实施，每项先写失败测试，再做最小实现并运行定向验证。

**目标：** 在应用中内置 Sora2U 的全部公开图片/视频模型、完整多模态生成能力和合作专属入口。

**架构：** 沿用厂商连接、统一模型目录与声明式协议运行时。用本地 manifest 提供稳定兜底，用带 Key 的远端 `/api/v1/models` 补齐并更新能力；不在节点组件中增加厂商执行分支。

**技术栈：** React 19、TypeScript、Zustand、Vitest、现有模型协议运行时与 Tauri 凭据存储。

---

### 任务 1：锁定内置模型和协议契约

**文件：**

- 新建：`src/services/ai/providers/sora2uModelManifest.ts`
- 新建：`tests/services/sora2uModelManifest.test.ts`

**步骤：**

1. 写测试断言 Base URL、本地九模型 ID、图片/视频类别、能力范围与协议的提交/轮询字段。
2. 运行 `npx vitest run tests/services/sora2uModelManifest.test.ts`，确认因模块不存在而失败。
3. 实现最小 manifest 与图片/视频声明式协议。
4. 再次运行同一测试，预期通过。

### 任务 2：远端模型目录能力归一化

**文件：**

- 修改：`src/services/ai/providerCatalogService.ts`
- 修改：`src/types/index.ts`（仅在目录适配器类型需要扩展时）
- 修改：`tests/services/providerCatalogService.test.ts`

**步骤：**

1. 写测试模拟 Sora2U `data[]` 响应，断言远端模型与本地协议按 ID 合并，并保留时长、比例、分辨率、参考素材上限。
2. 运行定向测试确认失败。
3. 新增 Sora2U 厂商定义和目录归一化；固定 API 同源，不接受响应改写 Base URL。
4. 运行目录与 manifest 测试，预期通过。

### 任务 3：统一模型同步与设置入口

**文件：**

- 修改：`src/store/store.config.ts`
- 修改：`src/components/settings/ProviderConnectionDialog.tsx`
- 修改：`tests/components/apiKeySettings.test.ts`
- 修改或新建：对应 Store 定向测试（按仓库现有测试位置复用）

**步骤：**

1. 写测试断言 Sora2U 所选模型同步为 `GeneralModelConfig`，且外部按钮使用精确 UTM 链接。
2. 运行定向测试确认失败。
3. 把 `sora2u` 纳入统一模型目录同步，并增加专属入口；不改 API Base URL。
4. 运行设置与 Store 测试，预期通过。

### 任务 4：完整多模态参考传输

**文件：**

- 修改：`src/types/aiTypes.ts`
- 修改：`src/services/ai/generateVideo.ts`
- 修改：`src/services/ai/modelProtocol.ts`、`src/services/ai/modelProtocolBody.ts` 或最小必要的协议变量模块
- 修改：`tests/services/generationRuntime.test.ts` 或新增 Sora2U 生成定向测试

**步骤：**

1. 写测试覆盖无参考文生视频、多张图片、视频和音频混合参考，以及仅允许参考驱动的模型。
2. 运行测试确认当前协议变量无法完整构造 Sora2U 请求。
3. 扩展通用协议变量的参考素材表达，使 manifest 能声明 `reference_urls` / `references`；禁止按厂商 ID 在节点层分支。
4. 写轮询成功、失败、空结果与取消测试并运行通过。

### 任务 5：回归验证与实施记录

**文件：**

- 修改：`doc/对话助手-Agent能力实施方案.md`（仅记录本次确实影响的统一媒体/Provider 能力；若阅读后确认不属于其阶段范围，则不修改并在交付中说明）

**步骤：**

1. 搜索所有 `sora2u`、厂商目录和模型引用，确认无重复硬编码或遗漏清理路径。
2. 运行所有新增/修改相关 Vitest。
3. 运行 `npm run typecheck` 与改动文件定向 ESLint。
4. 运行 `npx vite build --outDir <系统临时目录>`、`git diff --check` 和严格 UTF-8/乱码扫描。
5. 检查 `git status --short`，确认没有意外文件；按阶段使用中文提交说明提交。

### 任务 6：合作追踪参数与额度验证修正

**文件：**

- 修改：`src/services/ai/providers/sora2uModelManifest.ts`
- 修改：`src/services/ai/providerCatalogService.ts`
- 修改：`src/services/testConnection.ts`
- 修改：`tests/services/sora2uModelManifest.test.ts`
- 修改：`tests/services/providerCatalogService.test.ts`
- 修改：`tests/services/testConnection.test.ts`

**步骤：**

1. 写失败测试，断言额度验证、模型目录、生成提交和任务轮询都携带固定 UTM 查询参数。
2. 在厂商定义中集中声明只读验证路径和静态请求查询参数，避免各调用点手写字符串。
3. 连接验证改用 `/api/v1/credits`，解析 `balance` 与 `currency`，不发送生成请求。
4. 声明式图片/视频协议的提交和轮询，以及模型目录请求，统一复用同一份 UTM 参数。
5. 保持服务端返回的签名媒体 URL 原样，不对下载地址追加参数。

### 任务 7：设置页余额与临时模型隐藏

**文件：**

- 修改：`src/components/settings/ApiKeySettings.tsx`
- 修改：`src/services/ai/providerCatalogService.ts`
- 修改：`tests/services/providerCatalogService.test.ts`
- 修改：`tests/services/sora2uModelManifest.test.ts`

**步骤：**

1. API Key 页面每次挂载后自动调用 Sora2U 额度验证，并在连接状态右侧显示最新 GP 余额。
2. 额度请求失败时保持卡片可用且不展示过期结果；API Key 或接口地址变化时允许重新请求。
3. 在厂商目录中声明三个暂时隐藏的 Seedance 2.5 模型 ID，同时过滤远端目录和本地兜底目录。
4. 页面加载已有 Sora2U 配置时清理被隐藏模型，并同步通用模型目录，确保所有模型选择入口都不再展示。
5. 保留九个模型的底层执行协议，后续恢复时只需撤销目录隐藏规则。

### 任务 8：模型菜单独立厂商分组

**文件：**

- 修改：`src/components/nodes/shared/defaultModels.ts`
- 修改：`src/components/nodes/shared/ModelSelector.tsx`
- 修改：`tests/components/defaultModels.test.ts`

**步骤：**

1. 为复用通用执行协议的 Sora2U 模型生成独立厂商分组展示元数据。
2. 节点模型菜单把 Sora2U 分组与普通“通用模型”分开渲染，并保持分组始终可用。
3. 对话图片/视频媒体目录复用相同分组规则，避免两个入口显示不一致。
4. 模型值继续使用 `general/...`，不迁移节点数据或改变生成 Provider 路由。
5. 补测试确认 Sora2U 独立分组、自定义中转站仍归入通用模型，以及媒体目录引用不变。

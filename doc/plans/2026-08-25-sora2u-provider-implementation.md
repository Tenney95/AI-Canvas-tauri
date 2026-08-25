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

# 厂商连接与模型目录重构 Implementation Plan

> **For Codex:** 按阶段小步迁移，每阶段验证并提交；不删除旧通用模型字段，不改 Tauri 安全配置或 IndexedDB schema。

**Goal:** 将 API 凭据与模型选择分离，让用户按厂商添加连接、拉取目录并只启用真正需要的模型；画布、项目设置和对话助手统一消费用户启用的模型。

**Architecture:** 代码内置 `ProviderDefinition` 描述厂商凭据与目录能力，`ApiProviderConfig` 每个连接只保存一份凭据，`ProviderModelSelection` 保存不含密钥的模型选择。远程目录统一解析 OpenAI 兼容响应，无目录能力的厂商使用调用方提供的本地 manifest；旧 `generalModels` 渐进迁移并继续作为执行兼容层。

**Tech Stack:** React 19、TypeScript、Zustand、现有 Fetch API 与模型 Provider 服务。

---

## 范围与约束

- 覆盖 APIMart、火山方舟、RunningHub、GRSAI、即梦和自定义 OpenAI 兼容接口。
- APIMart、火山方舟和自定义接口优先请求 `/models`；远程失败时内置厂商可回退本地 manifest。
- RunningHub、GRSAI 和即梦使用本地 manifest，不把 RunningHub 资源列表误当标准模型目录。
- `selectedModels === undefined` 表示旧配置尚未选择；空数组表示用户明确未启用模型。
- API Key 只保存在 `config.providers`，不进入模型选择、日志、消息或任务元数据。
- 不新增依赖，不提升 IndexedDB schema 版本，不修改 `tauri.conf.json`。

### 阶段 1：目录类型、Adapter 与配置兼容

**Files:**
- Modify: `src/types/index.ts`
- Create: `src/services/ai/providerCatalogService.ts`
- Modify: `src/store/store.config.ts`
- Create: `doc/plans/2026-07-19-provider-model-catalog.md`

**Steps:**
1. 定义厂商目录 Adapter、模型选择和连接扩展字段，保持新增字段可选。
2. 建立内置厂商 Registry，实现 OpenAI 兼容目录解析、模型类别推断、取消与安全错误。
3. 为无官方目录的厂商支持调用方本地 manifest，并允许远程目录失败后回退。
4. 增加连接保存/删除 Action；自定义连接同步兼容 `generalModels`。
5. 加载旧 `generalModels` 时按地址和 Key 分组迁移为自定义连接，保留旧字段和模型 ID。

### 阶段 2：API Key 设置页添加流程

**Files:**
- Create: `src/components/settings/ProviderConnectionDialog.tsx`
- Modify: `src/components/settings/ApiKeySettings.tsx`
- Modify: `src/styles/settings.css`

**Steps:**
1. 在 API Key 页标题右侧添加加号，打开厂商选择与连接配置弹窗。
2. 根据 Provider Definition 渲染凭据字段和即梦 OAuth 状态。
3. 拉取或读取模型目录，提供搜索、类别过滤、全选与逐项勾选。
4. 保存后仅在设置列表展示已接入厂商，支持编辑和删除。
5. 连接测试复用厂商配置，修正火山方舟与 RunningHub 的错误测试端点。

### 阶段 3：画布与项目设置模型过滤

**Files:**
- Modify: `src/components/nodes/shared/defaultModels.ts`
- Modify: `src/components/nodes/shared/ModelSelector.tsx`
- Modify: `src/components/ProjectSettingsPopover.tsx`

**Steps:**
1. 建立目录选择到既有 `ModelOption` 的统一映射。
2. 旧厂商配置继续显示全部内置模型；明确选择后仅显示勾选项。
3. 自定义连接模型继续通过兼容 `generalModels` 出现在对应节点类型。
4. 项目默认模型失效时显示明确空态，不静默改写已保存配置。

### 阶段 4：对话与执行链统一解析

**Files:**
- Modify: `src/components/chat/ChatInput.tsx`
- Modify: `src/components/chat/ChatPanel.tsx`
- Modify: `src/services/ai/helpers.ts`
- Modify: `src/services/ai/assistantStream.ts`
- Modify: `src/services/ai/generationRuntime.ts`
- Modify: `src/services/chat/tools/mediaTools.ts`
- Modify: `src/components/nodes/shared/toolbar/presetAction.ts`

**Steps:**
1. 对话模型菜单仅展示用户启用且连接可用的模型。
2. 文本与媒体执行通过 `providerConfigId` 读取单份凭据，兼容旧模型内嵌字段。
3. 独立对话窗口快照仅传递执行所需配置，不输出或记录凭据。
4. 预设和 Agent 媒体工具使用相同的模型可用性判断。

### 阶段 5：端到端验证

1. 严格 UTF-8 解码并扫描常见乱码字符。
2. 运行 `npm run typecheck` 和改动文件定向 ESLint。
3. 运行 `git diff --check` 与临时目录生产构建。
4. 在桌面与窄窗口验证添加、编辑、删除、目录回退、搜索筛选和各模型入口。

## 完成记录

- 2026-07-19 完成阶段 1：厂商目录类型、Provider Definition Registry、OpenAI 兼容目录 Adapter、本地 manifest 回退、连接 Store Action 和旧通用模型兼容迁移。
- `npm run typecheck` 通过。
- 阶段 1 改动 TS 文件定向 ESLint 通过。
- `git diff --check` 通过。
- 阶段 1 文件严格 UTF-8 解码通过，未发现常见乱码序列。
- `npx vite build --outDir %TEMP%/ai-canvas-provider-catalog-build-20260719` 通过；仅有既有动态导入与 chunk 体积警告。
- 2026-07-19 完成阶段 2：API Key 标题加号、厂商选择、凭据配置、远程/本地模型目录、搜索分类勾选、编辑删除，以及 RunningHub 双 Key 与即梦 OAuth 兼容。
- `npm run typecheck` 与阶段 2 TSX 文件定向 ESLint 通过。
- `git diff --check` 与阶段 2 文件严格 UTF-8 解码通过。
- `npx vite build --outDir %TEMP%/ai-canvas-provider-settings-build-20260719` 通过；仅有既有动态导入与 chunk 体积警告。
- 在本地 Web 模式验证 1280×720 与 680×760 视口：厂商弹窗 Portal 层级、搜索、分类、勾选、自定义手动模型、RunningHub 双 Key、固定操作栏和内部滚动均正常；浏览器控制台无错误，未写入测试配置。

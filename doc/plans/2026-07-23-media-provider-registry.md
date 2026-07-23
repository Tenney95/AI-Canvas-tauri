# 媒体 Provider Registry 渐进收敛方案

## 状态

Accepted，第一阶段已完成。

## 背景

图片、视频和音频生成入口分别维护 Provider 分支，并直接承担连接读取、密钥与地址校验、模型特例和执行协议选择。新增一个跨媒体厂商时，需要同步修改多个入口，模型目录与参数 UI 也可能声明入口实际不支持的 capability。

本阶段只收敛执行路由，不重写全部 Provider，不调整模型持久化、Agent 权限、Tauri 安全配置或 IndexedDB schema。

## 决策

新增会话无关的 `MediaProviderRegistry`，以 `image`、`video`、`audio` 三类 capability 注册 adapter：

- adapter 必须声明 `providerId` 和 capability；
- 每个声明的 capability 必须存在对应 handler，反之亦然；
- 同一 Registry 中禁止重复注册相同 Provider；
- 三个生成入口保留公共前置处理，优先向 Registry 查询 handler；
- 未注册 Provider 继续使用原有兼容分支，允许逐个迁移；
- Provider 配置、鉴权、端点和模型特例由 adapter 读取并处理；
- `AbortSignal` 只作为运行时参数传递，不进入任何持久化对象。

第一阶段选择 APIMart 作为验证对象，因为它同时具备图片、视频、语音和音乐能力，可以验证一个 adapter 覆盖多个媒体 capability 的边界。

## 数据流

```text
节点 / 对话 generationRuntime
            |
            v
 generateImage / generateVideo / generateAudio
            |
      公共输入预处理
            |
            v
   MediaProviderRegistry
       |             |
       | 已注册      | 未注册
       v             v
 APIMart adapter   既有兼容分支
       |
       v
 config.providers + 现有 APIMart 执行器
```

视频参考图解析保持惰性：只有 APIMart Seedance 模型会解析 `@` 图片引用和连接节点；旧 APIMart 视频模型不新增读取或错误路径。

## 第一阶段文件

- 新增：`src/services/ai/mediaProviderRegistry.ts`
- 新增：`src/services/ai/providers/apimartMedia.ts`
- 修改：`src/services/ai/generateImage.ts`
- 修改：`src/services/ai/generateVideo.ts`
- 修改：`src/services/ai/generateAudio.ts`
- 新增：`tests/services/mediaProviderRegistry.test.ts`
- 新增：`doc/plans/2026-07-23-media-provider-registry.md`
- 修改：`doc/对话助手-Agent能力实施方案.md`

## 保持不变的边界

- ComfyUI 工作流仍在生成入口优先分流，不进入模型 API Registry。
- Dreamina、火山方舟、RunningHub 和通用模型继续走既有分支。
- APIMart 的图片批量、视频待续任务、Flow Music 两阶段任务、TTS 二进制结果和取消信号语义不变。
- API Key 仍只从 `config.providers.apimart` 读取，不写入消息、节点、任务或日志。
- 付费媒体仍由上层 Policy 每次确认，adapter 不改变确认和重试策略。

## 备选方案

### 仅抽取连接配置 helper

改动最小，但三个入口仍要维护 Provider 分支，无法形成可扩展注册点，也不能校验 capability 与 handler 一致性，因此不采用。

### 一次迁移所有 Provider

最终结构更整齐，但会同时影响 Dreamina、火山、RunningHub、通用协议和多个异步任务恢复链路，回归范围过大，不符合渐进迁移要求，因此不采用。

### Registry + 单 Provider 迁移

本阶段采用。先用 APIMart 验证跨媒体 adapter，其他 Provider 按后续独立阶段迁移。

## 风险与缓解

| 风险 | 缓解 |
|---|---|
| capability 声明与 handler 不一致 | 注册时固定校验并补契约测试 |
| 迁移改变输入预处理顺序 | 保留工作流优先级；视频参考图惰性解析 |
| 取消信号丢失 | 三类 handler 均显式接收并转发 `AbortSignal` |
| 待续任务字段变化 | 复用现有 APIMart 执行器和原有 `providerConfigId` / `taskType` |
| 并行任务覆盖工作树 | 只修改本阶段文件，验证前复查 `git status` 与定向差异 |

## 验证

- Registry 注册、重复注册、注销和 capability/handler 一致性测试；
- APIMart 图片、Seedance 视频、旧视频、TTS 与缺失密钥行为测试；
- `npm run typecheck` 与 `npm run test:typecheck`；
- 改动文件定向 ESLint 和相关 Vitest；
- 全量 Vitest、临时目录 Vite 生产构建、`git diff --check`；
- 严格 UTF-8 解码和常见乱码扫描。

## 回滚

恢复三个生成入口中的 APIMart 分支，删除 Registry、APIMart adapter 和对应测试即可。没有配置或数据库迁移，不需要数据修复；已生成媒体和待续任务格式不受影响。

# Sora2U 内置厂商接入设计

## 目标与范围

在现有“API 厂商”连接体系中新增独立的 `Sora2U` 内置厂商。用户填写自己的 Sora2U API Key 后，可以直接启用站点当前公开的全部图片与视频模型，并在图片节点、视频节点和对话 `@model` 入口中使用。连接界面的外部入口统一打开合作方提供的专属链接：

`https://sora2u.com/?utm_source=tenney&utm_medium=canvas&utm_content=wx`

该链接只用于注册、获取 Key、充值和站点访问。真实 API Base URL 固定为 `https://sora2u.com`，不会把带 UTM 参数的页面链接写入请求地址。

合作追踪参数同时固定附加到 Sora2U API 请求：`utm_source=tenney`、`utm_medium=canvas`、`utm_content=wx`。连接验证使用无生成副作用的 `GET /api/v1/credits`；模型目录、生成提交和任务轮询使用同一组参数。服务端返回的图片/视频签名地址保持原样，避免修改查询串导致签名失效。

首版覆盖公开 API 已声明的全部能力：远端模型目录、图片生成、文生视频、图片/视频/音频参考驱动、多参考素材、连续整数时长、宽高比、分辨率、静音选项、异步轮询、错误信息和取消信号。任务列表、余额展示和主动取消远端任务不新增独立 UI；它们不是画布生成链路的必要条件。

## 架构与数据流

Sora2U 继续复用现有“厂商连接 → `selectedModels` → `generalModels` → 声明式协议运行时”的主路径，不在节点组件或 `ChatPanel` 中增加厂商分支。应用随包提供一份本地 manifest，保证离线打开连接弹窗时仍能看到文档当前列出的完整模型；用户填写 Key 并刷新后，再以 `GET /api/v1/models` 为权威来源，按模型 ID 合并名称、类别、时长、比例、分辨率、参考类型及上限。远端新增模型可以进入选择列表，远端暂时不可用时回退本地清单并显示警告。

图片和视频模型都提交到 `POST /api/v1/videos`。提交响应从 `task.id` 取任务 ID，轮询 `GET /api/v1/videos/{id}`，以 `task.status` 判定终态；图片读取 `task.image_url`，视频读取 `task.video_url`，失败读取 `task.error`。API Key 仍只经现有 `providerSecretService` 交给 Rust 凭据存储，不进入 manifest、日志、消息或导出配置。

为了完整承载多模态参考，通用协议变量增加“合并后的参考素材”语义，并由协议声明选择 `reference_urls` 或 `references`，避免在执行入口按 `providerId` 写硬编码判断。Sora2U 优先使用公网 HTTPS 引用；需要内联时保留带 MIME 的 data URL，确保视频和音频不会被误判为图片。

## 模型与能力映射

本地兜底清单包含文档当前列出的九个公开模型：`seedance-1.5`、`seedance-2.0`、`seedance-2.0-character`、`seedance-2.0-character-mono`、`seedance-2.5`、`seedance-2.5-character`、`seedance-2.5-character-mono`、`gemini-image`、`kontext-image`。

模型目录返回的 `duration_range` / `durations`、`aspect_ratios`、`resolutions` 和默认值会归一化为 `VideoModelCapability`。`supports_image`、`supports_video`、`supports_audio` 与 `reference_limits` 映射为画布的参考素材约束。`supports_text_only: false` 的视频模型在没有任何参考素材时直接给出本地可理解错误，避免付费请求到达远端后才失败。图片模型最多接收目录声明的参考图数量，不接收视频或音频参考。

远端目录缺少某项能力时，按同 ID 的本地 manifest 补齐；未知新模型只使用远端明确返回的字段，不凭名称编造付费参数。模型类别优先依据目录能力或本地定义判断，最后才退回现有 ID 规则推断。

## 错误处理与安全

创建请求不自动重试，避免重复扣费。轮询阶段仅对网络错误、`408`、`429` 和常见 `5xx` 做有限退避，并遵守取消信号。`pending` / `processing` 继续轮询；`completed` 必须同时存在对应媒体 URL 才算成功；`failed` / `canceled` 立即终止并展示清洗后的 `task.error`。`401` 提示检查 Key，`402` 提示余额不足，参数与参考素材错误保留服务端可读信息。

网页文档和远端模型目录都视为不可信输入：只解析预期 JSON 字段，不接受它们改变 Base URL、鉴权头、Policy 或协议路径。Base URL 固定同源，轮询路径只能由返回的任务 ID填入既定模板。专属链接只在用户主动点击时通过现有外部打开能力访问。

## 验证

测试覆盖内置厂商元数据、本地九模型清单、远端目录能力归一化、Store 同步、专属链接、图片请求、多模态视频请求、任务轮询成功/失败以及无参考素材限制。完成后运行相关 Vitest、`npm run typecheck`、改动文件定向 ESLint、临时目录生产构建、`git diff --check` 和严格 UTF-8/乱码扫描。若全仓 lint 命中项目已知 ESLint 10 兼容问题，只记录该既有阻断，不修改依赖。

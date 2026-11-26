# MAGI‑2 接入调研与实施方案

初次调研日期为 **2026 年 11 月 26 日**。代码已接入 Sand 国际与中国站 Ark、原生 v2，以及 Higgsfield、BeatAPI、Nereo 的 MAGI‑2。真实账户和桌面交付待验收。通用架构及其余模型迁移顺序见[视频模型通用适配方案](./2026-11-26-video-model-interoperability.md)。

## 1. 模型和可用入口

Sand AI 于 **2026 年 11 月 24 日**发布 480B MAGI‑2 旗舰版。2026 年 8 月的约 114B MAGI‑2 Preview 是另一版本。旗舰版公开能力包括最长 30 秒、1080p、25 fps 原生音视频、最多 20 份图／视频／音频参考，以及按提示词控制时间线和编辑。发布文章将旗舰开源列为后续工作，本轮未找到可作为旗舰本地部署依据的正式权重。时间线和编辑示范可以用于提示词设计，只有接口合同给出独立操作或字段后才在应用中开放结构化控件。[Sand AI 官网](https://sand.ai/) · [旗舰发布公告](https://sand.ai/blog/magi-2/)

| 入口 | 此次核实 | AI Canvas 建议 |
| --- | --- | --- |
| Sand AI 国际站 | `https://api.sand.ai`，Sand 组织 Bearer Key，模型 `magi-2`。1080p 报价 0.08 USD／输出秒。 | 同一厂商下建立独立地区连接。先开放 Ark 合同。 |
| Sand AI 中国站 | `https://api.sandai.cn`，该站组织 Bearer Key，模型 `magi-2`。1080p 报价 0.5 元／输出秒。中国站原生和 Ark 合同均声明可选布尔 `watermark`，默认 `false`。 | 地区由连接显式选择。中国站单独声明水印字段。 |
| VidMuse | 官方合作体验入口。帮助中心覆盖创作、素材、工作区、Credits 及 Lab 的插件、Skill、CLI 指南。VidMuse 自己的 MAGI‑2 指南将开发者导向 Sand AI 开放平台。 | 可作为体验和操作说明入口。网页账户、Credits 和网站会话独立管理。 |
| Higgsfield | 文生、首帧／首尾帧、多模态参考分路由。`Authorization: Key …`，提交返回 UUID `request_id`，按 `/requests/{request_id}/status` 查询，完成产物为 `video.url`。 | 已接入公开 HTTPS 素材三模式。单独验证本地上传后再开放剪辑。 |
| BeatAPI | Bearer，`POST /v1/videos/tasks`，`GET /v1/tasks/{id}`，任务标识 `data.id`，视频为 `data.output.media[].url`。支持通过可选 `Idempotency-Key` 对同一请求体做 24 小时内重放。 | 适合验证同名模型的不同合同。提示词必填、上限 5,000，关键帧走 `images`，比例由首帧决定，常规参考走 `reference_*`。 |
| Nereo | Bearer，`/api/v1/sand/magi-2/{操作}`，`request_id` 及 `/api/v1/requests/{id}/status`，产物 `outputs[].url`。多参使用 `reference_image_urls`、`reference_video_urls`、`reference_audio_urls`。 | 已接入公开 HTTPS 素材三模式，创建响应应为 200。 |
| ModelSell、Muapi | ModelSell 公布 `/sand/magi-2/*` 的三种 Bearer 路由。Muapi 使用 `x-api-key`，实际部署版本待核。 | 继续核实完整提交、查询、结果、账户权限再发布预设。 |

报价是查阅当日的目录值。Sand 两地模型价目页均提示充值暂未开放，账务指南描述一般操作流程。是否能创建 Key、开通模型、充值和调用须以对应组织控制台为准，应用内报价应带币种、来源日期和估算状态。文档未列出可用于首版的公开模型目录、余额查询或生成取消端点。[国际站价格](https://platform.sand.ai/docs/model-pricing/) · [中国站价格](https://platform.sandai.cn/docs/model-pricing/) · [中国站快速开始](https://platform.sandai.cn/docs/get-started/) · [国际站账务](https://platform.sand.ai/docs/credits/) · [VidMuse 帮助](https://vidmuse.ai/docs/zh-Hans) · [体验页](https://vidmuse.ai/zh-CN/magi-2) · [VidMuse 开发者指引](https://vidmuse.ai/blog/magi-2-on-vidmuse) · [Higgsfield 快速开始](https://open.higgsfield.ai/quick-start) · [文生](https://open.higgsfield.ai/models/sand/magi-2/text-to-video/api-reference) · [首尾帧](https://open.higgsfield.ai/models/sand/magi-2/image-to-video/api-reference) · [多参体验](https://open.higgsfield.ai/models/sand/magi-2/reference-to-video/playground) · [BeatAPI](https://docs.beatapi.io/api-reference/video-api/magi-2) · [ModelSell](https://token.xhh.com/docs/api-reference/magi-2/overview) · [Nereo](https://api.nereo.io/models/sand/magi-2/text-to-video) · [Muapi](https://muapi.ai/magi-2)

## 2. Sand 两套合同

连接保存 API 主机根地址，合同使用下表的同源路径。Ark SDK 的 `base_url` 额外带 `/compatible/ark/api/v3`，手填该值时只能拼接其余路径一次。所有创建返回字符串 `id`，按正 int64 十进制校验并保留原字符串。

| 项目 | Sand Ark 兼容 | Sand 原生 v2 |
| --- | --- | --- |
| 创建、查询 | `POST /compatible/ark/api/v3/contents/generations/tasks` → HTTP 200，`GET` 同路径加 `/{id}` | `POST /v2/generations` → HTTP 202，`GET /v2/generations/{id}` |
| 文本 | `content` 包含最多一个 `text` 项。纯文本必须非空，含素材时可省略，包括仅音频。 | `parts` 恰有一条非空文本，使用素材时仍必填。 |
| 素材和角色 | `image_url`／`video_url`／`audio_url` 与相应 `role`，上限 21 项含文本。支持普通图片／视频／音频、单首帧、首尾帧。尾帧须配首帧，关键帧和普通参考互斥。单张普通参考图显式传 `reference_image`。 | `reference_image`／`reference_video`／`reference_audio` 对应 `image`／`video`／`audio` 对象。各素材只能有 `assetId` 或 `url` 之一，保留媒体项顺序，`role` 禁用。 |
| 分辨率、时长、比例 | 1080p，4–30 整秒，比例为 `21:9`、`16:9`、`4:3`、`1:1`、`3:4`、`9:16`。 | 1080p，API 字段声明为正整数，旗舰发布上限 30 秒。比例字段为 `aspectRatio`，接口声明格式及组合约束。原生每种输入下限和完整组合表待实测。首版如开原生，界面可先提供 4–30 秒和六种比例，标为应用范围。 |
| 提示词和选项 | 文本上限 15,000 Unicode 码点。`generate_audio` 缺省为有声，`enhance_prompt` 缺省委托模型，`seed` 为随机 `-1`／省略或固定 `0–4294967295`。`omni_reference_task_type` 只接受 `auto`。 | 同一文本上限和随机种子范围。对应字段 `generateAudio`、`enhancePrompt`，静音时仍可带参考音频。 |
| 水印 | 中国站可选。国际站省略，发送任意布尔会被拒绝。 | 中国站可选。国际站省略。 |
| 生成结果 | `queued`、`running`；`succeeded` → `content.video_url`；终止 `failed`、`expired`、`cancelled`。可选返回实际时长、帧率和音轨等。 | `queued`、`processing`；`succeeded` → `output.videoUrl`，过期字段 `output.urlExpiresAt`；终止 `failed`、`canceled`。创建错误可能包含 `details.generation_id`。 |
| 素材地址 | 同组织 `asset://{id}`、公开 HTTPS。图片／音频允许指定 MIME 的 Base64 Data URL。JSON 总上限 64,000,000 字节，非媒体 JSON 最多 2 MiB。 | 同组织 `assetId` 或 `asset://{id}`、公开 HTTPS。公开 URL 最多 8192 字符，可携带签名查询参数。 |

两套 API 均使用 `POST /v1/assets` 的 multipart 单文件字段 `file`。完整请求上限 201,048,576 字节。上传返回数值 int64，适配器须在进入 JavaScript Number 之前无损读取并转换为十进制字符串。图片最多 10 张，每张小于 30,000,000 字节，边长 16–10,000 像素，最多 16,000,000 像素且最长边不超过最短边的 100 倍。视频最多 5 段，MP4／MOV 的 H.264／H.265，每段不超过 200,000,000 字节。音频最多 5 段，WAV／MP3，每段不超过 15,000,000 字节。视频、音频单段均 2–30 秒，各自累计最多 30 秒，重复引用按出现次数计算。支持的图片扩展名与容器音轨以素材文档为准。[国际站原生创建](https://platform.sand.ai/docs/create-generation/) · [国际站查询](https://platform.sand.ai/docs/get-generation/) · [国际站 Ark](https://platform.sand.ai/docs/ark-generations/) · [中国站原生创建](https://platform.sandai.cn/docs/create-generation/) · [中国站 Ark](https://platform.sandai.cn/docs/ark-generations/) · [素材上传](https://platform.sand.ai/docs/upload-asset/) · [素材生命周期](https://platform.sand.ai/docs/delete-asset/)

### 最小请求样例

以下请求体用于固定夹具和预览。`101`、`102` 是示例素材 ID。首例对应 Sand Ark 国际站，次例对应 Sand 原生两地的保守交集。

```json
{
  "model": "magi-2",
  "content": [
    {"type": "image_url", "role": "first_frame", "image_url": {"url": "asset://101"}},
    {"type": "image_url", "role": "last_frame", "image_url": {"url": "asset://102"}}
  ],
  "duration": 5,
  "ratio": "16:9",
  "resolution": "1080p",
  "generate_audio": false
}
```

```json
{
  "model": "magi-2",
  "parts": [
    {"type": "text", "text": "镜头沿海岸缓慢推进，海浪逐渐盖过礁石。"},
    {"type": "reference_image", "image": {"assetId": "101"}}
  ],
  "duration": 5,
  "aspectRatio": "16:9",
  "resolution": "1080p"
}
```

## 3. AI Canvas 接入路径

**先采用 Sand Ark 覆盖画布主流程。** 它同时覆盖文生、普通参考和首尾帧，便于单个官方合同走通项目交付。使用 `GeneralModelConfig` 和专属厂商 manifest，连接绑定地区和合约版本，型号使用 `magi-2`。候选由本地已知合同提供，目录可见和组织有权调用分别标示。首轮文生走现有声明式生命周期。随后补齐按角色装配、空提示词、素材直传、端到端恢复，再加入原生合同和其他渠道。

| 位置 | 具体改动和验证 |
| --- | --- |
| `providerCatalogService.ts`、`providerPolicies.ts`、`providers/sandVideoContract.ts` | 注册中国／国际连接、Ark 合同与固定能力。设置提供只读协议预览及试跑，目录来自应用内已核对的模型清单。站点地址检查通过后，仍需用组织 Key 验证调用权限。 |
| `videoRequestResolver.ts`、`generateVideo.ts`、`modelProtocolVariables.ts` | 重用标准视频请求、参考素材、校验和持久任务入口。引入合同级角色和提示词必填规则，发布前统一验证设置试跑、节点和批量预检。当前 `seedanceContent` 按媒体类型分组并总会加文本项，Sand 需要可省略空文本、保留有效顺序和单独字段映射。火山原生构造会固定发送 `watermark: false`，Seedance 2.5 还会派生 `adaptive` 或 `-1`，这些值均由 Sand 合同独立处理。 |
| `referenceMediaPreparation.ts`、`nativeVideoSubmission.ts`、拟新增 Sand 直传适配器 | 依次做本地验证、源身份／执行租约核对、按组织串行或限并发上传、准备实际请求、再次核对后提交。复用原生文件范围校验和流式传输。保留获准的公网 HTTPS。上传后的 ID 在本连接内使用，按服务和组织绑定，与方舟 `asset://` 隔离。未知上传状态不盲目重投。清理独立于生成取消，在所有相关任务结束后才可删除上传素材。 |
| `modelProtocolRuntime.ts`、`nativeModelProtocolTask.ts`、`nativeProtocolRecovery.ts`、`nativeMediaResultPersistence.ts` | 保存意图后提交，把远端 ID 和原查询合同写入回执。实现顶层 `id` 身份校验和 Sand 原生错误中的 `details.generation_id` 提取。结果用不带 Key 的流式下载。签名过期按同 ID 更新再下载，成功无 URL 时保留回执并区分产物不可用。 |
| `generationService.ts`、`generationRuntime.ts`、`videoBatchPlanning.ts`、`videoEditorAiTransitionService.ts` | 画布和助手经同一次能力解析并保留权限语义。逐镜批量使用同一预检与组织级限流。剪辑 AI 转场单独验证两张指定关键帧和剪辑交付，素材顺序和已交付文件均须正确。 |

Sand 原生与 Ark 的创建、查询配额按组织共享，各 20 次／60 秒。素材上传另有 20 次／60 秒。默认最多 5 个并行生成，超出后在平台排队。单任务约每 10 秒查询，多任务错峰，5 个活动任务可按每任务 20 秒、组织每 4 秒一次的例子配置。查询 429、500、503 或网络错误有限退避并遵守返回的 `Retry-After`，同时设总预算。没有可信组织标识时可由用户指定同组织限流组，未合组时 429 仍应降速。Sand 创建无幂等保证。超时、丢响应、5xx 一律保留提交未知或已有任务 ID，用户暂停查询和远端取消分别显示。两套 API 的结果链接约一小时过期，同任务查询可以刷新。[官方限流](https://platform.sand.ai/docs/limits/) · [官方错误](https://platform.sand.ai/docs/errors/) · [原生结果](https://platform.sand.ai/docs/get-generation/) · [Ark 结果](https://platform.sand.ai/docs/ark-generations/)

## 4. 分步交付与验收

| 阶段 | 退出条件 | 回退 |
| --- | --- | --- |
| A · Ark 文生竖切 | 在两地区连接预览精确 URL、授权和字段。用回环 HTTP 夹具覆盖一次创建、查询状态、落盘、重启续查和国际站省略水印。真实账户使用 5 秒文生，在设置验证连接后由画布保存到项目并打开。 | 禁用新增合同的新提交。保留对已知任务的原合同查询和已有文件。 |
| B · Ark 素材与产品入口 | 文生、单首帧、首尾帧、单张普通参考图、图／视频／音频混合、仅音频分别通过预检。夹具覆盖资源 ID 超过 JS 安全整数、2／30 秒边界、11 张图／6 段视频／6 段音频、累计超限、尾帧缺首帧、空文本省略及静音仍传参考音频。测试在试跑、画布、助手、批次、转场中检查各自入口和项目交付。 | 关闭新素材入口和分发，仍能查原任务和已有素材登记。 |
| C · 原生与第二渠道 | 原生普通参考验证 `parts` 顺序、必填文本和地区水印。Higgsfield 独立连接先验文生和首尾帧，拿到完整多参 schema 再启用。BeatAPI 用于验证相同 `magi-2` 在另一连接使用不同长度、比例和幂等合同。 | 按连接或操作停用新提交，保留对应查询版本。 |

公共故障用例包括错 ID、未知状态、明确余额或鉴权拒绝、创建 5xx／断流、有 ID 的错误响应、429、签名 URL 过期、下载中断、切项目、Key 变更与重启。回环夹具记录上游请求数，确认同一 Sand 操作为一次创建。真实账户至少分别核实一条文生、一条首尾帧和一条含视频／音频的参考任务。验收时查看视频真实尺寸、时长、音轨和 `ffprobe` 可读取性，画布重开仍播放本机文件。初次真实调用应由用户选择有额度的站点和短时长，再验证边界时长与账户矩阵。

### 实施状态和桌面验收

- 画布、助手和批次复用共享视频请求。批次预检使用画布的连线素材识别，完整素材角色与数量在生成入口校验。设置试跑支持公开 HTTPS 引用，在创建前绑定凭据。剪辑采用两帧转场，原生项目将结果落入原项目账本。相同图片可分别担任首尾帧。国际站省略水印字段，中国站发送 `watermark: false`。
- 本地素材经 Rust 暂存并流式上传。每次上传一个文件，同时最多两个 Sand 暂存会话。Data URL 和 Blob 经分块 IPC，原生 HTTP 任务响应上限为 128 KiB。临时文件在上传结束、失败或取消时释放。WebView 仍会分配请求对象、预览和元数据，内存峰值及 GC 暂停需以桌面基准测量。已上传到 Sand 的远端素材仍按平台生命周期管理。
- Ark 创建无自动重放，查询按连接站点分开限速，轮询失败保留原任务回执。新回执绑定原连接、查询合同和 Key 的比较摘要。结果下载使用签名 URL，省略 API Key。当前限速按应用进程内的站点和操作实现，组织总额度仍由平台执行。
- 参考视频和音频在画布入口读取元数据校验时长。图片像素限制、远程素材的解码兼容性和设置试跑对远程素材的详细检查仍由厂商处理。
- Higgsfield、BeatAPI、Nereo 的同名模型各自保留连接、请求字段、鉴权和查询身份。BeatAPI 桌面上传使用 `/v1/files`，首尾帧按顺序写入 `images`，比例取首帧。BeatAPI 每个新生成请求附独立幂等键，查询仅用 GET。断流或 5xx 后保留回执，由原任务续查或由用户核对平台记录。Higgsfield、Nereo 使用已上传的公开 HTTPS 地址。
- 三个渠道均可在设置试跑时切换文生、首帧／首尾帧和普通参考。试跑查询会话仅保留到应用关闭或刷新。项目生成使用项目账本，Sand Ark 和 BeatAPI 的本地首尾帧还可用于剪辑转场。阶段关闭时停用连接中的模型选择，保留原连接及凭据用于续查。

离线验收从仓库根目录运行 `npm run test:typecheck`、`npm run lint`、`npm run build` 和 `npm test`。PR 分支通过类型检查、ESLint、生产构建及全量 Vitest（847 个文件、15,762 项）。Vite 报告部分模块同时被静态和动态导入的分包警告。同站点的其他自定义视频使用原协议续查，Sand 和中转站的冻结合同均校验原模型 ID。

Rust 验收在 Windows PR 工作树的 `src-tauri` 下运行。设置 `NO_PROXY` 让回环地址直连，`UI_SLICE_INTEROP_DIR` 指向包含 `payload/draft.zip` 的 PS‑Tidy 夹具目录，`UI_SLICE_INTEROP_SOURCE` 指向配套原图。`cargo test --locked --lib --features tauri-channel-tests -- --include-ignored --test-threads=1` 通过 686 项、跳过 0 项。`cargo check --locked --lib` 亦通过。176 MiB 压力用例验证固定 1 MiB 读缓冲复用、正式文件逐块内容和临时文件清理。文件传输遇到 `Interrupted` 时重新检查取消再读取。PS‑Tidy 原生 worker 回读 AI Canvas 导出的草稿，保留双环孔洞和待补项。

本轮一手合同补充 [Higgsfield 多参](https://open.higgsfield.ai/models/sand/magi-2/reference-to-video/api-reference)、[Higgsfield 查询](https://docs.higgsfield.ai/docs/api-reference/requests/get-request-status)、[BeatAPI 上传](https://docs.beatapi.io/quick-guide#upload-an-input-file)、[Nereo 提交](https://api.nereo.io/docs/api-reference/submit-request)和[Nereo 查询](https://api.nereo.io/docs/api-reference/get-request-status)。

桌面验收从「设置 → API Key」选择 Sand 地区连接，填写本站 Key，载入 MAGI‑2 后打开只读调用协议。先核对文生请求，随后在项目画布用 5 秒文生得到可打开的 MP4。继续验证同图首尾帧、仅音频、多参考、节点与剪辑归属。查询途中取消或切换项目，回到原节点续查应命中原任务并落盘。更换 Key 后应暂停续查，恢复原 Key 后可继续。模拟断网或网关错误时检查账本是否保留提交未知，再确认平台没有重复创建。两地分别验收付费权限及实际输出参数。

### 原生 v2 交付与回滚

- 在「设置 → API Key」新增对应地区的「原生 v2」连接。预览检查创建路径 `/v2/generations`、`parts`、`aspectRatio` 和 `generateAudio`。两地各验收文生、带公开 HTTPS 参考、带本地上传素材三种任务。4–30 整秒和六种比例为首版应用提供的范围，实际组合由组织模型合同决定。
- 使用 Ark 已配置的首尾帧切到 v2。参考列表应保留原角色，用户明确改成普通参考图后才可生成。剪辑转场的 Sand 模型选项只列出 Ark 连接。设置试跑的 v2 场景提供文生和普通参考。
- 用离线夹具分开验证 202、错误中携带的 `details.generation_id`、未知提交、错 ID、无效状态和跨协议恢复。对无签名结果、签名过期、切换连接或更换 Key 的既有任务，确认能回到原任务续查，始终不创建新任务。
- v2 复用站点级创建、查询和上传限流，复用定长分块素材 I/O、128 KiB 任务响应上限及清理策略。Rust 代理对两套官方任务路径均禁止重定向和自动重放。WebView、JSON 和 IPC 有托管分配。桌面基准记录 RSS、WebView 堆峰值及 GC 暂停，并在取消和重试后核对暂存目录。
- 暂停 v2 新任务时，在原连接取消启用模型，保留连接、原 Key、查询版本与回执，核对原任务后再清理。安装旧版本前先保存 v2 结果。旧版本可能没有原生 v2 查询合同，线上任务仍可在对应 Sand 站点用原组织身份核对。

### 内存与生命周期验收

在同一台桌面机录制四组场景，每组连续跑三次。分别使用文生、单个大视频参考、两路并发本地上传和查询中切项目。记录 WebView 和 Rust 进程 RSS、WebView JS 堆峰值及 GC 暂停、上传吞吐、取消到临时文件释放时间、远端创建次数及本地文件校验。对照相同素材的小文件和大文件，检查本地路径上传的 JS 堆峰值是否随文件大小增长。大型素材优先使用项目本地路径，二进制由 Rust 流式读写。内联素材仍由 WebView 持有并分块传输。任务 JSON 在两端都限制为 128 KiB。当前资源采用预算和生命周期控制，桌面实测前缺少全链路 0GC 数据。

### 改动清单

| 范围 | 文件与行为 |
| --- | --- |
| 厂商合同与能力 | `src/services/ai/providers/sandVideoContract.ts` 定义模型、地区和角色映射。`src/services/ai/providers/sandRateLimit.ts` 管理各站点的请求间隔。`src/services/ai/providerCatalogService.ts`、`src/services/ai/providerPolicies.ts` 和 `src/services/ai/videoModelCapabilityResolver.ts` 注册模型目录和固定能力。 |
| 设置 | `src/components/settings/ModelProtocolEditor.tsx`、`src/components/settings/providerConnection/ProviderModelSection.tsx` 显示固定协议。 `src/components/settings/modelProtocol/useProtocolTrial.ts`、`src/components/settings/modelProtocolTestRun.ts`、`src/services/ai/modelProtocolTestSession.ts` 和 `src/services/testConnection.ts` 处理预览、试跑、续查和站点检查。 |
| 视频与素材 | `src/services/ai/generateVideo.ts`、`src/services/ai/connectedReferenceMedia.ts` 和 `src/services/videoBatchPlanning.ts` 接入共享参数与参考素材。`src/services/ai/providers/sandAssetUpload.ts`、`src/services/ai/providers/relayonVideoUpload.ts` 和 `src-tauri/src/media/relayon_video_upload.rs` 暂存及上传本地素材。 |
| 协议与查询 | `src/services/ai/modelProtocol.ts`、`src/services/ai/modelProtocolHttp.ts`、`src/services/ai/modelProtocolPoll.ts`、`src/services/ai/modelProtocolRuntime.ts`、`src/services/ai/modelProtocolVariables.ts` 和 `src-tauri/src/network/proxy.rs` 处理一次性提交、响应校验和查询。 |
| 恢复与剪辑 | `src/services/ai/polling/pendingTaskLedger.ts`、`src/services/ai/polling/providerTaskRecovery.ts`、`src/services/nativeProtocolRecovery.ts`、`src/services/nativeVolcengineRecovery.ts`、`src/services/indexedDb/nativeEditorMediaTaskRepository.ts`、`src/services/nativeEditorTransitionService.ts` 和 `src/services/videoEditorAiTransitionService.ts` 保存或恢复原任务。 |
| 用例与文档 | `tests/services/sandVideoContract.test.ts`、`src-tauri/src/network/proxy_tests.rs` 覆盖合同和传输边界。`doc/模型与生成模块.md`、`doc/plans/计划索引.md`、本方案与视频模型通用适配方案记录入口、实施范围和验收。 |
| v2 能力与界面增量 | `src/types/aiTypes.ts` 与 `src/services/ai/videoRequestResolver.ts` 声明并校验关键帧能力。`src/components/nodes/shared/VideoParamSelector.tsx` 与 `src/components/settings/ModelProtocolEditor.tsx` 按合同呈现素材角色及试跑场景。 |

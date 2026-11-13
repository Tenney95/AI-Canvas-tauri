# 火山方舟私有 TOS 参考素材上传

状态：已实现，待用户验证。**本次未运行测试，待用户验收**；未执行类型检查、lint、Rust 检查、构建、桌面操作、真实上传或媒体生成。

## 范围与依据

用户要求火山官方本地参考素材改用自己的上传能力。依据[方舟内网 TOS 预签名流程](https://docs.volcengine.com/docs/ark/upload-files-via-tos-internal-presigned-url?lang=zh)，用户需创建北京区域的私有 Bucket，提供有对应对象 PutObject/GetObject 权限的独立 AK/SK；方舟 API Key 不等于 TOS 凭据。

## 架构决策

- 采用原生固定目的端 TOS 上传，而非 Renderer 通用代理或公共图床。桌面 PUT 到 `bucket.tos-cn-beijing.volces.com`，成功后对同一随机对象重新签名 `bucket.tos-cn-beijing.ivolces.com` 的 GET URL。仅发给北京官方方舟接口；不将其交给第三方厂商或私域素材入库。
- 使用已有 reqwest、sha2、base64 与路径授权设施，不引入 SDK 或扩大通用代理请求体。大文件由原生文件句柄流式上传；视频路径上限 200 MB，图片/音频沿用 32 MiB 应用传输预算，内联素材解码上限 32 MiB。此预算不替代具体模型或 CreateAsset 的更严格限制。
- TOS4 签名按官方协议独立实现，不套用 AWS4 或 Ark OpenAPI 签名器。公网 PUT 与内网 GET 的 host/方法分别参与签名；GET 有效期 6 小时，现有 2.5 小时缓存仅存内存。无公开读 ACL、不自动创建桶、不自动重传或切换图床。
- AK/SK 作为一个不可变 bundle 写入 Rust 凭据存储；连接普通配置仅有 Bucket、固定 region 与 `secret:provider/volcengine/tos/<uuid>` 引用。取消草稿不写入，保存失败保留新引用供重试，保存成功后才清理不再使用的旧引用。不借用模型 Key 或虚拟人像库凭据。
- 原生命令仅主窗口调用，固定北京 TOS 目的端，路径先经 `path_policy` 授权并固定普通文件句柄。上传前与发送正文分别计算固定 256 KiB 链指纹，复核来源、长度、修改状态与取消。前端沿用串行上传、120 秒总超时、取消及配置守卫，底层未结算时不释放执行槽。
- 对输入中带本地副本的方舟引用优先使用本地源，避免旧公共图床链接盖过文件。用户显式给出的已有 HTTP(S) 素材仍原样引用。模型参考只发送 URL，不把本地 Base64 送给方舟。
- 方舟提交及任务查询按敏感请求处理；上游错误若回显 TOS 预签名 URL，在进入生成错误、节点或历史前整体脱敏。账本继续沿用现有固定错误分类。

入口：`volcengineTos.rs`、`volcengineTosUpload.ts`、`volcengineTosConfigService.ts`、`VolcengineTosSettings.tsx`、`ProviderConnectionDialog.tsx`、`providerPolicies.ts` 与 `uploadService.ts`；原生注册与精确 ACL 位于 `lib.rs`、`permissions/volcengine-tos.toml` 和仅主窗口的 capability。

## 私域素材入库边界

用户补充的以下限制属于 [CreateAsset API](https://docs.volcengine.com/docs/ark/create-asset-api?lang=zh)，与[私域虚拟人像库](https://docs.volcengine.com/docs/ark/private-virtual-avatar-library-guide-preview?lang=zh)的资产组、异步入库、Active 状态及权限要求一起生效，不普遍套用于 TOS PutObject 或 Seedream 参考图：

| 素材 | CreateAsset 格式与约束 |
|---|---|
| 图片 | jpeg、png、webp、tiff、gif、heic/heif；宽高比 `(0.4, 2.5)`，宽高均 `(300, 6000)` px，单张 `<30 MB` |
| 视频 | mp4、mov；480p/720p/1080p/4K，时长 `[2,30]` s；比例 `[0.4,2.5]`，宽高均 `[300,6000]` px，总像素 `[407696,8295044]`，`≤200 MB`，FPS `[24,60]` |
| 音频 | wav、mp3；时长 `[2,30]` s，`≤15 MB` |

现有素材库继续接受公网 URL，不接收 Base64、本地 URI 或上述 TOS 内网 URL；公网签名参数保留原编码，敏感请求与错误不反射完整 URL、正文或凭据。本次不自动 CreateAsset，也不为远端 URL 下载整份素材以推断元数据；实际入库规格仍由官方 API 检查，只有 Active 资产可以继续推理。

## 桌面验收

前置：在火山控制台创建 cn-beijing 私有 TOS 桶，准备只对目标前缀有 PutObject/GetObject 权限的 AK/SK，已有可用方舟模型 Key。存储对象位于 `ai-canvas/ark-reference/`，用户应按自己的保留需求设置生命周期；预签名到期不会删除远端对象。

1. 设置 → API Key → 编辑火山方舟：填写 Bucket 和独立 AK/SK，保存并重启，确认引用保留、密钥输入框不回显明文。取消编辑不得写入；只更新一项密钥或填非北京配置应拒绝。缺 TOS 配置时，无参考或已有公网素材仍可用，本地参考应提示配置并在模型提交前停止。
2. 将全局图床设成其他服务，给火山图片/视频模型引用本地图片、视频、音频。预期仅有北京 TOS 公网 PUT，再将同对象的内网签名 URL 交给方舟；不调用 ImgBB/Uguu 等，不向模型发送 Base64。已有本地副本的节点引用也应使用本地文件。大视频使用原生路径，不能把 200 MB Base64 送入 IPC。
3. 同一素材在 2.5 小时内可复用内存缓存；普通上传 localStorage 不应出现 TOS 签名参数。切 Bucket/凭据引用后重新上传；上传中切配置、取消、源文件变化、权限拒绝或网络超时均停止，不采用迟到结果，不换服务重传，不发起后续生成。
4. 用大于 32 MiB 的实际视频文件核对原生路径上传，并按具体模型文档选合规时长/分辨率；检查错误格式、空文件、超限文件、缺失凭据、AK/SK 权限不足。内网 URL 设计上不能在桌面浏览器直接预览，不将浏览器不可访问误判上传失败。
5. 虚拟人像库仍使用自己的 AK/SK 与公网 URL 入库；Base64/本地 URI/TOS 内网 URL 应在网络前拒绝，远端处理 Failed/Processing 不可当 Active。回归其他厂商上传、全局图床、同名自定义连接隔离、设置深浅主题、键盘与窄窗口。

用户可在仓库根目录运行 `npx vitest run tests/services/volcengineTosConfigService.test.ts tests/services/volcengineTosUpload.test.ts tests/services/volcengineAssetLibrary.test.ts tests/services/volcengineError.test.ts tests/services/volcengineImage.test.ts tests/services/volcengineVideoQuery.test.ts tests/services/generateVideo.test.ts tests/services/providerPolicies.test.ts tests/services/referenceImageTransport.test.ts tests/components/providerConnectionDraftGuard.test.tsx`；Rust 单元测试入口为 `src-tauri` 下 `cargo test volcengine_tos::tests`。上述命令本轮均未执行，原生编译与实机链路没有验证结论。

## 回滚

撤销本批 TOS 源码、配置入口与精确命令权限即可，无数据库版本变化。用户已上传的对象和凭据不会自动删除；未删除的 TOS 配置会被旧版忽略。私有对象保留与费用由用户自己的 TOS 桶管理，回滚不会公开对象或批量清桶。

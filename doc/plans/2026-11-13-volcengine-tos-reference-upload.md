# 火山方舟私有 TOS 参考素材上传

状态：已实现，待用户验证。**本次未运行测试，待用户验收**；未执行类型检查、lint、Rust 检查、构建、桌面操作、真实上传或媒体生成。

## 范围与依据

2026-11-16 用户进一步要求火山官方所有参考素材共用 TOS，包含外部素材 URL 与人像库上传。依据[方舟内网 TOS 预签名流程](https://docs.volcengine.com/docs/ark/upload-files-via-tos-internal-presigned-url?lang=zh)，用户需创建北京区域的私有 Bucket，提供有对应对象 PutObject/GetObject 权限的独立 AK/SK；方舟 API Key 不等于 TOS 凭据。

## 架构决策

- 采用原生固定目的端 TOS 上传。桌面 PUT 到 `bucket.tos-cn-beijing.volces.com`；生成参考使用 `reference` 用途，独立签发同对象 `bucket.tos-cn-beijing.ivolces.com` 的 GET URL。仅真实火山目录连接使用这条链路，同名自定义中转连接不继承。
- 图片/视频/音频生成、文本视觉和助手图片在已有协议支持参考素材的范围内统一路由。直接厂商与通用模型均以实际连接 ID 判定；已有 HTTP(S) 素材也先转存 TOS，模型不接收原始外部 URL 或 Base64。仅构造发送副本，不把签名链接改写回节点、聊天或持久化引用。`asset://<Asset ID>` 继续作为官方入库素材引用，不重新上传。
- 人像库选择本地文件或输入 URL 后，使用同一 TOS 配置的 `asset-ingestion` 用途，独立签发**公网 GET** 再调用 CreateAsset。公网和内网 host/方法分别参与 TOS4 签名，禁止直接替换域名。此选择避免假定 CreateAsset 能访问推理专用内网地址；官方资料未证明它明确禁止该地址。
- 使用已有 reqwest、sha2、base64 与路径授权设施，不引入 SDK 或扩大通用代理请求体。本地大文件由原生句柄流式上传；外部来源仅接受无用户凭据的标准端口 HTTP(S)，复核公网 DNS/IP 并固定解析地址，不带 TOS/方舟鉴权、不跟随重定向。下载写入应用原生私有临时文件，Unix 立即 unlink、Windows 关闭句柄时删除，取消或失败也回收；不在 Renderer 转成大份 Base64。
- 当前桶中符合应用随机命名规则的已有 TOS 对象，使用独立签名的公网 HEAD 复核存在及体积，然后按用途重签 GET；不从桌面下载内网 URL，也不重复 PUT。其他公开来源按普通导入处理，不替用户签发任意路径。
- GET 有效期 6 小时，普通上传的 2.5 小时缓存仅存内存；入库签名只随本次请求使用。无公开读 ACL、不自动创建桶、不自动重传或切换图床。签名过期不会删除对象，也不保证覆盖所有上游入库排队时间，实际入库需桌面验证。
- AK/SK 作为一个不可变 bundle 写入 Rust 凭据存储；连接普通配置仅有 Bucket、固定 region 与 `secret:provider/volcengine/tos/<uuid>` 引用。取消草稿不写入，保存失败保留新引用供重试，保存成功后才清理不再使用的旧引用。不借用模型 Key 或虚拟人像库凭据。
- 原生命令仅主窗口调用，固定北京 TOS 目的端，路径先经 `path_policy` 授权并固定普通文件句柄。上传前与发送正文分别计算固定 256 KiB 链指纹，复核来源、长度、修改状态与取消。前端沿用串行上传、120 秒总超时、取消及配置守卫，底层未结算时不释放执行槽。
- 对输入中带本地副本的方舟引用优先使用本地源，避免旧公共图床链接盖过文件。生成参考仍按图片/音频 32 MiB、视频 200 MB 的应用上传预算；内联素材保持 32 MiB IPC 上限。入库用途进一步执行下表中的体积上限，格式按文件头识别；尺寸、比例、时长及 FPS 仍由官方 API 检查，未新增解码探测器。
- 普通无变换的远端参考直接交原生导入；蒙版/标注、角色多图合并、分镜裁剪仍沿用既有图像合成流程。没有本地副本时，这些处理可能先由 Renderer 读取远端图片，处理结果再进入 TOS，不承诺所有合成路径都没有前端读取。
- 方舟提交及任务查询按敏感请求处理；上游错误若回显 TOS 预签名 URL，在进入生成错误、节点或历史前整体脱敏。账本继续沿用现有固定错误分类。

入口：`volcengineTos.rs`、`volcengineTosUpload.ts`、`volcengineAssetUpload.ts`、`volcengineTosConfigService.ts`、`VolcengineTosSettings.tsx`、`VolcengineAssetLibraryPanel.tsx`、`providerPolicies.ts`、`uploadService.ts`，以及媒体/文本/助手生成入口；原生注册与精确 ACL 位于 `lib.rs`、`permissions/volcengine-tos.toml` 和仅主窗口的 capability。TOS 配置说明与下方人像库留出间距，并提供与厂商控制台相同样式的「前往获取 AK/SK」，固定导航到[火山访问密钥管理](https://console.volcengine.com/iam/keymanage/)。

2026-11-16 用户最终要求 TOS AK/SK 保存后不可再次查看。设置界面不读取已保存的真实凭据，只根据专用引用显示固定长度的密码掩码，移除查看/隐藏按钮；掩码属于界面隐藏，存储继续沿用普通 API Key 的 Rust 凭据存储，未新增磁盘加密。聚焦空草稿时进入替换输入，未填写而离焦时恢复掩码；聚焦、离焦及未修改保存均不写入假掩码、不产生凭据修改或轮换引用。更新须重新填写完整 AK/SK，保存换引用、清除配置或关闭面板时卸载对应字段并清空界面草稿；原生上传仍按引用取用已保存凭据。

## 私域素材入库边界

用户补充的以下限制属于 [CreateAsset API](https://docs.volcengine.com/docs/ark/create-asset-api?lang=zh)，与[私域虚拟人像库](https://docs.volcengine.com/docs/ark/private-virtual-avatar-library-guide-preview?lang=zh)的资产组、异步入库、Active 状态及权限要求一起生效，不普遍套用于 TOS PutObject 或 Seedream 参考图：

| 素材 | CreateAsset 格式与约束 |
|---|---|
| 图片 | jpeg、png、webp、tiff、gif、heic/heif；宽高比 `(0.4, 2.5)`，宽高均 `(300, 6000)` px，单张 `<30 MB` |
| 视频 | mp4、mov；480p/720p/1080p/4K，时长 `[2,30]` s；比例 `[0.4,2.5]`，宽高均 `[300,6000]` px，总像素 `[407696,8295044]`，`≤200 MB`，FPS `[24,60]` |
| 音频 | wav、mp3；时长 `[2,30]` s，`≤15 MB` |

面板新增本地文件/URL 来源选择和明确的图片/视频/音频类型；无后缀 URL 由用户选择类型。`volcengineAssetUpload.ts` 先复核真实火山连接、北京 TOS、独立启用的素材库 AK/SK、项目与官方入库端点，再上传并仅提交一次 CreateAsset。通用 `createAsset` 协议层仍只接收公网 HTTP(S) URL，不直接接受 Base64、本地 URI 或 TOS 内网 URL；转换由上层编排负责。公网签名参数保留原编码，敏感请求与错误不反射完整 URL、正文或凭据。

提交前后复核取消和配置快照，签名等待后、实际网络发送前再次检查。配置变化不继续提交或把迟到成功当作当前配置结果；若已发送 CreateAsset，提示先检查原素材库避免重复提交。收到素材 ID 只显示「已提交、正在处理」，不视作 Active；入库失败不自动重投。TOS 设置本身不会自动为每次普通生成创建素材资产。

## 桌面验收

前置：在火山控制台创建 cn-beijing 私有 TOS 桶，准备只对目标前缀有 PutObject/GetObject 权限的 AK/SK，已有可用方舟模型 Key。存储对象位于 `ai-canvas/ark-reference/`，用户应按自己的保留需求设置生命周期；预签名到期不会删除远端对象。

1. 设置 → API Key → 编辑火山方舟：确认 AK/SK 输入与说明、TOS 与下方人像库之间有间距；「前往获取 AK/SK」打开官方访问密钥页。填写 Bucket 和独立 AK/SK，保存并重启：两项显示固定密码掩码，没有查看入口；聚焦只出现空替换输入，不显示旧密钥，空白离焦恢复掩码。仅切换焦点后取消不应提示未保存修改，直接保存沿用旧引用，假掩码不得写入凭据。更新只填一项应拒绝，两项均重填才保存新凭据；取消编辑保留原凭据。清除配置后再保存才删除连接引用，取消清除不改原凭据。非北京配置应拒绝。缺 TOS 时，无参考生成保持可用，所有本地/外部 URL 参考在模型提交前提示配置并停止。
2. 将全局图床设成其他服务，分别以本地与外部 URL 给火山图片/视频模型提供图片、视频、音频，再核对通用火山模型、文本视觉和助手的 `@` 图片/直接附件。预期外部来源由原生下载，再经北京 TOS 公网 PUT，模型只接收内网 GET URL；不走公共图床，不发送 Base64。已有本地副本仍使用本地文件；官方 Asset ID 保留。
3. 同一素材在 2.5 小时内可复用内存缓存；已有本桶应用对象用 HEAD+重签而不重复上传。localStorage、节点/聊天、任务错误中不应出现 TOS 签名参数。切 Bucket/凭据引用后不用旧缓存；上传中切配置、取消、源文件变化、权限拒绝或超时均停止，不采用迟到结果，不换服务重传，不发起后续生成。
4. 用大于 32 MiB 的合规视频核对原生路径与外部 URL 上传。检查空/超限/错误格式、缺失凭据和权限不足；外部来源的私网地址、凭据 URL、非标准端口、重定向均拒绝。内网 URL 不能由桌面浏览器直接预览，不据此判断上传失败。
5. 启用人像库并配置其独立 AK/SK，进入资产侧栏 → 方舟素材库 → 上传素材：本地文件和 URL 的图片/视频/音频先共用 TOS，再以独立公网 GET 提交一次 CreateAsset；无后缀 URL 必须选类型。缺 TOS/人像库配置时阻止提交。Processing/Failed 不可当 Active；提交中切项目/桶/凭据或取消时检查不会重投，也不会覆盖当前配置列表。
6. 回归其他厂商上传、全局图床、同名自定义连接隔离、角色 Asset ID 引用，以及设置的深浅主题、键盘与窄窗口。确认没有新增模型本身未声明的参考能力。

用户可在仓库根目录运行 `npx vitest run tests/services/volcengineTosConfigService.test.ts tests/services/volcengineTosUpload.test.ts tests/services/volcengineAssetUpload.test.ts tests/services/volcengineAssetLibrary.test.ts tests/services/volcengineAudioReferenceTransport.test.ts tests/services/volcengineError.test.ts tests/services/referenceImageTransport.test.ts tests/services/modelProtocol.test.ts tests/components/volcengineTosUi.test.tsx`；Rust 单元测试入口为 `src-tauri` 下 `cargo test volcengine_tos::tests`。较广回归还包括生成、助手协议、聊天引用和 Provider 策略测试。上述命令本轮均未执行，原生编译与实机链路没有验证结论。

## 回滚

本次扩展无数据库版本变化；撤销统一路由、原生导入/用途、入库编排及 UI 补丁即可回到此前只上传本地生成参考的行为。用户已上传的对象、已受理的入库任务与凭据不会自动删除；对象保留与费用由用户自己的 TOS 桶管理，回滚不会公开对象或批量清桶。

# 生图、生视频模型适配：80 项证据与比较

采样：2026-11-18。配套：[代码审查与实施设计](./2026-11-18-media-model-compatibility.md)。本研究针对模型能力发现、参数差异、媒体任务和创作体验；外部配置接管另见[外部管理研究](./2026-11-18-provider-management-research.md)。

每组 20 个样本。A 为专项开源实现，B 为另选的高星仓库（门槛 10,000，数字取采样日 GitHub 仓库页面的计数，仅表示热度）；C 为 20 个不同采用方，由供应商与客户署名的发布材料呈现，不作为独立审计；D 为 20 个可访问的 Web 服务或平台，观察公开界面帮助和 API 合同，未登录、未执行生成或付费调用。各组比较的是不同对象，同一生态可横跨多组，例如 fal 客户端、商业客户和线上平台。下表最后一栏是对 Canvas 的推论。没公开的内部实现一律不推断；未用供应商延迟、吞吐、可靠率或商业结果作为 Canvas 基线。

## A · 专项开源实现（20）

| ID | 实现 / 一手来源 | 观察到的机制 | Canvas 对照 |
|---|---|---|---|
| A01 | [Bifrost](https://github.com/maximhq/bifrost) | 以网关统一访问上游，集中配置凭据、负载与回退。 | 可以接现有网关；保留供应商与账户身份，媒体任务一旦提交就不能换路。 |
| A02 | [Portkey Gateway](https://github.com/Portkey-AI/gateway) | 在网关管理上游选择、重试和可观测性。 | 一次请求只由一层主导重试；客户端不能默认重发网关中的计费生成。 |
| A03 | [TensorZero](https://github.com/tensorzero/tensorzero) | 配置推理变体，并将观测、评估、实验和调用整合。 | 分开合同测试与输出质量评估；模型换版涉及真实结果差异。 |
| A04 | [Hugging Face JS](https://github.com/huggingface/huggingface.js) | Hub 与 Inference 有独立包；推理 SDK 覆盖文字、视觉等任务。 | 发现和执行分别版本化；能列出模型不代表当前连接能执行该操作。 |
| A05 | [Cog](https://github.com/replicate/cog) | 从 Python 输入输出声明生成 OpenAPI 并校验请求。 | 优先导入机器可读 schema；外部 schema 无权带入执行代码、凭据或受信域。 |
| A06 | [Replicate JS](https://github.com/replicate/replicate-javascript) | 同时提供便捷执行和显式 prediction 创建、等待与结果操作。 | Canvas 的便捷调用也要公开可复用回执；停在等待阶段可续查。 |
| A07 | [fal JS](https://github.com/fal-ai/fal-js) | SDK 提供队列提交、等待查询和取得结果，接口按 endpoint 寻址。 | 一套队列协议覆盖一组模型，具体输入从 endpoint 合同读取。 |
| A08 | [SwarmUI](https://github.com/mcmonkeyprojects/SwarmUI) | 统一创作前端，可接 ComfyUI 和其他后端。 | 画布保持一套工作流程，局部强项由后端能力决定；可达性与适配成功分开。 |
| A09 | [BentoML](https://github.com/bentoml/BentoML) | 可将推理服务、多模型流水线和异步任务部署成服务。 | 客户端统一生命周期；本地编排与远端执行不必共享同一个业务 API。 |
| A10 | [KServe](https://github.com/kserve/kserve) | 自托管推理在统一部署框架下拥有不同 serving runtime。 | 协议族分开注册；部署框架相同不能证明生图/生视频字段相同。 |
| A11 | [Modal 客户端](https://github.com/modal-labs/modal-client) | 云函数客户端支持派发异步函数调用和访问调用句柄。 | 把远端句柄当成一等数据；不要依赖窗口内存保存恢复信息。 |
| A12 | [Inngest](https://github.com/inngest/inngest) | 使用可持久化步骤组织重试和工作流。 | 分别登记提交、取得产物、写入项目；只重试能安全重做的步骤。 |
| A13 | [OpenTelemetry Rust](https://github.com/open-telemetry/opentelemetry-rust) | 将追踪、指标和日志事件放入标准 API。 | 用固定阶段、分类与耗时诊断；默认不采集提示词、Key 与 URL 签名。 |
| A14 | [Loom](https://github.com/tokio-rs/loom) | 枚举缩小后的并发调度模型。 | 用小状态模型检查两个窗口竞争、迟到完成和撤权交错；不能替代整机测试。 |
| A15 | [SQLite](https://www.sqlite.org/lang_transaction.html) | 多读者和单写者事务，对写冲突有明确语义。 | 现有权威事务存储先做条件写入；若迁到 Rust 再在选定的同一存储建立状态机。 |
| A16 | [Pydantic](https://pydantic.dev/docs/validation/latest/concepts/json_schema/) | 可从类型导出验证或序列化 JSON Schema。 | 一份规则驱动表单、预检与夹具，标明单向转换无法表达的条件约束。 |
| A17 | [Bytes](https://docs.rs/bytes/latest/bytes/struct.Bytes.html) | 可共享、切片底层字节缓冲，生命周期由持有者决定。 | 原生端按实际被保留容量计费，避免小视图长期占住大素材。 |
| A18 | [ControlNet](https://github.com/lllyasviel/ControlNet) | 边缘、姿势、深度等结构条件有不同输入语义。 | 把参考图角色作为显式字段；用户不能用任意一张图片自动覆盖关键帧或掩膜。 |
| A19 | [Submitit](https://github.com/facebookincubator/submitit) | 给本地或 Slurm 作业提供作业句柄、结果取得和检查点接口。 | 工作流和远端模型共享“作业”概念；各运行时自行提供恢复语义。 |
| A20 | [MCP 规范](https://github.com/modelcontextprotocol/modelcontextprotocol) | 初始化交换协议版本与能力，由服务端列出可用项。 | 复用“声明能力与版本”的模式；模型清单无权发布任意宿主工具。 |

A01–A10 覆盖从协议归一到运行器分流；A11–A17 对应句柄、阶段持久化、审计和内存；A18–A20 说明媒体输入角色与默认权限应独立表达。选择小协议族加清单比每个模型拉一个 SDK 更容易共享这些机制。

## B · 高星项目（20）

| ID | 仓库 | Stars | 观察到的机制 | Canvas 对照 |
|---|---|---:|---|---|
| B01 | [ComfyUI](https://github.com/Comfy-Org/ComfyUI) · [服务路由](https://docs.comfy.org/development/comfyui-server/comms_routes) | 147,446 | 节点定义、队列、history、WebSocket 各有接口。 | 用图定义发现输入、WS 提示进度、history 核对结果；工作流保留独立适配器。 |
| B02 | [Diffusers](https://github.com/huggingface/diffusers) | 34,938 | 共享 pipeline 与部件，不同架构有专用 pipeline 和条件输入。 | 相似模型复用同一合同内核；差异由操作和角色表达。 |
| B03 | [InvokeAI](https://github.com/invoke-ai/InvokeAI) | 29,116 | 创作 UI、模型管理与生成工作流分离。 | 同一模型可在专业节点和轻量交互复用；把高级选项按操作折叠。 |
| B04 | [Krita AI Diffusion](https://github.com/Acly/krita-ai-diffusion) | 10,915 | 创作者在画布内改图；后端设定与笔刷式交互各有职责。 | 保留在画布里的快速迭代；参考图选择和请求组装由不同层处理。 |
| B05 | [Stable Diffusion WebUI](https://github.com/AUTOMATIC1111/stable-diffusion-webui) | 165,334 | 文生图、图生图和扩展有不同参数面板/执行路径。 | 按操作定义可见参数；扩展能力不应自动成为通用默认项。 |
| B06 | [Fooocus](https://github.com/lllyasviel/Fooocus) | 53,949 | 将生成默认值和复杂控制封装成更直接的提示词体验。 | 大多数用户能用有效默认值立即生成，同时可查看实际提交值。 |
| B07 | [SD WebUI Forge](https://github.com/lllyasviel/stable-diffusion-webui-forge) | 13,140 | 在既有 UI 基础上重做底层生成和显存调度。 | 体验和调度分别演进；性能收益需在相同任务与硬件上测。 |
| B08 | [LiteLLM](https://github.com/BerriAI/litellm) · [图像合同](https://docs.litellm.ai/docs/image_generation) | 63,474 | 统一请求格式，图像仍列明支持参数和供应商差异。 | “OpenAI 兼容”只说明信封；不自动填造可选字段与能力。 |
| B09 | [Vercel AI SDK](https://github.com/vercel/ai) · [视频生成](https://ai-sdk.dev/docs/ai-sdk-core/video-generation) | 28,064 | 通用图像/视频操作保留 providerOptions、seed 和取消接口。 | 允许受 schema 约束的高级选项；批量拆单须显式反馈费用和任务数。 |
| B10 | [LangChain](https://github.com/langchain-ai/langchain) · [模型文档](https://docs.langchain.com/oss/python/langchain/models) | 149,839 | 共享模型接口和消息格式，仍依赖不同供应商实现。 | 会话保存本地消息和媒体引用，多轮协议能力单独建模。 |
| B11 | [Open WebUI](https://github.com/open-webui/open-webui) | 159,001 | 一个会话界面连接本地或兼容服务，配置层区分连接。 | 聊天切模型保留会话草稿，新请求显式重新验证上下文；已发起作业保持原连接。 |
| B12 | [LobeHub](https://github.com/lobehub/lobehub) | 85,752 | 多供应商模型与对话/Agent 共用工作空间。 | 目录更新和会话状态分离；用户看到实际模型来源。 |
| B13 | [LibreChat](https://github.com/LibreChat-AI/LibreChat) | 47,313 | 对话应用连接原生和自定义端点。 | 端点模板降低接入成本，仍按连接保存选择，不全局按 model slug 合并。 |
| B14 | [Cherry Studio](https://github.com/CherryHQ/cherry-studio) | 53,623 | 桌面工作区在同一聊天中提供多个 API 供应商。 | 连接设置、会话中的模型切换和任务动作分别表达。 |
| B15 | [Ollama](https://github.com/ollama/ollama) | 187,501 | 本机模型管理和 API 由服务暴露。 | 本地发现结果有本地连接身份；本地可达性不赋予云凭据转发权限。 |
| B16 | [vLLM](https://github.com/vllm-project/vllm) | 97,146 | 推理服务内部做批处理和内存优化。 | Canvas 只负责有界排队和保活，不能据服务端吞吐估计客户端尾延迟。 |
| B17 | [llama.cpp](https://github.com/ggml-org/llama.cpp) | 135,609 | 不同本地构建、模型和模板可共享兼容服务接口。 | 兼容入口应有能力和版本协商，能连接不等于工具、媒体和流都支持。 |
| B18 | [Tauri](https://github.com/tauri-apps/tauri) | 112,994 | WebView 与 Rust 宿主通过显式桥接连接。 | UI 保留 React；必要时把大型素材 I/O 和权限留在原生层，IPC 用句柄。 |
| B19 | [Temporal](https://github.com/temporalio/temporal) · [执行](https://docs.temporal.io/workflow-execution) | 24,470 | 持久化历史，工作流与执行有副作用的活动分离。 | 模仿状态和副作用隔离；不引入服务集群，也不能替不支持幂等的上游提供保证。 |
| B20 | [Airflow](https://github.com/apache/airflow) | 47,526 | DAG 的任务有持久状态、重试与运维视图。 | 工作流节点显示阶段及可恢复动作；单个生成任务不需要 DAG 调度器。 |

B01–B07 最接近创作体验；B08–B17 验证共享 API 可缩减接入成本，却需要明确差异。B18–B20 为本地原生分工及持久化抽象的对照。星数不能证明安全性、性能或适用性。

## C · 具名商业案例（20）

| ID | 采用方 / 一手案例 | 公布的做法 | Canvas 对照与限度 |
|---|---|---|---|
| C01 | [Quora / Poe](https://fal.ai/customer-case/customer-highlights) | Poe 将许多图像和视频消息接入 fal 推理。 | 在对话中直接迭代媒体；案例未公开 Poe 的回执持久化或路由实现。 |
| C02 | [Genspark](https://fal.ai/customer-case/genspark) | 代理系统把图像、视频生成作为子能力接入。 | 多轮上下文属于调用方，生成能力可单独演进。 |
| C03 | [Bria](https://fal.ai/customer-case/bria) | 企业推理基础设施与公开模型目录并存，以 endpoint 发布模型。 | 兼容云目录与自建连接；同模型不同连接保持独立合同。 |
| C04 | [VEED](https://fal.ai/customer-case/veed) | 编辑器运行的模型也在公开目录以独立操作和 API 暴露。 | 给文生视频与对口型等独立操作命名，便于复用和精确测试。 |
| C05 | [AutoHDR](https://fal.ai/customer-case/autohdr) | 房产图像编辑模型以端点部署，在生产版本旁测试新版本。 | 旧清单支撑在途任务，新版本先按连接或模型逐步启用。 |
| C06 | [Layer](https://fal.ai/customer-case/layer) | 游戏工作室在一个空间使用多种图、视频、3D、音频模型。 | 按任务意图组织模型入口；模型数量不能替代模板覆盖与成功率。 |
| C07 | [FLORA](https://fal.ai/customer-case/flora) | 创作画布通过共享 API 接入多种生成端点并提前校对新模型。 | 这是最接近的案例：共享协议能提速，但新端点仍需要集成验证。 |
| C08 | [Rendair](https://www.runpod.io/case-studies/how-rendair-cut-client-render-approvals-from-three-months-to-one) | 将生成、编辑、放大分别部署为生产端点。 | 性能、模型和限额绑定操作，不能对整个厂商使用同一预算。 |
| C09 | [Nodalview](https://www.runpod.io/case-studies/how-nodalview-chose-what-to-move) | 图片增强、室内布置等按负载选 GPU，只迁移 GPU 层。 | 迁移只替换任务执行，不要求重做存储、界面或账户。 |
| C10 | [Faceless.video](https://www.runpod.io/case-studies/how-faceless-video-bootstrapped-to-1m-arr) | 将完整视频流水线作为后台工作，由 App 层展示。 | 长作业和界面等待期限独立，超时后仍能处理合法回执。 |
| C11 | [BottoDAO](https://www.runpod.io/case-studies/how-bottodao-cut-its-ai-art-engines-costs-by-73) | 保持 worker 和产物位置约定，迁移推理基础设施。 | 用输出路径和结果指纹保持可验证迁移，路由升级不改变旧产物。 |
| C12 | [Prime Intellect](https://openrouter.ai/customers/prime-intellect) | 先通过同一接口评估候选模型，再按质量与成本选择。 | 先证明合同，再比较生成效果。案例是模型评估，并非媒体任务恢复。 |
| C13 | [Sentry](https://openrouter.ai/customers/sentry) | 集中管理模型预算和用途，按保留与凭据条件限制上游路由。 | 能力之外先筛数据去向和费用授权，避免健康度凌驾权限。 |
| C14 | [Descript](https://openrouter.ai/customers/descript) | 视频编辑代理通过统一推理层验证并切换新模型。 | 参数漂移可以由共享层处理；编辑器的 LLM 路由不证明视频渲染可回退。 |
| C15 | [Pax Historia](https://openrouter.ai/customers/paxhistoria) | 提供用户可选模型，网关在多个上游之间回退。 | 给用户速度、质量、费用的控制；付费生成只能在未派发的条件下变更路线。 |
| C16 | [Aperture](https://lumalabs.ai/case-studies/aperture) | 在 Luma 画布比较概念、维护品牌素材，并用 API 提升产出规模。 | 保留参考链和版本预览；广告指标不能归因于某一模型适配方法。 |
| C17 | [Boundless](https://lumalabs.ai/case-studies/boundless) | 结合实拍素材、AI 扩展及画布组装完成广告。 | 视频延展、精修、合成要沿用原镜头和参考语义，并各自产生新版本。 |
| C18 | [SiteGPT](https://portkey.ai/case-studies/sitegpt-built-ai-customer-support-platform) | 多模型切换配合提示版本和调用观测。 | 给合同和提示建立版本、区分错误阶段；Canvas 日志避免存用户输入。 |
| C19 | [Frame.io](https://vercel.com/customers/frameio-never-drop-the-illusion) | 用真实视频协作交互和预览环境发现卡顿。 | 从点击反馈和帧时间看 UX，后台生成延迟单独记录；不是适配 API 的证据。 |
| C20 | [Leonardo.Ai](https://vercel.com/customers/leonardo-ai-performantly-generates-4-5-million-images-daily-with-next-js-and-vercel) | 图像创作大流量下通过缓存、部署与监控改善界面。 | 模型端耗时不应阻塞前端操作；该材料没有公开 Leonardo 的提交/恢复实现。 |

C01–C11 直接覆盖媒体生成；C12–C15、C18 补上模型治理和路由；C16–C17、C19–C20 说明创作上下文、流程和反馈的重要性。发布方数字不构成跨项目因果比较。

## D · 实际 Web 产品与开发者入口（20）

| ID | 产品 / 一手说明 | 可见交互或 API 合同 | Canvas 对照 |
|---|---|---|---|
| D01 | [fal](https://fal.ai/docs/documentation/model-apis/inference/queue) | 以 request ID 分开排队、查询、取结果与取消。 | 对接队列族，保存 endpoint 和回执；轮询超时不等于取消。 |
| D02 | [Replicate](https://replicate.com/docs/topics/predictions/lifecycle) · [Schema](https://replicate.com/docs/reference/openapi) · [Webhook](https://replicate.com/docs/topics/webhooks/receive-webhook) | 输入输出按模型版本暴露；异步 prediction 有明确状态，Webhook 是另一观察通道。 | schema 可自动导入；用原预测 ID 查询，处理重复或乱序事件。 |
| D03 | [Runway](https://docs.dev.runwayml.com/api/) | 区分文/图生视频等操作以及统一任务查询。 | 多操作可以复用查询族；每个提交表单仅开放相应参数。 |
| D04 | [Gemini AI Studio / Veo](https://aistudio.google.com/docs/video.md) · [Veo 模型文档](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/veo/3-1-generate) | 视频能力按模型与平台发布，云端用长运行操作。 | 保存原平台和 operation 名；时长与分辨率依具体操作合同，不能照搬到其他连接。 |
| D05 | [Amazon Bedrock / Nova Reel](https://docs.aws.amazon.com/nova/latest/userguide/video-gen-access.html) | 异步作业使用 invocation ID，产物交付到指定 S3。 | 支持受权产物位置与独立取件；多镜头时长不能填入普通单段模式。 |
| D06 | [Luma Dream Machine](https://docs.lumalabs.ai/docs/video-generation) | 视频操作有 keyframe 与延展输入，可引用已有 generation。 | 对能延续原作的操作保留远端父作业；换连接不能移植远端 ID。 |
| D07 | [Kling Open Platform](https://klingai.com/document-api/api/image/4-0/image-generation.md) · [视频](https://klingai.com/document-api/api/video/4-0/text-to-video.md) | 生图和视频使用不同提交路径，共用任务查询；支持 external_task_id。 | 共享查询解析和身份核对，分别建模输入；自定义 ID 是对账键。 |
| D08 | [Midjourney](https://docs.midjourney.com/hc/en-us/articles/33329374594957-Image-Size-Resolution) | 图片大小依模型版本与比例，显示成品像素及放大信息。 | 保存实际交付尺寸与选择值，不能用营销分辨率概括所有模型。 |
| D09 | [Adobe Firefly](https://helpx.adobe.com/firefly/web/work-with-audio-and-video/work-with-video/generate-videos-using-non-adobe-models.html) | 同一 Web 流程选择伙伴模型并按模型配置视频。 | 切换模型保留创作任务，重算可用选项并展示当前模型。 |
| D10 | [Leonardo.Ai](https://docs.leonardo.ai/docs/flux-dev) | 为特定图像模型公布自己的请求配置与示例。 | 用一份底层通用执行去实现不同模型的可验证请求。 |
| D11 | [Ideogram](https://docs.ideogram.ai/create/image-settings) | 保留提示与数量，只在目标支持时保留比例；高级设置随模型改变。 | 草稿随操作保留，模型私有设置按模型恢复，冲突在提交前显示。 |
| D12 | [Black Forest Labs](https://docs.bfl.ai/quick_start/generating_images) | 提交取得轮询入口；生成结果作为有时效的交付地址。 | 区分任务完成、临时链接和项目落盘；允许按原任务重新取件。 |
| D13 | [Stability AI](https://docs.stability.ai/api-reference) | 生成、编辑、放大等由不同 endpoint 提供，工具参数各异。 | 将操作和上传形式进 schema；显式约束 multipart 素材大小和类型。 |
| D14 | [OpenAI Images](https://developers.openai.com/api/docs/guides/image-generation) | Image API 做单次生成/编辑；Responses 能携带上下文继续图像工作。 | 区分本地跨模型继续、单次编辑与厂商原生多轮。 |
| D15 | [xAI Imagine](https://docs.x.ai/developers/model-capabilities/imagine) | 图片、图像编辑、视频生成、参考生视频分开描述。 | 复用媒体术语，但实际输入、输出和编辑能力逐项声明。 |
| D16 | [阿里云百炼 / Wan](https://www.alibabacloud.com/help/en/model-studio/text-to-video-api-reference) | 文生视频异步提交并按 task_id 查询，示例合同说明有效期且明确避免重复任务。 | 按厂商 TTL 提前归档结果，过期后反馈，不自动重发生成。 |
| D17 | [PixVerse](https://docs.platform.pixverse.ai/) | 开发者资料区分积分、并发规则、任务查询和扣费查询。 | 区分作业数、并发占用和账单，重试提示说明可能产生的新费用。 |
| D18 | [Hedra](https://www.hedra.com/docs/) | 文档将视频生成、剪接生成链和生产操作分开。 | 派生关系与单个执行实例分开保存；创作迭代可以继续已有输出。 |
| D19 | [OpenRouter](https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties) | 模型目录提供访问端点和属性，允许按端点等条件过滤。 | 可自动发现候选能力；仍需按真实连接和授权决定可执行性。 |
| D20 | [ComfyUI Cloud](https://docs.comfy.org/development/cloud/overview) | 在线工作流 API 暴露云端作业和输出取得方式。 | 本地 ComfyUI 与 Cloud 使用独立连接，拓扑相似也不能共用账户与回执。 |

D01–D07 表明“查任务”最适合在平台层复用，输入仍按操作变化；D08–D13 提供 Web 表单与交付的参考；D14–D20 展示会话、生命周期和发现的不同合同。没有公开材料能证明任意模型可从名称安全地推断协议，也没有商业案例能证明桌面应用端到端零分配。

这四组交集支持三个工程决策：用版本化 schema 缩短同族模型接入（A04–A08、B08–B09、C03–C07、D02、D19）；让持久作业固定自己的连接与合同（A11–A12、B19–B20、D01–D07、D16）；让创作者知道什么时候切换模型、什么时候继续同一任务（B03–B06、C01、C16–C20、D09–D11、D14）。落实到 Canvas 的可验收条件在[实施设计](./2026-11-18-media-model-compatibility.md)。

## 补充源码对照 · CC Switch 与 Magpie

2026-11-18 核对公开源码。CC Switch 固定到 `ad22d45a8d3cabee5a95ef3eff58ac5cd2ecbeb8`，Magpie 固定到 `589e4ba6da51ac20143a82a30551d7a526c598ca`。以下结论适用于这两个提交。夹具用于阅读其预期行为，本轮未运行上游代码。

| 维度 | CC Switch | Magpie | AI Canvas 的取舍 |
|---|---|---|---|
| 获取模型列表 | 通用获取器按连接和协议选择候选目录地址。兼容 `data[].id` 和 `models[].slug/id/name`。通用返回类型只有 `id`、`ownedBy`，即使目录带长度也不经这条链返回。专有集成可另外取能力，例如 Codex 表单的 Copilot 专用探测。 [通用获取器](https://github.com/farion1231/cc-switch/blob/ad22d45a8d3cabee5a95ef3eff58ac5cd2ecbeb8/src-tauri/src/services/model_fetch.rs#L16-L57) · [专有探测](https://github.com/farion1231/cc-switch/blob/ad22d45a8d3cabee5a95ef3eff58ac5cd2ecbeb8/src/components/providers/forms/CodexFormFields.tsx#L930-L979) | 按供应商读取并缓存线上目录。目录解析读取部分长度、模态和兼容协议字段。用匹配的公开记录补齐缺失值。网关只列用户启用且当前请求可见的条目。 [线上目录与补全](https://github.com/yetone/magpie/blob/589e4ba6da51ac20143a82a30551d7a526c598ca/internal/catalog/live.go#L1310-L1361) · [接入文档](https://github.com/yetone/magpie/blob/589e4ba6da51ac20143a82a30551d7a526c598ca/docs/integrating.md#L50-L75) | 连接目录决定候选项与账号可见性。单独归一化能力字段。第三方公共目录可以给候选补线索，启用与协议选择仍由该连接的合同控制。 |
| 自动补全与手动设置 | 逐字段优先同地址预设，再按地址匹配 models.dev 供应商，最后找原厂条目。原厂补全不带价格，对部分 GPT 窗口有额外封顶。表单只填空值，例如 OpenCode 的 `limit.context/output`，OpenClaw 的 `contextWindow/maxTokens`。Codex 客户端还有独立的上下文和压缩阈值设置。 [来源解析](https://github.com/farion1231/cc-switch/blob/ad22d45a8d3cabee5a95ef3eff58ac5cd2ecbeb8/src/lib/modelMetadata.ts#L351-L413) · [表单字段](https://github.com/farion1231/cc-switch/blob/ad22d45a8d3cabee5a95ef3eff58ac5cd2ecbeb8/src/components/providers/forms/modelMetadataFill.ts#L32-L158) · [Codex 配置](https://github.com/farion1231/cc-switch/blob/ad22d45a8d3cabee5a95ef3eff58ac5cd2ecbeb8/src/components/providers/forms/CodexConfigSections.tsx#L176-L236) | 模型级覆盖独立保存。窗口、输出支持连接默认和按模型设置。CLI `magpie model spec <provider/model> --context … --output …` 可设置，`--reset` 恢复自动，查询可查看来源。优先模型设置，再供应商默认，再用已知目录能力。 [设置命令](https://github.com/yetone/magpie/blob/589e4ba6da51ac20143a82a30551d7a526c598ca/internal/cli/model_spec_cli.go#L10-L34) · [来源与重置](https://github.com/yetone/magpie/blob/589e4ba6da51ac20143a82a30551d7a526c598ca/internal/provider/modelspec.go#L261-L379) · [有效值](https://github.com/yetone/magpie/blob/589e4ba6da51ac20143a82a30551d7a526c598ca/internal/provider/models.go#L4052-L4132) | 借鉴按地址匹配、逐字段来源、手动修改和恢复自动。原厂同名模型的数据可供参考，不能直接扩大代理的预算。 |
| 刷新与离线 | 先读预设和公共目录缓存，异步补全读取最新表单状态。公共查询共用一小时新鲜期。拉取失败时保留预设填过的值。 [补全 Hook](https://github.com/farion1231/cc-switch/blob/ad22d45a8d3cabee5a95ef3eff58ac5cd2ecbeb8/src/hooks/useModelMetadataFill.ts#L17-L129) · [缓存](https://github.com/farion1231/cc-switch/blob/ad22d45a8d3cabee5a95ef3eff58ac5cd2ecbeb8/src/lib/modelsDev.ts#L58-L72) | 支持手动及定时刷新。可按规则接纳新增项。成功刷新可能移除上游已下线的选中项，失败按调度重试。 [刷新策略](https://github.com/yetone/magpie/blob/589e4ba6da51ac20143a82a30551d7a526c598ca/internal/provider/autolist.go#L261-L344) · [刷新入口](https://github.com/yetone/magpie/blob/589e4ba6da51ac20143a82a30551d7a526c598ca/internal/provider/models.go#L323-L383) | Canvas 保留最后成功快照。成功且完整的目录缺项才标下线，保留选择和引用以便恢复。晚到结果按连接修订检查，只更新目录数据。 |
| 有效长度与路由 | 通用补全主要投影到各客户端配置。请求限制仍取决于具体客户端、协议和代理分支。CC Switch 至少在 Codex 到 Anthropic 的转换分支读取对应输出设置。 [转换请求](https://github.com/farion1231/cc-switch/blob/ad22d45a8d3cabee5a95ef3eff58ac5cd2ecbeb8/src-tauri/src/proxy/forwarder.rs#L1868-L1908) | `/v1/models` 将同一个窗口值以三种别名发布，输出另给 `max_output_tokens`。源码夹具检查手动输出会降低发给上游的 `max_tokens`。路由组默认可公布最高成员值，也可设固定窗口或跟随最小已知窗口。组的输出可以是成员中的最高值，运行时按实际成员处理。 [目录序列化](https://github.com/yetone/magpie/blob/589e4ba6da51ac20143a82a30551d7a526c598ca/internal/gateway/gateway.go#L1503-L1548) · [设置到发包夹具](https://github.com/yetone/magpie/blob/589e4ba6da51ac20143a82a30551d7a526c598ca/internal/gateway/modelspec_test.go#L52-L125) · [组合同](https://github.com/yetone/magpie/blob/589e4ba6da51ac20143a82a30551d7a526c598ca/internal/provider/group.go#L1636-L1827) · [组输出夹具](https://github.com/yetone/magpie/blob/589e4ba6da51ac20143a82a30551d7a526c598ca/internal/gateway/group_output_test.go#L17-L75) | 先固定请求的协议和目标，再计算预算并写入经支持的请求字段。客户端看不到全部备选时，把网关声明当参考值。观察到的路由信息可用于解释本轮结果。 |
| 图像与视频 | 本轮核对的通用目录与参数补全主要覆盖文本模型和客户端设置，未从这条调用链取得通用的媒体操作和长度合同。 | `?kind=all` 可列文本、图像和视频。媒体项有 `kind`、模态及部分端点声明。视频创建、查询和取件对应同一网关任务 ID。例示的视频目录对象没有按操作给出秒数、提示词或参考素材上限。 [媒体目录](https://github.com/yetone/magpie/blob/589e4ba6da51ac20143a82a30551d7a526c598ca/internal/gateway/gateway.go#L1633-L1694) · [视频任务](https://github.com/yetone/magpie/blob/589e4ba6da51ac20143a82a30551d7a526c598ca/internal/gateway/video.go#L31-L50) | 可以发现媒体候选及任务协议。实际可选秒数、提示词和素材限制仍按网关和上游组合的操作合同确认。原网关 ID 用于续查。 |

Magpie 的 `context_window`、`context_length`、`max_input_tokens` 在所查版本里是同一值的别名。其目录结构也可能优先读取上游输入限额作为窗口，因此不能据此同时获得独立输入硬上限与输入输出总窗口。对比中的设置和回执证据来自源码与夹具，尚未用已发布客户端、实际账号或付费请求验证。 [公共目录窗口语义](https://github.com/yetone/magpie/blob/589e4ba6da51ac20143a82a30551d7a526c598ca/internal/catalog/catalog.go#L540-L555) · [上下文别名](https://github.com/yetone/magpie/blob/589e4ba6da51ac20143a82a30551d7a526c598ca/internal/gateway/gateway.go#L1520-L1529)

# API 外部管理的 80 项证据与比较

2026-11-18。分析对象为 AI Canvas 桌面的厂商接入、动态接管、凭据保护和任务恢复。主方案在[外部管理实施计划](./2026-11-18-external-provider-management.md)，可实施的时序与预算在[生命周期与验收设计](./2026-11-18-provider-runtime-design.md)。

**选样与证据强度。** A 为能直接参考的开源应用、网关和基础库，B 为单独选取的高星开源项目，入选门槛 10,000 个 GitHub Stars，逐仓读取 GitHub 公开计数。两个样本集不重复，同一仓库内的子项目只计一项。C 按实际采用方去重，20 个具名商业客户的落地案例，来自客户与供应商联合发布或供应商发布的材料；成效按发布方陈述，缺少独立对照。D 为 20 个实际 Web 服务，从公开的用户／开发者资料观察产品合同，未登录执行账户操作。跨组同一供应商的实现、客户、线上服务可以相互印证；80 是不同对象数，不能据此计算市场份额、成功率或独立厂商数。Star 是采样日热度。以下“采用／边界”均为本项目的设计判断。

## A · 专项开源项目（20）

| ID | 项目 | 观察到的机制 | 采用／边界 | 一手来源 |
|---|---|---|---|---|
| A01 | Magpie | 同一本机网关可服务其他应用，管理器列表另有独立适配合同。 | 先通网关，另验收管理器内的一键连接、换模型和解除。 | [项目资料](https://usemagpie.ai/docs/integrate) |
| A02 | CC Switch | 针对不同客户端注册应用类型并编辑各自配置，部分客户端另有本机路由。 | 提供稳定文件合同和临时目录样例，不能从端口号推断支持。 | [项目资料](https://github.com/farion1231/cc-switch/blob/ad22d45a8d3cabee5a95ef3eff58ac5cd2ecbeb8/src-tauri/src/app_config.rs) |
| A03 | Agent Router（原 Envoy AI Gateway） | 对应用提供统一协议，在平台侧集中处理上游路由和凭据。 | 允许外接网关，桌面端不必部署独立集群。 | [项目资料](https://github.com/theagentrouter/agent-router) |
| A04 | Bifrost | 一个兼容入口连接多个供应商，提供故障转移和虚拟 Key。 | 区分网关身份和厂商身份。故障转移需遵守授权范围与付费语义。 | [项目资料](https://github.com/maximhq/bifrost) |
| A05 | Portkey Gateway | 把路由、重试、故障转移和可观察性放进网关。 | 记录由哪一层重试，避免网关与应用叠加重投。 | [项目资料](https://github.com/Portkey-AI/gateway) |
| A06 | TensorZero | 将推理网关、评估和在线实验组合。 | 把合同测试和结果质量评估分开，性能不能替代协议正确性。 | [项目资料](https://github.com/tensorzero/tensorzero) |
| A07 | RouteLLM | 同一工作负载可评估质量与成本之间的模型路由选择。 | 固定任务集比较结果；首版由用户选择路由，不擅自降档。 | [项目资料](https://github.com/lm-sys/RouteLLM) |
| A08 | SOPS | 可将配置中的秘密加密并依赖外部密钥后端。 | 加密文件有密钥分发与解密生命周期，公开路由在 v1 只存引用。 | [项目资料](https://github.com/getsops/sops) |
| A09 | age | 使用明确的接收者和身份做文件加解密。 | 加密备份需独立设计恢复身份；v1 分享配置时排除秘密。 | [项目资料](https://github.com/FiloSottile/age) |
| A10 | notify | 各平台文件通知及编辑器保存行为存在差异。 | 监听父目录、合并通知，恢复前台时按完整文件复核。 | [项目资料](https://docs.rs/notify/latest/notify/) |
| A11 | arc-swap | 面向读多写少场景原子替换 Arc 指向的数据。 | 作为读写竞争的备选优化；首版先测标准库短锁。 | [项目资料](https://github.com/vorner/arc-swap) |
| A12 | secrecy | 通过封装类型显式访问秘密，限制意外暴露。 | 原生凭据类型限制显示、日志和序列化；审计显式取值点。 | [项目资料](https://github.com/iqlusioninc/crates/tree/main/secrecy) |
| A13 | zeroize | 提供防止编译器优化掉的内存清零。 | 为可控的秘密缓冲区清零；列出 HTTP/TLS 库可能产生的额外副本。 | [项目资料](https://github.com/RustCrypto/utils/tree/master/zeroize) |
| A14 | keyring-rs | 跨平台凭据 API 背后有多个实际存储后端。 | 按每个 OS 和安装形态验收锁定、不可用、轮换与卸载行为。 | [项目资料](https://github.com/open-source-cooperative/keyring-rs) |
| A15 | Loom | 用调度置换探索 Rust 并发交错。 | 在小模型中穷举切换、撤权、提交登记，整机行为另做故障注入。 | [项目资料](https://github.com/tokio-rs/loom) |
| A16 | Bytes | 缓冲区可共享和切片，视图可延长底层分配寿命。 | 按底层缓冲总容量限制队列，巨大响应切小片也须纳入预算。 | [项目资料](https://docs.rs/bytes/latest/bytes/struct.Bytes.html) |
| A17 | tracing | 用 span 和事件关联异步操作。 | 保留阶段、计时和临时关联 ID，拒绝记录请求体和凭据。 | [项目资料](https://github.com/tokio-rs/tracing) |
| A18 | Tower | 将服务包装为可组合的限流、超时等中间层。 | 固定排队、超时、取消的责任顺序，每次计费提交只能有一个重试决策点。 | [项目资料](https://github.com/tower-rs/tower) |
| A19 | rustls | 提供由 Rust 实现的 TLS 客户端与服务端。 | 复用项目既有 TLS 验证，私有部署单独验收信任链。 | [项目资料](https://github.com/rustls/rustls) |
| A20 | SQLx | 统一访问多种数据库，也支持 SQLite。 | 本机一致性需要事务；项目已有 rusqlite，按已有实现评估即可。 | [项目资料](https://github.com/launchbadge/sqlx) |

A01–A07 有直接接管、API 转换、调度、评估四种职责。桌面端需要前两种接口，后两种可委托给选定网关。A08–A20 解决的分别是密钥存储、热更新、并发和观测；是否引入依赖由本机测量和维护成本决定。

## B · 高星项目（20）

| ID | 项目 | Stars | 观察到的机制 | 采用／边界 | 一手来源 |
|---|---|---|---|---|---|
| B01 | Envoy | 29,258 | 数据转发和动态配置分离。 | 文件解析离开转发热路径，申请请求时固定版本。 | [仓库](https://github.com/envoyproxy/envoy) |
| B02 | Caddy | 79,168 | 原生 JSON 管理接口可以在线替换配置并保存有效版本。 | 保留最后可用快照；v1 用用户级文件减少本机监听面。 | [仓库](https://github.com/caddyserver/caddy) · [文档](https://caddyserver.com/docs/api) |
| B03 | Traefik | 65,584 | 从配置提供方持续更新路由。 | 明确哪些字段由外部拥有，避免 UI 保存抢回控制。 | [仓库](https://github.com/traefik/traefik) |
| B04 | Apache APISIX | 17,338 | 支持动态上游和路由、限流、熔断等策略。 | 路由的授权边界先于健康度和负载策略。 | [仓库](https://github.com/apache/apisix) |
| B05 | Kong Gateway | 44,394 | 用插件扩展鉴权、转发、负载等行为。 | 适配器声明能力，核心执行固定的鉴权和目标检查。 | [仓库](https://github.com/Kong/kong) |
| B06 | etcd | 52,620 | KV 操作与 watch 的保证不同，修订可描述变更顺序。 | 事件只提示刷新；请求准入以权威状态为准。 | [仓库](https://github.com/etcd-io/etcd) · [文档](https://etcd.io/docs/v3.6/learning/api_guarantees/) |
| B07 | Kubernetes | 129,249 | resourceVersion 支持条件更新；监听中断可以重新列举。 | 过期编辑返回冲突，窗口漏通知时取完整摘要。 | [仓库](https://github.com/kubernetes/kubernetes) · [文档](https://kubernetes.io/docs/reference/using-api/api-concepts/) |
| B08 | Tokio | 33,719 | 事件驱动的异步 Rust 运行时。 | 复用现有运行时；阻塞文件／凭据 IO 离开异步执行线程。 | [仓库](https://github.com/tokio-rs/tokio) |
| B09 | curl/libcurl | 43,557 | 提供跨协议传输和可复用客户端库。 | 将传输取消、超时与业务终态区分，避免另起命令行进程。 | [仓库](https://github.com/curl/curl) |
| B10 | Ollama | 187,499 | 本机 REST 服务提供模型和推理。 | 独立标记本地模型合同与发现方式，不能把所有回环端口视为可信。 | [仓库](https://github.com/ollama/ollama) |
| B11 | vLLM | 97,143 | 服务端做连续批处理等推理调度。 | 客户端限制并发并测首 token；服务端吞吐无法外推桌面开销。 | [仓库](https://github.com/vllm-project/vllm) |
| B12 | llama.cpp | 135,606 | 可运行兼容 OpenAI 的本地推理服务。 | 将本机自托管作为协议夹具，工具与流式能力分别探测。 | [仓库](https://github.com/ggml-org/llama.cpp) |
| B13 | Aider | 50,163 | 可配置多种云端和本地模型。 | 模型选择保存连接身份和模型 ID，避免同名模型跨厂商串用。 | [仓库](https://github.com/Aider-AI/aider) |
| B14 | LiteLLM | 63,474 | 以统一格式访问多模型，提供独立代理模式。 | 兼容接口只承诺已验证子集，保留协议和能力差异。 | [仓库](https://github.com/BerriAI/litellm) |
| B15 | OpenAI Codex | 135,743 | 用户可配置命名 provider、地址和凭据来源。 | 选择项与认证机制分离，应用只识别受控引用。 | [仓库](https://github.com/openai/codex) · [文档](https://developers.openai.com/codex/config-reference/) |
| B16 | gRPC | 45,448 | 取消传播到各处理环节，需要执行方协作停止。 | 窗口关闭、令牌撤销、本地超时共用取消链，远端状态另查。 | [仓库](https://github.com/grpc/grpc) · [文档](https://grpc.io/docs/guides/cancellation/) |
| B17 | Prometheus | 67,686 | 以指标名和标签维度组织时间序列。 | 指标标签固定枚举，杜绝把模型自由文本、密钥或请求 ID 当标签。 | [仓库](https://github.com/prometheus/prometheus) |
| B18 | Rust | 122,219 | 所有权规定资源存续和释放，无需语言级追踪式 GC。 | 单独测堆分配和析构延迟；WebView 与第三方网关不在原生保证范围。 | [仓库](https://github.com/rust-lang/rust) · [文档](https://doc.rust-lang.org/book/ch04-01-what-is-ownership.html) |
| B19 | libsodium | 14,065 | 可对受控内存执行清零和锁页，锁页可能受系统限制。 | 缩短密钥明文寿命；在威胁模型标出复制、交换和崩溃转储边界。 | [仓库](https://github.com/jedisct1/libsodium) · [文档](https://doc.libsodium.org/memory_management) |
| B20 | Istio | 38,519 | 将流量管理、安全策略与可观测性作为服务间基础设施。 | 可连接现有企业网关；桌面端只保留自身最小执行策略。 | [仓库](https://github.com/istio/istio) |

B01–B07 支持把写配置和服务请求分离。B08–B16 显示兼容入口背后仍有运行时、协议族与取消差异。B17–B20 提供可观察性、内存和策略的工程参照。没有取任何上游 benchmark 作为本应用性能值。

## C · 具名落地案例（20）

| ID | 采用方 | 公开部署／结果 | 采用／边界 | 一手来源 |
|---|---|---|---|---|
| C01 | ING | 把 API 配置接入开发团队既有 CI/CD，支持混合部署。 | 管理器保留自己的工作流，Canvas 只公布文件合同和拒绝原因。 | [客户案例](https://konghq.com/customer-stories/ing-constructs-high-velocity-banking-architecture-with-kong) |
| C02 | Vanguard | 为越来越多应用标准化网关鉴权、路由和治理流程。 | 协议适配与原生安全策略分开评审，防止适配器跳过鉴权。 | [客户案例](https://konghq.com/customer-stories/vanguard-standardizes-apiops-with-kong) |
| C03 | TELUS | 为分散在多云的 API 建立统一运行和治理视图。 | 提供当前路由、错误阶段和连接来源，不收集全部请求内容。 | [客户案例](https://konghq.com/customer-stories/telus-builds-a-multi-cloud-ai-enabled-unified-api-platform-with-kong) |
| C04 | MediaMarktSaturn | 多区域部署，将团队自治与统一网关结合，报告运营成本下降。 | 只借鉴管理与执行的分工；区域故障转移不能直接移植给有账户归属的媒体任务。 | [客户案例](https://konghq.com/customer-stories/mediamarktsaturn-reduces-costs-11x-with-kong) |
| C05 | Poka | 以 feature flag 改善原依赖分支的发布流程。 | 按平台和能力逐项发布接管功能，允许单独关闭。 | [客户案例](https://launchdarkly.com/case-studies/poka/) |
| C06 | Relay Network | 用 AI Configs 让受监管客户的生成能力可受控调整。 | 模型／提示变化需要版本；路由设置只管理连接，避免改写项目提示词。 | [客户案例](https://launchdarkly.com/case-studies/relay-network/) |
| C07 | Blue Cross of Idaho | 客户门户的排障时间下降，案例报告降幅 75%。 | 设置页展示最近一次成功修订和失败阶段，验收使用实际排障任务。 | [客户案例](https://launchdarkly.com/case-studies/blue-cross-of-idaho/) |
| C08 | HP | 打印软件团队统一开关用法并形成书面指南。 | 为管理器作者提供同一套转移、撤销和恢复样例。 | [客户案例](https://launchdarkly.com/case-studies/hp/) |
| C09 | Oracle Red Bull Racing | 用秘密引用和 CLI 改善服务凭据访问，减少模拟代码中明文。 | 公开路由使用本机绑定别名，系统库只由原生层访问。 | [客户案例](https://1password.com/customers/oracle-red-bull-racing-for-developers) |
| C10 | Asana | 使用既有密码管理并引入设备信任，强调低支持负担。 | 日常已授权切换无需重复确认；新目的地一次性呈现影响。 | [客户案例](https://1password.com/customers/asana) |
| C11 | DigitalOcean | 共享库集中权限，CLI 辅助服务账户凭据迁移。 | 迁移需记录进度和所有者，支持条件提交及中断续作。 | [客户案例](https://1password.com/customers/digitalocean) |
| C12 | JetBrains | 将凭据库纳入员工入职流程，集中管理跨团队共享。 | 首次启用接管提供明确引导，便于以后识别和收回权限。 | [客户案例](https://1password.com/customers/jetbrains) |
| C13 | Theories Group | n8n 工作流通过网关切模型，减少每次替换模型时的流程变化。 | 节点引用稳定连接槽；外部替换路由不重写项目。 | [客户案例](https://portkey.ai/case-studies/theories-group-scaling-llm-operations) |
| C14 | SiteGPT | 支持多模型切换、观测与故障转移，维持客服应用服务。 | 保留网关提供路由组的能力；发送域和数据去向仍由用户授权。 | [客户案例](https://portkey.ai/case-studies/sitegpt-built-ai-customer-support-platform) |
| C15 | Sandstone | 通过 AI SDK 实现多步法律工作流，用预览部署向企业客户验证修改。 | 把多步助手轮作为可追踪单元，预览路由变更时展示会影响哪些操作。 | [客户案例](https://vercel.com/customers/how-sandstone-grew-40x-in-147-days-on-vercel) |
| C16 | Snorkel AI | 团队用成功与失败 trace 的差异定位多 Agent 流程问题。 | 用匿名阶段链复现，默认不保存客户输入、工具结果或模型输出。 | [客户案例](https://portkey.ai/case-studies/snorkel-ai-multi-agent-debugging) |
| C17 | Runway | 用预览与健康视图缩短网站迭代和审查周期。 | 发布前预览设置差异；此案例覆盖交付流程，未验证其模型传输。 | [客户案例](https://vercel.com/customers/runway-enables-next-generation-content-creation-with-ai-and-vercel) |
| C18 | Leonardo.Ai | 图像创作平台在高流量下改善前端反馈及部署。 | 将 UI 响应和生成完成分开量度；页面规模不能推导本地 p99。 | [客户案例](https://vercel.com/customers/leonardo-ai-performantly-generates-4-5-million-images-daily-with-next-js-and-vercel) |
| C19 | Frame.io | 以预览和真实交互的性能核查发现界面回归。 | 对切换后继续输入、取消流、重启恢复录制桌面交互时序。 | [客户案例](https://vercel.com/customers/frameio-never-drop-the-illusion) |
| C20 | Vapi | 用适配器支持 SSE 与 Streamable HTTP 两种 MCP 传输。 | 同一产品对不同传输分别认证和验收，MCP 能力不等于模型网关权限。 | [客户案例](https://vercel.com/customers/vapi-mcp-server-on-vercel) |

C01–C04 重在治理，C05–C08 重在可撤销发布，C09–C12 重在凭据生命周期，C13–C16 直接涉及 AI 路由与诊断，C17–C20 补充创作界面与协议升级。SiteGPT 的自动切换有助于可用性，作为额外对照，Fontys ICT 的地域和预算要求限制可选目的地；Canvas 应让用户先界定允许的目标，已提交的付费任务始终按原作业恢复。高校对照未计入 20 个商业客户。[Fontys ICT 部署资料](https://portkey.ai/case-studies/fontys-ict-university-ai-infrastructure)

## D · Web 产品与开发者入口（20）

| ID | Web 服务 | 可观察的接口／交互 | 采用／边界 | 一手来源 |
|---|---|---|---|---|
| D01 | Stripe | 请求按幂等键去重，版本和有效期影响结果。 | 仅在真实上游合同覆盖该请求时允许原身份重试。 | [官方说明](https://docs.stripe.com/api/idempotent_requests) |
| D02 | Slack | 429 回应给出 Retry-After。 | 只读探测遵守服务端等待值，并受总截止时间约束。 | [官方说明](https://docs.slack.dev/apis/web-api/rate-limits/) |
| D03 | Discord | 有按 bucket 区分的速率限制和重试等待。 | 一个受限连接不会拖停其他提供方。 | [官方说明](https://docs.discord.com/developers/topics/rate-limits) |
| D04 | Shopify | GraphQL 有按查询成本计的配额。 | 预留每个协议报告成本的字段，不能假设每次请求消耗相同。 | [官方说明](https://shopify.dev/docs/api/usage/limits) |
| D05 | Notion | 请求存在速率及载荷限制。 | 把过大请求与可退避的限流区分，给出不同操作。 | [官方说明](https://developers.notion.com/reference/request-limits) |
| D06 | Linear | 分别限制请求率与查询复杂度。 | 诊断需区分请求过频和单次操作过重。 | [官方说明](https://linear.app/developers/rate-limiting) |
| D07 | Sentry | 令牌到期、撤销以及 scope 不足需要不同处置。 | 分别显示重新绑定和缺少能力，禁止循环尝试旧凭据。 | [官方说明](https://docs.sentry.io/api/auth/) |
| D08 | Twilio | 可按用途创建 API Key 并单独撤销。 | 一个外部管理器使用独立绑定，撤销时不波及其他连接。 | [官方说明](https://www.twilio.com/docs/iam/api-keys) |
| D09 | Supabase | 公开标识与服务端秘密具有不同暴露规则。 | 把 Magpie 本机标记清楚标为公开；真实网关令牌永不放入分享。 | [官方说明](https://supabase.com/docs/guides/api/api-keys) |
| D10 | Hugging Face | 细粒度 token 可以限制到需要的模型或资源。 | 权限按模型和操作缩小，凭据只用于绑定的账户／目标。 | [官方说明](https://huggingface.co/docs/hub/security-tokens) |
| D11 | OpenRouter | 可设路由偏好并禁用提供方回退。 | 把“允许网关换上游”展示给用户，不把逻辑模型名解释成物理厂商。 | [官方说明](https://openrouter.ai/docs/guides/routing/provider-selection) |
| D12 | Replicate | 预测有状态和 deadline，执行后取消仍可能产生费用。 | 区分本地停止等待、远端取消和账单确认。 | [官方说明](https://replicate.com/docs/topics/predictions/lifecycle) |
| D13 | fal | 排队接口分提交、状态、结果和取消，客户端等待有独立期限。 | 持久化任务回执，恢复只续查原任务。 | [官方说明](https://docs.fal.ai/model-apis/model-endpoints/queue) |
| D14 | Cloudflare AI Gateway | 网关可以要求调用端认证。 | 网关访问凭据和上游账户凭据用两种绑定类型。 | [官方说明](https://developers.cloudflare.com/ai-gateway/configuration/authentication/) |
| D15 | Vercel AI Gateway | 网关 API Key／OIDC 与 BYOK 供应商凭据承担不同角色。 | 认证失败明确标出是哪一跳，支持更换边界。 | [官方说明](https://vercel.com/docs/ai-gateway/authentication-and-byok) |
| D16 | ElevenLabs | API Key 可按端点设访问限制。 | 目录读取成功只能标记该操作可用，不能推出语音生成可用。 | [官方说明](https://elevenlabs.io/docs/api-reference/authentication) |
| D17 | Grafana Cloud | 服务账户可配多 token 并设置到期。 | 区分稳定账户绑定和可轮换的凭据版本。 | [官方说明](https://grafana.com/docs/grafana/latest/administration/service-accounts/) |
| D18 | GitLab | 项目访问令牌有角色、scope 和有效期，控制台区分活跃、到期、轮换和撤销。 | 设置页分别显示绑定与令牌状态，并提供替换和撤销，避免反复展示秘密。 | [官方说明](https://docs.gitlab.com/user/project/settings/project_access_tokens/) |
| D19 | Postman | 在请求中引用 Vault 秘密，提供本地 Vault。 | 导出或同步路由只带别名；缺少本机绑定时暂停。 | [官方说明](https://learning.postman.com/docs/sending-requests/postman-vault/postman-vault-secrets/) |
| D20 | Google AI Studio | 提供 Gemini API key 创建、使用及限制的管理指引。 | 设置页引导使用独立、受限的 Key，连接探测默认不做生成。 | [官方说明](https://ai.google.dev/gemini-api/docs/api-key) |

D01–D06 表明重试、请求预算和配额需要逐协议建模。D07–D11、D14–D20 表明应用身份、网关凭据、账号和模型权限需要分别呈现。D12–D13 给出本地等待、远端任务和费用三条独立状态线。

## 维护和复核

准备发布时，由适配维护者登记来源版本或提交、核对日期、桌面系统与实测协议。优先重查 A01/A02、B14/B15、D11–D15。来源变更先更新受影响的比较行，再重跑设计中对应的合同用例；商业页面移除时保留原引用并标记待复核，不能用营销首页补作协议证据。

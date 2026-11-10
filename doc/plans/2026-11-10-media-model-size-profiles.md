# 图片与视频型号参数、尺寸同源管理

状态：已补齐已确认型号的公共模板与渠道覆写，模板统一提交的相关 32 个文件、1813 项 Vitest 通过。随后按用户补充文档修正万象 SD 路由、请求与取件合同，并按用户确认开放万象 H3 30 秒；该追加修正尚未运行测试，详见[万象专项](./2026-10-27-relayonapi-provider.md#sd-当前路由与-h3-30-秒修正2026-11-10)。桌面与真实模型调用仍待用户验收。

## 决策与来源

按“精确型号能力 → 渠道限制 → 请求字段映射”组织现有能力，不以显示名称推断另一个渠道的合同。相同 Seedance 版号复用基础比例；渠道支持范围、首尾帧、视频编辑和音频组合限制继续显式声明。图片档位不等于所有型号通用的固定长边或短边；具体像素优先取已确认尺寸表，布局估计与实际产物尺寸分开。

核对的公开主来源：

- [火山视频任务 API](https://docs.volcengine.com/docs/ark/create-video-generation-task-api?lang=zh&redirect=1)：Seedance 2.5 的首尾帧、编辑与延长限制，比例及自动时长语义。官方完整能力与万象渠道支持范围分别保留。
- [火山图片教程](https://docs.volcengine.com/docs/ark/image-generation-tutorial?lang=zh&redirect=1)：Seedream 各型号档位不同；档位与明确宽高是不同参数方式，参考尺寸不等于所有渠道保证的实际尺寸。
- [Google 图片生成规格](https://ai.google.dev/gemini-api/docs/image-generation#aspect-ratios-and-image-size)：核对 Nano Banana 原版、Pro、2.1 的完整像素表。例如 Pro 的 2K／16:9 为 2752×1536；不沿用通用短边 2048 公式。
- [Google 官方 SDK](https://github.com/googleapis/python-genai)、[火山官方 SDK](https://github.com/volcengine/volcengine-python-sdk)：核对型号能力与传输字段分属不同层；不因共用能力而替换已有 generateContent、Interactions 或中转协议。
- [OpenAI 图片生成文档](https://developers.openai.com/api/docs/guides/image-generation)：GPT 客户端像素预设遵守对应型号的尺寸约束；应用预设不是官方允许尺寸的穷举列表。
- [APIMart GPT 2.5](https://docs.apimart.ai/cn/api-reference/images/gpt-image-2.5/generation)、[ToAPIs GPT 2.5](https://docs.toapis.com/docs/cn/api-reference/images/gpt-image-2.5-official/generation)：保留仓库已核对的渠道尺寸合同，不将其自动改为官方模板数值。本轮未重新执行各渠道真实调用。

万象原五种常用比例来自用户截图确认。后续用户明确要求以 2026-11-10 提供的本地 SD 调用参考为准：2.0 C 系列默认采用当前通用三比例，2.5 C1 增加 21:9，A 系列保留原五项；公共 Seedance 比例不改。这些是渠道声明，不作为平台实测通过。

## 实现边界

- `services/ai/modelCapabilityTemplates.ts` 集中 13 个图片基线（GPT Image 1／1.5／2／2.5／2.6、Nano Banana 原版／Pro／2／2.1、Seedream 4／4.5／5 Lite／5 Pro）及 6 个视频基线（Seedance 2.0／Fast／Mini／2.5、MiniMax H3／Max）。视频继续读取既有官方能力源，渠道按已核对的精确 ID 绑定，不按显示名称或前缀猜型号。
- 渠道只覆写自身的分辨率、比例、默认值、时长、素材上限和模式差异。数组、输入模式与操作模式整体替换，不合并扩权；显式 `undefined` 删除未声明字段，返回对象及嵌套数据均为独立副本。未知模板拒绝，不兜底到其他版号。GPT 2.6 未确认的高级能力不继承 2.5，兼容能力由具体渠道显式声明。
- `services/ai/modelSizeProfiles.ts` 集中命名尺寸表并返回隔离副本：官方 GPT、APIMart、ToAPIs、万象 Image／Nano／Seedream／MJ、GRSAI GPT、已核对的 Google 与火山型号。不同渠道的同名尺寸不混用；相同像素行可复用。GRSAI 查询及实际请求共用同一张表；这是本轮新增的精确尺寸声明，原请求像素不变。
- 图片模板、内置图片构造和声明式生成共用尺寸解析。显式表缺少固定组合时拒绝，不能静默降档。auto／adaptive 只估计布局，真实宽高仍由文件确认。既有 HD 等自定义枚举没有精确表时保留旧布局估计，不阻止只接收枚举的自定义协议。
- `resolveImageParameterCapability` 和 `resolveImageExecutionCapability` 共用有效能力；后者移除仅用于隐藏控件的空数组。显式用户声明仍接受原协议校验。未匹配内置合同的自定义协议不继承目录的整套尺寸、批量及参考能力；CCC 已有按实际变量选择候选的兼容规则继续保留。
- 视频参数面板、生成预检及 Agent／MCP 的能力入口共用 `resolveConfiguredVideoCapability`。保留 Sora2U 完整目录兜底，再应用联合名额。旧节点按实际绑定连接解析，不因旧 provider 名称串用另一条连接。
- 万象视频仍读取公共型号基线，再按最新客户接口覆写：官转保留 `metadata.ratio`，A／2.5 C1 修正为顶层 `aspect_ratio`；C2／C3 离散时长、C3 当前禁参考音频、2.5 C1 六比例及 H3 的 15／20／25／30 秒四档均为渠道差异。旧内置合同精确识别，新提交投影当前版，已提交任务按原摘要恢复。
- 仅七款确曾发布单项 16:9 默认值的完整旧能力快照可临时补正。缺省比例也须匹配其余完整能力；用户修改过的时长、参考限制、输入模式、其他显式比例以及自定义协议不扩宽。能力整体缺失且完整命中内置协议时可读取当前合同副本。2.0 C1／C2／C3 原本已支持五项，不能把其单项显式限制误判为旧默认。
- Agent／MCP 的图片能力查询补充已声明的 dimensionPresets，只传参数与尺寸，不暴露连接地址、协议或凭据。
- CCC 旧 Pro／Gemini 3.x 别名与当前香蕉目录共用三档候选，参数面板和生成均保留 2K／4K；用户改写协议时仍按实际提交变量隐藏无效选项。CCC 没有本渠道精确尺寸表时不继承 APIMart 同名表，标准 Images 保留既有像素换算与对齐。

不修改数据库版本、连接身份、原任务回执、用户节点参数或正式迁移开关；不自动迁移项目或搬动真实素材。已保存的自定义模板不自动重写，更新完整模板需用户显式重新应用。

## 默认模板实际共用范围

已确认属于下列型号家族的中转 SKU 通过公共模板与渠道覆写构造。相同型号共用基线，不要求渠道最终候选完全一致：渠道限制、枚举大小写及顺序、缺省值和传输字段继续遵守原合同。

| 渠道 | 视频默认能力 | 图片默认能力／尺寸 |
|---|---|---|
| APIMart | Seedance 2.x 与 doubao 别名沿用公共模板 | GPT／Nano／Seedream 读取公共基线，保留本渠道枚举、引用和尺寸差异 |
| 万象 | 10 个 Seedance SKU 与 H3 接入公共基线，保留官转／A／C 各自限制 | 10 个已确认 Image／Nano／Seedream SKU 接入基线；MJ 仍为独立家族，像素表集中管理 |
| ToAPIs | Seedance 2.x 与 H3／Max 读取基线，离散时长、素材及模式按渠道覆写 | GPT／Nano／Seedream 读取基线，VIP／official 尺寸与普通版差异保留 |
| LibAPI | 10 个已审计内部 ID 绑定基线，原快照提供渠道声明 | 12 个已审计内部 ID 绑定基线，公开别名、快照及本地像素合同保留 |
| CCC | 未内置 Seedance 2.x | 已确认现行／旧香蕉别名和 Flare／Sunburst 质量背景读取公共基线；不增加未声明的像素、批量或引用字段 |
| Amam／AIGC SI | 9 个已确认视频 SKU 接入 Seedance／H3 基线 | 9 个已确认 GPT／Nano SKU 接入基线；未确认底层型号的“香蕉”别名保留原合同 |
| Lec | Seedance 复用模板机制；四个已知 SKU 仍有渠道覆写 | 无独立图片清单，需用户显式应用图片模板 |
| Sora2U | 6 个 Seedance 2.x SKU 接入基线，必须参考、联合名额、Mono 限额及未声明输出参数保留 | 未声明精确 GPT／Nano SKU，不猜测归并 |
| GRSAI | H3 读取基线，保留渠道档位及未声明模式 | 已确认 GPT／Nano SKU 读取基线，原两套 GPT 请求像素表集中并同步至能力查询；未知版号的 fast 别名不归并 |
| RunningHub | 已确认的 Seedance／H3 端点枚举从公共基线投影，渠道专有档位和时长单独配置 | 已确认 GPT／Nano／Seedream 端点枚举从基线投影；合计 46 个精确端点、56 处枚举，继续使用专有参数 schema |
| Google／显式快速模板 | 不改传输层 | 已确认 Google Pro 及 GPT／Nano 快速适配模板共用基线，保留 Interactions／generateContent／JSON／APIMart 的合同差异 |

RunningHub 的专有扩展（如 native1080p、放大档、超高清档、令牌时长）继续单独声明，不改变表单或补入普通模型控件。Flux、Kling、Wan 等不同家族、未确认底层型号的渠道别名及其他专有端点仍保留各自合同；不能以名称相似并入上述模板，也不承诺全部模型的像素均已确认。

旧配置直接沿用原记录：此次不新增保存时改写、目录刷新迁移或协议替换。LibAPI 的原审计快照保留为渠道事实来源；已有万象旧快照仅继续使用上文受限的运行期补正规则。原任务查询协议和回执摘要来源不变，不因能力构造方式改变而重投任务。

## 本轮自动化验证

在旧提交 `4b00f146` 的隔离工作树生成原合同摘要，与本轮实现按 JSON 语义对照（忽略对象键顺序与 undefined，保留数组顺序）。`modelCapabilityTemplateCompatibility.test.ts` 的 11 组回归覆盖 647 个公开目录记录及完整协议／参数 schema、18 个快速模板、34 个普通／APIMart 图片能力样本、17 个 GRSAI 图片 SKU 和 4 个 H3 档位分支。仅 GRSAI 图片忽略本轮有意新增的 `dimensionPresets` 字段，其请求像素由独立逐值断言验证；原断言不放宽。

相关 32 文件、1813 项测试全部通过，覆盖公共模板、渠道清单、目录缓存、旧能力解析、自定义配置草稿、Agent／MCP 参数查询及图片／视频请求。隔离对照临时工作树已移除；未读取真实项目或凭据。请求测试使用受控响应，没有真实计费或迁移用户数据。此次未运行完整前端 CI、Rust、类型检查、lint、构建或桌面验收。

## 仍需区分的未知尺寸

Google 3.1 Flash 的 512／21:9 官方正文给出 792×168，与比例不一致。本轮不推算替换，也不把该表作为已确认的精确尺寸源。Banana 2 的既有估算、未确认的 Flash Lite 与各渠道无固定尺寸表的合同继续保留，不能据此声称全部型号像素已实测。渠道自适应、参考映射及未知枚举的最终尺寸均以返回文件为准。

## 待用户验收

前置：使用 Tauri 桌面端，准备测试项目和所需连接；先检查参数面板与请求预览。网络生成可用受控接口替代，真实模型调用由用户自行决定。

1. 已保存的万象视频连接无需重建：官转／A 五比例、2.0 C 系列通用三比例、2.5 C1 六比例，与渠道声明一致；H3 仅支持 15／20／25／30 秒，默认 15 秒，公共基线及其他渠道不变。
2. 选择各渠道支持的比例，核对节点／对话／Agent／MCP 的选择和提交参数；官转保持原层级，A／2.5 C1 为顶层输出参数。C2／C3 的非档位时长及 C3 任意参考音频均应在上传和提交前拒绝。
3. 修改过协议、时长或模式的旧万象模型及同名自定义连接保持原配置。2.0 C1 的显式单项比例不扩宽；切换／重启／导出配置不应将运行期补正写回原记录。
4. 显式套用 Google 原版／Pro／2.1 模板，核对各档位像素；Pro 2K／16:9 应取 2752×1536。APIMart GPT 2.5 的 1K／2:1 应取 2048×1024，官方 GPT 客户端预设为 1536×768，不因同名模板而串表。缺少固定尺寸组合应报错；auto 不承诺固定像素。
5. 自定义 HD 枚举协议仅发送其声明字段，仍能提交；无能力声明不因目录同名而增加请求参数。Sora2U 缺能力的旧引用仍获得完整目录能力。素材上限、图片质量／背景、批量、首尾帧及视频编辑限制须回归。
6. 读取 media_model_parameters：图片尺寸表与当前选择一致，不出现 Key、连接地址或执行协议。已有任务继续查询原回执；本轮改动不触发真实数据迁移。
7. 在 ToAPIs／LibAPI／Amam／Sora2U／GRSAI 分别核对已绑定型号：渠道原默认值、候选顺序及素材限制不变；未声明的首尾帧、音轨、质量或批量不增加。GRSAI GPT 的 1K／16:9 基础版为 1672×941，Flare 的 2K／4:3 为 2304×1728，能力查询与原请求一致。
8. RunningHub 核对普通生图及 Seedance／H3 参数表，确认渠道额外档位、自动时长、令牌时长和大小写仍可选；相似名称但未审计的专有端点不受影响。改动某个测试连接后，其他同型号连接及已保存用户声明保持独立。

在仓库根目录复跑本轮 32 个测试文件：

```powershell
$files = @(
  'tests/services/modelCapabilityTemplates.test.ts', 'tests/services/modelCapabilityTemplateCompatibility.test.ts',
  'tests/services/imageModelTemplates.test.ts', 'tests/services/googleModelManifest.test.ts',
  'tests/services/mediaModelCapabilities.test.ts', 'tests/services/modelProtocol.test.ts',
  'tests/services/modelRequestTransport.test.ts', 'tests/services/relayonModelManifest.test.ts',
  'tests/services/videoModelCapabilityResolver.test.ts', 'tests/services/seedanceModelCapabilities.test.ts',
  'tests/services/h3ModelCapabilities.test.ts', 'tests/services/volcengineVideoModels.test.ts',
  'tests/services/generateVideo.test.ts', 'tests/services/chat/mediaTools.test.ts',
  'tests/services/providerCatalogService.test.ts', 'tests/services/providerCatalogCache.test.ts',
  'tests/components/providerConnectionModels.test.ts', 'tests/components/relayonGroupConnection.test.tsx',
  'tests/components/videoParamSelectorProtocol.test.ts', 'tests/services/aigcsiModelManifest.test.ts',
  'tests/services/libapiModelManifest.test.ts', 'tests/services/toapisModelManifest.test.ts',
  'tests/services/sora2uModelManifest.test.ts', 'tests/services/sora2uVideoRuntime.test.ts',
  'tests/services/grsaiMedia.test.ts', 'tests/services/imageRequestContracts.test.ts',
  'tests/services/toSeedanceCapabilityView.test.ts', 'tests/services/mediaParameterMappings.test.ts',
  'tests/services/chat/providerConfigDraftService.test.ts', 'tests/services/runninghubModelManifest.test.ts',
  'tests/services/runninghubMediaRouting.test.ts', 'tests/services/imageSingleRequestBatch.test.ts'
)
npx vitest run @files
```

## 回滚

撤销本轮公共模板、渠道构造与尺寸源调用点变更即可，无数据库或真实项目迁移需要反向执行。不删除用户连接、素材、已生成文件或任务记录；已保存的显式能力仍按原记录解释，既有任务继续沿原协议与回执恢复。

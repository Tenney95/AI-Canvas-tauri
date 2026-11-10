# 图片与视频型号参数、尺寸同源管理

状态：2026-11-10 已通过相关 24 个文件、1356 项 Vitest 用例；完成静态复核。未运行类型检查、lint、构建、桌面或真实模型调用，桌面行为待用户验收。

## 决策与来源

按“精确型号能力 → 渠道限制 → 请求字段映射”组织现有能力，不以显示名称推断另一个渠道的合同。相同 Seedance 版号复用基础比例；渠道支持范围、首尾帧、视频编辑和音频组合限制继续显式声明。图片档位不等于所有型号通用的固定长边或短边；具体像素优先取已确认尺寸表，布局估计与实际产物尺寸分开。

核对的公开主来源：

- [火山视频任务 API](https://docs.volcengine.com/docs/ark/create-video-generation-task-api?lang=zh&redirect=1)：Seedance 2.5 的首尾帧、编辑与延长限制，比例及自动时长语义。官方完整能力与万象渠道支持范围分别保留。
- [火山图片教程](https://docs.volcengine.com/docs/ark/image-generation-tutorial?lang=zh&redirect=1)：Seedream 各型号档位不同；档位与明确宽高是不同参数方式，参考尺寸不等于所有渠道保证的实际尺寸。
- [Google 图片生成规格](https://ai.google.dev/gemini-api/docs/image-generation#aspect-ratios-and-image-size)：核对 Nano Banana 原版、Pro、2.1 的完整像素表。例如 Pro 的 2K／16:9 为 2752×1536；不沿用通用短边 2048 公式。
- [Google 官方 SDK](https://github.com/googleapis/python-genai)、[火山官方 SDK](https://github.com/volcengine/volcengine-python-sdk)：核对型号能力与传输字段分属不同层；不因共用能力而替换已有 generateContent、Interactions 或中转协议。
- [OpenAI 图片生成文档](https://developers.openai.com/api/docs/guides/image-generation)：GPT 客户端像素预设遵守对应型号的尺寸约束；应用预设不是官方允许尺寸的穷举列表。
- [APIMart GPT 2.5](https://docs.apimart.ai/cn/api-reference/images/gpt-image-2.5/generation)、[ToAPIs GPT 2.5](https://docs.toapis.com/docs/cn/api-reference/images/gpt-image-2.5-official/generation)：保留仓库已核对的渠道尺寸合同，不将其自动改为官方模板数值。本轮未重新执行各渠道真实调用。

万象的五种常用比例来自用户本轮截图确认：16:9、9:16、4:3、3:4、1:1。其公开文档本轮抓取不可用，不将截图确认写成平台实测通过。

## 实现边界

- `services/ai/modelSizeProfiles.ts` 集中命名尺寸表并返回隔离副本：官方 GPT、APIMart、ToAPIs、万象 Image 2／2.5 和已核对的 Google 型号。不同渠道的同名尺寸不混用；相同像素行可复用。
- 图片模板、内置图片构造和声明式生成共用尺寸解析。显式表缺少固定组合时拒绝，不能静默降档。auto／adaptive 只估计布局，真实宽高仍由文件确认。既有 HD 等自定义枚举没有精确表时保留旧布局估计，不阻止只接收枚举的自定义协议。
- `resolveImageParameterCapability` 和 `resolveImageExecutionCapability` 共用有效能力；后者移除仅用于隐藏控件的空数组。显式用户声明仍接受原协议校验。未匹配内置合同的自定义协议不继承目录的整套尺寸、批量及参考能力；CCC 已有按实际变量选择候选的兼容规则继续保留。
- 视频参数面板、生成预检及 Agent／MCP 的能力入口共用 `resolveConfiguredVideoCapability`。保留 Sora2U 完整目录兜底，再应用联合名额。旧节点按实际绑定连接解析，不因旧 provider 名称串用另一条连接。
- 万象官方四款、A 两款、2.5 C1 及原有 2.0 C1／C2／C3 的基础比例共用 Seedance 来源。原请求分别映射到 metadata.ratio、output.aspect_ratio 或 aspect_ratio，不改接口层级；C3 带音频的额外限制保留。
- 仅七款确曾发布单项 16:9 默认值的完整旧能力快照可临时补正。缺省比例也须匹配其余完整能力；用户修改过的时长、参考限制、输入模式、其他显式比例以及自定义协议不扩宽。能力整体缺失且完整命中内置协议时可读取当前合同副本。2.0 C1／C2／C3 原本已支持五项，不能把其单项显式限制误判为旧默认。
- Agent／MCP 的图片能力查询补充已声明的 dimensionPresets，只传参数与尺寸，不暴露连接地址、协议或凭据。
- CCC 旧 Pro／Gemini 3.x 别名与当前香蕉目录共用三档候选，参数面板和生成均保留 2K／4K；用户改写协议时仍按实际提交变量隐藏无效选项。CCC 没有本渠道精确尺寸表时不继承 APIMart 同名表，标准 Images 保留既有像素换算与对齐。

不修改数据库版本、连接身份、原任务回执、用户节点参数或正式迁移开关；不自动迁移项目或搬动真实素材。已保存的自定义模板不自动重写，更新完整模板需用户显式重新应用。

## 默认模板实际共用范围

当前不是所有中转站都调用同一套默认参数模板。统一解析入口、共享某张尺寸表、共用完整型号能力是不同范围；本轮源码审计如下。

| 渠道 | 视频默认能力 | 图片默认能力／尺寸 |
|---|---|---|
| APIMart | Seedance 2.x 与 doubao 别名复用公共模板 | GPT 2.5／2.6 共用渠道尺寸表；其他图片能力仍独立 |
| 万象 | Seedance 共用五比例；时长、档位与输入能力仍独立 | Image 2／2.5／2.6-01 用集中尺寸源；Nano、Seedream、MJ 仍有本地渠道表 |
| ToAPIs | 精确 SKU 独立声明与修正 | GPT 2.5 VIP／official 用集中尺寸源，其他能力独立 |
| LibAPI | 渠道快照派生 | 渠道快照与本地精确像素表派生 |
| CCC | 未内置 Seedance 2.x | 现行及旧香蕉别名共用本渠道候选；GPT 参数仍独立，无已确认像素时不借其他渠道表 |
| Amam／AIGC SI | 独立能力清单 | GPT／Nano 独立能力清单 |
| Lec | Seedance 复用模板机制；四个已知 SKU 仍有渠道覆写 | 无独立图片清单，需用户显式应用图片模板 |
| Sora2U | 独立能力与联合参考名额 | 未声明精确 GPT／Nano SKU |
| GRSAI | 无 Seedance 2.x，现有 H3 独立 | 独立能力及两张 GPT 请求像素表 |
| RunningHub | 每个端点的参数 schema | 每个端点的参数 schema，不走普通模型快速模板 |

因此，“所有同版号模型的共同基线集中管理，再显式覆写渠道差异”尚未全部完成。剩余主要为万象的完整 Seedance 能力、ToAPIs／LibAPI／Amam／Sora2U 视频，以及各渠道 Nano 和 GRSAI 图片尺寸声明。不能将这些独立合同全部覆盖为官方参数，也不能把本轮测试通过写成全部默认数据已统一。

## 本轮自动化验证

首次执行原列出的 11 个核心文件，共 937 项：924 通过、13 失败。定位并修正 CCC 旧别名的单项 1K 误限制、CCC 继承 APIMart 像素表，以及未知型号空能力返回的回归；未通过改写原请求尺寸断言掩盖渠道差异。

修正后运行核心 11 文件，并追加 `providerCatalogService`、`providerCatalogCache`、`providerConnectionModels`、`relayonGroupConnection`、`videoParamSelectorProtocol`、`aigcsiModelManifest`、`libapiModelManifest`、`toapisModelManifest`、`grsaiMedia`、`imageRequestContracts`、`toSeedanceCapabilityView`、`mediaParameterMappings`、`chat/providerConfigDraftService`：24 文件、1356 用例全部通过。请求测试使用受控响应，没有真实计费或迁移用户数据。未运行完整前端 CI、Rust、类型检查或桌面验收。

## 仍需区分的未知尺寸

Google 3.1 Flash 的 512／21:9 官方正文给出 792×168，与比例不一致。本轮不推算替换，也不把该表作为已确认的精确尺寸源。Banana 2 的既有估算、未确认的 Flash Lite 与各渠道无固定尺寸表的合同继续保留，不能据此声称全部型号像素已实测。渠道自适应、参考映射及未知枚举的最终尺寸均以返回文件为准。

## 待用户验收

前置：使用 Tauri 桌面端，准备测试项目和所需连接；先检查参数面板与请求预览。网络生成可用受控接口替代，真实模型调用由用户自行决定。

1. 已保存的万象视频连接无需重建：逐一切换官方四款、A 两款、2.5 C1 与 2.0 C 系列，默认合同应显示截图五项。旧节点已选的合法比例保持；切换同版号渠道后选项来源一致。
2. 选择 9:16、4:3 与 1:1，核对节点／对话／Agent／MCP 的选择和提交参数；官转、A、C 系列分别进入原字段层级。C3 带音频的 4:3 与非法时长仍应在上传和提交前拒绝。
3. 修改过协议、时长或模式的旧万象模型及同名自定义连接保持原配置。2.0 C1 的显式单项比例不扩宽；切换／重启／导出配置不应将运行期补正写回原记录。
4. 显式套用 Google 原版／Pro／2.1 模板，核对各档位像素；Pro 2K／16:9 应取 2752×1536。APIMart GPT 2.5 的 1K／2:1 应取 2048×1024，官方 GPT 客户端预设为 1536×768，不因同名模板而串表。缺少固定尺寸组合应报错；auto 不承诺固定像素。
5. 自定义 HD 枚举协议仅发送其声明字段，仍能提交；无能力声明不因目录同名而增加请求参数。Sora2U 缺能力的旧引用仍获得完整目录能力。素材上限、图片质量／背景、批量、首尾帧及视频编辑限制须回归。
6. 读取 media_model_parameters：图片尺寸表与当前选择一致，不出现 Key、连接地址或执行协议。已有任务继续查询原回执；本轮改动不触发真实数据迁移。

回归源码覆盖尺寸副本隔离、渠道差异、动态画幅、图片执行能力投影、旧万象快照、自定义连接隔离、三类视频请求层级和 Sora2U 兜底。核心 11 文件可在仓库根目录复跑（本轮另追加上述 13 文件）：

```powershell
npx vitest run tests/services/imageModelTemplates.test.ts tests/services/googleModelManifest.test.ts tests/services/mediaModelCapabilities.test.ts tests/services/modelProtocol.test.ts tests/services/modelRequestTransport.test.ts tests/services/relayonModelManifest.test.ts tests/services/videoModelCapabilityResolver.test.ts tests/services/seedanceModelCapabilities.test.ts tests/services/volcengineVideoModels.test.ts tests/services/generateVideo.test.ts tests/services/chat/mediaTools.test.ts
```

## 回滚

撤销本轮能力解析、尺寸源与调用点变更即可，无数据库或真实项目迁移需要反向执行。不删除用户连接、素材、已生成文件或任务记录；其他任务已有的转场入口改动独立保留。

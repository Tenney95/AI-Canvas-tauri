# ToAPIs 内置厂商接入

状态：源码与回归用例已实现；提交阶段按仓库规则由钩子执行定向 ESLint。本次未运行自动化测试、类型检查、构建或桌面实机验收，待用户验收。未发起付费模型调用，未修改原生安全权限、依赖或数据库。

## 连接与目录

- 复用既有 `ProviderDefinition`、通用模型与凭据存储；一个 ToAPIs 连接选择 `https://toapis.cn/v1`（默认）或 `https://toapis.com/v1`。Key 共用，切换不清空；链接使用所选域名的 `/login?aff=SnMr`。
- 切换站点或修改 Key 取消进行中的目录请求，迟到结果不能回写。取消弹窗不保存。拉取成功后剔除当前站点未返回的型号及选择，保存实际站点；错误不跨域回退、不伪装成本地目录验证成功。
- 文本只匹配用户指定 ID：`gemini-3.8-flash`、`gemini-4-argon`、`qwen3.8-flash`、`deepseek-v4.1-flash`、`gpt-6.1-sol`、`grok-4.7`、`qwen3.8-27b`、`claude-opus-5-5`、`glm-5.3-flash`。缺少的型号不自动换别名、不补入其他文本模型。
- 2026-10-18 从浏览器逐页读取的两站目录均为 158 个型号，当时清单一致。此观察不作为长期权限或目录差异；运行时按当前站点 `/v1/models` 的响应取交集。

## 媒体执行边界

- 76 个已核对图片/视频型号及 Suno 基础灵感生成使用声明式异步任务协议。提交不自动重试；查询遵守 `Retry-After` 和有界退避。视频沿用既有任务持久化、暂停、重试查询与本地交付，不重新提交原任务。
- GPT Image 普通版发送比例与分辨率，2.5 VIP/official 使用像素尺寸；Gemini 普通/VIP 按文档发送 `{url}` 参考图元素，official 等渠道发送 URL 字符串。Seedream 参考图与输出合计不超过 15 张。应用批量图片仍受全局最多 8 张限制；具体渠道声明更低上限时从严限制。
- 视频各型号分别声明分辨率、比例、时长、音频开关及参考素材范围。Seedance/H3 保留图片角色，并完整传送视频/音频列表；H3 参考素材合计最多 12 个。Veo、Wan、Kling、Omni、Vidu、海螺等各自映射帧、参考图和元数据，不根据图片顺序推测尾帧。Kling Omni 引用编号与实际提交列表同步。
- 已声明的组合错误在上传/付费提交前拒绝：首尾帧与普通参考互斥、渠道不接收尾帧、海螺 1080P 搭配 10 秒、Kling 标准档音频限制等。Omni VIP 参考视频时省略不接受的时长；官方 Omni 视频编辑和 Wan 首帧模式按文档省略比例。
- 本地图片、视频和音频分别上传当前站点 `/uploads/images`、`/uploads/videos`、`/uploads/audios`，只使用所属连接 Key；不回退公共图床或借用其他 Key。图片 10 MB、视频/音频 50 MB，并校验文档列出的文件类型。复用既有压缩、串行队列、取消和缓存。
- Suno 当前接入基础灵感模式，提示词描述音乐；生成返回两首候选，既有单音频节点采用首个结果。自定义歌词、续写、人声资产和其他音乐编辑操作不在本批范围。
- 当前九个媒体目录项暂不展示：`nano_banana`、`nano_banana_2`、`nano_banana_pro`、`gemini-3.1-flash-lite-image-official`、`wan3.0-video-prime` 缺少已核对的精确别名/渠道合同；`midjourney` 使用独立状态与交互任务；`viduq3-ad`、`viduq3-drama`、`viduq3-mix` 可能要求结构化主体输入。不得用相似型号的能力和通用协议把这些型号标为可直接执行。

## 源码和回归入口

- 厂商与目录：`src/constants/api.ts`、`src/services/ai/providerCatalogService.ts`、`src/services/ai/providers/toapisModelManifest.ts`。
- 界面与凭据草稿：`ProviderConnectionDialog.tsx`、`providerConnection/ProviderConnectionForm.tsx`；`store.config.ts` 将选中的型号及其能力、协议同步为通用模型，复用现有 Store Action 和原生凭据桥接。
- 菜单：`nodes/shared/defaultModels.ts` 及 `defaultModels.test.ts`，节点与对话共用独立的 ToAPIs 分组，模型引用仍走通用模型身份，遵守各媒体类别可见性。
- 快捷切站：`ApiKeySettings.tsx` 及 `apiKeyDeletionPersistence.test.tsx`，ToAPIs 和 RunningHub 卡片复用 UI Kit 分段按钮与既有凭据保存链路；模型勾选保留，ToAPIs 共享 Key，RunningHub 使用各站独立 Key，空站点仍可切回。桌面验收步骤见模块文档的快捷切换说明。
- 生成与素材：`generateImage.ts`、`generateVideo.ts`、`uploadService.ts`。不修改其他厂商的提交协议和上传策略。
- 用例：`toapisModelManifest.test.ts`、`providerCatalogService.test.ts`、`modelRequestTransport.test.ts`、`generateVideo.test.ts`、`providerConnectionForm.test.tsx`、`toapisConnection.test.tsx`。原范围中的 `mediaUploadService.test.ts` 属于 MCP 文件接收，与厂商上传无关，未修改。

## Tauri 桌面验收

1. 设置 → API Key → 添加厂商 → ToAPIs，预期只有一个厂商入口，默认国内站。填写 Key 后切换国际站再切回，Key 不变；分别打开控制台，预期域名正确且邀请参数为 `aff=SnMr`。
2. 在两站分别拉取，预期只显示响应中存在的已适配型号；文本不超出上述九个 ID。拉取期间切站并重新拉取，旧请求结果不能覆盖新目录。测试无效 Key、断网和取消，不应跨站重试或提示验证成功。
3. 勾选图片、视频和音乐型号并保存；重启后站点与选择保留，节点菜单出现同一个 ToAPIs 厂商。取消一次站点编辑，预期原站点/选择不变。
4. 用户自行选择是否付费验收：GPT Image 普通/VIP、Gemini VIP、Seedream 分别提交一张本地参考图；请求中的尺寸、图片类型与所选站点一致，结果保存本地。分别测试视频普通参考和显式首尾帧，不应把普通参考当首帧或尾帧。Seedance 2.5 同时连接图、视频、音频，预期素材完整传送。
5. 异常回归：文件超限、类型不符、缺 Key、H3 素材合计超限、渠道不支持的尾帧或帧/参考混合应在提交前提示具体修改项。确认其他厂商 Key 未被使用，其他厂商仍沿用原行为。
6. 用户付费验收慢视频时，已有任务查询超时应暂停；重试只查询原任务 ID，成功后保存。Suno 用提示词生成音乐，预期采用音频结果而非封面。切换深浅主题、缩小窗口检查站点选择可见且菜单不被裁剪。

提交钩子执行暂存 TypeScript 文件的定向 ESLint；如用户另行授权，在仓库根目录运行上述回归文件的定向 Vitest 及 `npm run typecheck`。本批未执行测试和类型检查。

## 资料

- [模型目录](https://docs.toapis.com/docs/cn/api-reference/models)、[列出模型](https://docs.toapis.com/docs/cn/api-reference/chat/list-models)。
- [GPT Image 2.5 普通](https://docs.toapis.com/docs/cn/api-reference/images/gpt-image-2.5/generation)、[VIP](https://docs.toapis.com/docs/cn/api-reference/images/gpt-image-2.5-vip/generation)、[official](https://docs.toapis.com/docs/cn/api-reference/images/gpt-image-2.5-official/generation)。
- [Gemini VIP](https://docs.toapis.com/docs/cn/api-reference/images/gemini-3.1-flash-vip/generation)、[Seedance 2.5](https://docs.toapis.com/docs/cn/api-reference/videos/seedance-2-5/generation)、[H3](https://docs.toapis.com/docs/cn/api-reference/videos/minimax-h3/generation)、[Vidu Q4](https://docs.toapis.com/docs/cn/api-reference/videos/viduq4-preview/generation)。
- [图片上传](https://docs.toapis.com/docs/cn/api-reference/uploads/images)、[视频上传](https://docs.toapis.com/docs/cn/api-reference/uploads/videos)、[音频上传](https://docs.toapis.com/docs/cn/api-reference/uploads/audios)、[音乐生成](https://docs.toapis.com/docs/cn/api-reference/audios/suno/generation)、[音乐查询](https://docs.toapis.com/docs/cn/api-reference/tasks/music-status)。

## 回滚

撤销本批源码和文档即可；无依赖、权限或数据库迁移。已保存的 ToAPIs 连接记录和 Key 按既有凭据存储保留，不自动删除。未完成生成任务仍使用已持久化的查询描述，不因界面回滚而自动重提。

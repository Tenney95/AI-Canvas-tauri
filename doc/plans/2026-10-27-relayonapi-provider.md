# RelayOnAPI 图片与视频接入

状态：基础接入已提交（`63ec27a6`）；普通 2.5 质量／透明背景、配置初始化保护、分组管理与后续三个视频型号已有实现。2026-11-06 补齐 MJ 五款的四候选交付与 `image-2.6-01` 兼容配置，待用户验收；本批未运行测试、lint、类型检查、构建、桌面验收或付费调用，不沿用旧批次的检查结果宣称本批通过。

## 范围与依据

- 4 文本：Gemini 3.8 Flash、Gemini 4 Argon、GPT 6.1 Sol、Claude Opus 5.5。
- 15 图片：`image-2-01`、`Image-2.5-Flare`、`image-2.5-flare-01`、`Image-2.5-Sunburst`、`image-2.5-sunburst-01`、`image-2.6-01`、`Midjourney v6`、`Midjourney v6.1`、`Midjourney v7`、`Midjourney v8.1`、`Midjourney v8.2`、`nano-banana-2`、`nano-banana-2.1`、`nano-banana-pro`、`Seedream 5.0 Pro`。
- 11 视频：`doubao-seedance-2-0-260128`、`doubao-seedance-2-0-fast-260128`、`doubao-seedance-2-0-mini-260615`、`doubao-seedance-2-5-260628`、`sd-2.0-A`、`sd-2.5-A`、`sd-2.0-c1`、`sd-2.0-c2`、`minimax-h3`、`sd-2.0-c3`、`sd-2.5-c1`。三款后补视频已有正确 `video` 分组；2.5 C1 仍按用户确认的 2.5 A 兼容合同，独立站点合同待实测。
- 未接未公开的音频生成、视频编辑或样片流程。未添加依赖、原生能力、安全权限或数据库迁移。

来源为 [官网目录](https://relayonapi.com/api/pricing)与[型号文档](https://relayonapi.com/docs)，关键示例见 [Image 01](https://relayonapi.com/docs?model=image-2-01)、[Flare](https://relayonapi.com/docs?model=Image-2.5-Flare)、[Nano Banana](https://relayonapi.com/docs?model=nano-banana-2)、[Seedream](https://relayonapi.com/docs?model=Seedream%205.0%20Pro)、[官转 2.5](https://relayonapi.com/docs?model=doubao-seedance-2-5-260628)、[A](https://relayonapi.com/docs?model=sd-2.0-A)、[C1](https://relayonapi.com/docs?model=sd-2.0-c1)、[C2](https://relayonapi.com/docs?model=sd-2.0-c2)。

官网只标明兼容协议，缺少该站完整实际响应样例。用户确认先采用 [OpenAI Images 标准返回](https://developers.openai.com/api/reference/resources/images/methods/generate)及 [Videos 标准状态](https://developers.openai.com/api/reference/resources/videos/methods/retrieve)，辅以官网明确列出的三个视频 URL 字段。此为兼容实现依据，尚不是本站端到端验证结论；不借用其他部署的响应、尺寸或权限合同。

## 执行边界

厂商定义、模型 manifest 和策略表仍是主要接线入口。默认展示候选，不自动勾选；远端刷新以当前 Key 的实际目录求交，错误不变成本地验证成功。文本、图片、视频共用节点和对话菜单同步。

图片为同步生成及 JSON 编辑，参考图保留顺序并通过现有内联通道处理，不经公共图床。厂商上限为 8／10／16 张，但当前应用内联通道只支持 6 张、单张 8 MiB、合计 24 MiB，本批能力和提交前检查采用这一有效上限，不静默截断，也不放宽内存保护。当前内置合同完整匹配时才切换生成／编辑路径，用户改过的协议保持原值。尺寸采用该型号公布的精确像素表；Seedream 首批只开放完整矩阵的共同六比例。单请求 `n=1`，批量沿用应用调度；不以异步返回不足为理由补交生成。

普通 `Image-2.5-Flare` 和 `Image-2.5-Sunburst` 是本次唯一补充质量和背景的型号。官网明确这些字段原值透传；用户确认先提供当前 OpenAI Images 2.5 的兼容候选 `auto/low/medium/high/xhigh/max` 和背景 `auto/opaque/transparent`，不把它们标为该平台已实测枚举。两项默认均不新增请求字段；只有用户选择时发送 `quality`／`background`，透明额外要求 PNG。`-01`、Nano、Seedream 不套用；比例、分辨率及其他请求字段不因选择质量或背景改变。

针对旧保存的普通两型号，识别完整旧模板或完整新模板后，以临时有效副本补齐参数映射与能力；参数 UI、生成及保存／导入校验使用同一副本。原始保存、导出配置不自动改写。修改过的协议不因名称匹配而被覆盖，原安全校验依旧先执行。编辑初始化只为 RelayOnAPI 启用“缓存／已选配置优先”的合并选项，不更改其他厂商或常规目录刷新优先级。

视频四种官转合同使用字符串 `seconds` 与 `metadata`；A 使用字符串 `seconds`、`output` 和普通 `references`；C1／C2 使用顶层 `duration`、`resolution`、`aspect_ratio` 与普通 `references`。不把其他渠道的同名参数套过来。C2 不接视频参考；未公布的首尾帧、比例或纯音频素材组合不开放，角色与组合错误在上传前拦截。本地视频参考沿用已有公共上传，最终 JSON 仅接受 HTTPS 素材；不制造专用 Files API，也不向公共图床传递 RelayOnAPI Key。

C1 按最终媒体顺序编译 `@图N`、`@视频N`、`@音频N`；C2 保留其合同使用的“图片N／音频N”。官网 A 渠道的 multipart `first_frame`／`last_frame` 未接入当前 JSON 普通参考，不能据此推测首尾帧的 JSON 字段或混用规则。其他部署的响应、尺寸或权限不能作为本站实测依据。

共享执行器的幂等身份只进入新媒体提交的固定 `Idempotency-Key`，不进入持久化协议、轮询、结果下载或凭据。请求构建两次仍复用同一键；新调用用新键，不自动重试 POST。视频复用 `PendingTask`、取消、暂停、原任务恢复、保存和回填确认；只在真实厂商且完整匹配内置视频合同的查询描述中补入明确的 URL 备用路径，其他厂商和用户协议保持原行为。

### MJ 四候选与 2.6 补充（2026-11-06）

逐页核对 [MJ v6](https://relayonapi.com/docs?model=Midjourney%20v6)、[v6.1](https://relayonapi.com/docs?model=Midjourney%20v6.1)、[v7](https://relayonapi.com/docs?model=Midjourney%20v7)、[v8.1](https://relayonapi.com/docs?model=Midjourney%20v8.1)、[v8.2](https://relayonapi.com/docs?model=Midjourney%20v8.2)：前三款只有 1K，后两款为 1K／2K；十种比例使用该型号的精确像素表，尺寸仅选择画幅／档位，实际像素以返回结果为准。每次最多一张参考图，支持 URL／data URI 的 JSON 编辑，生成与编辑分别走 `/v1/images/generations` 和 `/v1/images/edits`。未完整公布的 quality、style、seed、stylize、chaos、weird、HD 枚举不新增控件或推测请求字段；不把 GPT 的质量或透明参数套给 MJ。

MJ 的 `n` 为作业次数，不是候选图张数。应用每次提交固定 `n=1`，四张返回全部保留，URL／Base64 沿用已有兼容响应解析。长按发送选择 2～8 次作业，复用串行调度；一次点击四图、三作业十二图，不能为凑足图片补交生成。作业数与期待输出数分开记录；四图共享一个原任务回执，并有稳定的输出序号、产物与消息身份。四张都保存、所有所需节点回填及消息持久化成功后才确认；部分失败保留整组，继续保存只取原结果，不重复节点、消息或历史。对话拆为四条既有单媒体消息，不新增持久化嵌套输出结构；项目包仍遵循现有只导出对话文本的边界，画布四节点沿用既有素材导出。

`image-2.6-01` 在官网 `image` 目录可见且标注 1K／2K／4K，但本轮详情与独立文档均无法加载能力。用户明确确认先按 2.5 一样接入，因此复用现有 2.5-01 参数与像素表、同步生成／编辑和 URL／Base64 返回；未将普通 2.5 独有质量／背景候选套入。参考数量及参数接受情况属于兼容待验收，不写成官方已验证能力。

新增六款图片只属于 `image`，已保存连接和节点不自动启用或改写 ID。完整匹配内置 MJ 合同且连接身份为真实万象时才使用固定四候选规则；同名自定义连接、用户修改的协议保持原样。保留兼容的用户比例／分辨率、原连接地址、任务 origin 与分组 Key 隔离，不因示例出现 API 子域而迁移旧任务。

固定四候选仅在能接收完整产物组的图片节点、提示词和对话／MCP 生成入口开放。动画、全景、分镜单帧和插件等仍只消费一个图片结果的入口，在提交前明确拒绝固定多候选合同，不付费后再丢掉额外三张。HTTP(S) 结果使用现有无密钥交付记录续存；Base64 不写入任务存储，四图在本次调用中完整保存并各自记录状态，但无远端任务 ID 且内联结果未保存时，不能保证跨重启恢复或重新查询。任务和文件存储边界不因接入 MJ 放宽。

原对话消息已承载另一轮结果时，旧任务追加四条恢复消息并转为仅对话交付，明确提示可逐图添加到画布；不能在第二次续取时重新绑定并覆盖新图。显式再次生成导致旧任务移到待恢复节点时，产物组身份沿同一尝试保留，已成功的候选文件继续复用。

## 分组连接与迁移

`src/services/ai/relayonProviderGroups.ts` 管理 ClaudeMax号池、GPTpro号池、Gemini号池、default、image、video 六个可见候选分组，各组以独立连接保存 Key 和模型，统一入口汇总。候选取应用适配清单、Key 实际模型目录及公开分组目录的交集；公开目录请求不附带 Key，目录可见不代表具备调用或计费权限。2026-10-27 的分组快照中 default 没有已适配候选，不自动补入其他组模型。

旧连接不推断分组，用户明确指定后保留原连接 ID、Key 与已保存配置；同组多条连接各自保留，不按组名合并。单组删除只处理所选连接，统一入口删除须确认。配置分享保留分组但不携带凭据；待恢复任务仍绑定原连接及原任务身份，只读取当前 Key 查询，不自动重投。用户更换 Key 后能否查询旧任务由平台权限决定。

分组代码已实现，原专项未执行自动化、桌面或真实调用验收。以下步骤是待执行清单，不是本次整理的新授权。

## 验收

本次质量／背景补充完成源码、引用、差异空白与 UTF-8 静态复核；提交按仓库钩子执行改动文件的定向 ESLint。测试、类型检查、构建、Tauri 实机及真实厂商调用均未运行。

不付费：新建厂商确认 30 个默认候选均未勾选；填 Key 后拉目录，勾选各类模型并保存，确认节点和对话按正确类别显示、重启保持勾选。错误 Key／断网时旧目录和选择保留，不能提示远端验证成功；显式自定义且同名的连接不继承本厂商白名单、上传或幂等策略。切换模型保留用户比例，不支持的值应明确拦截。

分组的无付费回归：添加万象 API 后逐组核对独立 Key 输入、候选和 default 空提示；分别保存图片／视频分组，检查节点、对话和 MCP 按选中连接显示对应组。给旧连接指定分组，确认与同组新连接并存，连接 ID、高级参数及用户协议不被覆盖。断网或无效 Key 保留原候选；单组删除不影响其他连接，统一删除需确认；复制／导出配置不含 Key。对已有任务只检查恢复仍使用原连接和任务身份，平台查询权限另行验收。

质量／背景的无付费回归：已有旧连接无需重建或重新拉取，普通 Flare／Sunburst 的图片参数弹层应显示六档质量和背景选择；原 9:16、1K 保持不变，未选参数仍沿用接口默认。选 `high` 与透明后，摘要及节点参数应保留选择，关闭重开、重新生成和批量通路仍传同一参数；切换到 `-01`／Nano 不显示不支持的控件。编辑用户自定义过的普通两型号时，缓存和保存配置优先于新模板，取消无写入、保存和分享保留原协议；非法路径仍在配置校验时拒绝。UI Kit 的品牌色样式不另造分支。

以下真实生成由用户自行决定执行，会产生厂商计费：

1. 选择 Image 01，16:9、2K，无参考生成一次；预期请求像素为 2048×1152，返回后保存并展示。单张参考编辑应切换到编辑端点，内联参考不经公共图床；超过上限在提交前拒绝。
2. 选择一款 Nano Banana 与 Seedream，核对各自像素及参考数量；Seedream 不应把不存在的 1K／2:3 规格发送给平台。
3. 官转视频生成 4 秒、480p、16:9，确认只提交一次并保存任务 ID，完成后从官方 URL 保存、回填并结束加载。A 与 C1 分别核对参数层级；C1 参考编号与最终图片／视频／音频顺序一致，C2 接视频参考应在上传和生成前拒绝。
4. 任务取得 ID 后断网或暂停，再继续查询；应复用原 ID、不出现新 POST。查询返回三种已公布 URL 字段任一种均应取回；返回陌生结构不能伪称成功，任务应保留。结果保存或回填失败后继续取回，不能重新扣费生成。
5. 更换 Key、切换项目、手动取消和重启后恢复，核对连接身份和目标守卫；临时链接过期应明确报错。提交响应丢失且无 ID 时到平台核对，不换幂等键自动重发。
6. 仅在用户决定付费验收时，对普通 Flare／Sunburst 各检查无参考文生和单图编辑：选择 `high`、透明，预期请求含相同值及 PNG 输出要求，产物原图应为保留 alpha 的 PNG。未选两项时不应额外发送字段；自动／不透明背景不强制附加 PNG。平台若拒绝某兼容档位，应保留真实错误，不伪称成功或自动换档重投。

本次补充的回归源码：`relayonModelManifest.test.ts`、`mediaModelCapabilities.test.ts`、`modelRequestTransport.test.ts`、`providerCatalogService.test.ts`、`providerConnectionModels.test.ts`；覆盖完整旧模板、缺字段的模型缓存、用户自定义协议、默认省略和透明 PNG。基础接入另有 `providerPolicies.test.ts`、`defaultModels.test.ts`、`generateVideo.test.ts`、`modelProtocol.test.ts`。有相应授权后可在仓库根目录运行对应文件的定向 Vitest，本轮未执行。

### 本轮 MJ／2.6 桌面验收

前置：Tauri 桌面打开项目，准备具有 `image`／`video` 权限的独立万象连接。先只检查配置：设置 → API Key → 万象 API → 对应分组重新拉取，图片应新增六款且未自动勾选，视频仍有 `minimax-h3`、`sd-2.0-c3`、`sd-2.5-c1`。保存后检查节点、对话与 MCP 的模型目录，不能跨组串 Key；取消编辑、旧协议、同名自定义连接及兼容的用户比例／分辨率保持原状。

以下需要真实模型或受控测试服务，由用户决定执行；真实模型会计费：

1. MJ v6／v6.1／v7 仅显示 1K，v8.1／v8.2 可选 1K／2K；各自十比例与型号表一致。点发送应提示一次四候选；长按选 3 次作业，只有三次 `n=1` 提交、十二个完整图片结果及相应历史，不把 `n` 发成 12。单张参考走编辑端点；两张参考提交前拒绝。
2. 用受控服务返回四个图片 URL，令第三张下载失败：其他图片可保留，整组原回执继续存在。点击继续保存，只重试原结果，不新增生成 POST、不重复节点、消息或历史。再模拟取消、换项目、删目标和新一轮生成，旧结果不能写入错误目标。
3. 在普通对话及 Agent／MCP 分别生成一次，检查四条独立图片消息；需要画布时交付四个节点。任一图片保存或消息持久化失败，不能用首张成功清回执；从子消息继续也应恢复同一组。仅对话产物沿既有项目包文本导出边界，不据此承诺图片归档。
4. 分别返回 URL 与四项 Base64，检查当次交付不截图、不丢图。Base64 保存失败逐项显示失败；无远端 ID 时不承诺重启后重取，不把大 Base64 或 Key 写进 PendingTask。动画、全景、插件或单帧入口使用固定四候选模型应在 POST 前拒绝。
5. `image-2.6-01` 先检查与现有 2.5-01 一致的参数装配，再由用户决定验证文生／单图编辑、URL／Base64、1K／2K／4K 和兼容比例。当前仅是用户确认的兼容合同，平台拒绝字段时保留原错误，不自动换模型、改参数或重投。

本批只补 `relayonModelManifest`、`providerCatalogService`、`mediaModelCapabilities`、`modelRequestTransport`、`modelProtocol`、`pollManager`、`imageBatchService`、`generationServiceReplicaLease`、`generationRuntime`、对话执行／媒体工具和节点／分组交互回归源码；没有运行自动化检查。需要自行运行时，在仓库根目录执行 `npx vitest run tests/services/relayonModelManifest.test.ts tests/services/modelRequestTransport.test.ts tests/services/pollManager.test.ts tests/services/imageBatchService.test.ts tests/services/generationRuntime.test.ts tests/services/chat/conversationExecutionController.test.ts tests/services/chat/mediaTools.test.ts tests/components/nodeCriticalInteractions.test.tsx tests/components/relayonGroupConnection.test.tsx`。这不是已通过结论。

## 回滚

撤销本批代码即可移除本轮媒体候选、分组界面及公共执行器的新增可选字段，不删除已有连接、凭据或任务记录。旧记录不包含新增字段时沿用原轮询行为；分组回退不合并连接或改写任务身份，不得为回滚清空其他任务改动。

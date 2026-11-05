# MiniMax 官方 H3 与语音接入

日期：2026-11-05。状态：已实现并补回归源码；本批未运行测试、lint、类型检查、构建、桌面验收或付费调用，待用户验收。本批仅本地提交，不推送。

## 目标与边界

解决自定义 H3 调用依赖公共图床时，上游服务端可能无法读取参考素材的问题。增加官方连接并复用现有 H3 模板、厂商策略、音频参数控件和媒体交付恢复，不迁移或改写原自定义连接。本批不新增依赖、Rust 命令、权限或数据库结构；凭据沿用原生 secret_store。

内置六个候选，不自动勾选：

| 模型 | 输出规格 |
|---|---|
| MiniMax-H3 | 768P／2K，4–15 秒整数 |
| MiniMax-H3-Highspeed | 480P／768P，4–15 秒整数 |
| MiniMax-H3-Lite | 480P／768P，4–15 秒整数；参考模式不开放 adaptive |
| MiniMax-H3-Max | 480P／768P，5–15 秒整数 |
| speech-2.8-hd／speech-2.8-turbo | 普通语音合成，音色 ID、0.5–2 倍速、MP3／WAV／FLAC |

国内默认 `https://api.minimax.cn`；国际使用独立连接 `https://api.minimax.io`。接口调用、上传缓存和文件 ID 绑定当前连接，Key 不自动跨站使用。只读连接验证查询系统音色，不调用生成、不伪造 `/models` 目录权限。普通按量账户余额缺少公开查询合同，本批不展示。

## 上传、调用与恢复

- 本地素材经当前连接 `POST /v1/files/upload`，multipart 字段为 `file`、`purpose=video_generation_input`，成功要求 `base_resp.status_code=0` 和有效 `file.file_id`。JSON 数字 ID 在进入 JS Number 前转为字符串，避免 int64 精度丢失。
- 图片接受 JPG／PNG／WebP／HEIC／HEIF，单文件 30 MB；视频 MP4／MOV 50 MB；音频 MP3／WAV 15 MB。继续使用既有受限读取、图片准备、取消、指纹及上传队列。官方上传失败不切 Uguu。
- 官方上传引用为 `mm_file://{file_id}`，有效 7 天；应用上传缓存继续沿用 2.5 小时期限。文件格式／体积在上传前检查，视频／音频时长用原素材校验；官方仍负责完整编解码、尺寸、帧率与内容校验，不能把私有引用交给浏览器探测。
- 已有公网 HTTPS 地址直接发送，不附 Key 给外站。上游无法读取时提示重新导入本地素材再直传；不在失败后自动重交生成，也不自动下载外链转存。手工拼入的私有引用不作为可探测的本地媒体。
- 视频沿用 `POST /v2/video_generation` 和 `GET /v2/query/video_generation/{task_id}`。`task.status` 为 `succeeded` 时取 `task.content.url`，`failed/cancelled` 为终态；网络或查询业务错误保留原任务。查询仅覆盖官方近 7 天任务；过期任务不能保证取回。结果链接失效后重新查询原 ID，使用新链接保存。
- 首尾帧与多参考互斥，尾帧需配首帧；官方对单尾帧说明存在差异，本批保守不开单尾帧。普通参考最多 9 图／3 视频／3 音频，视频和音频各自单条 2–15 秒、各自合计最多 15 秒。不套用中转站的“素材总共 12 份”等未确认限制，不展示未映射的音轨开关。
- 语音 `POST /v1/t2a_v2` 使用 `stream=false`、`output_format=url`，取 `data.audio`。结果 URL 官方有效期 24 小时，取得 URL 后立即走现有保存与续存；返回 URL 前中断的同步请求没有原任务 ID，不能通过再次合成恢复。音色默认为官方示例 `male-qn-qingse`，也可填平台已有音色 ID；参考音频不会隐式创建克隆音色。
- HTTP 200 仍检查业务码；已核实拒绝码直接失败，系统错误或超时保持不确定，不自动重投。原任务恢复校验绑定已保存的官方查询合同，不拿当前改写过的模型配置冒充旧任务合同。

实现入口：`providers/minimaxModelManifest.ts`、`providerPolicies.ts`、`providerCatalogService.ts`、`uploadService.ts`、`generateVideo.ts`、`generateAudio.ts`、`modelProtocolRuntime.ts`、`pollManager.ts`、`testConnection.ts`。音频能力由 `mediaModelCapabilities.ts` 统一给节点／提示词面板／菜单消费，批量、对话及 MCP 复用共享生成入口，不新增工具或权限。MCP 的 `media_generate` 已有音色／格式／语速参数；专属 `media_model_parameters` 查询仍沿用只支持图片／视频的既有边界，本批未新增音频参数发现。通过适配目录保存的 H3 带完整视频能力；不把缺少能力声明的手工模型当作已适配目录。

## Tauri 桌面验收

前置：使用包含本批源码的桌面开发版，准备按量 API Key 和可控预算；需要真实生成的步骤由用户主动执行并承担平台费用。不要把 Key 或完整下载地址贴进日志。

1. 设置 → API Key → 添加厂商 → MiniMax 官方。应显示六个默认候选；填 Key 后点击验证连接，仅查询音色；无效 Key 应明确失败，不因本地目录可见而显示验证通过。保存选中的视频和语音后，在对应节点、对话及 MCP 模型目录可找到。
2. 分别在视频节点引用本地图片、MP4 和 MP3。上传应走当前官方连接，body 使用 `video_generation_input`，生成 content 使用 `mm_file://`；不出现 Uguu 请求。上传取消或失败时不发送生成请求。换 Key、连接或站点不能复用另一作用域的文件引用。
3. 用一张参考图生成 H3 视频，再试多参考模式。核对用户兼容比例、分辨率和时长保留，首尾帧角色不串值。高速度／Lite 不出现 2K，Max 不接受 4 秒，Lite 多参考不出现 adaptive；不允许首尾帧与普通参考混用。
4. 视频生成后模拟短暂断网或本地保存失败。应保留任务 ID，继续查询／保存只 GET 原任务并取新结果地址，不新增生成 POST。远端 `failed/cancelled` 直接失败；查询鉴权失败不能把原任务误清理。
5. 语音节点选 HD／Turbo，填写音色 ID，改变格式和语速后合成；应按已选参数生成并保存音频。切换两款时兼容的声音、语速、格式保留。连入参考音频时提交前提示本批未接声音克隆，不上传素材或扣费创建克隆。
6. 回归已有 LibAPI 语音、其他厂商视频及用户自定义协议；同名自定义连接不能触发 MiniMax 官方上传。分别从单节点、批量、主窗口对话和 MCP 发起用户主动的可控调用，检查调用参数、任务身份和保存回填保持一致。

尚待验证：真实官方上传及长文件 ID、HEIC／HEIF、各视频编解码／尺寸／帧率限制、不同地区网络、实际音色权限、成片声音、音频文件头及跨入口落盘表现。

自动化命令仅供用户后续在仓库根目录执行，本批未运行：

```powershell
npx vitest run tests/services/minimaxModelManifest.test.ts tests/services/providerCatalogService.test.ts tests/services/providerPolicies.test.ts tests/services/modelRequestTransport.test.ts tests/services/generateVideo.test.ts tests/services/pollManager.test.ts tests/services/mediaModelCapabilities.test.ts tests/services/testConnection.test.ts tests/components/defaultModels.test.ts tests/components/nodeCriticalInteractions.test.tsx
npm run typecheck
```

## 回滚

撤销本批代码即可；已有连接、原任务和素材保留，无数据迁移。回滚后本批新增连接失去内置目录／官方上传能力，不清理原凭据或主动重交旧任务。TOS／OSS 公共图床、声音克隆／设计与长文本异步另行规划。

## 官方依据

- [H3 创建任务](https://platform.minimax.cn/docs/api-reference/video-generation-v2-create)、[查询任务](https://platform.minimax.cn/docs/api-reference/video-generation-v2-query)。
- [文件上传](https://platform.minimax.cn/docs/api-reference/file-management-upload)。
- [同步语音](https://platform.minimax.cn/docs/api-reference/speech-t2a-http)、[系统音色](https://platform.minimax.cn/docs/faq/system-voice-id)、[查询音色](https://platform.minimax.cn/docs/api-reference/voice-management-get)。
- [错误码](https://platform.minimax.cn/docs/api-reference/errorcode)。文档核对不代表真实账户调用已通过。

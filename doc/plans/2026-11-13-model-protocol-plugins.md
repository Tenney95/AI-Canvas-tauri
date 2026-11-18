# 模型协议预设插件与 OpenAI Responses

日期：2026-11-13。范围已由用户确认并授权实施、定向测试及类型检查；本项在此前原生 Responses 实现上增补插件扩展，不撤回原有改动。

## 交付与状态

宿主代码和独立插件已实现。插件在源码仓库外的 `../plugins/openai-responses/`，分发包为 `../plugins/openai-responses.zip`。这不是自动内置插件；原有 0.11.3 安装版缺少新扩展，必须升级到包含本次源码的宿主后才能安装使用。已按用户要求生成包含本次修改的 Windows x64 本地 NSIS 安装包，版本仍为 0.11.3；未安装、提交、推送或公开发布。

2026-11-13 的前端自动检查以及完整默认功能的 Rust release 构建、NSIS 打包均已通过。2026-11-16 更新后已修复全部已发现的前端测试及静态检查问题，全量测试、lint、两套类型检查和生产构建通过，原生检查结果见下方专项记录。桌面安装、重启恢复、实际 WebView/传输和真实厂商 API 调用均未验收，不能将模拟注册状态与 HTTP 响应的回归当作原生运行成功。

## 实现边界

- API 2 新能力 `model.protocolPresets` 与 `contributes.modelProtocols`：最多 16 个，固定四字段，首版类别 `text`，只绑定四种已实现的宿主原生对话适配器。允许零工具、空权限包，保留必要的无操作 `main.js`。
- Rust 独立验证声明，将其纳入 revision 身份和私有快照一致性检查；旧记录使用空贡献缺省值，空字段不改变旧序列化形状。注册状态仅在 ready 且快照已验证时公开协议元数据。
- 模型保存 `{preset:"plugin",plugin:{pluginId,presetId}}`，导入/导出保留身份与缺失引用。显示名称不充当身份，普通模型配置不能自带 adapter 自授权；缺失、禁用、失效或混入自定义 JSON 时明确拒绝，不默认回退。
- `pluginProtocolPresetService.ts` 负责有界目录与租约，`pluginModelProtocol.ts` 连接对话助手、文本节点和设置试跑。每轮请求前和交付前重验原生活动状态、双摘要、依赖和声明；各工具轮重新获取租约。
- 更新、停用、卸载、加载、注册表修复及反向依赖失效时取消原调用。流式文本可逐段显示，工具提议/终态等待最终核验。失败补偿只恢复后续调用，不复活旧请求。
- 凭据、Base URL、消息和素材由宿主处理，不传给插件代码。Responses 复用 `responsesApiProtocol.ts` 的消息、图片、函数工具及结果、SSE/JSON、失败/截断处理，不新增任意编解码脚本、网络或文件权限。
- 模型设置显示来源、可用状态及稳定 ID；插件设置正确展示零工具、预设数量和无权限。新文案同步英、日、韩。现有 `plugin_host_inspect` 提供公开合同和已校验的有界摘要。
- CLI `init <目录> protocol` 提供独立预设模板，`check` 沿用真实清单校验；Windows watch 使用目录真实路径，避免短路径与文件通知路径不一致造成 libuv 崩溃。

主要合同见[插件开发规范](../插件开发规范.md)，模块入口见[插件平台](../插件平台模块.md)及[模型与生成](../模型与生成模块.md)。不新增依赖、不删除文件、不修改 Tauri 安全配置或 lockfile。

## 已执行验证

2026-11-13，以下 **21 个文件、776 项 Vitest 用例全部通过**。覆盖实际交付清单、五图编码、原生/插件消息执行、工具轮、流式/非流式、失效取消、目录/引用、导入导出、安装 Store、设置和旧协议回归；原生状态和模型响应为测试桩。

```powershell
npx vitest run tests/services/pluginManifest.test.ts tests/services/pluginContractCatalog.test.ts tests/services/pluginHealthService.test.ts tests/services/pluginProtocolPresetService.test.ts tests/services/pluginModelProtocol.test.ts tests/services/openaiResponsesPluginPackage.test.ts tests/store/plugins.test.ts tests/scripts/pluginDev.test.mjs tests/services/modelProtocol.test.ts tests/services/providerConnectionTransfer.test.ts tests/services/assistantStreamProtocol.test.ts tests/services/generateTextProtocol.test.ts tests/components/modelProtocolEditor.test.tsx tests/components/modelProtocolEditorInteractions.test.tsx tests/components/modelProtocolTestRun.test.ts tests/components/pluginSettingsNativeDrop.test.tsx tests/services/responsesApiProtocol.test.ts tests/services/chat/agentRoundExecutor.test.ts tests/components/providerConnectionForm.test.tsx tests/services/generateVideo.test.ts tests/services/chat/providerConfigTools.test.ts
npm run typecheck
npm run test:typecheck
node scripts/plugin-dev.mjs check ../plugins/openai-responses
```

两套类型检查和实际插件目录 `check` 均通过。侧车插件包用例仅在独立包存在时运行，普通仓库 CI 不会要求外部插件预装。本次独立包存在，该组实际执行且通过。未运行全仓 lint 或全量 CI。

`git diff --check` 通过；所有本次改动/新增文本及独立交付文件已严格按 UTF-8 解码核对，无替换字符。ZIP 已检查三个预期条目、CRC 和逐字节内容，插件文件不含凭据或绝对本地路径。

Windows 本地打包已实际运行 `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/build-local-windows.ps1 -NoOpen`，通过 `tsc -b`、Vite 生产构建、MCP 适配器构建，以及 Rust 1.100.0 的完整默认功能 release 编译和 NSIS 打包。安装器清单包含 DirectML.dll 与 MCP 适配器，安装包 PE 头、大小、SHA-256 及运行 DLL 哈希已核对；本地包未签名、不生成自动更新产物。重复启动器的并发锁拒绝和脚本语法、编码检查通过。产物及构建记录位于同级 `../packages/`，入口见[打包与发版流程](../打包与发版流程.md#windows-一键本地打包)。

此前 `cargo check --lib` 和 `cargo test --lib plugin_registry::tests` 因缺少 `cargo` 未进入编译；2026-11-13 的打包没有重新运行这两条命令。当时原生单测待执行；2026-11-16 已执行的范围和结果见下节。未修改依赖或锁文件。

## 2026-11-16 更新后验证

验证对象为 `8f83d52` 上的当前工作树，包含冲突修复及尚未提交的插件、Responses 和提示词超限功能。首轮检查发现的 7 项测试失败、4 个 lint 错误和 3 个警告均已修复，最终全量自动检查通过；这不等于所有桌面场景或真实厂商调用均无 BUG。

- `npm run build -- --outDir <系统临时输出目录>` 通过，包含应用类型检查和 Vite 生产构建；`npm run test:typecheck` 通过。MCP 内置脚本与当前源码重新打包的结果在统一换行符后相同；Windows 本地打包脚本语法通过。
- `npm test -- --silent --reporter=default` 最终执行完整 812 个文件、14437 项用例，全部通过；新增 6 项覆盖文章切换后的迟到回执、最新草稿入口、素材连接切换取消及音频引用顺序／共享预算。没有跳过用例或删除失败断言。
- `npm run lint` 最终为 0 错误、0 警告；`npm run typecheck`、`npm run test:typecheck` 和生产构建均通过。Vite 仍有依赖注释、分包体积和静态／动态导入提示，不属于已修复的 ESLint 警告。
- 在 `src-tauri/` 执行 `cargo check --lib --release --target x86_64-pc-windows-msvc --locked` 通过；`cargo test --lib --release --target x86_64-pc-windows-msvc --locked plugin_registry::tests` 最终 50 项全部通过，保留默认功能。

原生检查修正了新增测试的夹具：无权限协议包不伪造高风险授权；通过真实暂存入口断言同摘要更改适配器被拒绝，再实际损坏源码快照，验证健康状态变为 invalid 且不再公开预设。没有放宽生产授权、快照验证或失败断言。

使用同一依赖环境，在独立的 `8f83d52` 源码副本中逐组复现了全部 7 项前端测试失败及上述 lint 结果，确认这些失败在本次工作树改动前已存在：

| 回归文件 | 失败项数 | 复现原因／表现 |
|---|---:|---|
| `tests/services/apimartGen.test.ts` | 2 | 上传测试桩仍返回本地 URL，未跟随共享素材解析入口，上传与失败轮询断言不满足。 |
| `tests/scripts/projectModelBoundaries.test.mjs` | 1 | `storageHealth.ts` 的 `readStorageReferences` 调用 `getProjectById` 超出登记预算。 |
| `tests/i18n/i18n.test.ts` | 1 | 发现 17 条源码已不再使用的翻译 key。 |
| `tests/services/mediaReferenceMemoryGuards.test.ts` | 1 | 音频引用源码字符串断言与现有参数排列不一致。 |
| `tests/scripts/ciAffected.test.mjs` | 2 | 经 npm 启动时测试没有使用预期的 npm 替身，报缺少 package.json／test:typecheck；当前工作树与基线直接调用 Vitest 时该文件 33 项均通过。 |

修复保持原边界：APIMart 测试桩按共享解析入口上传本地素材；存储审计将原 `scanStorageHealth` 的单次旧读取预算迁到实际的 `readStorageReferences`，不增加预算；三种语言同步移除已无源码引用的 17 个 key；音频接线断言适配 TOS／Data URL 分流并用行为测试覆盖取消和共享预算；CI 夹具按大小写不敏感规则清除继承的 npm 入口。文章会话在视图提交后更新编辑入口，采用前复核最新草稿；文章与素材连接切换通过组件身份重置状态并阻止旧回执写回。全仓 AST 扫描曾在并行检查负载下耗时 17.6 秒，单项超时由 15 秒调整为 60 秒，完整扫描和所有审计断言保持，最终全量复跑通过。

构建产生的受跟踪文件换行差异已恢复；依赖清单、锁文件、已有改动和 autostash 保留。未重新打包安装器，未执行桌面实机、重启恢复或真实厂商调用；对应验收步骤见下节及[提示词超限处理](../模型与生成模块.md#gpt-images-提示词超限处理)。

## 再次更新后的兼容验证

本轮基于 `75daa73` 的工作树；已获取并核对远端，当前与 `origin/master` 同步。解决再次 autostash 合并产生的 13 个冲突文件，保留上游文章助手的模型／团队选择、图片输出格式、扩图独立垫图、渠道上传修复，以及本地插件协议、Responses 和提示词超限处理。原有改动与两份 autostash 保留，没有提交或推送。

文章会话在视图提交后同时接入最新编辑器与执行选择，生成开始时冻结执行参数，采用前仍复核最新草稿；文章切换的组件身份重置保留新模型控件、主题与减少动效支持。图片执行同时传递输出格式与本次提示词选择，预检补齐输出参数及独立垫图，避免预检和实际提交使用不同输入。APIMart 用上游共享素材解析测试桩，Agent 预算与 Responses 回传测试均保留。

新增 5 项组合回归覆盖最新团队／单模型入口、GIF／SVG 参数、扩图预检及原生提交参数；相关 4 个文件、429 项定向用例通过。`npm test -- --silent --reporter=default` 最终完整执行 820 个文件、14993 项用例，全部通过。词条全仓扫描曾在并行编译负载下超过 15 秒，单项上限调整为 60 秒；完整扫描和断言保持，未跳过用例或删除有效断言。

`npm run lint` 为 0 错误／0 警告，后续改动文件的定向 lint 通过；`npm run typecheck`、`npm run test:typecheck` 和临时目录内的生产构建通过。默认功能的 `cargo check --lib --release --target x86_64-pc-windows-msvc --locked` 及 `cargo test --lib --release --target x86_64-pc-windows-msvc --locked plugin_registry::tests` 通过，后者 50 项通过。原生检查沿用现有本地构建脚本的缓存及 DLL 复制目录准备，未关闭 ONNX 功能。Vite 依赖／分包提示和既有 Rust 编译／链接警告仍保留。

依赖清单和锁文件未改动，没有新增权限或改变持久化格式。已核对严格 UTF-8、冲突标记与差异空白，Git 无未合并条目，验证期间生产代码和测试源码快照保持一致。未重新打包安装器；Tauri 实机、实际厂商上传／生成、独立窗口和重启恢复仍按下节验收，自动检查通过不能替代这些场景。

## 桌面与真实渠道验收

前提：通过 Rust 编译，使用包含新能力的桌面宿主；准备实际支持 Responses、图片输入和所需工具能力的厂商连接。模型名不作为支持证据，Key 沿现有连接保管。

1. 从文件夹安装独立包并启用。模型协议下拉应出现带插件来源和 `ai-canvas.openai-responses/responses` 身份的 OpenAI Responses；保存并重启后保留。
2. 文本节点和对话各准备五张不同图片，真实连接/引用后要求逐张描述。确认实际请求包含五个 `input_image`，系统和历史消息仍有效；不将素材正文或凭据写入诊断日志。
3. 验证非流式、流式、一次获准的工具调用及结果回传。失败、EOF 和截断不得误执行工具；截断沿现有暂停入口处理。
4. 请求中取消、停用或更新插件，预期请求中断，迟到结果/工具不交付；重新启用只能发起新调用。原生依赖状态失效也应阻止交付。
5. 卸载后引用仍保留并明确不可用；重新安装相同身份后可恢复后续调用。导入缺失引用不丢失模型，不能把配置中的 adapter 当作授权。
6. 回归 OpenAI Chat、Anthropic、Gemini、已有声明式媒体协议、旧节点/工具插件，以及深浅主题、键盘选择和原生文件夹导入。真实网关兼容性及费用需按该渠道结果单独记录。
7. 工作台生成文章修改候选期间切换文章，预期新文章的输入和候选清空，旧生成／采用回执不得覆盖新输入；同一文章采用时仍须核对最新草稿版本，采用只进入草稿，保存由用户操作。
8. 素材库选择文件或上传期间，将配置切换到另一个有效火山连接 ID，预期关闭旧上传草稿并中止旧上传；新连接重新同步列表，迟到的文件选择与上传结果不得写入新连接界面。
9. 文章助手分别选择单模型与正文生成团队，预期使用当前选择的模型、团队模板及会话；未选模型或最终只交付审稿报告时，不回退到其他模型、不覆盖文章。团队生成、预览及采用期间回归切换文章、继续手写和停止，原稿及新输入均应保留。
10. 对声明了输出格式和提示词长度合同的模型，回归 PNG／GIF／SVG 的短正文与超长正文处理，确认格式、帧数、帧时长及透明参数保留，原有方图／文生约束仍生效；扩图节点在裁剪或优化后重试，参考图仍是原始独立垫图，预检和提交不得改用上次结果。

## 回退

先将受影响模型切到目标宿主支持的协议，再卸载新能力插件；降级前导出连接设置，遵守既有 schema 2 注册表兼容门槛。保留素材、连接凭据及其他插件，不手工改注册表版本。若撤回本次扩展，只撤本批插件合同与路由差异，保留此前独立的原生 Responses 支持；不得整体回滚重叠文件。

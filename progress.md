# 插件优化进度

## 2026-09-03 Git 发布与上游 PR

- 用户明确要求把当前改动全部提交到 `master`，并由 fork 向上游创建 PR。
- 已恢复规划文件并新增发布阶段；按上一条要求不运行新的测试，仅执行提交前状态、差异、远程与 PR 核对。
- 已确认当前远程：`myfork` 指向用户 fork，`origin` 指向上游；下一步核对代理配置、PR #15 状态与真实差异。
- 已确认 Git 配置仍含 `127.0.0.1:7892`，后续 fetch/push 将逐命令清空代理；环境变量未配置代理。
- `gh pr view 15` 因系统未安装 `gh` 未执行；已记录并切换到不新增依赖的 GitHub API/网页路径。
- 公共网页检索未可靠返回 PR #15；已改以无代理 Git fetch 和 GitHub API 为准。
- 已不经 `127.0.0.1:7892` 成功刷新 `origin` 与 `myfork`；上游最新为 `6bd898c`。
- 已确认本地、fork 与上游三方当前提交完全一致，基线正是 `6bd898c style(audio): 统一音频节点工具栏样式`。
- GitHub API 已确认旧 PR #15 合并关闭；本轮发布将创建新的上游 PR。
- 已完成 tracked 差异统计与文件名核对：39 个真实差异文件和 8 个新文件，均属于已确认插件方案及过程记录；`Cargo.toml` 工作区与 HEAD 哈希一致，无实际内容差异。
- 发布阶段 1 完成：基线、远程、旧 PR、真实差异与无代理策略均已核对；`git diff --check` 未发现空白错误，仅显示仓库行尾策略提示。
- 发布阶段 2 开始：将使用显式文件清单暂存 47 个真实变更文件，不使用 `git add .`，不纳入内容相同的 `Cargo.toml`。
- 首次显式暂存因沙箱拒绝写入 `.git/index.lock` 失败且未产生部分暂存；随后在批准的 Git 索引权限下用同一清单成功暂存。
- 暂存后有 47 个实际 staged 文件且无 unexpected；`git diff --cached --check` 通过。原预期中的 `tests/components/toolbarRegistry.test.ts` 经 `git add` 后不再显示差异，准备以 blob 哈希确认其是否只是索引/行尾假修改。
- 已确认 `toolbarRegistry.test.ts` 与 `Cargo.toml` 的工作区 blob 均精确等于 `HEAD`；两者只是索引/行尾假修改，不制造空提交，真实提交范围为 47 个文件。
- 最终暂存状态已核对：47 个文件全部在 staged 区，无额外未暂存文件；统计为 4303 行新增、1259 行删除，`git diff --cached --check` 通过。
- 已核对 pre-commit：只同步 README 版本徽章并运行 staged TS/TSX ESLint，不含测试；将正常提交，不绕过仓库门禁。

## 2026-09-03 关联资源与主窗口 UI

- 用户已确认实施“节点自身/直接入边/插件包资源的最小授权 + 主窗口内插件 Modal”方案。
- 已启用 planning-with-files 工作流并完整读取其 `SKILL.md`。
- 已恢复三份既有规划记录，确认它们属于上一轮插件工作；本轮保留原内容并追加新阶段。
- 初始工作区为 `master...origin/master [ahead 44]`，仅 `src-tauri/Cargo.toml` 有既有状态标记及三份未跟踪规划文件；尚未修改产品代码。
- `session-catchup.py` 首次因系统不存在 `python` 命令失败，已记录并准备改用可用运行时。
- 已通过 Codex 工作区依赖定位内置 Python，并成功运行 `session-catchup.py`；脚本未报告未同步上下文。
- 已完成类型、Manifest 校验和现有文本 grant 的首轮代码核对，最终将资源 sidecar 直接纳入首版 v1，不保留旧入口。
- 已核对资产索引与项目文件安全实现，确定复用 `assetId`/项目 relativePath、普通文件检查及摘要复核。
- 已确认资源租约应在 `pluginRuntime` 每次 invocation 开始时异步创建，并在 `finally` 与生命周期事件中撤销。
- 已核对插件安装、Store 串行事务、原生私有快照和命令注册链；包资源必须随 stage 进入原生快照，不能依赖 IndexedDB 中的路径。
- 已完成 Manifest 解析器、前后端 API/runtime 组合、Rust stage/activate/ensure 链和现有 Manifest/runtime 测试的第二轮核对。
- 已核对本地媒体 URL 判定、画布 derivation guard 和执行 effect 上下文，形成资源租约复核所需字段清单。
- 阶段 1 完成：14 个候选文件严格 UTF-8 解码通过；插件 Manifest、文件 grant、runtime 与 Store 基线测试 4 文件 77 项全部通过。
- 阶段 2 开始：定义首版 API v1、细分资源权限、Manifest 资源/端口 scope 与可选 invocation resources 类型。
- 已核对 GitHub Release 安装与本地文件夹安装链，确定包资源统一以有界字节 payload 暂存，长期只保存在 Rust 私有快照。
- 已修改 `src/types/plugin.ts`：在 API v1 中加入细分资源权限、resource 端口、包资源声明/安装 payload、opaque `PluginResourceRef`、invocation resources sidecar 与资源读取 effect 类型。
- 已修改 `pluginManifest.ts`：加入 v1 runtime/entry 组合、资源权限依赖、resourceAccess、包资源路径/MIME/字节/摘要校验，以及媒体/resource 端口限制。
- 首轮测试共发现 2 个测试夹具问题和 1 个 effect 类型穷尽问题；已记录，测试夹具已修正，运行时分支已在资源服务接入时显式处理。
- 已确认自动节点资源首批覆盖主资产；插件节点手选文件继续走既有显式授权并在执行时验证。复杂节点多产物不会通过任意对象递归扫描扩权。
- 整文件资源服务补丁因同路径 Delete/Add 冲突被工具拒绝，文件未变化；已改为分段 Update 策略。
- 用户明确无需兼容尚未投入使用的旧插件 API；后续以单一新资源/UI 契约迁移仓库内示例、测试和文档，不再实现旧行为降级。
- 主窗口插件 UI 会话服务首次类型检查失败：`executePluginUiHostEffect` 尚未声明 `resources` 与 `resourceReadContext`；已定位为新 Broker 与既有运行时之间的单点接线缺口，下一步补齐后复检。
- API v1 测试夹具的首个跨文件批量补丁因实际缩进/文本不匹配而整包拒绝，未写入部分变更；改为读取精确上下文后分文件更新。
- API v1 首轮回归发现 `store.plugins.ts` 仍残留 `apiVersion !== 4`，导致两个插件加载测试错误地 fail closed；Rust 单测夹具也剩一处旧标识，均为机械替换漏项。
- v1 前端复检已通过；随后 Rust 测试误从仓库根目录执行，Cargo 因找不到 `Cargo.toml` 未运行，已改为在 `src-tauri/` 目录重试。
- 主窗口插件 UI 主题上下文补丁因空 hunk 语法错误被整包拒绝，未产生部分修改；改为按文件精确应用。
- 主窗口 Modal/iframe 接线后类型检查通过；定向 ESLint 发现渲染期写 ref 与 effect 起始同步 setState 两项 React 19 规则问题，已按异步会话生命周期调整。
- 第二次 UI ESLint 仅剩“插件不存在”分支在 effect 中同步更新状态；已改为微任务回调并保留卸载保护。
- 移除旧手选文件字段的首个跨文件补丁因 `PluginFileGrantSummary` 周边结构不匹配被整包拒绝，未写入部分修改；改为按真实片段拆分清理。
- 旧字段已退出公开 API 与运行链；复检时一条 `rg` 正则因转义错误未执行，随后类型检查确认仅待删除的旧 `pluginFileGrantService.ts` 仍导入被移除类型。为保持中间状态可编译，旧结构暂时收回该文件内部。
- 新增 UI 会话测试通过；资源 Broker 测试有两项因 mock 将 `assets` 中间目录误报为普通文件而被生产路径校验拒绝，修正 mock 目录结构后重跑。
- 新增资源/UI 会话前端测试 4 项通过，Rust 注册表 20 项与插件 UI 协议 1 项通过。全仓 `cargo fmt --check` 被本批外大量既有格式差异阻断，后续仅格式化本次修改的 Rust 文件。
- 插件规范两处小修首次因同一补丁重复声明同一文件被拒绝，未产生修改；已合并为同一文件的两个 hunk。
- 已新增 `pluginResourceService.ts`：调用级 opaque 句柄绑定插件、源码/完整 revision、项目、节点、画布 revision 与精确连线；读取前复核路径、符号链接、文件身份、边和端口。
- 已将资源 sidecar 与资源读取/分段读取/model resourceIds 接入插件运行时，并阻止本地 asset/file/blob/data URL 继续通过旧输入字段透传。
- 插件契约收敛后的首次 `npm run typecheck` 通过；仓库内旧测试夹具随后统一迁移到首版 v1，不保留兼容解析。
- 用户进一步确认稳定契约、测试与文档全部统一称为 API v1；已将前端、原生注册表 schema 和仓库夹具回收到单一 v1 标识。
- Manifest 测试现已迁移为 v1，16 项通过；前端类型检查和 Rust `cargo check --lib --no-default-features` 均通过。
- Rust 包资源私有快照、完整 revision 摘要、活动 revision 双摘要校验和有界资源读取命令已接入；当前剩余失败均来自仓库内旧测试夹具尚未迁移。
- 旧链路删除前引用复核的首条 `rg` 正则在 PowerShell 参数转义后形成未闭合分组，未执行检索；改用多个固定字符串查询重新核对，不复用该正则。
- 插件相关用户可见文案、规范、测试名称和过程记录已统一为 Plugin API v1；其他业务域自身的数据/模型版本未改动。
- 自定义 UI host 已改为 sandboxed iframe 内的自包含挂载协议，避免不透明 origin 加载 ES module 时的 CORS 风险；插件可自带任意框架，但拿不到主窗口 React、DOM、Store 或 Tauri API。
- 最新验证：TypeScript、目标 ESLint、6 个插件测试文件 88 项、Vite 生产构建、Rust 注册表 20 项、插件 UI 协议 1 项和 `cargo check --lib --no-default-features` 全部通过；Cargo 仅有既有 `model_mirror.rs` dead-code 警告。
- 首次全仓 `npm run check` 的 lint 与应用 typecheck 通过，测试类型阶段发现新 UI 会话夹具把 `placements` 推断成只读 tuple，无法赋给公开的可变数组类型；生产代码无错误，改为给夹具显式标注 `PluginNodeToolManifest` 后重跑。
- 第二次全仓 `npm run check` 的 lint、应用类型和测试类型通过；全量 Vitest 为 239 个文件、2033 项通过，2 个既有 MCP suite 在收集阶段以 `SyntaxError: Invalid or unexpected token` 失败（`aiCanvasMcp.test.mjs`、`mcpImageResult.test.ts`），两文件不在本批差异内。插件定向 6 文件 88 项已独立通过，不越界修改 MCP 测试。
- 删除后最终契约收敛的首个跨文件补丁因 `pluginManifest.ts` 权限常量实际排版与预期上下文不同而整包拒绝，未产生部分修改；改为先读取精确片段，再按文件拆分应用。
- 新增大文件 Range 降级保护后，资源专项 5 项测试通过；同一复合命令末尾用于确认“旧权限名零命中”的 `rg` 按预期返回 1，导致组合命令整体为 1，并非测试失败，后续将验证命令拆开记录。
- 收紧 v1 精确端口与 UI `submit` 契约的跨文件补丁因 `PluginUISurfaceProps` 注释实际文本与预期不完全一致而整包拒绝，未产生部分修改；改为读取精确上下文后拆分应用。
- 第二次补丁仍被 `src/types/plugin.ts` 该段混合行尾阻断，整包未落盘；先独立修改其余 UTF-8 文件，再用稳定上下文处理该类型段。
- 将既有“宿主模型媒体可回传”用例改成受信本地 asset URL 的补丁因链式 mock 上下文少一行而拒绝，未落盘；读取测试原文后用最小 hunk 重试。
- 删除旧链路及最新安全收口后，应用类型检查、测试类型检查和 6 个插件测试文件 96 项均通过。
- 最新目标 ESLint 首次运行在 `pluginRuntime.ts` 的输出文件名控制字符正则处触发 `no-control-regex`；功能未执行，准备改为逐字符码点替换后复检。
- 首次同时更新运行时与进度记录的补丁因 Windows 正则反斜杠上下文不匹配被拒绝，未产生修改；随后一次补丁脚本因未转义 Markdown 反引号而在解析阶段失败，同样未修改文件；改用纯字符串数组和更小上下文重试。
- 输出文件名清洗的两次小补丁仍因 JavaScript 字符串转义生成了错误的反斜杠/引号上下文而被拒绝；经字节级核对原行后改用原始字符串补丁成功，行为保持不变且不再触发控制字符正则规则。
- 提取实施方案 12.2.2 段落的首个 PowerShell 命令因匹配到多行后直接对数组做减法而失败，文件未修改；改为先列出精确行号再读取单个区间。
- 自定义 UI 复用同一执行租约并统一媒体来源约束后的首次类型检查，只发现已移除参数留下的未使用 `PluginRuntime` 类型导入；准备删除该导入后复检。
- 同步记录上述类型错误与删除导入的首个补丁脚本因未转义 Markdown 反引号而在解析阶段失败，未修改文件；改用普通字符串数组重试。
- UI 会话与运行时回归首次重跑时，运行时 41 项通过，UI 会话夹具因完整 mock 未补新导出的媒体来源收集函数而在创建会话时报错；补齐 mock，并增加同一租约透传断言后重跑。
- 同步插件规范的大补丁脚本因 Markdown 反引号进入 JavaScript 原始模板而在解析阶段失败，文档未修改；改用占位符还原反引号后重试。
- 已完成 UI 会话复用：`submit` 沿用原 sessionId、canvas guard、资源 sidecar 与受信媒体集合；UI effect 始终按不可信 JavaScript 限制媒体来源，并在异步 effect 后再次复核当前 revision/画布。
- 自定义 UI bootstrap 新增 Tauri 全局注入失败关闭、实时 `theme` getter 和等待宿主确认后再更新 parameters；Broker 增加 64 次请求上限与 effect/set/submit 单飞。
- 最新验证：`npm run typecheck`、`npm run test:typecheck`、目标 ESLint、6 个插件测试文件 99 项、Rust 注册表 20 项、Rust runtime 13 项、Rust UI 1 项和 `cargo check --lib --no-default-features` 均通过；Cargo 仅报告既有 `model_mirror.rs` dead-code 警告。
- 最新系统临时目录 Vite 生产构建通过，确认双入口和 `plugin-ui-bootstrap.js` 被复制；仅保留既有动态导入失效与大 chunk 警告。
- 当前唯一配置检查点：项目 bundle target 为全平台，而全局 CSP 尚未允许 macOS/Linux 的 `plugin-ui:` 脚本源；尚未修改 `tauri.conf.json`，等待用户对精确一项 allowlist 变更的确认。
- 用户确认追加 CSP 白名单并明确“不用测试”；已仅在 `script-src` 增加 `plugin-ui:`，没有扩大其它 CSP、capability、依赖或业务权限。
- 实施记录已标明代码完成；真实 Tauri 主窗口加载、交互及故障注入按用户要求跳过，不把既有自动化证据冒充真机验收。

## 2026-08-30

- 已确认本批为一次性安全/功能修复，不进入原生信任注册架构重构。
- 已运行全工作区与目标文件状态检查。
- 已确认三份目标产品文件没有未提交改动；其余现有改动保持原样。
- 已建立任务计划、发现与进度记录。
- 已严格校验三份目标产品文件为 UTF-8。
- 已读取现有 runtime 与完整测试结构，确认可在当前测试文件内覆盖新边界。
- 已实现插件来源 Handle 精确路由、来源/目标端口类型检查和旧连线回退。
- 已实现 JavaScript 远程媒体来源集合与所有声明媒体输出的写回前校验。
- 已加入多输出、类型不兼容、旧连线、任意远程媒体拒绝、输入透传、宿主媒体 effect、嵌套媒体路径和普通文本 URL 兼容测试。
- 已同步插件开发规范，明确端口精确路由、媒体来源、内联媒体和 Python 兼容边界。

## 文件变更

- 产品文件：已修改 `src/services/plugins/pluginRuntime.ts`、`tests/services/pluginRuntime.test.ts`、`doc/插件开发规范.md`。
- 过程记录：`task_plan.md`、`findings.md`、`progress.md`。

## 验证记录

- 修改前基线：`npx vitest run tests/services/pluginRuntime.test.ts` 通过，1 个文件、7 个测试。
- 修改后定向测试：1 个文件、25 个测试通过。
- 插件相关回归组：5 个文件、45 个测试通过。
- 目标文件 ESLint：通过。
- 第一次全仓 `npm run typecheck`：通过。
- 第二次全仓 `npm run typecheck`：被本批范围外的 `ComposerLayerNode.tsx` 两处 `resourceBudgetError` 类型错误阻断；未越界修改。
- 最终全仓 `npm run typecheck`：并行改动收敛后重新运行并通过。
- 三份产品文件及三份过程记录均通过严格 UTF-8 解码和常见乱码扫描。
- 三份产品文件 `git diff --check` 通过；仅有仓库行尾策略提示（下次 Git 触碰时 LF 转 CRLF）。
- 最终只读安全复审：三项追加阻断均已解除，无残余阻断。

## 2026-08-30 未提交改动审计

- 用户要求审计当前全部未提交文件，并提交完整、有用的改动。
- 已恢复并读取现有规划、发现和进度记录；确认它们属于先前插件安全修复的过程材料。
- 已开始按功能来源盘点；尚未暂存或提交任何文件。
- 已读取差异统计、原生插件 ADR、注册表模块结构和主要测试覆盖，完成三组候选改动的初步分流。
- `git diff --check` 当前通过；尚未运行本轮独立验证。
- 前端定向验证：3 个测试文件、63 项测试通过；`npm run typecheck` 通过；目标 TS/TSX ESLint 通过。
- Rust 默认特性测试：被既有 ONNX/MSVC ABI 链接错误阻断，未进入本批测试逻辑。
- Rust 无 ONNX 验证：19 项注册表测试、13 项插件运行时测试、3 项 Blender artifact 测试、4 项资源测试及 `cargo check --lib --no-default-features` 全部通过。
- 编码验证：23 个候选产品文件严格 UTF-8 通过，Blender 模板 Python AST 解析通过。
- 全仓 `npm run check`：lint、应用类型、测试类型通过；全量测试 233 个文件通过、4 个候选范围外文件失败（1989/1991 测试通过）。
- 内容哈希复核确认 9 个状态异常 Rust 文件与 `HEAD` 完全一致，排除提交。
- 已完成候选分组、架构与回滚边界整理；按项目 `AGENTS.md` 的架构收敛检查点暂停，等待用户确认后再按显式文件清单提交。
- 用户已确认按三组提交；第一组 14 个插件安全架构文件已通过显式清单暂存。
- 初次自动清单比对受 Git 中文路径转义影响产生假告警，未发现真实越界暂存，正在以未转义路径复核。
- 第一组已提交为 `30ddc43`：14 个插件安全架构文件，暂存 allowlist、`git diff --cached --check` 和提交后状态均通过。
- 第二组已提交为 `5f4b0d0`：8 个 Blender 保存回传文件，暂存 allowlist、`git diff --cached --check` 和提交后状态均通过。
- 第三组已提交为 `561ad84`：仅 `.gitignore`，新增 `.planning` 与 `.cargo` 忽略规则。
- 重新索引 9 个内容相同文件后假修改标记已清除；最终无已跟踪差异、无暂存差异，仅保留三份未跟踪过程记录。
- 本地 `master` 相对 `myfork/master` 领先本轮 3 个提交；本轮未执行推送。

## 2026-08-30 文档同步

- 用户要求同步 `README.md`、`doc/开发指南.md`、`doc/插件开发规范.md`、`doc/架构说明.md`，随后追加 `AGENTS.md`。
- 已确认工作区除三份过程记录外无已跟踪差异；开始只读审计，尚未修改五份目标文档。
- 已完成五份文档的目录、关键词与关键段落首轮扫描，并启动三个只读并行审计任务分别核对 README、AGENTS/架构和开发指南/插件规范。
- 已对照当前 Store、前端插件 runtime、Rust 注册表、Blender manifest/runner 与 ADR 核实关键标识；发现 MCP 权限文案存在两处高优先级漂移，纳入本轮同步范围。
- README 并行审计已返回：确认用户插件、MCP 自主执行、双运行时导演台、可选 Blender 环境要求和插件规范导航五项缺口；未修改文件。
- 三个并行只读审计均已完成；核实开发指南/架构说明版本、Store slice 数量、IndexedDB schema、目录树、MCP 权限和 Blender 保存返回链路均存在需同步内容。
- 已形成五文件修改摘要、风险、验收和回滚范围；按项目超过 3 文件的检查点暂停等待用户确认，尚未修改目标文档。
- 用户已确认继续，并明确要求提交、推送及把今天全部修改 PR 到上游；开始并行写入五份目标文档。
- 用户进一步明确“先完善文档”；提交、推送和 PR 暂不执行，先完成五文档终审。
- 首轮文档写入后交叉审计发现 MCP 双传输、固定令牌、自动启动和远程自主权限在旧文档中严重漂移；已直接对照 `mcpSessionConfig.ts`、`mcp_bridge.rs`、`McpControlSettings.tsx` 与 `App.tsx` 修正。
- 已完成五份文档的严格 UTF-8、常见乱码、代码围栏、本地 Markdown 链接、源码真值和 `git diff --check` 验证；三路最终只读回归均确认无阻断。
- 最终额外修正 Plan 模式语义：`policyEngine.ts` 先拒绝非 `read`，因此 Plan 下 `user_choice` 与 `memory_write` 均拒绝；B/C/MCP 下 `user_choice` 才等待用户作答。
- 终检再次确认五份文档严格 UTF-8、代码围栏成对、本地链接可解析、旧版本/旧安全语义无命中，`git diff --check` 仅提示仓库既有 LF→CRLF 策略。
- 源码事实复核：应用版本 0.9.0、IndexedDB v20、Store 21 个 slice、Blender runtime 1.3.2 / Blender 5.2.1 LTS、MCP 固定令牌键 `mcp/token`、HTTP 端点 `/mcp`、1 MiB 请求上限与 4 并发均有源码依据。
- 当前仅五份目标文档存在已跟踪差异；三份过程记录继续保持未跟踪且不进入产品提交。按用户“先完善文档”要求，尚未提交、推送或创建 PR。
- 五份文档已按显式清单提交为 `52820df docs: 同步插件、MCP 与导演台架构文档`；提交只包含五份目标文档。
- 本地 `master` 已推送至 `myfork/master`，远端从 `4e4a42c` 快进到 `52820df`。
- 已确认此前没有同 head/base 的开放 PR，并创建上游 PR #15：`luckcatlin2000:master` → `Tenney95:master`，包含今天相对上游的 18 个提交。

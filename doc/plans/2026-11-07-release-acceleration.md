# 发布检查与打包加速

初始日期：2026-11-07。目标是缩短发版关键路径，按当前风险计划执行源码检查，同时保留完整类型检查、生产构建、签名和全部平台成功后公开的条件。主入口为[发版流程](../打包与发版流程.md)，不修改产品功能或已推送标签。

## 当前触发规则（2026-11-15）

用户已选择方案二：普通提交、分支推送和 PR 不运行源码 CI，版本打包按影响范围检查，高风险改动再全量；独立 GitHub Pages 官网／演示自动构建部署保留。[PR #51](https://github.com/Tenney95/AI-Canvas-tauri/pull/51) 的日常按改动检查，以及本日早先的“标签一律全量”策略，均由本节替代。后文阶段方案和耗时仅作历史背景。

- 本地 `pre-push` 对普通分支和标签均不创建隔离检出、安装依赖或启动检查。`npm run ci`、`npm run ci:affected` 仍可在用户明确需要时手动执行，要求提交或普通推送不等于授权这些检查。
- 只有稳定 `vX.Y.Z` 版本标签发起打包时启动源码 CI，标签提交须属于同仓库默认分支历史。规划器从最近可信完整 CI 成功的严格祖先累计比较全部未验证改动，既可使用旧默认分支完整证明，也可使用新标签完整证明；增量结果不能成为新的全量基线。同 SHA 的较新失败或取消不能借更早成功蒙混过关。
- 普通组件、Hook、服务、翻译词条和可分类领域类型按依赖关系及显式源码读取映射选择 lint／测试。应用版本字段经前后内容精确比较确认未改依赖或配置后，不单独触发全量；锁文件依赖、权限、凭据、持久化、全局入口、构建／测试基础设施等高风险改动执行全量。没有可信基线、接口查询失败、删除或旧依赖关系不可恢复、测试范围无法可靠解析时，也执行全量并记录原因。
- 规划阶段固定目标 SHA、基线 SHA、`full`／`affected`、Rust 范围、lint 和实际测试文件清单，通过同次运行产物传给执行任务；执行时复核源码身份、基线和文件路径，不重算或静默更换模式。Summary 展示模式、基线、原因和选中范围，完整清单随计划保留。
- `full` 执行完整前端与三平台 Rust；`affected` 只执行选中的 lint／测试，但始终保留全项目应用／测试类型检查、完整生产构建和新前端产物。没有原生影响时可省略预检 Rust 矩阵，实际安装包仍由原平台和目标编译，缓存不等于当前检查成功。
- 标签发布请求仍转交默认分支固定工作流。全量证明为 `Full source quality`，增量证明为 `Affected source quality (<baseSHA>)`；Release 核对当前同仓库、同标签、同 SHA、同一次尝试的检查与前端产物，增量模式另外核对基线为可信完整检查的严格祖先。失败、缺失、取消、超时、错误模式或产物身份不符均停止，不能将增量结果标成全量成功。
- 发版资料与版本保持同一提交，建议原子推送 `master` 与同 SHA 标签。本地不重复执行门禁，官网自动部署维持原规则；不改写已发布标签，不删除发布检查或放宽产物校验。首次采用本规则的标签通常因 CI 规则变化或缺少基线而全量，之后仅应用版本元数据更新不会强制全量。

实施计划与入口：

1. `scripts/ci-affected-scope.mjs` 与 `scripts/ci-affected.mjs`：细化风险分类、精确识别仅版本元数据变化，解析并冻结清单，复核清单身份后执行；补充 `tests/scripts/ciAffected.test.mjs`。
2. `scripts/ci-source-plan.mjs` 与 `.github/workflows/ci.yml`：查找可信完整基线，输出检查计划和原因，按冻结模式选择全量分片或相关检查；补充 `tests/scripts/ciSourcePlan.test.mjs`。
3. `scripts/release-workflow.mjs`：读取真实全量／增量证明，独立验证增量基线与同次前端产物；补充 `tests/scripts/releaseWorkflow.test.mjs`。
4. 同步 `AGENTS.md`、开发指南、发版流程和导航中的当前规则，保留历史实测资料，状态与实际命令结果分开记录。

状态：实现与回归源码按本方案同步，待用户验收。本次未运行测试、lint、类型检查、构建、原生检查或实际发版，不承诺未经实测的节省时间。用户明确需要时可在仓库根目录运行 `npx vitest run tests/scripts/ciAffected.test.mjs tests/scripts/ciSourcePlan.test.mjs tests/scripts/releaseWorkflow.test.mjs`；定向结果不能代替真实 Actions 触发、范围选择与跨平台打包验收。

验收顺序：

1. 普通分支推送与 PR 不应启动源码 CI，本地不安装依赖或构建；官网／演示仍按原规则自动构建部署。
2. 首个包含规则变更的正式标签应记录 `full` 原因并完成完整门禁；有可信全量基线后，普通组件或翻译词条变更加仅版本元数据更新，应记录 `affected`、严格祖先基线及相关文件清单，仍执行两套类型检查和完整生产构建。
3. 依赖或锁文件解析结果、权限、持久化、全局入口等高风险变更应记录 `full`；无基线、接口失败、清单解析不可靠也应全量并说明原因。普通改动无 Rust 影响时可省预检矩阵，有原生影响时需执行对应原生范围。
4. 模拟 SHA／基线／文件清单不匹配、较新基线运行失败、其他标签或尝试的产物、过期或缺失产物，均不得进入打包；增量证明不能充当完整基线。检查失败、取消或等待超时同样阻断。
5. 核对安装包仍编译对应平台、签名和产物来源，全部平台成功后才公开；已有标签不改写。回滚需同时恢复规划／分类、工作流和 Release 证明读取，不触碰项目数据或历史发布附件。

## 历史实测基线

| 阶段 | 实际耗时与来源 |
|---|---|
| v0.10.29 源码 Frontend quality | 13分34秒；[源码 CI](https://github.com/Tenney95/AI-Canvas-tauri/actions/runs/42346733676) |
| 同提交 Rust check | 5分27秒，与前端并行；同一源码 CI |
| v0.10.29 Release Quality gate | 11分20秒，重复完整前端检查；[发布工作流](https://github.com/Tenney95/AI-Canvas-tauri/actions/runs/42348612665) |
| v0.10.28 Release 全流程 | 65分38秒；[上一版发布](https://github.com/Tenney95/AI-Canvas-tauri/actions/runs/42185944138) |
| 上一版标准 Windows／Linux／macOS | 27分14秒／21分54秒／22分15秒，三者并行 |
| 上一版 Windows Legacy | 26分48秒，在三个标准包全部成功后才开始 |

Windows 标准包的 Rust release 编译约23分23秒，重复前端构建约56秒。源码 CI 中 ESLint 约119秒、应用类型49秒、测试类型67秒、Vitest 464秒。瓶颈优先级是串行 Legacy、重复完整检查与原生冷编译，不靠删除测试或提高超时缩短报告时间。

## 历史实施边界（2026-11-07）

以下为当时的实现边界；涉及 CI 触发和本地钩子的行为以本文开头 2026-11-15 规则为准。

1. 当时要求发版资料一次准备并提交，`master` 与标签指向同一提交后一次原子推送，`pre-push` 完整执行 `npm run ci`；不增加按 HEAD、时间戳或不完整输入树判断成功的本地缓存，也不为了补一次成功记录再推送一次。
2. 标签事件只将发布请求转交默认分支工作流。实际编排在默认分支运行以获得跨版本缓存，但每个构建检出固定的目标标签 SHA，标题和说明也从目标源码读取；手动从非默认分支启动、非法标签、版本不符和已公开 Release 均失败关闭。
3. 当时安装包构建前等待同仓库默认分支 push 的同 SHA 源码 CI，核验其前端与 Rust 检查均成功；失败、取消或等待超时不能进入打包。复用该次 CI 的前端产物，产物缺失或不符时提示恢复可信 CI 产物，不冒用其他提交或分支的结果。
4. 前端构建只做一次，后续 Tauri 构建通过固定发布配置复用产物并保留 MCP 适配器准备。产物来源和清单需要验证，普通本地 `tauri build` 保留原构建行为。
5. npm 与 Rust 缓存按系统、目标及标准／Legacy 模式隔离。Legacy 的无 AVX／AVX2 RUSTFLAGS 纳入其缓存身份；不缓存签名密钥，不将缓存当作质量证明。首次冷缓存、工具链或依赖变化仍可能触发完整编译。
6. 三个标准平台和 Windows Legacy 在门禁后并行构建。Legacy 先保存为 Actions 产物，最终任务等待两类构建成功后才上传到同一 Release 并公开，避免草稿尚未生成时抢先上传。macOS 签名与启动检查继续保留。

发布标题由 `.github/release-title.txt` 提供，正文只维护 `.release-notes.md`；不再在工作流 YAML 中重复抄写发布正文。原文档和既有标签保留历史身份，不将新流程应用到当前正在执行的旧工作流。

实现入口为 `.github/workflows/ci.yml`、`.github/workflows/release.yml` 和 `scripts/release-workflow.mjs`；标准／Legacy 的固定 Tauri 覆盖配置分别在 `scripts/tauri-release.config.json` 与 `scripts/tauri-release-legacy.config.json`。草稿查找沿用 GitHub／Tauri Action 的发布列表语义，并在最终上传和公开前复核标签与草稿目标。

## 可推算收益与限制

按 v0.10.28 的已有阶段时长，仅将 Legacy 并行，关键路径约从66分钟降到39分钟，可移除约27分钟的串行等待；再复用同 SHA 源码 CI，可移除本次约11分钟的重复发布检查。以上是已有阶段耗时的流程推算，不是优化后实测结果。Rust 缓存的实际收益、GitHub 排队和不同 runner 的差异仍待首次及后续热缓存发版对照。

当前保留 Vitest 的 `fileParallelism: false`。历史配置没有解释串行原因，现有只读检查不足以证明全量并行安全；有限并行另行验证，不与本轮发布编排同时改动。

## 历史验收与状态（2026-11-07）

状态：已实现，待实际验证；已完成 UTF-8、差异空白、脚本调用链与工作流依赖的静态核对，并用现有 GitHub 运行元数据确认 CI 字段和草稿列表语义。本次未运行测试、lint、类型检查、构建或基准，未提交、推送或触发新发布；新测试源码不代表已运行。不取消或重跑当前 v0.10.29 发布。

当时的验证入口是仓库根目录 `npx vitest run tests/scripts/releaseWorkflow.test.mjs` 和推送钩子的完整 `npm run ci`。这些检查不能代替真实 Actions 依赖、跨平台缓存及安装包验收；当前本地检查须另获明确授权，推送不再自动运行。原阶段的实际发版验收设计为：

1. 当时预期下一正常版本完成所有版本与发布资料，标签和 `master` 指向同一提交，原子推送只触发一遍本地完整门禁；当前推送不执行该本地门禁。
2. 源码 CI 尚在运行时，发布工作流只等待。前端或 Rust 失败、取消、缺失或超时，应阻止安装包任务；其他 SHA、PR 或 fork 的成功记录不可复用。
3. 目标标签版本、标题、前端产物清单不符，或缺少／过期产物时应停止，不读取签名密钥继续打包。已有公开 Release 不可改写。
4. 正常路径复用可信 CI 的前端产物，三个标准平台与 Legacy 并行。逐项模拟标准包、Legacy 或 macOS 验证失败，最终任务不得公开 Release。
5. 记录第一次冷缓存与下一次热缓存发布的各阶段时间、缓存命中与产物来源；确认标准版／Legacy 缓存隔离，旧 CPU 包、自动更新签名和三平台安装升级仍按原桌面步骤验收。

回退时整体回退编排、脚本及文档，恢复旧版完整门禁和串行 Legacy，不改写已有标签、不删除已发布附件或清理用户项目。

## CI 日志与按需边界（2026-11-11）

状态：源码与回归用例已编写，仅完成调用链、差异和 UTF-8 静态核对。本次未运行测试，待用户验收；未运行 lint、类型检查、构建、性能基准或桌面交互。本节不沿用上文旧版流水耗时作为本次性能证据，也不修改发布门禁或 Vitest 文件串行设置。

- **预期失败日志**：Skill 压缩包的非法路径、冲突、多入口、原生拒绝与保存中断，以及本集资产清单的三条保存失败用例，仅捕获并精确断言本条预期日志。其他日志仍输出，测试结束恢复 spy；生产日志、脱敏、回滚和拒绝断言保留，不使用全局静默。
- **连线适配插件**：`scripts/viteCanvasEdgeLayer.ts` 的 `transform` 改为 Vite/Rolldown 对象钩子，`filter.id` 由已安装 React Flow 两个 ESM 入口生成，提前排除其他模块，减少无效 Rust/JavaScript 调用。handler 内仍核对真实入口，固定版本及源码结构守卫保留。回归源码覆盖正反斜杠、开发 URL 前缀、查询/片段和近似路径拒绝，不承诺 `PLUGIN_TIMINGS` 必然消失。
- **视频剪辑 AI 转场**：`VideoNode.tsx` 仅在收到模型目录或转场请求后加载 `videoEditorAiTransitionService.ts`，加载后复核捕获的窗口绑定，再读目录或开始调用。同步暂停、原结果回执和已完成结果保留路径保持原语义；加载期间窗口关闭／绑定撤销不能把请求交给新窗口。
- **AI 应用执行**：Agent 工具仅在实际 `canvas_app_run` 时加载 `aiAppRuntime.ts`，加载后重新检查项目、revision 与取消信号；SDK 查询和工具发现不因此加载隔离运行时。创建、更新、界面及动作仍共用原执行实现，不新增工具权限。
- **团队任务图**：将图编辑器从 `TeamExecutionPicker.tsx` 提取到 `TeamGraphEditor.tsx`，配置弹窗和任务卡都只在实际编辑时加载，复用既有加载提示与控件；执行方式入口保留同步展示。没有通过 Picker 静态重导出图编辑器，防止重新拉回静态依赖。

以上三处原先静态与动态混用的专用功能边界已按源码收敛。Store、文件基础设施及原生仓储等其他混用警告保留待分域审查；其中部分动态边承担循环依赖或运行时访问时机，不能批量改为静态。未提高 `chunkSizeWarningLimit`、关闭 Rolldown 警告或仅为分小文件配置强制分包。仍可能存在超过 500 kB 的产物，实际分包、启动及构建收益待同条件构建确认。

本轮完整文件范围：

- 构建：`scripts/viteCanvasEdgeLayer.ts`、`tests/scripts/viteCanvasEdgeLayer.test.ts`。
- 运行时加载：`src/components/nodes/VideoNode.tsx`、`src/services/chat/tools/aiAppTools.ts`、`tests/components/videoNodePreviewLifecycle.test.tsx`、`tests/services/chat/aiAppTools.test.ts`。
- 团队图：`src/components/shared/agentTeams/TeamGraphEditor.tsx`（新增）、`TeamExecutionPicker.tsx`、`TeamRunCard.tsx`，以及 `tests/components/agentTeamControls.test.tsx`。
- 日志：`tests/services/fileServiceSkillUpload.test.ts`、`tests/services/episodeAssetRoster.test.ts`。
- 文档：本专项和 `doc/开发指南.md`。

验收前置：使用同一依赖锁文件和机器，区分冷／热缓存；保留原 CI 的最终汇总与构建输出用于对照。用户可在仓库根目录执行定向回归和完整前端门禁：

```powershell
npx vitest run tests/services/fileServiceSkillUpload.test.ts tests/services/episodeAssetRoster.test.ts tests/scripts/viteCanvasEdgeLayer.test.ts tests/components/agentTeamControls.test.tsx tests/services/chat/aiAppTools.test.ts tests/components/videoNodePreviewLifecycle.test.tsx tests/services/videoEditorAiTransitionService.test.ts tests/services/videoEditorWindowService.test.ts
npm run ci
```

预期：原模拟失败用例通过且对应错误不再刷屏，非预期输出仍可见；插件守卫和两入口行为保持，三处功能可生成独立按需产物，最终以构建模块图核对；完整前端检查全部通过。记录实际构建总时长及插件耗时提示，不以减少告警数量推断性能收益。不要并行运行两套完整门禁比较耗时。

Tauri 桌面回归：

1. 打开主／独立助手及工作台，执行方式入口正常；首次打开团队配置或暂停任务的图编辑器才出现加载提示，随后可编辑依赖／正文来源并保存，关闭重开与深浅主题正常。
2. 打开视频剪辑窗口，模型目录正常；由用户使用可控模型验证转场成功和错误回执。请求加载期间关闭窗口、切换项目或撤销绑定，旧请求不得调用模型或写回新窗口；已有转场结果仍可按原入口取回。
3. 查询 AI 应用 SDK，再执行已有只读动作，输出与状态保存规则保持；加载期间取消或切项目，应拒绝执行，不新增状态写回或自动重试。

回退：恢复局部日志处理、函数式插件钩子和三处原导入边界，同时恢复测试导入。保留用户项目和产物；本轮无依赖、数据库或原生权限变化。

## 按改动检查与 Vitest 分片（2026-11-14，历史）

本节记录 PR #51 之前及第二阶段的历史实现；普通推送、PR 和本地钩子的触发策略已由本文开头 2026-11-15 规则替代。手动按改动入口与发布时的四分片保留。

第一阶段已实现。本地新增 `npm run ci:affected` 开发入口；`--plan` 预览分类，`--base <ref>` 指定比较基线，`--rust` 在涉及原生输入时检查当前平台。筛选由 Git 工作区差异、Vitest 导入关系和显式的文件读取用例共同决定，范围无法确认时走完整前端 CI。

第一阶段当时的 GitHub PR 与默认分支执行完整门禁。四个独立任务各运行一个 Vitest 分片，分片内沿用串行文件执行；全仓 ESLint 和测试类型检查并行启动。全部通过后，`Frontend quality` 执行应用类型检查、生产构建，并在默认分支 push 上传同 SHA 产物。发版核验同 SHA 的成功前端、Rust 和制品来源；当时本地 `pre-push` 也执行 `npm run ci`。

使用隔离检出和 Node.js 22，重放样式预览与 UI Kit CSS 的两文件改动，受影响检查选中 11 个 Vitest 文件，301 项通过，整个命令约 80 秒。同一源码快照的 `npm run ci` 约 6 分 16 秒，793 个文件、14021 项用例通过。四个分片与全量文件清单一致，无遗漏或重叠，14021 项通过。工作流通过 actionlint，发版回归及本地前端制品的 SHA／摘要校验通过。尚无新工作流的远程执行记录。

远程耗时基线见 [600bf4e0 的 GitHub CI](https://github.com/Tenney95/AI-Canvas-tauri/actions/runs/43576149995)。该提交只改动样式预览与 UI Kit CSS，前端任务约 14 分 40 秒，其中全量 Vitest 约 9 分 17 秒。首次远程验收需核对实际 Actions 的四个分片、全仓静态检查、`Frontend quality`、三平台 Rust 和制品名称，记录从工作流启动至前端门禁完成的墙钟时间。任一前端分片失败或取消时，该次运行不应上传可用于发版的前端产物。

原第二阶段的日常 `master` CI 从有 `Source CI baseline` 成功证明的最近祖先计算差异，纳入先前失败或取消的提交。找不到基线或影响范围无法确认时执行全量。按改动模式仍执行生产构建，原生相关改动触发 Rust 矩阵。发布资料变更强制完整检查，发版要求同 SHA、同一次尝试的 `Full source quality` 与前端制品。默认分支按 SHA 管理并发，后续推送可与发版源码检查并行。

原本地钩子在临时检出中验证 Git 实际推送对象。如同时推送 `master` 和指向同 SHA 的版本标签，则只验证一次全量。工作区既有修改与暂存内容不会进入该次检查。前端依赖按锁文件安装，复用 npm 下载缓存。

原第二阶段的验收设计以 PR 和首次默认分支运行记录为准：首次部署因工作流变更强制全量并生成该尝试的前端产物，后续普通代码推送记录成功祖先、执行定向前端检查与构建并按范围决定 Rust，明确独立的文档记录 `skip`。发版回归拒绝只有按改动结果或上一次尝试制品的提交。当前不再对普通推送执行这套自动验收。

回退第一阶段只需恢复 CI 的前端任务及移除可选的本地入口，不涉及项目数据、依赖或发版标签。

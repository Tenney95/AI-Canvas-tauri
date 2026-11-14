# 发布检查与打包加速

日期：2026-11-07。目标是缩短发版关键路径，同时保留完整前端与 Rust 门禁、签名和全部平台成功后公开的条件。主入口为[发版流程](../打包与发版流程.md)，不修改产品功能或已推送标签。

## 实测基线

| 阶段 | 实际耗时与来源 |
|---|---|
| v0.10.29 源码 Frontend quality | 13分34秒；[源码 CI](https://github.com/Tenney95/AI-Canvas-tauri/actions/runs/42346733676) |
| 同提交 Rust check | 5分27秒，与前端并行；同一源码 CI |
| v0.10.29 Release Quality gate | 11分20秒，重复完整前端检查；[发布工作流](https://github.com/Tenney95/AI-Canvas-tauri/actions/runs/42348612665) |
| v0.10.28 Release 全流程 | 65分38秒；[上一版发布](https://github.com/Tenney95/AI-Canvas-tauri/actions/runs/42185944138) |
| 上一版标准 Windows／Linux／macOS | 27分14秒／21分54秒／22分15秒，三者并行 |
| 上一版 Windows Legacy | 26分48秒，在三个标准包全部成功后才开始 |

Windows 标准包的 Rust release 编译约23分23秒，重复前端构建约56秒。源码 CI 中 ESLint 约119秒、应用类型49秒、测试类型67秒、Vitest 464秒。瓶颈优先级是串行 Legacy、重复完整检查与原生冷编译，不靠删除测试或提高超时缩短报告时间。

## 实施边界

1. 发版资料一次准备并提交，`master` 与标签指向同一提交后一次原子推送；`pre-push` 继续完整执行 `npm run ci`。不增加按 HEAD、时间戳或不完整输入树判断成功的本地缓存，也不为了补一次成功记录再推送一次。
2. 标签事件只将发布请求转交默认分支工作流。实际编排在默认分支运行以获得跨版本缓存，但每个构建检出固定的目标标签 SHA，标题和说明也从目标源码读取；手动从非默认分支启动、非法标签、版本不符和已公开 Release 均失败关闭。
3. 安装包构建前等待同仓库默认分支 push 的同 SHA 源码 CI，核验其前端与 Rust 检查均成功；失败、取消或等待超时不能进入打包。复用该次 CI 的前端产物，产物缺失或不符时提示恢复可信 CI 产物，不冒用其他提交或分支的结果。
4. 前端构建只做一次，后续 Tauri 构建通过固定发布配置复用产物并保留 MCP 适配器准备。产物来源和清单需要验证，普通本地 `tauri build` 保留原构建行为。
5. npm 与 Rust 缓存按系统、目标及标准／Legacy 模式隔离。Legacy 的无 AVX／AVX2 RUSTFLAGS 纳入其缓存身份；不缓存签名密钥，不将缓存当作质量证明。首次冷缓存、工具链或依赖变化仍可能触发完整编译。
6. 三个标准平台和 Windows Legacy 在门禁后并行构建。Legacy 先保存为 Actions 产物，最终任务等待两类构建成功后才上传到同一 Release 并公开，避免草稿尚未生成时抢先上传。macOS 签名与启动检查继续保留。

发布标题由 `.github/release-title.txt` 提供，正文只维护 `.release-notes.md`；不再在工作流 YAML 中重复抄写发布正文。原文档和既有标签保留历史身份，不将新流程应用到当前正在执行的旧工作流。

实现入口为 `.github/workflows/ci.yml`、`.github/workflows/release.yml` 和 `scripts/release-workflow.mjs`；标准／Legacy 的固定 Tauri 覆盖配置分别在 `scripts/tauri-release.config.json` 与 `scripts/tauri-release-legacy.config.json`。草稿查找沿用 GitHub／Tauri Action 的发布列表语义，并在最终上传和公开前复核标签与草稿目标。

## 可推算收益与限制

按 v0.10.28 的已有阶段时长，仅将 Legacy 并行，关键路径约从66分钟降到39分钟，可移除约27分钟的串行等待；再复用同 SHA 源码 CI，可移除本次约11分钟的重复发布检查。以上是已有阶段耗时的流程推算，不是优化后实测结果。Rust 缓存的实际收益、GitHub 排队和不同 runner 的差异仍待首次及后续热缓存发版对照。

当前保留 Vitest 的 `fileParallelism: false`。历史配置没有解释串行原因，现有只读检查不足以证明全量并行安全；有限并行另行验证，不与本轮发布编排同时改动。

## 验收与状态

状态：已实现，待实际验证；已完成 UTF-8、差异空白、脚本调用链与工作流依赖的静态核对，并用现有 GitHub 运行元数据确认 CI 字段和草稿列表语义。本次未运行测试、lint、类型检查、构建或基准，未提交、推送或触发新发布；新测试源码不代表已运行。不取消或重跑当前 v0.10.29 发布。

用户授权后，在仓库根目录执行 `npx vitest run tests/scripts/releaseWorkflow.test.mjs`，推送时由原 `pre-push` 完整运行 `npm run ci`。这些检查不能代替真实 Actions 依赖、跨平台缓存及安装包验收。实际发版验收：

1. 在下一正常版本完成所有版本与发布资料，确认标签和 `master` 指向同一提交，原子推送应只触发一遍本地完整门禁。
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

## 按改动检查与 Vitest 分片（2026-11-14）

第一阶段已实现。本地新增 `npm run ci:affected` 开发入口；`--plan` 预览分类，`--base <ref>` 指定比较基线，`--rust` 在涉及原生输入时检查当前平台。筛选由 Git 工作区差异、Vitest 导入关系和显式的文件读取用例共同决定，范围无法确认时走完整前端 CI。

GitHub 的 PR 与默认分支仍执行完整门禁。四个独立任务各运行一个 Vitest 分片，分片内沿用串行文件执行；全仓 ESLint 和测试类型检查并行启动。全部通过后，`Frontend quality` 执行应用类型检查、生产构建，并在默认分支 push 上传同 SHA 产物。发版继续核验同 SHA 的成功前端、Rust 和制品来源；本地 `pre-push` 继续执行 `npm run ci`。

使用隔离检出和 Node.js 22，重放样式预览与 UI Kit CSS 的两文件改动，受影响检查选中 11 个 Vitest 文件，301 项通过，整个命令约 80 秒。同一源码快照的 `npm run ci` 约 6 分 16 秒，793 个文件、14021 项用例通过。四个分片与全量文件清单一致，无遗漏或重叠，14021 项通过。工作流通过 actionlint，发版回归及本地前端制品的 SHA／摘要校验通过。尚无新工作流的远程执行记录。

远程耗时基线见 [600bf4e0 的 GitHub CI](https://github.com/Tenney95/AI-Canvas-tauri/actions/runs/43576149995)。该提交只改动样式预览与 UI Kit CSS，前端任务约 14 分 40 秒，其中全量 Vitest 约 9 分 17 秒。首次远程验收需核对实际 Actions 的四个分片、全仓静态检查、`Frontend quality`、三平台 Rust 和制品名称，记录从工作流启动至前端门禁完成的墙钟时间。任一前端分片失败或取消时，该次运行不应上传可用于发版的前端产物。

第二阶段的日常 `master` CI 从有 `Source CI baseline` 成功证明的最近祖先计算差异，纳入先前失败或取消的提交。找不到基线或影响范围无法确认时执行全量。按改动模式仍执行生产构建，原生相关改动触发 Rust 矩阵。发布资料变更强制完整检查，发版要求同 SHA、同一次尝试的 `Full source quality` 与前端制品。默认分支按 SHA 管理并发，后续推送可与发版源码检查并行。

本地钩子在临时检出中验证 Git 实际推送对象。如同时推送 `master` 和指向同 SHA 的版本标签，则只验证一次全量。工作区既有修改与暂存内容不会进入这次检查。前端依赖按锁文件安装，复用 npm 下载缓存。

第二阶段验收以 PR 和首次默认分支运行记录为准。首次部署应因工作流变更强制全量，并生成该尝试的前端产物。下一次普通代码推送应记录成功祖先、执行定向前端检查与构建并按范围决定 Rust；明确独立的文档应记录 `skip`。发版回归应拒绝只有按改动结果或上一次尝试制品的提交。

回退第一阶段只需恢复 CI 的前端任务及移除可选的本地入口，不涉及项目数据、依赖或发版标签。

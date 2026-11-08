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

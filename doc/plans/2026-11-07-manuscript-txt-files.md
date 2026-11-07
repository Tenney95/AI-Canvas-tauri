# 原文与分集剧本 TXT 文件实施方案

**Goal:** 原文和分集剧本保存为项目目录内可直接打开的 TXT，原文使用普通文本编辑。

**Architecture:** 项目记录保留正文和可移植相对文件引用，文本文件写入后读回核对，再确认项目记录保存。文件操作只由主窗口执行，复用已有 UTF-8、项目范围、版本和保存队列守卫。

**Tech Stack:** Tauri 2、React、Zustand、IndexedDB、现有文件服务；不新增依赖。

## 目录与保存约定

`essay` 通常指随笔或议论文，采用能同时涵盖原文和剧本的 `manuscripts`（稿件）：

```text
项目目录/
└─ manuscripts/
   ├─ 原文.txt
   ├─ EP000 序章.txt
   └─ EP001 第一集.txt
```

- 文件名使用实际分集名称，清洗 Windows 非法字符；重名不覆盖其他文件，成功后保存实际相对引用。
- 原文新稿首次保存才创建文件。已有根目录 TXT 或 Markdown 原文在下一次显式保存时转存 TXT，旧文件保留。
- 已有分集正文在下一次保存时生成 TXT；不在启动时批量写文件。工作台允许为尚无文件的旧正文点击保存。
- 分集改名后，下次保存正文按新名转存；旧文件保留，不自动删除用户稿件。
- 应用项目记录和 TXT 同步维护；外部改动出现冲突时拒绝静默覆盖，保留草稿。暂不监听外部文本反向更新项目正文。

## 实施步骤

1. 文件基础设施：`src/services/fs/assetTextFiles.ts` 支持受限 `manuscripts` 子目录，校验普通目录、UTF-8、大小、唯一新建与读回。补充 `tests/services/assetTextFileCreation.test.ts` 的目录和冲突用例。
2. 原文保存：`src/services/originalWritingService.ts` 统一新建／迁移与引用改绑，保留旧文件摘要、失败重试、并发输入及跨窗守卫。补充 `tests/services/originalWritingService.test.ts`。
3. 分集剧本：`src/services/episodeScriptFileService.ts` 处理受管 TXT；在 `src/store/store.projects.ts` 的 `updateEpisodeCreative` 收口同步，覆盖工作台、Agent 和团队，失败不得报告保存成功。类型、摘要、归档和三方合并保留正文／文件关联，补充对应回归源码。
4. 普通编辑：`src/components/OriginalWritingEditor.tsx` 使用普通文本框，去掉 Markdown 格式及预览；保留章节、选区、AI 候选、原生撤销和 Ctrl+S。更新组件用例及工作台旧稿保存入口。

## 验收与回退

状态：已实现，待用户验收；本轮未运行测试、lint、类型检查、构建或桌面验收。自动化用例补充不代表已通过。以后提交推送仍须由 `pre-push` 完整执行 `npm run ci`。

桌面验收：

1. 准备一个未添加原文、包含两集旧正文的剧集。在桌面工作台的「原文」页手写或采用 AI 开篇，再点击「保存原文」，项目目录应出现 `manuscripts/原文.txt`，重新打开后正文保留。仅打开或编辑而未保存时不创建文件；文本框无 Markdown 工具栏，原生撤销和 Ctrl+S 可用。
2. 两集分别点击「保存本集」，应按实际集名生成 TXT；重开后正文与文件对应。将一集改名后再次保存，应创建新集名文件，旧文件保留。已有同名文件时不得覆盖，连续保存应复用实际创建的文件。
3. 打开已有根目录 TXT 或 Markdown 原著，下一次显式保存应转存为 `manuscripts` 内 TXT 并改绑，旧原著保持原样。保存后从独立工作台编辑再收回，正文与保存状态应一致。
4. 用外部编辑器修改已绑定 TXT，再从工作台保存，应提示冲突并保留草稿。回归保存中切项目／换原著、目录不可写与数据库保存失败后重试，不能把旧上下文写到新项目或报告假成功。
5. 导出并导入包含稿件的项目，检查 TXT 随归档携带且原文／分集仍可保存；三方合并冲突时分集正文与对应文件引用一起选择。回归深浅主题、长集名及窄窗口。

用户可在仓库根目录执行：`npx vitest run tests/services/assetTextFileCreation.test.ts tests/services/originalWritingService.test.ts tests/services/episodeScriptFileService.test.ts tests/services/manuscriptFileReference.test.ts tests/store/projectSeries.test.ts tests/components/originalWritingEditor.test.tsx tests/components/scriptWorkbench.test.tsx tests/services/storageServiceProjectLoad.test.ts tests/services/projectTransferService.test.ts tests/services/projectMergeService.test.ts`。这些自动化入口不能代替桌面文件和多窗口验收。

旧原文及改名前文件保留，项目正文继续保存在项目记录中；发现文件同步失败时先保留当前草稿和文件，不自动清理或批量覆盖。回退实现前先导出项目并备份稿件目录。

# 文件读取与保存性能优化

主模块：[文件与存储](../文件与存储模块.md)。任务类型：现有平台能力的局部性能修复，不调整架构、文件格式、权限或依赖。

状态（2026-11-05）：全部优化已提交为 `3e7c770c`。用户随后授权助手测试；自动化验证及修正见下方“提交与自动化验证”。前面各轮的“未运行测试”是实施时记录，以最新验证节为准。未做实际吞吐／峰值内存采样或桌面交互验收，不承诺实测提速比例。

## 调查结论与实施范围

| 文件 | 已实施内容 |
|---|---|
| `src/services/fileService.ts` | 为全局资产复用现有原生流式复制提供窄包装；本地节点另存到尚不存在的目标时复用该通道，已有目标保留对话框确认后的覆盖语义；Data URL 保存复用现有分块解码。 |
| `src/services/fs/assetLibrary.ts` | 添加本地文件、保存真实文件到永久目录改走上述复制；虚拟资产保存复用分块解码。保留顺序、成功计数、同名分配与失败返回。 |
| `src/services/fs/mediaRead.ts` | 私有句柄记录读取位置，连续分块不重复 seek；重复和随机 offset 仍定位，保留前后路径与句柄元数据核对、忙碌拒绝及关闭屏障。 |
| `src/services/fs/core.ts` | 合并同路径、文件大小和预览上限的在途文本读取；缓存键纳入预览上限并区分未知大小与空文件，失效后旧请求不回灌缓存。仍限读片段，失败不回退整文件。 |
| `src/services/indexedDbService.ts` | 消息分页用游标 advance 跳 offset，取足即停；分配序号只读末尾索引键；普通／永久删除会话时的消息清理只读键，保留事务和索引范围，事务完成后返回、中止时拒绝。 |
| `src-tauri/src/files/transfer.rs` | 网络分片直接复制到调用方缓冲，只有尾部需要 pending；缓冲短写，发布前显式 flush/sync；进度保留首片及末次，中间按时间合并，取消仍逐片检查。 |
| `src-tauri/src/files/thumbnail_cache.rs` | 缓存命中分开读取固定头和 payload，返回原 payload Vec，避免整张缩略图再次复制；保留大小、SHA-256、完整解码、来源版本和路径校验。 |
| `doc/plans/2026-11-05-file-io-performance.md` | 本文记录范围、实际完成状态、验收缺口及回滚。 |
| `doc/plans/计划索引.md` | 在文件生命周期领域链接本文。 |

回归源码文件（只编写，不自动执行）：

- `tests/services/assetFolderNavigation.test.ts`：原生复制、不走整文件读取、同名及失败计数。
- `tests/services/fileServiceSaveAs.test.ts`：新目标流式复制、旧目标覆盖、取消、来源缺失回退和分块解码。
- `tests/services/fs/mediaRead.test.ts`：连续、重复和随机 offset，短读、取消、变化及句柄关闭。
- `tests/components/assetTextPreview.test.tsx`：并发合并、不同限读大小、未知大小／空文件隔离、失效期间新旧读取两种完成顺序、失败重试及句柄释放。
- `tests/services/chatMessageSequence.test.ts`：分页边界、倒序、空会话、序号分配、并发新增、跨会话隔离及删除。
- 两个 Rust 文件内的既有 `tests` 模块：短分片、完整字节、取消与临时文件、进度首尾、损坏/截断/超长缓存。

## 保护边界与暂缓项

- 当前工作区的 S3 共享同步改动不属于本轮；不修改这些在改文件（包括文件与存储模块主文档和 `lib.rs`）。
- 原生复制仍沿用真实路径授权、独占发布、长度校验、进度和取消；新目标出现并发占用时拒绝覆盖，不自动改为覆盖或重试。
- 节点另存为在复制前已确认源缺失时保留原 URL 回退；若源在预检之后才消失，则报告复制失败，避免把目标权限／抢占错误误判成源错误后回退覆盖。已有目标的覆盖入口仍会完整读取文件，其流式覆盖需要另外明确发布与覆盖语义。
- Data URL 解码沿用现有 helper，不新增保存体积政策。流式复制只改变字节传输路径，不改变文件归属、身份或内容。
- IndexedDB schema、保存队列、exchangeEpoch 权威和项目隔离保持原语义。不能用摘要替换保存前完整旧项目读取而放松代际保护。
- 文本保存冲突校验、不可变项目文件读回复核、归档的预检和最终内容校验继续保留。消除归档重读需要先明确各次校验保证，未列入本轮实施。
- 原生短写增加固定 1 MiB 写缓冲，换取合并小片写入；并发任务的额外缓冲开销仍需连同吞吐采样。取消／失败通过 `into_parts` 丢弃尚未落盘的缓冲；成功显式 flush、sync 后才校验和发布，不能依赖 Drop 刷盘。
- 不修改无实际调用的 `listDirectoryFiles`，不加入全局文件内容缓存或无限并发。
- 首轮暂缓的缩略图写入二进制 IPC 已在下方“剩余读写收敛批次”成对实施，保留元数据、体积及路径校验。读取返回还包含源版本、尺寸和 miss 信息，继续保留原响应合同，不直接替换成裸图片。

## 开源对照

- [Joplin 本地文件驱动](https://github.com/laurent22/joplin/blob/dev/packages/lib/file-api-driver-local.ts)：`get(target=file)` / `put(source=file)` 直接复制文件，避免把字节读到上层再写出。本轮复用项目已有的流式复制，不引入其依赖或代码。
- [Tauri 文件插件](https://github.com/tauri-apps/plugins-workspace/blob/v2/plugins/fs/guest-js/index.ts)：支持原生 copyFile 和 ReadableStream 写入；本项目已有更完整的取消、进度及独占发布通道，应优先复用。
- [Zed 文件系统](https://github.com/zed-industries/zed/blob/main/crates/fs/src/fs.rs)：重 I/O 放后台，原子保存使用目标所在卷的临时文件；本项目已有相应边界，继续保留。
- [Dexie Collection](https://github.com/dexie/Dexie.js/blob/master/src/classes/collection/collection.ts)：简单索引范围分页通过 `cursor.advance` 跳过 offset，键枚举不请求 value；本轮沿用原生 IndexedDB 完成同类优化，不引入 Dexie。

以上是实现方式对照，不是相同设备、相同数据上的性能测试。可确定减少的工作包括整文件 JS/IPC 往返、连续读取的 seek、逐条跳过 offset 的 JS 回调、分片中间复制及缩略图 payload 复制；耗时、峰值内存和用户体验收益仍待采样。

## 验收（待用户执行）

前置：加载本轮前端及原生代码的 Tauri 桌面开发版本，使用可丢弃项目与复制素材。固定同设备、同项目、同文件及操作顺序比较前后耗时与峰值内存，不用 Web 结果代替桌面验收。

1. 在资产面板添加多个图片、音视频及同名文件，保存外部素材到永久目录；内容完整，同名生成独立副本，源文件不变。回归目录离线、权限拒绝和单项失败后的成功计数。
2. 节点另存为分别选择新路径、已有文件、原文件自身；保留取消和覆盖确认，结果完整。回归源文件缺失时 URL 回退、Data URL 图片、保存中取消和目标被其他任务抢占。
3. 连续下载本地原素材并重复请求分块，再随机读取；字节一致，取消后句柄可释放，读取期间替换文件应拒绝继续。
4. 多个条目同时预览同一文本，保存等字节长度的新正文后刷新；不得复用旧内容。回归不同预览长度、读取失败重试和空文件。
5. 长会话逐页读取、保存新消息、更新旧消息和删除会话；顺序、总数、序号、项目隔离及清理结果保持正确。
6. 下载短分片媒体和复制大文件，首批及最终进度可见；取消或磁盘/网络失败不发布残缺目标，重试可用。进度合并不得延迟取消；回归无 Content-Length 和超时。
7. 图片缩略图首次生成、再次命中、源文件变化、缓存损坏/截断后重建；原图、尺寸和项目归属正确。

仓库根目录可执行：

```powershell
npx vitest run tests/services/assetFolderNavigation.test.ts tests/services/fileServiceSaveAs.test.ts tests/services/fs/mediaRead.test.ts tests/components/assetTextPreview.test.tsx tests/services/chatMessageSequence.test.ts
npm run typecheck
npm run test:typecheck
```

在 `src-tauri/` 可执行：

```powershell
cargo test --lib file_transfer::tests
cargo test --lib thumbnail_cache::tests
cargo check --lib
```

## 第二轮：生成历史与素材指纹（2026-11-05）

状态：用户要求继续优化后，已完成以下局部修复和回归源码。范围为两个源码文件、本文及两个回归文件；保留首轮及其他任务差异。本次未运行测试，待用户验收；没有耗时或内存采样结果。

| 文件 | 本轮变化 |
|---|---|
| `src/services/indexedDbService.ts` | 生成历史裁剪使用键游标，一次 `advance(16)` 跳过保留区，再按主键删除旧项；项目／节点历史清理只请求键，并在事务中止时拒绝。保留最新 16 条、同时间戳按 id 倒序、项目与节点范围和原事务。 |
| `src/services/fs/assetImageMetadata.ts` | `fingerprintAssetImage` 每文件复用一个 `32 + 256 KiB` 输入缓冲，内容直接读入摘要前缀后的区域，消除每块重新分配大数组和拼接内容的复制。等待当前摘要完成后才复用，尾块仅包含实际读取字节，旧链摘要、文件变化检查和关闭逻辑保持。 |
| `tests/services/imageGenerationHistory.test.ts` | 补充 0／1／15／16／17／35 条边界、同时间戳排序、键游标和跳过工作量、单条保存、项目／节点隔离及清理中止回滚。 |
| `tests/services/assetImageMetadata.test.ts` | 用独立 Node SHA-256 实现核对旧算法的整块与尾块向量，覆盖短读与等待摘要期间缓冲不被覆盖。 |

可确定减少的是保留区的逐条游标回调，以及逐块分配／内容拼接；不假定所有浏览器的值游标都会立即解码正文，不据源码差异承诺具体速度或峰值内存降幅。没有更改数据库版本、摘要身份协议、保存权限或依赖。

用户在仓库根目录可执行：

```powershell
npx vitest run tests/services/imageGenerationHistory.test.ts tests/services/assetImageMetadata.test.ts tests/services/chatMessageSequence.test.ts
npm run typecheck
npm run test:typecheck
```

桌面前置：使用含可丢弃素材的测试项目，加载本轮前端。连续生成超过 16 条记录后，打开生成历史，应只保留最新 16 条；单节点删除历史和项目清空不得影响其他节点／项目，保存重开后结果一致。使用大于 256 KiB、包含非整块尾部的素材打开图片信息、保存提示词／参考图，再重开，应仍匹配原摘要和元数据；回归批量素材识别、取消、读取中替换文件，以及无权限／离线文件拒绝且句柄释放。本轮未修改原生代码，不能据此宣称上述桌面操作已通过。

回滚本轮只撤销本节三份非测试文件与两份回归文件中的本轮差异，不撤销首轮消息分页等修改；无需迁移数据库或重算既有素材摘要。

## 第三轮：默认目录与素材恢复扫描（2026-11-05）

状态：用户继续要求优化后，已完成下列局部改动、回归源码、交叉代码审查及五文件严格 UTF-8／差异空白静态核对。本次未运行测试，待用户验收，未做性能采样。范围为两个源码文件、本文及两个回归文件。

| 文件 | 本轮变化 |
|---|---|
| `src/services/fs/core.ts` | 私有 `getAppDataDir` 在当前窗口模块生命周期内复用成功的系统目录，并合并在途查询；失败／空值不缓存，后续调用可重试，非 Tauri 环境仍返回空。用户自定义根目录和项目文件夹映射仍在各入口实时解析，不缓存文件状态或授权。 |
| `src/services/storageService.ts` | 缺失素材恢复直接复用 `scanDirectoryFiles` 已完成的 stat、身份登记和失败统计，传入 `source: project`、所属项目与根 `.thumbnail` 排除，移除扫描后的整批重复识别。扫描失败／不完整仍保留持久画布，重试前继续清空文件存在性缓存。 |
| `tests/services/fs/coreDataDir.test.ts` | 覆盖混合入口并发合并、成功复用、同步／异步失败及空值重试、运行环境切换、自定义目录切换和项目文件夹变更。 |
| `tests/services/storageServiceProjectLoad.test.ts` | 同步为项目扫描合同，保留缺失恢复、缓存目录排除、文件重现和恢复并发边界；补充真实扫描器与 IndexedDB 登记复用、退役副本排除、改名后按真实索引恢复，以及扫描失败／部分失败／截断。 |

确定减少的工作：默认根目录下的多个缩略图会话、项目存取与存储扫描共享一次成功的系统路径查询；缺失素材恢复不再对刚扫描登记的全部文件重新 stat、读取和写入索引。实际耗时和内存收益待测。不缓存用户的可变目录选择；已经开始的操作仍按原先捕获的目录处理，新操作读取最新配置。

使用现有扫描器的项目模式同时保留其退役副本排除、普通文件和项目身份校验及有界扫描。不完整结果只用于尽力恢复已有引用并提示状态，不能据此推断删除、冒充扫描完成或反复扩大范围。

用户在仓库根目录可执行：

```powershell
npx vitest run tests/services/fs/coreDataDir.test.ts tests/services/storageServiceProjectLoad.test.ts tests/services/thumbnailCache.test.ts tests/services/projectAssetScanRelocations.test.ts
npm run typecheck
npm run test:typecheck
```

桌面前置：使用测试项目及复制的素材，加载本轮前端。默认存储目录下打开多图项目，缩略图、保存和重开应正常；在设置中切换自定义目录，再恢复默认目录，新操作应使用新选择。外部改名／移动项目中的图片或视频后重新打开项目，恢复扫描应保持稳定身份并找回引用；`.thumbnail` 和已退役的旧副本不得登记为素材。回归离线／无权限目录、不完整扫描、扫描期间文件重新出现及其他项目隔离，失败时应保留原画布，允许后续重试。

回滚只撤销本节对应代码和回归差异，保留前两轮及其他任务改动。没有原生命令、权限、依赖或数据库版本变更，无须迁移存储目录或清理用户文件。

## 第四轮：导出聊天批量读取（2026-11-05）

状态：用户继续要求优化后，已完成两个源码文件中的导出读取收敛、回归源码及交叉代码审查，并对五文件进行严格 UTF-8／差异空白静态核对。本次未运行测试，待用户验收；没有耗时、峰值内存或桌面采样结果。

| 文件 | 本轮变化 |
|---|---|
| `src/services/indexedDbService.ts` | 新增 `getProjectChatForExport`，在同一只读事务中按原索引读取本项目会话与记忆，再按会话用 `getAll(limit + 1)` 批量读取消息。过滤已删除会话，保留会话／记忆原排序及同消息序号时的旧主键倒序；事务完成后返回，超限或中止时拒绝。 |
| `src/services/projectTransferService.ts` | 导出聊天改用批读入口，保持单会话 100000 条上限，继续经过 `portableArchiveChat` 脱敏、总量检查和后续整包关系校验；普通项目、剧集与分集入口共用原打包流程。 |
| `tests/services/projectChatExport.test.ts` | 用真实 IndexedDB 覆盖空项目、多会话、已删除会话、项目范围、记忆来源、同序号顺序、消息上限及事务中止，并核对批读替代逐条游标。 |
| `tests/services/projectTransferService.test.ts` | 改为直接提供批读材料，覆盖调用参数、取消、普通／剧集聊天与跨分集记忆往返、读取失败／超限中止、序列化失败及原生打包失败清理。 |

可确定减少的工作是每个会话的额外计数请求、逐消息游标回调和分散的读取事务，不承诺具体提速比例。消息仍需要完整进入归档，整体材料的大小未因此降低。没有修改普通聊天分页 API、消息序号写入、数据库版本或保存代际保护。

读取范围保持原有项目会话与会话消息索引合同，不靠额外丢弃损坏记录隐藏归属错误。可移植脱敏不是完整的关系校验；序列化后的收件校验与原生内容校验继续负责拒绝损坏归档。项目记忆可引用其他分集会话，不按本项目会话集合清空其来源。

用户在仓库根目录可执行：

```powershell
npx vitest run tests/services/projectChatExport.test.ts tests/services/projectTransferService.test.ts tests/services/projectArchiveRoundTrip.test.ts tests/services/chatMessageSequence.test.ts
npm run typecheck
npm run test:typecheck
```

桌面前置：使用测试项目及复制素材，加载本轮前端。分别导出空项目、含多个会话／项目记忆的普通项目，以及含多集聊天和跨集记忆来源的剧集，再导入核对正文、顺序和来源关系；回收站会话不应被导出。回归从单集入口导出、取消保存对话框、超限拒绝和打包失败；失败不能发布截断聊天或触发项目导入，副本创建失败应清理本次临时包。普通聊天分页及旧消息更新顺序保持原行为。

回滚仅撤销本节代码、回归和记录差异，保留前三轮及同文件内其他任务变更；无数据迁移或用户文件清理。

## 剩余读写收敛批次（2026-11-05，已实现，待用户验收）

用户已确认按完整剩余批次实施。下列 7 个源码文件、本文、7 个前端回归文件及 Rust 内联回归已完成实现和交叉代码审查。本批为既有文件能力的局部性能修复，不调整架构或权限。本次未运行测试，待用户验收；未运行类型检查、lint、构建、基准或桌面验收，没有实际提速或峰值内存测量结果。

### 完整源码与文档清单

| 文件 | 已实现内容 |
|---|---|
| `src/services/fs/thumbnailCache.ts` | 缩略图写入改为原始二进制 IPC，固定元数据以 UTF-8 JSON → Base64 放入专用 ASCII header；保留串行队列、8 MiB／64 项等待上限、取消和会话捕获。读取响应合同不变。 |
| `src-tauri/src/files/thumbnail_cache.rs` | 原写命令接收 Raw body，先检查主窗口、4 MiB 图像上限、唯一且有界的元数据 header，再解码固定 schema 并复用原路径／版本／图片校验；缓存头与 payload 分片写入，省掉合并整图副本。现有 `publish_cache_file` 对 Sprite 的签名不变。 |
| `src-tauri/src/files/project_archive.rs` | 在各次扫描、打包复核、解包读回与素材发布操作内复用 scratch 缓冲，去掉逐素材分配／清零；全部文件读取、原始预检、摘要比较和落盘读回仍执行。 |
| `src-tauri/src/files/transfer.rs` | 已知长度的小文件按实际长度分配读／写缓冲，未知／大文件保持既有 1 MiB；零长保留至少一个字节的探测能力，实际数据超过已知长度时提前失败，避免异常源触发大量小块读取。保留取消、进度、flush／sync 和独占发布。 |
| `src/services/fileService.ts` | 授权文本真正限读至 `maxBytes + 1` 并保留 UTF-8、取消和句柄关闭；桌面上传的内存降级改用既有异步分块 Base64；普通非 GitHub HTTP 媒体另存到新目标时复用原生流下载，失败不回退覆盖。已有目标覆盖、GitHub 镜像／切源、asset／Blob 读取及 Comfy 专属行为保持。 |
| `src/services/fs/dramaAssetArchive.ts` | Blob 素材直接读取有同等体积限制的原始字节，省掉 Blob → Base64 → 字节的往返；每次异步边界继续检查操作 guard，保留原生最终复制／摘要校验和暂存语义。 |
| `src/services/indexedDbService.ts` | `putAssetIndexes` 先保留逐条墓碑检查，再整批复用一次现有重定位日志读取；保持逐条身份、原路径标签、顺序、同值免写、使用时间和摘要合并。仅纯删除的项目域／项目记忆索引游标改为键游标；孤儿消息和 MCP binding 内容扫描、需要 `markMcpTaskDeleted` 的值读取不改。项目删除的错误／中止处理统一提供 Error 回退，避免显式中止先拒绝空值。 |
| `doc/plans/2026-11-05-file-io-performance.md` | 本节记录实际状态、边界、验收缺口和本批回滚，不改其他任务正在维护的模块文档。 |

### 完整回归源码清单

- `tests/services/thumbnailCache.test.ts`：Raw 字节、中文／空格／百分号路径元数据、队列、取消和失败降级。
- `tests/services/fileServiceTextRead.test.ts`（新增）：短读、刚好上限、读取中增长、取消等待、UTF-8 与关闭。
- `tests/services/fileServiceDataUrlLimits.test.ts`：上传降级继续执行大小预算，并复用异步编码。
- `tests/services/fileServiceSaveAs.test.ts`：普通 HTTP 新目标流式下载、目标抢占、失败／取消不覆盖；已有目标、GitHub 和 Comfy 分支回归。
- `tests/services/dramaAssetArchive.test.ts`：Blob 直读、相同限额、guard 失效、原生复制和失败保留。
- `tests/services/assetIndexBatch.test.ts`：每批仅一次迁移日志读取、原路径标签、重复身份顺序、墓碑／迁移／失败回滚。
- `tests/services/chatMessageSequence.test.ts`：项目域和项目记忆键删除、隔离及回滚；保留孤儿消息与 MCP 内容处理边界。
- 三个 Rust 文件内既有 `tests` 模块：二进制参数／元数据拒绝、分片缓存发布与原格式读取、scratch 连续复用的真实摘要、传输长度／小缓冲边界及原子发布。

### 固定边界与回滚

- 无新增 npm／Cargo 依赖、命令、ACL、窗口 capability、数据库版本或磁盘格式。前后端须成对加载新的缩略图写入合同；旧缓存可照常读取，协议错配只能降级为可重建缓存 miss，不回退宽松写入。
- 原生写缓存只读取一个专用元数据 header；它是 ASCII 编码的固定四字段 JSON，限制编码长度后才解码，不拒绝 Tauri 自动运输 header，不把路径写入日志。读取响应继续包含源版本、尺寸与 miss 信息，不另建二进制返回协议。
- 授权文本不依赖先前 stat 作为实际读取上限，文件增长只触发有界拒绝；不增加文件 grant，也不放松权限。普通网络另存只对新目标启用独占流下载，GitHub 保留现有镜像及可重试错误策略，覆盖目标仍走原路径。
- 对归档安全校验、文件真实落盘读回、凭据、插件安装协议和当前 S3／MCP 在改业务不作削弱或无关改动。进一步减少这些读取或改覆盖发布语义，需要独立的保证说明和测量，不能当作纯粹重复删除。
- 回滚仅撤销本表和回归文件中的本批差异，保留前四轮和其他任务差异。不删除用户文件或旧缓存，不重建数据库。

### 本批验收（待用户执行）

前置：重新构建并启动同时加载本批前端与 Rust 的 Tauri 桌面版本，使用可丢弃项目及复制素材；已有磁盘缓存无需清理。固定同设备、文件和操作顺序比较前后耗时与峰值内存，不能据下列回归源码推断实际收益。

1. 打开多图项目生成缩略图，关闭重开确认命中；项目和素材路径包含中文、空格及 `%` 时也应正常。替换源图、破坏缓存、快速切换项目或取消加载后，不能使用过期图像。回归 Sprite 预览及既有缓存读取。
2. 通过对话文件授权入口读取空文件、接近 256 KiB 上限的 UTF-8 文本和超限文本，分别应返回完整正文或明确拒绝。读取期间取消或文件增长时应停止并释放句柄；非法 UTF-8、离线及无权限目标不得降级为整文件读取。
3. 将普通 HTTP 图片、音视频另存到新目标，核对完整字节及进度；保存中取消、网络失败、目标被抢占时不得留下残缺或覆盖既有文件。分别回归已有目标覆盖、GitHub 官方源／镜像、Comfy、asset／Blob 和本地素材；小文件与未知长度响应均应可用。
4. 导入 Blob 来源的图片、音视频创作资产后重开项目，内容、项目归属和引用应保持。回归超过相应媒体预算、过程中取消／切换项目、暂存失败及 Data URL 来源，失败不能发布不完整资产。
5. 批量扫描含改名／移动素材及已有标签的项目；原标签、稳定身份、使用时间和内容摘要应保留，退役素材仍拒绝登记。删除测试项目或清空项目记忆后重开，相关会话、孤儿消息、任务及 MCP 绑定应按既有规则清理，其他项目和非绑定元数据不受影响。
6. 导出并导入含多份大小不同素材的项目，核对素材与聊天内容；覆盖空文件、超过 1 MiB 的文件及短尾块。取消、摘要错误、超限、解包失败时仍应拒绝发布；不能减少归档完整读回校验作为验收手段。

用户在仓库根目录可执行：

```powershell
npx vitest run tests/services/thumbnailCache.test.ts tests/services/fileServiceTextRead.test.ts tests/services/fileServiceDataUrlLimits.test.ts tests/services/fileServiceSaveAs.test.ts tests/services/dramaAssetArchive.test.ts tests/services/assetIndexBatch.test.ts tests/services/chatMessageSequence.test.ts
npm run typecheck
npm run test:typecheck
```

在 `src-tauri/` 可执行：

```powershell
cargo test --lib thumbnail_cache::tests
cargo test --lib project_archive::tests
cargo test --lib file_transfer::tests
cargo check --lib
```

## 提交与自动化验证（2026-11-05）

在 `3e7c770c` 的独立工作树验证，复用已安装依赖，隔离 S3／MCP 并行改动；随后在同一工作树应用下列最小修复再重跑。未推送，未运行生产构建、全量前端测试、性能基准或桌面交互验收。

- 首轮前端 470 项中 466 项通过，4 项失败已修正：索引 `getAll` 的中止注入捕获真实事务，并明确断言注入发生；节点历史清理接受原生 `AbortError`，继续核对事务回滚和项目隔离。
- 类型检查暴露提交基线已有的筛选表达式多余括号及 `ToolResultSummary.errorCode` 声明缺失，已通过 `21cd445d` 独立修复，仅修改一个括号与一个可选类型字段，保留并行 MCP 差异。节点工具的 138 项回归也纳入最终前端重跑。
- 归档首轮并行测试有一次临时目录撞名，串行复核 27 项通过。测试 Fixture 已给既有进程 ID／时间目录名追加原子序号，修复只在 `cfg(test)` 内，不改变归档业务逻辑。

| 验证范围 | 实际结果 |
|---|---|
| 本专项 16 个前端回归文件及 7 个相关既有文件 | 最终重跑 23 文件、608 项通过 |
| 本专项改动的 26 个 TypeScript 文件及上述两处检查阻断文件的定向 ESLint | 通过，零警告 |
| `npm run typecheck`、`npm run test:typecheck` | 修复后均通过 |
| `cargo test --lib thumbnail_cache::tests` | 13 项通过 |
| `cargo test --lib file_transfer::tests` | 32 项通过，1 个既有 176 MiB 压力项按原声明忽略 |
| `cargo test --lib project_archive::tests` | Fixture 修复后默认并行 27 项通过 |
| `cargo check --lib` | Fixture 修复后重跑通过 |

前端最终重跑命令，运行目录为仓库根目录：

```powershell
$ioRegressionFiles = @(git show --pretty= --name-only 3e7c770c | Where-Object { $_ -match '^tests/.*\.tsx?$' })
$ioRegressionFiles += @('tests/services/base64Encoding.test.ts', 'tests/services/mediaRelocations.test.ts', 'tests/services/projectAssetScanRelocations.test.ts', 'tests/services/projectArchiveRoundTrip.test.ts', 'tests/services/recentAssets.test.ts', 'tests/services/seriesSourceService.test.ts', 'tests/services/chat/canvasTools.test.ts')
npx --no-install vitest run @ioRegressionFiles
npm run typecheck
npm run test:typecheck
```

Rust 命令及桌面操作步骤见各轮验收节。上述自动化结果不代替 Tauri 桌面验收；原生读写、取消、路径切换、缓存命中和实际性能收益仍须按同设备／同文件条件验证。

## 回滚

仅撤销上表及回归文件中本轮差异；保留其他任务改动。没有数据迁移、依赖或配置变更；无需删除原文件、缩略图或重建数据库。若实测收益不足或行为回归，按入口分别撤回，不能靠跳过完整性与权限校验获得提速。

# 设置持久化可靠性优化方案

## 目标与当前状态

用户已要求优化渠道凭据、MCP 固定令牌、普通设置、工具栏布局、多实例覆盖与退出保存，并希望降低读取失败概率。本方案属于包含明确 bug 修复的架构收敛：保留现有存储介质，调整读取状态、保存意图和失败恢复。

当前阶段：三个已确认阶段均已完成。原生锁、条件读写、同步落盘、删除收敛和同类型工具栏冲突已通过定向回归；真实桌面退出重开与断电验收仍未进行。

## 已确认问题

1. 普通设置保存仍核对全部 Key；凭据读取失败会阻止主题等无关设置保存。界面先更新内存，失败后仅提示，调用方默认收到成功结束的 Promise。
2. MCP 把读取失败当成条目不存在，会生成新令牌；后续写入成功就覆盖原固定令牌。
3. 工具栏读取失败返回空值，缺少加载完成保护；下一次修改可能覆盖其他布局。
4. 多个实例按整份旧快照保存；串行队列无法阻止逻辑上的旧值覆盖。
5. 主窗口退出等待项目保存，但没有等待设置保存队列。

## 推荐方案

- 普通设置继续使用 IndexedDB；渠道 Key 与 MCP 令牌继续只由 Rust 私有凭据存储持久化。
- 普通设置采用字段级变更及冲突检测；凭据只在显式修改、迁移或恢复时读写，不因修改主题或窗口大小反复读取全部 Key。
- 区分不存在、未加载、读取失败、保存失败、版本冲突和已保存。只对明确的瞬时读取故障做少量有上限的重试；不自动重试写入、权限错误、损坏或版本不兼容。
- 保留最后成功读取/保存的内存状态；失败不能清空或覆盖原记录。未保存修改要可见、可重试，退出等待队列并报告失败。
- 工具栏按节点类型保存局部变更，失败加载不开放覆盖；普通配置在同一个 IndexedDB 事务内比较版本并合并变更。
- 原生凭据复用已有 fs2 依赖实施跨进程锁，保留临时文件替换并补全同步落盘与结构化错误分类；新增私有锁文件同时纳入私有资源拒绝范围。
- 不将旧凭据备份自动恢复为当前 Key/令牌，避免恢复已被用户撤销的凭据。数据库和原生凭据无法组成单个跨介质事务，必须明确处理部分成功并可重试收敛。

### 读取与保存的具体约定

1. 读取成功的状态继续保留在各自 Store 中；不新增长期明文凭据缓存。重新读取失败时保留当前值和原始引用，界面区分“未能读取”和“未填写”。
2. 普通设置按本次实际修改字段提交；providers 按连接和字段分解，工具栏按节点类型处理，数组作为对应字段的完整值。保存携带读取基线，事务内比较当前值；不冲突的字段合并，同字段冲突拒绝并提示重新加载，不以最后写入者无条件获胜。
3. 只有明确的凭据修改意图才调用原生写入。主题、尺寸、语言等无关修改不重新写旧 Key；仅因其他渠道凭据不可读，不阻断这类普通设置保存。配置初次数据库读取失败仍不开放默认值保存。
4. 保存状态至少包含 idle/saving/saved/error/conflict；保存错误不得通过成功 Promise 被调用方当作成功处理。失败保留待保存修改并提供用户触发的重试。保存期间新修改必须有独立序号，旧完成回调不清掉新修改的未保存状态。
5. 初始读取、重新连接只对明确可恢复错误最多尝试 3 次；权限拒绝、数据损坏、版本不兼容和字段冲突不自动重试。诊断仅含操作类别、错误代码和次数，不含 Key、令牌、路径或配置正文。
6. 退出先结束或收集尺寸等防抖修改，停止产生新的设置写入，等待配置和布局队列到达终态；存在失败时由用户决定重试、取消退出或明确放弃未保存修改。
7. 凭据临时文件、主文件和锁文件只位于现有原生私有目录；跨进程锁覆盖读取、比较、写入和提交的完整过程。锁获取等待有上限，不在 UI 线程无限等待。变更现有命令时保持旧参数兼容，不新增宽泛原生能力。
8. 持久性增强限定配置与布局等低频关键写入，不能顺手改变画布历史、媒体或全部数据库事务的性能策略。

### 存储方式比较

| 方案 | 优点 | 本次判断 |
|---|---|---|
| 现有 IndexedDB + Rust 私有凭据文件 | 已有数据兼容、已有权限边界、不新增依赖；可使用局部事务和可靠落盘 | 推荐；本次主要问题是保存/恢复协议，而非缺少另一种数据库 |
| Tauri Store | 原生文件形式的键值存储，提供异步保存和加载 | 仍要处理保存时机、错误与并发；单纯替换没有消除已复现问题，暂不迁移 |
| Rust 管理的 SQLite | 可用于后续统一原生配置与桌面数据管理 | 需要新依赖、旧数据迁移、权限与 Web 兼容设计；作为单独项目，当前不扩大范围 |
| Stronghold 等加密凭据库 | 可加强凭据加密保护 | 需要主密钥/密码与迁移恢复方案；加密与可靠性是不同目标，本次不混入 |

官方参考资料与本次判断的边界见 findings.md。没有一种选项能保证文件、数据库或 IPC 永不失败。

## 阶段

### 阶段 0：方案核验与确认

- 核对现有实现和官方存储能力，形成完整文件清单。
- 比较保留现有介质、Tauri Store、SQLite、加密凭据库的收益与迁移风险。
- 状态：complete；用户已确认第一阶段实施。

### 阶段 1：凭据和工具栏失败保护

- MCP 只在确认不存在时创建令牌；读取失败不覆盖旧令牌。确实不可用时可使用明确标记的稳定会话令牌，同一会话内不可反复变动。
- 工具栏加载、保存失败均保留旧记录；独立节点类型修改不覆盖其他类型。
- 覆盖错误分类、瞬时读取恢复、并发令牌创建和布局覆盖故障模拟。
- 状态：complete；14 个定向测试文件共 184 项通过，定向 ESLint 通过。应用/测试类型及编码结果见 progress.md；真实桌面重启、主题截图和原生多实例故障仍待实测。按项目规则确认再进入第二阶段。

### 阶段 2：普通设置保存状态、局部提交与退出等待

- 普通设置与凭据读写分离；更新采用字段级变更，同字段冲突明确报告，不静默覆盖。
- 可见地显示保存中/未保存/失败与重试入口；调用方不得在保存失败后继续显示成功。
- 退出等待当前设置及工具栏保存完成，未保存成功时保留取消退出的选择。
- 覆盖并发修改、重新加载、修改后立即关闭与失败后恢复。
- 状态：complete；20 个定向测试文件共 244 项通过，应用/测试类型、定向 ESLint、差异与编码检查通过。真实桌面退出重开、明暗主题截图和原生多实例验收未进行。

### 阶段 3：原生落盘与持久性加固

- 凭据文件读改写增加跨进程锁；写入完成需同步落盘，再提交替换。
- 对低频设置事务评估 strict durability 并对不支持的运行时保持明确兼容处理。
- 凭据创建/更新按预期旧值或版本进行原生冲突检查；持久化失败保留可用旧文件。
- 收敛连接删除与配置提交的顺序，避免配置提交失败后已删除其 Key；跨介质部分成功不假定可以整体回滚。
- 工具栏同节点类型增加基线冲突保护，冲突重试保留原基线；用户确认后可丢弃草稿并重新加载。
- 状态：complete；最终前端回归 21 文件共 307 项通过，应用/测试类型和定向 ESLint 通过。原生凭据 10 项及路径边界 7 项定向测试通过，其中包含隔离凭据目录的真实子进程竞争与退出释放锁；使用 --no-default-features 排除无关 ONNX 链接。默认特性 cargo check --lib 通过。默认特性测试受现有 ONNX/MSVC 链接错误阻断，未更换工具链或依赖。差异、编码和实测边界见 progress.md。

## 验收

- 无关设置保存不发起凭据 IPC，API Key 不进入 IndexedDB、日志、普通备份或配置状态元数据。
- 读取失败、权限拒绝、损坏、高版本数据库均不清空已保存数据。
- 短暂读取失败恢复成功；永久失败有可理解的分类，不无限重试。
- 多实例修改不同字段可保留双方变更；修改同一字段有冲突保护。旧版或不同存储源客户端不参与新协议时不声称拥有同等保证。
- 工具栏失败加载后不能覆盖其他布局；新旧 MCP 令牌不会因探测失败悄然轮换。
- 正常退出等待保存；保存失败时用户可保留修改并取消退出。
- 定向回归、应用/测试类型、ESLint、UTF-8、diff 检查；Rust 改动执行定向 cargo test 和 cargo check --lib。真实重启、多实例和文件故障另行实测，不以单元测试代替。

## 范围与回滚

- 不新增 npm/cargo 依赖，不切换存储后端，不放松权限，不修改 README，不删除用户文件，不打包或发布。
- 每阶段按明确文件清单收敛；保留旧配置读取兼容，暂不提高数据库 schema 版本。若实现必须新增 object store、依赖或安全配置变更，先重新确认。
- 回滚代码时保留用户数据，停止新写入后使用兼容读取；不自动删除凭据或恢复已撤销令牌。原生文件格式默认保持现状；需要格式迁移时另行确认。
- 本任务不触碰已有 .gitignore 改动及根目录其他任务的计划文件。

## 文件清单

以下为三个已确认阶段的实施范围；新增文件在创建前已核验不存在。各阶段共享文件逐步修改，不重复新建另一套保存服务。

### 阶段 1

| 文件 | 改动 |
|---|---|
| `src/services/providerSecretService.ts` | 通用凭据读写结果明确区分缺失和失败，统一脱敏分类 |
| `src/services/mcp/mcpSessionConfig.ts` | 稳定的会话令牌、并发初始化、失败不覆盖固定令牌 |
| `src/components/settings/McpControlSettings.tsx` | 表达读取/持久化失败与会话令牌状态 |
| `src/store/store.toolbar.ts` | 加载保护、局部保存与失败状态 |
| `src/hooks/useToolbarEdit.ts` | 保存失败保留编辑草稿，不提前关闭编辑 |
| `src/services/storageService.ts` | 工具栏读取抛错、局部提交，复用配置保存边界 |
| `src/services/indexedDbService.ts` | 布局按类型的事务更新，完整等待事务终态 |
| `src/services/storageDiagnostics.ts`（新增） | 安全错误分类、瞬时读取重试辅助 |
| `tests/services/providerSecretService.test.ts` | 凭据错误分类回归 |
| `tests/components/mcpControlSettings.test.ts` | MCP 界面与失败状态回归 |
| `tests/services/storageDiagnostics.test.ts`（新增） | 重试上限、错误脱敏与不可重试分类 |
| `tests/services/mcpSessionConfig.test.ts`（新增） | 读取失败、初始化竞争、降级令牌稳定性 |
| `tests/store/toolbarPersistence.test.ts`（新增） | 失败加载、局部保存、并发与旧布局保留 |
| `tests/hooks/useToolbarEdit.test.ts`（新增） | 失败时编辑草稿保留和重试 |

### 阶段 2

| 文件 | 改动 |
|---|---|
| `src/services/configPatch.ts`（新增） | 字段变更与三方比较，冲突不覆盖 |
| `src/services/configPersistenceQueue.ts` | 任务结果、排空和退出等待；不吞掉最后失败 |
| `src/services/storageService.ts` | 普通设置和凭据提交意图分离、局部保存、兼容读取 |
| `src/services/storageDiagnostics.ts`（复用第一阶段） | 配置读取使用同一套脱敏分类和有界重试 |
| `src/services/indexedDb/catalogRepository.ts` | 同一配置事务内基线比较与更新 |
| `src/store/store.config.ts` | 基线、修改序号、保存状态、失败重试和加载隔离 |
| `src/store/store.toolbar.ts` | 加入退出等待与全局保存状态协调 |
| `src/components/SettingsPanel.tsx` | 使用现有 UI 类展示保存状态与重试；成功提示依赖保存结果 |
| `src/components/settings/ApiKeySettings.tsx` | 保存失败不关闭渠道编辑器；凭据未读到与未填写区分 |
| `src/components/settings/FileAppSettings.tsx` | 文件/目录设置只在确认保存后显示完成 |
| `src/components/settings/ComfyUISettings.tsx` | 服务端设置失败状态与重试收敛 |
| `src/components/AssetsPanel.tsx` | 素材目录/列数保存不误报成功，不改当前资产库功能 |
| `src/components/AssetSearchWindow.tsx`（追加已确认） | 独立窗口仅保存目录字段；失败保留目录选择并以最新基线重试 |
| `src/components/canvas/CanvasRadialMenu.tsx`（追加已确认） | 保存失败保留圆环编辑界面，不提示成功或关闭 |
| `src/hooks/useMainWindowSize.ts` | 收集或结束待处理尺寸保存，退出不留下防抖写入 |
| `src/hooks/useToolbarEdit.ts`、`tests/hooks/useToolbarEdit.test.ts`（复用第一阶段） | 关闭时收集打开的编辑草稿并等待已发起的保存 |
| `src/App.tsx` | 接入设置/工具栏保存等待，保留项目关闭检查与用户退出选择 |
| `tests/store/config.test.ts` | 新修改与旧保存完成隔离、失败与重试、读取保护 |
| `tests/services/configSecretStorage.test.ts` | 普通设置零凭据 IPC、冲突处理、局部成功与引用保护 |
| `tests/hooks/useMainWindowSize.test.ts` | 尺寸防抖和关闭顺序 |
| `tests/services/configPatch.test.ts`（新增） | 嵌套字段/数组/删除/冲突与无关变更 |
| `tests/components/settingsPersistence.test.tsx`（新增） | 保存提示、失败不关闭与重试 |
| `tests/services/settingsClose.test.ts`（新增） | 配置及布局排空、失败退出选择、关闭竞态 |

### 阶段 3

| 文件 | 改动 |
|---|---|
| `src-tauri/src/secret_store.rs` | 跨进程锁、同步落盘、错误分类、预期旧值校验；内置 Rust 回归 |
| `src/services/providerSecretService.ts` | 匹配原生错误分类与条件更新，保持 Key 保密边界 |
| `src/services/storageDiagnostics.ts`（复用第一阶段） | 识别原生可信错误码，包含容量不足分类 |
| `src/services/mcp/mcpSessionConfig.ts` | 使用原生创建/更新冲突保护 |
| `src/services/indexedDb/catalogRepository.ts` | 仅关键配置提交采用明确持久性策略 |
| `src/services/indexedDbService.ts` | 工具栏关键写入的持久性与事务中止处理 |
| `tests/services/providerSecretService.test.ts`、`tests/services/mcpSessionConfig.test.ts` | 条件更新、原生错误和失败恢复 |
| `tests/services/indexedDbService.test.ts`、`tests/services/configSecretStorage.test.ts` | 兼容读取、strict 选项与失败保留 |
| `src/store/store.config.ts`、`src/services/storageService.ts`、`tests/store/config.test.ts` | 凭据删除与配置提交的顺序及部分成功状态；失败清理仅保留指纹，已提交部分推进基线 |
| `src/store/store.toolbar.ts`、`src/hooks/useToolbarEdit.ts`、`tests/store/toolbarPersistence.test.ts`、`tests/hooks/useToolbarEdit.test.ts` | 同类型布局冲突、保留草稿与确认重新加载 |

### 主文档与模块链接

- 主计划为本文件；本目录 `findings.md` 和 `progress.md` 只保留必要依据与实际验证结论。
- 实施时更新 `doc/文件与存储模块.md` 的行为边界和验收；`doc/桌面运行时与安全模块.md`、`doc/MCP控制模块.md` 仅补必要边界与主计划链接。
- 不更新内部 Agent 实施方案，不重复追加历史流水。

# ADR 0010：3D 镜头台双运行时与 Blender 场景权威边界

## 状态

已接受，2026-08-28。

“已接受”表示本 ADR 的决策获得确认，不等同于 Phase 0-D 文档检查或 Blender 原生运行时验收已经完成。

Phase 0-D 只冻结产品、场景和执行边界，不启动 Blender，不执行 Python，不开放新的原生命令、进程能力或 Agent/MCP 工具。

## 背景

现有 `ai-director` 节点已经通过 `lightweight-web` 运行时提供独立导演台、当前帧截图和参考视频，并保持稳定的画布复制、历史、持久化和下游连线语义。后续需要把 Blender 接入为高质量渲染与高级编辑后端，但不能因此：

- 新增一个与 `ai-director` 平行的 Blender 节点；
- 把完整 Blender 界面作为普通用户的默认导演入口；
- 让 Blender、网页、插件、模型、Agent 或 MCP 传入任意 Python、命令行参数或绝对路径；
- 让 `.blend`、场景 JSON、截图、视频和节点字段成为互相覆盖的多个隐式权威来源；
- 破坏旧项目、`lightweight-web` 或现有下游媒体连线。

因此必须先确定同一节点的双运行时状态、可移植场景 JSON、Blender 文件和结果清单之间的权威关系，再实现任何 Blender 进程能力。

## 决策

### 1. 保留唯一的 `ai-director` 节点

1. 画布继续只使用现有 `ai-director` NodeType。
2. 产品目标名称锁定为“3D 镜头台”，不改变内部 NodeType；当前“3D 导演台”展示文案的代码改名属于后续实施项。
3. `lightweight-web` 与 `blender` 是同一节点内的运行时状态，不是两种节点。
4. 不新增 Blender 专用 NodeType、Sidebar/NodeMenu 菜单项、平行 Store 或第二套下游连线协议。
5. 节点创建、复制、历史、项目持久化、截图和参考视频输出继续复用现有语义。

### 2. 运行时状态只有 `lightweight-web` 与 `blender`

节点持久化判别为：

```ts
type DirectorRuntimeKind = 'lightweight-web' | 'blender';
```

规则如下：

- 旧节点缺少该字段时解释为 `lightweight-web`；
- `lightweight-web` 是长期正式运行时，不称为 legacy 或待淘汰 fallback；
- `blender` 在原生适配器接通前保持可识别但不可用；
- 未知非空值必须失败关闭，禁止静默回退到 `lightweight-web`；
- 运行时切换必须由用户显式触发，不能在恢复、复制、导入或错误恢复时自动发生；
- 切换运行时只重置瞬时会话状态，不删除既有场景、截图、视频或结果引用；
- 运行时状态不决定或替代场景数据的权威关系。

### 3. Director Scene JSON 是可移植场景权威

当节点存在 `directorScene` 引用时，Director Scene JSON 是 AI Canvas 可理解字段的唯一可移植权威，负责表达场景、人物、道具、镜头、时间轴和关键帧。

场景文件必须：

- 使用独立 `schemaVersion`；
- 使用稳定 `sceneId`；
- 使用单调 revision，并记录父 revision 与父文件哈希；
- 保存为项目数据目录内的规范相对路径；
- 使用 UTF-8 JSON 和严格字段白名单；
- 由精确文件字节 SHA-256、文件大小和 revision 共同绑定节点引用；
- 使用不可变 revision 文件，文件写入并复核成功后才更新节点引用。

完整场景 JSON 不写入 IndexedDB；节点只持久化 schema、scene ID、revision、项目相对路径、大小和哈希引用。

没有 `directorScene` 的旧 `lightweight-web` 节点继续使用现有运行时状态和媒体输出，不强制生成、迁移或猜测场景 JSON。

### 4. `.blend` 是受 Scene revision 约束的 Blender 工作产物

`.blend` 不是 Director Scene JSON 的替代品，也不能自动覆盖 JSON。

- `.blend` 作为结果清单中的 `blend-project` artifact 保存；
- 它必须绑定生成或同步时的 `sceneRevision` 与 `sceneSha256`；
- AI Canvas 将其视为不透明文件，不解析其中的节点、脚本、依赖或专有数据；
- Phase 0-D 不打开、执行或生成 `.blend`；
- 高级编辑可以保留 JSON 暂时无法表达的 Blender 专有数据，但这些数据不得伪装为已同步的 JSON 字段；
- `.blend` 与其他结果 artifact 一样是不可变快照；编辑返回必须写入新的内容寻址 artifact 和新的 Manifest revision，不得原地覆盖旧文件；
- JSON revision 改变后，旧 `.blend` 必须标记为基于旧场景，禁止静默覆盖、自动合并或宣称无损双向转换；
- 从 Blender 回写 AI Canvas 时，固定脚本只能提交受限结果清单和可选的 portable Scene proposal。Result Manifest 本身永远不能创建或覆盖 Scene；只有 proposal 另行通过 Scene schema 白名单、父 revision/hash 和宿主写入流程校验后，才能形成新的 Scene revision。纯 Blender 专有编辑只生成新的 `.blend` artifact 与 Manifest，仍绑定原 Scene revision。

### 5. Result Manifest 是已验证结果文件的清单权威

Result Manifest 负责列出当前帧截图、参考视频和 `.blend` 等产物，但不负责场景编辑状态。

它至少记录：

- `schemaVersion`；
- `sceneId`、`sceneRevision` 与 `sceneSha256`；
- 独立的 `manifestRevision`；
- producer 的运行时、适配器版本和可选 Blender 版本；
- artifact 的固定 kind、MIME、项目相对路径、大小和 SHA-256。

所有 artifact 都是不可变、内容完整性绑定的结果快照。`artifactId` 在同一 Scene bundle 内唯一，路径同时绑定 ID 与内容哈希；截图、视频和 `.blend` 均不得原地覆盖。任何新渲染或高级编辑返回都必须创建新 artifact，并在所有文件验证完成后创建新的 `manifestRevision`。

权威关系如下：

| 对象 | 权威范围 | 不负责 |
|---|---|---|
| Director Scene JSON | AI Canvas 可移植场景语义 | Blender 专有细节、渲染文件 |
| `.blend` | Blender 高级工作副本 | 自动覆盖 JSON、跨运行时语义 |
| Result Manifest | 已验证结果文件清单与完整性 | 场景编辑状态 |
| 节点截图、`imageUrl`、`videoUrl` 等现有字段 | UI 与下游兼容投影 | 文件清单和场景权威 |

现有节点媒体字段继续保留，以兼容预览和下游节点；未来可以从已验证 Result Manifest 投影回这些字段。旧 `lightweight-web` 截图和视频在没有 Result Manifest 时继续按现有规则工作。

### 6. 项目内文件规则

导演场景文件使用项目数据目录内的不可变结构，例如：

```text
director/scenes/<sceneId>/scene-r<revision>-<sha256>.json
director/scenes/<sceneId>/results/manifest-r<manifestRevision>-<sha256>.json
director/scenes/<sceneId>/results/<artifactId>-<sha256>.<ext>
```

所有持久化引用必须：

- 使用 `/` 分隔的项目相对路径；
- 拒绝绝对路径、盘符、URI、反斜杠、空段、`.`、`..`、控制字符和 `.trash`；
- 不保存 API Key、环境变量、命令、Python、Shell 参数或运行时句柄；
- 不把绝对路径或路径授权暴露给网页运行时、模型、Agent、MCP 或插件。

Scene 内部引用项目文件时必须至少携带 `{relativePath, sha256, bytes}`；目录资产引用必须使用稳定 asset ID，并在可用时绑定明确版本或内容哈希。仅有 `relativePath` 的引用无效，防止同名文件替换后让既有 Scene revision 静默变义。跨项目节点复制在 Phase 1-D 完成 bundle 复制、哈希复核和引用重写前必须保持 unresolved 或失败关闭，不能自动绑定目标项目的同名文件。

项目整体导出、导入和复制继续复用现有项目目录归档。新增可选场景文件不要求提升 IndexedDB schema，也不提升项目归档格式版本。

### 7. 保存与失败顺序

场景更新必须按以下顺序执行：

1. 读取并验证当前引用的相对路径、schema、scene ID、revision 和 SHA-256；
2. 生成下一 revision，并绑定父 revision 与父哈希；
3. 写入新的不可变文件；
4. 重新验证写入结果；
5. 经过项目、节点和 canvas revision 防护后更新节点引用。

禁止先更新节点再写文件。崩溃最多产生未引用文件，不能让节点指向半写内容。

Result Manifest 必须在所有不可变 artifact 写入并验证后最后生成。清单无效、哈希不符或文件缺失时，不回写新结果，并保留此前已验证的节点输出。Manifest 不得直接写 Scene；可选 Scene proposal 必须独立走上一节的 Scene revision 保存顺序。

## Blender 执行安全边界

1. Blender 内部允许使用由 Rust 第一方信任根解析、版本固定且通过哈希或签名校验的 AI Canvas 脚本，但这不构成通用 Python 能力；编译内嵌、bundle resource 或独立签名资源包的具体交付方式由后续阶段确认。
2. Renderer、网页、用户场景、模型、Agent、MCP 和插件均不得提供 Python 源码、脚本路径、`--python-expr`、自由 argv、工作目录、环境变量或绝对输出路径。
3. Blender 集成不得复用 [ADR 0009](./0009-trusted-python-plugin-runtime.md) 的可信 Python 插件运行时；两份 ADR 互不取代。
4. 后续原生适配器只能注册用途单一的 Tauri commands，输入为固定操作枚举与不透明 installation/job/project/scene ID。
5. 项目根必须先由 `main` 窗口通过用途单一的授权流程建立 Rust 进程内 grant：canonicalize 并复用路径策略校验后绑定 `projectId`，只向前端返回不透明 `projectGrantId`。Blender Job 只查询该 grant，不接收项目路径；任何 Renderer 提供的 ID 都不得直接拼接为文件路径。
6. `installationId` 只是 Rust 安装记录的查找键，不是信任或授权。每次启动前都必须重新解析和 canonicalize 候选，确认仍为允许安装根内的普通文件，并在启用前完成固定版本/架构兼容握手。
7. `start_blender_job` 不能接收 `jobId`；Job ID 和实际 Job 目录均由 Rust 独立生成并保存在受限状态表中。status/cancel/collect 只用不透明 Job ID 查表，不能用它直接构造目录。
8. 可执行文件、Application Template、`.blend` 模板、第一方脚本、参数序列、工作目录和输出目录必须由 Rust 从受信资源、installation 复核和 project grant 派生。
9. 启动必须直接使用 `Command::new(...).arg(...)`，禁止 Shell、`cmd /c`、raw argument 拼接或前端 Shell capability。
10. 打开 `.blend` 时必须禁用自动执行内嵌脚本；后台与前台编辑使用不同的固定操作序列。
11. Result Manifest 和 artifact 的路径、目录包含关系、类型、数量、大小与哈希必须由宿主独立验证，不能只信任 Blender 或脚本自报。
12. Scene JSON 和 Result Manifest 始终是不可信输入，不能修改 Policy、权限、脚本、运行参数或输出范围。
13. 自动测试、fake runner 或临时目录验证完成后，Blender adapter 仍必须保持 unavailable。只有用户明确授权真机验收，并通过候选重验证、版本握手、帧/视频渲染、高级编辑保存返回、取消/超时/崩溃/退出回收及结果独立校验后，才能标记 available；未授权或任一步失败都保持 unavailable。

## 兼容性

- 旧项目缺少 `directorRuntimeKind` 时继续打开 `lightweight-web`。
- 旧节点缺少 Scene 或 Result Manifest 引用时不迁移、不报错。
- 现有 `director-desk://`、安装管理和 Tauri Event 协议继续作为 `lightweight-web` 内部实现，由统一 facade 调用。
- `ai-director` 的图片和视频下游语义保持不变。
- 较新 Scene 或 Result Manifest schema 必须保留节点但禁用读取，禁止按旧字段猜测。
- 同项目复制节点可以共享不可变场景快照；任一副本保存时只移动自己的引用。
- 项目归档继续递归携带导演目录；导入后只按项目相对路径解析。
- 跨项目复制 Scene bundle 和旧 Director 多媒体迁移属于后续独立阶段，不在本阶段猜测 URL 与路径配对。

## 影响

### 正向

- Blender 与 `lightweight-web` 共用一个稳定节点和下游接口。
- 场景语义、Blender 工作文件和渲染结果的职责明确。
- 场景可以随项目整体导出、导入和复制，不依赖本机绝对路径。
- 不启用 Blender 也能独立验证 schema、哈希、revision 和持久化。

### 负向

- 项目目录会增加不可变 revision 文件，后续需要安全的孤儿识别与清理策略。
- JSON 与 `.blend` 不承诺无损双向转换，高级编辑存在显式的 Blender 专有边界。
- 跨项目旧 Director 媒体仍需单独迁移，不能由单一 `filePath` 完整恢复。

### 中性

- `lightweight-web` 当前能力和下载方式不变。
- Blender 仍不可用，Phase 0-D 不新增用户可执行能力。
- 不新增依赖、IndexedDB object store、Tauri capability 或 Agent/MCP 工具。

## 未采用方案

### 新增独立 Blender 节点

会分裂节点入口、连线、复制、历史和下游语义，因此拒绝。

### 让 `.blend` 成为唯一项目权威

AI Canvas 无法安全解析、迁移或跨运行时编辑 `.blend`，也无法保证版本和插件兼容，因此拒绝。

### 把完整场景 JSON 存入节点或 IndexedDB

会扩大自动保存体积、历史快照和项目数据库压力，也不利于哈希、归档和外部运行时交接，因此拒绝。

### 运行时切换时自动互转 JSON 与 `.blend`

无法保证高级 Blender 数据无损，容易静默丢失用户编辑，因此拒绝。

### 使用任意 Python 或 Shell 生成、修改场景

会把导演台变成任意代码执行入口，并绕过路径和工具权限边界，因此拒绝。

### 保存 Blender 可执行文件或项目文件的绝对路径

项目移动、导入和跨机器使用后会失效，也会扩大未授权文件访问面，因此拒绝。

## 故障策略

- Blender 不可用：节点保留并显示不可用原因，不启动 `lightweight-web` 代替。
- Scene 文件缺失、损坏或哈希不符：禁止打开该场景，保留节点和此前输出。
- Scene schema 较新：显示需要升级，不自动降级或重写。
- Result Manifest 无效：忽略本次清单，不覆盖此前已验证结果。
- `.blend` 缺失或基于旧 Scene：保留 JSON 权威，要求重新生成或由用户明确处理。
- 写文件成功但节点回写失败：文件作为未引用文件保留，后续由存储健康能力识别；禁止反向猜测并自动绑定。

## 回滚

回滚到 Phase 0-C 时：

1. 保留唯一的 `ai-director`、`lightweight-web` adapter 和现有媒体输出；
2. Blender 恢复或继续显示 unavailable；
3. 停止创建和读取 Scene、Result Manifest 引用；
4. 旧版本自然忽略节点中的可选引用，不需要数据库降级；
5. 项目目录中的 JSON、Result Manifest 和 `.blend` 不自动删除，避免破坏用户数据；
6. 项目归档仍可把这些文件作为不透明项目素材携带；
7. 禁止把 `blender` 或未知运行时静默改写为 `lightweight-web`。

## 参考

- [ADR 0003：3D 导演台使用按需下载运行时](./0003-director-desk-prebuilt-runtime.md)
- [ADR 0009：可信 Python 插件运行时](./0009-trusted-python-plugin-runtime.md)
- [Blender Application Templates](https://docs.blender.org/manual/en/latest/advanced/blender_directory_layout.html)
- [Blender 命令行参数](https://docs.blender.org/manual/en/5.1/advanced/command_line/arguments.html)
- `src/services/directorRuntimeRegistry.ts`
- `src/services/projectTransferService.ts`

# Skill 全软件统一调用

## 目标与状态

Skill 从任一现有入口导入后，节点、主窗口与独立窗口的对话助手、提示词润色、子智能体都使用同一目录和相同的显式调用规则。任务类型为产品能力完善，复用既有目录与执行服务。

- 已实现、待用户验收：文件夹导入补充用户所选目录的递归授权；原生字符串异常转为可读错误提示，日志不记录原始路径。
- 已实现、待用户验收：节点菜单和提交展开、助手文件夹上传、子智能体绑定和执行、Skill 管理列表已补齐共享目录；独立窗口与润色沿用已有共享链路。
- 2026-10-19 已实现、待用户验收：桌面端“上传 Skill 文件”兼容 `.zip`、`.tar.gz` 和 `.tgz`，共用节点和助手上传入口；优先读取 `SKILL.md`，去掉外层包装目录，保存入口所在子树的 UTF-8 文本资料。无 `SKILL.md` 时沿用文件夹导入的文本入口回退；并列的多个独立 Skill 提示分别打包上传。
- 本次未运行测试，待用户验收。

## 安装目录存储与原文件夹引用（2026-11-13）

目标：单文件及压缩包导入保存到可执行文件所在目录的 `skills`；文件夹导入只引用用户选中的原目录。安装根由原生确定，不接受前端指定目标目录，也不静默回退到应用数据目录。

实施顺序与验收边界：

1. 原生增加专用文本保存与只读来源登记，复用归档路径、体积和 UTF-8 限制；登记表位于原生私有区，按不透明来源 ID 读资料，重启后复核真实目录、链接及私有路径边界，不扩大公共 fs／asset 权限。
2. `skillFiles.ts` 的单文件和压缩包走原生唯一目标保存，文件夹选择后登记并读取原目录入口；UserSkill／SkillRecord 与 Store 透传可选原生来源 ID，资料工具按该 ID 读取。旧无来源 ID 的应用数据目录记录沿用已有读取路径，不迁移或猜测丢失的原目录。
3. 补充导入、来源读取与 Store 持久化回归源码，更新模块说明。前端完整 CI 按提交推送门禁核验；Rust 检查、原生测试和真实桌面验收仍需对应授权。

当前状态：已实现并补充回归源码，完成差异、UTF-8 与独立静态审查；前端检查以本次推送门禁和同 SHA CI 为准，Rust 检查及三端实机仍待验证。包含原生修改，需重新编译启动 Tauri 桌面端。删除 Skill 继续只移除目录记录，不删除原文件夹或安装目录文件；入口正文沿用现有数据库缓存，不新增监视或自动覆盖原文件。目录记录持久化失败时明确报错，不追加内存或显示上传成功，已保存文件保留。

跨平台权限边界：宿主提供的系统应用数据根先规范为真实路径，再严格建立私有登记子树，避免 Linux 链接型用户目录等宿主别名使授权存储不可用。Windows 盘符／UNC 沿用统一真实路径格式，junction 和其他重解析点保持拒绝；macOS 仅兼容已核对固定目标的 `/var`、`/tmp`、`/etc` 系统别名，Skill 子树中的普通链接仍拒绝。原 Skill 目录仅需列举／读取权限，不要求写入；持久登记仍要求应用自己的私有数据目录可写。Windows 安装 ACL、macOS 系统隐私限制、Linux AppImage 只读挂载或其他权限拒绝均明确失败，不自动提权或改存别处。这些是静态确认的实现边界，不代表三平台实机验收通过。

## 改动前已确认的调用链

- `skillCatalog.ts` 已合并 `userSkills` 与 `agentPackageSkills`；`projectSkillPickerOptions` 为显式调用提供共享元数据。
- 对话助手和独立窗口已经使用共享选择目录；主窗口上传仅支持单文件。
- 节点 `/` 菜单与提交展开仅读取 `userSkills`，智能体包 Skill 无法在节点调用。
- 子智能体的选择框与角色正文读取也只读取 `userSkills`。
- 提示词润色已合并两种来源；Skill 管理列表仅展示手动上传的记录。

## 实施文件

| 文件 | 改动 |
|---|---|
| `src/components/nodes/shared/PromptPanel.tsx` | 菜单使用共享选择目录，提交时从完整运行时目录展开同一个 Skill ID |
| `src/components/nodes/shared/SlashCommandMenu.tsx` | 接收共享 Skill 元数据，选择回调不再要求手动上传记录类型 |
| `src/components/chat/ChatInput.tsx` | 增加文件夹上传入口，与单文件上传共用 Store Action |
| `src/components/settings/SubAgentSettings.tsx` | 绑定选择框使用共享 Skill 目录 |
| `src/services/chat/subAgentService.ts` | 根据 Skill ID 从共享目录读取角色正文，并复用显式调用可用性规则 |
| `src/components/nodes/shared/SkillManager.tsx` | 展示共享目录；智能体包 Skill 保持只读，删除只作用于手动上传记录 |
| `tests/services/chat/subAgentService.test.ts` | 补充智能体包 Skill 绑定、不可用 Skill 与角色提示词回退的回归用例 |
| `doc/对话助手-Agent能力实施方案.md` | 记录共享调用入口、待验收状态和本计划链接 |
| 本文件 | 维护实施范围与验收状态 |

文件与压缩包导入位于 `src/services/fs/skillFiles.ts`；压缩包读取由 `src-tauri/src/files/skill_archive.rs` 完成，注册与权限声明同步更新。ZIP 直接引用锁文件已有的 `zip 2.4.2`，tar.gz 复用 `tar` / `flate2`。前端回归位于 `tests/services/fileServiceSkillUpload.test.ts`，归档读取和安全回归位于原生模块内。

安装目录保存、外部来源登记和资料读取由 `src-tauri/src/files/skill_storage.rs` 承担，固定目标根及目录链校验复用 `path_policy.rs`。四个命令为 `save_skill_files`、`register_skill_folder`、`list_skill_source_files`、`read_skill_source_file`，注册与精确应用权限同步声明。来源 ID 为本机只读能力，不进入模型结果；数据库新增可选字段 `nativeSourceId`，不提升版本、不改写旧记录。

## 行为边界

- 一次导入、跨入口使用同一 Skill ID，不复制智能体包正文到手动上传的 Skill 数据库。
- 共享显式调用目录继续遵守 `user-invocable`、包启停和当前健康状态；自动发现和显式调用保留各自已有的声明语义。
- 主窗口仍为独立助手窗口的状态写入源，独立窗口继续使用脱敏元数据快照。
- 包内资料仍通过原生来源注册表读取；手动上传资料继续使用现有文件服务。MCP 的已有授权和只读边界继续生效。
- 压缩包原生命令只接受可信窗口和已获用户授权的普通文件，不接收解包目标路径，只返回 `.md` / `.txt` / `.json` 文本；不执行脚本。路径穿越、链接、设备文件、加密 ZIP、重复路径、非 UTF-8 文本、损坏及超限包失败关闭，原始绝对路径不进入导入错误提示。
- 上限为压缩包 32 MiB、解压流/ZIP 展开总量 64 MiB、单文件 8 MiB、4096 个条目；PAX/GNU 元数据由归档库解析，实际路径仍须校验。落盘前复核文本路径，保存失败清理本次新建目录，不新增 Skill 记录。
- 压缩包沿用文件夹型 Skill 的持久化格式，不迁移数据库；Web 演示端选择压缩包时提示使用桌面端。

## Tauri 桌面端验收

前置条件：使用更新后的桌面端，配置可用的文本助手模型；准备一个 UTF-8 的 Skill 文件夹，根目录含 `SKILL.md`、多级 `references` 文本资料；准备一个含 Skill 的可安装智能体包。

1. 在节点 `/ → Skill → 上传 Skill 文件夹` 导入，确认成功提示、入口正文和多级资料从原目录读取，安装目录和旧应用数据目录均未生成该文件夹副本；助手和润色选择框应出现同一个 Skill。
2. 从助手导入单文件或文件夹，节点菜单应立即出现对应 Skill；切换项目后仍可选择，重启后仍保留。
3. 在智能体中心安装并启用包，包内可显式调用的 Skill 应出现在助手、节点、润色及子智能体绑定选择框中；节点提交应展开正文，而非仅移除引用标记。
4. 给子智能体绑定该 Skill，执行只读任务，确认角色正文来自该 Skill；停用或移除来源后不得继续使用旧正文。有内联角色提示词时按既有规则回退，否则提示不可用。
5. 打开独立助手窗口，核对共享 Skill 选择项；主窗口导入、停用或删除后，独立窗口列表应同步。
6. 管理列表可查看两种来源；包内 Skill 只读，手动上传记录仍可删除；删除后各调用入口同步更新。
7. 取消导入不得新增记录；空文件夹、非 UTF-8 文本和读取权限错误应给出明确提示；单文件上传与减少动态效果、深浅主题展示应回归。
8. 将同一 Skill 分别打包为 ZIP、tar.gz、tgz（覆盖根目录直接放入口、外层目录包装、中文多级资料、UTF-8 BOM）；通过节点和助手的“上传 Skill 文件”导入，应显示入口正文，附属资料相对路径可读取，重启后仍保留。重复上传应创建独立目录，原有记录内容不被覆盖。
9. 损坏、加密、无文本、路径穿越、链接、大小写重名、多个并列 Skill 及超限包应提示错误，不新增记录；模拟写入权限或存储空间不足应提示保存失败。回归原单文件和文件夹导入，Web 演示端压缩包应显示桌面端提示。
10. 使用重新编译并启动的桌面端，在可写安装目录导入单文件，确认落在可执行文件旁 `skills`，保留 UTF-8 BOM；压缩包落在 `skills/<独立目录>`。导入同名文件／压缩包两次，原文件不得被覆盖。将安装目录设为不可写后导入，预期明确失败且不回退到 AppData，也不新增 Skill 记录。
11. 完全退出并重开应用，分别读取新压缩包和原目录 Skill 的多级资料；原目录不应需要再次选择。删除 Skill 后原目录和文件仍在；重命名／移走原目录或在子树内放置链接时，资料读取应失败，不能读取目录外文件。失效或篡改的来源 ID 不得改走前端路径读取。旧 `appData/skill` 记录应仍可使用；以前复制的文件夹没有原始路径记录，需要重新导入才能切换为原目录引用。

若用户授权命令检查，在仓库根目录执行 `npx vitest run tests/services/fileServiceSkillUpload.test.ts tests/services/fileServiceSkillResource.test.ts tests/services/chat/skillCatalog.test.ts tests/services/skillPromptService.test.ts tests/services/chat/subAgentService.test.ts tests/components/subAgentSettings.test.tsx tests/services/chat/detachedChatSyncController.test.ts` 和 `npm run typecheck`。

存储与压缩包定向检查命令（仅供用户执行，本次未运行）：仓库根目录执行 `npx vitest run tests/services/fileServiceSkillUpload.test.ts tests/services/fileServiceSkillResource.test.ts tests/store/skills.test.ts tests/services/chat/skillTools.test.ts`；`src-tauri` 目录分别执行 `cargo test --lib skill_archive::tests` 和 `cargo test --lib skill_storage::tests`。原生命令的授权还应在桌面端验收：未选择授权的文件与第三方插件窗口不得读取，应用私有目录保持拒绝。

## 回滚

撤销本计划涉及的共享入口补齐即可恢复原有入口行为，不迁移已有 Skill 数据；文件夹递归授权修复可独立保留。

压缩包支持可单独回滚上传分支、原生模块及命令注册/权限、直接 ZIP 依赖和入口文案；已导入的记录继续作为普通文件夹型 Skill 读取。

安装目录／原目录引用可回滚新导入分支与模块说明，但新来源 ID 依赖专用原生读取接口；已有新记录应保留该接口，或由用户重新导入，不能通过扩大通用 fs 权限补偿。回滚不删除安装目录文件、原目录或旧应用数据目录文件。

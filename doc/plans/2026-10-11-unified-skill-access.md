# Skill 全软件统一调用

## 目标与状态

Skill 从任一现有入口导入后，节点、主窗口与独立窗口的对话助手、提示词润色、子智能体都使用同一目录和相同的显式调用规则。任务类型为产品能力完善，复用既有目录与执行服务。

- 已实现、待用户验收：文件夹导入补充用户所选目录的递归授权；原生字符串异常转为可读错误提示，日志不记录原始路径。
- 已实现、待用户验收：节点菜单和提交展开、助手文件夹上传、子智能体绑定和执行、Skill 管理列表已补齐共享目录；独立窗口与润色沿用已有共享链路。
- 本次未运行测试，待用户验收。

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

现有文件夹导入修复另涉及 `src/services/fs/skillFiles.ts` 和 `tests/services/fileServiceSkillUpload.test.ts`，保留在本任务改动中。

## 行为边界

- 一次导入、跨入口使用同一 Skill ID，不复制智能体包正文到手动上传的 Skill 数据库。
- 共享显式调用目录继续遵守 `user-invocable`、包启停和当前健康状态；自动发现和显式调用保留各自已有的声明语义。
- 主窗口仍为独立助手窗口的状态写入源，独立窗口继续使用脱敏元数据快照。
- 包内资料仍通过原生来源注册表读取；手动上传资料继续使用现有文件服务。MCP 的已有授权和只读边界继续生效。
- 不涉及依赖、持久化格式、原生命令或安全配置变更。保留工作区内其他任务的 MCP 改动。

## Tauri 桌面端验收

前置条件：使用更新后的桌面端，配置可用的文本助手模型；准备一个 UTF-8 的 Skill 文件夹，根目录含 `SKILL.md`、多级 `references` 文本资料；准备一个含 Skill 的可安装智能体包。

1. 在节点 `/ → Skill → 上传 Skill 文件夹` 导入，确认成功提示、入口正文和多级资料完整保存；助手和润色选择框应出现同一个 Skill。
2. 从助手导入单文件或文件夹，节点菜单应立即出现对应 Skill；切换项目后仍可选择，重启后仍保留。
3. 在智能体中心安装并启用包，包内可显式调用的 Skill 应出现在助手、节点、润色及子智能体绑定选择框中；节点提交应展开正文，而非仅移除引用标记。
4. 给子智能体绑定该 Skill，执行只读任务，确认角色正文来自该 Skill；停用或移除来源后不得继续使用旧正文。有内联角色提示词时按既有规则回退，否则提示不可用。
5. 打开独立助手窗口，核对共享 Skill 选择项；主窗口导入、停用或删除后，独立窗口列表应同步。
6. 管理列表可查看两种来源；包内 Skill 只读，手动上传记录仍可删除；删除后各调用入口同步更新。
7. 取消导入不得新增记录；空文件夹、非 UTF-8 文本和读取权限错误应给出明确提示；单文件上传与减少动态效果、深浅主题展示应回归。

若用户授权命令检查，在仓库根目录执行 `npx vitest run tests/services/fileServiceSkillUpload.test.ts tests/services/fileServiceSkillResource.test.ts tests/services/chat/skillCatalog.test.ts tests/services/skillPromptService.test.ts tests/services/chat/subAgentService.test.ts tests/components/subAgentSettings.test.tsx tests/services/chat/detachedChatSyncController.test.ts` 和 `npm run typecheck`。

## 回滚

撤销本计划涉及的共享入口补齐即可恢复原有入口行为，不迁移已有 Skill 数据；文件夹递归授权修复可独立保留。

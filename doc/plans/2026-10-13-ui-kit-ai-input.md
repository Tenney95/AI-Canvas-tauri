# UI Kit 公用 AI 输入框实施计划

## 目标与边界

以节点提示词输入框为外观基准，将玻璃容器、透明编辑区、底部模型与工具布局、图标按钮和圆形发送按钮收敛到 `src/styles/ui-kit.css` 的 `ui-ai-input` 类。助手主窗口和独立窗口共用 `ChatInput`，沿用同一套外观；保留既有编辑器、任务控制、引用序列化和 Store，快捷键设置通过现有双窗口协议同步。

用户已要求抽离公用样式并统一两处入口；不新增依赖、数据库迁移或原生能力。节点定位、放大、批量发送及停止状态仍由业务组件管理。金属效果复用既有 `PolishMetalFx`，按需加载，性能模式、减少动态效果、加载失败及不支持 WebGL2 时保留静态按钮。

## 实施步骤

1. `src/styles/ui-kit.css`：抽离 `ui-ai-input` 容器及编辑区、占位文案、工具栏、操作按钮、发送与金属容器样式，适配明暗主题与系统显示偏好。节点按容器宽度换行；助手使用 `ui-ai-input__footer--single-row` 单排变体，优先截断模型名称，保留操作按钮；窄容器隐藏 `ui-ai-input__shortcut-hint` 提示。
2. `src/components/nodes/AINodeDialog.tsx`、`nodes/shared/PromptPanel.tsx`、`nodes/shared/MentionEditor.tsx`、`src/styles/panels.css`、`prompt.css`：接入公用类，移除已抽离的基础外观，保留定位、放大与生成业务状态。
3. `src/components/chat/ChatInput.tsx`、`ChatComposerEditor.tsx`、`src/components/nodes/shared/ModelSelector.tsx`、`src/styles/model-selector.css`：接入公用类及节点同款模型入口与金属发送效果，移除助手专用触发器尺寸覆盖；保留引用、Skill、文件授权、上下文指示、调整任务及队列发送。独立窗口的主题读取已应用的 DOM 外观，性能模式订阅既有窗口运行时，不读取独立窗口默认 Store 配置。
4. `src/components/styleGuide/StyleGuideSections.tsx`：在「输入框」分区补充使用真实公用类的可编辑样例，包含发送禁用和有效状态；`doc/画布与项目模块.md` 留存入口与本计划链接。
5. `src/components/shared/SendShortcutMenu.tsx`：从节点发送按钮抽离受控右键菜单，复用 `ui-menu` 与既有快捷键选项，集中处理视口定位、选中状态、方向键/Home/End 导航、Escape/外部点击/滚动收起和触发器焦点恢复。节点沿用全局配置的 Store 保存；UI Kit 样例仅使用局部状态，并复用 `resolvePromptEnterAction` 演示发送与换行，预览不修改实际设置。
6. 助手 `ChatInput` 接入同一右键菜单，`ChatComposerEditor` 复用发送按键判定与换行逻辑，保持输入法确认和引用候选优先。助手与节点共用已有 `AppConfig.promptSubmitShortcut`；`ChatPanel` 的内嵌入口通过 Store 保存，独立入口经 `ChatAction.set_prompt_submit_shortcut` 请求主窗口保存，并由版本化快照/补丁回传唯一快捷键值。配置未完成加载时菜单不可改；主窗口拒绝未就绪或不在四种选项中的请求，不向独立窗口传完整配置。

## 状态与验收

已实现；本次未运行测试，待用户验收。已完成调用链、差异与严格 UTF-8 静态核对，未执行自动化检查、构建或实机验收。

Tauri 桌面端准备一个可编辑的图片/文本节点及助手会话：

1. 打开节点输入框和助手输入框，对比玻璃背景、圆角、透明编辑区、占位字号、模型徽标及底部按钮；聚焦时只有统一的表面提示，不出现助手原来的双层边框或编辑区独立底色。
2. 在两处输入多行中文、粘贴长文本及插入引用，检查滚动、光标与引用展示；助手通过 `@n` / `@a` / `@m` 和 `/` 选择引用或 Skill，文件授权仍可添加与撤销。
3. 空输入时发送禁用，输入后可发送；助手任务运行时仍能入队和调整任务。节点发送快捷键、长按批量数量、生成停止、润色入口及放大/收回仍按原功能工作。
4. 内嵌助手默认宽度由 400px 增至 480px，与独立助手窗口的现有默认宽度一致，拖拽尺寸与视口限制沿用原逻辑。重启应用后打开内嵌助手，确认消息和输入区加宽；选择长名称模型，再调窄内嵌面板和独立助手窗口，模型与工具保持单排，名称超出显示省略号，悬浮仍能查看完整名称。输入文字及任务运行时检查入队/调整按钮：窄容器可隐藏 Enter 提示，操作按钮不被挤出；主/独立窗口切换后草稿与引用保持同步。宽度及单排调整未运行测试，待用户验收。
5. 切换明暗主题、性能模式和系统减少动态效果，检查可读性及静态回退。通过「关于 → 连点 logo 4 次 → 输入框」查看 UI Kit 样例，输入与清空文字可切换发送状态。
6. 在 UI Kit 样例中右键发送按钮，依次选择 Enter、Shift+Enter、Ctrl+Enter、Alt+Enter：选中项显示勾选，提示同步更新；输入文字后匹配组合键模拟发送并清空，其余换行按节点规则处理。检查上下箭头、Home/End、Escape、点击外部及滚动/窗口缩放；菜单应收起且无越界。关闭预览后节点原快捷键设置应保留。
7. 回归节点发送按钮右键设置：选择后提示词占位提示同步，关闭重开节点及重启应用后读取已保存的设置；Escape 收起菜单时返回发送按钮焦点，输入法确认和引用候选仍优先，长按批量发送不被右键操作误触发。本次菜单抽离未运行测试，待用户验收。
8. 在内嵌和独立助手中右键发送按钮，应显示同款菜单且屏蔽浏览器默认菜单。依次切换四种发送组合，验证真实发送/入队、换行与提示一致，节点设置跟随；独立窗口修改后收回内嵌及重启应用，设置应保留。引用/Skill 候选打开时 Enter 优先选择候选，中文输入法确认不发送；未匹配的修饰键不能误发。快捷键未就绪时菜单显示禁用，输入或发送被禁用时仍可右键查看设置。新增双窗口回归用例已编写，未运行测试，待用户验收。

可选检查由用户在仓库根目录执行：

```powershell
npm run typecheck
npx eslint src/components/chat/ChatInput.tsx src/components/chat/ChatComposerEditor.tsx src/components/chat/ChatPanel.tsx src/services/chat/chatWindowService.ts src/services/chat/detachedChatSyncController.ts src/components/nodes/AINodeDialog.tsx src/components/nodes/shared/PromptPanel.tsx src/components/nodes/shared/MentionEditor.tsx src/components/nodes/shared/ModelSelector.tsx src/components/shared/SendShortcutMenu.tsx src/components/styleGuide/StyleGuideSections.tsx
npx vitest run tests/components/promptSubmitShortcut.test.ts tests/services/chat/detachedChatSyncController.test.ts tests/services/chat/chatWindowListener.test.ts
```

预期无类型或 ESLint 错误。真实模型调用、构建和 Tauri 实机验收未由助手执行。

## 回滚

撤回本计划列出的样式、组件接入、公用菜单和助手快捷键同步改动；无需数据库迁移。已保存的 `promptSubmitShortcut` 仍是节点可读取的现有配置。

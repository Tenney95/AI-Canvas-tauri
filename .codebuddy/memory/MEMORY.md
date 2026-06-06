# MEMORY.md

> 长期有效的项目约定、技术决策与偏好。

## 技术决策

### 动画库：framer-motion（2026-05-31）

- **选择了** `framer-motion` 作为主交互动画库
- **否决了** `anime.js`（命令式 API 与 React 声明式理念冲突，无退出动画/布局动画）
- **否决了** `React Bits`（自带完整 UI 体系，与本项目已有 Tailwind + canvas-* token 样式冲突）
- **策略**：framer-motion 覆盖 80% 场景（弹窗进出、按钮微交互、布局动画）；未来如需 SVG 路径动画、数字滚动、复杂时间线，可引入 anime.js 作为特效引擎补充
- **统一缓动**：`cubic-bezier(0.16, 1, 0.3, 1)` (ease-out-expo 风格)
- **模式**：所有条件渲染的弹窗/菜单统一使用 `AnimatePresence` + `motion.div` 包裹，不再使用 `if (!open) return null`

## 项目约定

- 所有文件使用 UTF-8 编码
- 禁止修改 `node_modules/`、`src-tauri/target/`
- 状态管理通过 `useAppStore` 单一 Store，禁止组件内直接修改
- 样式优先 Tailwind class，颜色使用 `canvas-*` token
- 新增类型定义统一放在 `src/types/index.ts`

### Asset Protocol Scope（2026-06-06）

- `tauri.conf.json` 的 `assetProtocol.scope` 设为 `["**"]`，支持任意路径的文件通过 `asset://localhost/` 协议加载
- 原因：用户可通过设置面板自定义 `baseDataDir`（可能在任何驱动器），`$APPDATA/**` 不足以覆盖

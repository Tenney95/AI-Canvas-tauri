# PointEdit 包迁移实施计划

**目标**：把图片节点使用的通用矢量标注能力迁移到 `Tenney95/XiaoLuo-PointEdit`，并让 AI Canvas 通过 npm registry 消费个人作用域包。

**架构**：Fork 保留现有 `ImageEditor` API，新增不依赖 Zustand、Tauri 或 AI Canvas 的受控编辑器、渲染层、数据模型和透明层导出函数。AI Canvas 只保留节点和模型请求适配，通过包公开 API 读写 `ImageAnnotationLayer`。

**技术栈**：React、TypeScript、Vite library mode、npm registry、CSS theme tokens。

**状态**：阶段一、阶段二已完成。功能 PR 已合入原作者与 Fork 的 `main`，临时分支已删除；`@tenney95/xiaoluo-image-editor@1.1.0` 已发布为公开 npm 包，AI Canvas 已改用 `^1.1.0` registry 依赖。

---

## 阶段一：扩展 Fork 公共 API

涉及 Fork 文件：

- 新增 `src/components/PointEdit/PointEditEditor.tsx`
- 新增 `src/components/PointEdit/PointEditCanvas.tsx`
- 新增 `src/components/PointEdit/PointEditToolbar.tsx`
- 新增 `src/components/PointEdit/AnnotationLayer.tsx`
- 新增 `src/components/PointEdit/point-edit.css`
- 新增 `src/utils/annotationExport.ts`
- 修改 `src/types/annotation.ts`
- 修改 `src/index.ts`
- 修改 `package.json`
- 更新 `dist-lib/`

步骤：

1. 增加版本化 `ImageAnnotationLayer` 类型、运行时校验和尺寸映射。
2. 移植受控 SVG 交互画布和独立 SVG 渲染层。
3. 增加带 50 步历史、快捷键、缩放和原版双胶囊工具栏的受控编辑器。
4. CSS 使用包级 `--point-edit-*` 变量，并从宿主的 `data-theme` 继承明暗主题。
5. 导出透明标注层栅格化函数；不绘制或改写原图。
6. 保持旧 `Annotation`、`Canvas` 和 `ImageEditor` 导出兼容。
7. 运行 `npm run lint` 与 `npm run build:lib`，检查打包内容。
8. 提交并推送功能分支，PR 合并后同步 Fork `main` 并删除临时分支。

## 阶段二：AI Canvas 改用包依赖

涉及 AI Canvas 文件：

- 修改 `package.json`、`package-lock.json`
- 修改 `src/components/nodes/ImageNode.tsx`
- 修改 `src/services/ai/promptResolver.ts`
- 修改 `src/types/index.ts`
- 修改 `src/styles/nodes-image.css`
- 修改 `tests/components/annotationLayer.test.tsx`
- 删除已由包接管的 2 个既有本地组件，并确认迁移期间的 5 个辅助实现文件未留在仓库

步骤：

1. 用 npm 安装 `@tenney95/xiaoluo-image-editor@^1.1.0`，并由 lockfile 锁定 registry 包版本与完整性摘要。
2. 从包导入 `PointEditEditor`、`AnnotationLayer`、类型和导出函数。
3. 删除本地重复组件、类型和导出模块。
4. 清理已经迁入包的标注编辑器 CSS，只保留节点覆盖层定位样式。
5. 保持 `annotationLayer` 持久化格式和旧 PNG 回退行为不变。
6. 运行类型检查、定向 ESLint、完整测试和生产构建。
7. 在明暗主题下验证编辑、保存、重新打开和原图 URL 不变。

## 完成记录（2026-07-22）

- Fork 的 lint、library build 和 pack dry-run 通过；PR 已合并，Fork `main` 已同步，临时分支已删除。
- `@tenney95/xiaoluo-image-editor@1.1.0` 已通过 Windows 安全密钥授权发布为公开 npm 包。
- AI Canvas 的前端类型检查、测试类型检查、PointEdit 定向 ESLint、标注层定向测试、生产构建、UTF-8 和差异检查通过。
- 浏览器验证了原版双胶囊工具栏、明暗主题、保存后独立 SVG 透明层、重新打开可编辑，以及原图 URL 不变；临时测试节点已删除并恢复暗色主题。
- 全量测试 223/223 通过。
- `ImageNode.tsx` 定向 ESLint 仍为迁移前已有的 6 个错误和 6 个警告，本次未扩大范围处理。

## 回滚

移除 `@tenney95/xiaoluo-image-editor` registry 依赖并恢复被删除的本地文件即可。持久化数据结构不变，不需要 IndexedDB 迁移。

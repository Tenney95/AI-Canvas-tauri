# 3D 导演台生产运行方式实施计划

> **状态：已被取代。** 2026-07-21 起改用运行时按需下载，实施记录见 `doc/plans/2026-07-21-director-desk-on-demand-runtime.md`。本文件保留为构建期内置方案的历史记录。

**目标：** 开发环境继续使用本地源码和 Vite，生产环境改为校验后随 Tauri 安装包发布的版本化静态资源。

**架构：** 导演台 Fork 负责从 tag 构建并发布 `dist`；主项目构建阶段按固定清单下载、校验和准备资源；Tauri 独立窗口在开发模式加载本地端口，在生产模式加载应用内页面。通信协议和主窗口数据写入边界不变。

## Task 1：发布导演台预构建资源

**文件：**

- `C:/Users/Tenne/Projects/3d-director-desk/.github/workflows/release.yml`
- `C:/Users/Tenne/Projects/3d-director-desk/package.json`
- `C:/Users/Tenne/Projects/3d-director-desk/package-lock.json`
- `C:/Users/Tenne/Projects/3d-director-desk/src/__tests__/App.test.tsx`

**实施：**

1. 升级补丁版本，并校验 Git tag 与包版本一致。
2. 标签发布时运行 `npm ci`、完整测试和生产构建。
3. 在 `dist` 写入版本和 `tauri-event-v1` 协议元数据。
4. 发布 `tar.gz` 静态资源包及 SHA-256 文件。

## Task 2：实现主项目产物准备器

**文件：**

- `scripts/director-desk-release.json`
- `scripts/prepare-director-desk.mjs`
- `package.json`
- `.gitignore`

**实施：**

1. 固定发布仓库、版本、资源 URL、协议和 SHA-256。
2. 下载时限制大小并校验 SHA-256；缓存只在再次校验通过后复用。
3. 解包前拒绝路径穿越，解包后校验入口、版本和协议元数据。
4. 优先原子替换 `public/director-desk`；Windows 文件监听占用时先备份旧目录，再使用已校验复制，保留恢复能力。
5. 将准备步骤接入 `npm run build`，使本地 Tauri build 和 GitHub Release 使用同一路径。

## Task 3：分离开发与生产窗口地址

**文件：**

- `src/services/directorDeskService.ts`
- `tests/services/directorDeskWindowService.test.ts`

**实施：**

1. 开发模式继续生成 `http://127.0.0.1:5178` URL，并保留本地 origin 覆盖。
2. 生产模式固定生成 `director-desk/index.html` 应用内路径。
3. 两种路径都保留 `instanceId`、`theme`、`transport=tauri` 和宿主窗口标签。
4. 增加生产路径测试，并重跑既有窗口复用、实例隔离和请求关联测试。

## Task 4：验证与发布

1. Fork：完整测试、生产构建、`git diff --check` 和严格 UTF-8 检查。
2. 主项目：准备真实发布资产，运行定向 Vitest、TypeScript、ESLint、临时目录 Vite 构建和 `git diff --check`。
3. 确认生成的主应用产物包含 `director-desk/index.html`，且 HTML 中引用均为相对路径。
4. Tauri 开发模式验证 5178 窗口通信；生产构建验证应用内窗口无需本地服务即可打开。

## 回滚

- Fork 发布失败时不创建 Release，修复后用新补丁版本重新发布，不覆盖已发布 tag。
- 主项目构建失败时保持上一份缓存和发布清单；提交后用 `git revert` 回滚本批变更。
- 已发布应用按完整 AI Canvas 版本回滚，避免单独替换导演台造成协议错配。

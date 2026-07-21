# 3D 导演台 Tauri 独立窗口实施计划

> **For Claude:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task.

**Goal:** 将 3D 导演台从画布内 iframe 改为可复用、可聚焦的 Tauri 独立窗口，并完整保留截图、当前帧和参考视频回写能力。

**Architecture:** 主窗口通过固定标签 `director-desk` 创建外部 URL WebviewWindow，并作为节点数据唯一写入源。主窗口与 `Tenney95/3d-director-desk` 使用带 `instanceId` 的定向 Tauri 事件交换现有协议消息；导演台 Fork 保留 iframe `postMessage` 兼容路径，并在检测到 Tauri 全局 API 时切换到事件传输。

**Tech Stack:** Tauri 2 WebviewWindow/Event API、React 19、TypeScript、Vitest、Vite。

---

### Task 1: 定义主项目独立窗口通信协议

**Files:**
- Create: `src/services/directorDeskWindowService.ts`
- Test: `tests/services/directorDeskWindowService.test.ts`
- Modify: `src/services/directorDeskService.ts`

**Steps:**
1. 先写失败测试，覆盖窗口标签、URL 参数、消息按 `instanceId` 过滤和请求按 `requestId` 关联。
2. 运行 `npx vitest run tests/services/directorDeskWindowService.test.ts`，确认测试先失败。
3. 实现 `openDirectorDeskWindow`、`subscribeDirectorDeskWindow`、`requestDirectorWindowAction` 和 `closeDirectorDeskWindow`。
4. 使用 `WebviewWindow.getByLabel('director-desk')` 复用窗口；新建窗口直接加载导演台 URL，不创建 iframe。
5. 主窗口仅通过 `emitTo('director-desk', 'director-desk:host-message', payload)` 发送消息，并监听 `director-desk:message`。
6. 重跑定向测试，预期通过。

### Task 2: 将画布节点切换到独立窗口

**Files:**
- Modify: `src/components/nodes/DirectorDeskNode.tsx`

**Steps:**
1. 删除 `FullscreenOverlay`、iframe ref 和 overlay 渲染。
2. “打开导演台”调用窗口服务；已存在窗口时聚焦并发送当前节点 session。
3. 订阅当前 `instanceId` 的 ready、close、captures 和 response 消息。
4. 保留截图落盘与节点回写逻辑；同步当前帧和导出视频改走窗口服务请求。
5. Web 模式显示“仅 Tauri 桌面端支持”，不回退 iframe 或 `window.open`。
6. 运行定向 ESLint、TypeScript 和窗口服务测试。

### Task 3: 限定远程 Webview 权限

**Files:**
- Create: `src-tauri/capabilities/director-desk.json`

**Steps:**
1. 将 capability 限定为窗口 `director-desk` 和 URL `http://127.0.0.1:5178/**`。
2. 仅授权 Tauri event listen/emit 所需权限，不授权 fs、shell、dialog 或通用网络能力。
3. 运行 `cargo check --lib`，确认 capability/schema 可加载。

### Task 4: 扩展导演台 Fork 的 Tauri 事件传输

**Files:**
- Create: `C:/Users/Tenne/Projects/3d-director-desk/src/editor/io/tauriHostTransport.ts`
- Modify: `C:/Users/Tenne/Projects/3d-director-desk/src/editor/io/hostBridge.ts`
- Modify: `C:/Users/Tenne/Projects/3d-director-desk/src/App.tsx`
- Modify: `C:/Users/Tenne/Projects/3d-director-desk/src/App.test.tsx`
- Modify: `C:/Users/Tenne/Projects/3d-director-desk/src/editor/io/hostBridge.test.ts`
- Test: `C:/Users/Tenne/Projects/3d-director-desk/src/editor/io/tauriHostTransport.test.ts`

**Steps:**
1. 写失败测试，模拟 `window.__TAURI__.event`，覆盖 ready、close、宿主请求、响应和截图事件。
2. 实现传输适配器：Tauri 环境使用 `listen/emit`，普通 iframe 环境继续使用 `postMessage`。
3. 所有出站消息自动附带 `instanceId`；所有入站消息必须匹配当前实例。
4. `hostBridge.ts` 复用既有 payload 校验和动作处理，不复制业务协议。
5. 运行 Fork 的 `npm test`、`npm run build` 和定向类型检查。
6. 使用中文提交说明提交并推送 `Tenney95/3d-director-desk:main`。

### Task 5: 端到端验证

**Files:**
- Verify only

**Steps:**
1. 运行主项目 `npm run check`、定向 ESLint、临时目录 Vite 构建、`cargo check --lib`、`git diff --check` 和严格 UTF-8 扫描。
2. 在 Tauri 开发窗口创建导演台节点并点击打开。
3. 验证只出现一个独立 `director-desk` 窗口，再次点击只聚焦、不重复创建。
4. 验证导演台发送截图、主窗口同步当前帧、导出参考视频和关闭状态。
5. 截图确认导演台为独立窗口，主画布内不存在 iframe 或全屏 overlay。

### 回滚方案

- 主项目未提交前可逐文件撤销本计划新增内容；提交后使用 `git revert <主项目提交>`。
- Fork 提交后使用 `git revert <Fork 提交>` 并推送，不改写共享历史。
- capability 删除后，远程导演台窗口不再获得任何 Tauri API 权限。

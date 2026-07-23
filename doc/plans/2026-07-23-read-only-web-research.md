# 纯只读网页研究 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 让 Agent 在未配置搜索 API Key 时也能主动读取公开网页并沿页面链接继续研究，同时不获得 Shell、本地文件或系统命令能力。

**Architecture:** 复用现有 `assistant_web_extract` Rust 命令作为唯一网络出口；它仅执行无 Cookie、无自定义 Header、无请求体的 `GET`，并逐跳校验协议、DNS/IP、端口、重定向、内容类型和响应大小。前端从返回的 HTML 中提取正文与安全链接，链接只作为当前任务的临时导航上下文，不持久化网页正文。

**Tech Stack:** Tauri 2、Rust `reqwest`、React/TypeScript、Agent Tool Registry、Vitest。

---

### Task 1: 扩展任务级网页导航授权

**Files:**
- Modify: `src/services/chat/webAccessGrantService.ts`
- Test: `tests/services/chat/webAccessGrantService.test.ts`

**Steps:**
1. 先增加失败测试，覆盖安全公网 HTTPS 初始导航、HTTP 仅限已有任务授权、私网与敏感查询拒绝。
2. 增加批量记录页面链接的内存授权函数。
3. 保持授权只绑定 `taskId`，任务结束后继续由现有清理逻辑释放。
4. 运行 `npx vitest run tests/services/chat/webAccessGrantService.test.ts`。

### Task 2: 提取正文页面中的可跟随链接

**Files:**
- Modify: `src/services/webPageService.ts`
- Test: `tests/services/chat/webTools.test.ts`

**Steps:**
1. 扩展 `WebPageResult`，返回去重后的公开 HTTP(S) 链接及可读标题。
2. 使用浏览器标准 `DOMParser` 和 `URL` 解析相对链接，不执行页面脚本。
3. 过滤凭据 URL、私网字面地址、非标准端口和敏感查询参数，并限制返回数量。
4. 保持正文截断和来源元数据结构不变。

### Task 3: 向 Agent 暴露无 Key 的受控网页浏览

**Files:**
- Modify: `src/services/chat/tools/webTools.ts`
- Modify: `src/services/ai/assistantStream.ts`
- Test: `tests/services/chat/webTools.test.ts`

**Steps:**
1. 将 `web_extract` 的用户可见能力说明改为“浏览和读取网页”，保留工具 ID 兼容既有任务。
2. 允许模型主动打开通过双层校验的公开 HTTPS 页面；不增加请求方法、Header、Cookie、请求体、下载或脚本执行。
3. 把页面链接写入任务级临时授权，并作为可继续浏览的 URL 返回模型。
4. 调整系统提示：有 `web_search` 时优先使用；没有 Key 时从已知公开来源开始浏览。
5. 运行 `npx vitest run tests/services/chat/webTools.test.ts`。

### Task 4: 文档与全量验证

**Files:**
- Modify: `doc/对话助手-Agent能力实施方案.md`

**Steps:**
1. 记录无 Key 只读网页研究能力、限制和完成状态。
2. 运行改动文件定向 ESLint、`npm run typecheck`、`npm run test:typecheck` 和定向 Vitest。
3. 运行 `cargo test assistant_web::tests --lib` 与 `cargo check --lib`，确认原生安全边界未回归。
4. 运行生产构建、`git diff --check`、严格 UTF-8 解码和乱码扫描。

> 当前工作区包含用户已有未提交改动，本计划不自动创建提交，避免混入或覆盖其他工作。

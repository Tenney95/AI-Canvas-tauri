# 可信 Python 插件兼容实施计划

> 本计划在当前仓库直接执行；每个任务完成后运行对应的定向检查。

**目标：** 在保留 JavaScript QuickJS 强沙箱的前提下，让用户插件可选择本机 Python 运行时，并对其完整本机权限做显式、不可混淆的风险提示。

**架构：** Plugin API v3 增加 `runtime: "python"` 与 `entry: "main.py"`，v1/v2 JavaScript 插件继续按原协议运行。前端仍负责裁剪输入、校验输出、宿主 effect、canvas revision 与 Store 写回；Rust 仅为 Python 分支启动一次性子进程，通过 stdin/stdout JSON 信封通信并限制时间、输入、输出和错误长度。Python 是“可信代码”而不是安全沙箱，安装和重新启用都必须由用户确认。

**技术栈：** React 19、TypeScript、Zustand、Tauri 2、Rust `std::process`、Vitest、Rust 单元测试。

---

### 任务 1：固定 Manifest 与兼容边界

**文件：**

- 修改：`src/types/plugin.ts`
- 修改：`src/services/plugins/pluginManifest.ts`
- 测试：`tests/services/pluginManifest.test.ts`

**步骤：**

1. 先增加失败测试：v3 Python Manifest 被接受，v1/v2 仍只接受 `main.js`，runtime/entry 不匹配时拒绝。
2. 运行 `npx vitest run tests/services/pluginManifest.test.ts`，确认新用例先失败。
3. 增加 `PluginRuntime`、API v3、可选向后兼容 runtime 归一化以及动态入口错误信息。
4. 再运行同一测试，确认通过。

### 任务 2：兼容本地导入与 GitHub Release

**文件：**

- 修改：`src/components/settings/PluginSettings.tsx`
- 修改：`src/services/plugins/pluginMarketplace.ts`
- 测试：`tests/services/pluginMarketplace.test.ts`

**步骤：**

1. 增加市场测试，验证按 Manifest 入口下载 `main.py`，并继续限制大小和仓库一致性。
2. 修改本地文件夹导入：先读取 Manifest，再从同级目录读取归一化后的 entry。
3. 修改市场解析：先下载 Manifest 和校验入口，再下载对应源码。
4. 运行插件市场测试。

### 任务 3：实现可信 Python 子进程运行时

**文件：**

- 修改：`src-tauri/src/plugin_runtime.rs`
- 修改：`src-tauri/src/lib.rs`
- 修改：`src/services/plugins/pluginRuntime.ts`
- 测试：`src-tauri/src/plugin_runtime.rs`
- 测试：`tests/services/pluginRuntime.test.ts`

**步骤：**

1. 扩展前端调用测试，确保 runtime 随每次工具调用进入同一个原生命令。
2. Rust 增加解释器探测命令和 Python 执行分支；命令参数使用数组，不通过 Shell，不拼接用户命令。
3. Python runner 从 stdin 读取源码、toolId 和 input，支持 `define_plugin({"tools": {...}})`，只把最后一个 JSON 结果写到 stdout。
4. 子进程使用独立 stdin/stdout/stderr、清理插件协议环境变量、设置超时并在超时后 kill/wait；限制输入、输出和错误信息大小。
5. 前端继续使用现有输出校验、宿主 effect、过期结果丢弃和 Store Action，不给 Python 新的画布写入捷径。
6. 运行 Rust 定向测试、`cargo check --lib` 和前端 runtime 测试。

### 任务 4：风险确认与环境反馈

**文件：**

- 修改：`src/store/store.plugins.ts`
- 修改：`src/components/settings/PluginSettings.tsx`
- 测试：`tests/store/storePlugins.test.ts`（若现有文件不存在则在插件服务测试中覆盖纯逻辑）

**步骤：**

1. Store 安装与启用接口增加显式 `trustedPythonConfirmed`，未确认时拒绝高风险状态变更。
2. 插件设置页在安装、更新和重新启用 Python 插件前展示原生确认，说明其可访问文件、网络、环境变量并执行本机代码。
3. 增加 Python 环境检测状态和版本展示；缺少解释器时允许安装但默认停用，并提供明确修复提示。
4. 增加最小 Python 示例插件，JavaScript 示例保持不变。
5. 运行组件相关测试和 TypeScript 类型检查。

### 任务 5：文档、回归与阶段收尾

**文件：**

- 新增：`doc/adr/0009-trusted-python-plugin-runtime.md`
- 修改：`doc/插件开发规范.md`
- 修改：`doc/plans/2026-08-23-user-plugin-platform.md`
- 修改：`doc/对话助手-Agent能力实施方案.md`

**步骤：**

1. 写明可信 Python 与 QuickJS 沙箱的安全差异、目录结构、协议、解释器发现顺序、依赖策略和故障提示。
2. 记录未新增依赖、未自动安装 requirements、未向 Agent/MCP 暴露 Python/Shell、未改变 Tauri capability。
3. 运行定向 Vitest、前端 typecheck、定向 ESLint、Rust 测试与检查、`git diff --check`、严格 UTF-8/乱码扫描。
4. 检查 `git status --short`，确保没有无关变更。
5. 按项目规范用中文提交阶段代码。


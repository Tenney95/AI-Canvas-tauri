# ADR-0009：可信 Python 插件运行时

## 状态

已接受。

## 背景

现有用户插件仅支持同步 JavaScript，并在无文件、网络、Shell、模块加载器和 Tauri API 的 QuickJS Runtime 中执行。用户希望复用本机 Python 生态及已安装依赖，这与当前强沙箱边界天然冲突：普通 CPython 代码可以直接访问本机文件、网络、环境变量和系统 API，不能仅靠 Manifest 权限或清理环境变量变成安全沙箱。

需求同时要求：

- JavaScript 插件继续保持 QuickJS 强沙箱；
- Python 插件能使用本机解释器及现有 site-packages；
- 不把任意 Shell/Python 能力注册给 Agent 或 MCP；
- 插件结果仍受字段声明、宿主 effect、项目 ID、canvas revision 和 Store Action 约束；
- 缺少 Python、执行超时、输出过大或协议错误时可诊断、可恢复；
- 不自动安装依赖，不修改 Tauri capability 或安全配置。

## 决策

1. Plugin API v1 使用显式 `runtime` 区分执行环境：Python 入口固定为 `main.py`，JavaScript 使用 `main.js`。
2. Python 插件被定义为“可信本机代码”，不是沙箱。安装、更新和从停用状态重新启用时，宿主必须显示高风险确认。
3. Rust 每次调用创建独立 CPython 子进程，不使用 Shell。按平台探测 `python`、`python3` 和 Windows `py -3`，通过 JSON stdin/stdout 信封传递源码、toolId 和受裁剪输入。
4. 子进程保留本机 Python 的导入能力和 site-packages；宿主仅提供超时、进程终止、输入输出上限、错误脱敏和协议隔离，不宣称限制 Python 对操作系统的访问。
5. 前端继续执行现有 Manifest 字段校验、宿主 effect 授权、canvas derivation guard 和 Store 写回。Python 不获得直接 Store、Tauri IPC、API Key 或文件 grant 路径；但作为可信本机代码，它仍可能自行读取本机资源，这一点必须在 UI 和文档中明确。
6. 首版不读取或自动执行 `requirements.txt`，不创建虚拟环境，不下载 Python，不持久化解释器绝对路径。

## 影响

### 正向

- Python 作者可以复用本机标准库和已安装包。
- JavaScript 强沙箱不降级；当前插件格式统一使用 API v1。
- 运行失败限定在一次性子进程，超时可终止，不阻塞 QuickJS Runtime。
- 不新增依赖、数据库 schema、Tauri capability 或 Agent 工具。

### 负向

- Python 插件具有与当前用户相同的操作系统权限，恶意插件可能读取或修改本机数据、访问网络或启动其他进程。
- 本机 Python 版本和依赖不一致会降低插件可复现性。
- 进程启动成本高于 QuickJS，首版不适合高频逐帧处理。

### 中性

- Manifest 权限对 Python 仍约束宿主代办能力和 UI 展示，但不是操作系统级沙箱。
- 市场中的 Python 插件与本地插件使用相同高风险确认，不因来源是 GitHub 而获得信任。

## 备选方案

### 在 QuickJS 中继续只支持 JavaScript

安全边界最好，但无法满足 Python 生态复用目标。

### 嵌入 RustPython、Pyodide 或 WASM Python

可提供更强隔离，但包兼容性有限、安装体积和运行复杂度显著增加，不能满足“使用本机现有依赖”。

### 自动创建虚拟环境并执行 requirements.txt

依赖更可复现，但安装依赖本身可以执行任意构建脚本，会扩大供应链与网络风险；留待后续单独设计。

### 直接通过 Tauri Shell 插件执行 Python

会要求扩大前端 Shell capability，并让命令边界更难审计，因此拒绝。原生 Rust 只注册具体插件命令。

## 故障与回滚

- 未找到 Python：插件保持可安装但不可执行，设置页显示检测失败；JavaScript 插件不受影响。
- 超时或协议错误：终止子进程并返回有限错误，不写回画布。
- 回滚：移除 API v1 中的 Python runtime 分支、环境检测和风险 UI；不需要数据库降级。

## 参考

- `doc/plans/2026-08-26-trusted-python-plugins.md`
- `doc/plans/2026-08-23-user-plugin-platform.md`
- `doc/插件开发规范.md`

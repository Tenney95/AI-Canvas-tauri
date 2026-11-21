# 本地 Tauri Channel 隔离补丁

宿主通过本目录使用 Tauri 2.12.7 和项目的 WebView 隔离、IPC、原生窗口补丁。升级从 2.11.2 的原始发布包、项目旧补丁和 2.12.7 的原始发布包三方合并。后续维护在此目录完成。

本地补丁使用 Rust 1.95 起稳定的原子条件更新方法 `try_update`。本目录的 Cargo 清单声明 Rust 1.95 为最低版本。

## 来源与许可

- crates.io 的 `tauri-2.12.7.crate` 包含 143 个文件，SHA-256 为 `30fbfbb9dc9a2697b0e96d909ddc295fb18d2d82a58ed542ab8d9eba2edbe6da`。[官方发布](https://github.com/tauri-apps/tauri/releases/tag/tauri-v2.12.7)
- 保留发布包的 `LICENSE-APACHE-2.0`、`LICENSE-MIT`、原始 Cargo 清单与 `.cargo_vcs_info.json`。宿主 Cargo 清单精确锁定内核，通过 `[patch.crates-io]` 指向本目录。
- 本地队列仍按真实 WebView 实例绑定。2.12.7 上游已按 WebView 标签隔离队列，项目保留实例隔离、显式 fetch ACL 和同名重建隔离，并合入新版对关闭窗口的事件监听清理。[上游 IPC 安全公告](https://github.com/tauri-apps/tauri/security/advisories/GHSA-w28w-mhc8-qvjv)

## 定点修改

| 文件 | 内容 |
| --- | --- |
| `src/ipc/channel_queue.rs`（新增） | 每个真实 WebView 实例持有待取数据；克隆共享，重新创建不继承；取一次即失效，关闭清空并拒绝迟到发送，eval 失败回收；数字 ID 耗尽失败而不是回绕 |
| `src/ipc/channel.rs` | 流式 Channel 和普通 invoke 回退均使用上述队列；取数命令接受实际 WebView；不改变旧 wire 名、阈值、JSON/二进制类型或流式序号 |
| `src/ipc/protocol.rs` | macOS 在对应 WebView 的主线程交付最终 IPC 响应，保留上游协议校验 |
| `src/webview/mod.rs` | 创建/克隆携带实例队列，移除内置 fetch 的 ACL 豁免，仅在 ACL 查询时把旧命令映射到 `plugin:channel\|fetch` |
| `src/manager/mod.rs` | 窗口和 WebView 关闭时撤销实例队列，包括仍被异步发送者持有的克隆 |
| `src/manager/webview.rs` | 带 `xiaohongshu-reference-` 或 `xiaohongshu-reference-toolbar-` 和 32 位十六进制会话 ID 的小红书子 WebView 跳过应用、素材与 IPC 协议、主应用初始化及插件注入。仅标题栏子 WebView 注册固定 `xhs-reference-toolbar` 资源协议。宿主继续负责导航和单图导入 |
| `src/app.rs`、`src/lib.rs` | 使用实例内队列，保留 Windows debug 冷维护所需的受管窗口与 WebView 计数 |
| `src/webview/exclusive_environment.rs` | 保留 Windows debug 冷维护的独占 WebView2 环境和 profile，依赖与宿主对齐 |
| `build.rs` | 启用 `core:channel` 权限生成，`core:default` 包含其默认取数权限 |
| `src/test/mod.rs`、`src/test/channel_security.rs`、`tests/channel-security.rs` | 仅 Tauri 既有 test feature 编译的 MockRuntime 回归与宿主测试 target |

构建自动生成 Channel 权限参考和宿主 `gen/schemas/` 中的 ACL、capability 与目标平台 schema。默认权限集合在构建输出目录生成，平台 schema 由对应平台构建更新。

第一方窗口经 `core:default` 只能取自己的消息。第三方插件窗口仅使用专用会话桥接，保持原有 capability。宿主 FS 2.7.1 使用显式权限保留原 `fs:default` 的命令和允许路径，启用新版 WebView 数据拒绝。[宿主默认 capability](../../capabilities/default.json)

## 可复现检查

从宿主 `src-tauri/` 目录执行。依赖已缓存时可以附加 `--offline`。

```text
cargo check --lib --locked
cargo test --test tauri-channel-security --features tauri-channel-tests --no-default-features --locked
cargo test --lib --no-default-features --locked path_policy::tests
cargo test --lib --no-default-features --locked plugin_
```

测试 target 只在显式启用 `tauri-channel-tests` 时参与构建，不引入其他第三方库。Windows/MSVC 测试通过宿主 build.rs 的 `rustc-link-arg-tests` 获得 Common Controls v6 manifest；否则 MockRuntime 链接到的控件函数可能在执行测试前触发 `STATUS_ENTRYPOINT_NOT_FOUND`。这与主程序既有 manifest 相同，不安装系统组件，也不改变正式二进制的链接参数。依据 [Cargo build scripts](https://doc.rust-lang.org/cargo/reference/build-scripts.html#rustc-link-arg-tests) 与 [Microsoft MANIFESTDEPENDENCY](https://learn.microsoft.com/en-us/cpp/build/reference/manifestdependency-specify-manifest-dependencies?view=msvc-170)。

MockRuntime 覆盖实际命令分派和生成的 ACL，但不执行 JavaScript、WebView2 来源注入、系统窗口事件或真实 UI。普通 invoke 的回退回归直接调用其 Channel 构造路径，不应宣称整个浏览器协议端到端通过。默认特性 Rust test 在本机另受既有 ONNX/VS2019 链接问题影响，因此测试使用 `--no-default-features`，默认特性仅运行 cargo check。

2026-11-21 在 Apple Silicon macOS 上通过默认特性 `cargo check`，以及 13 项 Channel / FS 宿主回归、10 项路径回归和 103 项插件定向回归。宿主 FS 用例覆盖项目目录读写、外部目录授权前拒绝、授权后可用及显式拒绝优先。macOS 隔离开发版通过独立助手关闭重开、草稿保留和授权附件预览。Windows WebView2 和正式安装包仍待验收。

## 后续维护与回滚边界

- 升级 Tauri 前先对照上游核实此补丁是否已被正式修复，再重跑全部队列、ACL、第一方回包与真实 WebView 验收；不能静默跳过本地 patch。
- 保持独立窗口的来源与存储、CSP、导航、会话和 revision 校验。
- 回滚以本次升级前的工作区为基线，一起还原 npm/Cargo 清单和锁、本目录、宿主 capability 与生成 ACL。保留原有 2.11.2 本地补丁和此前依赖升级，项目数据沿用原目录。

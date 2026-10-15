# 应用下载真实进度

状态：已实现；本次未运行测试，待用户验收。

## 目标与边界

把应用内可见下载接到实际传输数据，复用 UI Kit 的 `ui-progress` 和共享 `DownloadProgress`。有可靠总字节数时显示百分比和已下载/总大小；无总量时显示已下载字节与“总大小未知”，不按时间模拟。多文件按当前文件显示，Git 按实际对象计数逐阶段显示，不混算整体百分比。

下载完成与校验、安装、重启是独立状态。安装过程没有可计量数据时只显示阶段，不编造下载进度。沿用原生授权、私有目录、下载体积和摘要校验；不新增通用事件权限，不写入持久化状态。

ComfyUI 的四个进度命令直接接收 `Channel<String>`，前端服务始终传入通道，只有内部辅助函数保留 `Option<Channel<String>>`。命令参数不能套用 `Option`，否则会落到普通 Serde 反序列化并触发 `E0277`。该编译问题已修正，尚待用户重新执行 `cargo check --lib` 和桌面验收。

应用版本检查优先请求 GitHub Release 的 `latest.json`，连接、超时或 HTTP 状态失败后由 Tauri updater 按配置切换到 `gh-proxy.com` 再请求一次。启动静默检查、关于页检查和安装前检查共用该顺序，每个源超时 30 秒；正常返回当前版本时不访问镜像。此兜底仅作用于版本清单请求，安装包仍使用清单中的下载地址。已实现，待用户验证；本次未运行测试。

## 实施范围

| 范围 | 源码入口 | 行为 |
|---|---|---|
| 共享展示 | `src/components/shared/DownloadProgress.tsx` | 真实字节、百分比、未知总量和无障碍进度语义，沿用深浅主题 token |
| 应用更新 | `updateService.ts`、`store.ui.ts`、`App.tsx`、`Sidebar.tsx`、`UpdateBubble.tsx` | updater 原生事件累计字节；两个入口共享运行态，单次下载安装，区分校验安装及重启 |
| ONNX 模型 | `useModelDownload.ts`、`ModelDownloadDialog.tsx`、图片/音频/合成编辑器入口、`media/onnx/mod.rs` | 超分、主体识别、ASR 下载进度；多文件逐项展示；取消/卸载中止，取消不继续切镜像 |
| 轻量导演台 | `DirectorDeskRuntimeManager.tsx`、`DirectorDeskDownloadDialog.tsx` | 展示下载、校验、解包各阶段的真实字节，清理监听和取消状态 |
| 即梦组件 | `DreaminaLoginModal.tsx`、`media/dreamina.rs`、`files/transfer.rs` | 流式下载 CLI 并显示字节，保留探活、原子替换及旧版回退 |
| ComfyUI 管理 | `comfyManagementService.ts`、`components/comfyui/`、`media/comfyui/management.rs` | 插件目录显示字节；Git 安装/更新/刷新显示实际对象阶段和计数；专属字符串 Channel 回传固定字段，不回传原始进程输出 |
| 插件市场 | `pluginMarketplace.ts`、`PluginSettings.tsx` | 市场刷新预取与从仓库安装显示实际下载量，保留来源和大小限制 |
| 节点远程另存为 | `fileService.ts`、`useNodeContextMenu.ts`、`store.ui.ts`、`NodeOutputDownloadDialog.tsx`、`Canvas.tsx` | 真实远程下载字节、取消与重复点击保护；弹窗独立订阅 UI 运行态，控制器留 Hook ref，画布不随字节刷新；本地/文本保存不显示网络下载 |

不把媒体生成、内存导出、本机字体枚举或 Blender 本机安装发现算作网络下载。ComfyUI 的 pip 依赖安装仍显示安装状态：当前固定命令没有稳定可用的逐包字节协议，不能据此给出可靠总体百分比。插件视频复刻在宿主任务登记前准备 ASR 模型的内部调用仍沿用原流程，未扩展插件宿主下载协议。

## 用户验收

前置：使用包含本次 Rust 变更的 Tauri 桌面运行时和可访问的下载源。应用更新必须用有可用新版本的打包应用验收；开发模式会跳过自动检查。优先使用可丢弃的测试安装和目标文件，深色、浅色主题各检查一次。

1. 关于→检查更新→下载安装；同时查看吉祥物提示。应显示同一份已下载/总字节和百分比，重复点击不启动第二次安装；下载完成后切到校验安装、重启状态。正常访问 GitHub 时不请求镜像；仅阻断 GitHub 直连、保留镜像可访问时，版本检查应在直连失败或 30 秒超时后通过镜像完成；同时阻断两个源时应结束检查并恢复可点击状态，不循环重试。最新版本场景不额外请求镜像，启动静默检查与安装前检查沿用相同顺序。
2. 在未安装相应模型的测试环境，分别从图片超分、主体识别、音频转文本和图片合成编辑器触发下载。应显示实际字节，ASR 两文件逐项显示；取消后不切镜像继续下载，再次发起可正常完成。
3. 打开未安装运行时的轻量导演台。下载、校验、安装分阶段显示各自计量；取消、失败、重试不残留旧监听或旧百分比。本地选择安装包仍可使用。
4. 设置→即梦 OAuth 登录，在需准备 CLI 时显示下载量，完成后进入授权；更新 CLI 失败保留已有可用版本，无可用版本则明确报错。
5. 设置→ComfyUI→管理，先停止 ComfyUI。刷新插件目录显示字节；安装可信 Git 插件、刷新远端版本、更新内核/插件显示真实对象计数及阶段。插件仍默认停用，依赖仍需要原生确认；网络失败保留原来的可恢复行为。
6. 设置→插件→刷新市场、从仓库安装，观察实际下载量，失败时解除忙状态，原大小和来源限制仍有效。
7. 在含远程媒体 URL 的节点右键→另存为，选择目标后观察进度、取消及重试；已有本地文件、文本/data/asset 保存与覆盖行为回归。
8. 异常场景：慢网、断网、未知 Content-Length、连续取消后重试、关闭界面、下载结束但安装失败。未知总量不出现伪造百分比；成功/失败/取消均清理临时运行态。

可选定向命令（均由用户执行）：

- 仓库根目录：`npx vitest run tests/services/updateService.test.ts tests/services/pluginMarketplace.test.ts tests/services/fileServiceSaveAs.test.ts tests/services/fileServiceDownload.test.ts`
- `src-tauri/`：`cargo test --lib download_progress_tests`、`cargo test --lib file_transfer::tests`、`cargo check --lib`

自动化回归不代替真实桌面下载、更新安装与取消验收。

已补更新、插件市场与另存为的服务回归源码，以及 ComfyUI Git 进度解析的 Rust 回归源码；均未执行。完成了调用链、UTF-8 和差异空白的静态核对，尚无本次运行验证结论。

## 回滚

按上述入口回退本次进度展示、回调和取消修复即可；未修改数据库 schema、用户模型、项目媒体或安装目录。回滚时保留其他任务的模型/插件改动；不要整文件覆盖共享工作区。

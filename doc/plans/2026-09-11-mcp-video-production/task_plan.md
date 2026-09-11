# MCP 视频制作能力实施计划

## 已批准范围

用户确认补齐宣传片所需的剪辑时间轴、后期编辑、成片导出、媒体验片 MCP 能力，并修复当前 MCP 任务中止故障。只用 MCP 操作软件；不使用电脑控制，不新增依赖、不删除文件、不调整安全配置、不发布或打包。

任务类型：平台能力，附带明确故障修复。主模块为画布与项目；复用现有剪辑类型、仓储、合成/混音/抽帧及文件服务，不另建剪辑引擎。

## 阶段

1. implemented — 失败已细分为信号中止、任务缺失与终态；补充开发热更新的 Store 保留与 action 刷新，回归覆盖不触发 dispose 的模块重新求值。最终重新载入后，真实 MCP 工具描述与 app_get_state 调用成功，宣传片项目和工作流可读取；未另外进行反复热更新压力测试。
2. implemented — 已注册工程创建/列表/读取/原子编辑，支持主轨、文字、转场和音轨。
3. implemented — 已接入单任务后台合成、状态、取消及保存；含有界请求去重、项目/来源/完整工程版本防护。真实 3 秒截图视频已编码、保存并回填。
4. implemented — 已接入节点媒体探测、时间点抽帧与合成预览；真片开头、中间及末尾抽帧通过。文字/混音/取消已过回归，完整实机验收尚待继续。
5. implemented — 20 个测试文件、331 项定向回归通过；源码与测试类型检查通过；26 个本批文件的定向 lint（适用源码）、严格 UTF-8 与差异检查通过；重新载入后的真实 MCP 调用恢复。正式 ComfyUI 六镜及 24 秒成片转入创作制作阶段，尚未生成。

## 预计文件范围

- 执行诊断：`src/services/chat/agentRoundExecutor.ts`、实际根因对应执行/Store 文件及回归测试。
- 开发状态保留：`src/store/useAppStore.ts`、`src/store/store.hotReload.ts`、`tests/store/hotReload.test.ts`；`src/App.tsx` 仅补 MCP 初始化失败提示，保留其他任务的改动。
- 剪辑领域：`src/types/videoEditor.ts`、`src/types/videoEditorControl.ts`、`src/services/videoEditorService.ts`、`src/services/videoEditorControlService.ts`、`src/services/videoEditorExportService.ts`、`src/services/videoEditorInspectionService.ts`。
- 注册与并发：`src/services/chat/tools/videoEditorTools.ts`、`src/services/chat/tools/index.ts`、`src/services/mcp/mcpToolCatalog.ts`、必要的现有剪辑仓储校验。
- 对应 `tests/services/` 和工具测试；`doc/画布与项目模块.md` 与本计划记录。
- 共享图片解码预算抽到 `videoEditorRenderBitmap.ts`，原剪辑窗口与新 MCP 素材准备共用；对应更新既有内存防护测试。

## 验收与风险

工具按 effect 经过同一 Policy。只接受当前项目的节点/工程 ID，不接受任意媒体 URL、源码或路径；素材路径仍由既有宿主文件能力负责。编辑使用版本比较；打开的人工作业窗口不可被后台覆盖。媒体读写有界，长导出可取消，不重复提交，不让过期结果回写其他项目。失败明确返回状态而不伪装成功；动态 ComfyUI 凭证跨请求问题单列，不扩大本批权限。

导出以既有合成服务为权威，验收真实时长与尺寸；mock 测试不替代实际编码或付费 ComfyUI 生成验收。

## 交付接口

`video_editor_list/create/get/update` 管理工程；`video_editor_export/export_status/export_cancel` 管理后台导出；`video_media_probe/extract_frames` 检查成片；`video_editor_preview` 检查时间轴合成。均仅对当前项目的 MCP 会话开放，不增加普通对话的模型选择权限。

工程列表最多返回最近 50 项；单工程最多 8 轨、120 片段，抽帧每次最多 6 张 JPEG，每张最多 512 KiB。导出任务仅保留会话内最近 30 项，不承诺跨重启去重。素材读取或编码库的当前异步步骤返回后才能完成取消。视频探测返回时长、宽高、编码和可解码性；任务中的 frameRate 是导出设定，抽帧同时返回真实样本时间和持续时间，不宣称已经完整统计可变帧率片源。

## 回滚

仅撤销本批新增工具、领域服务和对应有界修改；项目媒体及既有工程不删除。无持久化 schema 升级，已有工程保持兼容。当前工作区存在其他任务的设置/存储改动，保持不动。

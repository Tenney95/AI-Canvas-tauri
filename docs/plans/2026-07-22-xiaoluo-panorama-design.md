# XiaoLuo Panorama 嵌入式集成设计

## 目标

使用 `Tenney95/XiaoLuo-Panorama` 替换 AI Canvas 全景节点内现有的 Three.js 查看器，同时保留节点上传、图片/全景切换、截图生成图片节点和项目文件持久化能力。节点内采用轻量交互，全屏模式提供完整的漫游与视觉矫正工具。

## 架构边界

上游仓库新增无宿主界面的 `PanoramaCore`。它只负责 Pannellum 实例生命周期、等距柱状图加载、拖拽缩放、视角参数、可选键盘漫游、截图和错误回调。核心组件使用元素引用创建实例，不使用固定 DOM id，不修改全局 Canvas API，也不假定代理下载端点、页面背景或全屏容器。

上游现有 `PanoramaViewer` 继续作为完整产品界面，并改为组合 `PanoramaCore`。包增加 `xiaoluo-vr-panorama/core` 子路径导出，使宿主只加载核心运行时代码，避免被完整界面的 `motion`、`lucide-react` 和 Tailwind 样式绑定。仓库补齐 Apache-2.0 许可证文件和嵌入式 API 文档。

AI Canvas 新增一层查看器适配组件，将上游 imperative API 转换为项目现有的截图接口。`PanoramaNode` 继续拥有节点状态、全屏状态、截图裁剪、文件保存和新节点创建逻辑；`FullscreenOverlay` 继续负责应用级全屏。节点内只显示可拖拽、可滚轮缩放的画面，全屏层显示漫游、视觉矫正、重置和截图控制。

## 数据流与错误处理

`imageUrl` 从节点数据传入适配层，再交给 `PanoramaCore`。核心默认直接交给 Pannellum 加载 `data:`、`blob:`、HTTP 和 Tauri asset URL，不自行请求任意代理。加载状态和错误通过回调返回宿主；节点模式显示紧凑状态，全屏模式显示可恢复的错误状态。组件卸载或 URL 变化时销毁 Pannellum 实例、动画帧、对象 URL和事件监听。

截图由核心返回当前 WebGL 画布的 PNG Data URL。AI Canvas 按既有比例裁剪流程保存到项目目录，并一次性创建图片节点和历史快照。完整查看器的下载行为保留在上游外壳，不进入核心 API。

## 验证

上游运行 TypeScript 检查和库构建，确认根入口与 `core` 子路径均生成声明及独立产物。AI Canvas 运行类型检查、定向 ESLint、相关测试、临时目录生产构建和 `git diff --check`。最后启动 Web 开发服务，分别验证多个全景节点、节点内拖拽缩放、全屏开关、漫游键盘作用域、截图创建节点以及桌面和窄视口布局。

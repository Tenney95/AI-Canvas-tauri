# GitHub 下载超时加速

目标：公开 GitHub 读取先直连，连接或读取超时、瞬时网络故障时最多经 gh-proxy.com 重试一次。共用策略在 `src/constants/githubDownload.json`，前端入口为 `githubDownloadService.ts`，原生入口为 `files/github_fallback.rs`。

## 范围与边界

- 导演台、通用文件下载、插件市场与包资源、ComfyUI 安装包及扩展目录共用回退规则；切源重置进度并从头读取。
- ComfyUI Git 仅重试 fetch。新扩展只初始化一次停用目录，保留官方 origin，获取默认 HEAD 后只 checkout 一次；失败保留现场，不执行 install.py 或自动安装依赖。
- 更新包命令只接受主窗口 updater 资源 ID。下载返回前由原更新器验签，成功后安装一次；校验、磁盘错误和安装失败不切源。Legacy 仍不提供自动更新。
- 不改道带凭据请求和其他站点。取消、超限、SHA-256 或签名校验失败不切源；原有路径、解压及窗口权限边界保留。

## 状态与验证

实现已完成。隔离源码副本执行 `cargo test github_fallback::tests --lib --locked`，3 项通过，覆盖切源次数、终止错误和完整响应读取；`cargo check --lib --locked` 通过。`npm run ci` 全量门禁通过，含 `githubDownloadService.test.ts`、`pluginMarketplace.test.ts`、`updateService.test.ts`、`fileServiceDownload.test.ts` 回归。未实际升级应用或下载 ComfyUI 大包，桌面网络切源与安装仍待用户验收。

已纳入 `v0.10.10`，同一发布提交的主分支 CI 与 Release 质量门禁均通过，多平台构建已启动；当前发布状态见[发版记录](./2026-10-18-release-0.10.10.md)。

桌面验收：阻断官方 GitHub 连接，下载导演台、打开插件市场、获取 ComfyUI 扩展目录，应仅切源一次且进度重新开始；中途取消不再切源。恢复直连后默认仍从官方源读取。校验失败、超限或目录不可写应停止；扩展获取失败保留停用目录，不能重复安装依赖。更新器验收使用测试发布包，在签名有效、无效以及两源都不可达时检查下载、安装阶段。

回滚：撤销本批代码和命令声明；不改写已发布标签，不清理用户文件或已有安装。

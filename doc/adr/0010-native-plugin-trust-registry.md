# ADR-0010：开放插件生态的原生信任注册表

## 状态

已接受。

## 背景

插件平台同时支持 QuickJS JavaScript 插件和可信 Python 本机插件。Python 轨道为了兼容本机解释器、标准库和 site-packages，明确拥有当前用户权限；本项目选择保留本地侧载、GitHub 仓库和后续第三方目录源，不把代码签名作为安装硬门槛。

原有执行命令由 Renderer 在每次调用时提交 `runtime`、完整 `source`、`toolId` 和输入。即使安装界面已经提示 Python 风险，Rust 仍无法证明实际执行的源码就是用户安装或更新时批准的源码；前端停用也没有形成原生执行边界。

P0 的目标不是缩小可信插件权限，而是建立以下不变量：

- 用户批准的精确源码与实际执行源码一致；
- 插件身份、活动版本、启停状态和工具归属由 Rust 持有；
- Renderer 在运行阶段不能替换源码或运行时；
- 更新可原子切换并保留上一批准版本；
- 停用、卸载或版本切换会阻止新调用并取消活动 Python 调用。

## 决策

### 1. 保留双轨开放模型

- JavaScript 继续运行在独立 QuickJS Runtime 中，只能使用声明的宿主能力。
- Python 继续作为“可信本机插件”，可访问本机文件、网络、环境变量、site-packages 和系统 API。
- Manifest 权限只描述宿主代办能力，不宣称限制 Python 的操作系统权限。
- 本地无签名插件可以安装；来源与代码摘要必须向用户可见。

### 2. Rust 私有注册表成为执行权威

注册表和入口源码快照存放在 `{appLocalData}/plugin-private/`。当前 Windows 应用标识下对应：

```text
C:\Users\30344\AppData\Local\com.aicanvas.app\plugin-private\
```

目录包含原子注册表和按 `pluginId/sourceDigest` 保存的不可变入口快照。该目录从 Tauri fs scope、asset protocol scope 和通用路径命令同时拒绝，Renderer 不能读取真实快照路径或内容。

每个原生 revision 保存：

- 插件 ID、版本、runtime 和 entry；
- 入口源码 SHA-256；
- Manifest 权限；
- 节点工具与自定义节点 ID；
- 暂存时间。

注册表只保留活动版本、上一版本和一个暂存版本。读取时校验 schema、数量、体积、字段、摘要和快照；执行前再次读取源码并计算 SHA-256。

### 3. 安装与更新采用 stage → persist → activate

1. 前端解析 Manifest，显示来源、完整源码 SHA-256、宿主权限和 Python 完整本机风险。
2. Rust 独立解析同一 revision。Python 在写入任何私有数据前必须通过原生 Warning 确认；提示绑定插件 ID、版本、完整摘要和权限，Renderer 布尔值不能替代。
3. `stage_plugin_revision` 在私有目录保存不可执行快照，返回 Rust 计算的摘要。
4. 前端比较用户看到的摘要与 Rust 摘要；不一致立即拒绝。
5. IndexedDB 保存安装记录和 `sourceDigest`。
6. 更新时先撤销旧前端版本租约；摘要变化还会清除旧 revision 的内存文件 grant。
7. `activate_plugin_revision` 原子切换活动版本；旧活动版本成为 `previous`。
8. 任一 post-stage 步骤失败时回切旧 active 或移除首次注册，同时丢弃未提交的 staged；IndexedDB 恢复旧记录。

更新切换摘要时会取消旧 Python invocation。前端同时把捕获摘要作为整次调用的版本租约，在每轮原生执行、宿主 effect 和最终写回前复核；native mutation 前会先撤销旧租约，避免原生提交到 IPC 返回之间的旧 QuickJS 窗口。旧版本结果不能写进新版本状态，旧版本文件授权也不会自动转交给新代码。

### 4. 执行接口只接受不透明身份

运行命令只接收：

```text
pluginId + sourceDigest + toolId + invocationId + input
```

Rust 必须依次确认：可信调用窗口、插件存在、已启用、摘要等于活动版本、工具属于该版本、源码快照摘要正确。runtime 和 source 只从私有注册表读取。

### 5. 停用、卸载和进程取消

- 停用与卸载在调用原生 mutation 前先撤销前端版本租约并清除内存文件 grant；画布节点数据不删除。
- 原生停用先提交 `enabled=false`，再在同一注册表线性化区间取消活动 Python invocation；卸载提交、取消和私有快照删除也在同一锁区间。
- Python 暂存和重新启用都要经过原生高风险确认；回切 `previous` 会改变真实代码，同样必须确认。
- Windows Python 子进程在收到源码前加入带 `KILL_ON_JOB_CLOSE` 的 Job Object；macOS/Linux 使用独立进程组。正常结束、停用、卸载、更新、取消或超时都会清理后代。
- 解释器探测、正文执行和 stdout/stderr 回收共享有界 deadline；后代继承管道或探测异常不能让宿主永久等待。

### 6. 旧记录迁移失败关闭

- 没有 `sourceDigest` 的旧记录在首次加载时进行一次 stage/activate，并补存摘要。
- 已有摘要的记录只调用 `ensure_plugin_registration`，不得再次把 IndexedDB 源码提交给 Rust。
- 私有注册缺失、摘要不匹配或快照损坏时自动停用该插件，不回退到 Renderer 传源码执行。

## 原子性与恢复

- 注册表写入前重新执行完整结构校验和 2 MiB 上限检查。
- 更新使用 `registry.json.tmp → registry.json`，旧主文件暂存为 `registry.json.bak`。
- 主文件缺失或损坏时，只恢复通过完整校验的 backup；未提交的 tmp 不会被提升。
- stage 超过 512 个插件或其他注册表上限时，写入失败并清理本次新快照，旧注册表保持可读。
- 激活只在注册表提交成功后清理被淘汰快照。
- 原生确认窗口不持有注册表锁；确认后重新加锁并比较完整 registration、候选角色、摘要和 revision，状态变化时要求重新确认。
- 重新启用按目标 `sourceDigest` 调用 activate，可恢复“IndexedDB 已保存新版本、原生尚未激活”的中断状态。

## 影响

### 正向

- 开放的 Python 权限与精确代码身份可以同时成立。
- Renderer 无法在普通执行调用中临时替换 Python/JavaScript 源码。
- 更新、停用和卸载获得原生失败关闭语义。
- 不新增 npm/cargo 依赖，不修改 Tauri 安全配置或 IndexedDB object store。

### 负向

- 应用私有目录会额外保存当前、上一和暂存入口源码，产生少量磁盘占用。
- 私有注册表被用户手动删除后，已有摘要插件会停用并要求重新安装，不会从 IndexedDB 静默恢复。
- P0 revision key 仍是入口源码 SHA-256；只修改 Manifest 而入口源码字节完全不变时会失败关闭。后续需引入同时覆盖规范化 Manifest 安全字段的 revision/approval digest。
- 可信 Python 可主动脱离宿主创建的 Job/进程组；它本来就拥有当前用户完整权限，P0 不把进程托管宣称为 OS 沙箱。

## 回滚

- 旧 IndexedDB 安装记录继续保留完整 `source`，旧应用版本可忽略新增的可选 `sourceDigest`。
- 回滚代码时 `plugin-private` 可留在磁盘供新版恢复使用；旧版本不会读取它。
- 更新失败可把 active 切回 previous，不需要重新下载源码。
- 回滚不自动删除插件、画布节点或用户原始侧载目录。

## 后续阶段

P0 完成后，JavaScript 可以通过宿主 broker 按 Manifest 申请更开放的能力，例如公共 HTTPS、单独的局域网权限、插件私有存储、项目相对路径和用户授权目录。任意 Shell/本机 Python 继续归入明确的可信本机等级。

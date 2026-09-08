# 导演台与 Blender

负责 `ai-director` 的轻量网页与 Blender 双运行时、3D 镜头场景、原生任务和结果回填。阶段状态统一维护在[Blender 原生运行时计划](./plans/2026-08-28-director-blender-native-runtime.md)。

## 主要入口

| 入口 | 职责 |
|---|---|
| [directorNodeOperationService.ts](../src/services/directorNodeOperationService.ts) | 同一节点的导演操作编排 |
| [directorSceneService.ts](../src/services/directorSceneService.ts) / [directorSceneSchema.ts](../src/services/directorSceneSchema.ts) | Scene/Result 数据读写与合同校验 |
| [directorBlenderRuntimeService.ts](../src/services/directorBlenderRuntimeService.ts) | Blender 安装识别、原生任务和结果收集 |
| [directorDeskRuntimeService.ts](../src/services/directorDeskRuntimeService.ts) / [原生 director](../src-tauri/src/director/) | 轻量运行资源与原生执行边界 |

## 关键边界

- 轻量网页和 Blender 共用导演节点契约，各自维护运行时，不能把两套场景状态互相冒充。
- Blender 固定包 1.4.0 的 Windows x86_64 版本策略接受 4.5.x、5.0.x、5.1.x、5.2.x 稳定系列，不锁补丁号；预发行版和未纳入的系列不自动放行。跨版本的真实桌面验收状态见专项计划，不能把版本放行等同于全部功能已实测。
- EEVEE 标识、材质/世界节点初始化和图像/视频设置按 API 差异适配；保存工程保留时间线和 Cycles 选择。前端只映射已绑定 Job 的固定失败码，区分版本、渲染能力、启动、崩溃、超时和成果错误，不展示原生诊断正文。
- Renderer 只提交固定 operation 和已验证场景引用，不提交任意可执行文件、脚本、argv、环境变量或输出路径。
- Blender 进程退出不等于结果成功；先验证文件集合、摘要和 Result Manifest，再检查项目、节点实例、Scene revision 与派生结果守卫后回填。
- 真实 Blender 预览、保存返回、故障注入和界面验收分别记录；历史“预览已接通”不能替代阶段完成标准。

## 验证与资料

- 定向回归：[Scene 服务](../tests/services/directorSceneService.test.ts)、[Blender 运行时](../tests/services/directorBlenderRuntimeService.test.ts)、[节点操作](../tests/services/directorNodeOperationService.test.ts)；原生测试按专项计划选择。
- 架构决策：[双运行时与场景权威](./adr/0010-director-dual-runtime-and-blender-scene-authority.md)、[轻量运行资源](./adr/0003-director-desk-prebuilt-runtime.md)。
- 历史：[前端契约](./history/2026-09-07-跨模块实施记录归档.md#director-contract)、[协议冻结](./history/2026-09-07-跨模块实施记录归档.md#director-protocol)、[原生预览](./history/2026-09-07-跨模块实施记录归档.md#director-preview)、[新手界面](./history/2026-09-07-跨模块实施记录归档.md#director-ui)、[双 MCP](./history/2026-09-07-跨模块实施记录归档.md#director-mcp)、[保存工程模式](./history/2026-09-07-跨模块实施记录归档.md#director-saved-scene)。

返回[文档导航](./文档导航.md)。

# 生成特效源码来源

这些目录是应用内置的第三方源码。画布与 UI Kit 引用同一份实现，不再依赖 `thinking-orbs`、`border-beam`、`metal-fx` npm 包。只迁入这三个特效及金属效果需要的着色器，不包含上游站点、宣传素材、Studio 或其他特效。

| 目录 | 版本与上游提交 | 许可证 |
| --- | --- | --- |
| `thinking-orbs/src` | [thinking-orbs 0.3.1](https://github.com/Jakubantalik/thinking-orbs/tree/bd204b73c9b6660fad7210b1ad48d9dc2adbb89d/src)，`bd204b73c9b6660fad7210b1ad48d9dc2adbb89d` | 目录内 `LICENSE`，MIT |
| `border-beam/src` | [border-beam 1.3.0](https://github.com/Jakubantalik/Libraries.dev/tree/50ebc2405fca40d0b907ec4c721a3cf4b1f96e25/src)，`50ebc2405fca40d0b907ec4c721a3cf4b1f96e25` | 目录内 `LICENSE`，MIT |
| `metal-fx/src` | [metal-fx 2.0.10](https://github.com/Jakubantalik/Libraries.dev/tree/99f8bf5b6ae19bf9663e694d586ad09fb26a3d26/packages/metal-fx/src)，`99f8bf5b6ae19bf9663e694d586ad09fb26a3d26` | 目录内 `LICENSE`，MIT；保留 `NOTICE` |
| `paper-shaders` | [Paper Shaders 0.0.80](https://github.com/paper-design/shaders/tree/60467401863c1917dd02016d0c1ff2f791d0b3c8/packages/shaders/src)，`60467401863c1917dd02016d0c1ff2f791d0b3c8` | 目录内 `LICENSE`，Apache-2.0 |

版本提交根据原安装版本的 npm `gitHead` 核对。Border Beam 和 Metal 的上游现已迁入 `Libraries.dev` 合集仓库。

## 本地适配

- 保留三个库的 TS/TSX 源码、内部目录和版权声明；不迁入预编译产物。
- Paper 只保留 `liquid-metal.ts` 的片元着色器与 `shader-utils.ts` 中使用的四段 GLSL 常量；顶点着色器沿用 Metal 内置版本。删除未使用的图像预处理与类型依赖，Metal 改为本地导入。两段最终着色器与原 metal-fx 2.0.10 包逐字节一致。
- 清理未使用的内部声明，保留有意占位的参数；没有更改思考球的几何算法。
- `BorderBeam` 增加可选 `paused`，复用上游暂停样式并停止呼吸驱动；不改变 `active` 的激活/淡出语义。
- `MetalText` / `MetalBadge` 透传配色、暂停参数；徽标也支持关闭光晕。
- Metal 的上下文事件绑定当前 GL 画布，忽略旧画布迟到的丢失/恢复事件。画布按钮继续使用 `PolishMetalFx` 的既有 StrictMode 生命周期保护。
- 思考球的轨道与缎带计算复用同角度的 `sin` / `cos`，不改变运算顺序、粒子数、帧率或绘制顺序。64px 单帧三角函数调用量：working 从 3196 降至 1132，composing 从 4310 降至 2198，breathing 从 3881 降至 1945；这是调用量，不是整机 CPU 降幅。
- Metal 关闭光晕时从更新队列移除实例，保留光晕句柄和金属边框；重新开启时复用原状态。本地版本去掉了未接入的系统指针贴图替换，光标光照保留光斑和跟随高光。两种效果都未开启时不会启动鼠标动画循环。离开光照范围后已有光效会淡出，页面隐藏时停止回调。
- 上游组件保留原有命令式绘制、样式和生命周期。ESLint 仅在此目录豁免四项 React 生命周期/热更新规则，接入组件仍运行完整检查，源码继续参与 TypeScript 与其余 lint 检查。

## 维护与验证

UI Kit 入口是「关于 → 连点 logo 4 次 → 生成特效」，展示边框流转/呼吸、九种思考状态、两种思考球尺寸，以及金属圆形按钮、文字、胶囊按钮与徽标。参数只作用于预览窗口；支持明暗主题、暂停、离屏卸载、页面隐藏及系统减少动态效果。金属效果需要 WebGL2，不支持时保留普通内容。

邻近反射沿用上游的暗色主题行为。`reflectionTargets` 应指向承载背景、边框和圆角的容器；输入框复用 `ui-input-group`，内部输入框保持透明。不要直接绑定 `input` / `textarea` 等不能容纳绘制层的元素，上游会跳过这些目标。UI Kit 的 JSX 示例包含对应容器与引用接法。

自动回归入口：`tests/components/generationEffects.test.tsx`。帧数据和着色器摘要取自迁移前的原安装包，另覆盖计算调用量、光晕开关、鼠标空闲与隐藏停机、边框静态暂停、上下文事件隔离、源码独立打包。涉及渲染行为的后续修改仍需在 Tauri 桌面端检查明暗主题、生成中状态、关闭/重开和后台恢复。

升级时先核对版本、提交和许可证，比较本地适配，再运行上述回归、类型检查及 lint。不要直接用上游主分支覆盖这些目录；回滚时恢复原三个依赖版本及接入引用。

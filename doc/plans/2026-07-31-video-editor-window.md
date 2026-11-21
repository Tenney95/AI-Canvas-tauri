# 内置视频编辑器 Implementation Plan

**Goal:** 视频节点右键「编辑视频」在独立窗口打开内置剪辑模块，工程数据持久化，导出结果在画布上新建节点。

**Architecture:** 复用 `index.html?view=` 单入口多窗口路由（同 `assets` / `chat`），编辑器与主窗口同源、共享 IndexedDB，因此工程由主窗口开窗前写入、编辑器按 ID 取回，不需要额外素材交接通道；仅导出结果经 Tauri 事件回传。媒体能力由 mediabunny (MPL-2.0) 提供，预览用 WebView 原生 `<video>`。

**Tech Stack:** Tauri 2、React 19、TypeScript 6、Vite 8、IndexedDB v18、mediabunny 1.52、Vitest 4。

---

## 选型结论

| 方案 | 结论 |
| --- | --- |
| **mediabunny** (MPL-2.0) | **采用**。纯 TS + WebCodecs、零依赖、完整源码公开，可 fork 自救。 |
| `@diffusionstudio/core` | 否决。GitHub 仓库只有 playground，引擎以 468KB 打包产物发 npm、源码从未公开，且自 2025-11-30 停更。官网那套 UI 属闭源的 Diffusion Studio Pro。 |
| Remotion / designcombo | 否决。>3 人公司需付费商业许可。 |
| etro-js | 否决。GPL-3.0，污染本项目许可。 |
| ffmpeg.wasm | 否决。性能远逊 WebCodecs，且 LGPL/GPL + SharedArrayBuffer 门槛。 |

mediabunny 不用 wasm、不用 SharedArrayBuffer，因此**不需要** COOP/COEP 响应头，`tauri.conf.json` 的 `csp: null` 无需改动。

---

## 一期范围（已完成）

打通链路 + 单轨裁剪。

**Files:**
- Create: `src/types/videoEditor.ts`
- Create: `src/services/indexedDb/videoEditorRepository.ts`
- Create: `src/services/videoEditorMediaService.ts`
- Create: `src/services/videoEditorWindowService.ts`
- Create: `src/services/videoEditorService.ts`
- Create: `src/components/videoEditor/VideoEditorWindow.tsx`
- Create: `src/components/videoEditor/VideoEditorPreview.tsx`
- Create: `src/components/videoEditor/VideoEditorTimeline.tsx`
- Create: `src/components/videoEditor/VideoEditorMediaPanel.tsx`
- Create: `src/components/videoEditor/VideoEditorInspector.tsx`
- Create: `src/styles/video-editor.css`
- Modify: `src/services/indexedDb/schema.ts`（DB_VERSION 17 → 18，新增 `videoEditorProjects`）
- Modify: `src/RootView.tsx`、`src/index.css`
- Modify: `src/hooks/useNodeContextMenu.ts`、`src/components/canvas/NodeContextMenu.tsx`、`src/components/Canvas.tsx`
- Modify: `src/components/nodes/VideoNode.tsx`（订阅导出结果并新建节点）
- Modify: `src-tauri/capabilities/default.json`（窗口列表加 `video-editor`）

### 关键设计

**工程持久化**：IndexedDB 独立表 `videoEditorProjects`，主键 `{projectId}::{nodeId}`，按 `projectId_updatedAt` 与 `nodeId` 建索引。轨道/片段结构按多轨设计，二期加轨不需要迁移。记录带 `schemaVersion`，读到更高版本按「无工程」处理而非按缺字段渲染。

**关键帧对齐的裁剪使用无损直通**。已编码的分组原样写入新容器，入点平移到零点。同一素材在时间轴上连续分割时，导出合并读取连续的源区间，时间轴仍保留各个片段。

> ⚠️ 不能用 `Conversion` 的 `trim` 达成这一点。它的判据是
> `needsTranscode = ... || firstTimestamp < startTimestamp`，
> 即**只要入点不等于轨道起点就强制重编码**（为了帧级精确的头部裁切）。
> 仅裁尾时才会走直通复制。

若合并后的任一源区间入点未对齐关键帧，或 MP4 容器无法保留源编码，编辑器会切换到合成导出并提示原因，保持时间轴的裁切位置。

**输入走 Range 而非整体加载**：`CustomSource` + HTTP Range 读 `asset://`，避免把整个视频读进内存；服务端不支持 Range 时回退 `BlobSource`。

**预览用原生 `<video>`**：吃系统解码器，比逐帧驱动 canvas 稳；缩略图与导出才交给 mediabunny。

**能力边界**：编辑器是本仓库自己的代码，并入 `default` 能力（同 `asset-search`），而非像导演台那样单开最小权限文件——那是因为导演台加载的是外部下载的运行时。

---

## 一期增补：多素材与分割（已完成）

**多选打开**：右键落在已有多选内时保留整个选择（原先 `openMenu` 无条件塌成单节点），
把选中的视频与图片按选择顺序铺成一条视频轨。工程锚定在第一个节点上，
导出结果也回写到它。至少需要一个视频节点。

> 多选右键最初打不开节点菜单：菜单不走 React Flow 的 `onNodeContextMenu`，
> 而是 `useCanvasSecondaryClickMenu` 用 `elementFromPoint` 判断落点。
> 多选时 React Flow 会在节点上盖一层选择框，`elementFromPoint` 只返回那层，
> 于是直接掉进画布菜单分支。修法是在退回画布菜单前，先对已选中节点做几何命中测试。

**刻度尺**：`VideoEditorRuler` 按时长选「整数感」步长（候选 0.1s–10min，目标约 8 条主刻度），
主刻度带时间标签、副刻度为其五分之一；尺子上按下即可拖动播放头手柄。
步长与标签计算拆在 `rulerTicks.ts` 以便单测。

> 多选打开后只出现一个片段：锚点节点若已有旧工程（例如之前单独打开过），
> 原实现「已有工程直接复用」会把这次新选中的素材整个忽略。
> 修法是把选择里多出来的节点**追加**进时间轴（而非重建），既尊重这次的选择，
> 又保住已有的裁剪与分割结果；选择是已有集合的子集时则原样复用。

**分割**：`splitClipsAt` 在播放头处把片段一分为二（快捷键 `S`），
`relayoutSequential` 负责任何增删后把时间轴压实。选中片段可删除（`Delete`）。

**多片段导出**：`exportLosslessConcat` 把各片段的已编码分组按序写进同一个容器。
直通复制要求所有片段共用同一套解码参数，因此**编码或分辨率不一致时明确报错**，
而不是产出一个播不动的文件。

## 一期增补：时间轴编辑能力（已完成）

对齐 PR / 剪映的**编辑手感**，范围锁在与无损导出兼容的能力上。

| 能力 | 说明 |
| --- | --- |
| 缩放与横向滚动 | `Ctrl/⌘ + 滚轮`以光标处时间为锚点缩放；缩放条、±按钮、「适应窗口」。刻度按像素密度自动细分（主刻度恒定 ≥72px 间距） |
| 拖拽换序 | 拖动片段即换序，落点按各片段中点判定；磁吸重排不留空隙 |
| 边界吸附 | 播放头与裁剪手柄吸附到片段边界和播放头，容差按像素折算，缩放后手感一致；可开关 |
| 多选 | `Shift/⌘ + 点击`加减选，`Ctrl+A` 全选，`Esc` 清空 |
| 撤销重做 | 轨道快照栈（上限 50），`Ctrl+Z` / `Ctrl+Shift+Z` / `Ctrl+Y`；连续拖拽只在按下时落一次快照 |
| 片段右键菜单 | 分割 / 复制 / 删除 |
| 轨道头 | 静音、锁定（锁定轨道不响应拖拽与裁剪） |
| 快捷键 | `S` 分割、`Del` 删除、`Ctrl+D` 复制、`←/→` 逐帧（`Shift` 加速）、`Home/End` 跳首尾 |

布局改为「左侧固定轨道头 + 右侧横向滚动画布」，刻度尺与轨道共用同一坐标系。
纯操作逻辑集中在 `timelineOps.ts`，历史栈在 `useTimelineHistory.ts`，均有单测覆盖。

### 更正：编码器并非不可用

先前记为「目标机器 `VideoEncoder` 不可用」——**这个结论下早了**，是从一次失败的
探测过度外推。核实后的事实链：

1. **与 Tauri 权限无关。** capability 只管 Tauri 命令（fs/dialog/event/shell），
   WebCodecs 是 WebView 的 Web 平台 API，capability 碰不到它。
   反证：解码正常（缩略图能出），说明 WebCodecs 本身是通的。
2. **真正的触发点**是 mediabunny 的候选配置。`buildVideoEncoderConfigs` 会把
   `bitrateMode: 'quantizer'` 的候选排在第一个试，而 `'quantizer'` 是 WebCodecs
   后加的枚举值，WebKit 不认识 —— 按 WebIDL 规则，字典里出现非法枚举值直接抛
   TypeError（即 `TypeError: Type error`）。mediabunny 没接这个异常，
   于是整条导出崩掉，**而它后面还有一个普通 bitrate 候选本可以用**。

**修复**：`guardEncoderProbe()` 把 `isConfigSupported` 的异常转成
`{supported:false}`，让 mediabunny 继续试下一个候选，而不是判定本机不能编码。

**验证**：新增 `videoCodecProbe.ts` + 检查器里的「编码能力自检」面板，
对 H.264 720p/1080p/4K、HEVC、VP9、AV1 逐个实测 —— 不只问 `isConfigSupported`，
还真的 `configure()` 并编一帧，因为前者在部分 WebView 上并不可信。
结果可一键复制。

若自检显示编码可用，则转场、合成、音轨重编码这些路线都重新成立，
「必须下沉到 Rust ffmpeg」的前提也随之改变。

## 一期增补：合成渲染通路（已完成）

多轨叠加、音频编辑、转场三件事共用同一个前提 —— **一条能合成并重编码的渲染通路**。
先建通路，再在上面挂能力。

### 双导出路径

`needsCompositing(tracks)` 决定走哪条：

- **无损直通**（默认）：单视频轨、无变换、无转场、无图片，且各连续源区间入点对齐关键帧时，搬运已编码分组。
- **合成重编码**：有叠加轨、变换、转场或图片，或者直通预检无法保留裁切位置与源音轨时，逐帧渲染并编码。

这样「加了一个画中画就整条时间轴掉画质」不会悄悄发生，检查器里也明示当前走的是哪条。

### 新增模块

| 模块 | 职责 |
| --- | --- |
| `videoCompositor.ts` | `renderFrameAt` 把某时刻所有可见轨道画到画布；`computeDrawRect` 按 contain + 变换求绘制矩形。预览与导出共用，所见即所得 |
| `videoAudioMixer.ts` | `mixTimelineAudio` 按时间轴位置与音量包络叠加多轨音频，逐样本求增益（淡入淡出连续而非阶梯）；`extractWaveform` 出峰值包络 |
| `exportComposite` | 逐帧 `CanvasSource.add` + `AudioBufferSource`，进度分「混音 20% / 画面 70% / 写音频 10%」三段 |

混流在普通 Float32 缓冲上手工完成，不用 `OfflineAudioContext`（它在 WebView 里
对超长音频容易顶到限制），并在末尾做峰值限幅，避免多轨叠加削顶爆音。

### 能力

- **多轨叠加**：可新增叠加轨；数组顺序即自下而上的图层顺序，主轨固定最底层
- **画中画 / 贴纸**：每个片段有位置、缩放、旋转、不透明度，检查器里实时可调
- **转场**：与前一段之间可选硬切 / 交叠淡入 / 黑场淡入，时长可调
- **音频轨**：独立音频轨、片段增益、音量包络（分段线性插值）、波形显示
- **轨道控制**：静音、锁定、隐藏、调层、删除（主轨不可删）

### 实测确认的本机能力（2026-07-31，macOS WKWebView）

导出栈跟到 `AudioBufferSource.add` 才失败，说明**画面已全部编码完成** ——
`VideoEncoder` 可用，此前「编码器不可用」的判断彻底证伪。

真正缺的是 **`AudioEncoder`**：WebKit 至今未实现它（有 `VideoEncoder`、
`VideoDecoder`、`AudioDecoder`，唯独没有音频编码器）。

因此合成导出的音频分三种模式，由 `resolveCompositeAudioMode()` 选择：

| 模式 | 条件 | 效果 |
| --- | --- | --- |
| `encode` | 有 `AudioEncoder` | 混流为 AAC，体积小、能力全 |
| `copy` | 无编码器，且无需混音（不改音量、片段不重叠、参数一致） | 原样搬运 AAC 分组，无损且体积小 |
| `pcm` | 无编码器但需要混音 | 混流为未压缩 PCM 音轨 |
| `none` | 时间轴确实没有音频 | 只出画面 |

**缺少 `AudioEncoder` 并不意味着必须丢音频。** mediabunny 对 PCM 走自带的
软件编码器（`initPcmEncoder`），完全不碰 WebCodecs；MP4 也能容纳 `pcm-s16`
（ISO/IEC 23003-5）。因此混流、音量包络、重叠音频在无编码器的机器上照常可用，
代价只是音轨不压缩（48kHz 立体声约 1.5 Mbps）。

早先把这些情况判为 `none`（直接丢音频）是过度保守 —— 只查了 `AudioEncoder`
这一条路，没注意到 PCM 分支。

### 导出结果落到新节点

导出不覆盖源素材，而是在源节点右侧新建一个视频节点承载结果 ——
剪辑是破坏性操作，覆盖原节点会让原始素材在画布上无从找回。
沿用 `registerCanvasDerivation` 守卫：导出是跨窗口的异步结果，
期间可能已切换项目或删掉源节点，守卫挡掉过期回写避免落到别的画布上。

### 音轨保留（三条导出路径都已覆盖）

原先只有单片段直通保留音轨，多片段拼接和合成路径都会丢音频。现已补齐：

| 路径 | 音频处理 |
| --- | --- |
| 单片段直通 | 搬运原始分组 |
| 多片段拼接 | 各段解码参数一致时逐段搬运分组，与画面共用同一 `segmentBase` 保证拼接点对齐 |
| 合成重编码 | `encode` / `copy` / `none` 三档，见下 |

导出结果返回 `audioKept` 与 `audioDropReason`，界面据此如实说明音轨去向，
而不是让用户自己发现没声音。

### 已知限制

- **图片片段无法导出**：静态图转视频帧必须重编码，而目标机器的 `VideoEncoder` 不可用。
  导出前会明确拦截并说明原因，不会走到一半才失败。
- 片段只能首尾相接，不支持留空或重排。

## 二期（未开始）

- 多视频轨 / 音频轨 / 字幕轨，片段拖拽换序与留空
- 多片段拼接保留音轨
- 时间轴撤销重做（复用主画布的历史快照语义）
- 右侧检查器的 Transform / Appearance / Effects / Transition 分组转为可编辑
- 从项目资产面板拖入素材
- 电平表与音频波形

## 三期（未开始）

- 转场与关键帧
- 需要重编码的能力（变速、缩放、合成），届时评估是否引入 Rust 侧 `ffmpeg-sidecar` 兜底

---

## 真机实测发现（2026-07-31）

以 4K 素材（3840×2160、16.4s）实测，加载与预览正常，**导出报 `Type error`**。

**定位**：`Type error` 是 WebKit 里 `fetch()` 失败的标志性 message，不是普通 JS 类型错误。加载阶段只有零星小读取所以不暴露；导出时 `Conversion` 并发发起大量分片请求，WKWebView 的 `asset://` 处理器在这种压力下让 `fetch` 直接失败。

**修复**：`createResilientReader` 给分片读取加自愈——失败先退避 50ms 重试一次，仍失败则整份下载一次转为内存切片，此后所有读取不再依赖 `asset://` 的并发表现。

**同时修掉的一个隐性 bug**：编辑器窗口有自己的模块实例，此前没调用 `registerProjectFolders`，`resolveProjectFolder` 会退化成拿 `projectId` 当目录名，导出文件会落进错误目录。资源搜索窗口本来就有这步注册，编辑器漏了。

**可观测性**：独立窗口开不了 devtools，因此错误改为按阶段标注（打开素材 / 裁剪导出 / 写入项目目录 / 回写节点），并在界面上直出 `name: message` + 可展开调用栈 + 一键复制。原先只显示 `error.message`，对 WebKit 的 `Type error` 等于没有信息。

### 第二轮：导出仍报 Type error，栈指向 `VideoEncoder.isConfigSupported`

拿到调用栈后定位到**设计判断错误**（而非环境问题）：

```js
// mediabunny/src/conversion.js
const needsTranscode = !!trackOptions.forceTranscode
    || firstTimestamp < this._startTimestamp   // ← 命中这条
```

入点一旦不为 0，`Conversion` 必然重编码；随后 `getFirstEncodableVideoCodec` →
`VideoEncoder.isConfigSupported` 在 WKWebView 上对 4K 配置直接抛 TypeError。

**原判断「裁剪不经过编码器」只对单纯裁尾成立**，裁头不成立，需更正。

**修复**：新增 `exportLosslessTrim`，绕开 `Conversion` 走低层分组搬运
（`EncodedPacketSink` → `EncodedVideoPacketSource`），彻底不依赖编码器；
`Conversion` 降级为源编码进不了 MP4 时的回退路径，并把 `isConfigSupported`
的 TypeError 翻译成可读提示。

## 仍需真机验证

1. 上述修复后 4K 素材能否完整导出（整份下载回退对 4K 长素材的内存占用需观察）。
2. Windows (WebView2) 上 `asset://` 是否有同样的并发分片问题。
3. macOS 与 Windows 上 `VideoDecoder` 对 H.264 / HEVC 的解码覆盖 —— 决定缩略图是否可用（不影响直通裁剪导出）。

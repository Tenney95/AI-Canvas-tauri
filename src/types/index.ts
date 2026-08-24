/**
 * types 全局类型定义 — 定义 NodeType、BaseNodeData、CanvasProject、AppConfig、ModelOption、WorkflowDefinition 等核心类型
 */
import type { AudioOutputFormat, AudioTtsVoice, ModelExecutionProfile, VideoModelCapability, VideoReferenceItem } from './aiTypes';
import type { AudioGenerationPurpose } from './media';
import type { ImageAnnotationLayer } from '@tenney95/xiaoluo-image-editor';
import type { CanvasNoteData } from './canvasNote';
import type { ShotlistColumnKey, ShotRow } from './shotlist';
import type { Locale } from '../i18n';

export type {
  CanvasDrawingTool,
  CanvasNoteArrowhead,
  CanvasNoteCrop,
  CanvasNoteData,
  CanvasNoteFontFamily,
  CanvasNoteFontSize,
  CanvasNoteKind,
  CanvasNoteLayerDirection,
  CanvasNoteLineType,
  CanvasNotePatch,
  CanvasNotePoint,
  CanvasNoteRoughness,
  CanvasNoteRoundness,
  CanvasNoteStrokeStyle,
  CanvasNoteStrokeWidth,
  CanvasNoteStyle,
  CanvasNoteTextAlign,
} from './canvasNote';
export { createCanvasNoteData, DEFAULT_CANVAS_NOTE_STYLE, isCanvasNoteKind } from './canvasNote';

export type { ShotFrameBinding, ShotFrameCandidate, ShotlistColumnKey, ShotRow } from './shotlist';
export {
  buildShotFramePrompt,
  buildShotPlaceholderText,
  collectShotFrameCandidates,
  formatShotRowBrief,
  computeShotlistDuration,
  createShotRow,
  DEFAULT_SHOT_DURATION,
  isShotRowBlank,
  isShotRowTextOnly,
  readShotFrameSource,
  resolveShotDuration,
  resolveShotTransitionKind,
  SHOT_CAMERA_OPTIONS,
  SHOT_SIZE_OPTIONS,
  SHOT_TRANSITION_OPTIONS,
  SHOTLIST_COLUMN_LABELS,
  SHOTLIST_COLUMN_ORDER,
  SHOTLIST_DEFAULT_COLUMNS,
  SHOTLIST_FRAME_SOURCE_TYPES,
  SHOTLIST_OPTIONAL_COLUMNS,
  SHOTLIST_PINNED_COLUMNS,
  SHOTLIST_TRANSITION_DURATION,
} from './shotlist';

export type {
  AnnotationPoint,
  ArrowImageAnnotation,
  BaseImageAnnotation,
  BrushImageAnnotation,
  ImageAnnotation,
  ImageAnnotationLayer,
  ImageAnnotationTool,
  ImageAnnotationType,
  MarkerImageAnnotation,
  RectangleImageAnnotation,
  TextImageAnnotation,
} from '@tenney95/xiaoluo-image-editor';

// 节点类型定义
export type NodeType =
  | 'ai-text'
  | 'ai-image'
  | 'ai-video'
  | 'ai-audio'
  | 'ai-animation'
  | 'ai-panorama'
  | 'ai-markdown'
  | 'ai-storyboard'
  | 'ai-shotlist'
  | 'ai-director'
  | 'source-image'
  | 'source-video'
  | 'source-audio'
  | 'source-text'
  | 'plugin-node'
  | 'canvas-note'
  | 'comment';

// 内置图像预设可请求的生成后处理流程
export type ImagePostProcess = 'character-8-direction-grid';

export type AnimationAction = 'idle' | 'walk' | 'run' | 'jump' | 'attack' | 'hit';
export type AnimationPreviewMode = 'playing' | 'sheet';
export type CameraLens = '15mm' | '24mm' | '35mm' | '50mm' | '85mm' | '200mm' | 'macro' | 'fisheye';
export type CameraShutterEffect = 'freeze' | 'natural' | 'motion' | 'light-trails';
export type CameraAperture = 'f/1.4' | 'f/2' | 'f/2.8' | 'f/4' | 'f/5.6' | 'f/8' | 'f/11' | 'f/16';
export type CameraExposureTime = '1/2000s' | '1/1000s' | '1/500s' | '1/250s' | '1/125s' | '1/60s' | '1/30s' | '1/8s' | '1/2s' | '1s' | '5s';

export interface CameraGenerationSettings {
  lens?: CameraLens;
  shutterEffect?: CameraShutterEffect;
  aperture?: CameraAperture;
  exposureTime?: CameraExposureTime;
}

export const ANIMATION_ACTION_LABELS: Record<AnimationAction, string> = {
  idle: '待机',
  walk: '行走',
  run: '奔跑',
  jump: '跳跃',
  attack: '攻击',
  hit: '受击',
};

export const ANIMATION_FRAME_GRIDS: Record<6 | 8 | 10 | 12 | 16 | 20, { cols: number; rows: number }> = {
  6: { cols: 3, rows: 2 },
  8: { cols: 4, rows: 2 },
  10: { cols: 5, rows: 2 },
  12: { cols: 4, rows: 3 },
  16: { cols: 4, rows: 4 },
  20: { cols: 5, rows: 4 },
};

/** 可以拖进宫格空格的节点类型（角色库参考图落在画布上是 source-image） */
export const STORYBOARD_CELL_SOURCE_TYPES = ['ai-image', 'source-image'];

// 宫格分镜：被拖入某格的图片覆盖
export interface StoryboardCellOverride {
  url: string;         // 展示用 asset/data URL
  filePath?: string;   // 本地文件路径（复用被拖入节点的落盘文件）
  assetId?: string;    // 稳定资产身份，不随文件移动或重命名变化
  relativePath?: string; // 项目目录内的相对路径（持久化优先）
}

export interface CharacterLibraryNodeLink {
  scope: 'project' | 'global';
  characterId: string;
  referenceImageId: string;
}

// 节点数据接口
export interface BaseNodeData {
  label: string;
  type: NodeType;
  displayId?: number;         // 节点展示编号（#10, #11, ...）
  role?: 'generator' | 'source'; // 节点角色：生成器（有AI对话框） vs 源节点（上传/粘贴内容）
  fileName?: string;           // 上传的文件名（源节点使用）
  prompt?: string;           // 提示词
  output?: string;            // 输出结果（文本/URL等）
  status?: 'idle' | 'loading' | 'success' | 'error';
  model?: string;             // 选择的模型 ID（如 qwen/qwen3.5-397b-a17b）
  provider?: string;          // 选择的供应商 ID（如 apimart）
  workflowId?: string;        // 选择的工作流 ID
  workflowInputs?: Record<string, string>; // 工作流 IO 节点赋值: ioNodeId → value
  imageUrl?: string;          // 生成的图片 URL（Tauri: asset://localhost/..., 浏览器: data:...）
  videoUrl?: string;          // 生成的视频 URL
  audioUrl?: string;          // 生成的音频 URL
  sourceUrl?: string;         // 原始远程生成 URL（下载到本地前保留）
  filePath?: string;          // 本地文件路径（项目 data 目录下，重建 asset URL 用）
  assetId?: string;           // 稳定资产身份；filePath 仅表示当前位置
  relativePath?: string;      // 项目目录内相对路径，保存时优先于绝对路径
  artifactId?: string;        // 对话媒体 Artifact ID（聊天与节点共享同一产物）
  thumbnailUrl?: string;      // 缩略图（应与 imageUrl 同步；全屏/预览统一读 resolveNodeImageDisplaySrc）
  /** 每次生成成功写入的单调版本号，用于绕过 WebView 图片缓存 */
  mediaVersion?: number;
  /** 由短剧资产一键创建的图像节点：反查绑定 */
  dramaAssetId?: string;
  dramaAssetKind?: import('./dramaAssets').DramaAssetKind;
  /** 角色参考图与当前项目节点的反向关联；全局角色本身不保存项目节点 ID。 */
  characterLibraryLinks?: CharacterLibraryNodeLink[];
  /** 仅表示该节点当前由角色库收纳隐藏，节点与连线仍保留在项目数据中。 */
  hiddenByCharacterLibrary?: boolean;
  /** 分组节点：折叠为文件夹卡片，组内节点与其连线暂不渲染 */
  groupCollapsed?: boolean;
  /** 分组节点：折叠前的尺寸，展开时还原 */
  groupExpandedSize?: { width: number; height: number };
  mattingMask?: string;       // 遮罩编辑器蒙版数据（data URL，独立于图片存储）
  annotation?: string;        // 旧版标注数据（data URL，透明 PNG；仅用于兼容读取）
  annotationLayer?: ImageAnnotationLayer; // 可编辑矢量标注层，独立于原图存储
  imageWidth?: number;        // 生成图片实际宽度
  imageHeight?: number;       // 生成图片实际高度
  videoWidth?: number;        // 视频原始宽度（用于节点等比布局）
  videoHeight?: number;       // 视频原始高度（用于节点等比布局）
  nodeWidth?: number;         // 画布节点当前宽度
  nodeHeight?: number;        // 画布节点当前高度
  imageSize?: string;         // 画质选择：'1K' | '2K' | '4K'
  aspectRatio?: string;       // 图片比例：'1:1' | '16:9' | ...
  batchCount?: number;        // 单次批量生成图片数量，默认 1
  batchGroupId?: string;      // 同一次批量生成的结果分组 ID
  cameraSettings?: CameraGenerationSettings; // 生图/生视频摄影参数；字段缺省时由模型自动决定
  videoResolution?: number;   // 视频分辨率：832 | 1024 | 1280 | 1440
  videoFps?: number;          // 视频帧率：16 | 24 | 30
  videoFrames?: number;       // 视频生成帧数（时长）
  animationAction?: AnimationAction; // 角色逐帧动画动作
  animationFrames?: 6 | 8 | 10 | 12 | 16 | 20; // Sprite Sheet 总帧数
  animationPreviewMode?: AnimationPreviewMode; // 动图预览 / 静态排布
  animationFps?: number;      // 预览播放帧率（1-24），默认 8
  animationLoop?: boolean;    // 预览循环播放，false 时播到末帧停住，默认 true
  seedanceResolution?: string;// Seedance 分辨率：'480p' | '720p' | '1080p' | '4k'
  seedanceRatio?: string;     // Seedance 宽高比：'16:9' | '4:3' | '1:1' | '3:4' | '9:16' | '21:9' | 'adaptive'
  seedanceDuration?: number;  // Seedance 时长（整数秒）：2-15
  generateAudio?: boolean;    // 生成有声视频（Seedance 2.0 / 1.5 pro）
  videoReferences?: VideoReferenceItem[]; // 手动挑选的参考帧 / 参考角色；不选则沿用连线顺序
  audioVoice?: AudioTtsVoice; // TTS 音色
  audioFormat?: AudioOutputFormat; // TTS 输出格式
  audioSpeed?: number;        // TTS 播放速度：0.25-4
  audioPurpose?: AudioGenerationPurpose; // 当前音频模型用途
  musicTitle?: string;        // Flow Music 标题
  musicLyrics?: string;       // Flow Music 歌词
  musicClipId?: string;       // Flow Music 产物标识
  musicBpm?: number;          // Flow Music BPM
  musicDuration?: number;     // Flow Music 时长：1-240 秒
  autoGenerateLyrics?: boolean; // 是否先调用歌词生成接口
  style?: string;               // 画风 ID（如 'realistic'、'anime'）
  error?: string;             // 错误信息
  // ── 宫格分镜（ai-storyboard）──
  storyboardCols?: number;              // 列数
  storyboardRows?: number;              // 行数
  storyboardRowPositions?: number[];    // 自定义横线位置百分比（有序，不含 0/100），非均匀裁切时使用
  storyboardColPositions?: number[];    // 自定义竖线位置百分比（有序，不含 0/100），非均匀裁切时使用
  storyboardExtracted?: boolean[];      // 各格是否已被拖出提取（行优先），已提取的格显示空占位
  storyboardOverrides?: (StoryboardCellOverride | null)[]; // 各格被拖入的图片（覆盖源图裁片显示）
  // ── 分镜表（ai-shotlist）──
  shotlistRows?: ShotRow[];                 // 逐行镜头
  shotlistColumns?: ShotlistColumnKey[];    // 当前显示的列（常驻列恒在其中）
  // ── 3D 导演台（ai-director）──
  directorInstanceId?: string;           // 导演台 localStorage 隔离实例 ID
  directorStatus?: 'idle' | 'open' | 'ready';
  directorCaptureUrls?: string[];        // 从导演台同步的截图 URL 列表
  directorCaptureFilePaths?: string[];   // 对应本地路径
  /** 轻量笔记/绘图元素。与 AI 生成节点数据语义隔离。 */
  note?: CanvasNoteData;
  [key: string]: unknown;
}

// ── AI 输出历史记录 ──
export interface OutputHistoryEntry {
  id: string;                    // 唯一 ID
  projectId: string;             // 所属项目 ID
  nodeId: string;                // 来源节点 ID
  nodeLabel: string;             // 来源节点名称
  timestamp: number;             // 生成时间戳
  prompt: string;                // 原始提示词
  output: string;                // 输出内容（文本 or URL）
  nodeType: NodeType;            // 节点类型
  model: string;                 // 模型 ID
  provider: string;              // 供应商 ID
  status: 'success' | 'error';   // 生成结果
  error?: string;                // 错误信息
  mediaUrl?: string;             // 媒体资源 URL（imageUrl/videoUrl/audioUrl）
  filePath?: string;             // 本地文件路径
  params?: Record<string, unknown>; // 生成参数快照
}

export interface CanvasProject {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  /** 最近一次离开/切换时捕获的画布 WebP 快照（Data URL）。 */
  snapshot?: string;
  /** 本地媒体文件夹名（形如「项目名-短ID」）。创建时确定后保持稳定，旧项目可能缺失（回退到 id）。 */
  dataFolder?: string;
  /** Store revision 计数模式：project=项目独立计数（默认），global=全局计数 */
  revisionScope?: 'project' | 'global';
  /** 项目级创作基线；旧项目缺失时沿用应用与节点默认值。 */
  settings?: ProjectSettings;
  /**
   * 分集项目所属的剧集项目 id。有值 = 这是一集，画布独立、角色库与素材目录跟随父项目；
   * 无值 = 普通单画布项目，或已拥有分集的剧集项目本身。
   */
  parentId?: string;
  /** 分集序号，从 1 开始；仅分集项目有。 */
  episodeNo?: number;
  /** 本集大纲或剧本片段；仅分集项目有。 */
  episodeOutline?: string;
  /** 剧集级原著与剧本；仅剧集项目有。 */
  series?: ProjectSeriesInfo;
}

/** 原著文件引用：正文存在项目数据目录里，记录只留定位信息。 */
export interface ProjectOriginalWork {
  fileName: string;
  /** 相对项目数据目录的路径 */
  relativePath: string;
  addedAt: number;
}

/** 剧集项目的原著与剧本，全部分集共享。 */
export interface ProjectSeriesInfo {
  originalWork?: ProjectOriginalWork;
  /** 全剧剧本正文 */
  script?: string;
}

export type ProjectModelKind = 'text' | 'image' | 'video' | 'audio';

/** 项目级风格母图：生图时自动作为风格参考注入，无需每次 @ */
export interface ProjectStyleReference {
  /** 项目 data 目录下的本地路径 */
  filePath?: string;
  /** 展示/生成用 URL（asset:// 或 data:） */
  imageUrl?: string;
  /** 文件名（展示用） */
  fileName?: string;
  /**
   * 是否启用自动注入。
   * 有 imageUrl 时默认 true；关闭后仅保留母图文件，不参与生成。
   */
  enabled?: boolean;
}

export interface ProjectVisualStyleSettings {
  styleId?: string;
  styleName?: string;
  /** 保存选择时的提示词快照，避免自定义画风被删除后项目失去基线。 */
  prompt?: string;
  locked?: boolean;
  /** 上传的风格母图（卡通/电影截图等），整项目图像生成自动跟随 */
  styleReference?: ProjectStyleReference;
}

export interface ProjectGenerationDefaults {
  imageAspectRatio?: string;
  imageSize?: string;
  /** 视频画面比例：'16:9' 横屏、'9:16' 竖屏等；应用到节点的 seedanceRatio。 */
  videoAspectRatio?: string;
  videoResolution?: '480p' | '720p' | '1080p' | '4k';
  videoDuration?: number;
}

export interface ProjectSettings {
  visualStyle?: ProjectVisualStyleSettings;
  /** @deprecated 旧项目的全类型提示词后缀；编辑保存后迁移到 promptSuffixes。 */
  promptSuffix?: string;
  promptSuffixes?: Partial<Record<ProjectModelKind, string>>;
  defaultModels?: Partial<Record<ProjectModelKind, string>>;
  /** 专门用于图片理解/描述的文本模型；必须声明 image 输入能力。 */
  visionModelId?: string;
  /** 允许 Agent 在未显式 @model 时依据能力和用户描述选择媒体模型。 */
  modelAutoRouting?: boolean;
  generation?: ProjectGenerationDefaults;
}

// API 配置
export type GeneralModelCategory = 'text' | 'image' | 'audio' | 'video';

export type ImageReferenceRequestMode =
  | 'generation-json-image-urls'
  | 'generation-json-image-data-urls'
  | 'edits-multipart';

export type ProviderCatalogAdapter = 'openai-compatible' | 'local-manifest';

export type WebSearchProviderId = 'tavily' | 'bocha' | 'zhipu-search' | 'exa';

/** 用户在厂商目录中明确启用的模型，不包含凭据。 */
export interface ProviderModelSelection {
  id: string;
  name: string;
  category: GeneralModelCategory;
  provider: string;
  description?: string;
  /** 用户已手动编辑用途说明，刷新厂商目录时不覆盖。 */
  descriptionManual?: boolean;
  /** 可验证的输入模态；自然语言描述不能替代该能力声明。 */
  inputModalities?: Array<'text' | 'image'>;
  /** 用户已手动确认输入模态，刷新厂商目录时不覆盖。 */
  inputModalitiesManual?: boolean;
  /** 分类是否由用户手动指定；为 true 时重新拉取目录或合并模型不再覆盖该分类。 */
  categoryManual?: boolean;
  /**
   * 文本模型的上下文窗口（token）。缺省时按模型 ID 猜目录，猜不中退回保守默认值，
   * 中转站的自定义命名基本都猜不中，声明出来助手才不会过早压缩上下文。
   */
  contextWindow?: number;
  /** 自定义媒体模型的提交、轮询与结果解析规则。 */
  executionProfile?: ModelExecutionProfile;
  /** 图片模型存在参考图时使用的请求协议；缺省保持 generations JSON 兼容方式。 */
  imageReferenceRequestMode?: ImageReferenceRequestMode;
  /** 视频模型的参数能力声明（时长/分辨率/比例/参考素材等），缺省走通用兜底。 */
  videoCapability?: VideoModelCapability;
}

export interface ApiProviderConfig {
  name: string;
  /**
   * 运行期明文凭据，只存在于内存。持久化时由 providerSecretService 摘进 Rust 侧的
   * 凭据存储（Renderer 不可直读），数据库里只留 apiKeyRef，不再写入明文。
   */
  apiKey: string;
  /** 凭据在凭据存储中的条目名；由持久化层维护，业务代码不要直接读写。 */
  apiKeyRef?: string;
  baseUrl?: string;
  /** 内置目录定义 ID；自定义连接的配置 key 与目录定义 ID 不同。 */
  catalogId?: string;
  /** undefined 表示旧配置尚未选择；空数组表示用户明确未启用任何模型。 */
  selectedModels?: ProviderModelSelection[];
  /** 最近一次拉取并保存在本地的完整模型目录，不包含凭据。 */
  catalogModels?: ProviderModelSelection[];
  /** undefined 表示旧配置全部可见；空数组表示从所有节点模型列表隐藏该厂商。 */
  visibleModelCategories?: GeneralModelCategory[];
  catalogUpdatedAt?: number;
}

// 即梦/Dreamina OAuth 登录态（登录态由官方 dreamina_cli 持久化，此处仅镜像用于 UI）
export interface DreaminaAuthData {
  loggedIn: boolean;
  username?: string;          // 账户昵称
  credit?: string;            // 额度余额文本
  loginTs?: number;           // 登录时间戳
  cookie?: string;            // 遗留字段（旧 cookie 方案），已弃用且不再持久化（属凭据）
}

// 即梦 OAuth 登录运行态（对应 Rust LoginRuntime 快照）
export interface DreaminaRuntime {
  active: boolean;
  phase: string;              // idle/preparing/starting/oauth_ready/polling/success/failed
  message: string;
  error: string;
  verificationUrl: string;    // 授权链接
  userCode: string;           // 验证码
  loggedIn: boolean;
  username: string;
  credit: string;
}

/** 画布背景主题 */
export type CanvasBackground =
  | 'default'
  | 'solar-system'
  | 'minimal'
  | 'nebula'
  | 'off-white'
  | 'frosted-glass'
  | 'custom';

/** 画布交互模式：default = Figma 风格（左键框选 / 右键·中键平移 / 滚轮缩放）；classic = 传统（左键平移 / Shift+拖动框选 / 滚轮纵横平移 / Ctrl+滚轮缩放） */
export type InteractionMode = 'default' | 'classic';

/** 节点顶部工具栏显示方式 */
export type NodeToolbarMode = 'icons' | 'icons-and-text';

/** 软件启动后优先展示的视图。 */
export type StartupView = 'last-project' | 'project-library';

/** 主窗口可固定的宽高比 */
export type WindowAspectRatio = '16:9' | '16:10' | '4:3';

/** 吉祥物在可拖动视口中的相对位置，x/y 均为 0-1。 */
export interface MascotPosition {
  x: number;
  y: number;
}

/** 画布空白处长按圆环可触发的快捷动作。 */
export type CanvasQuickActionKind =
  | 'comfyui'
  | 'workflows'
  | 'assets'
  | 'settings'
  | 'projects'
  | 'fit-view'
  | 'custom-url'
  | 'disabled';

export interface CanvasQuickAction {
  id: string;
  kind: CanvasQuickActionKind;
  /** 自定义网页或需要覆盖默认文案时使用。 */
  label?: string;
  /** 仅 custom-url 动作使用，执行前仍会校验 http/https 协议。 */
  url?: string;
}

export interface AppConfig {
  providers: Record<string, ApiProviderConfig>;
  /** 当前用于 Agent 联网搜索的厂商；旧配置未设置时优先沿用 Tavily。 */
  webSearchProviderId?: WebSearchProviderId;
  theme: 'dark' | 'light';
  language?: Locale; // 界面语言，未设置时跟随系统
  canvasBackground?: CanvasBackground; // 画布背景主题
  interactionMode?: InteractionMode; // 画布交互模式，默认 'default'
  nodeToolbarMode?: NodeToolbarMode; // 节点顶部工具栏显示方式，默认 'icons'
  nodeLabelVisible?: boolean; // 是否显示节点顶部标题标签，默认 true
  canvasNoteToolbarVisible?: boolean; // 是否显示画布笔记工具栏，默认 true
  canvasHistoryPinned?: boolean; // 操作记录浮层是否锁定常显（默认悬浮才显示）
  canvasQuickActions?: CanvasQuickAction[]; // 画布空白处长按圆环，最多 6 个槽位
  startupView?: StartupView; // 软件启动后打开上次画布或项目列表，默认 'last-project'
  windowAspectRatio?: WindowAspectRatio; // 窗口尺寸预设所用比例，默认 '16:9'
  windowAspectLocked?: boolean; // 拖拽缩放窗口时是否固定为上面的比例，默认 false
  windowSize?: { width: number; height: number }; // 上次退出时的窗口逻辑尺寸，启动时恢复
  customBackgroundUrl?: string;  // 自定义背景图片 data URL
  customBackgroundIsDark?: boolean; // 自定义背景是否为深色（自动识别）
  customBackgroundOpacity?: number; // 自定义背景透明度 0-1，默认 0.3
  comfyUIUrl?: string;        // ComfyUI 默认服务地址（工作流没绑定服务端时用它）
  comfyServers?: ComfyServer[]; // 额外的 ComfyUI 服务端，供工作流按需绑定
  comfyUIPath?: string;       // ComfyUI 安装目录路径
  dreaminaAuth?: DreaminaAuthData; // 即梦登录态
  baseDataDir?: string;       // 用户自定义文件保存根目录，保存结构为 {baseDataDir}/{projectId}/**
  generalModels?: GeneralModelConfig[]; // 用户自建通用模型
  sidebarFloating?: boolean;  // 侧边栏是否悬浮显示（半隐于窗口边缘），默认 true
  windowGlassFrame?: boolean; // 是否显示主窗口玻璃外框，默认 true
  performanceMode?: boolean; // 性能模式：关闭高开销视觉效果与装饰动画，默认 false
  /** @deprecated 仅用于读取早期图形兼容模式配置，加载后迁移到 performanceMode。 */
  graphicsCompatibilityMode?: boolean;
  titlebarFloating?: boolean; // 标题栏是否悬浮显示（macOS 红绿灯内移并带毛玻璃胶囊），默认 true
  mascotVisible?: boolean;   // 是否显示吉祥物，默认 false
  mascotPosition?: MascotPosition; // 吉祥物相对视口位置，未设置时使用右下角默认位置
  assetFolders?: string[];    // 资产管理中登记的外部本地文件夹路径（引用不拷贝）
  assetWaterfallColumns?: number; // 资产管理瀑布流列数，默认 3，范围 2-6
  photoshopPath?: string;    // Photoshop 安装路径，自动检测失败时手动配置
  jianyingPath?: string;     // 剪映专业版安装路径，自动检测失败时手动配置
  premierePath?: string;     // Adobe Premiere Pro 安装路径，自动检测失败时手动配置
  assistantModelId?: string;  // 助手模型 ID：generalModels 中的 text 模型 id
  assistantImageModelId?: string;  // 助手生图模型 ID：generalModels 中的 image 模型 id
  assistantVideoModelId?: string;  // 助手生视频模型 ID：generalModels 中的 video 模型 id
  cloudParseEnabled?: boolean; // 是否启用云端解析，默认 true；关闭后助手仅使用本地规则
  mcpAutoStart?: boolean;     // 启动软件时自动开启 MCP 本地控制会话，默认 false
  mcpPort?: number;           // MCP 固定端口，1024-65535；未设置时随机分配
  mcpTransport?: 'stdio' | 'streamable-http'; // 默认 stdio；HTTP 模式监听 0.0.0.0
}

// ── 通用模型配置 ──
export interface GeneralModelConfig {
  id: string;
  name: string;               // 名称
  modelId: string;            // 模型 ID
  category: GeneralModelCategory; // 模型种类
  contextWindow?: number;     // 文本模型上下文窗口（token）；未声明时按模型 ID 目录推断
  description?: string;       // 用户可编辑的模型用途说明，用于 Agent 路由参考
  inputModalities?: Array<'text' | 'image'>;
  /** 对应 config.providers 中的连接 ID，凭据和地址仅从该连接读取。 */
  providerConfigId: string;
  executionProfile?: ModelExecutionProfile;
  /** 图片模型存在参考图时使用的请求协议；缺省保持 generations JSON 兼容方式。 */
  imageReferenceRequestMode?: ImageReferenceRequestMode;
  /** 视频模型的参数能力声明（时长/分辨率/比例/参考素材等），缺省走通用兜底。 */
  videoCapability?: VideoModelCapability;
}

export const GENERAL_MODEL_CATEGORY_LABELS: Record<GeneralModelCategory, string> = {
  text: '文本',
  image: '图片',
  audio: '音频',
  video: '视频',
};

/** GeneralModelCategory → 适用的节点类型映射 */
export const CATEGORY_TO_NODE_TYPES: Record<GeneralModelCategory, NodeType[]> = {
  text: ['ai-text'],
  image: ['ai-image', 'ai-animation'],
  video: ['ai-video'],
  audio: ['ai-audio'],
};

// 引用节点信息
export interface NodeReference {
  nodeId: string;
  nodeLabel: string;
  nodeType: NodeType;
  outputType: 'text' | 'image' | 'video' | 'audio';
}

// ============================================
// 模型/供应商定义 — 驱动节点底部模型选择器
// ============================================

export interface ModelOption {
  value: string;              // 模型唯一 ID
  provider: string;           // 归属供应商
  label: string;              // 展示名
  description?: string;       // 简介
  inputModalities?: Array<'text' | 'image'>; // 可验证的输入模态
  icon?: string;              // 图标路径或内置图标名
  iconType?: 'image' | 'badge';
  badgeText?: string;
  nodeTypes: NodeType[];      // 可用于哪些节点类型
  nbFamily?: string;          // RunningHub/GRSAI nanobanana 家族标识（可选）
  audioPurpose?: AudioGenerationPurpose; // 音频模型用途，避免音乐与语音混用
}

export interface ModelGroup {
  id: string;
  name: string;               // 供应商展示名
  description: string;
  icon?: string;
  iconType?: 'image' | 'badge';
  badgeText?: string;
  models: ModelOption[];
}

// ============================================
// 工作流定义 — ComfyUI workflow import
// ============================================

/** 额外的 ComfyUI 服务端；图片 / 视频分开部署时，工作流各自绑定一台 */
export interface ComfyServer {
  id: string;
  name: string;
  url: string;
}

/** 工作流分类 — 对应各节点类型 */
export type WorkflowCategory = 'ai-text' | 'ai-image' | 'ai-video' | 'ai-audio';

/** 工作流中识别的输入/输出节点类型 */
export type WorkflowIONodeType = 'prompt' | 'image' | 'video' | 'audio';

/** 工作流中识别的输入/输出节点信息 */
export interface WorkflowIONode {
  nodeId: string;             // ComfyUI 节点 ID（如 "57:27"）
  title: string;              // 节点标题（来自 _meta.title 或 class_type）
  type: WorkflowIONodeType;   // 节点类型
}

/** 导入的 ComfyUI 工作流 */
export interface WorkflowDefinition {
  id: string;
  name: string;               // 工作流名称
  category: WorkflowCategory; // 归属分类
  fileName: string;           // 原始文件名
  fileContent: string;        // JSON 字符串
  editableContent?: string;   // ComfyUI UI 工作流 JSON，用于保留节点布局后再次编辑
  ioNodes?: WorkflowIONode[]; // 识别出的输入/输出节点
  /** 各类型的默认 IO 节点（type → nodeId）；用户没 @ 该类型节点时，提示词框里的同类内容自动注入这里 */
  defaultNodes?: Partial<Record<WorkflowIONodeType, string>>;
  /** 绑定的 ComfyUI 服务端 id；为空或服务端已删除时回落到默认地址 */
  serverId?: string;
  createdAt: number;
  updatedAt?: number;
}

/** 按 NodeType 映射其所属工作流分类 */
export function getWorkflowCategory(nodeType: NodeType): WorkflowCategory | null {
  switch (nodeType) {
    case 'ai-text': return 'ai-text';
    case 'ai-image': return 'ai-image';
    case 'ai-video': return 'ai-video';
    case 'ai-audio': return 'ai-audio';
    default: return null;
  }
}

// ============================================
// 用户自定义预设 — 可编辑的提示词模板
// ============================================

export type PresetNodeType = 'ai-text' | 'ai-image' | 'ai-video' | 'ai-audio';

export const PRESET_NODE_TYPES: PresetNodeType[] = ['ai-text', 'ai-image', 'ai-video', 'ai-audio'];

export const PRESET_NODE_TYPE_LABELS: Record<PresetNodeType, string> = {
  'ai-text': '文本预设',
  'ai-image': '图像预设',
  'ai-video': '视频预设',
  'ai-audio': '音频预设',
};

// ============================================
// 节点类型统一视觉配置 — 图标、颜色、标签
// 所有组件引用此处，避免分散定义
// ============================================
export interface NodeTypeVisualConfig {
  icon: string;      // MDI 图标名（用于 @iconify/react <Icon>）
  color: string;     // Tailwind 文字颜色类，如 'text-indigo-400'
  bg: string;        // Tailwind 背景色类，如 'bg-indigo-500/15'
  label: string;     // 中文名称
}

export const NODE_TYPE_CONFIG: Record<string, NodeTypeVisualConfig> = {
  'ai-text':     { icon: 'mdi:text-box-outline',         color: 'text-indigo-400',  bg: 'bg-indigo-500/15',  label: '生成文本' },
  'ai-image':    { icon: 'mdi:image-outline',             color: 'text-green-400',   bg: 'bg-green-500/15',   label: '生成图像' },
  'ai-video':    { icon: 'mdi:video-outline',             color: 'text-blue-400',    bg: 'bg-blue-500/15',    label: '生成视频' },
  'ai-audio':    { icon: 'mdi:volume-high',               color: 'text-orange-400',  bg: 'bg-orange-500/15',  label: '生成音频' },
  'ai-animation': { icon: 'mdi:animation-play-outline',    color: 'text-fuchsia-400', bg: 'bg-fuchsia-500/15', label: '生成动画' },
  'ai-panorama': { icon: 'mdi:panorama',                  color: 'text-cyan-400',    bg: 'bg-cyan-500/15',    label: '生成360全景' },
  'ai-markdown': { icon: 'mdi:language-markdown-outline', color: 'text-purple-400',  bg: 'bg-purple-500/15',  label: 'Markdown' },
  'ai-storyboard': { icon: 'mdi:grid',                    color: 'text-pink-400',    bg: 'bg-pink-500/15',    label: '宫格分镜' },
  'ai-shotlist':   { icon: 'mdi:table-large',             color: 'text-amber-400',   bg: 'bg-amber-500/15',   label: '分镜表' },
  'ai-director':   { icon: 'mdi:video-3d',                color: 'text-violet-400',  bg: 'bg-violet-500/15',  label: '3D 导演台' },
  'plugin-node':   { icon: 'mdi:puzzle-outline',          color: 'text-indigo-400',  bg: 'bg-indigo-500/15',  label: '插件节点' },
  'canvas-note':   { icon: 'mdi:draw',                    color: 'text-sky-400',     bg: 'bg-sky-500/15',     label: '画布笔记' },
};

/** 获取节点类型视觉配置，未匹配时返回灰色兜底 */
export function getNodeTypeConfig(kind: string): NodeTypeVisualConfig {
  return NODE_TYPE_CONFIG[kind] ?? { icon: 'mdi:help-circle-outline', color: 'text-gray-400', bg: 'bg-gray-500/15', label: kind };
}

export type PresetTriggerMode = 'direct' | 'insertPrompt';

export type UserPresetMode = 'basic' | 'advanced';

export type PresetParameterType = 'text' | 'textarea' | 'number' | 'select' | 'boolean';

export type PresetParameterValue = string | number | boolean;

export interface PresetParameterDefinition {
  id: string;
  key: string;
  label: string;
  type: PresetParameterType;
  required?: boolean;
  defaultValue?: PresetParameterValue;
  options?: string[];
}

export interface PresetSequenceStep {
  id: string;
  name: string;
  nodeType: PresetNodeType;
  promptTemplate: string;
  model?: string;
  provider?: string;
  /** provider=comfyui 时指定本地工作流；缺省则沿用触发节点的工作流 */
  workflowId?: string;
  imageSize?: string;
  aspectRatio?: string;
}

export interface PresetAdvancedConfig {
  parameters: PresetParameterDefinition[];
  steps: PresetSequenceStep[];
}

export interface PresetRunRequest {
  presetId: string;
  sourceNodeId: string;
}

/** 反推提示词弹窗的输入：图片节点给自身图，视频节点给抽好的关键帧 */
export interface ReversePromptRequest {
  sourceNodeId: string;
  kind: 'image' | 'video';
  imageUrls: string[];
}

// ── 用户自定义画风 ──
export interface CustomStyle {
  id: string;
  nodeType: string;       // 'ai-image' | 'ai-panorama' | 'ai-video'
  name: string;           // 画风名称
  prompt: string;         // 画风提示词
  thumbnail?: string;     // base64 缩略图
  createdAt: number;
}

export interface UserPreset {
  id: string;
  nodeType: PresetNodeType;
  name: string;
  description: string;
  promptTemplate: string;
  icon?: string;              // iconify icon name (e.g. 'mdi:star'), for Toolbar display
  thumbnail?: string;        // base64 data URL
  triggerMode: PresetTriggerMode;  // direct=替换全文, insertPrompt=追加到提示词
  // 可选：预设绑定的模型和尺寸，选择后生图时覆盖节点设置
  model?: string;
  provider?: string;
  imageSize?: string;
  aspectRatio?: string;
  /** 旧数据缺省时按 basic 读取。 */
  mode?: UserPresetMode;
  advanced?: PresetAdvancedConfig;
}

// ============================================
// 用户 Skill — 只读上传与调用，不提供内置编辑
// ============================================

export interface SkillManifest {
  name?: string;
  description?: string;
  whenToUse?: string;
  /** 缺省表示不额外限制；空数组表示该 Skill 不需要任何 Agent 工具。 */
  allowedTools?: string[];
  userInvocable?: boolean;
  disableModelInvocation?: boolean;
  version?: string;
}

export interface UserSkill {
  id: string;
  name: string;
  description: string;
  fileName: string;
  content: string;
  sourceType: 'file' | 'folder';
  storagePath?: string;
  entryFileName?: string;
  /** 从入口文件 frontmatter 解析的非执行型声明。 */
  manifest?: SkillManifest;
  createdAt: number;
}

// ============================================
// 节点分组
// ============================================

export interface NodeGroup {
  id: string;
  name: string;
  nodeIds: string[];
  color: string;
  createdAt: number;
}

/** 分组色板 — 循环分配 */
export const GROUP_COLOR_PALETTE = [
  '#6366f1',
  '#ec4899',
  '#10b981',
  '#f59e0b',
  '#3b82f6',
  '#ef4444',
  '#8b5cf6',
  '#06b6d4',
  '#14b8a6',
  '#f97316',
];

// ============================================
// Toolbar 自定义编辑 — 按钮 / Zone / 布局
// ============================================

/** Toolbar 按钮定义（注册表中每一项） */
export interface ToolbarButtonDef {
  key: string;              // 唯一标识，如 'copy', 'fullscreen', 'matting'
  label: string;            // tooltip 文本
  icon: string;             // iconify name (e.g. 'mdi:copy') 或 emoji
  defaultZone: string;      // 默认归属 Zone 名
  /** 是否有状态变体（如 copied 状态的图标），默认 false */
  hasState?: boolean;
  /** 子菜单项 key 列表（如宫格裁切有子菜单） */
  subKeys?: string[];
}

/** 一个 Zone 的布局 */
export interface ToolbarZoneLayout {
  id: string;
  name: string;
  buttonKeys: string[];
}

/** 单个节点类型的 Toolbar 布局 */
export interface ToolbarLayout {
  zones: ToolbarZoneLayout[];
  version: number;
}

/** 所有节点类型的 Toolbar 布局集合 */
export type ToolbarLayouts = Record<string, ToolbarLayout>;

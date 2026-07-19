/**
 * types 全局类型定义 — 定义 NodeType、BaseNodeData、CanvasProject、AppConfig、ModelOption、WorkflowDefinition 等核心类型
 */
import type { AudioOutputFormat, AudioTtsVoice } from './aiTypes';
import type { AudioGenerationPurpose } from './media';

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
  | 'source-image'
  | 'source-video'
  | 'source-audio'
  | 'source-text'
  | 'comment';

// 内置图像预设可请求的生成后处理流程
export type ImagePostProcess = 'character-8-direction-grid';

export type AnimationAction = 'idle' | 'walk' | 'run' | 'jump' | 'attack' | 'hit';
export type AnimationPreviewMode = 'playing' | 'sheet';

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

// 宫格分镜：被拖入某格的图片覆盖
export interface StoryboardCellOverride {
  url: string;         // 展示用 asset/data URL
  filePath?: string;   // 本地文件路径（复用被拖入节点的落盘文件）
  assetId?: string;    // 稳定资产身份，不随文件移动或重命名变化
  relativePath?: string; // 项目目录内的相对路径（持久化优先）
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
  thumbnailUrl?: string;      // 缩略图
  mattingMask?: string;       // 遮罩编辑器蒙版数据（data URL，独立于图片存储）
  annotation?: string;        // 标注编辑器涂写数据（data URL，透明 PNG）
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
  videoResolution?: number;   // 视频分辨率：832 | 1024 | 1280 | 1440
  videoFps?: number;          // 视频帧率：16 | 24 | 30
  videoFrames?: number;       // 视频生成帧数（时长）
  animationAction?: AnimationAction; // 角色逐帧动画动作
  animationFrames?: 6 | 8 | 10 | 12 | 16 | 20; // Sprite Sheet 总帧数
  animationPreviewMode?: AnimationPreviewMode; // 动图预览 / 静态排布
  seedanceResolution?: string;// Seedance 分辨率：'480p' | '720p' | '1080p' | '4k'
  seedanceRatio?: string;     // Seedance 宽高比：'16:9' | '4:3' | '1:1' | '3:4' | '9:16' | '21:9' | 'adaptive'
  seedanceDuration?: number;  // Seedance 时长（整数秒）：2-15
  generateAudio?: boolean;    // 生成有声视频（Seedance 2.0 / 1.5 pro）
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
  [key: string]: unknown;
}

// ── AI 输出历史记录 ──
export interface OutputHistoryEntry {
  id: string;                    // 唯一 ID
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
  /** 本地媒体文件夹名（形如「项目名-短ID」）。创建时确定后保持稳定，旧项目可能缺失（回退到 id）。 */
  dataFolder?: string;
  /** Store revision 计数模式：project=项目独立计数（默认），global=全局计数 */
  revisionScope?: 'project' | 'global';
  /** 项目级创作基线；旧项目缺失时沿用应用与节点默认值。 */
  settings?: ProjectSettings;
}

export type ProjectModelKind = 'text' | 'image' | 'video' | 'audio';

export interface ProjectVisualStyleSettings {
  styleId?: string;
  styleName?: string;
  /** 保存选择时的提示词快照，避免自定义画风被删除后项目失去基线。 */
  prompt?: string;
  locked?: boolean;
}

export interface ProjectGenerationDefaults {
  imageAspectRatio?: string;
  imageSize?: string;
  videoResolution?: '480p' | '720p' | '1080p';
  videoDuration?: number;
}

export interface ProjectSettings {
  visualStyle?: ProjectVisualStyleSettings;
  /** @deprecated 旧项目的全类型提示词后缀；编辑保存后迁移到 promptSuffixes。 */
  promptSuffix?: string;
  promptSuffixes?: Partial<Record<ProjectModelKind, string>>;
  defaultModels?: Partial<Record<ProjectModelKind, string>>;
  generation?: ProjectGenerationDefaults;
}

// API 配置
export type GeneralModelCategory = 'text' | 'image' | 'audio' | 'video';

export type ProviderCatalogAdapter = 'openai-compatible' | 'local-manifest';

/** 用户在厂商目录中明确启用的模型，不包含凭据。 */
export interface ProviderModelSelection {
  id: string;
  name: string;
  category: GeneralModelCategory;
  provider: string;
  description?: string;
}

export interface ApiProviderConfig {
  name: string;
  apiKey: string;
  baseUrl?: string;
  /** 内置目录定义 ID；自定义连接的配置 key 与目录定义 ID 不同。 */
  catalogId?: string;
  anthropicUrl?: string;
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
  cookie?: string;            // 遗留字段（旧 cookie 方案），已弃用
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

export interface AppConfig {
  providers: Record<string, ApiProviderConfig>;
  theme: 'dark' | 'light';
  canvasBackground?: CanvasBackground; // 画布背景主题
  interactionMode?: InteractionMode; // 画布交互模式，默认 'default'
  customBackgroundUrl?: string;  // 自定义背景图片 data URL
  customBackgroundIsDark?: boolean; // 自定义背景是否为深色（自动识别）
  customBackgroundOpacity?: number; // 自定义背景透明度 0-1，默认 0.3
  comfyUIUrl?: string;        // ComfyUI 服务地址
  comfyUIPath?: string;       // ComfyUI 安装目录路径
  dreaminaAuth?: DreaminaAuthData; // 即梦登录态
  baseDataDir?: string;       // 用户自定义文件保存根目录，保存结构为 {baseDataDir}/{projectId}/**
  generalModels?: GeneralModelConfig[]; // 用户自建通用模型
  sidebarFloating?: boolean;  // 侧边栏是否悬浮显示（半隐于窗口边缘），默认 true
  titlebarFloating?: boolean; // 标题栏是否悬浮显示（macOS 红绿灯内移并带毛玻璃胶囊），默认 true
  mascotVisible?: boolean;   // 是否显示吉祥物，默认 false
  assetFolders?: string[];    // 资产管理中登记的外部本地文件夹路径（引用不拷贝）
  photoshopPath?: string;    // Photoshop 安装路径，自动检测失败时手动配置
  assistantModelId?: string;  // 助手模型 ID：generalModels 中的 text 模型 id
  assistantImageModelId?: string;  // 助手生图模型 ID：generalModels 中的 image 模型 id
  assistantVideoModelId?: string;  // 助手生视频模型 ID：generalModels 中的 video 模型 id
  cloudParseEnabled?: boolean; // 是否启用云端解析，默认 true；关闭后助手仅使用本地规则
}

// ── 通用模型配置 ──
export interface GeneralModelConfig {
  id: string;
  name: string;               // 名称
  openaiUrl: string;          // OpenAI 接口地址
  anthropicUrl: string;       // Anthropic 接口地址
  modelId: string;            // 模型 ID
  apiKey: string;             // API 密钥
  category: GeneralModelCategory; // 模型种类
  contextWindow?: number;     // 文本模型上下文窗口（token）；未声明时按模型 ID 目录推断
  /** 对应 config.providers 中的连接 ID；旧配置可能缺失。 */
  providerConfigId?: string;
}

export const GENERAL_MODEL_CATEGORY_LABELS: Record<GeneralModelCategory, string> = {
  text: '文本',
  image: '图片',
  audio: '音频',
  video: '视频',
};

export const GENERAL_MODEL_CATEGORY_COLORS: Record<GeneralModelCategory, string> = {
  text: '#6366f1',
  image: '#22c55e',
  audio: '#f97316',
  video: '#3b82f6',
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
  ioNodes?: WorkflowIONode[]; // 识别出的输入/输出节点
  createdAt: number;
}

/** 工作流分类的显示配置 */
export const WORKFLOW_CATEGORY_LABELS: Record<WorkflowCategory, string> = {
  'ai-text': '生成文本',
  'ai-image': '生成图像',
  'ai-video': '生成视频',
  'ai-audio': '生成音频',
};

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

export interface UserSkill {
  id: string;
  name: string;
  description: string;
  fileName: string;
  content: string;
  sourceType: 'file' | 'folder';
  storagePath?: string;
  entryFileName?: string;
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

/**
 * types 全局类型定义 — 定义 NodeType、BaseNodeData、CanvasProject、AppConfig、ModelOption、WorkflowDefinition 等核心类型
 */

// 节点类型定义
export type NodeType =
  | 'ai-text'
  | 'ai-image'
  | 'ai-video'
  | 'ai-audio'
  | 'ai-panorama'
  | 'ai-markdown'
  | 'source-image'
  | 'source-video'
  | 'source-audio'
  | 'source-text'
  | 'comment';

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
  thumbnailUrl?: string;      // 缩略图
  mattingMask?: string;       // 遮罩编辑器蒙版数据（data URL，独立于图片存储）
  annotation?: string;        // 标注编辑器涂写数据（data URL，透明 PNG）
  imageWidth?: number;        // 生成图片实际宽度
  imageHeight?: number;       // 生成图片实际高度
  imageSize?: string;         // 画质选择：'1K' | '2K' | '4K'
  aspectRatio?: string;       // 图片比例：'1:1' | '16:9' | ...
  videoResolution?: number;   // 视频分辨率：832 | 1024 | 1280 | 1440
  videoFps?: number;          // 视频帧率：16 | 24 | 30
  videoFrames?: number;       // 视频生成帧数（时长）
  error?: string;             // 错误信息
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
}

// API 配置
export interface ApiProviderConfig {
  name: string;
  apiKey: string;
  baseUrl?: string;
}

// 即梦/Dreamina 网页登录认证数据
export interface DreaminaAuthData {
  loggedIn: boolean;
  username?: string;          // 账户昵称
  credit?: string;            // 额度余额文本
  cookie?: string;            // 持久化的 cookie/token
  loginTs?: number;           // 登录时间戳
}

/** 画布背景主题 */
export type CanvasBackground = 'default' | 'solar-system' | 'minimal' | 'nebula' | 'off-white' | 'custom';

export interface AppConfig {
  providers: Record<string, ApiProviderConfig>;
  theme: 'dark' | 'light';
  canvasBackground?: CanvasBackground; // 画布背景主题
  customBackgroundUrl?: string;  // 自定义背景图片 data URL
  customBackgroundIsDark?: boolean; // 自定义背景是否为深色（自动识别）
  customBackgroundOpacity?: number; // 自定义背景透明度 0-1，默认 0.3
  comfyUIUrl?: string;        // ComfyUI 服务地址
  comfyUIPath?: string;       // ComfyUI 安装目录路径
  dreaminaAuth?: DreaminaAuthData; // 即梦登录态
  baseDataDir?: string;       // 用户自定义文件保存根目录，保存结构为 {baseDataDir}/{projectId}/**
  generalModels?: GeneralModelConfig[]; // 用户自建通用模型
  sidebarFloating?: boolean;  // 侧边栏是否悬浮显示（半隐于窗口边缘），默认 true
}

// ── 通用模型配置 ──
export type GeneralModelCategory = 'text' | 'image' | 'audio' | 'video';

export interface GeneralModelConfig {
  id: string;
  name: string;               // 名称
  openaiUrl: string;          // OpenAI 接口地址
  anthropicUrl: string;       // Anthropic 接口地址
  modelId: string;            // 模型 ID
  apiKey: string;             // API 密钥
  category: GeneralModelCategory; // 模型种类
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
  image: ['ai-image'],
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
  'ai-panorama': { icon: 'mdi:panorama',                  color: 'text-cyan-400',    bg: 'bg-cyan-500/15',    label: '生成360全景' },
  'ai-markdown': { icon: 'mdi:language-markdown-outline', color: 'text-purple-400',  bg: 'bg-purple-500/15',  label: 'Markdown' },
};

/** 获取节点类型视觉配置，未匹配时返回灰色兜底 */
export function getNodeTypeConfig(kind: string): NodeTypeVisualConfig {
  return NODE_TYPE_CONFIG[kind] ?? { icon: 'mdi:help-circle-outline', color: 'text-gray-400', bg: 'bg-gray-500/15', label: kind };
}

export type PresetTriggerMode = 'direct' | 'insertPrompt';

export interface UserPreset {
  id: string;
  nodeType: PresetNodeType;
  name: string;
  description: string;
  promptTemplate: string;
  thumbnail?: string;        // base64 data URL
  triggerMode: PresetTriggerMode;  // direct=替换全文, insertPrompt=追加到提示词
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

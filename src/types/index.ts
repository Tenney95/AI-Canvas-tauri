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

export interface AppConfig {
  providers: Record<string, ApiProviderConfig>;
  theme: 'dark' | 'light';
  localLLMUrl?: string;       // 本地大模型调用地址
  comfyUIUrl?: string;        // ComfyUI 服务地址
  dreaminaAuth?: DreaminaAuthData; // 即梦登录态
  baseDataDir?: string;       // 用户自定义文件保存根目录，保存结构为 {baseDataDir}/{projectId}/**
  generalModels?: GeneralModelConfig[]; // 用户自建通用模型
}

// ── 通用模型配置 ──
export type GeneralModelCategory = 'mixed' | 'text' | 'audio' | 'video' | 'image';

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
  mixed: '混合模型',
  text: '纯文本',
  audio: '音频',
  video: '视频',
  image: '图片',
};

export const GENERAL_MODEL_CATEGORY_COLORS: Record<GeneralModelCategory, string> = {
  mixed: '#6366f1',
  text: '#6366f1',
  audio: '#f97316',
  video: '#3b82f6',
  image: '#22c55e',
};

/** GeneralModelCategory → 适用的节点类型映射 */
export const CATEGORY_TO_NODE_TYPES: Record<GeneralModelCategory, NodeType[]> = {
  mixed: ['ai-text', 'ai-image', 'ai-video', 'ai-audio'],
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

export const PRESET_NODE_TYPE_ICONS: Record<PresetNodeType, string> = {
  'ai-text': 'T',
  'ai-image': 'I',
  'ai-video': 'V',
  'ai-audio': 'A',
};

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

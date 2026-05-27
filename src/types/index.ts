// 节点类型定义
export type NodeType =
  | 'ai-text'
  | 'ai-image'
  | 'ai-video'
  | 'ai-audio'
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
  prompt?: string;           // 提示词
  output?: string;            // 输出结果（文本/URL等）
  status?: 'idle' | 'loading' | 'success' | 'error';
  model?: string;             // 选择的模型 ID（如 qwen/qwen3.5-397b-a17b）
  provider?: string;          // 选择的供应商 ID（如 ppio）
  workflowId?: string;        // 选择的工作流 ID
  workflowInputs?: Record<string, string>; // 工作流 IO 节点赋值: ioNodeId → value
  imageUrl?: string;          // 生成的图片 URL
  videoUrl?: string;          // 生成的视频 URL
  audioUrl?: string;          // 生成的音频 URL
  thumbnailUrl?: string;      // 缩略图
  imageWidth?: number;        // 生成图片实际宽度
  imageHeight?: number;       // 生成图片实际高度
  imageSize?: string;         // 画质选择：'1K' | '2K' | '4K'
  aspectRatio?: string;       // 图片比例：'1:1' | '16:9' | ...
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

export interface AppConfig {
  providers: Record<string, ApiProviderConfig>;
  theme: 'dark' | 'light';
  localLLMUrl?: string;       // 本地大模型调用地址
  comfyUIUrl?: string;        // ComfyUI 服务地址
}

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

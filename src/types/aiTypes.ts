export interface AIGenerateParams {
  prompt: string;
  model: string;      // model value (e.g. 'ppio/qwen/qwen3.5-397b-a17b')
  provider: string;   // provider id (e.g. 'ppio')
  /** 关联的节点 ID（用于中断恢复） */
  nodeId?: string;
}

export interface AIImageGenParams extends AIGenerateParams {
  imageSize?: string;     // '1K' | '2K' | '4K'
  aspectRatio?: string;   // '1:1' | '16:9' | '9:16' | ...
  image_urls?: string[];  // 参考图片 URL（从 @图片节点 引用中提取）
  workflowId?: string;    // ComfyUI 工作流 ID（存在时走 ComfyUI 执行）
  workflowInputs?: Record<string, string>; // IO 节点赋值映射
}

export const MAX_IMAGE_BATCH_COUNT = 8;

export interface ImageGenerationResult {
  url: string;
  width: number;
  height: number;
}

export interface BatchImageResult {
  requestedCount: number;
  results: ImageGenerationResult[];
  failedCount: number;
}

export interface AIVideoGenParams {
  prompt: string;
  model: string;
  provider: string;
  // ── ComfyUI / RunningHub 参数 ──
  videoResolution?: number;  // 视频分辨率 (e.g. 832)
  videoFps?: number;         // 帧率 (e.g. 24)
  videoFrames?: number;      // 帧数 (e.g. 77)
  // ── 火山方舟 Seedance 参数 ──
  /** Seedance 分辨率: '480p' | '720p' | '1080p' | '4k' */
  seedanceResolution?: string;
  /** Seedance 宽高比: '16:9' | '4:3' | '1:1' | '3:4' | '9:16' | '21:9' | 'adaptive' */
  seedanceRatio?: string;
  /** Seedance 时长（整数秒）: 2-15 */
  seedanceDuration?: number;
  /** 是否生成有声视频（仅 Seedance 2.0 / 1.5 pro） */
  generateAudio?: boolean;
  // ── 通用 ──
  workflowId?: string;       // ComfyUI 工作流 ID
  workflowInputs?: Record<string, string>; // IO 节点赋值映射
  /** 关联的节点 ID（用于中断恢复） */
  nodeId?: string;
}

export interface AIAudioGenParams {
  prompt: string;
  model: string;
  provider: string;
  workflowId?: string;       // ComfyUI 工作流 ID
  workflowInputs?: Record<string, string>; // IO 节点赋值映射
  /** 关联的节点 ID（用于中断恢复） */
  nodeId?: string;
}

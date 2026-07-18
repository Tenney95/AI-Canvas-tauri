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
  /** TTS 音色。 */
  audioVoice?: AudioTtsVoice;
  /** TTS 输出格式。 */
  audioFormat?: AudioOutputFormat;
  /** TTS 播放速度，范围 0.25-4。 */
  audioSpeed?: number;
  /** Flow Music 标题。 */
  musicTitle?: string;
  /** Flow Music 歌词；为空时可只按风格提示词生成。 */
  musicLyrics?: string;
  /** Flow Music BPM，最小值 1。 */
  musicBpm?: number;
  /** Flow Music 时长，范围 1-240 秒。 */
  musicDuration?: number;
  /** 先调用 Flow Music 歌词接口，再把结果回填到音乐生成。 */
  autoGenerateLyrics?: boolean;
  workflowId?: string;       // ComfyUI 工作流 ID
  workflowInputs?: Record<string, string>; // IO 节点赋值映射
  /** 关联的节点 ID（用于中断恢复） */
  nodeId?: string;
}

export type AudioTtsVoice = 'alloy' | 'echo' | 'fable' | 'onyx' | 'nova' | 'shimmer';

export type AudioOutputFormat = 'wav' | 'opus' | 'aac' | 'flac' | 'pcm';

export interface AudioGenerationResult {
  url: string;
  /** 同步二进制接口返回的运行时数据，只用于落盘，不得写入 Store 或 IndexedDB。 */
  bytes?: Uint8Array;
  format?: AudioOutputFormat;
  clipId?: string;
  title?: string;
  lyrics?: string;
}

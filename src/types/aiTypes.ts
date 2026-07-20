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

export type ProtocolJsonValue =
  | string
  | number
  | boolean
  | null
  | ProtocolJsonValue[]
  | { [key: string]: ProtocolJsonValue };

export type ModelProtocolHttpMethod = 'GET' | 'POST';

export type ModelProtocolBodyEncoding = 'json' | 'form-urlencoded' | 'multipart';

export type ModelProtocolResponseType = 'json' | 'text' | 'binary';

export type ModelProtocolAuthType = 'bearer' | 'header' | 'query' | 'none';

export interface ModelProtocolAuthConfig {
  type: ModelProtocolAuthType;
  /** header/query 模式使用的字段名；密钥值只在运行时注入。 */
  name?: string;
  /** 可选值前缀，例如 `Token `；Bearer 默认使用 `Bearer `。 */
  prefix?: string;
}

export interface ModelProtocolRequestTemplate {
  method: ModelProtocolHttpMethod;
  /** 只允许相对于连接 baseUrl 的同源路径。 */
  path: string;
  /** append 默认拼接到 baseUrl；origin 从同源根路径发起。 */
  pathMode?: 'append' | 'origin';
  /** 受控静态请求头；禁止覆盖鉴权、来源、Cookie 和传输层字段。 */
  headers?: Record<string, string>;
  query?: Record<string, ProtocolJsonValue>;
  /** 请求体编码，缺省为 JSON。multipart 文件只接受受控的 data URL 声明。 */
  bodyEncoding?: ModelProtocolBodyEncoding;
  body?: ProtocolJsonValue;
}

export type ModelProtocolPollBackoff = 'fixed' | 'linear' | 'exponential';

export interface ModelProtocolPollRetryConfig {
  /** 仅状态查询可重试的 HTTP 状态码。 */
  httpStatuses?: number[];
  /** 连续查询错误最多重试次数，默认 3。 */
  maxRetries?: number;
  backoff?: ModelProtocolPollBackoff;
  /** 退避或 Retry-After 允许的最大等待时间。 */
  maxDelayMs?: number;
  /** 是否遵循响应中的 Retry-After，默认 true。 */
  honorRetryAfter?: boolean;
  /** 是否重试瞬时网络错误，默认 true。 */
  retryNetworkErrors?: boolean;
}

export interface ModelProtocolResultConfig {
  urlPath?: string;
  textPath?: string;
  base64Path?: string;
  mimeType?: string;
}

export interface ModelProtocolResponseConfig {
  type: ModelProtocolResponseType;
  /** 异步提交响应中的任务 ID 路径。 */
  taskIdPath?: string;
  result?: ModelProtocolResultConfig;
  errorPath?: string;
}

export interface ModelProtocolPollResponseConfig {
  statusPath: string;
  successValues: string[];
  failureValues: string[];
  result: ModelProtocolResultConfig;
  errorPath?: string;
  progressPath?: string;
}

/** version 1 兼容输入；不再作为新协议的写入格式。 */
export interface LegacyModelProtocolPollTemplate extends ModelProtocolRequestTemplate {
  statusPath: string;
  successValues: string[];
  failureValues: string[];
  resultUrlPath?: string;
  resultTextPath?: string;
  resultBase64Path?: string;
  resultMimeType?: string;
  errorPath?: string;
  progressPath?: string;
  intervalMs?: number;
  maxAttempts?: number;
  maxDurationMs?: number;
  retry?: ModelProtocolPollRetryConfig;
}

export interface ModelProtocolPollTemplate extends ModelProtocolRequestTemplate {
  response: ModelProtocolPollResponseConfig;
  intervalMs?: number;
  maxAttempts?: number;
  maxDurationMs?: number;
  retry?: ModelProtocolPollRetryConfig;
}

export interface ModelExecutionProtocolV1 {
  version: 1;
  mode: 'sync' | 'async';
  /** 缺省为 Bearer，保持旧配置兼容。 */
  auth?: ModelProtocolAuthConfig;
  /** 对话助手仅接受显式声明的 OpenAI SSE 兼容流。 */
  streamFormat?: 'openai-sse';
  submit: ModelProtocolRequestTemplate;
  /** 同步响应类型，缺省为 JSON；异步协议固定使用 JSON。 */
  responseType?: ModelProtocolResponseType;
  /** 同步协议的结果 URL 路径。 */
  resultUrlPath?: string;
  /** 同步文本协议的结果文本路径。 */
  resultTextPath?: string;
  /** 同步 JSON 响应中的 Base64 媒体路径。 */
  resultBase64Path?: string;
  /** Base64 结果或无 Content-Type 二进制响应使用的 MIME 类型。 */
  resultMimeType?: string;
  /** 提交响应或 HTTP 错误响应中的错误详情路径。 */
  errorPath?: string;
  /** 异步协议用于记录远端任务身份的提交响应路径。 */
  taskIdPath?: string;
  poll?: LegacyModelProtocolPollTemplate;
}

export interface ModelExecutionProtocolV2 {
  version: 2;
  mode: 'sync' | 'async';
  /** 缺省为 Bearer，保持旧配置兼容。 */
  auth?: ModelProtocolAuthConfig;
  /** 对话助手仅接受显式声明的 OpenAI SSE 兼容流。 */
  streamFormat?: 'openai-sse';
  submit: ModelProtocolRequestTemplate;
  response: ModelProtocolResponseConfig;
  poll?: ModelProtocolPollTemplate;
}

export type ModelExecutionProtocol = ModelExecutionProtocolV1 | ModelExecutionProtocolV2;

/** parser、编辑器与执行器统一使用的规范协议。 */
export type NormalizedModelExecutionProtocol = ModelExecutionProtocolV2;

export type ModelProtocolPresetId = 'openai-chat' | 'openai-image' | 'agnes-video' | 'custom';

export interface ModelExecutionProfile {
  preset: ModelProtocolPresetId;
  /** preset=custom 时保存用户声明的协议。 */
  protocol?: ModelExecutionProtocol;
}

/** 异步任务提交后解析出的轮询描述；不包含 API Key。 */
export interface ResolvedModelProtocolPoll {
  method: ModelProtocolHttpMethod;
  url: string;
  /** 只保存鉴权方式，不保存密钥。 */
  auth?: ModelProtocolAuthConfig;
  headers?: Record<string, string>;
  bodyEncoding?: Exclude<ModelProtocolBodyEncoding, 'multipart'>;
  body?: ProtocolJsonValue;
  statusPath: string;
  successValues: string[];
  failureValues: string[];
  resultUrlPath?: string;
  resultTextPath?: string;
  resultBase64Path?: string;
  resultMimeType?: string;
  errorPath?: string;
  progressPath?: string;
  intervalMs: number;
  maxAttempts?: number;
  maxDurationMs?: number;
  retry?: ModelProtocolPollRetryConfig;
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

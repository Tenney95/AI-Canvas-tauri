/**
 * AI 执行层共享类型，覆盖生成参数、模型协议、轮询映射以及各媒体结果结构。
 */
export interface AIGenerateParams {
  prompt: string;
  model: string;      // model value (e.g. 'ppio/qwen/qwen3.5-397b-a17b')
  provider: string;   // provider id (e.g. 'ppio')
  /** 关联的节点 ID（用于中断恢复） */
  nodeId?: string;
  /** 追加到消息末尾的图片；文本/VLM 请求统一转换为受限 Base64 data URL。 */
  imageUrls?: string[];
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
  /** 对 Base64 原始媒体执行受控容器封装。 */
  base64Transform?: {
    type: 'pcm-s16le-to-wav';
    sampleRate: number;
    channels?: number;
  };
  /** 使用当前协议鉴权下载同源 URL，并将结果归一化为 data URL。 */
  fetchUrl?: boolean;
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

/**
 * 视频生成模型的能力声明，用于在参数面板与生成入口里按模型约束
 * 时长 / 分辨率 / 比例 / 参考素材等，替代「全局 2~15s + 通用分辨率」的兜底。
 * 字段语义与内置 Seedance 能力表（apimartVideoModels）对齐，便于同一套 UI 消费。
 */
export interface VideoModelCapability {
  /** 可选分辨率档位，如 ['480p', '720p', '1080p']。 */
  resolutions?: string[];
  /** 未指定分辨率时的默认值。 */
  defaultResolution?: string;
  /** 可选宽高比，如 ['16:9', '9:16', '1:1', 'adaptive']。 */
  ratios?: string[];
  /** 未指定比例时的默认值。 */
  defaultRatio?: string;
  /** 可选帧率档位，如 [16, 24, 30]。 */
  frameRates?: number[];
  /** 未指定帧率时的默认值。 */
  defaultFrameRate?: number;
  /**
   * 只允许这几个时长（秒）。文档写「仅支持 10 或 15 秒」这类离散取值时用它，
   * min/max 表达不了中间不可取（10~15 会放过 12，接口仍会 400）。
   */
  durations?: number[];
  /** 时长下限（秒）。 */
  minDuration?: number;
  /** 时长上限（秒）。 */
  maxDuration?: number;
  /** 未指定时长时的默认值（秒）。 */
  defaultDuration?: number;
  /** 是否支持生成音频（有声视频）。 */
  supportsAudio?: boolean;
  /** 是否支持纯音频参考（无图/视频）。 */
  supportsStandaloneAudio?: boolean;
  /** 参考图数量上限。 */
  maxImageReferences?: number;
  /** 参考视频数量上限。 */
  maxVideoReferences?: number;
  /** 参考音频数量上限。 */
  maxAudioReferences?: number;
}

/**
 * 图片生成模型的能力声明，用于按模型约束分辨率 / 比例 / 批量数量 / 参考图等，
 * 替代「全局 2K + 1:1」的兜底。字段语义与内置 APIMart 生图能力表对齐，
 * 便于同一套参数面板与生成入口消费。
 */
export interface ImageModelCapability {
  /** 可选分辨率档位，如 ['1K', '2K', '4K'] 或 ['1MP', '2MP']。 */
  resolutions?: string[];
  /** 未指定分辨率时的默认值。 */
  defaultResolution?: string;
  /** 可选宽高比，如 ['1:1', '16:9', '9:16', 'auto']。 */
  ratios?: string[];
  /** 未指定比例时的默认值。 */
  defaultRatio?: string;
  /** 是否支持批量生成（n > 1）。不支持时生成入口应把数量钳制为 1。 */
  supportsBatch?: boolean;
  /** 单次批量数量上限（supportsBatch 为 true 时生效）。 */
  maxBatchCount?: number;
  /** 是否支持图生图 / 参考图（image_urls）。false 时传入参考图应报错而非静默丢弃。 */
  supportsImageReference?: boolean;
  /** 参考图数量上限（supportsImageReference 为 true 时生效）。 */
  maxImageReferences?: number;
  /** 参考图是否支持 Base64 data URI（false 表示仅支持公网 URL）。 */
  supportsDataUrlReference?: boolean;
  /** 分辨率字段名（不同模型可能用 resolution / 无此字段 / 其他）。 */
  resolutionField?: string;
  /** 是否在请求体中输出分辨率字段（部分模型如 Imagen 4.0 / Grok 无 resolution）。 */
  hasResolutionField?: boolean;
}

/**
 * 音频生成模型的能力声明，用于按模型约束音色 / 输出格式 / 参考音频等。
 * APIMart 目前只有 speech（TTS）与 music（Flow Music）两类，字段对齐各自协议。
 */
export interface AudioModelCapability {
  /** 能力类型：speech = 语音合成（TTS），music = 音乐生成（Flow Music）。 */
  kind: 'speech' | 'music';
  /** 支持的音色列表（仅 speech 生效）。 */
  voices?: string[];
  /** 是否支持音色参考（连入的音频作为音色克隆）。当前 APIMart 两类均不支持。 */
  supportsVoiceReference?: boolean;
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
  resultBase64Transform?: ModelProtocolResultConfig['base64Transform'];
  resultFetchUrl?: boolean;
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

export type VideoGenerationOperation =
  | 'text-to-video'
  | 'image-to-video'
  | 'video-to-video';

export type MediaReferenceKind = 'image' | 'video' | 'audio';

export type MediaReferenceOrigin = 'prompt' | 'connection';

export type MediaReferenceRole =
  | 'reference'
  | 'first_frame'
  | 'last_frame'
  | 'reference_audio';

/** 视频节点上手动挑选的参考图：参考帧（首/中/尾）或参考角色，来源可以是连线节点或角色库。 */
export interface VideoReferenceItem {
  /** 连线节点用节点 ID，角色库用 `character:<角色 ID>` */
  id: string;
  url: string;
  label?: string;
  /** frame = 参考帧；character = 参考角色（按普通参考图提交） */
  kind: 'frame' | 'character';
  role: 'first_frame' | 'last_frame' | 'reference';
  sourceNodeId?: string;
}

/**
 * 画布生成入口统一使用的参考媒体描述。
 * url 用于本地展示或本地工作流；远端模型优先使用仍然可访问的 sourceUrl。
 */
export interface MediaReference {
  kind: MediaReferenceKind;
  url: string;
  origin: MediaReferenceOrigin;
  role: MediaReferenceRole;
  sourceNodeId?: string;
  filePath?: string;
  sourceUrl?: string;
}

export interface VideoGenerationReferenceInput {
  prompt: string;
  imageUrls: string[];
  videoUrls: string[];
  audioUrls: string[];
  operation: VideoGenerationOperation;
  /** 新入口始终提供；可选仅用于兼容已有 Provider adapter 和测试夹具。 */
  references?: MediaReference[];
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
  /**
   * 调用方直接给定的参考媒体，排在提示词引用与连线引用之前。
   * 供画布之外的入口使用，例如剪辑窗口按首/尾帧生成 AI 转场。
   */
  referenceMedia?: MediaReference[];
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

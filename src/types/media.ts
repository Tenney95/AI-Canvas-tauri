/** 对话助手媒体生成领域类型。 */
import type { AudioOutputFormat, AudioTtsVoice } from './aiTypes';

export type MediaKind = 'image' | 'video' | 'audio';

export type AudioGenerationPurpose = 'music' | 'speech';

export type MediaDeliveryMode = 'chat' | 'canvas' | 'both';
/** 新媒体回执只保存原目的地身份，不保存请求正文或凭据。 */
export interface NativeMediaOrigin {
  conversationId: string;
  messageId: string;
  agentTaskId?: string;
  modelId?: string;
  deliveryMode: MediaDeliveryMode;
}
export interface NativeMediaLocalResult { relativePath: string; bytes: number; sha256: string }
/** 完整的原作业产物集合；序号是投递身份，不能用请求数量截断。 */
export interface NativeMediaLocalOutput extends NativeMediaLocalResult { category: MediaKind }
export interface NativeMediaCompletion {
  taskCount: number; failedTasks: number;
  failedSubmissions?: number; unknownSubmissions?: number; notStartedSubmissions?: number;
}
/** 不可变查询合同身份；分阶段提交意图由对应原生 sidecar 单独保留。 */
export interface NativeMediaRecoveryBinding {
  kind: 'general-protocol' | 'workflow' | 'builtin-audio' | 'builtin-image' | 'builtin-video';
  workflowId?: string;
  modelId?: string;
  serverId?: string;
  digest?: string;
  expectedCount?: number;
}
export interface NativeApimartImageBatch {
  version: 1;
  requestedCount: number;
  submissions: Array<{ id: string; state: 'prepared' | 'unknown' | 'submitted' | 'not-started' | 'failed'; taskIds: string[] }>;
  tasks: Array<{ taskId: string; state: 'submitted' | 'completed' | 'failed'; results?: NativeMediaLocalResult[] }>;
  uncertainAcknowledged?: true;
}

/** 用户显式选择或审批前锁定的媒体参数；不包含提示词、素材和凭据。 */
export interface MediaGenerationParameters {
  aspectRatio?: string;
  resolution?: string;
  duration?: number;
  imageQuality?: string;
  imageBackground?: string;
  videoFps?: number;
  generateAudio?: boolean;
}

export interface MediaGenerationIntent extends MediaGenerationParameters {
  kind: MediaKind;
  prompt: string;
  /** GeneralModelConfig.id 或供应商模型 value。 */
  modelRef?: string;
  deliveryMode: MediaDeliveryMode;
  /** 音频生成时用于区分音乐与语音，底层仍复用音频节点执行能力。 */
  audioPurpose?: AudioGenerationPurpose;
  /** 音色 ID、格式和速度由所选音频模型在提交前校验。 */
  audioVoice?: AudioTtsVoice;
  audioFormat?: AudioOutputFormat;
  audioSpeed?: number;
  musicTitle?: string;
  musicLyrics?: string;
  /** 云工作流按节点/字段映射的本轮参数。 */
  workflowInputs?: Record<string, string>;
  runninghubModelParameters?: Record<string, string>;
}

export type MediaGenerationStatus =
  | 'queued'
  | 'generating'
  | 'paused'
  | 'submit_unknown'
  | 'succeeded'
  | 'failed';

export type CanvasMaterializationStatus =
  | 'none'
  | 'pending'
  | 'created'
  | 'failed';

/**
 * 产物落盘状态，与「生成成功」严格区分：
 * - saved：已写入项目数据目录，url 指向本地文件；
 * - skipped：无项目或非桌面端，本就不该落盘；
 * - failed：生成已完成但没能保存，url 仍是签名地址或 blob 等临时地址，重启后可能失效。
 */
export type MediaPersistenceStatus = 'saved' | 'skipped' | 'failed';

export interface MediaGenerationResult {
  parameters?: MediaGenerationParameters;
  /** 异步生成的交付回执；只有保存及目标回填成功后才能确认。 */
  taskReceipt?: import('./aiTypes').MediaTaskReceipt;
  workflowApiOutputs?: import('./workflowApi').CloudWorkflowOutput[];
  workflowApiTaskId?: string;
  runninghubOutputs?: import('./runninghub').RunningHubOutput[];
  id: string;
  kind: MediaKind;
  deliveryMode: MediaDeliveryMode;
  /** 优先为项目本地 asset URL；Web 模式或落盘失败时为 sourceUrl。 */
  url: string;
  sourceUrl: string;
  filePath?: string;
  /** 落盘状态；failed 时 url 是临时地址，需要提示用户重试保存。 */
  persistence: MediaPersistenceStatus;
  /** persistence 为 failed 时的原因。 */
  persistError?: string;
  prompt: string;
  modelId: string;
  provider: string;
  width?: number;
  height?: number;
  audioPurpose?: AudioGenerationPurpose;
  createdAt: number;
}

/** 仅在本轮交付中携带同一作业的其他候选；拆成独立消息后才持久化。 */
export interface MediaGenerationDelivery extends MediaGenerationResult {
  additionalResults?: MediaGenerationResult[];
  expectedOutputCount?: number;
}

export interface ResolvedMediaModel {
  configId: string;
  requestModel: string;
  provider: string;
  audioPurpose?: AudioGenerationPurpose;
  /** 选中的是 ComfyUI 工作流时带上，生成入口据此走本地工作流 */
  workflowId?: string;
}

/** 对话助手媒体生成领域类型。 */
export type MediaKind = 'image' | 'video' | 'audio';

export type AudioGenerationPurpose = 'music' | 'speech';

export type MediaDeliveryMode = 'chat' | 'canvas' | 'both';

export interface MediaGenerationIntent {
  kind: MediaKind;
  prompt: string;
  /** GeneralModelConfig.id 或供应商模型 value。 */
  modelRef?: string;
  deliveryMode: MediaDeliveryMode;
  /** 音频生成时用于区分音乐与语音，底层仍复用音频节点执行能力。 */
  audioPurpose?: AudioGenerationPurpose;
  /** 审批前锁定的视频有效参数；缺省表示沿用模型默认。 */
  aspectRatio?: string;
  resolution?: string;
  duration?: number;
  /** 云工作流按节点/字段映射的本轮参数。 */
  workflowInputs?: Record<string, string>;
}

export type MediaGenerationStatus =
  | 'queued'
  | 'generating'
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

export interface ResolvedMediaModel {
  configId: string;
  requestModel: string;
  provider: string;
  audioPurpose?: AudioGenerationPurpose;
  /** 选中的是 ComfyUI 工作流时带上，生成入口据此走本地工作流 */
  workflowId?: string;
}

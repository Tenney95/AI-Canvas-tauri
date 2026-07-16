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

export interface MediaGenerationResult {
  id: string;
  kind: MediaKind;
  deliveryMode: MediaDeliveryMode;
  /** 优先为项目本地 asset URL；Web 模式或落盘失败时为 sourceUrl。 */
  url: string;
  sourceUrl: string;
  filePath?: string;
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
}

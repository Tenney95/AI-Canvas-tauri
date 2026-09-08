/**
 * 定义图片、视频和音频 Provider Adapter 契约，并按能力注册和解析媒体执行适配器。
 */
import type {
  AIAudioGenParams,
  AIImageGenParams,
  AIVideoGenParams,
  AudioGenerationResult,
  BatchImageResult,
  VideoGenerationReferenceInput,
} from '../../types/aiTypes';
import { apimartMediaProviderAdapter } from './providers/apimartMedia';
import { runninghubMediaProviderAdapter } from './providers/runninghubMedia';

export type MediaProviderCapability = 'image' | 'video' | 'audio';

export interface ImageProviderRequest {
  params: AIImageGenParams;
  prompt: string;
  imageUrls: string[];
  referenceMedia?: import('../../types/aiTypes').MediaReference[];
  requestedCount: number;
  signal?: AbortSignal;
}

export interface VideoProviderRequest {
  params: AIVideoGenParams;
  prompt: string;
  resolveReferenceInput: () => Promise<VideoGenerationReferenceInput>;
  signal?: AbortSignal;
}

export interface AudioProviderRequest {
  params: AIAudioGenParams;
  prompt: string;
  /** 连入该节点的音频（角色库绑定的声音走这条线）；能吃音色参考的 adapter 自行映射 */
  referenceAudioUrls: string[];
  referenceMedia?: import('../../types/aiTypes').MediaReference[];
  signal?: AbortSignal;
}

export interface MediaProviderAdapter {
  providerId: string;
  capabilities: readonly MediaProviderCapability[];
  generateImage?: (request: ImageProviderRequest) => Promise<BatchImageResult>;
  generateVideo?: (request: VideoProviderRequest) => Promise<{ url: string; runninghubOutputs?: import('../../types/runninghub').RunningHubOutput[] }>;
  generateAudio?: (request: AudioProviderRequest) => Promise<AudioGenerationResult>;
}

export type ImageMediaProviderAdapter = MediaProviderAdapter & Required<
  Pick<MediaProviderAdapter, 'generateImage'>
>;
export type VideoMediaProviderAdapter = MediaProviderAdapter & Required<
  Pick<MediaProviderAdapter, 'generateVideo'>
>;
export type AudioMediaProviderAdapter = MediaProviderAdapter & Required<
  Pick<MediaProviderAdapter, 'generateAudio'>
>;

const HANDLER_BY_CAPABILITY = {
  image: 'generateImage',
  video: 'generateVideo',
  audio: 'generateAudio',
} as const satisfies Record<MediaProviderCapability, keyof MediaProviderAdapter>;

function validateAdapter(adapter: MediaProviderAdapter): void {
  if (!adapter.providerId.trim()) throw new Error('媒体 Provider ID 不能为空');
  const capabilities = new Set(adapter.capabilities);
  if (capabilities.size !== adapter.capabilities.length) {
    throw new Error(`媒体 Provider "${adapter.providerId}" 存在重复 capability`);
  }
  for (const capability of Object.keys(HANDLER_BY_CAPABILITY) as MediaProviderCapability[]) {
    const hasHandler = typeof adapter[HANDLER_BY_CAPABILITY[capability]] === 'function';
    if (capabilities.has(capability) !== hasHandler) {
      throw new Error(
        `媒体 Provider "${adapter.providerId}" 的 ${capability} capability 与 handler 不一致`,
      );
    }
  }
}

export class MediaProviderRegistry {
  private readonly adapters = new Map<string, MediaProviderAdapter>();

  constructor(adapters: readonly MediaProviderAdapter[] = []) {
    for (const adapter of adapters) this.register(adapter);
  }

  register(adapter: MediaProviderAdapter): () => void {
    validateAdapter(adapter);
    if (this.adapters.has(adapter.providerId)) {
      throw new Error(`媒体 Provider "${adapter.providerId}" 已注册`);
    }
    this.adapters.set(adapter.providerId, adapter);
    return () => {
      if (this.adapters.get(adapter.providerId) === adapter) {
        this.adapters.delete(adapter.providerId);
      }
    };
  }

  supports(providerId: string, capability: MediaProviderCapability): boolean {
    return this.adapters.get(providerId)?.capabilities.includes(capability) === true;
  }

  getImageAdapter(providerId: string): ImageMediaProviderAdapter | undefined {
    const adapter = this.adapters.get(providerId);
    return adapter?.generateImage ? adapter as ImageMediaProviderAdapter : undefined;
  }

  getVideoAdapter(providerId: string): VideoMediaProviderAdapter | undefined {
    const adapter = this.adapters.get(providerId);
    return adapter?.generateVideo ? adapter as VideoMediaProviderAdapter : undefined;
  }

  getAudioAdapter(providerId: string): AudioMediaProviderAdapter | undefined {
    const adapter = this.adapters.get(providerId);
    return adapter?.generateAudio ? adapter as AudioMediaProviderAdapter : undefined;
  }
}

export const mediaProviderRegistry = new MediaProviderRegistry([
  apimartMediaProviderAdapter,
  runninghubMediaProviderAdapter,
]);

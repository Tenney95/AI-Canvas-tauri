/** Muse 网页生成别名与应用提交边界；参数仅作为提示词目标，不保证上游成片规格。 */
import type { ProviderModelSelection } from '../../types';
import type { ImageModelCapability, VideoModelCapability } from '../../types/aiTypes';

export const MUSE_BASE_URL = 'https://muse.ai';
export const MUSE_TEXT_MODEL = 'muse-chat';
export const MUSE_IMAGE_MODEL = 'muse-image';
export const MUSE_VIDEO_MODEL = 'muse-video';
export const MUSE_MAX_IMAGE_REFERENCES = 4;

export const MUSE_IMAGE_CAPABILITY: ImageModelCapability = {
  ratios: ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3'],
  defaultRatio: '1:1',
  hasResolutionField: false,
  supportsBatch: false,
  maxBatchCount: 1,
  supportsImageReference: true,
  maxImageReferences: MUSE_MAX_IMAGE_REFERENCES,
  supportsDataUrlReference: true,
};

export const MUSE_VIDEO_CAPABILITY: VideoModelCapability = {
  operations: ['text-to-video', 'image-to-video'],
  ratios: ['16:9', '9:16'],
  defaultRatio: '16:9',
  durations: [5, 6, 8, 10],
  defaultDuration: 5,
  maxImageReferences: MUSE_MAX_IMAGE_REFERENCES,
  maxVideoReferences: 0,
  maxAudioReferences: 0,
  supportsStandaloneAudio: false,
};

export const MUSE_MODEL_MANIFEST: readonly ProviderModelSelection[] = [
  {
    id: MUSE_TEXT_MODEL, name: 'Muse 对话', category: 'text', provider: 'muse',
    description: '通过 Muse 网页进行普通文本与看图对话；不支持工具调用',
    inputModalities: ['text', 'image'],
  },
  {
    id: MUSE_IMAGE_MODEL, name: 'Muse 图片', category: 'image', provider: 'muse',
    description: '通过 Muse 网页生成或编辑图片；比例为提示词目标，分辨率由上游决定',
    imageCapability: MUSE_IMAGE_CAPABILITY,
  },
  {
    id: MUSE_VIDEO_MODEL, name: 'Muse 视频', category: 'video', provider: 'muse',
    description: '通过 Muse 网页生成视频；支持图片参考，比例和时长为提示词目标',
    videoCapability: MUSE_VIDEO_CAPABILITY,
  },
];

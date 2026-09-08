import type { VideoModelCapability } from '../../types/aiTypes';
import type { WorkflowApiManifest } from '../../types/workflowApi';

export const AUTODL_BASE_URL = 'https://autodl.art';
export function normalizeWorkflowApiBaseUrl(value?: string): string {
  let url: URL;
  try { url = new URL(value?.trim() || AUTODL_BASE_URL); }
  catch { throw new Error('工作流 API 连接地址无效'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash
    || !['', '/'].includes(url.pathname)) throw new Error('工作流 API 连接请填写站点根地址');
  return url.origin;
}
export const AUTODL_H3_WORKFLOW = {
  id: 'minimax_h3_zm_u24',
  name: 'H3 多图多音频生视频（升级画质）',
  prompt: { min: 1, max: 10000 },
  images: { min: 1, max: 9, fieldPrefix: 'ref_image_', extensions: ['jpg', 'jpeg', 'png', 'webp'], mimeTypes: ['image/jpeg', 'image/png', 'image/webp'] },
  audio: { min: 0, max: 3, fieldPrefix: 'ref_audio_', extensions: ['mp3', 'wav', 'mp4', 'flac'], mimeTypes: ['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav', 'audio/mp4', 'video/mp4', 'audio/flac', 'audio/x-flac'] },
  capability: {
    operations: ['image-to-video'], minDuration: 1, maxDuration: 15, defaultDuration: 5,
    resolutions: ['480p', '768p'], defaultResolution: '768p',
    ratios: ['9:16', '16:9', '1:1'], defaultRatio: '9:16',
    maxImageReferences: 9, maxAudioReferences: 3, maxVideoReferences: 0,
  } satisfies VideoModelCapability,
  resolutionSuffix: { '9:16': '竖', '16:9': '横', '1:1': '(1:1)' } as Record<string, string>,
  submitPath: '/api/v1/comfyui/comfyui_workflow/minimax_h3_zm_u24',
  queryPath: '/api/v1/comfyui/comfyui_workflow/result/',
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function resolveWorkflowApiInputValues(values: unknown = {}) {
  if (!isRecord(values) || Object.keys(values).some((key) => !['duration', 'resolution', 'ratio', 'seed'].includes(key))) {
    throw new Error('工作流包含不支持的输入参数');
  }
  const capability = AUTODL_H3_WORKFLOW.capability;
  const duration = values.duration === undefined ? capability.defaultDuration : values.duration;
  const resolution = values.resolution === undefined ? capability.defaultResolution : values.resolution;
  const ratio = values.ratio === undefined ? capability.defaultRatio : values.ratio;
  const seed = values.seed;
  if (typeof duration !== 'number' || !Number.isInteger(duration) || duration < capability.minDuration || duration > capability.maxDuration) throw new Error('视频时长必须是 1–15 秒的整数');
  if (typeof resolution !== 'string' || !capability.resolutions.includes(resolution)) throw new Error('工作流分辨率只支持 480p 或 768p');
  if (typeof ratio !== 'string' || !capability.ratios.includes(ratio)) throw new Error('工作流比例只支持竖屏、横屏或 1:1');
  if (seed !== undefined && (typeof seed !== 'number' || !Number.isSafeInteger(seed))) throw new Error('随机种子必须是安全整数');
  return { duration, resolution, ratio, ...(seed !== undefined ? { seed } : {}) };
}

export function validateWorkflowApiManifest(value: unknown): asserts value is WorkflowApiManifest {
  const keys = ['version', 'adapter', 'workflowId', 'connectionId', 'defaults'];
  if (!isRecord(value) || Object.keys(value).some((key) => !keys.includes(key))
    || value.version !== 1 || value.adapter !== 'autodl-comfyui'
    || value.workflowId !== AUTODL_H3_WORKFLOW.id
    || typeof value.connectionId !== 'string' || !/^[\w:-]{1,120}$/.test(value.connectionId)) {
    throw new Error('工作流 API 定义无效或尚未支持，请重新选择工作流模板');
  }
  if (value.defaults !== undefined) {
    if (!isRecord(value.defaults)) throw new Error('工作流默认参数无效');
    resolveWorkflowApiInputValues(value.defaults);
  }
}

export function createAutodlH3WorkflowManifest(connectionId: string): WorkflowApiManifest {
  const manifest: WorkflowApiManifest = { version: 1, adapter: 'autodl-comfyui', workflowId: AUTODL_H3_WORKFLOW.id, connectionId };
  validateWorkflowApiManifest(manifest);
  return manifest;
}

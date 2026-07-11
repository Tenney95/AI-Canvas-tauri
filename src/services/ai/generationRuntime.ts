/**
 * 对话媒体生成统一入口。
 * ChatPanel 不再直接选择 Provider 或调用具体图片、视频服务。
 */
import { useAppStore } from '../../store/useAppStore';
import { downloadUrlAndSave, saveDataUrlToProjectData } from '../fileService';
import type {
  MediaGenerationIntent,
  MediaGenerationResult,
  MediaKind,
  ResolvedMediaModel,
} from '../../types/media';
import { generateImage } from './generateImage';
import { generateVideo } from './generateVideo';
import { findMediaModelOption } from '../../components/nodes/shared/defaultModels';

const MODEL_MENTION_RE = /@model\{([^|}\s]+)(?:\|[^}]*)?\}/i;

export function extractModelMention(input: string): string | undefined {
  return MODEL_MENTION_RE.exec(input)?.[1]?.trim() || undefined;
}

export function stripModelMentions(input: string): string {
  return input.replace(new RegExp(MODEL_MENTION_RE.source, 'gi'), '').replace(/\s{2,}/g, ' ').trim();
}

export function resolveMediaModel(kind: MediaKind, modelRef?: string): ResolvedMediaModel {
  const config = useAppStore.getState().config;
  if (!modelRef) {
    throw new Error(`请先通过 @ 选择${kind === 'image' ? '图片' : '视频'}模型`);
  }

  const option = findMediaModelOption(modelRef, config.generalModels ?? []);
  if (!option) throw new Error('未找到 @ 引用的媒体模型');
  if (option.mediaKind !== kind) {
    throw new Error(`模型“${option.label}”不能用于${kind === 'image' ? '图片' : '视频'}生成`);
  }

  if (option.provider === 'general') {
    const generalId = option.value.slice('general/'.length);
    const generalModel = (config.generalModels ?? []).find((model) => model.id === generalId);
    if (!generalModel) throw new Error('未找到 @ 引用的通用模型配置');
    if (!generalModel.openaiUrl || !generalModel.modelId) {
      throw new Error(`模型“${generalModel.name}”的接口配置不完整`);
    }
    return {
      configId: option.value,
      requestModel: `general/${generalModel.id}`,
      provider: 'general',
    };
  }

  if (option.provider === 'dreamina') {
    if (!config.dreaminaAuth?.loggedIn) throw new Error('请先登录即梦账号');
  } else if (!config.providers[option.provider]?.apiKey) {
    throw new Error(`请先配置 ${option.provider} 的 API Key`);
  }

  return {
    configId: option.value,
    requestModel: option.value,
    provider: option.provider,
  };
}

async function saveGeneratedMedia(
  url: string,
  projectId: string | null | undefined,
  kind: MediaKind,
  artifactId: string,
) {
  if (!projectId) return null;
  if (url.startsWith('data:')) {
    const extension = kind === 'image' ? 'png' : 'mp4';
    return saveDataUrlToProjectData(url, projectId, `对话${kind === 'image' ? '图片' : '视频'}-${artifactId}.${extension}`);
  }
  return downloadUrlAndSave(
    url,
    projectId,
    kind === 'image' ? 'ai-image' : 'ai-video',
    `对话${kind === 'image' ? '图片' : '视频'}-${artifactId}`,
  );
}

export async function runMediaGeneration(
  intent: MediaGenerationIntent,
  projectId?: string | null,
  signal?: AbortSignal,
): Promise<MediaGenerationResult> {
  if (signal?.aborted) throw new DOMException('请求已取消', 'AbortError');

  const prompt = stripModelMentions(intent.prompt);
  if (!prompt) throw new Error('媒体生成提示词不能为空');

  const model = resolveMediaModel(intent.kind, intent.modelRef);
  const id = `media-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  if (intent.kind === 'image') {
    const result = await generateImage({
      prompt,
      model: model.requestModel,
      provider: model.provider,
      imageSize: '2K',
      aspectRatio: '1:1',
    });
    const saved = await saveGeneratedMedia(result.url, projectId, intent.kind, id).catch(() => null);
    return {
      id,
      kind: intent.kind,
      deliveryMode: intent.deliveryMode,
      url: saved?.assetUrl || result.url,
      sourceUrl: result.url,
      filePath: saved?.filePath,
      width: result.width,
      height: result.height,
      prompt,
      modelId: model.configId,
      provider: model.provider,
      createdAt: Date.now(),
    };
  }

  const result = await generateVideo({
    prompt,
    model: model.requestModel,
    provider: model.provider,
  });
  const saved = await saveGeneratedMedia(result.url, projectId, intent.kind, id).catch(() => null);
  return {
    id,
    kind: intent.kind,
    deliveryMode: intent.deliveryMode,
    url: saved?.assetUrl || result.url,
    sourceUrl: result.url,
    filePath: saved?.filePath,
    prompt,
    modelId: model.configId,
    provider: model.provider,
    createdAt: Date.now(),
  };
}

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
import { generateAudio, persistAudioGenerationResult } from './generateAudio';
import { findMediaModelOption } from '../../components/nodes/shared/defaultModels';
import { resolveProjectGenerationPrompt } from '../projectSettingsService';
import type { BaseNodeData, NodeType } from '../../types';

const MODEL_MENTION_RE = /@model\{([^|}\s]+)(?:\|[^}]*)?\}/i;

const MEDIA_NODE_TYPES: Record<MediaKind, NodeType> = {
  image: 'ai-image',
  video: 'ai-video',
  audio: 'ai-audio',
};

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('请求已取消', 'AbortError');
}

export function extractModelMention(input: string): string | undefined {
  return MODEL_MENTION_RE.exec(input)?.[1]?.trim() || undefined;
}

export function stripModelMentions(input: string): string {
  return input.replace(new RegExp(MODEL_MENTION_RE.source, 'gi'), '').replace(/\s{2,}/g, ' ').trim();
}

export function resolveMediaModel(kind: MediaKind, modelRef?: string): ResolvedMediaModel {
  const config = useAppStore.getState().config;
  if (!modelRef) {
    const label = kind === 'image' ? '图片' : kind === 'video' ? '视频' : '音频';
    throw new Error(`请先通过 @ 选择${label}模型`);
  }

  const option = findMediaModelOption(modelRef, config.generalModels ?? [], config);
  if (!option) throw new Error('未找到 @ 引用的媒体模型');
  if (option.mediaKind !== kind) {
    const label = kind === 'image' ? '图片' : kind === 'video' ? '视频' : '音频';
    throw new Error(`模型“${option.label}”不能用于${label}生成`);
  }

  if (option.provider === 'general') {
    const generalId = option.value.slice('general/'.length);
    const generalModel = (config.generalModels ?? []).find((model) => model.id === generalId);
    if (!generalModel) throw new Error('未找到 @ 引用的通用模型配置');
    const provider = config.providers[generalModel.providerConfigId];
    if (!provider?.baseUrl || !generalModel.modelId) {
      throw new Error(`模型“${generalModel.name}”的接口配置不完整`);
    }
    return {
      configId: option.value,
      requestModel: `general/${generalModel.id}`,
      provider: 'general',
      audioPurpose: option.audioPurpose,
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
    audioPurpose: option.audioPurpose,
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
    const extension = kind === 'image' ? 'png' : kind === 'video' ? 'mp4' : 'mp3';
    const label = kind === 'image' ? '图片' : kind === 'video' ? '视频' : '音频';
    return saveDataUrlToProjectData(url, projectId, `对话${label}-${artifactId}.${extension}`);
  }
  return downloadUrlAndSave(
    url,
    projectId,
    kind === 'image' ? 'ai-image' : kind === 'video' ? 'ai-video' : 'ai-audio',
    `对话${kind === 'image' ? '图片' : kind === 'video' ? '视频' : '音频'}-${artifactId}`,
  );
}

export async function runMediaGeneration(
  intent: MediaGenerationIntent,
  projectId?: string | null,
  signal?: AbortSignal,
): Promise<MediaGenerationResult> {
  throwIfAborted(signal);

  const prompt = stripModelMentions(intent.prompt);
  if (!prompt) throw new Error('媒体生成提示词不能为空');

  const store = useAppStore.getState();
  const targetProjectId = projectId ?? store.currentProjectId;
  const projectSettings = store.projects.find(
    (project) => project.id === targetProjectId,
  )?.settings;
  const effectivePrompt = resolveProjectGenerationPrompt({
    prompt,
    data: {
      label: '对话媒体生成',
      type: MEDIA_NODE_TYPES[intent.kind],
      role: 'generator',
    } as BaseNodeData,
    settings: projectSettings,
    customStyles: store.customStyles,
  });

  const model = resolveMediaModel(intent.kind, intent.modelRef);
  if (
    intent.kind === 'audio'
    && intent.audioPurpose
    && model.audioPurpose
    && intent.audioPurpose !== model.audioPurpose
  ) {
    throw new Error(`所选模型不支持${intent.audioPurpose === 'music' ? '音乐' : '语音'}生成`);
  }
  const id = `media-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  if (intent.kind === 'image') {
    const result = await generateImage({
      prompt: effectivePrompt,
      model: model.requestModel,
      provider: model.provider,
      imageSize: projectSettings?.generation?.imageSize || '2K',
      aspectRatio: projectSettings?.generation?.imageAspectRatio || '1:1',
    }, signal);
    throwIfAborted(signal);
    const saved = await saveGeneratedMedia(result.url, projectId, intent.kind, id).catch(() => null);
    throwIfAborted(signal);
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

  if (intent.kind === 'video') {
    const result = await generateVideo({
      prompt: effectivePrompt,
      model: model.requestModel,
      provider: model.provider,
      seedanceResolution: projectSettings?.generation?.videoResolution,
      seedanceDuration: projectSettings?.generation?.videoDuration,
    }, signal);
    throwIfAborted(signal);
    const saved = await saveGeneratedMedia(result.url, projectId, intent.kind, id).catch(() => null);
    throwIfAborted(signal);
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

  const result = await generateAudio({
    prompt: effectivePrompt,
    model: model.requestModel,
    provider: model.provider,
  }, signal);
  throwIfAborted(signal);
  const persisted = await persistAudioGenerationResult(
    result,
    projectId,
    `对话音频-${id}`,
  );
  throwIfAborted(signal);
  return {
    id,
    kind: intent.kind,
    deliveryMode: intent.deliveryMode,
    url: persisted.mediaUrl,
    sourceUrl: persisted.sourceUrl || persisted.outputUrl,
    filePath: persisted.filePath,
    prompt,
    modelId: model.configId,
    provider: model.provider,
    audioPurpose: intent.audioPurpose,
    createdAt: Date.now(),
  };
}

/**
 * ai/generationRuntime — 对话媒体生成统一入口。
 *
 * ChatPanel / Agent 工具不再直接选择 Provider 或调用具体图片、视频、音频服务，
 * 而是统一走 runMediaGeneration(intent)，由本模块完成：
 *   1. 解析并剥离 @model{...} 引用（extractModelMention / stripModelMentions）；
 *   2. 解析媒体模型（resolveMediaModel），统一校验模型类型、API Key、ComfyUI / 即梦等前置条件；
 *   3. 按 kind 分发到 generateImage / generateVideo / generateAudio；
 *   4. 产物落盘（persistGeneratedMedia），并如实区分「生成成功」与「已保存到项目」两种状态，
 *      失败不再被吞掉，避免签名 URL 过期或 blob 失效后留下打不开的产物。
 *
 * 产物落盘失败后可通过 retryMediaArtifactPersist 重新写盘。
 */
import { useAppStore } from '../../store/useAppStore';
import {
  downloadUrlAndSave,
  isTauriEnv,
  saveBinaryToProjectData,
  saveDataUrlToProjectData,
} from '../fileService';
import { comfyBaseUrlFor } from '../comfyServers';
import type {
  MediaGenerationIntent,
  MediaGenerationResult,
  MediaKind,
  MediaPersistenceStatus,
  ResolvedMediaModel,
} from '../../types/media';
import { generateImage } from './generateImage';
import { generateVideo } from './generateVideo';
import { generateAudio, persistAudioGenerationResult } from './generateAudio';
import { findMediaModelOption } from '../../components/nodes/shared/defaultModels';
import { videoLongSideFromLabel } from '../aiDimensions';
import { resolveProjectGenerationPrompt } from '../projectSettingsService';
import type { BaseNodeData, NodeType } from '../../types';
import { tagGeneratedProjectAssetSafely } from '../fs/generatedAssetTags';

const MODEL_MENTION_RE = /@model\{([^|}\s]+)(?:\|[^}]*)?\}/i;

const MEDIA_NODE_TYPES: Record<MediaKind, NodeType> = {
  image: 'ai-image',
  video: 'ai-video',
  audio: 'ai-audio',
};

const MEDIA_LABELS: Record<MediaKind, string> = {
  image: '图片',
  video: '视频',
  audio: '音频',
};

const MEDIA_FALLBACK_EXTENSIONS: Record<MediaKind, string> = {
  image: 'png',
  video: 'mp4',
  audio: 'mp3',
};

export const MEDIA_PERSIST_FAILED_MESSAGE = '产物未能写入项目目录，当前是临时地址，重启后可能失效';

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

  const option = findMediaModelOption(
    modelRef,
    config.generalModels ?? [],
    config,
    useAppStore.getState().workflows,
  );
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

  if (option.workflowId) {
    if (!comfyBaseUrlFor(option.workflowId)) {
      throw new Error('未配置 ComfyUI 服务地址\n请在「设置 → ComfyUI」中配置');
    }
    return {
      configId: option.value,
      requestModel: 'comfyui/workflow',
      provider: 'comfyui',
      workflowId: option.workflowId,
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
  projectId: string,
  kind: MediaKind,
  artifactId: string,
) {
  const baseName = `对话${MEDIA_LABELS[kind]}-${artifactId}`;
  const fileName = `${baseName}.${MEDIA_FALLBACK_EXTENSIONS[kind]}`;
  if (url.startsWith('data:')) {
    return saveDataUrlToProjectData(url, projectId, fileName);
  }
  // blob: 进不了原生下载通道，先在前端取回字节再落盘
  if (url.startsWith('blob:')) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`读取临时媒体数据失败：HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    return saveBinaryToProjectData(bytes, projectId, fileName);
  }
  return downloadUrlAndSave(url, projectId, MEDIA_NODE_TYPES[kind], baseName);
}

interface MediaPersistOutcome {
  status: MediaPersistenceStatus;
  filePath?: string;
  assetUrl?: string;
  error?: string;
}

/**
 * 落盘生成产物，并如实返回结果。
 * 失败不再被吞掉：调用方据此把「生成成功」和「已保存到项目」分开呈现，
 * 否则签名 URL 过期或 blob 失效后，用户手里就只剩一个打不开的产物。
 */
async function persistGeneratedMedia(
  url: string,
  projectId: string | null | undefined,
  kind: MediaKind,
  artifactId: string,
): Promise<MediaPersistOutcome> {
  if (!projectId || !isTauriEnv()) return { status: 'skipped' };
  try {
    const saved = await saveGeneratedMedia(url, projectId, kind, artifactId);
    if (!saved?.filePath) return { status: 'failed', error: MEDIA_PERSIST_FAILED_MESSAGE };
    return { status: 'saved', filePath: saved.filePath, assetUrl: saved.assetUrl };
  } catch (error) {
    return {
      status: 'failed',
      error: error instanceof Error ? error.message : MEDIA_PERSIST_FAILED_MESSAGE,
    };
  }
}

async function tagSavedGeneratedMedia(
  filePath: string | undefined,
  projectId: string | null | undefined,
  prompt: string,
): Promise<void> {
  if (!filePath || !projectId) return;
  await tagGeneratedProjectAssetSafely({ filePath, projectId, prompt });
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
      workflowId: model.workflowId,
    }, signal);
    throwIfAborted(signal);
    const persisted = await persistGeneratedMedia(result.url, projectId, intent.kind, id);
    await tagSavedGeneratedMedia(persisted.filePath, projectId, effectivePrompt);
    throwIfAborted(signal);
    return {
      id,
      kind: intent.kind,
      deliveryMode: intent.deliveryMode,
      url: persisted.assetUrl || result.url,
      sourceUrl: result.url,
      filePath: persisted.filePath,
      persistence: persisted.status,
      persistError: persisted.error,
      width: result.width,
      height: result.height,
      prompt,
      modelId: model.configId,
      provider: model.provider,
      createdAt: Date.now(),
    };
  }

  if (intent.kind === 'video') {
    const aspectRatio = intent.aspectRatio ?? projectSettings?.generation?.videoAspectRatio;
    const resolution = intent.resolution ?? projectSettings?.generation?.videoResolution;
    const duration = intent.duration ?? projectSettings?.generation?.videoDuration;
    const result = await generateVideo({
      prompt: effectivePrompt,
      model: model.requestModel,
      provider: model.provider,
      seedanceRatio: aspectRatio,
      seedanceResolution: resolution,
      seedanceDuration: duration,
      // 工作流只认数字长边，档位换算后再传
      videoResolution: videoLongSideFromLabel(resolution),
      workflowId: model.workflowId,
    }, signal);
    throwIfAborted(signal);
    const persisted = await persistGeneratedMedia(result.url, projectId, intent.kind, id);
    await tagSavedGeneratedMedia(persisted.filePath, projectId, effectivePrompt);
    throwIfAborted(signal);
    return {
      id,
      kind: intent.kind,
      deliveryMode: intent.deliveryMode,
      url: persisted.assetUrl || result.url,
      sourceUrl: result.url,
      filePath: persisted.filePath,
      persistence: persisted.status,
      persistError: persisted.error,
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
    workflowId: model.workflowId,
  }, signal);
  throwIfAborted(signal);
  const persisted = await persistAudioGenerationResult(
    result,
    projectId,
    `对话音频-${id}`,
  );
  await tagSavedGeneratedMedia(persisted.filePath, projectId, effectivePrompt);
  throwIfAborted(signal);
  return {
    id,
    kind: intent.kind,
    deliveryMode: intent.deliveryMode,
    url: persisted.mediaUrl,
    sourceUrl: persisted.sourceUrl || persisted.outputUrl,
    filePath: persisted.filePath,
    persistence: persisted.persistence,
    persistError: persisted.persistError,
    prompt,
    modelId: model.configId,
    provider: model.provider,
    audioPurpose: intent.audioPurpose,
    createdAt: Date.now(),
  };
}

/**
 * 重新把已生成的产物写入项目目录（用于落盘失败后的重试下载）。
 * 成功时返回指向本地文件的新产物，失败时抛出可直接展示的原因。
 */
export async function retryMediaArtifactPersist(
  artifact: MediaGenerationResult,
  projectId?: string | null,
): Promise<MediaGenerationResult> {
  if (!isTauriEnv()) throw new Error('浏览器模式不支持把产物保存到项目目录');
  const targetProjectId = projectId ?? useAppStore.getState().currentProjectId;
  if (!targetProjectId) throw new Error('当前没有打开的项目，无法保存产物');

  const sourceUrl = artifact.sourceUrl || artifact.url;
  if (!sourceUrl) throw new Error('产物已没有可用的下载地址，请重新生成');

  const persisted = await persistGeneratedMedia(
    sourceUrl,
    targetProjectId,
    artifact.kind,
    artifact.id,
  );
  if (persisted.status !== 'saved') {
    throw new Error(persisted.error || MEDIA_PERSIST_FAILED_MESSAGE);
  }
  await tagSavedGeneratedMedia(persisted.filePath, targetProjectId, artifact.prompt);
  return {
    ...artifact,
    url: persisted.assetUrl || artifact.url,
    filePath: persisted.filePath,
    persistence: 'saved',
    persistError: undefined,
  };
}

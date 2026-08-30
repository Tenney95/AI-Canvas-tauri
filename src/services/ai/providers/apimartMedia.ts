/**
 * APIMart 媒体 Provider Adapter，封装图片、视频和音频任务的提交、轮询与结果归一化。
 */
import { DEFAULT_BASE_URLS } from '../../../constants/api';
import { useAppStore } from '../../../store/useAppStore';
import type { AIAudioGenParams, AIVideoGenParams, AudioGenerationResult } from '../../../types/aiTypes';
import type { BaseNodeData } from '../../../types';
import { mapImageDimensions } from '../../aiDimensions';
import { pollTask } from '../../pollTask';
import {
  cleanupNodePolling,
  registerNodePolling,
  removePendingTask,
  savePendingTask,
  updatePendingTask,
} from '../../pollManager';
import {
  extractFlowMusicLyrics,
  extractFlowMusicTrack,
  fetchFlowMusicTask,
  generateApimartSpeech,
  getApimartAudioCapability,
  submitFlowMusicGeneration,
  submitFlowMusicLyrics,
  type FlowMusicGenerationRequest,
  type FlowMusicTaskState,
} from '../apimartAudio';
import { generateApimartImagesBatch, generateApimartVideo } from '../apimartGen';
import { getApimartSeedanceCapability, isApimartSeedanceModel } from '../apimartVideoModels';
import { getMediaReferenceUrl } from '../connectedReferenceMedia';
import { extractModelName } from '../helpers';
import { resolveImageUrlArray } from '../imageUtils';
import { resolveMediaReferenceUrl } from '../../uploadService';
import type { MediaProviderAdapter } from '../mediaProviderRegistry';

async function mapSequentially<T, R>(
  items: readonly T[],
  mapper: (item: T, index: number) => Promise<R>,
  signal?: AbortSignal,
): Promise<R[]> {
  const results: R[] = [];
  for (let index = 0; index < items.length; index += 1) {
    if (signal?.aborted) throw signal.reason ?? new DOMException('请求已取消', 'AbortError');
    results.push(await mapper(items[index], index));
  }
  return results;
}

function resolveImageUrlsSequentially(
  urls: readonly string[],
  provider: string,
  signal?: AbortSignal,
): Promise<string[]> {
  return mapSequentially(
    urls,
    async (url) => (await resolveImageUrlArray([url], provider, signal))[0],
    signal,
  );
}

function resolveApimartConnection(): { apiKey: string; baseUrl: string } {
  const providerConfig = useAppStore.getState().config.providers.apimart;
  const apiKey = providerConfig?.apiKey || '';
  if (!apiKey) {
    throw new Error('未配置 apimart 的 API Key\n请在「设置 → API Key」中配置');
  }
  const baseUrl = (providerConfig?.baseUrl || DEFAULT_BASE_URLS.apimart || '').replace(/\/+$/, '');
  if (!baseUrl) {
    throw new Error('未配置 apimart 的服务地址\n请在「设置 → API Key」中添加');
  }
  return { apiKey, baseUrl };
}

function buildFlowMusicRequest(
  params: AIAudioGenParams,
  prompt: string,
  generated?: { title: string; lyrics: string },
): FlowMusicGenerationRequest {
  return {
    soundPrompt: prompt,
    lyrics: generated?.lyrics || params.musicLyrics,
    title: generated?.title || params.musicTitle,
    bpm: params.musicBpm,
    length: params.musicDuration ?? 60,
  };
}

function waitForFlowMusicTask(
  apiKey: string,
  baseUrl: string,
  taskId: string,
  signal?: AbortSignal,
): Promise<FlowMusicTaskState> {
  return pollTask<FlowMusicTaskState, FlowMusicTaskState>({
    fetchState: () => fetchFlowMusicTask(apiKey, baseUrl, taskId, signal),
    isComplete: (task) => task.status === 'completed' ? task : null,
    isFailed: (task) =>
      task.status === 'failed' || task.status === 'error' || task.status === 'cancelled'
        ? `APIMart 音乐任务失败: ${task.status}`
        : null,
    interval: 3000,
    signal,
  });
}

async function generateFlowMusic(
  apiKey: string,
  baseUrl: string,
  params: AIAudioGenParams,
  prompt: string,
  externalSignal?: AbortSignal,
): Promise<AudioGenerationResult> {
  const shouldGenerateLyrics = params.autoGenerateLyrics === true;
  const initialStage = shouldGenerateLyrics ? 'lyrics' : 'music';
  const projectId = useAppStore.getState().currentProjectId;
  const nodeSignal = params.nodeId ? registerNodePolling(params.nodeId) : undefined;
  const signal = nodeSignal && externalSignal
    ? AbortSignal.any([nodeSignal, externalSignal])
    : nodeSignal ?? externalSignal;

  if (params.nodeId && projectId) {
    savePendingTask({
      nodeId: params.nodeId,
      projectId,
      nodeType: 'ai-audio',
      provider: 'apimart',
      providerConfigId: 'apimart',
      taskId: '',
      taskType: 'apimart-flow-music',
      audioTaskStage: initialStage,
      submitted: false,
    });
  }

  try {
    let generatedLyrics: { title: string; lyrics: string } | undefined;
    if (shouldGenerateLyrics) {
      const lyricsTaskId = await submitFlowMusicLyrics(apiKey, baseUrl, prompt, signal);
      if (params.nodeId) {
        updatePendingTask(params.nodeId, { taskId: lyricsTaskId, submitted: true });
      }
      generatedLyrics = extractFlowMusicLyrics(
        await waitForFlowMusicTask(apiKey, baseUrl, lyricsTaskId, signal),
      );

      if (
        params.nodeId
        && useAppStore.getState().currentProjectId === projectId
        && useAppStore.getState().nodes.some((node) => node.id === params.nodeId)
      ) {
        useAppStore.getState().updateNodeDataTransient(params.nodeId, {
          musicTitle: generatedLyrics.title || params.musicTitle,
          musicLyrics: generatedLyrics.lyrics,
        });
      }
      if (params.nodeId) {
        updatePendingTask(params.nodeId, {
          taskId: '',
          audioTaskStage: 'music',
          submitted: false,
        });
      }
    }

    const musicTaskId = await submitFlowMusicGeneration(
      apiKey,
      baseUrl,
      buildFlowMusicRequest(params, prompt, generatedLyrics),
      signal,
    );
    if (params.nodeId) {
      updatePendingTask(params.nodeId, {
        taskId: musicTaskId,
        audioTaskStage: 'music',
        submitted: true,
      });
    }
    return extractFlowMusicTrack(
      await waitForFlowMusicTask(apiKey, baseUrl, musicTaskId, signal),
    );
  } finally {
    if (params.nodeId) {
      cleanupNodePolling(params.nodeId);
      removePendingTask(params.nodeId);
    }
  }
}

/**
 * 用户/调用方是否显式指定了首/尾帧角色。
 * 未显式指定时（例如只上传多张普通参考图），assignVideoReferenceRoles 会按图片顺序
 * 自动推断首/尾帧；但 APIMart Seedance 的 image_with_roles 与 image_urls 互斥，
 * 自动推断会误报「首尾帧与参考素材不能同时使用」。因此只有显式角色才拆分首尾帧，
 * 其余情况全部图片按普通参考图提交（与火山方舟行为保持一致）。
 */
function hasExplicitFrameRoles(params: AIVideoGenParams): boolean {
  if ((params.referenceMedia ?? []).some((ref) => ref.role === 'first_frame' || ref.role === 'last_frame')) {
    return true;
  }
  if (!params.nodeId) return false;
  const node = useAppStore.getState().nodes.find((item) => item.id === params.nodeId);
  return ((node?.data as BaseNodeData | undefined)?.videoReferences ?? [])
    .some((item) => item.role === 'first_frame' || item.role === 'last_frame');
}

export const apimartMediaProviderAdapter: MediaProviderAdapter = {
  providerId: 'apimart',
  capabilities: ['image', 'video', 'audio'],

  async generateImage({ params, prompt, imageUrls, requestedCount, signal }) {
    const { apiKey, baseUrl } = resolveApimartConnection();
    const imageSize = params.imageSize ?? '2K';
    const aspectRatio = params.aspectRatio ?? '1:1';
    return generateApimartImagesBatch(
      apiKey,
      baseUrl,
      extractModelName(params.model, params.provider),
      prompt,
      imageSize,
      aspectRatio,
      mapImageDimensions(imageSize, aspectRatio),
      imageUrls,
      requestedCount,
      params.nodeId,
      signal,
    );
  },

  async generateVideo({ params, prompt, resolveReferenceInput, signal }) {
    const { apiKey, baseUrl } = resolveApimartConnection();
    const modelName = extractModelName(params.model, params.provider);
    const referenceInput = await resolveReferenceInput();
    if (!isApimartSeedanceModel(modelName)) {
      if (referenceInput.operation === 'video-to-video') {
        throw new Error(`APIMart 视频模型 "${modelName}" 暂不支持视频到视频生成`);
      }
      return generateApimartVideo(apiKey, baseUrl, modelName, prompt, params.nodeId, {}, signal);
    }
    if (
      !referenceInput.prompt.trim()
      && referenceInput.imageUrls.length === 0
      && referenceInput.videoUrls.length === 0
      && referenceInput.audioUrls.length === 0
    ) {
      throw new Error('提示词不能为空');
    }
    const capability = getApimartSeedanceCapability(modelName);
    // MiniMax-H3 用独立首/尾帧字段；Seedance 2.0/2.5 用 image_with_roles 数组。
    // 两者都需从 references 按 role 拆分首/尾帧，其余 role=reference 的图作多模态参考图。
    // 无 references（调用方未提供角色信息）时回退为普通参考图 image_urls。
    let imageUrls: string[];
    let firstFrameUrl: string | undefined;
    let lastFrameUrl: string | undefined;
    let imageWithRoles: Array<{ url: string; role: 'first_frame' | 'last_frame' | 'reference_image' }> = [];
    const references = referenceInput.references ?? [];
    if (
      (capability?.frameFields || capability?.imageWithRoles)
      && references.length > 0
      && hasExplicitFrameRoles(params)
    ) {
      const frameRefs = references.filter((ref) => ref.kind === 'image'
        && (ref.role === 'first_frame' || ref.role === 'last_frame'));
      const frameUrls = await resolveImageUrlsSequentially(
        frameRefs.map((ref) => getMediaReferenceUrl(ref)),
        'apimart',
        signal,
      );
      const frameRoles = frameRefs.map((ref) => ref.role);
      if (capability?.frameFields) {
        firstFrameUrl = frameRoles.includes('first_frame')
          ? frameUrls[frameRoles.indexOf('first_frame')]
          : undefined;
        lastFrameUrl = frameRoles.includes('last_frame')
          ? frameUrls[frameRoles.indexOf('last_frame')]
          : undefined;
      } else {
        imageWithRoles = frameRefs.map((ref, index) => ({
          url: frameUrls[index],
          role: ref.role as 'first_frame' | 'last_frame',
        }));
      }
      // 其余角色为 reference 的图片作为多模态参考图
      const referenceUrls = await resolveImageUrlsSequentially(
        references
          .filter((ref) => ref.kind === 'image' && ref.role === 'reference')
          .map((ref) => getMediaReferenceUrl(ref)),
        'apimart',
        signal,
      );
      // Seedance 2.0/2.5 走 image_with_roles，与 image_urls 互斥；参考图必须并入同一数组
      // （role=reference_image），否则首尾帧 + 参考图会被判为互斥直接报错。
      if (capability?.imageWithRoles) {
        imageWithRoles = [
          ...imageWithRoles,
          ...referenceUrls.map((url) => ({ url, role: 'reference_image' as const })),
        ];
        imageUrls = [];
      } else {
        imageUrls = referenceUrls;
      }
    } else {
      imageUrls = await resolveImageUrlsSequentially(referenceInput.imageUrls, 'apimart', signal);
    }
    // APIMart 的视频/音频参考必须是公网 URL；本地文件经统一入口上传（视频/音频强制走通用图床）
    const videoUrls = await mapSequentially(
      referenceInput.videoUrls,
      (url) => resolveMediaReferenceUrl(url, { provider: 'apimart', kind: 'video', signal }),
      signal,
    );
    const audioUrls = await mapSequentially(
      referenceInput.audioUrls,
      (url) => resolveMediaReferenceUrl(url, { provider: 'apimart', kind: 'audio', signal }),
      signal,
    );
    if (signal?.aborted) throw new DOMException('请求已取消', 'AbortError');
    return generateApimartVideo(apiKey, baseUrl, modelName, referenceInput.prompt, params.nodeId, {
      resolution: params.seedanceResolution,
      ratio: params.seedanceRatio,
      duration: params.seedanceDuration,
      generateAudio: params.generateAudio,
      imageUrls,
      firstFrameUrl,
      lastFrameUrl,
      imageWithRoles,
      videoUrls,
      audioUrls,
      operation: referenceInput.operation,
    }, signal);
  },

  generateAudio({ params, prompt, referenceAudioUrls, signal }) {
    const { apiKey, baseUrl } = resolveApimartConnection();
    const modelName = extractModelName(params.model, params.provider);
    const capability = getApimartAudioCapability(modelName);
    // APIMart 的 TTS 是 OpenAI 兼容的 /audio/speech，Flow Music 走歌词与风格参数，
    // 两者都没有音色参考入参；连了声音却被静默丢弃会让用户误以为生效，这里显式说明。
    if (referenceAudioUrls.length > 0) {
      useAppStore.getState().showToast?.(
        `APIMart 音频模型「${modelName}」不支持音色参考，已忽略连线音频`,
        'error',
      );
    }
    if (capability === 'speech') {
      return generateApimartSpeech(apiKey, baseUrl, {
        model: modelName,
        input: prompt,
        voice: params.audioVoice ?? 'alloy',
        format: params.audioFormat ?? 'wav',
        speed: params.audioSpeed ?? 1,
      }, signal);
    }
    if (capability === 'music') {
      return generateFlowMusic(apiKey, baseUrl, params, prompt, signal);
    }
    throw new Error(`APIMart 音频模型 "${modelName}" 暂不支持音频生成`);
  },
};

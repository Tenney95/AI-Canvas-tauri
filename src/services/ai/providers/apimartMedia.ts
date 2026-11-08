/**
 * APIMart 媒体 Provider Adapter，封装图片、视频和音频任务的提交、轮询与结果归一化。
 */
import { DEFAULT_BASE_URLS } from '../../../constants/api';
import { useAppStore } from '../../../store/useAppStore';
import type { AIAudioGenParams, AIVideoGenParams, AudioGenerationResult, MediaTaskReceipt } from '../../../types/aiTypes';
import type { BaseNodeData } from '../../../types';
import { mapImageDimensions } from '../../aiDimensions';
import { pollTask, PollTaskFailedError } from '../../pollTask';
import { getHttpResponseError } from '../httpUtils';
import {
  cleanupNodePolling,
  registerNodePolling,
  removeFailedMediaTask,
  savePendingTask,
  updatePendingTask,
  pauseMediaTask,
  VIDEO_POLL_MAX_DURATION_MS,
} from '../../pollManager';
import {
  extractFlowMusicLyrics,
  extractFlowMusicTrack,
  fetchFlowMusicTask,
  generateApimartSpeech,
  getApimartAudioCapability,
  submitFlowMusicGeneration,
  submitFlowMusicLyrics,
  submitSunoGeneration,
  type FlowMusicGenerationRequest,
  type FlowMusicTaskState,
} from '../apimartAudio';
import { generateApimartImagesBatch, generateApimartVideo } from '../apimartGen';
import { getApimartSeedanceCapability, isApimartSeedanceModel } from '../apimartVideoModels';
import { getMediaReferenceUrl } from '../connectedReferenceMedia';
import { assertVideoInputConstraints } from '../videoInputValidation';
import { extractModelName } from '../helpers';
import { mapSequentially, resolveImageUrlsSequentially } from '../referenceMediaPreparation';
import { resolveMediaReferenceUrl } from '../../uploadService';
import type { MediaProviderAdapter } from '../mediaProviderRegistry';
import { isNativeVideoSubmissionGuard } from '../../nativeVideoSubmission';

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
    version: params.model.endsWith('flowmusic-lyria-3.5') ? 'lyria-3.5' : undefined,
    soundPrompt: prompt,
    lyrics: generated?.lyrics || (params.autoGenerateLyrics ? undefined : params.musicLyrics),
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
    fetchState: (querySignal) => fetchFlowMusicTask(apiKey, baseUrl, taskId, querySignal),
    isComplete: (task) => task.status === 'completed' ? task : null,
    isFailed: (task) =>
      task.status === 'failed' || task.status === 'error' || task.status === 'cancelled'
        ? `APIMart 音乐任务失败: ${typeof task.error === 'string' ? task.error : task.error?.message || task.status}`
        : null,
    interval: 3000,
    maxDuration: VIDEO_POLL_MAX_DURATION_MS,
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
  const model = extractModelName(params.model, params.provider);
  const isSuno = /^suno(?:-v6(?:-wild|-mini)?)?$/.test(model);
  // 新音乐模型直接使用自身的风格/歌词生成，保持只有一个可恢复的音乐任务阶段。
  const shouldGenerateLyrics = params.autoGenerateLyrics === true && model === 'flowmusic';
  const initialStage = shouldGenerateLyrics ? 'lyrics' : 'music';
  const projectId = useAppStore.getState().currentProjectId;
  let receipt: MediaTaskReceipt | undefined;
  let requestSent = false;
  const nodeSignal = params.nodeId ? registerNodePolling(params.nodeId) : undefined;
  const signal = nodeSignal && externalSignal
    ? AbortSignal.any([nodeSignal, externalSignal])
    : nodeSignal ?? externalSignal;

  try {
    if (params.nodeId && projectId) {
      receipt = savePendingTask({
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
    let generatedLyrics: { title: string; lyrics: string } | undefined;
    if (shouldGenerateLyrics) {
      signal?.throwIfAborted();
      const submission = submitFlowMusicLyrics(apiKey, baseUrl, prompt, signal);
      requestSent = true;
      const lyricsTaskId = await submission;
      if (params.nodeId) {
        receipt = updatePendingTask(params.nodeId, { taskId: lyricsTaskId, submitted: true }, receipt?.taskId, receipt?.attemptId) ?? receipt;
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
        receipt = updatePendingTask(params.nodeId, {
          taskId: '',
          audioTaskStage: 'music',
          submitted: false,
          mediaRecoveryState: undefined,
        }, receipt?.taskId, receipt?.attemptId) ?? receipt;
      }
      requestSent = false;
    }

    signal?.throwIfAborted();
    const musicSubmission = isSuno
      ? submitSunoGeneration(apiKey, baseUrl, {
        version: model === 'suno' ? 'v6' : model.slice('suno-'.length) as 'v6' | 'v6-wild' | 'v6-mini',
        prompt, lyrics: params.autoGenerateLyrics ? undefined : params.musicLyrics,
        title: params.musicTitle, duration: params.musicDuration,
      }, signal)
      : submitFlowMusicGeneration(apiKey, baseUrl, buildFlowMusicRequest(params, prompt, generatedLyrics), signal);
    requestSent = true;
    const musicTaskId = await musicSubmission;
    if (params.nodeId) {
      receipt = updatePendingTask(params.nodeId, {
        taskId: musicTaskId,
        audioTaskStage: 'music',
        submitted: true,
      }, receipt?.taskId, receipt?.attemptId) ?? receipt;
    }
    const result = extractFlowMusicTrack(
      await waitForFlowMusicTask(apiKey, baseUrl, musicTaskId, signal),
    );
    if (receipt) receipt = updatePendingTask(receipt.nodeId, { mediaRecoveryState: 'delivery_pending' }, receipt.taskId, receipt.attemptId) ?? receipt;
    return { ...result, ...(receipt ? { taskReceipt: receipt } : {}) };
  } catch (error) {
    if (receipt) {
      const rejected = !receipt.taskId && getHttpResponseError(error)?.definitiveFailure === true;
      if (!requestSent || rejected || error instanceof PollTaskFailedError) {
        removeFailedMediaTask(receipt);
      } else {
        const paused = pauseMediaTask(receipt, error, receipt.taskId ? undefined : 'submit_unknown');
        if (paused) throw paused;
      }
    }
    throw error;
  } finally {
    if (params.nodeId) cleanupNodePolling(params.nodeId, nodeSignal);
  }
}

/**
 * 用户/调用方是否显式指定了首/尾帧角色。
 * APIMart Seedance 的 image_with_roles 与 image_urls 互斥，因此只有显式角色才拆分
 * 首尾帧；连线图片和普通 @ 图片全部按普通参考图提交（与其他 Seedance 路径一致）。
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

  async generateImage({ params, prompt, imageUrls, requestedCount, signal, beforeSubmit }) {
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
      params.imageQuality,
      params.imageBackground,
      beforeSubmit,
    );
  },

  async generateVideo({ params, prompt, resolveReferenceInput, signal, beforeSubmit }) {
    const { apiKey, baseUrl } = resolveApimartConnection();
    const modelName = extractModelName(params.model, params.provider);
    const referenceInput = await resolveReferenceInput();
    if (!isApimartSeedanceModel(modelName)) {
      if (referenceInput.operation === 'video-to-video') {
        throw new Error(`APIMart 视频模型 "${modelName}" 暂不支持视频到视频生成`);
      }
      signal?.throwIfAborted();
      if (beforeSubmit) await beforeSubmit();
      signal?.throwIfAborted();
      return generateApimartVideo(apiKey, baseUrl, modelName, prompt, params.nodeId, {}, signal, beforeSubmit);
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
      if (capability?.omniVariant) {
        for (const role of ['first_frame', 'last_frame']) {
          if (frameRefs.filter((ref) => ref.role === role).length > 1) {
            throw new Error('Omni 每种首尾帧角色只能选择 1 张图片');
          }
        }
        if (capability.omniVariant !== 'flash' && frameRefs.some((ref) => ref.role === 'last_frame')) {
          throw new Error('该 Omni 模型不支持尾帧，请使用 Gemini Omni 1.1 Flash');
        }
      }
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
    if (capability?.omniVariant || capability?.requestVariant) {
      const constraints = structuredClone(capability.inputConstraints);
      if (capability.requestVariant === 'wan3' && constraints?.referenceVideo && params.seedanceDuration !== -1) {
        constraints.referenceVideo.totalDurationSeconds = { max: Math.min(15, Math.max(0, 30 - (params.seedanceDuration ?? 5))) };
      }
      await assertVideoInputConstraints(
        { ...referenceInput, videoUrls, audioUrls },
        { inputConstraints: constraints },
        capability.modelId,
        { signal },
      );
    }
    signal?.throwIfAborted();
    if (beforeSubmit) await beforeSubmit();
    signal?.throwIfAborted();
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
    }, signal, beforeSubmit);
  },

  async generateAudio({ params, prompt, referenceAudioUrls, referenceMedia, signal, beforeSubmit }) {
    const { apiKey, baseUrl } = resolveApimartConnection();
    const modelName = extractModelName(params.model, params.provider);
    const capability = getApimartAudioCapability(modelName);
    if (useAppStore.getState().projectExecutionContext?.modelGeneration === 1 || isNativeVideoSubmissionGuard(beforeSubmit)) {
      if (referenceAudioUrls.length || referenceMedia?.length) throw new Error('APIMart 音频合同不支持素材参考，未提交生成');
      const { generateNativeBuiltinAudio } = await import('../../nativeBuiltinAudioRecovery');
      return generateNativeBuiltinAudio({ params, prompt, apiKey, baseUrl, signal, beforeSubmit });
    }
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

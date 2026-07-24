import { DEFAULT_BASE_URLS } from '../../../constants/api';
import { useAppStore } from '../../../store/useAppStore';
import type { AIAudioGenParams, AudioGenerationResult } from '../../../types/aiTypes';
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
import { isApimartSeedanceModel } from '../apimartVideoModels';
import { extractModelName } from '../helpers';
import { resolveImageUrlArray } from '../imageUtils';
import type { MediaProviderAdapter } from '../mediaProviderRegistry';

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
    if (!isApimartSeedanceModel(modelName)) {
      return generateApimartVideo(apiKey, baseUrl, modelName, prompt, params.nodeId, {}, signal);
    }
    const referenceInput = await resolveReferenceInput();
    if (!referenceInput.prompt.trim() && referenceInput.imageUrls.length === 0) {
      throw new Error('提示词不能为空');
    }
    const imageUrls = await resolveImageUrlArray(referenceInput.imageUrls, 'apimart');
    if (signal?.aborted) throw new DOMException('请求已取消', 'AbortError');
    return generateApimartVideo(apiKey, baseUrl, modelName, referenceInput.prompt, params.nodeId, {
      resolution: params.seedanceResolution,
      ratio: params.seedanceRatio,
      duration: params.seedanceDuration,
      generateAudio: params.generateAudio,
      imageUrls,
    }, signal);
  },

  generateAudio({ params, prompt, signal }) {
    const { apiKey, baseUrl } = resolveApimartConnection();
    const modelName = extractModelName(params.model, params.provider);
    const capability = getApimartAudioCapability(modelName);
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

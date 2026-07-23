/**
 * ai/generateAudio — 音频生成入口
 */
import { useAppStore } from '../../store/useAppStore';
import { DEFAULT_BASE_URLS } from '../../constants/api';
import { resolveNodeReferences } from '../nodeReferenceService';
import { executeComfyUIAudioGenerate } from '../comfyWorkflowService';
import { downloadUrlAndSave, saveBinaryToProjectData } from '../fileService';
import { pollTask } from '../pollTask';
import {
  cleanupNodePolling,
  registerNodePolling,
  removePendingTask,
  savePendingTask,
  updatePendingTask,
} from '../pollManager';
import type { AIAudioGenParams, AudioGenerationResult } from '../../types/aiTypes';
import { extractModelName, resolveGeneralModel, resolveGeneralModelConnection } from './helpers';
import { executeGeneralAsyncTask } from './apimartGen';
import { runConfiguredModelProtocol } from './modelProtocolRuntime';
import {
  extractFlowMusicLyrics,
  extractFlowMusicTrack,
  fetchFlowMusicTask,
  getApimartAudioCapability,
  submitFlowMusicGeneration,
  submitFlowMusicLyrics,
  generateApimartSpeech,
  type FlowMusicGenerationRequest,
  type FlowMusicTaskState,
} from './apimartAudio';

export interface PersistedAudioGenerationResult {
  mediaUrl: string;
  outputUrl: string;
  sourceUrl?: string;
  filePath?: string;
}

function buildSafeAudioFileName(label: string, format: string): string {
  const printableLabel = Array.from(label, (character) =>
    character.charCodeAt(0) < 32 ? '_' : character,
  ).join('');
  const safeLabel = printableLabel
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/[. ]+$/g, '')
    .trim()
    .slice(0, 80) || '生成音频';
  return `${safeLabel}.${format}`;
}

/** 把同步 TTS 二进制或异步远程音频统一保存为节点可持久化的结果。 */
export async function persistAudioGenerationResult(
  result: AudioGenerationResult,
  projectId: string | null | undefined,
  label: string,
): Promise<PersistedAudioGenerationResult> {
  const saved = projectId
    ? result.bytes
      ? await saveBinaryToProjectData(
          result.bytes,
          projectId,
          buildSafeAudioFileName(label, result.format || 'wav'),
        ).catch(() => null)
      : await downloadUrlAndSave(result.url, projectId, 'ai-audio', label).catch(() => null)
    : null;

  const mediaUrl = saved?.assetUrl || result.url;
  if (saved && result.url.startsWith('blob:')) URL.revokeObjectURL(result.url);
  return {
    mediaUrl,
    outputUrl: result.bytes ? mediaUrl : result.url,
    sourceUrl: result.bytes ? undefined : result.url,
    filePath: saved?.filePath,
  };
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
      task.status === 'failed' || task.status === 'error'
        ? `APIMart 音乐任务失败: ${task.status}`
        : null,
    interval: 3000,
    onFetchError: 'continue',
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

export async function generateAudio(
  params: AIAudioGenParams,
  signal?: AbortSignal,
): Promise<AudioGenerationResult> {
  const { prompt: rawPrompt, model, provider } = params;

  // 解析 @{nodeId:label} 引用为对应节点的实际输出内容
  const prompt = resolveNodeReferences(rawPrompt);

  // ComfyUI 工作流执行路径
  if (params.workflowId) {
    return executeComfyUIAudioGenerate({ ...params, prompt }, signal);
  }

  // APIMart 音频能力按模型 capability 路由，避免把 TTS/音乐误发到图片端点。
  if (provider === 'apimart') {
    const config = useAppStore.getState().config;
    const providerConfig = config.providers.apimart;
    const apiKey = providerConfig?.apiKey || '';
    if (!apiKey) {
      throw new Error('未配置 apimart 的 API Key\n请在「设置 → API Key」中配置');
    }
    const baseUrl = (providerConfig?.baseUrl || DEFAULT_BASE_URLS.apimart || '').replace(/\/+$/, '');
    if (!baseUrl) {
      throw new Error('未配置 apimart 的服务地址\n请在「设置 → API Key」中添加');
    }
    const modelName = extractModelName(model, provider);
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
  }

  // ── 通用模型音频生成 ──
  if (provider === 'general') {
    const gm = resolveGeneralModel(model);
    if (!gm) throw new Error('未找到该通用模型配置\n请在「设置 → API Key」中检查');
    const connection = resolveGeneralModelConnection(model);
    if (!connection) throw new Error(`通用模型 "${gm.name}" 的连接配置不存在`);
    if (!connection.baseUrl) throw new Error(`通用模型 "${gm.name}" 未配置接口地址`);
    if (gm.executionProfile) {
      const urls = await runConfiguredModelProtocol({
        model: gm,
        category: 'audio',
        nodeId: params.nodeId,
        signal,
        variables: {
          model: gm.modelId,
          prompt,
          audioVoice: params.audioVoice,
          audioFormat: params.audioFormat,
          audioSpeed: params.audioSpeed,
          duration: params.musicDuration,
          musicTitle: params.musicTitle,
          musicLyrics: params.musicLyrics,
          musicBpm: params.musicBpm,
          n: 1,
          batchCount: 1,
        },
      });
      const url = urls[0];
      if (!url) throw new Error('音频生成完成但未返回结果');
      return { url };
    }
    return executeGeneralAsyncTask(
      connection.apiKey,
      connection.baseUrl,
      gm.modelId,
      prompt,
      'audios',
      connection.providerConfigId,
      params.nodeId,
      signal,
    );
  }

  // 无 workflowId 时暂不支持直接调用 API，提示配置
  throw new Error('音频生成需要选择 ComfyUI 工作流\n请在模型选择器中导入并选择工作流');
}

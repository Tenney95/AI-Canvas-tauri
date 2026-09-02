/**
 * ai/generateAudio — 音频生成入口
 */
import { resolveNodeReferences } from '../nodeReferenceService';
import { executeComfyUIAudioGenerate } from '../comfyWorkflowService';
import {
  createMediaDataUrlBudget,
  isTauriEnv,
  persistMediaUrlToProjectData,
  saveBinaryToProjectData,
} from '../fileService';
import { resolveMediaReferenceUrl } from '../uploadService';
import type { AIAudioGenParams, AudioGenerationResult, MediaReference } from '../../types/aiTypes';
import type { MediaPersistenceStatus } from '../../types/media';
import { resolveGeneralModel, resolveGeneralModelConnection } from './helpers';
import {
  collectConnectedReferenceMedia,
  getMediaReferenceUrl,
  getMediaReferenceUrls,
  mergeMediaReferences,
  warnIfTooManyReferences,
} from './connectedReferenceMedia';
import { collectPromptNodeMediaUrls } from './promptResolver';
import { executeGeneralAsyncTask } from './apimartGen';
import { runConfiguredModelProtocol } from './modelProtocolRuntime';
import { mediaProviderRegistry } from './mediaProviderRegistry';
import { mapAudioParameters } from './audioParameterMappings';

export interface PersistedAudioGenerationResult {
  mediaUrl: string;
  outputUrl: string;
  sourceUrl?: string;
  filePath?: string;
  /** 落盘状态；failed 表示音频已生成但 mediaUrl 仍是临时地址。 */
  persistence: MediaPersistenceStatus;
  persistError?: string;
}

export const AUDIO_PERSIST_FAILED_MESSAGE = '音频未能写入项目目录，当前是临时地址';

function normalizeProtocolAudioResult(url: string): AudioGenerationResult {
  const match = /^data:(audio\/[^;,]+);base64,([a-z\d+/=\s]+)$/i.exec(url);
  if (!match) return { url };
  let bytes: Uint8Array;
  try {
    const binary = atob(match[2].replace(/\s/g, ''));
    bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    throw new Error('音频模型返回的 Base64 数据无效');
  }
  const format = match[1].toLowerCase() === 'audio/wav' ? 'wav' : undefined;
  return { url, bytes, ...(format ? { format } : {}) };
}

async function resolveGeneralAudioReferenceUrls(
  references: readonly MediaReference[],
  signal?: AbortSignal,
): Promise<string[]> {
  const budget = createMediaDataUrlBudget('本次音频模型参考媒体');
  const results: string[] = [];
  const audioReferences = references.filter((reference) => reference.kind === 'audio');
  for (const reference of audioReferences) {
    if (signal?.aborted) throw signal.reason ?? new DOMException('请求已取消', 'AbortError');
    const url = getMediaReferenceUrl(reference);
    // 通用协议模型需要 data URL（base64）；公网 / data: 原样返回
    results.push(await resolveMediaReferenceUrl(url, {
      mode: 'dataUrl', kind: 'audio', signal, dataUrlBudget: budget,
    }));
  }
  return results;
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

/**
 * 把同步 TTS 二进制或异步远程音频统一保存为节点可持久化的结果。
 * 落盘失败不会抛出，但会如实记在 persistence/persistError 上：调用方必须区分
 * 「生成成功」和「已保存到项目」，否则临时地址失效后产物就打不开了。
 */
export async function persistAudioGenerationResult(
  result: AudioGenerationResult,
  projectId: string | null | undefined,
  label: string,
): Promise<PersistedAudioGenerationResult> {
  const shouldPersist = !!projectId && isTauriEnv();
  let saved: { filePath?: string; assetUrl?: string; sourceUrl?: string } | null = null;
  let persistError: string | undefined;
  if (shouldPersist) {
    try {
      saved = result.bytes
        ? await saveBinaryToProjectData(
            result.bytes,
            projectId!,
            buildSafeAudioFileName(label, result.format || 'wav'),
          )
        : await persistMediaUrlToProjectData(result.url, projectId!, 'ai-audio', label);
      if (!saved?.filePath) persistError = AUDIO_PERSIST_FAILED_MESSAGE;
    } catch (error) {
      persistError = error instanceof Error ? error.message : AUDIO_PERSIST_FAILED_MESSAGE;
    }
  }

  const mediaUrl = saved?.assetUrl || result.url;
  // 只有落盘成功才回收 blob，失败时保留它，用户仍能在本次会话里重试保存
  if (saved?.filePath && result.url.startsWith('blob:')) URL.revokeObjectURL(result.url);
  return {
    mediaUrl,
    // 落盘成功后来源要改指项目文件，否则节点会把临时地址一起持久化
    outputUrl: result.bytes ? mediaUrl : (saved?.sourceUrl ?? result.url),
    sourceUrl: result.bytes ? undefined : (saved?.sourceUrl ?? result.url),
    filePath: saved?.filePath,
    persistence: saved?.filePath ? 'saved' : shouldPersist ? 'failed' : 'skipped',
    persistError,
  };
}

export async function generateAudio(
  params: AIAudioGenParams,
  signal?: AbortSignal,
): Promise<AudioGenerationResult> {
  const { prompt: rawPrompt, model, provider } = params;

  // 解析 @{nodeId:label} 引用为对应节点的实际输出内容
  const prompt = resolveNodeReferences(rawPrompt);
  // @ 引用和连线统一收集；角色库绑定的声音仍通过连线进入。
  const mentionedMedia = collectPromptNodeMediaUrls(rawPrompt);
  const connectedMedia = collectConnectedReferenceMedia(params.nodeId);
  const references = mergeMediaReferences(mentionedMedia.references, connectedMedia.references);
  const referenceAudioUrls = getMediaReferenceUrls(references, 'audio');
  warnIfTooManyReferences({ audio: referenceAudioUrls.length });

  // ComfyUI 工作流执行路径：连线音频兜底填充工作流的 audio IO 节点
  if (params.workflowId) {
    return executeComfyUIAudioGenerate(
      { ...params, prompt },
      signal,
      getMediaReferenceUrls(references, 'audio', 'local'),
    );
  }

  const registeredAdapter = mediaProviderRegistry.getAudioAdapter(provider);
  if (registeredAdapter) {
    return registeredAdapter.generateAudio({ params, prompt, referenceAudioUrls, signal });
  }

  // ── 通用模型音频生成 ──
  if (provider === 'general') {
    const gm = resolveGeneralModel(model);
    if (!gm) throw new Error('未找到该通用模型配置\n请在「设置 → API Key」中检查');
    const connection = resolveGeneralModelConnection(model);
    if (!connection) throw new Error(`通用模型 "${gm.name}" 的连接配置不存在`);
    if (!connection.baseUrl) throw new Error(`通用模型 "${gm.name}" 未配置接口地址`);
    if (gm.executionProfile) {
      const protocolAudioUrls = await resolveGeneralAudioReferenceUrls(references, signal);
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
          audioUrls: protocolAudioUrls,
          audioUrl: protocolAudioUrls[0],
          referenceAudioUrls: protocolAudioUrls,
          n: 1,
          batchCount: 1,
        },
      });
      const url = urls[0];
      if (!url) throw new Error('音频生成完成但未返回结果');
      return normalizeProtocolAudioResult(url);
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
      mapAudioParameters('standard', gm.modelId, {
        model: gm.modelId,
        prompt,
        batchCount: 1,
      }),
    );
  }

  // 无 workflowId 时暂不支持直接调用 API，提示配置
  throw new Error('音频生成需要选择 ComfyUI 工作流\n请在模型选择器中导入并选择工作流');
}

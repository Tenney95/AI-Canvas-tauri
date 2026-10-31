/**
 * ai/generateAudio — 音频生成入口
 */
import { collectAudioSpeechReferences, resolveAudioSpeechWorkflow, stripAudioSpeechReferences } from './audioSpeechSettings';
import { resolveNodeReferences } from '../nodeReferenceService';
import { loadGlobalDramaAssetsForPrompt } from '../dramaAssetPrompt';
import { useAppStore } from '../../store/useAppStore';
import { executeWorkflowApiMedia } from '../workflowApi/workflowApiAdapter';
import { parseWorkflowApiFields } from '../workflowApi/workflowApiConfig';
import { isRunningHubWorkflow, getCloudWorkflowPersistedOutput } from '../workflowExecutionService';
import { executeRunningHubWorkflow } from './providers/runninghubWorkflow';
import { splitRunningHubPrompt } from './providers/runninghubWorkflowInputs';
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
import { resolveProviderCatalogId } from './providerPolicies';
import {
  collectConnectedReferenceMedia,
  getMediaReferenceUrl,
  getMediaReferenceUrls,
  mergeMediaReferences,
  warnIfTooManyReferences,
} from './connectedReferenceMedia';
import { collectPromptNodeMediaUrls, resolvePromptWithMediaRefs } from './promptResolver';
import { compileVideoReferencePrompt } from './referencePrompt';
import { getRunningHubModel } from './providers/runninghubModelManifest';
import { executeGeneralAsyncTask } from './apimartGen';
import { retainCompletedMediaResults, runConfiguredModelProtocol } from './modelProtocolRuntime';
import { createMediaDownloadAccess } from './mediaDownloadAccess';
import { mediaProviderRegistry } from './mediaProviderRegistry';
import { mapAudioParameters } from './audioParameterMappings';
import { libapiAudioVariables, usesLibapiModelProtocol } from './providers/libapiModelManifest';

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
  const cloud = getCloudWorkflowPersistedOutput(result.workflowApiOutputs ?? result.runninghubOutputs, result.url);
  if (cloud) return cloud;
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
        : await persistMediaUrlToProjectData(result.url, projectId!, 'ai-audio', label,
          result.mediaDownloadAccess ? { mediaDownloadAccess: result.mediaDownloadAccess } : undefined);
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
  const { model, provider } = params;
  let rawPrompt = params.prompt;
  const rawWorkflowPrompt = rawPrompt;
  const state = useAppStore.getState();
  const globalAssets = await loadGlobalDramaAssetsForPrompt(`${rawPrompt}\n${JSON.stringify(params.workflowInputs ?? {})}`, state);
  if (signal?.aborted) throw new DOMException('请求已取消', 'AbortError');
  if (useAppStore.getState().currentProjectId !== state.currentProjectId) throw new Error('项目已切换，请重新生成音频');
  const selectedWorkflow = params.workflowId ? state.workflows.find((item) => item.id === params.workflowId) : undefined;
  if (isRunningHubWorkflow(selectedWorkflow)) rawPrompt = splitRunningHubPrompt(rawWorkflowPrompt).prompt;
  if (resolveAudioSpeechWorkflow(selectedWorkflow)) {
    const invalid = collectAudioSpeechReferences(rawPrompt, params.nodeId, state.nodes, state.edges,
      state.dramaAssets, selectedWorkflow, params.workflowInputs, globalAssets).find((reference) => !reference.url);
    if (invalid) throw new Error(`参考语音已失效：${invalid.label}，请重新选择`);
  }

  const isRunningHub = params.workflowId ? isRunningHubWorkflow(selectedWorkflow) : provider === 'runninghub';
  const runninghubMedia = isRunningHub ? await resolvePromptWithMediaRefs(rawPrompt, { preserveBindings: true }) : undefined;
  // 参考音频通过独立媒体通道传递，不混入朗读正文。
  const mentionedMedia = runninghubMedia ?? collectPromptNodeMediaUrls(rawPrompt, globalAssets);
  const connectedMedia = collectConnectedReferenceMedia(params.nodeId);
  const connectedReferences = runninghubMedia ? connectedMedia.references.map((reference) => {
    const local = runninghubMedia.references.find((candidate) => candidate.kind === 'image' && reference.kind === 'image'
      && candidate.sourceNodeId === reference.sourceNodeId && candidate.sourceNodeId
      && state.nodes.find((node) => node.id === candidate.sourceNodeId)?.data.imageUrl === reference.url);
    return local ? { ...reference, url: local.url } : reference;
  }) : connectedMedia.references;
  const references = mergeMediaReferences(mentionedMedia.references, connectedReferences);
  // 只有明确的音乐合同使用素材编号；语音及未声明用途的工作流不能朗读素材标记或角色说明。
  const runninghubMusic = !params.workflowId && provider === 'runninghub' && getRunningHubModel(model)?.audioPurpose === 'music';
  const prompt = runninghubMedia ? runninghubMusic
    ? compileVideoReferencePrompt(runninghubMedia, references, { target: 'local' })
    : stripAudioSpeechReferences(runninghubMedia.segments?.filter((segment): segment is string => typeof segment === 'string').join('') ?? '', state.nodes)
    : resolveNodeReferences(stripAudioSpeechReferences(rawPrompt, state.nodes), globalAssets);
  const referenceAudioUrls = getMediaReferenceUrls(references, 'audio', runninghubMedia ? 'local' : 'remote');
  warnIfTooManyReferences({ audio: referenceAudioUrls.length });

  // ComfyUI 工作流执行路径：连线音频兜底填充工作流的 audio IO 节点
  if (params.workflowId) {
    const workflow = useAppStore.getState().workflows.find((item) => item.id === params.workflowId);
    if (provider === 'workflow-api' && workflow?.adapterType !== 'workflow-api') throw new Error('请先配置并选择工作流 API');
    if (workflow?.adapterType === 'workflow-api') {
      const result = await executeWorkflowApiMedia({ workflowId: workflow.id, nodeId: params.nodeId, taskContext: params.workflowApiTaskContext,
        prompt, inputs: parseWorkflowApiFields(params.workflowInputs, workflow.workflowApi), references: {
          image: getMediaReferenceUrls(references, 'image', 'local'), video: getMediaReferenceUrls(references, 'video', 'local'), audio: getMediaReferenceUrls(references, 'audio', 'local'),
        } }, signal);
      return { ...normalizeProtocolAudioResult(result.url), ...result };
    }
    if (isRunningHubWorkflow(workflow)) {
      const outputs = await executeRunningHubWorkflow({ ...params, workflowId: params.workflowId, rawWorkflowPrompt, prompt, kind: 'audio', references: {
        image: getMediaReferenceUrls(references, 'image', 'local'), video: getMediaReferenceUrls(references, 'video', 'local'), audio: getMediaReferenceUrls(references, 'audio', 'local'),
      } }, signal);
      return { ...normalizeProtocolAudioResult(outputs[0].url), runninghubOutputs: outputs };
    }
    const comfyReferences = mergeMediaReferences((await resolvePromptWithMediaRefs(rawPrompt)).references, connectedMedia.references);
    return executeComfyUIAudioGenerate(
      { ...params, prompt },
      signal,
      getMediaReferenceUrls(comfyReferences, 'audio', 'local'),
      { imageUrls: getMediaReferenceUrls(comfyReferences, 'image', 'local'), videoUrls: getMediaReferenceUrls(comfyReferences, 'video', 'local') },
    );
  }

  if (provider === 'workflow-api') throw new Error('请先配置并选择工作流 API');
  const registeredAdapter = mediaProviderRegistry.getAudioAdapter(provider);
  if (registeredAdapter) {
    return registeredAdapter.generateAudio({ params, prompt, referenceAudioUrls, referenceMedia: references, signal });
  }

  // ── 通用模型音频生成 ──
  if (provider === 'general') {
    const gm = resolveGeneralModel(model);
    if (!gm) throw new Error('未找到该通用模型配置\n请在「设置 → API Key」中检查');
    const connection = resolveGeneralModelConnection(model);
    if (!connection) throw new Error(`通用模型 "${gm.name}" 的连接配置不存在`);
    if (!connection.baseUrl) throw new Error(`通用模型 "${gm.name}" 未配置接口地址`);
    if (gm.executionProfile) {
      const catalogId = connection.definition?.id ?? resolveProviderCatalogId(connection.providerConfigId, connection.provider);
      const isLibapi = catalogId === 'libapi';
      const usesLibapiProtocol = isLibapi && usesLibapiModelProtocol(gm.modelId, gm.executionProfile);
      if (usesLibapiProtocol) {
        // 旧语音收集器只收视频／音频节点；完整解析还覆盖无连线图片、资产及角色素材引用。
        const hasReferences = references.length || (await resolvePromptWithMediaRefs(rawPrompt, { preserveBindings: true })).references.length;
        if (hasReferences) {
          throw new Error('LibAPI 当前语音与音乐生成不接受参考素材；声音克隆需先在平台创建音色 ID，再填写到语音参数。本次尚未提交生成请求');
        }
      }
      if (usesLibapiProtocol && params.autoGenerateLyrics) {
        throw new Error('LibAPI 音乐由模型直接生成歌词，请关闭「自动生成歌词」的单独步骤，或填写自定义歌词。本次尚未提交生成请求');
      }
      // 已核对合同先验证参数，避免无效音色或素材被上传后才发现请求不能执行。
      const variables = {
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
      };
      const effectiveVariables = usesLibapiProtocol ? libapiAudioVariables(gm.modelId, variables) : variables;
      const protocolAudioUrls = await resolveGeneralAudioReferenceUrls(references, signal);
      const urls = await runConfiguredModelProtocol({
        model: gm,
        category: 'audio',
        nodeId: params.nodeId,
        signal,
        variables: {
          ...effectiveVariables,
          audioUrls: protocolAudioUrls,
          audioUrl: protocolAudioUrls[0],
          referenceAudioUrls: protocolAudioUrls,
        },
      });
      const url = urls[0];
      if (!url) throw new Error('音频生成完成但未返回结果');
      return { ...normalizeProtocolAudioResult(url), ...(urls.taskReceipt ? { taskReceipt: urls.taskReceipt } : {}),
        ...(urls.mediaDownloadAccess ? { mediaDownloadAccess: urls.mediaDownloadAccess } : {}) };
    }
    const result = await executeGeneralAsyncTask(
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
    const access = createMediaDownloadAccess(connection.providerConfigId, connection.baseUrl, { type: 'bearer' });
    const urls = retainCompletedMediaResults([result.url], access, params.nodeId, 'audio', 1, result.taskReceipt, state.currentProjectId);
    return { ...result, mediaDownloadAccess: access, ...(urls.taskReceipt ? { taskReceipt: urls.taskReceipt } : {}) };
  }

  // 无 workflowId 时暂不支持直接调用 API，提示配置
  throw new Error('音频生成需要选择 ComfyUI 工作流\n请在模型选择器中导入并选择工作流');
}

/**
 * ai/generateAudio — 音频生成入口
 */
import { resolveNodeReferences } from '../nodeReferenceService';
import { executeComfyUIAudioGenerate } from '../comfyWorkflowService';
import { downloadUrlAndSave, saveBinaryToProjectData } from '../fileService';
import type { AIAudioGenParams, AudioGenerationResult } from '../../types/aiTypes';
import { resolveGeneralModel, resolveGeneralModelConnection } from './helpers';
import { executeGeneralAsyncTask } from './apimartGen';
import { runConfiguredModelProtocol } from './modelProtocolRuntime';
import { mediaProviderRegistry } from './mediaProviderRegistry';

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

  const registeredAdapter = mediaProviderRegistry.getAudioAdapter(provider);
  if (registeredAdapter) {
    return registeredAdapter.generateAudio({ params, prompt, signal });
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

/** RunningHub 标准模型 Adapter。固定 manifest 选路；工作流协议仍由 runninghubWorkflow 执行。 */
import { isRemoteMediaUrl } from '../../../utils/mediaUrl';
import { useAppStore } from '../../../store/useAppStore';
import type { AIImageGenParams, AIVideoGenParams, AIAudioGenParams } from '../../../types/aiTypes';
import type { RunningHubConnection, RunningHubMediaKind, RunningHubOutput } from '../../../types/runninghub';
import type { MediaProviderAdapter } from '../mediaProviderRegistry';
import { getMediaReferenceUrls } from '../connectedReferenceMedia';
import { corsSafeFetch } from '../httpTransport';
import { pollTask } from '../../pollTask';
import { runningHubConnection } from '../../workflowExecutionService';
import { registerCanvasDerivation, isCanvasDerivationFresh, completeCanvasDerivation } from '../../canvasDerivationGuard';
import { registerNodePolling, cleanupNodePolling, getPendingTasksForProject, savePendingTask, updatePendingTask, removePendingTask } from '../../pollManager';
import { uploadRunningHubMedia } from './runninghubClient';
import { saveRunningHubOutputs, RunningHubTaskFailed, type RunningHubReferences } from './runninghubWorkflow';
import { getRunningHubModel, isLegacyRunningHubModel, parseRunningHubModelParameter, type RunningHubModelDefinition, type RunningHubModelValue } from './runninghubModelManifest';
import { mapImageDimensions } from '../../aiDimensions';

class RunningHubModelRequestError extends Error {
  readonly status: number;
  constructor(status: number) { super(`RunningHub 模型请求失败（HTTP ${status}）`); this.status = status; }
}
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
async function modelRequest(connection: RunningHubConnection, endpoint: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
  if (endpoint !== 'query' && getRunningHubModel(endpoint)?.id !== endpoint) throw new Error('未配置该 RunningHub 模型的执行合同');
  const activeSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000);
  let response: Response;
  try {
    response = await corsSafeFetch(`${connection.baseUrl}/openapi/v2/${endpoint}`, {
      method: 'POST', headers: { Authorization: `Bearer ${connection.apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: activeSignal,
    });
  } catch { throw new Error(activeSignal.aborted ? 'RunningHub 模型查询已停止或超时，任务保留' : 'RunningHub 模型连接中断，任务保留，请勿重复提交'); }
  if (!response.ok) throw new RunningHubModelRequestError(response.status);
  const text = await response.text();
  if (text.length > 1_500_000) throw new Error('RunningHub 模型响应超过大小限制');
  let parsed: unknown;
  try { parsed = JSON.parse(text.replace(/("taskId"\s*:\s*)(\d{16,})(?=\s*[,}])/g, '$1"$2"')); }
  catch { throw new Error('RunningHub 模型返回无效 JSON'); }
  if (!record(parsed)) throw new Error('RunningHub 模型返回格式无效');
  if (parsed.code !== undefined && parsed.code !== 0 && parsed.code !== 200) throw new Error('RunningHub 模型请求未成功，请核对账户或任务状态');
  return record(parsed.data) ? parsed.data : parsed;
}

function mediaSource(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('参考素材必须来自媒体引用或有效 URL'); }
  if (!['http:', 'https:', 'data:', 'blob:', 'asset:'].includes(url.protocol) || url.username || url.password) throw new Error('不支持的参考素材地址');
  return value;
}

/** 先完成类型/数量校验，再上传；显式参数优先，空字符串表示不使用该可选字段。 */
export async function buildRunningHubModelRequest(
  connection: RunningHubConnection, model: RunningHubModelDefinition, prompt: string,
  parameters: Record<string, string> = {}, references: RunningHubReferences = {}, signal?: AbortSignal,
): Promise<Record<string, RunningHubModelValue>> {
  const names = new Set(model.parameters.map((field) => field.name));
  if (Object.keys(parameters).some((name) => !names.has(name))) throw new Error('模型参数已变化，请重新选择模型并检查参数');
  const body: Record<string, RunningHubModelValue> = {};
  const consumed: Record<RunningHubMediaKind, Set<number>> = { image: new Set(), video: new Set(), audio: new Set() };
  for (const field of model.parameters) {
    let raw = parameters[field.name];
    if (raw === undefined && field.binding === 'prompt') raw = prompt;
    if (field.binding && field.binding !== 'prompt') {
      const sources = references[field.binding] ?? [];
      if (field.schema.type === 'array') { if (raw === undefined && sources.length) raw = JSON.stringify(sources); sources.forEach((_, i) => consumed[field.binding as RunningHubMediaKind].add(i)); }
      else if (sources[field.referenceIndex ?? 0]) { if (raw === undefined) raw = sources[field.referenceIndex ?? 0]; consumed[field.binding].add(field.referenceIndex ?? 0); }
    }
    const value = parseRunningHubModelParameter(field, raw);
    if (value !== undefined) {
      if (field.mediaKind) (Array.isArray(value) ? value : [value]).forEach((url) => mediaSource(String(url)));
      body[field.name] = value;
    }
  }
  for (const kind of ['image', 'video', 'audio'] as const) {
    if ((references[kind] ?? []).some((_, index) => !consumed[kind].has(index))) throw new Error(`此操作未使用全部${{ image: '图片', video: '视频', audio: '音频' }[kind]}参考，请检查所选操作及素材数量`);
  }
  // 标准模型的流式/内联 Base64 产物不能冒充统一 URL 异步合同。
  if (body.stream === true || body.enable_base64_output === true) throw new Error('当前节点使用异步 URL 结果，请关闭流式和 Base64 输出');
  if (model.id.includes('doubao-seed-audio') && body.audio_url && body.image_url) throw new Error('豆包音频的图片参考与音频参考不能同时使用');
  if (model.id.includes('qwen-image-3') && typeof body.size === 'string') {
    const match = /^(\d+)\*(\d+)$/.exec(body.size);
    if (!match || Number(match[1]) * Number(match[2]) < 512 * 512 || Number(match[1]) * Number(match[2]) > 2048 * 2048) throw new Error('Qwen Image 3 尺寸需为宽*高，总像素在 512²–2048² 内');
  }
  const uploads = new Map<string, string>();
  for (const field of model.parameters) {
    if (!field.mediaKind || body[field.name] === undefined) continue;
    const value = body[field.name];
    const urls = Array.isArray(value) ? value : [String(value)];
    const remote: string[] = [];
    for (const url of urls) {
      signal?.throwIfAborted();
      if (isRemoteMediaUrl(url)) remote.push(url);
      else {
        const key = `${field.mediaKind}:${url}`;
        let uploaded = uploads.get(key);
        if (!uploaded) { uploaded = (await uploadRunningHubMedia(connection, url, field.mediaKind, signal)).url; uploads.set(key, uploaded); }
        remote.push(uploaded);
      }
    }
    body[field.name] = Array.isArray(value) ? remote : remote[0];
  }
  return body;
}

export function parseRunningHubModelOutputs(results: unknown, kind: RunningHubMediaKind): RunningHubOutput[] {
  if (!Array.isArray(results)) throw new Error('RunningHub 已完成但未返回产物数组');
  const outputs: RunningHubOutput[] = [];
  for (const result of results) {
    if (!record(result) || typeof result.url !== 'string') continue;
    let url: URL;
    try { url = new URL(result.url); } catch { continue; }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) continue;
    const format = String(result.outputType || url.pathname.split('.').pop() || '').toLowerCase().replace(/^\./, '');
    const resultKind = /^(image|png|jpg|jpeg|webp|gif|bmp|tiff|avif)$/.test(format) ? 'image'
      : /^(video|mp4|webm|mov|mkv|avi)$/.test(format) ? 'video'
        : /^(audio|mp3|wav|flac|ogg|m4a|aac|pcm|opus)$/.test(format) ? 'audio' : undefined;
    if ((resultKind && resultKind !== kind) || /^(json|txt|obj|glb|gltf|zip)$/.test(format)) continue;
    outputs.push({ url: result.url, kind });
  }
  if (!outputs.length) throw new Error('RunningHub 未返回所选类型的媒体产物，任务已保留');
  return outputs;
}

export async function queryRunningHubModel(connection: RunningHubConnection, taskIds: string[], kind: RunningHubMediaKind, signal?: AbortSignal, onStatus?: (stage: string) => void): Promise<RunningHubOutput[]> {
  const outputs: RunningHubOutput[] = [];
  for (const taskId of taskIds) {
    try {
      const result = await pollTask<Record<string, unknown>, RunningHubOutput[]>({
        signal, interval: 3000, maxDuration: 2 * 60 * 60 * 1000, timeoutMsg: 'RunningHub 查询超时，任务已保留，可继续查询',
        fetchState: () => modelRequest(connection, 'query', { taskId }, signal),
        isComplete: (task) => {
          const status = String(task.status ?? '').toUpperCase();
          if (['FAILED', 'CANCELED', 'CANCELLED'].includes(status)) throw new RunningHubTaskFailed('RunningHub 模型任务失败或已取消');
          if (status === 'SUCCESS') return parseRunningHubModelOutputs(task.results, kind);
          if (!['QUEUED', 'RUNNING'].includes(status)) throw new Error('RunningHub 返回未知状态，任务已保留');
          onStatus?.(status === 'QUEUED' ? '排队中' : '生成中'); return null;
        },
      });
      outputs.push(...result);
    } catch (error) { if (!(error instanceof RunningHubTaskFailed)) throw error; }
  }
  if (!outputs.length) throw new RunningHubTaskFailed('RunningHub 模型任务失败或已取消');
  return outputs;
}

type ModelParams = AIImageGenParams | AIVideoGenParams | AIAudioGenParams;
export async function executeRunningHubModel(params: ModelParams, kind: RunningHubMediaKind, prompt: string, references: RunningHubReferences, count = 1, externalSignal?: AbortSignal, connectionOverride?: RunningHubConnection): Promise<RunningHubOutput[]> {
  const store = useAppStore.getState();
  const explicitImage = getRunningHubModel(params.model, true)?.parameters.some((field) => field.binding === 'image' && params.runninghubModelParameters?.[field.name]?.trim());
  const definition = getRunningHubModel(params.model, !!references.image?.length || explicitImage);
  if (!definition || definition.kind !== kind) throw new Error('RunningHub 模型或输出类型不匹配');
  if (!Number.isInteger(count) || count < 1 || count > 16 || (kind !== 'image' && count !== 1)) throw new Error('不支持的 RunningHub 生成数量');
  const connection = connectionOverride ?? runningHubConnection(store.config.providers, 'runninghub-model');
  const context = params.runninghubTaskContext;
  const projectId = context?.projectId ?? store.currentProjectId;
  const nodeId = params.nodeId;
  const trackingId = nodeId ?? (context ? `runninghub-message-${context.messageId}` : undefined);
  if (trackingId && projectId && getPendingTasksForProject(projectId).some((task) => task.nodeId === trackingId)) throw new Error('已有 RunningHub 任务，请先继续查询或确认远端任务结束');
  const nodeSignal = trackingId ? registerNodePolling(trackingId) : undefined;
  const signal = nodeSignal && externalSignal ? AbortSignal.any([nodeSignal, externalSignal]) : nodeSignal ?? externalSignal;
  const guard = nodeId ? registerCanvasDerivation(store, nodeId) : null;
  const fresh = () => !signal?.aborted && (!nodeId || (!!guard && isCanvasDerivationFresh(guard, useAppStore.getState())))
    && (!context || (useAppStore.getState().currentProjectId === context.projectId && useAppStore.getState().messages.some((message) => message.id === context.messageId && message.conversationId === context.conversationId)));
  const stage = (runninghubStage: string) => { if (nodeId && fresh()) useAppStore.getState().updateNodeDataTransient(nodeId, { runninghubStage }); };
  const taskIds: string[] = [];
  let submitting = false;
  try {
    if (!fresh()) throw new Error('项目或节点已变化，未提交任务');
    let parameters = params.runninghubModelParameters ?? {};
    // 旧组合模型继续接受既有比例/分辨率；新增操作由各自表单明确设置。
    if (isLegacyRunningHubModel(params.model) && kind === 'image') {
      const image = params as AIImageGenParams;
      parameters = { ...parameters };
      for (const [name, value] of Object.entries({ aspectRatio: image.aspectRatio, resolution: image.imageSize?.toLowerCase() })) {
        const field = definition.parameters.find((item) => item.name === name);
        if (field && value && parameters[name] === undefined && (!field.schema.enum || field.schema.enum.includes(value))) parameters[name] = value;
      }
    }
    stage('检查参数与上传素材');
    const body = await buildRunningHubModelRequest(connection, definition, prompt, parameters, references, signal);
    if (count > 1 && ['n', 'imageNum', 'numImages', 'maxImages'].some((key) => Number(body[key]) > 1)) throw new Error('请仅使用一处数量设置：节点批量数量或模型产物数量');
    if (!fresh()) throw new Error('画布已变化，未提交任务');
    if (trackingId && projectId) savePendingTask({ nodeId: trackingId, projectId, nodeType: store.nodes.find((node) => node.id === nodeId)?.data.type ?? `ai-${kind}`, provider: 'runninghub', providerConfigId: 'runninghub-model', taskType: 'runninghub-model', taskId: '', taskIds: [], submitted: false, runninghubRecoveryState: 'submit_unknown', runninghubModelId: params.model, runninghubMessage: context, batchCount: count });
    for (let index = 0; index < count; index++) {
      signal?.throwIfAborted();
      stage(count > 1 ? `提交任务 ${index + 1}/${count}` : '提交任务');
      submitting = true;
      if (trackingId) updatePendingTask(trackingId, { runninghubRecoveryState: 'submit_unknown', runninghubSubmissionUncertain: true });
      const response = await modelRequest(connection, definition.id, body, signal);
      if (typeof response.taskId !== 'string' || !/^\d{1,30}$/.test(response.taskId)) throw new Error('RunningHub 未返回有效任务 ID，请到平台确认提交状态');
      taskIds.push(response.taskId); submitting = false;
      if (trackingId) updatePendingTask(trackingId, { taskId: taskIds[0], taskIds: [...taskIds], submitted: true, runninghubRecoveryState: 'disconnected', runninghubSubmissionUncertain: false });
    }
    const outputs = await queryRunningHubModel(connection, taskIds, kind, signal, stage);
    if (!fresh()) throw new Error('画布或对话已变化，任务已保留');
    if (trackingId) updatePendingTask(trackingId, { runninghubRecoveryState: 'save_pending' }, taskIds[0]);
    stage('保存产物');
    const saved = await saveRunningHubOutputs(outputs, projectId, definition.label, fresh);
    if (nodeId && fresh()) useAppStore.getState().updateNodeDataTransient(nodeId, { runninghubOutputs: saved });
    return saved;
  } catch (error) {
    if (trackingId) {
      const certainRejection = error instanceof RunningHubModelRequestError && error.status < 500 && ![408, 429].includes(error.status);
      if ((!taskIds.length && certainRejection) || (error instanceof RunningHubTaskFailed && taskIds.length === 1)) removePendingTask(trackingId, taskIds[0] ?? '');
      else if (submitting) updatePendingTask(trackingId, { runninghubRecoveryState: 'submit_unknown', runninghubSubmissionUncertain: !certainRejection });
    }
    if (nodeId && fresh()) stage('任务已保留，可继续查询');
    if (!nodeId && context && taskIds.length) throw new Error(`RunningHub 任务 ${taskIds.join('、')} 已保留，重新打开项目时继续查询。`, { cause: error });
    throw error;
  } finally {
    if (guard) completeCanvasDerivation(guard);
    if (trackingId) cleanupNodePolling(trackingId, nodeSignal);
  }
}

export const runninghubMediaProviderAdapter: MediaProviderAdapter = {
  providerId: 'runninghub', capabilities: ['image', 'video', 'audio'],
  generateImage: async ({ params, prompt, imageUrls, referenceMedia, requestedCount, signal }) => {
    const outputs = await executeRunningHubModel(params, 'image', prompt, {
      image: imageUrls, video: referenceMedia ? getMediaReferenceUrls(referenceMedia, 'video', 'local') : undefined,
      audio: referenceMedia ? getMediaReferenceUrls(referenceMedia, 'audio', 'local') : undefined,
    }, requestedCount, signal);
    const dimensions = mapImageDimensions(params.imageSize ?? '2K', params.aspectRatio ?? '1:1');
    return { requestedCount, failedCount: Math.max(0, requestedCount - outputs.length), results: outputs.map((output) => ({ url: output.url, ...dimensions, runninghubOutputs: outputs })) };
  },
  generateVideo: async ({ params, resolveReferenceInput, signal }) => {
    const input = await resolveReferenceInput();
    const references = input.references ?? [];
    const outputs = await executeRunningHubModel(params, 'video', input.prompt, {
      image: references.length ? getMediaReferenceUrls(references, 'image', 'local') : input.imageUrls,
      video: references.length ? getMediaReferenceUrls(references, 'video', 'local') : input.videoUrls,
      audio: references.length ? getMediaReferenceUrls(references, 'audio', 'local') : input.audioUrls,
    }, 1, signal);
    return { url: outputs[0].url, runninghubOutputs: outputs };
  },
  generateAudio: async ({ params, prompt, referenceAudioUrls, referenceMedia, signal }) => {
    const outputs = await executeRunningHubModel(params, 'audio', prompt, referenceMedia ? {
      image: getMediaReferenceUrls(referenceMedia, 'image', 'local'), video: getMediaReferenceUrls(referenceMedia, 'video', 'local'), audio: getMediaReferenceUrls(referenceMedia, 'audio', 'local'),
    } : { audio: referenceAudioUrls }, 1, signal);
    return { url: outputs[0].url, runninghubOutputs: outputs };
  },
};

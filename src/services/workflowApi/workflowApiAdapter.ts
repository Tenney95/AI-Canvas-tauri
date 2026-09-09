import { isRemoteMediaUrl } from '../../utils/mediaUrl';
import type { ApiProviderConfig } from '../../types';
import type {
  CloudWorkflowOutput, WorkflowApiConnection, WorkflowApiInputValues, WorkflowApiManifest,
  WorkflowApiReferences, WorkflowApiTaskDescriptor, DeclarativeWorkflowApiManifest,
} from '../../types/workflowApi';
import { useAppStore } from '../../store/useAppStore';
import { isLocalImageUrl, resolveMediaReferenceUrl } from '../uploadService';
import { parseModelExecutionProtocol, pollResolvedModelProtocol, submitModelProtocol, type ModelProtocolVariables } from '../ai/modelProtocol';
import { resolvePoll } from '../ai/modelProtocolPoll';
import { readModelProtocolFirstScalar } from '../ai/modelProtocolResponse';
import { findUnusedReferenceVariables } from '../ai/modelProtocolRuntime';
import { resolveDeclaredWorkflowInputs, validateDeclarativeWorkflowManifest, workflowApiOutputKind } from './workflowApiDefinition';
import { corsSafeFetch } from '../ai/httpTransport';
import { buildSameOriginUrl } from '../ai/modelProtocolRequest';
import { pollTask } from '../pollTask';
import {
  cancelNodePolling, cleanupNodePolling, getPendingTasksForProject, registerNodePolling,
  removePendingTask, savePendingTask, updatePendingTask,
} from '../pollManager';
import { completeCanvasDerivation, isCanvasDerivationFresh, registerCanvasDerivation } from '../canvasDerivationGuard';
import { saveCloudWorkflowOutputs } from '../workflowExecutionService';
import { normalizeWorkflowApiBaseUrl, AUTODL_H3_WORKFLOW, resolveWorkflowApiInputValues, validateWorkflowApiManifest } from './autodlWorkflowManifest';

const TASK_ID = /^[\w-]{1,128}$/;
const RETRY_HTTP = new Set([408, 429, 500, 502, 503, 504]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export class WorkflowApiTaskFailed extends Error {}
class WorkflowApiRequestError extends Error {
  readonly retryable: boolean;
  readonly rejected: boolean;
  constructor(message: string, retryable = false, rejected = false) {
    super(message);
    this.retryable = retryable;
    this.rejected = rejected;
  }
}

/** 只传给调用方可读的短错误；禁止令牌或响应正文进入持久化错误信息。 */
function responseMessage(value: unknown, apiKey: string): string {
  if (typeof value !== 'string') return '';
  return value.split(apiKey).join('[令牌]').split(encodeURIComponent(apiKey)).join('[令牌]')
    .replace(/https?:\/\/\S+/gi, '[地址]').replace(/[\r\n\t]+/g, ' ').slice(0, 300);
}

export function workflowApiConnection(config: ApiProviderConfig | undefined, manifest?: WorkflowApiManifest): WorkflowApiConnection {
  const authOptional = manifest?.version === 2 && manifest.protocol.auth?.type === 'none';
  if (!config || (!authOptional && !config.apiKey?.trim())) throw new Error('请先配置工作流 API 的 Token');
  const apiKey = config.apiKey?.trim() ?? '';
  if ([...apiKey].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) throw new Error('工作流 API Token 包含无效字符');
  if (manifest?.version === 2 && !config.baseUrl?.trim()) throw new Error('请填写工作流 API 连接地址');
  return { apiKey, baseUrl: normalizeWorkflowApiBaseUrl(config.baseUrl, manifest?.version === 2) };
}

function assertPublicUrl(source: URL): void {
  const host = source.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  const ipv4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
  const privateV4 = ipv4 && (Number(ipv4[1]) === 0 || Number(ipv4[1]) === 10 || Number(ipv4[1]) === 127
    || (Number(ipv4[1]) === 169 && Number(ipv4[2]) === 254)
    || (Number(ipv4[1]) === 172 && Number(ipv4[2]) >= 16 && Number(ipv4[2]) <= 31)
    || (Number(ipv4[1]) === 192 && Number(ipv4[2]) === 168)
    || (Number(ipv4[1]) === 100 && Number(ipv4[2]) >= 64 && Number(ipv4[2]) <= 127));
  if (!['https:', 'http:'].includes(source.protocol) || source.username || source.password || privateV4
    || (!host.includes('.') && !host.includes(':')) || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')
    || host === '::' || host === '::1' || /^(?:f[cd][\da-f]{2}:|fe[89ab][\da-f]:|::ffff:)/.test(host)) {
    throw new Error('工作流参考素材必须是上游可访问的公网 URL');
  }
}

function validateReference(value: string, kind: 'image' | 'audio'): URL {
  let source: URL;
  try { source = new URL(value); } catch { throw new Error('工作流参考素材地址无效'); }
  if (source.username || source.password || !['http:', 'https:', 'asset:', 'file:', 'data:', 'blob:'].includes(source.protocol)) throw new Error('工作流参考素材地址无效');
  if (isRemoteMediaUrl(value)) assertPublicUrl(source);
  const spec = kind === 'image' ? AUTODL_H3_WORKFLOW.images : AUTODL_H3_WORKFLOW.audio;
  if (source.protocol === 'data:') {
    const mime = /^data:([^;,]+);base64,/i.exec(value)?.[1]?.toLowerCase();
    if (!mime || !(spec.mimeTypes as readonly string[]).includes(mime)) throw new Error('工作流参考素材格式不支持');
  } else if (!['blob:', 'data:'].includes(source.protocol)) {
    const extension = source.pathname.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase();
    if (extension && !(spec.extensions as readonly string[]).includes(extension)) throw new Error('工作流参考素材格式不支持');
  }
  return source;
}

/** 所有本地可知错误先检查，再顺序上传；编号字段不经过模型协议的整数组校验。 */
export async function buildWorkflowApiInputs(
  manifest: WorkflowApiManifest, prompt: string, inputs: WorkflowApiInputValues = {},
  references: WorkflowApiReferences = {}, signal?: AbortSignal,
): Promise<Record<string, string | number>> {
  signal?.throwIfAborted();
  validateWorkflowApiManifest(manifest);
  if (manifest.version !== 1) throw new Error('自定义工作流必须按声明式协议执行');
  if (typeof prompt !== 'string' || !prompt.trim() || [...prompt].length > AUTODL_H3_WORKFLOW.prompt.max) throw new Error('工作流提示词必须是 1–10000 个字符');
  resolveWorkflowApiInputValues(inputs);
  const values = resolveWorkflowApiInputValues({ ...manifest.defaults, ...inputs });
  const images = references.image ?? [];
  const audios = references.audio ?? [];
  if (!Array.isArray(images) || images.length < AUTODL_H3_WORKFLOW.images.min || images.length > AUTODL_H3_WORKFLOW.images.max) throw new Error('此工作流需要 1–9 张参考图片');
  if (!Array.isArray(audios) || audios.length > AUTODL_H3_WORKFLOW.audio.max) throw new Error('此工作流最多接收 3 段参考音频');
  if (references.video?.length) throw new Error('此工作流不支持参考视频');
  const media = [
    ...images.map((url, index) => ({ url, kind: 'image' as const, field: `${AUTODL_H3_WORKFLOW.images.fieldPrefix}${index}` })),
    ...audios.map((url, index) => ({ url, kind: 'audio' as const, field: `${AUTODL_H3_WORKFLOW.audio.fieldPrefix}${index}` })),
  ].map((item) => ({ ...item, source: validateReference(item.url, item.kind) }));
  const body: Record<string, string | number> = {
    prompt, duration: values.duration,
    resolution: `${values.resolution}${AUTODL_H3_WORKFLOW.resolutionSuffix[values.ratio]}`,
    ...(values.seed !== undefined ? { seed: values.seed } : {}),
  };
  for (const item of media) {
    signal?.throwIfAborted();
    const remote = isRemoteMediaUrl(item.url);
    const url = remote ? item.url : await resolveMediaReferenceUrl(item.url, {
      provider: manifest.connectionId, kind: item.kind, mode: 'publicUrl', signal,
    });
    signal?.throwIfAborted();
    assertPublicUrl(new URL(url));
    body[item.field] = url;
  }
  return body;
}

function validateWorkflowBusinessStatus(manifest: DeclarativeWorkflowApiManifest, payload: unknown): void {
  const status = manifest.businessStatus;
  if (!status) return;
  const value = readModelProtocolFirstScalar(payload, status.path);
  if (!status.successValues.some((allowed) => String(allowed).toLowerCase() === String(value).toLowerCase())) {
    const detail = status.errorPath ? readModelProtocolFirstScalar(payload, status.errorPath) : undefined;
    throw new WorkflowApiTaskFailed(`工作流接口返回业务失败${typeof detail === 'string' || typeof detail === 'number' ? `：${String(detail).slice(0, 300)}` : '，请检查参数和平台状态'}`);
  }
}

async function prepareDeclaredWorkflowVariables(manifest: DeclarativeWorkflowApiManifest, prompt: string,
  input: WorkflowApiInputValues = {}, references: WorkflowApiReferences = {}, signal?: AbortSignal): Promise<ModelProtocolVariables> {
  const parameters = resolveDeclaredWorkflowInputs(manifest, input);
  if (typeof prompt !== 'string' || (manifest.prompt?.required !== false && !prompt.trim())
    || [...prompt].length > (manifest.prompt?.maxLength ?? 10000)) throw new Error('工作流提示词为空或超过声明的长度');
  const media = (['image', 'video', 'audio'] as const).flatMap((kind) => {
    const urls = references[kind] ?? [];
    const limit = manifest.references[kind] ?? { min: 0, max: 0 };
    if (!Array.isArray(urls) || urls.length < limit.min || urls.length > limit.max) throw new Error(`工作流 ${kind} 素材数量必须在 ${limit.min}–${limit.max} 之间`);
    return urls.map((url) => {
      let source: URL;
      try { source = new URL(url); } catch { throw new Error('工作流参考素材地址无效'); }
      if (source.username || source.password || !['http:', 'https:', 'asset:', 'file:', 'data:', 'blob:'].includes(source.protocol)) throw new Error('工作流参考素材地址无效');
      if (!isLocalImageUrl(url)) assertPublicUrl(source);
      const extension = source.protocol === 'data:' ? /^data:[^/]+\/([^;,]+)/i.exec(url)?.[1]?.replace(/^x-/, '').replace('jpeg', 'jpg').replace('mpeg', 'mp3')
        : source.protocol === 'blob:' ? undefined : source.pathname.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase();
      if (extension && limit.extensions?.length && !limit.extensions.includes(extension)) throw new Error(`工作流 ${kind} 素材格式不支持`);
      return { kind, url };
    });
  });
  const variables = (): ModelProtocolVariables => {
    const imageUrls = media.filter((item) => item.kind === 'image').map((item) => item.url);
    const videoUrls = media.filter((item) => item.kind === 'video').map((item) => item.url);
    const audioUrls = media.filter((item) => item.kind === 'audio').map((item) => item.url);
    return { ...parameters, model: manifest.workflowId, prompt, parameters: Object.fromEntries(Object.entries(parameters).filter((entry): entry is [string, string | number | boolean] => entry[1] !== undefined)),
      imageUrls, referenceImageUrls: imageUrls, videoUrls, referenceVideoUrls: videoUrls, referenceVideoUrl: videoUrls[0],
      audioUrls, referenceAudioUrls: audioUrls, audioUrl: audioUrls[0], firstImage: imageUrls[0], lastImage: imageUrls.length > 1 ? imageUrls.at(-1) : undefined,
      referenceUrls: media.map((item) => item.url), seedanceDuration: parameters.duration, seedanceResolution: parameters.resolution,
      aspectRatio: parameters.ratio, seedanceRatio: parameters.ratio };
  };
  if (findUnusedReferenceVariables(JSON.stringify(manifest.protocol), variables(), { frameAliases: true }).length) throw new Error('工作流协议未映射全部参考素材，请检查数组变量或逐项编号字段');
  for (const item of media) {
    signal?.throwIfAborted();
    item.url = await resolveMediaReferenceUrl(item.url, { provider: manifest.connectionId, mode: 'publicUrl', kind: item.kind, signal });
    assertPublicUrl(new URL(item.url));
  }
  return variables();
}

function declaredWorkflowOutputs(urls: string[] | undefined, manifest: DeclarativeWorkflowApiManifest): CloudWorkflowOutput[] {
  if (!urls?.length) throw new Error('工作流完成但未返回配置的媒体 URL');
  if (urls.length > 64) throw new Error('工作流一次最多接收 64 个输出');
  return [...new Set(urls)].map((url) => { assertPublicUrl(new URL(url)); return { url, sourceUrl: url, kind: manifest.outputKind }; });
}

function manualTaskPoll(manifest: DeclarativeWorkflowApiManifest, baseUrl: string, taskId: string) {
  const protocol = parseModelExecutionProtocol(manifest.protocol);
  if (!protocol.poll) throw new Error('同步工作流没有可恢复的查询接口');
  const payload: Record<string, unknown> = { task_id: taskId };
  const parts = (protocol.response.taskIdPath ?? 'task_id').replace(/\[(\d+)\]/g, '.$1').split('.');
  if (parts.some((part) => !/^\w+$/.test(part) || ['__proto__', 'constructor', 'prototype'].includes(part))) throw new Error('请使用提交响应中的任务 ID 恢复');
  let cursor = payload;
  for (const part of parts.slice(0, -1)) { const nested: Record<string, unknown> = {}; cursor[part] = nested; cursor = nested; }
  cursor[parts.at(-1)!] = taskId;
  return resolvePoll(baseUrl, protocol.poll, protocol.auth, { submit: payload });
}

async function requestWorkflowApi(
  connection: WorkflowApiConnection, path: string, method: 'POST' | 'GET',
  body?: Record<string, string | number>, signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  signal?.throwIfAborted();
  const url = buildSameOriginUrl(connection.baseUrl, { method, path, pathMode: 'origin' }, {});
  const timeout = AbortSignal.timeout(120_000);
  const activeSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let response: Response;
  let text: string;
  try {
    response = await corsSafeFetch(url, {
      method, headers: { Authorization: connection.apiKey, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: activeSignal,
    });
    text = await response.text();
  } catch {
    if (signal?.aborted) throw new Error('工作流查询已停止，远端任务可能仍在运行');
    throw new WorkflowApiRequestError('工作流 API 连接中断或超时，请继续查询，不要重复提交', true);
  }
  // 提交响应已经收到时仍提取 ID，避免取消竞态把可恢复任务退回未知状态。
  if (method === 'GET') signal?.throwIfAborted();
  if (text.length > 1_500_000) throw new Error('工作流 API 响应超过允许大小');
  let payload: unknown;
  try { payload = JSON.parse(text); } catch { payload = null; }
  const message = isRecord(payload) ? responseMessage(payload.msg, connection.apiKey) : '';
  if (!response.ok) throw new WorkflowApiRequestError(
    `工作流 API 请求失败（HTTP ${response.status}）${message ? `：${message}` : ''}`,
    RETRY_HTTP.has(response.status), response.status >= 400 && response.status < 500 && ![408, 429].includes(response.status),
  );
  if (!isRecord(payload) || typeof payload.code !== 'string') throw new Error('工作流 API 返回格式无效或缺少业务状态码');
  if (payload.code.toLowerCase() !== 'success') throw new WorkflowApiRequestError(`工作流 API 请求失败${message ? `：${message}` : ''}`, false, true);
  return payload;
}

export function validateWorkflowApiTaskDescriptor(value: unknown): asserts value is WorkflowApiTaskDescriptor {
  if (isRecord(value) && value.adapter === 'declarative') {
    if (Object.keys(value).some((key) => !['version', 'attemptId', 'adapter', 'workflowId', 'remoteWorkflowId', 'origin', 'state', 'manifest', 'poll', 'outputs'].includes(key))
      || value.version !== 1 || typeof value.attemptId !== 'string' || !/^[\w-]{1,80}$/.test(value.attemptId)
      || typeof value.workflowId !== 'string' || !value.workflowId || typeof value.origin !== 'string'
      || !['submit_unknown', 'disconnected', 'save_pending'].includes(String(value.state))) throw new Error('工作流任务恢复描述无效');
    validateDeclarativeWorkflowManifest(value.manifest);
    if (value.remoteWorkflowId !== value.manifest.workflowId || new URL(value.origin).origin !== value.origin) throw new Error('工作流任务连接绑定无效');
    return;
  }
  if (!isRecord(value) || Object.keys(value).some((key) => !['version', 'attemptId', 'adapter', 'workflowId', 'remoteWorkflowId', 'origin', 'state'].includes(key))
    || value.version !== 1 || value.adapter !== 'autodl-comfyui'
    || typeof value.attemptId !== 'string' || !/^[\w-]{1,80}$/.test(value.attemptId)
    || value.remoteWorkflowId !== AUTODL_H3_WORKFLOW.id || typeof value.workflowId !== 'string' || !value.workflowId
    || typeof value.origin !== 'string' || !['submit_unknown', 'disconnected', 'save_pending'].includes(String(value.state))) throw new Error('工作流任务恢复描述无效');
  const url = new URL(value.origin);
  if (url.origin !== value.origin || !['http:', 'https:'].includes(url.protocol)) throw new Error('工作流任务连接绑定无效');
}

export async function queryWorkflowApiTask(
  connection: WorkflowApiConnection, taskId: string, descriptor: WorkflowApiTaskDescriptor,
  signal?: AbortSignal, onStatus?: (status: string) => void,
): Promise<CloudWorkflowOutput[]> {
  validateWorkflowApiTaskDescriptor(descriptor);
  if (descriptor.adapter === 'declarative') {
    const manifest = descriptor.manifest!;
    if (!/^[\w.:-]{1,256}$/.test(taskId) || new URL(connection.baseUrl).origin !== descriptor.origin) throw new Error('工作流任务 ID 或连接地址不匹配');
    if (descriptor.outputs) return declaredWorkflowOutputs(descriptor.outputs.map((output) => output.url), manifest);
    const poll = descriptor.poll ?? manualTaskPoll(manifest, connection.baseUrl, taskId);
    onStatus?.('查询任务');
    try {
      const result = await pollResolvedModelProtocol(poll, connection.apiKey, signal, connection.baseUrl, (payload) => {
        validateWorkflowBusinessStatus(manifest, payload);
        const status = String(readModelProtocolFirstScalar(payload, poll.statusPath) ?? '').trim().toLowerCase();
        if (poll.failureValues.some((value) => String(value).trim().toLowerCase() === status)) {
          const detail = poll.errorPath ? readModelProtocolFirstScalar(payload, poll.errorPath) : undefined;
          throw new WorkflowApiTaskFailed(`工作流任务失败：${typeof detail === 'string' || typeof detail === 'number' ? String(detail).slice(0, 300) : status}`);
        }
      });
      return declaredWorkflowOutputs(result.urls, manifest);
    } catch (error) {
      if (error instanceof Error) error.message = responseMessage(error.message, connection.apiKey || '\u0000');
      throw error;
    }
  }
  if (!TASK_ID.test(taskId)) throw new Error('工作流任务 ID 无效，请在平台核对');
  if (connection.baseUrl !== descriptor.origin) throw new Error('工作流连接地址已变化，请使用提交时的连接继续查询');
  let retries = 0;
  return pollTask<Record<string, unknown> | null, CloudWorkflowOutput[]>({
    signal, interval: 3000, maxDuration: 2 * 60 * 60 * 1000,
    timeoutMsg: '工作流查询超时，任务已保留，可继续查询',
    fetchState: async () => {
      let payload: Record<string, unknown>;
      try {
        payload = await requestWorkflowApi(connection, `${AUTODL_H3_WORKFLOW.queryPath}${taskId}`, 'GET', undefined, signal);
        retries = 0;
      } catch (error) {
        if (!signal?.aborted && error instanceof WorkflowApiRequestError && error.retryable && retries++ < 3) return null;
        throw error;
      }
      if (!isRecord(payload.data)) throw new Error('工作流查询缺少任务数据，任务已保留');
      const data = payload.data;
      if (data.task_id !== undefined && data.task_id !== taskId) throw new Error('工作流查询返回了其他任务，已停止接收结果');
      const status = typeof data.status === 'string' ? data.status.toUpperCase() : '';
      if (['FAILED', 'CANCELED', 'CANCELLED'].includes(status)) {
        const detail = responseMessage(payload.msg, connection.apiKey);
        throw new WorkflowApiTaskFailed(`工作流任务执行失败或已被远端取消${detail ? `：${detail}` : ''}`);
      }
      if (['QUEUED', 'RUNNING'].includes(status)) {
        onStatus?.(status === 'QUEUED' ? '排队中' : '生成中'); return null;
      }
      if (!['SUCCESS', 'COMPLETED'].includes(status)) throw new Error('工作流返回未知任务状态，任务已保留');
      return data;
    },
    isComplete: (data) => {
      if (!data) return null;
      const results: CloudWorkflowOutput[] = [];
      for (const item of Array.isArray(data.results) ? data.results : []) {
        if (!isRecord(item) || item.type !== 'video' || typeof item.url !== 'string'
          || (item.output_type !== undefined && item.output_type !== 'output')
          || (item.file_type !== undefined && item.file_type !== 'mp4')) continue;
        let url: URL;
        try { url = new URL(item.url); assertPublicUrl(url); } catch { continue; }
        if (!results.some((output) => output.url === url.toString())) results.push({ url: url.toString(), kind: 'video' });
      }
      if (!results.length) throw new Error('工作流已完成，但没有可保存的视频结果');
      return results;
    },
  });
}

/** 节点与对话沿用同一提交、查询、保存过程；任务身份贯穿调用方回填。 */
export async function executeWorkflowApi(params: {
  workflowId: string; nodeId?: string; prompt: string;
  taskContext?: import('../../types/workflowApi').CloudWorkflowTaskContext;
  inputs?: WorkflowApiInputValues; references?: WorkflowApiReferences;
}, externalSignal?: AbortSignal): Promise<CloudWorkflowOutput[]> {
  const store = useAppStore.getState();
  const workflow = store.workflows.find((item) => item.id === params.workflowId);
  if (workflow?.adapterType !== 'workflow-api') throw new Error('未找到工作流 API 定义');
  validateWorkflowApiManifest(workflow.workflowApi);
  const manifest = structuredClone(workflow.workflowApi);
  const outputKind = workflowApiOutputKind(manifest);
  const nodeType = `ai-${outputKind}` as 'ai-image' | 'ai-video' | 'ai-audio';
  const context = params.taskContext;
  const projectId = context?.projectId ?? store.currentProjectId;
  const node = store.nodes.find((item) => item.id === params.nodeId);
  if (!projectId || store.currentProjectId !== projectId || (!params.nodeId && !context)
    || (params.nodeId && (!node || node.data.workflowId !== workflow.id || node.data.type !== nodeType))
    || workflow.category !== nodeType) throw new Error('工作流与当前项目或节点输出类型不匹配');
  const trackingId = params.nodeId ?? `workflow-api-message-${context!.messageId}`;
  if (getPendingTasksForProject(projectId).some((task) => task.nodeId === trackingId)) throw new Error('已有工作流任务，请先继续查询或在平台确认远端任务结束');
  const connection = workflowApiConnection(store.config.providers[manifest.connectionId], manifest);
  const nodeSignal = registerNodePolling(trackingId);
  const signal = externalSignal ? AbortSignal.any([nodeSignal, externalSignal]) : nodeSignal;
  const guard = params.nodeId ? registerCanvasDerivation(store, params.nodeId) : null;
  let taskId = '';
  let submitting = false;
  const descriptor: WorkflowApiTaskDescriptor = {
    version: 1, attemptId: crypto.randomUUID(), adapter: manifest.adapter, workflowId: workflow.id, remoteWorkflowId: manifest.workflowId,
    origin: new URL(connection.baseUrl).origin, state: 'submit_unknown',
    ...(manifest.version === 2 ? { manifest } : {}),
  };
  const ownsRecord = (expectedTaskId = taskId) => getPendingTasksForProject(projectId).some((task) => task.nodeId === trackingId
    && task.taskId === expectedTaskId && task.taskType === 'workflow-api' && task.workflowApi?.attemptId === descriptor.attemptId);
  const fresh = () => !signal.aborted && useAppStore.getState().currentProjectId === projectId
    && (!params.nodeId || (!!guard && isCanvasDerivationFresh(guard, useAppStore.getState())
      && useAppStore.getState().nodes.some((item) => item.id === params.nodeId && item.data.workflowId === workflow.id)))
    && (!context || useAppStore.getState().messages.some((message) => message.id === context.messageId && message.conversationId === context.conversationId))
    && (!submitting || ownsRecord());
  const stage = (workflowApiStage: string) => {
    if (params.nodeId && fresh()) useAppStore.getState().updateNodeDataTransient(params.nodeId, { workflowApiStage });
  };
  try {
    if (!fresh()) throw new Error('画布已变化，未提交工作流');
    stage('准备素材');
    const variables = manifest.version === 2 ? await prepareDeclaredWorkflowVariables(manifest, params.prompt, params.inputs, params.references, signal) : undefined;
    const body = manifest.version === 1 ? await buildWorkflowApiInputs(manifest, params.prompt, params.inputs, params.references, signal) : undefined;
    if (!fresh()) throw new Error('画布已变化，未提交工作流');
    stage('提交任务');
    savePendingTask({ nodeId: trackingId, projectId, nodeType, provider: 'workflow-api',
      taskType: 'workflow-api', providerConfigId: manifest.connectionId, taskId, submitted: false, workflowApi: descriptor, workflowApiMessage: context });
    submitting = true;
    if (manifest.version === 2) {
      const submitted = await submitModelProtocol({ ...connection, protocol: manifest.protocol, variables: variables!, signal,
        validateResponse: (payload) => validateWorkflowBusinessStatus(manifest, payload) });
      taskId = submitted.taskId ?? `sync-${descriptor.attemptId}`;
      if (!/^[\w.:-]{1,256}$/.test(taskId)) throw new Error('工作流未返回有效任务 ID，请到平台确认提交状态');
      if (submitted.poll) descriptor.poll = submitted.poll;
      if (submitted.urls) descriptor.outputs = declaredWorkflowOutputs(submitted.urls, manifest);
    } else {
      const payload = await requestWorkflowApi(connection, AUTODL_H3_WORKFLOW.submitPath, 'POST', body, signal);
      const id = isRecord(payload.data) ? payload.data.task_id : undefined;
      if (typeof id !== 'string' || !TASK_ID.test(id)) throw new Error('工作流未返回有效任务 ID，请到平台确认提交状态');
      taskId = id;
    }
    if (!ownsRecord('')) throw new Error('原工作流任务记录已变化，请到平台核对提交结果');
    updatePendingTask(trackingId, { taskId, submitted: true, workflowApi: { ...descriptor, state: 'disconnected' } }, '');
    const outputs = await queryWorkflowApiTask(connection, taskId, descriptor, signal, stage);
    if (!fresh()) throw new Error('画布已变化，工作流结果已保留，请继续查询');
    if (manifest.version === 2) descriptor.outputs = outputs;
    updatePendingTask(trackingId, { workflowApi: { ...descriptor, state: 'save_pending' } }, taskId);
    stage('保存产物');
    const saved = await saveCloudWorkflowOutputs(outputs, projectId, workflow.name, fresh, '工作流 API');
    if (!fresh()) throw new Error('画布已变化，工作流结果已保留，请继续查询');
    if (params.nodeId) useAppStore.getState().updateNodeDataTransient(params.nodeId, { workflowApiOutputs: saved });
    return saved;
  } catch (error) {
    if (manifest.version === 2 && error instanceof Error) error.message = responseMessage(error.message, connection.apiKey || '\u0000');
    const canReport = fresh();
    if (ownsRecord() && (error instanceof WorkflowApiTaskFailed || (submitting && !taskId && error instanceof WorkflowApiRequestError && error.rejected))) removePendingTask(trackingId, taskId);
    if (params.nodeId && canReport) useAppStore.getState().updateNodeDataTransient(params.nodeId, {
      status: 'error', error: error instanceof Error ? error.message : '工作流执行失败',
      workflowApiStage: taskId ? '查询已停止' : submitting ? '提交状态待确认' : '未提交',
    });
    throw error;
  } finally {
    if (guard) completeCanvasDerivation(guard);
    cleanupNodePolling(trackingId, nodeSignal);
  }
}

export async function executeWorkflowApiMedia(params: Parameters<typeof executeWorkflowApi>[0], signal?: AbortSignal) {
  const outputs = await executeWorkflowApi(params, signal);
  const projectId = params.taskContext?.projectId ?? useAppStore.getState().currentProjectId;
  const trackingId = params.nodeId ?? `workflow-api-message-${params.taskContext?.messageId}`;
  const taskId = projectId ? getPendingTasksForProject(projectId).find((task) => task.nodeId === trackingId && task.taskType === 'workflow-api')?.taskId : undefined;
  return { url: outputs[0].url, workflowApiOutputs: outputs, workflowApiTaskId: taskId };
}

/** 没有配置取消协议；仅停止本地等待，保留远端任务身份。 */
export function stopWorkflowApiNodeTask(nodeId: string): void {
  const store = useAppStore.getState();
  const task = store.currentProjectId ? getPendingTasksForProject(store.currentProjectId).find((item) => item.nodeId === nodeId && item.taskType === 'workflow-api') : undefined;
  cancelNodePolling(nodeId, true);
  store.updateNodeDataTransient(nodeId, task
    ? { status: 'error', error: '已停止等待，远端任务可能仍在运行，可继续查询', workflowApiStage: '查询已停止' }
    : { status: 'idle', error: undefined, workflowApiStage: '未提交' });
}

/** 调用方保存并回填后按精确 taskId 确认，旧请求不能结束新任务。 */
export function completeWorkflowApiNodeTask(nodeId: string, taskId: string): void {
  const store = useAppStore.getState();
  const task = store.currentProjectId ? getPendingTasksForProject(store.currentProjectId).find((item) => item.nodeId === nodeId && item.taskType === 'workflow-api' && item.taskId === taskId) : undefined;
  if (task?.workflowApi?.state !== 'save_pending') return;
  removePendingTask(nodeId, taskId);
  store.updateNodeDataTransient(nodeId, { workflowApiStage: '已完成' });
}

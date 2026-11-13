/** 无声明式 profile 的既有通用任务合同；新项目保留原 ID，恢复绝不重发生成。 */
import type { MediaKind, NativeMediaLocalOutput } from '../types/media';
import type { CanvasContext } from '../types/project';
import { useAppStore } from '../store/useAppStore';
import { executeCharacterImageTask, isCharacterImageTaskContext } from './characterImageTaskContext';
import { resolveGeneralModelConnection, splitCommaSeparatedUrls, toImageDataUrl } from './ai/helpers';
import { corsSafeFetch } from './ai/httpTransport';
import { classifyHttpResponseFailure, getHttpResponseError, HttpResponseError } from './ai/httpUtils';
import { throwIfDefinitiveModelResponseFailure } from './ai/modelProtocolHttp';
import { createMediaDownloadAccess } from './ai/mediaDownloadAccess';
import { captureLegacyCanvasContext, isProjectExpectedContextCurrent } from './projectExecutionContext';
import { assertNativeVideoSubmissionInput, captureNativeVideoSubmissionBaseline, isNativeVideoSubmissionGuard } from './nativeVideoSubmission';
import { assertNativeMediaPrepared, claimNativeMediaRecovery, failNativeMediaTask, isNativeMediaLeaseCurrent, listNativeMediaTasks,
  normalizeNativeMediaProviderBase, prepareNativeMediaTask, recordNativeMediaSubmission, type NativeMediaTaskRecord } from './indexedDb/nativeMediaTaskRepository';
import { retainNativeMediaOutputs } from './indexedDb/nativeMediaCollectionRepository';
import { nativeMediaLocalOutputs, MAX_NATIVE_MEDIA_OUTPUTS } from './nativeMediaCollection';
import { captureNativeMediaLocalResult } from './nativeMediaLocalResult';
import { persistMediaUrlToProjectData } from './fileService';
import { sha256BytesHex } from './mediaDataUrl';
import { projectModelSourceToken } from './projectModelComparisonMaterial';
import { pollTask, PollTaskFailedError, PollTimeoutError } from './pollTask';
import { VIDEO_POLL_MAX_DURATION_MS } from './pollManager';

export const NATIVE_GENERAL_ASYNC_KIND = 'general-async-v1';
type ResultField = 'videos' | 'audios' | 'images';
const categoryFor = (field: ResultField): MediaKind => field === 'videos' ? 'video' : field === 'audios' ? 'audio' : 'image';
const fieldFor = (category: MediaKind): ResultField => category === 'video' ? 'videos' : category === 'audio' ? 'audios' : 'images';
const digest = (modelId: string, field: ResultField) => sha256BytesHex(new TextEncoder().encode(projectModelSourceToken([NATIVE_GENERAL_ASYNC_KIND, modelId, field])));
const recordObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const validId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value);

/** 只选择一个明确的返回集合；每项／每项中的多个 URL 都保留，不按请求张数截断。 */
export function nativeGeneralTaskUrls(payload: unknown, field: ResultField): string[] {
  if (!recordObject(payload)) return [];
  const containers = [payload, ...(recordObject(payload.result) ? [payload.result] : []), ...(recordObject(payload.data) ? [payload.data] : [])];
  const values = (value: unknown): string[] => {
    if (typeof value === 'string' && value.trim()) return /^data:/i.test(value) ? [value] : splitCommaSeparatedUrls([value]);
    if (Array.isArray(value) && value.length) return value.flatMap((item) => {
      if (typeof item !== 'string' || !item.trim()) throw new Error('原任务返回了不完整的候选集合');
      return /^data:/i.test(item) ? [item] : splitCommaSeparatedUrls([item]);
    });
    throw new Error('原任务候选没有可保存的媒体地址');
  };
  const collection = (value: unknown): string[] | undefined => {
    if (!Array.isArray(value) || !value.length) return undefined;
    return value.flatMap((item) => recordObject(item)
      ? item.url !== undefined ? values(item.url) : field === 'images' && typeof item.b64_json === 'string' && item.b64_json
        ? [toImageDataUrl(item.b64_json)] : values(undefined)
      : values(item));
  };
  let urls: string[] | undefined;
  for (const container of containers) { urls = collection(container[field]); if (urls) break; }
  if (!urls && field !== 'images') for (const container of containers) { urls = collection(container.images); if (urls) break; }
  if (!urls?.length && Array.isArray(payload.data) && payload.data.length) urls = collection(payload.data);
  if (!urls?.length) for (const container of containers) if (typeof container.url === 'string') { urls = values(container.url); break; }
  if (!urls?.length) return [];
  if (urls.length > MAX_NATIVE_MEDIA_OUTPUTS) throw new Error('原任务候选超过安全上限，未截断交付');
  return urls;
}
export function nativeGeneralTaskIds(payload: unknown): string[] {
  if (!recordObject(payload)) return [];
  const ids: unknown[] = Array.isArray(payload.data) ? payload.data.flatMap((item) => recordObject(item) && item.task_id !== undefined ? [item.task_id] : []) : [];
  if (payload.task_id !== undefined) ids.push(payload.task_id);
  if (ids.some((id) => !validId(id)) || ids.length > 128) throw new Error('原任务 ID 格式或数量异常，不能安全续查');
  return [...new Set(ids as string[])];
}
function originalConnection(record: NativeMediaTaskRecord) {
  const selected = record.modelRef && resolveGeneralModelConnection(record.modelRef);
  if (!selected || selected.model.executionProfile || selected.model.modelId !== record.recovery?.modelId
    || selected.providerConfigId !== record.providerConfigId || selected.model.category !== record.category
    || normalizeNativeMediaProviderBase(selected.baseUrl) !== record.providerBase || !selected.apiKey) throw new Error('原通用连接或合同已变化，请恢复后续查，不会重新生成');
  return selected;
}
function contextFor(record?: NativeMediaTaskRecord): CanvasContext {
  const context = captureLegacyCanvasContext(useAppStore.getState());
  if (!context || context.modelGeneration !== 1 || record && (context.projectId !== record.ownerProjectId || context.canvasId !== record.canvasId
    || context.episodeId !== record.episodeId || context.projectEpoch !== record.projectEpoch || context.canvasEpoch !== record.canvasEpoch)) throw new Error('请返回原通用媒体任务画布');
  return context;
}
function receiptError(record: NativeMediaTaskRecord, delivered = false): Error {
  const error = new Error(delivered ? `原通用媒体已保存并交付（${record.operationId}）` : `原通用媒体操作 ${record.operationId} 已保留，请续查原任务，不要重新生成。`);
  error.name = delivered ? 'NativeMediaTaskDelivered' : 'NativeMediaTaskPending'; Object.assign(error, { nativeOperationId: record.operationId }); return error;
}
async function deliver(record: NativeMediaTaskRecord, signal?: AbortSignal): Promise<void> {
  const { resumeNativeVolcengineTask } = await import('./nativeVolcengineRecovery'); await resumeNativeVolcengineTask(record.operationId, signal);
}
async function retainUrls(record: NativeMediaTaskRecord, urls: readonly string[], baseUrl: string,
  options: { signal?: AbortSignal; assertCurrent?: () => void; inlineSubmission?: boolean; completion?: { taskCount: number; failedTasks: number } } = {}): Promise<NativeMediaTaskRecord> {
  const outputs: NativeMediaLocalOutput[] = [], access = createMediaDownloadAccess(record.providerConfigId, baseUrl, { type: 'bearer' });
  for (const [ordinal, url] of urls.entries()) {
    options.assertCurrent?.();
    const saved = await persistMediaUrlToProjectData(url, record.canvasId, `ai-${record.category}`, `原通用产物 ${ordinal + 1}`,
      { signal: options.signal, assertCurrent: options.assertCurrent, mediaDownloadAccess: access });
    if (!saved.filePath) throw new Error('原通用媒体产物尚未完整保存');
    outputs.push({ ...await captureNativeMediaLocalResult(record.canvasId, saved.filePath), category: record.category });
  }
  return retainNativeMediaOutputs(record, outputs, { inlineSubmission: options.inlineSubmission, signal: options.signal, completion: options.completion });
}
export async function executeNativeGeneralAsyncTask(input: { apiKey: string; baseUrl: string; modelName: string; prompt: string;
  resultField: ResultField; providerConfigId: string; nodeId?: string; signal?: AbortSignal; requestBody?: Record<string, unknown>;
  beforeSubmit?: () => void | Promise<void>; modelRef?: string }): Promise<never> {
  if (isCharacterImageTaskContext(input.beforeSubmit)) {
    if (input.resultField !== 'images') throw new Error('角色目的地只接受图片结果');
    const { queryCharacterImageTasks } = await import('./characterImageTaskRecovery');
    return executeCharacterImageTask(input.beforeSubmit, { recovery: { kind: 'general-async' },
      mediaDownloadAccess: { providerConfigId: input.providerConfigId, origin: new URL(input.baseUrl).origin, auth: { type: 'bearer' } },
      execute: async (beforePost, received) => {
        await beforePost();
        const response = await corsSafeFetch(`${input.baseUrl.replace(/\/+$/, '')}/images/generations`, {
          method: 'POST', headers: { Authorization: `Bearer ${input.apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(input.requestBody ?? { model: input.modelName, prompt: input.prompt, n: 1 }), signal: input.signal,
        });
        if (!response.ok) {
          let failure: unknown;
          try { failure = await response.json(); } catch { /* 固定 HTTP 分类，不保留正文。 */ }
          throw new HttpResponseError(response.status, `通用媒体提交失败（HTTP ${response.status}）`, classifyHttpResponseFailure(response.status, failure));
        }
        const payload: unknown = await response.json(), taskIds = nativeGeneralTaskIds(payload);
        for (const taskId of taskIds) await received(taskId);
        if (!taskIds.length) {
          const urls = nativeGeneralTaskUrls(payload, 'images');
          if (!urls.length) throwIfDefinitiveModelResponseFailure(payload, response.status, undefined, input.apiKey);
          return urls.map((url) => ({ url }));
        }
        return queryCharacterImageTasks({ kind: 'general-async', connectionId: input.providerConfigId, providerBase: input.baseUrl },
          taskIds.map((taskId) => ({ taskId })), '', input.signal, input.apiKey);
      } });
  }
  if (!input.nodeId || !input.modelRef || !isNativeVideoSubmissionGuard(input.beforeSubmit)) throw new Error('通用媒体缺少原画布受信提交入口');
  const context = contextFor(), category = categoryFor(input.resultField), selected = resolveGeneralModelConnection(input.modelRef);
  if (!selected || selected.model.executionProfile || selected.model.modelId !== input.modelName || selected.providerConfigId !== input.providerConfigId
    || selected.model.category !== category || normalizeNativeMediaProviderBase(selected.baseUrl) !== normalizeNativeMediaProviderBase(input.baseUrl)
    || selected.apiKey !== input.apiKey) throw new Error('原通用模型与实际提交连接不一致');
  const body = structuredClone(input.requestBody ?? { model: input.modelName, prompt: input.prompt, n: 1 });
  await input.beforeSubmit?.(); input.signal?.throwIfAborted();
  const preparation = await useAppStore.getState().beginNativeMediaSubmissionPreparation(context);
  try {
  input.signal?.throwIfAborted();
  const baseline = await captureNativeVideoSubmissionBaseline(context, input.nodeId, undefined, 'media-input-v3', { preparedReferences: true, preparation });
  const protocolDigest = await digest(input.modelName, input.resultField);
  let record = await prepareNativeMediaTask({ context, operationId: crypto.randomUUID(), nodeId: input.nodeId, category,
    providerConfigId: input.providerConfigId, providerBase: input.baseUrl, modelRef: input.modelRef, protocolDigest,
    recovery: { kind: 'general-protocol', serverId: NATIVE_GENERAL_ASYNC_KIND, modelId: input.modelName, digest: protocolDigest,
      expectedCount: Number.isSafeInteger(body.n) && Number(body.n) > 0 && Number(body.n) <= 128 ? Number(body.n) : 1 },
    fingerprintScheme: 'media-input-v3', requestFingerprint: await sha256BytesHex(new TextEncoder().encode(projectModelSourceToken(body))),
    sourceCanvasRevision: baseline.canvasRevision, inputFingerprint: baseline.inputFingerprint, submissionKind: 'async' });
  let sent = false, retained = false, acknowledged = false;
  try {
    await input.beforeSubmit?.(); await assertNativeVideoSubmissionInput(record, context); await assertNativeMediaPrepared(record, { preparation });
    if (originalConnection(record).apiKey !== input.apiKey) throw new Error('原通用媒体连接已变化');
    record = await recordNativeMediaSubmission(record.operationId, record.lease, { unknown: true });
    input.signal?.throwIfAborted(); preparation.assertCurrent(); sent = true; preparation.release();
    const resource = input.resultField === 'audios' ? 'audio' : input.resultField;
    const response = await corsSafeFetch(`${input.baseUrl.replace(/\/+$/, '')}/${resource}/generations`, {
      method: 'POST', headers: { Authorization: `Bearer ${input.apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: input.signal,
    });
    if (!response.ok) {
      let failure: unknown; try { failure = await response.json(); } catch { /* 只保存固定HTTP分类，不带回正文。 */ }
      throw new HttpResponseError(response.status, `通用媒体提交失败（HTTP ${response.status}）`, classifyHttpResponseFailure(response.status, failure));
    }
    const payload: unknown = await response.json(), taskIds = nativeGeneralTaskIds(payload);
    if (taskIds.length) {
      if (input.apiKey && taskIds.some((id) => id.includes(input.apiKey))) throw new Error('提交响应任务身份包含凭据，不能保存或重投');
      record = await recordNativeMediaSubmission(record.operationId, record.lease, { taskId: taskIds[0], pollContext: { taskIds } }); acknowledged = true;
      await resumeNativeGeneralAsyncTask(record.operationId, input.signal);
    } else {
      const urls = nativeGeneralTaskUrls(payload, input.resultField);
      if (!urls.length) { throwIfDefinitiveModelResponseFailure(payload, response.status, undefined, input.apiKey); throw new Error('原通用响应没有任务或完整产物'); }
      // 无远端ID的已返回产物先保留原根，切集／取消只暂停后续视图投递。
      record = await retainUrls(record, urls, input.baseUrl, { inlineSubmission: true }); retained = true;
      input.signal?.throwIfAborted();
      if (!isProjectExpectedContextCurrent(context, useAppStore.getState(), { checkCanvasRevision: false })) throw receiptError(record);
      await deliver(record, input.signal);
    }
    throw receiptError(record, true);
  } catch (error) {
    if (error instanceof Error && error.name === 'NativeMediaTaskDelivered') throw error;
    if (!retained && !acknowledged) {
      record = await recordNativeMediaSubmission(record.operationId, record.lease,
        !sent || getHttpResponseError(error)?.definitiveFailure ? { notStarted: true } : { unknown: true }).catch(() => record);
    }
    const latest = (await listNativeMediaTasks(record.ownerProjectId)).find((row) => row.operationId === record.operationId);
    if (latest?.status === 'delivered') throw receiptError(latest, true);
    if (latest?.status === 'failed') throw new Error('原通用媒体任务已确认失败，回执保留', { cause: error });
    throw receiptError(record);
  }
  } finally { preparation.release(); }
}
export async function resumeNativeGeneralAsyncTask(operationId: string, signal?: AbortSignal): Promise<void> {
  const context = contextFor();
  let record = (await listNativeMediaTasks(context.projectId)).find((row) => row.operationId === operationId);
  if (!record || record.recovery?.kind !== 'general-protocol' || record.recovery.serverId !== NATIVE_GENERAL_ASYNC_KIND) throw new Error('没有此原通用异步操作');
  contextFor(record);
  if (record.status === 'delivered' || nativeMediaLocalOutputs(record).length) return deliver(record, signal);
  const field = fieldFor(record.category), selected = originalConnection(record);
  if (record.recovery.digest !== record.protocolDigest || record.protocolDigest !== await digest(selected.model.modelId, field)) throw new Error('原通用任务合同摘要已变化');
  const taskIds = record.pollContext?.taskIds;
  if (!Array.isArray(taskIds) || !taskIds.length || taskIds.length > 128 || taskIds[0] !== record.remoteTaskId || taskIds.some((id) => !validId(id))) throw new Error('原通用任务集合未知，不能重新提交');
  record = await claimNativeMediaRecovery(operationId, context);
  const controller = new AbortController(), abort = () => controller.abort(); signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) controller.abort();
  const unsubscribe = useAppStore.subscribe(() => { if (!isProjectExpectedContextCurrent(context, useAppStore.getState(), { checkCanvasRevision: false })) controller.abort(); });
  const current = () => { controller.signal.throwIfAborted(); if (!isProjectExpectedContextCurrent(context, useAppStore.getState(), { checkCanvasRevision: false })) throw new Error('原通用任务画布已切换'); };
  try {
    const urls: string[] = []; let failedTasks = 0;
    for (const taskId of taskIds as string[]) {
      current();
      let values: string[];
      try { values = await pollTask<Record<string, unknown>, string[]>({
        fetchState: async (querySignal) => {
          const response = await corsSafeFetch(`${selected.baseUrl.replace(/\/+$/, '')}/tasks/${encodeURIComponent(taskId)}?language=zh`, {
            headers: { Authorization: `Bearer ${selected.apiKey}` }, signal: querySignal,
          });
          if ([408, 504].includes(response.status)) throw new PollTimeoutError();
          if (!response.ok) throw new Error(`原通用查询失败（HTTP ${response.status}）`);
          return await response.json() as Record<string, unknown>;
        },
        isComplete: (raw) => { const task = recordObject(raw.data) ? raw.data : raw;
          if (task.status !== 'completed') return null;
          const values = nativeGeneralTaskUrls(recordObject(task.result) ? task.result : raw, field);
          if (!values.length) throw new Error('原通用任务完成但没有完整产物'); return values; },
        isFailed: (raw) => { const task = recordObject(raw.data) ? raw.data : raw;
          return ['failed', 'error', 'cancelled'].includes(String(task.status)) ? '服务商已确认原通用任务失败' : null; },
        interval: 3000, maxDuration: VIDEO_POLL_MAX_DURATION_MS, signal: controller.signal, onFetchError: 'throw',
      }); } catch (error) { if (error instanceof PollTaskFailedError) { failedTasks++; continue; } throw error; }
      urls.push(...values); if (urls.length > MAX_NATIVE_MEDIA_OUTPUTS) throw new Error('原任务完整候选超过上限，未截断交付');
    }
    current(); if (!await isNativeMediaLeaseCurrent(record)) throw new Error('原通用任务已由另一窗口续查');
    if (!urls.length && failedTasks === taskIds.length) { await failNativeMediaTask(record); throw new Error('原通用任务均已确认失败，完整原ID回执保留'); }
    record = await retainUrls(record, urls, selected.baseUrl, { signal: controller.signal, assertCurrent: current, completion: { taskCount: taskIds.length, failedTasks } });
    current(); await deliver(record, controller.signal);
  } catch (error) {
    if (error instanceof PollTaskFailedError && taskIds.length === 1) await failNativeMediaTask(record).catch(() => undefined);
    throw error;
  } finally { unsubscribe(); signal?.removeEventListener('abort', abort); controller.abort(); }
}

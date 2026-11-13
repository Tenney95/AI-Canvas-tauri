/** 角色任务续查：复用各通道原查询合同，不包含生成重提交入口。 */
import type { CharacterImageTaskRecovery } from '../types/media';
import { DEFAULT_BASE_URLS } from '../constants/api';
import type { MediaDownloadAccess, NormalizedModelExecutionProtocol } from '../types/aiTypes';
import type { ModelProtocolVariables } from './ai/modelProtocolTypes';
import { useAppStore } from '../store/useAppStore';
import { executeCharacterImageTask, validateCharacterImageTaskRecovery, type CharacterImageExecutionOutputs } from './characterImageTaskContext';
import { pollTask, PollTaskFailedError } from './pollTask';
import { fetchApimartTask } from './ai/apimartGen';
import { pollResolvedModelProtocol, resolvePoll } from './ai/modelProtocolPoll';
import { captureNativeProtocolContext, nativeProtocolQueryPaths, nativeProtocolQueryDigest, resolveNativeProtocolContext } from './nativeModelProtocolTask';
import { submitModelProtocol } from './ai/modelProtocol';
import { getProviderDefinition } from './ai/providerCatalogService';
import { normalizeNativeMediaProviderBase } from './indexedDb/nativeMediaTaskRepository';
import { projectModelSourceToken } from './projectModelComparisonMaterial';
import { sha256BytesHex } from './mediaDataUrl';

export async function characterImageConfigurationDigest(modelRef: string, connectionId: string, workflowId?: string): Promise<string> {
  const state = useAppStore.getState();
  const provider = state.config.providers[connectionId];
  const { apiKey: _apiKey, ...connection } = provider ?? {};
  const model = state.config.generalModels?.find((item) => `general/${item.id}` === modelRef);
  const workflow = workflowId ? state.workflows.find((item) => item.id === workflowId) : undefined;
  return sha256BytesHex(new TextEncoder().encode(projectModelSourceToken([modelRef, connectionId, connection, model, workflow])));
}

type Query = Pick<CharacterImageTaskRecovery, 'kind' | 'connectionId' | 'providerBase' | 'builtinMode' | 'workflow' | 'query'> & { modelRef?: string };
type Task = CharacterImageTaskRecovery['tasks'][number];
export async function queryCharacterImageOriginal(query: Query, task: Task, operationId: string,
  signal?: AbortSignal, originalApiKey?: string): Promise<Array<{ url: string; kind?: string }>> {
  signal?.throwIfAborted();
  if (query.kind === 'workflow' && query.workflow) {
    const { assertWorkflowContract, queryNativeWorkflowOriginal } = await import('./nativeWorkflowTasks');
    await assertWorkflowContract(query.workflow);
    return queryNativeWorkflowOriginal(query.workflow, task, operationId, signal ?? new AbortController().signal);
  }
  if (query.kind === 'builtin' && query.builtinMode === 'dreamina') {
    if (query.connectionId !== 'dreamina' || query.providerBase !== 'http://dreamina.local') throw new Error('原即梦任务连接身份无效');
    const { invoke, convertFileSrc } = await import('@tauri-apps/api/core');
    const urls = await pollTask<{ status: string; outputs: Array<{ url: string; localPath: string }> }, string[]>({
      fetchState: () => invoke('dreamina_query_result', { submitId: task.taskId }),
      isComplete: (value) => value.status === 'success' && value.outputs.length
        ? value.outputs.map((file) => file.localPath ? convertFileSrc(file.localPath) : file.url) : null,
      isFailed: (value) => value.status === 'failed' ? '即梦已确认原任务失败' : null,
      interval: 3000, maxDuration: 60 * 60 * 1000, signal, onFetchError: 'throw',
    });
    return urls.map((url) => ({ url }));
  }
  const provider = useAppStore.getState().config.providers[query.connectionId];
  const baseUrl = provider?.baseUrl?.trim() || getProviderDefinition(query.connectionId, provider)?.defaultBaseUrl || DEFAULT_BASE_URLS[query.connectionId] || '';
  if (!provider || normalizeNativeMediaProviderBase(baseUrl) !== normalizeNativeMediaProviderBase(query.providerBase)) {
    throw new Error('原图片连接已变化，请恢复原连接后继续查询');
  }
  const apiKey = originalApiKey ?? provider.apiKey;
  if (!apiKey) throw new Error('原图片连接缺少凭据');
  if (query.kind === 'protocol' && query.query) {
    const { characterImageRecoveryProtocols } = await import('./ai/generateImage');
    const candidates = characterImageRecoveryProtocols(query.query.modelId, query.connectionId, query.modelRef);
    let protocol: NormalizedModelExecutionProtocol | undefined;
    for (const candidate of candidates) if (await nativeProtocolQueryDigest(query.query.modelId, candidate) === query.query.digest) {
      protocol = candidate; break;
    }
    if (!protocol?.poll) throw new Error('原图片查询合同已变化，未发送原任务 ID');
    const context = resolveNativeProtocolContext(protocol, task.taskId, task.recoveryContext);
    const result = await pollResolvedModelProtocol(resolvePoll(baseUrl, protocol.poll, protocol.auth, context), apiKey, signal, baseUrl);
    if (!result.urls?.length) throw new Error('原图片任务没有返回可保存的结果');
    return result.urls.map((url) => ({ url }));
  }
  if (query.kind === 'builtin' && query.builtinMode === 'ccc') {
    if (getProviderDefinition(query.connectionId, provider)?.id !== 'cccapi') throw new Error('原 CCC 图片连接身份无效');
    const result = await pollResolvedModelProtocol({ method: 'GET', url: `${query.providerBase}/tasks/${encodeURIComponent(task.taskId)}`,
      auth: { type: 'bearer' }, statusPath: 'data.status', successValues: ['completed'], failureValues: ['failed'],
      resultUrlPath: 'data.result.images.*.url', intervalMs: 3000, maxDurationMs: 60 * 60 * 1000 }, apiKey, signal, baseUrl);
    if (!result.urls?.length) throw new Error('原 CCC 图片任务没有返回可保存的结果');
    return result.urls.map((url) => ({ url }));
  }
  if (query.kind === 'apimart' || query.kind === 'general-async') {
    if (query.kind === 'apimart' && query.connectionId !== 'apimart') throw new Error('原 APIMart 连接身份无效');
    const { nativeGeneralTaskUrls } = await import('./nativeGeneralAsyncTask');
    const urls = await pollTask<Awaited<ReturnType<typeof fetchApimartTask>>, string[]>({
      fetchState: () => fetchApimartTask(apiKey, query.providerBase, encodeURIComponent(task.taskId), signal, true),
      isComplete: (value) => {
        if (!['completed', 'succeeded', 'success'].includes((value.status ?? '').toLowerCase())) return null;
        const results = nativeGeneralTaskUrls(value, 'images');
        return results.length ? results : null;
      },
      isFailed: (value) => ['failed', 'error', 'cancelled', 'canceled'].includes((value.status ?? '').toLowerCase()) ? '原图片任务已确认失败' : null,
      interval: 3000, maxDuration: 60 * 60 * 1000, signal, onFetchError: 'throw',
    });
    if (!urls.length) throw new Error('原图片任务没有返回可保存的结果');
    return urls.map((url) => ({ url }));
  }
  throw new Error('原同步图片请求没有可续查的远端任务，不会重新生成');
}

export async function recoverCharacterImageTask(recovery: CharacterImageTaskRecovery, operationId: string, signal?: AbortSignal) {
  const secrets = Object.values(useAppStore.getState().config.providers).flatMap((provider) => provider?.apiKey ? [provider.apiKey] : []);
  validateCharacterImageTaskRecovery(recovery, secrets);
  if (!recovery.tasks.length) throw new Error('原图片请求没有已保存的任务 ID，请核对服务商原任务');
  return queryCharacterImageTasks(recovery, recovery.tasks, operationId, signal);
}

/** 单个子任务的明确失败不丢弃其他原作业；查询中断仍先返回可耐久保存的部分。 */
export async function queryCharacterImageTasks(query: Query, tasks: readonly Task[], operationId: string,
  signal?: AbortSignal, apiKey?: string): Promise<CharacterImageExecutionOutputs> {
  const outputs: CharacterImageExecutionOutputs = [];
  let failure: unknown;
  let pendingFailure: unknown;
  for (const task of tasks) {
    try { outputs.push(...await queryCharacterImageOriginal(query, task, operationId, signal, apiKey)); }
    catch (error) {
      if (!(error instanceof PollTaskFailedError)) {
        outputs.incomplete = true;
        pendingFailure ??= error;
      }
      failure = error;
      if (signal?.aborted) break;
    }
  }
  if (!outputs.length) throw pendingFailure ?? failure ?? new Error('原图片任务没有可保存的结果');
  return outputs;
}

export async function executeCharacterBuiltinImage(guard: unknown,
  input: Parameters<typeof import('./nativeBuiltinImageTask').runNativeBuiltinImageTask>[0]): Promise<never> {
  if (input.category && input.category !== 'image') throw new Error('角色目的地只接受图片结果');
  return executeCharacterImageTask(guard, { expectedCount: input.expectedCount,
    recovery: { kind: 'builtin', builtinMode: input.mode }, mediaDownloadAccess: input.mediaDownloadAccess,
    execute: async (beforePost, received) => {
      const acknowledged = new Set<string>();
      const retain = async (ids: string[]) => { for (const taskId of ids) { await received(taskId); acknowledged.add(taskId); } };
      const result = await input.execute(beforePost, retain);
      if (result.taskIds) await retain(result.taskIds.filter((id) => !acknowledged.has(id)));
      if (result.urls?.length) return result.urls.map((url) => ({ url }));
      return queryCharacterImageTasks({ kind: 'builtin', builtinMode: input.mode,
        connectionId: input.connectionId, providerBase: input.baseUrl }, [...acknowledged].map((taskId) => ({ taskId })), '', input.signal);
    } });
}

export async function executeCharacterWorkflow(guard: unknown,
  input: Parameters<typeof import('./nativeWorkflowTasks').submitNativeWorkflowTask>[0]): Promise<never> {
  const { assertWorkflowContract } = await import('./nativeWorkflowTasks');
  const descriptor = { ...input.descriptor, providerBase: normalizeNativeMediaProviderBase(input.descriptor.providerBase) };
  await assertWorkflowContract(descriptor);
  if (descriptor.category !== 'image' || (input.count ?? 1) !== 1) throw new Error('角色工作台每次提交一个图片作业');
  return executeCharacterImageTask(guard, { recovery: { kind: 'workflow', workflow: descriptor },
    isDefinitiveFailure: input.isDefinitiveFailure,
    mediaDownloadAccess: input.mediaDownloadAccess,
    execute: async (beforePost, received, operationId) => {
      await beforePost();
      const retained = new Map<string, Record<string, unknown> | undefined>();
      const retain = async (taskId: string, context?: Record<string, unknown>) => { await received(taskId, context); retained.set(taskId, context); };
      const result = await input.submit(0, input.signal, retain);
      if (result.taskId && !retained.has(result.taskId)) await retain(result.taskId, result.recoveryContext);
      if (result.outputs?.length) return result.outputs;
      return queryCharacterImageTasks({ kind: 'workflow', workflow: descriptor,
        connectionId: descriptor.connectionId, providerBase: descriptor.providerBase },
      [...retained].map(([taskId, recoveryContext]) => ({ taskId, recoveryContext })), operationId, input.signal);
    } });
}

export async function executeCharacterProtocol(guard: unknown, input: {
  apiKey: string; baseUrl: string; protocol: NormalizedModelExecutionProtocol; variables: ModelProtocolVariables;
  expectedCount?: number; mediaDownloadAccess?: MediaDownloadAccess; signal?: AbortSignal;
}): Promise<never> {
  const modelId = String(input.variables.model ?? '');
  const query = input.protocol.mode === 'async' && input.protocol.poll && input.protocol.response.taskIdPath
    ? { modelId, digest: await nativeProtocolQueryDigest(modelId, input.protocol) } : undefined;
  if (query) nativeProtocolQueryPaths(input.protocol);
  return executeCharacterImageTask(guard, { expectedCount: input.expectedCount,
    recovery: { kind: query ? 'protocol' : 'builtin', ...(query ? { query } : { builtinMode: 'protocol' }) },
    mediaDownloadAccess: input.mediaDownloadAccess,
    execute: async (beforeSubmit, received) => {
      const submitted = await submitModelProtocol({ ...input, beforeSubmit, sensitive: true,
        ...(query ? { captureRecoveryContext: (payload: unknown) => captureNativeProtocolContext(input.protocol, payload, input.variables, [input.apiKey]) } : {}) });
      if (submitted.urls?.length) return submitted.urls.map((url) => ({ url }));
      if (!submitted.taskId || !submitted.poll) throw new Error('原图片协议没有返回任务身份或完整产物');
      await received(submitted.taskId, submitted.recoveryContext);
      const result = await pollResolvedModelProtocol(submitted.poll, input.apiKey, input.signal, input.baseUrl);
      return (result.urls ?? []).map((url) => ({ url }));
    } });
}

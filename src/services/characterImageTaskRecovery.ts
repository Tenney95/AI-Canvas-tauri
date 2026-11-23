/** 角色任务续查：复用各通道原查询合同，不包含生成重提交入口。 */
import type { CharacterImageTaskRecovery } from '../types/media';
import { DEFAULT_BASE_URLS } from '../constants/api';
import type { ImageOutputCountRange, MediaDownloadAccess, NormalizedModelExecutionProtocol } from '../types/aiTypes';
import type { ModelProtocolVariables } from './ai/modelProtocolTypes';
import { useAppStore } from '../store/useAppStore';
import { executeCharacterImageTask, validateCharacterImageTaskRecovery, type CharacterImageExecutionOutputs } from './characterImageTaskContext';
import { assertImageOutputCount } from './ai/modelCapabilityValidation';
import { captureNativeQueryContractId, nativeQueryCredentialProof, resolveNativeQueryContract } from './nativeProtocolRecovery';
import { PollTaskFailedError } from './pollTask';
import { queryDreaminaResult } from './dreaminaResult';
import { queryApimartImageResult } from './ai/apimartImageResult';
import { queryCompatibleImageTask } from './ai/asyncMediaResult';
import { createCccImageResultPoll, queryCccImageResult } from './ai/cccImageResult';
import { pollResolvedModelProtocol, resolvePoll } from './ai/modelProtocolPoll';
import { captureNativeProtocolContext, nativeProtocolQueryPaths, nativeProtocolQueryDigest, resolveNativeProtocolContext } from './nativeModelProtocolTask';
import { submitModelProtocol } from './ai/modelProtocol';
import { getProviderDefinition, usesKlingImageProtocol } from './ai/providerCatalogService';
import { assertKlingImageResponse } from './ai/providers/klingImageResponse';
import { normalizeNativeMediaProviderBase } from './indexedDb/nativeMediaTaskRepository';
import { projectModelSourceToken } from './projectModelComparisonMaterial';
import { sha256BytesHex } from './mediaDataUrl';
import { getProviderPolicy, resolveProviderCatalogId } from './ai/providerPolicies';
import { redactVolcengineError } from './ai/providers/volcengineError';

export async function characterImageConfigurationDigest(modelRef: string, connectionId: string, workflowId?: string): Promise<string> {
  const state = useAppStore.getState();
  const provider = state.config.providers[connectionId];
  const { apiKey: _apiKey, ...connection } = provider ?? {};
  const model = state.config.generalModels?.find((item) => `general/${item.id}` === modelRef);
  const workflow = workflowId ? state.workflows.find((item) => item.id === workflowId) : undefined;
  return sha256BytesHex(new TextEncoder().encode(projectModelSourceToken([modelRef, connectionId, connection, model, workflow])));
}

type Query = Pick<CharacterImageTaskRecovery, 'kind' | 'connectionId' | 'providerBase' | 'builtinMode' | 'workflow' | 'query' | 'imageOutputCountRange'> & { modelRef?: string };
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
    const urls = await queryDreaminaResult(task.taskId, {
      signal,
      failureMessage: '即梦已确认原任务失败',
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
    if (query.query.credentialProof && query.query.credentialProof !== await nativeQueryCredentialProof(operationId, query.connectionId, apiKey)) {
      throw new Error('原账户的 API Key 已变化，请恢复原凭据后继续查询');
    }
    const { characterImageRecoveryProtocols } = await import('./ai/generateImage');
    let protocol = await resolveNativeQueryContract(query.query.serverId, resolveProviderCatalogId(query.connectionId, provider),
      'image', query.query.modelId, query.query.digest);
    const candidates = query.query.serverId ? [] : characterImageRecoveryProtocols(query.query.modelId, query.connectionId, query.modelRef);
    for (const candidate of candidates) if (await nativeProtocolQueryDigest(query.query.modelId, candidate) === query.query.digest) {
      protocol = candidate; break;
    }
    if (!protocol?.poll) throw new Error('原图片查询合同已变化，未发送原任务 ID');
    const context = resolveNativeProtocolContext(protocol, task.taskId, task.recoveryContext);
    const sensitive = getProviderPolicy(resolveProviderCatalogId(query.connectionId, provider)).upload === 'volcengine-tos';
    const poll = resolvePoll(baseUrl, protocol.poll, protocol.auth, context);
    const controller = new AbortController();
    const querySignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const assertConnection = () => {
      const current = useAppStore.getState().config.providers[query.connectionId];
      if (current?.apiKey !== provider.apiKey || current.baseUrl !== provider.baseUrl || current.catalogId !== provider.catalogId) {
        controller.abort(new Error('原图片连接已变化，请恢复原连接后继续查询'));
      }
    };
    const unsubscribe = useAppStore.subscribe(assertConnection);
    try {
      assertConnection();
      querySignal.throwIfAborted();
      const result = await pollResolvedModelProtocol(poll, apiKey, querySignal, baseUrl, undefined, sensitive, task.taskId);
      querySignal.throwIfAborted();
      if (!result.urls?.length) throw new Error('原图片任务没有返回可保存的结果');
      assertImageOutputCount(query.imageOutputCountRange, result.urls.length);
      return result.urls.map((url) => ({ url }));
    } finally {
      unsubscribe();
    }
  }
  if (query.kind === 'builtin' && query.builtinMode === 'ccc') {
    if (getProviderDefinition(query.connectionId, provider)?.id !== 'cccapi') throw new Error('原 CCC 图片连接身份无效');
    const poll = createCccImageResultPoll(query.providerBase, task.taskId, { maxDurationMs: 60 * 60 * 1000 });
    const urls = await queryCccImageResult(poll, apiKey, signal, baseUrl);
    if (!urls.length) throw new Error('原 CCC 图片任务没有返回可保存的结果');
    return urls.map((url) => ({ url }));
  }
  if (query.kind === 'apimart') {
    if (query.connectionId !== 'apimart') throw new Error('原 APIMart 连接身份无效');
    const urls = await queryApimartImageResult(apiKey, query.providerBase, task.taskId, {
      signal, interval: 3000, maxDuration: 60 * 60 * 1000, onFetchError: 'throw',
    });
    return urls.map((url) => ({ url }));
  }
  if (query.kind === 'general-async') {
    const urls = await queryCompatibleImageTask(apiKey, query.providerBase, task.taskId, {
      signal, maxDuration: 60 * 60 * 1000,
    });
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
  expectedCount?: number; imageOutputCountRange?: ImageOutputCountRange; mediaDownloadAccess?: MediaDownloadAccess; signal?: AbortSignal;
}): Promise<never> {
  const connectionId = input.mediaDownloadAccess?.providerConfigId;
  const policy = connectionId ? getProviderPolicy(resolveProviderCatalogId(connectionId,
    useAppStore.getState().config.providers[connectionId])) : undefined;
  const sensitive = policy?.upload === 'volcengine-tos';
  const idempotencyKey = policy?.submitIdempotency ? crypto.randomUUID() : undefined;
  const modelId = String(input.variables.model ?? '');
  const usesKlingProtocol = connectionId && resolveProviderCatalogId(connectionId,
    useAppStore.getState().config.providers[connectionId]) === 'kling'
    && usesKlingImageProtocol(modelId, { preset: 'custom', protocol: input.protocol });
  const query = input.protocol.mode === 'async' && input.protocol.poll && input.protocol.response.taskIdPath
    ? { modelId, digest: await nativeProtocolQueryDigest(modelId, input.protocol) } : undefined;
  const catalogId = connectionId ? resolveProviderCatalogId(connectionId, useAppStore.getState().config.providers[connectionId]) : undefined;
  const serverId = query && catalogId ? await captureNativeQueryContractId(catalogId, 'image', modelId, query.digest) : undefined;
  if (query) nativeProtocolQueryPaths(input.protocol);
  return executeCharacterImageTask(guard, { expectedCount: input.expectedCount,
    recovery: { kind: query ? 'protocol' : 'builtin', providerBase: input.baseUrl, ...(query ? { query: { ...query, ...(serverId ? { serverId } : {}) } } : { builtinMode: 'protocol' }),
      ...(input.imageOutputCountRange ? { imageOutputCountRange: input.imageOutputCountRange } : {}) },
    mediaDownloadAccess: input.mediaDownloadAccess,
    execute: async (beforeSubmit, received) => {
      const submitted = await submitModelProtocol({ ...input, beforeSubmit: async () => {
        if (connectionId && useAppStore.getState().config.providers[connectionId]?.apiKey !== input.apiKey) {
          throw new Error('图片连接凭据已变化，请重新确认生成');
        }
        await beforeSubmit();
        input.signal?.throwIfAborted();
        if (connectionId && useAppStore.getState().config.providers[connectionId]?.apiKey !== input.apiKey) {
          throw new Error('图片连接凭据已变化，请重新确认生成');
        }
      }, sensitive: true,
        ...(usesKlingProtocol ? { validateResponse: assertKlingImageResponse } : {}),
        ...(idempotencyKey ? { idempotencyKey } : {}),
        ...(query ? { captureRecoveryContext: (payload: unknown) => captureNativeProtocolContext(input.protocol, payload, input.variables, [input.apiKey]) } : {}) })
        .catch((error: unknown) => { throw sensitive ? redactVolcengineError(error, input.apiKey) : error; });
      if (submitted.urls?.length) {
        assertImageOutputCount(input.imageOutputCountRange, submitted.urls.length);
        return submitted.urls.map((url) => ({ url }));
      }
      if (!submitted.taskId || !submitted.poll) throw new Error('原图片协议没有返回任务身份或完整产物');
      await received(submitted.taskId, submitted.recoveryContext);
      const result = await pollResolvedModelProtocol(submitted.poll, input.apiKey, input.signal, input.baseUrl, undefined, sensitive, submitted.taskId);
      assertImageOutputCount(input.imageOutputCountRange, result.urls?.length ?? 0);
      return (result.urls ?? []).map((url) => ({ url }));
    } });
}

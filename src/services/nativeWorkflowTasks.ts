/** 新项目工作流始终续取原任务；适配器提供真实提交，回执、查询与完整产物交付由此统一。 */
import { useAppStore } from '../store/useAppStore';
import type { MediaKind, NativeMediaLocalOutput, NativeMediaSubmissionPreparation } from '../types/media';
import type { CloudWorkflowOutput } from '../types/workflowApi';
import type { NativeMediaTaskRecord } from './indexedDb/nativeMediaTaskRepository';
import { prepareNativeMediaTask, claimNativeMediaRecovery, listNativeMediaTasks, normalizeNativeMediaProviderBase, recordNativeMediaSubmission } from './indexedDb/nativeMediaTaskRepository';
import { captureLegacyCanvasContext, isProjectExpectedContextCurrent } from './projectExecutionContext';
import { captureNativeVideoSubmissionBaseline, assertNativeVideoSubmissionInput, isNativeVideoSubmissionGuard } from './nativeVideoSubmission';
import { nativeWorkflowDigest } from './nativeWorkflowExecution';
import { createNativeWorkflowReceipt, beginNativeWorkflowSubmission, retainNativeWorkflowSubmission, sealNativeWorkflowSubmissions,
  readNativeWorkflowReceipt, retainNativeWorkflowTaskOutputs, retainNativeWorkflowSyncOutputs,
  nativeWorkflowSummary,
  type NativeWorkflowDescriptor, type NativeWorkflowReceipt, type NativeWorkflowTask } from './nativeWorkflowRepository';
import { retainNativeMediaOutputs } from './indexedDb/nativeMediaCollectionRepository';
import { nativeMediaLocalOutputs } from './nativeMediaCollection';
import { captureNativeMediaLocalResult, readNativeMediaLocalResult } from './nativeMediaLocalResult';
import { persistMediaUrlToProjectData } from './fileService';
import { PollTaskFailedError } from './pollTask';
import { getHttpResponseError } from './ai/httpUtils';
import { createMediaDownloadAccess } from './ai/mediaDownloadAccess';
import { isSafeNativeProtocolTaskId, validateNativeProtocolContext } from './nativeProtocolContext';
import { findComfyOutputFiles, buildComfyFileUrl, type ComfyOutputs } from './comfyOutputs';
import type { MediaDownloadAccess } from '../types/aiTypes';

export { listNativeWorkflowRetainedOutputs } from './nativeWorkflowRepository';
export { nativeWorkflowDigest, isNativeWorkflowExecution } from './nativeWorkflowExecution';
export const isNativeWorkflowTask = (record: NativeMediaTaskRecord) => record.recovery?.kind === 'workflow';
function pending(record: NativeMediaTaskRecord): Error {
  const { operationId, localResults, remoteTaskId, status } = record;
  const error = new Error(`工作流原操作 ${operationId} 已保留，请在原画布继续查询；提交未知不会重新生成。`);
  error.name = 'NativeMediaTaskPending';
  return Object.assign(error, { nativeOperationId: operationId, localResultAvailable: !!localResults?.length,
    remoteTaskKnown: status === 'submitted' && !!remoteTaskId });
}
function delivered(operationId: string): never {
  const error = new Error('原工作流全部已确认产物已保存并交付'); error.name = 'NativeMediaTaskDelivered';
  Object.assign(error, { nativeOperationId: operationId }); throw error;
}
async function currentRecord(projectId: string, operationId: string): Promise<NativeMediaTaskRecord> {
  const record = (await listNativeMediaTasks(projectId)).find((item) => item.operationId === operationId);
  if (!record) throw new Error('原工作流回执不存在，未重新生成'); return record;
}
async function saveOutputs(record: NativeMediaTaskRecord, outputs: readonly CloudWorkflowOutput[], signal?: AbortSignal,
  assertCurrent?: () => void, mediaDownloadAccess?: MediaDownloadAccess): Promise<NativeMediaLocalOutput[]> {
  if (!outputs.length || outputs.length > 128) throw new Error('原工作流产物集合为空或超过上限，未截断交付');
  const files: NativeMediaLocalOutput[] = [];
  // 同步返回的字节须先归入原根；其余查询可取消并按原taskID重查，不向另一集投递。
  for (const output of outputs) {
    signal?.throwIfAborted(); assertCurrent?.();
    const saved = await persistMediaUrlToProjectData(output.url, record.canvasId, `ai-${output.kind}`, '原工作流产物', { signal, assertCurrent, mediaDownloadAccess });
    if (!saved.filePath) throw new Error('原工作流产物尚未完整保存，可继续查询原任务');
    files.push({ ...await captureNativeMediaLocalResult(record.canvasId, saved.filePath), category: output.kind });
  }
  const first = files.findIndex((file) => file.category === record.category);
  if (first < 0) throw new Error('原工作流没有请求类型的产物');
  return first === 0 ? files : [files[first], ...files.filter((_, index) => index !== first)];
}

export async function submitNativeWorkflowTask(input: {
  nodeId?: string; descriptor: NativeWorkflowDescriptor; requestMaterial: unknown; count?: number; synchronous?: boolean;
  signal?: AbortSignal; beforeSubmit?: () => void | Promise<void>;
  mediaDownloadAccess?: MediaDownloadAccess;
  /** 只在当前调用内过滤服务商错误回显；不进入回执或请求摘要。 */
  secretValues?: readonly string[];
  submit: (index: number, signal: AbortSignal | undefined, received: (taskId: string, recoveryContext?: Record<string, unknown>) => Promise<void>) => Promise<{
    taskId?: string; outputs?: CloudWorkflowOutput[]; recoveryContext?: Record<string, unknown> }>;
  isDefinitiveFailure?: (error: unknown) => boolean;
}): Promise<never> {
  const context = captureLegacyCanvasContext(useAppStore.getState());
  if (!context || context.modelGeneration !== 1 || !input.nodeId || !isNativeVideoSubmissionGuard(input.beforeSubmit)) throw new Error('工作流缺少原生画布提交守卫，未提交生成');
  const descriptor = structuredClone(input.descriptor), count = input.count ?? 1;
  descriptor.providerBase = normalizeNativeMediaProviderBase(descriptor.providerBase);
  await assertWorkflowContract(descriptor);
  await input.beforeSubmit?.(); input.signal?.throwIfAborted();
  let preparation: NativeMediaSubmissionPreparation | undefined = await useAppStore.getState().beginNativeMediaSubmissionPreparation(context);
  try {
  const baseline = await captureNativeVideoSubmissionBaseline(context, input.nodeId, undefined, 'media-input-v3', { preparedReferences: true, preparation });
  let record = await prepareNativeMediaTask({ context, operationId: crypto.randomUUID(), nodeId: input.nodeId,
    providerConfigId: descriptor.connectionId, providerBase: descriptor.providerBase, category: descriptor.category,
    submissionKind: input.synchronous ? 'sync' : 'async', fingerprintScheme: 'media-input-v3', modelRef: `workflow/${descriptor.workflowId ?? descriptor.modelId ?? descriptor.adapter}`,
    protocolDigest: descriptor.digest, requestFingerprint: await nativeWorkflowDigest(input.requestMaterial), inputFingerprint: baseline.inputFingerprint,
    sourceCanvasRevision: baseline.canvasRevision, recovery: { kind: 'workflow', workflowId: descriptor.workflowId,
      modelId: descriptor.modelId, serverId: descriptor.serverId, digest: descriptor.digest, expectedCount: count } });
  let receipt: NativeWorkflowReceipt;
  try { receipt = await createNativeWorkflowReceipt(record, descriptor, count); }
  catch (error) {
    await recordNativeMediaSubmission(record.operationId, record.lease, { notStarted: true }).catch(() => undefined);
    throw error;
  }
  const submissionLease = record.lease;
  let firstError: unknown;
  for (const [index, slot] of receipt.submissions.entries()) {
    let sent = false;
    try {
      // 每个真实 POST 独占短准备窗口；前一请求的网络等待期间自动保存可以继续。
      preparation ??= await useAppStore.getState().beginNativeMediaSubmissionPreparation(context);
      preparation.assertCurrent();
      input.signal?.throwIfAborted(); await input.beforeSubmit?.(); await assertNativeVideoSubmissionInput(record, context); await assertWorkflowContract(descriptor);
      ({ record, receipt } = await beginNativeWorkflowSubmission(record, slot.id, { preparation }));
      input.signal?.throwIfAborted(); await input.beforeSubmit?.(); await assertNativeVideoSubmissionInput(record, context); await assertWorkflowContract(descriptor);
      const received = async (taskId: string, recoveryContext?: Record<string, unknown>) => {
        const currentKey = useAppStore.getState().config.providers[descriptor.connectionId]?.apiKey ?? '';
        if (!isSafeNativeProtocolTaskId(taskId, [...(input.secretValues ?? []), currentKey])) throw new Error('原工作流未返回可安全保存的任务身份，请在平台核对');
        if (recoveryContext) validateNativeProtocolContext(recoveryContext);
        ({ record, receipt } = await retainNativeWorkflowSubmission(record, slot.id, { taskId, recoveryContext }));
      };
      // 合同、输入与耐久意图的异步核验后，再核对原始守卫，防止切集窗口落在最后一次 await 中。
      await input.beforeSubmit?.(); input.signal?.throwIfAborted();
      preparation.assertCurrent(); preparation.release(); preparation = undefined;
      sent = true;
      const result = await input.submit(index, input.signal, received);
      if (result.taskId && receipt.submissions[index].state !== 'submitted') await received(result.taskId, result.recoveryContext);
      if (input.synchronous) {
        if (result.taskId || !result.outputs?.length) throw new Error('同步工作流未返回完整产物，不伪造远端任务 ID');
        const files = await saveOutputs(record, result.outputs, undefined, undefined, input.mediaDownloadAccess);
        ({ record, receipt } = await retainNativeWorkflowSyncOutputs(record, slot.id, files));
        record = await retainNativeMediaOutputs(record, files);
      } else if (!result.taskId) throw new Error('工作流未返回原任务 ID，请到平台核对');
    } catch (error) {
      firstError = error;
      const knownId = error instanceof Error && (error as Error & { nativeTaskId?: unknown }).nativeTaskId;
      if (isSafeNativeProtocolTaskId(knownId, [...(input.secretValues ?? []), useAppStore.getState().config.providers[descriptor.connectionId]?.apiKey ?? ''])
        && receipt.submissions[index].state === 'unknown') {
        ({ record, receipt } = await retainNativeWorkflowSubmission(record, slot.id, { taskId: knownId }));
      } else if (!sent || input.isDefinitiveFailure?.(error) || getHttpResponseError(error)?.definitiveFailure === true) {
        ({ record, receipt } = await retainNativeWorkflowSubmission(record, slot.id, sent ? { failed: true } : { notStarted: true }).catch(() => ({ record, receipt })));
      }
      break;
    } finally {
      preparation?.release(); preparation = undefined;
    }
  }
  if (record.status === 'delivered') return delivered(record.operationId);
  if (record.status === 'reviewed' || record.lease !== submissionLease) throw pending(record);
  if (record.status !== 'submitted' || !input.synchronous) {
    ({ record, receipt } = await sealNativeWorkflowSubmissions(record, context));
  }
  if (record.status === 'failed') throw firstError ?? new Error('工作流提交均已明确失败，原回执保留');
  if (record.status !== 'outcome-unknown') {
    try { await resumeNativeWorkflowTask(record.operationId, input.signal); }
    catch (error) { firstError = error; }
    record = await currentRecord(record.ownerProjectId, record.operationId);
    if (record.status === 'delivered') return delivered(record.operationId);
    if (record.status === 'failed') throw firstError ?? new Error('原工作流任务均已失败');
  }
  throw pending(record);
  } finally { preparation?.release(); }
}

async function assertWorkflowContract(descriptor: NativeWorkflowDescriptor): Promise<void> {
  const state = useAppStore.getState(), workflow = descriptor.workflowId ? state.workflows.find((item) => item.id === descriptor.workflowId) : undefined;
  if (descriptor.adapter === 'muse-webview') {
    const { MUSE_BASE_URL, MUSE_IMAGE_MODEL, MUSE_VIDEO_MODEL } = await import('./ai/museModels');
    const connection = state.config.providers.muse;
    if (!connection || (connection.catalogId ?? 'muse') !== 'muse' || descriptor.connectionId !== 'muse'
      || !['image', 'video'].includes(descriptor.category) || descriptor.providerBase !== MUSE_BASE_URL
      || descriptor.modelId !== (descriptor.category === 'image' ? MUSE_IMAGE_MODEL : MUSE_VIDEO_MODEL)
      || descriptor.digest !== await nativeWorkflowDigest(['muse-webview-v1', descriptor.category, descriptor.modelId])) {
      throw new Error('原 Muse 连接或生成合同已变化，未提交或重发任务');
    }
    return;
  }
  if (descriptor.adapter === 'runninghub-model') {
    const { getRunningHubModel } = await import('./ai/providers/runninghubModelManifest');
    const definition = getRunningHubModel(descriptor.modelId);
    if (!definition || descriptor.digest !== await nativeWorkflowDigest(['runninghub-model-v1', definition, descriptor.category])) throw new Error('原模型合同已变化，未提交生成');
  } else {
    if (!workflow) throw new Error('原工作流已移除，未提交生成');
    const material = descriptor.adapter === 'comfyui' ? ['comfyui-native-media-v1', workflow.id, workflow.fileContent, workflow.serverId, descriptor.category]
      : descriptor.adapter === 'runninghub-workflow' ? ['runninghub-workflow-v1', workflow.id, workflow.runninghub, descriptor.category]
        : ['workflow-api-v1', workflow.id, workflow.workflowApi];
    if (descriptor.digest !== await nativeWorkflowDigest(material)) throw new Error('原工作流合同已变化，未提交生成');
  }
  let base: string;
  if (descriptor.adapter === 'comfyui') { const { comfyBaseUrlFor } = await import('./comfyServers'); base = comfyBaseUrlFor(descriptor.workflowId); }
  else if (descriptor.adapter === 'workflow-api') {
    const { workflowApiConnection } = await import('./workflowApi/workflowApiAdapter'); base = workflowApiConnection(state.config.providers[descriptor.connectionId], workflow && workflow.workflowApi || undefined).baseUrl;
  } else {
    const { runningHubConnection } = await import('./workflowExecutionService'); const { runningHubSiteId } = await import('./runninghubSiteCredentials');
    if (!['runninghub', 'runninghub-model'].includes(descriptor.connectionId)) throw new Error('原连接身份不匹配');
    base = runningHubConnection(state.config.providers, descriptor.connectionId as 'runninghub' | 'runninghub-model', runningHubSiteId(descriptor.providerBase)).baseUrl;
  }
  if (normalizeNativeMediaProviderBase(base) !== descriptor.providerBase) throw new Error('原工作流服务地址已变化，未提交生成');
}

async function queryOriginal(receipt: NativeWorkflowReceipt, task: NativeWorkflowTask, signal: AbortSignal): Promise<CloudWorkflowOutput[]> {
  const descriptor = receipt.descriptor, state = useAppStore.getState();
  if (descriptor.adapter === 'muse-webview') {
    await assertWorkflowContract(descriptor);
    if (descriptor.category !== 'image' && descriptor.category !== 'video') throw new Error('原 Muse 任务类型无效');
    const { queryMuseTask } = await import('./museService');
    return [{ kind: descriptor.category, url: await queryMuseTask(task.taskId, descriptor.category, signal) }];
  }
  const workflow = descriptor.workflowId ? state.workflows.find((item) => item.id === descriptor.workflowId) : undefined;
  if (descriptor.adapter === 'comfyui') {
    const { comfyBaseUrlFor } = await import('./comfyServers');
    if (!workflow || descriptor.digest !== await nativeWorkflowDigest(['comfyui-native-media-v1', workflow.id, workflow.fileContent, workflow.serverId, descriptor.category])
      || normalizeNativeMediaProviderBase(comfyBaseUrlFor(workflow.id)) !== descriptor.providerBase) throw new Error('原 ComfyUI 工作流或服务已变化，原任务保留');
    const { pollComfyHistory } = await import('./comfyPolling');
    return pollComfyHistory(descriptor.providerBase, task.taskId, '原 ComfyUI 任务尚未取回',
      (outputs) => nativeComfyOutputs(descriptor.providerBase, outputs, descriptor.category), signal);
  }
  if (descriptor.adapter === 'runninghub-model' || descriptor.adapter === 'runninghub-workflow') {
    const { runningHubConnection } = await import('./workflowExecutionService');
    const { runningHubSiteId } = await import('./runninghubSiteCredentials');
    if (!['runninghub', 'runninghub-model'].includes(descriptor.connectionId)) throw new Error('原 RunningHub 连接身份无效');
    const connection = runningHubConnection(state.config.providers, descriptor.connectionId as 'runninghub' | 'runninghub-model', runningHubSiteId(descriptor.providerBase));
    if (normalizeNativeMediaProviderBase(connection.baseUrl) !== descriptor.providerBase) throw new Error('原 RunningHub 站点已变化');
    if (descriptor.adapter === 'runninghub-model') {
      const { getRunningHubModel } = await import('./ai/providers/runninghubModelManifest');
      const definition = getRunningHubModel(descriptor.modelId);
      if (!definition || descriptor.digest !== await nativeWorkflowDigest(['runninghub-model-v1', definition, descriptor.category])) throw new Error('原 RunningHub 模型合同已变化');
      const { queryRunningHubModel } = await import('./ai/providers/runninghubMedia');
      return queryRunningHubModel(connection, [task.taskId], descriptor.category, signal);
    }
    if (!workflow?.runninghub || descriptor.digest !== await nativeWorkflowDigest(['runninghub-workflow-v1', workflow.id, workflow.runninghub, descriptor.category])) throw new Error('原 RunningHub 工作流合同已变化');
    const { queryRunningHubWorkflow } = await import('./ai/providers/runninghubWorkflow');
    return queryRunningHubWorkflow(connection, task.taskId, descriptor.category, descriptor.outputNodeIds, signal);
  }
  if (!workflow?.workflowApi || descriptor.digest !== await nativeWorkflowDigest(['workflow-api-v1', workflow.id, workflow.workflowApi])) throw new Error('原工作流 API 合同已变化');
  const manifest = workflow.workflowApi;
  const { workflowApiConnection, queryWorkflowApiTask } = await import('./workflowApi/workflowApiAdapter');
  const connection = workflowApiConnection(state.config.providers[descriptor.connectionId], manifest);
  if (normalizeNativeMediaProviderBase(connection.baseUrl) !== descriptor.providerBase) throw new Error('原工作流 API 地址已变化');
  let poll: import('../types/aiTypes').ResolvedModelProtocolPoll | undefined;
  if (manifest.version === 2) {
    const { parseModelExecutionProtocol } = await import('./ai/modelProtocol');
    const { resolvePoll } = await import('./ai/modelProtocolPoll');
    const { resolveNativeProtocolContext } = await import('./nativeModelProtocolTask');
    const protocol = parseModelExecutionProtocol(manifest.protocol);
    if (!protocol.poll) throw new Error('原异步工作流查询合同缺失');
    poll = resolvePoll(connection.baseUrl, protocol.poll, protocol.auth, resolveNativeProtocolContext(protocol, task.taskId, task.recoveryContext));
  }
  return queryWorkflowApiTask(connection, task.taskId, { version: 1, adapter: manifest.adapter, attemptId: receipt.operationId,
    workflowId: workflow.id, remoteWorkflowId: manifest.workflowId, origin: new URL(connection.baseUrl).origin, state: 'disconnected',
    ...(manifest.version === 2 ? { manifest, poll } : {}) }, signal);
}
export function nativeComfyOutputs(baseUrl: string, outputs: ComfyOutputs, category: MediaKind): CloudWorkflowOutput[] | null {
  const files = findComfyOutputFiles(outputs, category === 'audio' ? ['audio', 'video'] : [category]);
  if (!files.length) return null;
  if (files.length > 128) throw new Error('ComfyUI 产物超过上限，未截断交付');
  return files.map((file) => ({ url: buildComfyFileUrl(baseUrl, file), kind: category }));
}
async function workflowDownloadAccess(descriptor: NativeWorkflowDescriptor): Promise<MediaDownloadAccess | undefined> {
  if (descriptor.adapter === 'comfyui' || descriptor.adapter === 'muse-webview') return undefined;
  if (descriptor.adapter !== 'workflow-api') return createMediaDownloadAccess(descriptor.connectionId, descriptor.providerBase, { type: 'bearer' });
  const workflow = useAppStore.getState().workflows.find((item) => item.id === descriptor.workflowId);
  if (!workflow?.workflowApi) throw new Error('原工作流 API 下载合同缺失');
  const { parseModelExecutionProtocol } = await import('./ai/modelProtocol');
  const auth = workflow.workflowApi.version === 2 ? parseModelExecutionProtocol(workflow.workflowApi.protocol).auth : { type: 'header' as const, name: 'Authorization', prefix: '' };
  return createMediaDownloadAccess(descriptor.connectionId, descriptor.providerBase, auth);
}
export async function resumeNativeWorkflowTask(operationId: string, externalSignal?: AbortSignal): Promise<void> {
  const context = captureLegacyCanvasContext(useAppStore.getState());
  if (!context || context.modelGeneration !== 1) throw new Error('请返回原工作流画布');
  let record = await currentRecord(context.projectId, operationId), receipt = await readNativeWorkflowReceipt(operationId);
  if (!receipt || !isNativeWorkflowTask(record) || record.canvasId !== context.canvasId) throw new Error('原工作流不属于当前画布');
  if (record.status === 'delivered') { const { projectNativeMediaMessages } = await import('./nativeMediaMessages'); await projectNativeMediaMessages(); return; }
  if (!record.localResults) {
    ({ record, receipt } = await sealNativeWorkflowSubmissions(record, context));
    if (receipt.syncOutputs) record = await retainNativeMediaOutputs(record, receipt.syncOutputs);
  }
  if (record.status === 'failed') throw new Error('原工作流提交或任务均已明确失败，原回执保留');
  if (!['submitted', 'reviewed'].includes(record.status)) throw pending(record);
  record = await claimNativeMediaRecovery(operationId, context);
  const controller = new AbortController(), abort = () => controller.abort();
  externalSignal?.addEventListener('abort', abort, { once: true }); if (externalSignal?.aborted) controller.abort();
  const assertCurrent = () => { controller.signal.throwIfAborted(); if (!isProjectExpectedContextCurrent(context, useAppStore.getState(), { checkCanvasRevision: false })) throw new Error('原画布已切换，原工作流回执及产物保留'); };
  const unsubscribe = useAppStore.subscribe(() => { try { assertCurrent(); } catch { controller.abort(); } });
  try {
    if (!record.localResults) {
      for (const taskId of receipt.tasks.map((task) => task.taskId)) {
        assertCurrent(); const task = receipt.tasks.find((item) => item.taskId === taskId)!;
        if (task.state === 'failed') continue;
        if (task.outputs) { try { for (const file of task.outputs) await readNativeMediaLocalResult(record.canvasId, file); continue; } catch { assertCurrent(); } }
        try {
          const outputs = await queryOriginal(receipt, task, controller.signal); assertCurrent();
          const files = await saveOutputs(record, outputs, controller.signal, assertCurrent, await workflowDownloadAccess(receipt.descriptor));
          if (task.outputs) {
            const signature = (values: NativeMediaLocalOutput[]) => values.map((file) => `${file.category}:${file.sha256}:${file.bytes}`).sort().join('|');
            if (signature(task.outputs) !== signature(files)) throw new Error('原平台返回了另一份候选集合，未替换已有本机产物');
            for (const file of task.outputs) await readNativeMediaLocalResult(record.canvasId, file);
          } else ({ record, receipt } = await retainNativeWorkflowTaskOutputs(record, taskId, { outputs: files }));
        } catch (error) {
          const { RunningHubTaskFailed } = await import('./ai/providers/runninghubWorkflow');
          const { WorkflowApiTaskFailed } = await import('./workflowApi/workflowApiAdapter');
          if (!task.outputs && (error instanceof PollTaskFailedError || error instanceof RunningHubTaskFailed || error instanceof WorkflowApiTaskFailed)) {
            ({ record, receipt } = await retainNativeWorkflowTaskOutputs(record, taskId, { failed: true })); continue;
          }
          throw error;
        }
      }
      const files = receipt.tasks.flatMap((task) => task.outputs ?? []);
      if (!files.length) throw new Error('原工作流任务均已明确失败，原回执保留');
      if (receipt.tasks.some((task) => task.state === 'submitted') || receipt.submissions.some((slot) => slot.state === 'unknown') && !receipt.uncertainAcknowledged) throw pending(record);
      const summary = nativeWorkflowSummary(receipt);
      record = await retainNativeMediaOutputs(record, files, { completion: { taskCount: receipt.tasks.length,
        failedTasks: summary.failedTasks, failedSubmissions: summary.failedSubmissions, unknownSubmissions: summary.unknownSubmissions,
        notStartedSubmissions: summary.notStartedSubmissions } });
    }
    const files = nativeMediaLocalOutputs(record); for (const file of files) await readNativeMediaLocalResult(record.canvasId, file);
    assertCurrent();
    if (record.origin?.deliveryMode === 'chat') { const { commitNativeMediaMessageDelivery } = await import('./nativeMediaDelivery'); await commitNativeMediaMessageDelivery(record, files[0].relativePath, { signal: controller.signal }); }
    else await useAppStore.getState().commitNativeMediaResult(record, files[0].relativePath, context, controller.signal);
    const { projectNativeMediaMessages } = await import('./nativeMediaMessages'); await projectNativeMediaMessages().catch(() => {});
  } finally { unsubscribe(); externalSignal?.removeEventListener('abort', abort); controller.abort(); }
}

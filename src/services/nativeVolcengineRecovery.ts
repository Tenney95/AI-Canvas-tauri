/** 新画布媒体任务只续查原远端 ID，结果与账本由项目事务一起提交。 */
import { useAppStore } from '../store/useAppStore';
import { captureLegacyCanvasContext, isProjectExpectedContextCurrent } from './projectExecutionContext';
import { claimNativeMediaRecovery, failNativeMediaTask, isNativeMediaLeaseCurrent, listNativeMediaTasks, normalizeNativeMediaProviderBase } from './indexedDb/nativeMediaTaskRepository';
import { pollVolcengineVideoTask } from './ai/providers/volcengineVideoQuery';
import { persistMediaUrlToProjectData } from './fileService';
import { APIMART_BASE_URL, GRSAI_BASE_URL, VOLCENGINE_BASE_URL } from '../constants/api';
import { pollTask, PollTaskFailedError } from './pollTask';
import { GRSAI_H3_PROTOCOL } from './ai/grsaiModels';
import { resolvePoll, pollResolvedModelProtocol } from './ai/modelProtocolPoll';
import { sha256BytesHex } from './mediaDataUrl';
import { projectModelSourceToken } from './projectModelComparisonMaterial';
import { fetchApimartTask, type ApimartTaskResult } from './ai/apimartGen';
import { splitCommaSeparatedUrls } from './ai/helpers';
import { createMediaDownloadAccess } from './ai/mediaDownloadAccess';
import { VIDEO_POLL_MAX_DURATION_MS } from './pollManager';
import { resolveNativeProtocolConnection } from './nativeProtocolConnection';
import { resolveModelExecutionProfile } from './ai/modelProtocol';
import { nativeProtocolTaskDigest, nativeProtocolQueryDigest, resolveNativeProtocolContext } from './nativeModelProtocolTask';
import { nativeMediaLocalOutputs } from './nativeMediaCollection';
import { captureNativeMediaLocalResult, readNativeMediaLocalResult } from './nativeMediaLocalResult';
import { retainNativeMediaOutputs } from './indexedDb/nativeMediaCollectionRepository';
import { nativeBuiltinVideoProtocolDigest } from './nativeBuiltinVideoProtocol';
import { resolveProviderCatalogId } from './ai/providerPolicies';
import { assertMinimaxQueryResponse, usesMinimaxModelProtocol } from './ai/providers/minimaxModelManifest';
import { RELAYON_VIDEO_RESULT_URL_PATHS, usesRelayonModelProtocol } from './ai/providers/relayonModelManifest';
import { isSafeNativeProtocolTaskId } from './nativeProtocolContext';
import { assertModelProtocolResult } from './ai/modelCapabilityValidation';

export async function inspectNativeVolcengineTask(operationId: string) {
  const context = captureLegacyCanvasContext(useAppStore.getState());
  if (!context || context.modelGeneration !== 1) throw new Error('请先打开原新项目画布');
  const row = (await listNativeMediaTasks(context.projectId)).find((item) => item.operationId === operationId);
  if (!row || row.canvasId !== context.canvasId || row.projectEpoch !== context.projectEpoch || row.canvasEpoch !== context.canvasEpoch
    || row.episodeId !== context.episodeId || (!row.recovery && !row.apimartImageBatch && !row.modelRef && (!['volcengine', 'apimart', 'grsai', 'comfyui'].includes(row.providerConfigId) || row.category !== 'video'))
    || row.category !== 'video' && !['media-input-v2', 'media-input-v3'].includes(row.fingerprintScheme ?? '')) {
    throw new Error('当前画布版本没有该媒体原操作');
  }
  return row;
}

/** 切换画布或取消会立即终止查询；提交未知、结果已交付均不重新生成。 */
export async function resumeNativeVolcengineTask(operationId: string, externalSignal?: AbortSignal,
  options: { allowUnstartedStage?: boolean } = {}): Promise<void> {
  externalSignal?.throwIfAborted();
  const state = useAppStore.getState(), context = captureLegacyCanvasContext(state);
  if (!context || context.modelGeneration !== 1 || !context.runtimeEpoch) throw new Error('请先打开原新项目画布');
  const found = await inspectNativeVolcengineTask(operationId);
  if (found.status === 'delivered') {
    const { projectNativeMediaMessages } = await import('./nativeMediaMessages');
    await projectNativeMediaMessages(); return;
  }
  if (found.apimartImageBatch) {
    const { resumeNativeApimartImageBatch } = await import('./nativeApimartImageRecovery');
    return resumeNativeApimartImageBatch(operationId, externalSignal);
  }
  if (found.localResults?.length || found.submissionKind === 'sync' && found.localResult) {
    const record = await claimNativeMediaRecovery(operationId, context);
    const files = nativeMediaLocalOutputs(record);
    for (const file of files) await readNativeMediaLocalResult(record.canvasId, file);
    externalSignal?.throwIfAborted();
    if (!isProjectExpectedContextCurrent(context, useAppStore.getState(), { checkCanvasRevision: false })) throw new Error('原画布已切换，本机产物保留');
    if (record.origin?.deliveryMode === 'chat') {
      const { commitNativeMediaMessageDelivery } = await import('./nativeMediaDelivery');
      await commitNativeMediaMessageDelivery(record, files[0].relativePath, { signal: externalSignal });
    } else await useAppStore.getState().commitNativeMediaResult(record, files[0].relativePath, context, externalSignal);
    const { projectNativeMediaMessages } = await import('./nativeMediaMessages');
    await projectNativeMediaMessages(); return;
  }
  if (found.recovery?.kind === 'workflow') {
    const { resumeNativeWorkflowTask } = await import('./nativeWorkflowTasks');
    return resumeNativeWorkflowTask(operationId, externalSignal);
  }
  if (found.recovery?.kind === 'builtin-audio') {
    const { resumeNativeBuiltinAudioTask } = await import('./nativeBuiltinAudioRecovery');
    return resumeNativeBuiltinAudioTask(operationId, externalSignal, undefined, options);
  }
  if (found.recovery?.kind === 'builtin-image' || found.recovery?.kind === 'builtin-video' && found.recovery.serverId === 'dreamina-cli-v1') {
    const { resumeNativeBuiltinImageTask } = await import('./nativeBuiltinImageTask');
    return resumeNativeBuiltinImageTask(operationId, externalSignal);
  }
  if (found.recovery?.kind === 'general-protocol' && found.recovery.serverId === 'general-async-v1') {
    const { resumeNativeGeneralAsyncTask } = await import('./nativeGeneralAsyncTask');
    return resumeNativeGeneralAsyncTask(operationId, externalSignal);
  }
  if (found.submissionKind === 'sync') throw new Error('原同步调用没有已保存的本机产物，请先核对平台；不会重新提交生成');
  if (found.providerConfigId === 'comfyui') {
    const { resumeNativeComfyTask } = await import('./nativeComfyRecovery');
    return resumeNativeComfyTask(operationId, externalSignal);
  }
  if (!['submitted', 'reviewed'].includes(found.status) || !found.remoteTaskId) throw new Error('原任务未取得可确认的远端 ID，请先到原平台核对，勿重新提交');
  let record = await claimNativeMediaRecovery(operationId, context);
  if (record.imageReference) {
    const { verifyNativeVideoImageReference } = await import('./nativeVideoImageReference');
    await verifyNativeVideoImageReference(context, record.nodeId, record.imageReference);
  }
  const assertCurrent = () => {
    externalSignal?.throwIfAborted();
    if (!isProjectExpectedContextCurrent(context!, useAppStore.getState(), { checkCanvasRevision: false })) throw new Error('原画布已切换，结果已保留');
  };
  assertCurrent();
  const provider = useAppStore.getState().config.providers[record.providerConfigId];
  if (!provider?.apiKey) throw new Error('缺少原视频连接的 API Key，原任务已保留');
  const generalExpected = record.recovery?.kind === 'general-protocol' || record.modelRef?.startsWith('general/') === true;
  const general = generalExpected ? resolveNativeProtocolConnection(record) : undefined;
  const generalProtocol = general && resolveModelExecutionProfile(general.model.executionProfile);
  if (generalExpected && (!general || !generalProtocol || general.providerConfigId !== record.providerConfigId || general.model.category !== record.category
    || await nativeProtocolTaskDigest(general.model.modelId, generalProtocol) !== record.protocolDigest
      && !(record.recovery?.kind === 'general-protocol' && await nativeProtocolQueryDigest(general.model.modelId, generalProtocol) === record.recovery.digest))) throw new Error('原模型或查询协议已变化，请恢复原配置后续查');
  const isVolcengine = !generalExpected && record.providerConfigId === 'volcengine';
  const isGrsai = !generalExpected && record.providerConfigId === 'grsai';
  if (record.recovery?.kind === 'builtin-video' && (await nativeBuiltinVideoProtocolDigest(record.providerConfigId) !== record.protocolDigest
    || record.recovery.digest !== record.protocolDigest)) throw new Error('原内置视频查询合同已变化，未重新提交生成');
  const baseUrl = general?.baseUrl || provider.baseUrl?.trim() || (isVolcengine ? VOLCENGINE_BASE_URL : isGrsai ? GRSAI_BASE_URL : APIMART_BASE_URL);
  if (isGrsai && await sha256BytesHex(new TextEncoder().encode(projectModelSourceToken(GRSAI_H3_PROTOCOL))) !== record.protocolDigest) {
    throw new Error('原视频查询协议已变化，请核对原任务，不会自动重投');
  }
  if (normalizeNativeMediaProviderBase(baseUrl) !== record.providerBase) {
    throw new Error('视频连接地址已变化，请恢复原连接后继续查询');
  }
  const controller = new AbortController();
  const stop = () => controller.abort();
  externalSignal?.addEventListener('abort', stop, { once: true });
  if (externalSignal?.aborted) controller.abort();
  let remoteFailed: 'failed' | 'cancelled' | undefined;
  const unsubscribe = useAppStore.subscribe(() => {
    if (!isProjectExpectedContextCurrent(context, useAppStore.getState(), { checkCanvasRevision: false })) controller.abort();
  });
  try {
    const query = async (taskId: string) => generalProtocol ? await (async () => {
      const catalogId = resolveProviderCatalogId(record.providerConfigId, provider);
      const poll = { ...resolvePoll(baseUrl, generalProtocol.poll!, generalProtocol.auth, resolveNativeProtocolContext(generalProtocol, taskId, record.pollContext)),
        ...(catalogId === 'relayonapi' && record.category === 'video' && usesRelayonModelProtocol(general!.model.modelId, general!.model.executionProfile)
          ? { resultUrlFallbackPaths: [...new Set(RELAYON_VIDEO_RESULT_URL_PATHS)] } : {}) };
      const result = await pollResolvedModelProtocol(poll, provider.apiKey!, controller.signal, baseUrl,
        catalogId === 'minimax' && usesMinimaxModelProtocol(general!.model.modelId, general!.model.executionProfile) ? assertMinimaxQueryResponse : undefined);
      assertModelProtocolResult(record.category, result);
      if (!result.urls?.length || result.urls.length > 128) throw new Error('原媒体产物集合为空或超过安全上限，原任务保留');
      return { urls: result.urls };
    })() : isVolcengine
      ? await pollVolcengineVideoTask({ apiKey: provider.apiKey, baseUrl, taskId, signal: controller.signal,
        maxDuration: VIDEO_POLL_MAX_DURATION_MS, onFailed: (status) => { remoteFailed = status; } })
      : isGrsai ? await (async () => {
        if (!/^[A-Za-z0-9_-]{1,160}$/.test(taskId)) throw new Error('原任务 ID 不能安全用于查询，请到原平台核对');
        const poll = resolvePoll(baseUrl, GRSAI_H3_PROTOCOL.poll!, GRSAI_H3_PROTOCOL.auth, { submit: { id: taskId } });
        try {
          const result = await pollResolvedModelProtocol(poll, provider.apiKey!, controller.signal, baseUrl);
          if (!result.urls?.length || result.urls.length > 128) throw new Error('原视频任务产物集合为空或超过安全上限');
          return { urls: result.urls };
        } catch (error) {
          if (error instanceof PollTaskFailedError) remoteFailed = 'failed';
          throw error;
        }
      })() : await pollTask<ApimartTaskResult<{ videos?: Array<{ url: string[] }>; images?: Array<{ url: string[] }> }>, { urls: string[] }>({
        fetchState: (signal) => fetchApimartTask(provider.apiKey!, baseUrl, taskId, signal, true),
        isComplete: (task) => {
          if (task.status !== 'completed') return null;
          const videos = task.result?.videos?.flatMap((item) => splitCommaSeparatedUrls(item.url)) ?? [];
          const images = task.result?.images?.flatMap((item) => splitCommaSeparatedUrls(item.url)) ?? [];
          const urls = videos.length ? videos : images;
          if (!urls.length || urls.length > 128) throw new Error('原视频任务产物集合为空或超过安全上限');
          return { urls };
        },
        isFailed: (task) => {
          if (!['failed', 'cancelled', 'error'].includes(task.status ?? '')) return null;
          remoteFailed = task.status === 'cancelled' ? 'cancelled' : 'failed';
          return '原视频任务已确认失败或取消';
        }, interval: 3000, maxDuration: VIDEO_POLL_MAX_DURATION_MS, signal: controller.signal, onFetchError: 'throw',
      });
    const savedIds = !generalExpected && record.pollContext?.taskIds;
    const taskIds = Array.isArray(savedIds) ? savedIds : [record.remoteTaskId!];
    if (!taskIds.length || taskIds.length > 128 || taskIds[0] !== record.remoteTaskId
      || taskIds.some((id) => !isSafeNativeProtocolTaskId(id, [provider.apiKey!]))) throw new Error('原任务集合无效，未发起查询');
    const results: Awaited<ReturnType<typeof query>>[] = [];
    let failedTasks = 0;
    for (const taskId of taskIds as string[]) {
      assertCurrent(); remoteFailed = undefined;
      try { results.push(await query(taskId)); }
      catch (error) { if (remoteFailed || error instanceof PollTaskFailedError) { failedTasks++; continue; } throw error; }
    }
    if (!results.length) { remoteFailed = 'failed'; throw new Error('原媒体任务均已确认失败'); }
    remoteFailed = undefined;
    const urls = results.flatMap((result) => 'urls' in result ? result.urls : [result.url]);
    if (urls.length > 128) throw new Error('原媒体完整候选集合超过安全上限，未截断交付');
    const first = results[0];
    const completionTokens = 'completionTokens' in first && typeof first.completionTokens === 'number' ? first.completionTokens : undefined;
    assertCurrent();
    if (!await isNativeMediaLeaseCurrent(record)) throw new Error('原媒体租约已变化，结果已保留');
    const { findBillingRunByTask, updateBillingRun } = await import('./billing/volcengineBillingService');
    const run = isVolcengine ? await findBillingRunByTask(record.remoteTaskId!, record.canvasId).catch(() => null) : null;
    if (run) {
      const { quoteVolcengineVideo } = await import('./billing/volcenginePricing');
      const input = JSON.parse(run.inputJson) as { durationSeconds?: number; resolution?: string; ratio?: string; referenceType?: string };
      const quote = completionTokens === undefined ? null : quoteVolcengineVideo({ modelId: run.modelId,
        durationSeconds: input.durationSeconds ?? -1, resolution: input.resolution ?? '720p', ratio: input.ratio ?? '16:9',
        inputVideoSeconds: input.referenceType === 'video-reference' ? 1 : undefined, completionTokens });
      await updateBillingRun(run, { status: 'succeeded', finishedAt: Date.now(), calculatedMicros: quote?.amountMicros ?? null,
        amountConfidence: quote?.amountMicros == null ? 'unknown' : 'usage',
        inputJson: JSON.stringify({ ...input, completionTokens: completionTokens ?? null }) });
    }
    assertCurrent();
    const label = useAppStore.getState().nodes.find((node) => node.id === record.nodeId)?.data.label || '媒体';
    const files = [];
    for (const url of urls) {
      const saved = await persistMediaUrlToProjectData(url, record.canvasId, `ai-${record.category}`, label,
      { signal: controller.signal, assertCurrent, ...(isVolcengine ? {} : { mediaDownloadAccess: createMediaDownloadAccess(record.providerConfigId, baseUrl, generalProtocol?.auth ?? { type: 'bearer' }) }) });
      assertCurrent();
      if (!saved.filePath || !await isNativeMediaLeaseCurrent(record)) throw new Error('原媒体租约已变化或文件未保存，结果已保留');
      files.push({ ...await captureNativeMediaLocalResult(record.canvasId, saved.filePath), category: record.category });
    }
    record = await retainNativeMediaOutputs(record, files, { completion: { taskCount: taskIds.length, failedTasks } });
    const relative = files[0].relativePath;
    assertCurrent();
    if (record.origin?.deliveryMode === 'chat') {
      const { commitNativeMediaMessageDelivery } = await import('./nativeMediaDelivery');
      await commitNativeMediaMessageDelivery(record, relative, { signal: controller.signal });
    } else await useAppStore.getState().commitNativeMediaResult(record, relative, context, controller.signal);
    const { projectNativeMediaMessages } = await import('./nativeMediaMessages');
    await projectNativeMediaMessages().catch(() => { /* 完成回执已耐久提交，重开原对话可再次投影。 */ });
  } catch (error) {
    if (generalProtocol && error instanceof PollTaskFailedError) remoteFailed = 'failed';
    if (remoteFailed) {
      await failNativeMediaTask(record).catch(() => undefined);
      const { findBillingRunByTask, updateBillingRun } = await import('./billing/volcengineBillingService');
      const run = isVolcengine ? await findBillingRunByTask(record.remoteTaskId!, record.canvasId).catch(() => null) : null;
      await updateBillingRun(run, { status: remoteFailed, finishedAt: Date.now(), calculatedMicros: 0,
        amountConfidence: 'calculated', errorMessage: '火山任务已确认失败或取消' });
      throw new Error('服务商已确认原任务失败或取消，原回执已保留');
    }
    throw error;
  } finally { unsubscribe(); controller.abort(); externalSignal?.removeEventListener('abort', stop); }
}

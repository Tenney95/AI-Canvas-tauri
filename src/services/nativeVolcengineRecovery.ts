/** 新画布媒体任务只续查原远端 ID，结果与账本由项目事务一起提交。 */
import { useAppStore } from '../store/useAppStore';
import { captureLegacyCanvasContext, isProjectExpectedContextCurrent } from './projectExecutionContext';
import { claimNativeMediaRecovery, failNativeMediaTask, isNativeMediaLeaseCurrent, listNativeMediaTasks, normalizeNativeMediaProviderBase } from './indexedDb/nativeMediaTaskRepository';
import { pollVolcengineVideoTask } from './ai/providers/volcengineVideoQuery';
import { getProjectDataDir, persistMediaUrlToProjectData } from './fileService';
import { getRelativeAssetPath } from './fs/assetIndex';
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
import { resolveGeneralModelConnection } from './ai/helpers';
import { resolveModelExecutionProfile } from './ai/modelProtocol';
import { nativeProtocolTaskDigest, nativeProtocolTaskIdContext } from './nativeModelProtocolTask';
import { assertModelProtocolResult } from './ai/modelCapabilityValidation';

export async function inspectNativeVolcengineTask(operationId: string) {
  const context = captureLegacyCanvasContext(useAppStore.getState());
  if (!context || context.modelGeneration !== 1) throw new Error('请先打开原新项目画布');
  const row = (await listNativeMediaTasks(context.projectId)).find((item) => item.operationId === operationId);
  if (!row || row.canvasId !== context.canvasId || (!row.apimartImageBatch && !row.modelRef && (!['volcengine', 'apimart', 'grsai', 'comfyui'].includes(row.providerConfigId) || row.category !== 'video'))
    || row.category !== 'video' && row.fingerprintScheme !== 'media-input-v2') {
    throw new Error('当前画布没有该视频原操作');
  }
  return row;
}

/** 切换画布或取消会立即终止查询；提交未知、结果已交付均不重新生成。 */
export async function resumeNativeVolcengineTask(operationId: string, externalSignal?: AbortSignal): Promise<void> {
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
  if (found.submissionKind === 'sync') {
    if (!found.localResult) throw new Error('原同步调用没有已保存的本机产物，请先核对平台；不会重新提交生成');
    const record = await claimNativeMediaRecovery(operationId, context);
    const { readNativeMediaLocalResult } = await import('./nativeMediaLocalResult');
    await readNativeMediaLocalResult(record.canvasId, record.localResult!);
    externalSignal?.throwIfAborted();
    if (!isProjectExpectedContextCurrent(context, useAppStore.getState(), { checkCanvasRevision: false })) throw new Error('原画布已切换，本机产物保留');
    if (record.origin?.deliveryMode === 'chat') {
      const { commitNativeMediaMessageDelivery } = await import('./nativeMediaDelivery');
      await commitNativeMediaMessageDelivery(record, record.localResult!.relativePath, { signal: externalSignal });
    } else await useAppStore.getState().commitNativeMediaResult(record, record.localResult!.relativePath, context, externalSignal);
    const { projectNativeMediaMessages } = await import('./nativeMediaMessages');
    await projectNativeMediaMessages(); return;
  }
  if (found.providerConfigId === 'comfyui') {
    const { resumeNativeComfyTask } = await import('./nativeComfyRecovery');
    return resumeNativeComfyTask(operationId, externalSignal);
  }
  if (!['submitted', 'reviewed'].includes(found.status) || !found.remoteTaskId) throw new Error('原任务未取得可确认的远端 ID，请先到原平台核对，勿重新提交');
  const record = await claimNativeMediaRecovery(operationId, context);
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
  const general = record.modelRef ? resolveGeneralModelConnection(record.modelRef) : undefined;
  const generalProtocol = general && resolveModelExecutionProfile(general.model.executionProfile);
  if (record.modelRef && (!general || !generalProtocol || general.providerConfigId !== record.providerConfigId || general.model.category !== record.category
    || await nativeProtocolTaskDigest(general.model.modelId, generalProtocol) !== record.protocolDigest)) throw new Error('原模型或查询协议已变化，请恢复原配置后续查');
  const isVolcengine = !record.modelRef && record.providerConfigId === 'volcengine';
  const isGrsai = !record.modelRef && record.providerConfigId === 'grsai';
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
    const result = generalProtocol ? await (async () => {
      const poll = resolvePoll(baseUrl, generalProtocol.poll!, generalProtocol.auth, nativeProtocolTaskIdContext(generalProtocol, record.remoteTaskId!));
      const result = await pollResolvedModelProtocol(poll, provider.apiKey!, controller.signal, baseUrl);
      assertModelProtocolResult(record.category, result);
      if (result.urls?.length !== 1) throw new Error('原任务返回的候选数量不符合已冻结的单产物合同；全部原结果仍在平台保留，未截断交付');
      if (!result.urls?.[0]) throw new Error('原视频任务尚无可交付结果');
      return { url: result.urls[0] };
    })() : isVolcengine
      ? await pollVolcengineVideoTask({ apiKey: provider.apiKey, baseUrl, taskId: record.remoteTaskId!, signal: controller.signal,
        maxDuration: VIDEO_POLL_MAX_DURATION_MS, onFailed: (status) => { remoteFailed = status; } })
      : isGrsai ? await (async () => {
        if (!/^[A-Za-z0-9_-]{1,160}$/.test(record.remoteTaskId!)) throw new Error('原任务 ID 不能安全用于查询，请到原平台核对');
        const poll = resolvePoll(baseUrl, GRSAI_H3_PROTOCOL.poll!, GRSAI_H3_PROTOCOL.auth, { submit: { id: record.remoteTaskId! } });
        try {
          const result = await pollResolvedModelProtocol(poll, provider.apiKey!, controller.signal, baseUrl);
          if (!result.urls?.[0]) throw new Error('原视频任务完成但没有可取回的文件');
          return { url: result.urls[0] };
        } catch (error) {
          if (error instanceof PollTaskFailedError) remoteFailed = 'failed';
          throw error;
        }
      })() : await pollTask<ApimartTaskResult<{ videos?: Array<{ url: string[] }>; images?: Array<{ url: string[] }> }>, { url: string }>({
        fetchState: (signal) => fetchApimartTask(provider.apiKey!, baseUrl, record.remoteTaskId!, signal, true),
        isComplete: (task) => {
          if (task.status !== 'completed') return null;
          const videos = task.result?.videos?.flatMap((item) => splitCommaSeparatedUrls(item.url)) ?? [];
          const images = task.result?.images?.flatMap((item) => splitCommaSeparatedUrls(item.url)) ?? [];
          const url = videos[0] ?? images[0];
          if (!url) throw new Error('原视频任务完成但没有可取回的文件');
          return { url };
        },
        isFailed: (task) => {
          if (!['failed', 'cancelled', 'error'].includes(task.status ?? '')) return null;
          remoteFailed = task.status === 'cancelled' ? 'cancelled' : 'failed';
          return '原视频任务已确认失败或取消';
        }, interval: 3000, maxDuration: VIDEO_POLL_MAX_DURATION_MS, signal: controller.signal, onFetchError: 'throw',
      });
    const { url } = result;
    const completionTokens = 'completionTokens' in result && typeof result.completionTokens === 'number' ? result.completionTokens : undefined;
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
    const saved = await persistMediaUrlToProjectData(url, record.canvasId, `ai-${record.category}`, label,
      { signal: controller.signal, assertCurrent, ...(isVolcengine ? {} : { mediaDownloadAccess: createMediaDownloadAccess(record.providerConfigId, baseUrl, generalProtocol?.auth ?? { type: 'bearer' }) }) });
    assertCurrent();
    if (!saved.filePath || !await isNativeMediaLeaseCurrent(record)) throw new Error('原媒体租约已变化或文件未保存，结果已保留');
    const root = await getProjectDataDir(record.canvasId);
    const relative = root && getRelativeAssetPath(saved.filePath, root);
    if (!relative) throw new Error('视频素材不属于原项目，结果已保留');
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

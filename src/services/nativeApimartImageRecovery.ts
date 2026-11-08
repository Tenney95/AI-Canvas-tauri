/** 只查询原APIMart task集合；按task耐久保存全部候选后原子交付完整批次。 */
import { useAppStore } from '../store/useAppStore';
import { captureLegacyCanvasContext, isProjectExpectedContextCurrent } from './projectExecutionContext';
import { claimNativeMediaRecovery, isNativeMediaLeaseCurrent, listNativeMediaTasks, normalizeNativeMediaProviderBase } from './indexedDb/nativeMediaTaskRepository';
import { retainNativeImageBatchTask, sealNativeImageBatchSubmissions } from './indexedDb/nativeImageBatchRepository';
import { APIMART_IMAGE_BATCH_PROTOCOL, MAX_NATIVE_IMAGE_BATCH_RESULTS, nativeImageBatchResults, nativeImageBatchSettled } from './nativeImageBatch';
import { APIMART_BASE_URL } from '../constants/api';
import { sha256BytesHex } from './mediaDataUrl';
import { pollTask, PollTaskFailedError } from './pollTask';
import { fetchApimartTask, extractApimartImageUrls, type ApimartTaskResult } from './ai/apimartGen';
import { createMediaDownloadAccess } from './ai/mediaDownloadAccess';
import { persistMediaUrlToProjectData } from './fileService';
import { captureNativeMediaLocalResult, readNativeMediaLocalResult } from './nativeMediaLocalResult';
import { VIDEO_POLL_MAX_DURATION_MS } from './pollManager';
import type { NativeMediaLocalResult } from '../types/media';

export async function resumeNativeApimartImageBatch(operationId: string, externalSignal?: AbortSignal): Promise<void> {
  const context = captureLegacyCanvasContext(useAppStore.getState());
  if (!context || context.modelGeneration !== 1) throw new Error('请先打开原图片批次画布');
  let found = (await listNativeMediaTasks(context.projectId)).find((record) => record.operationId === operationId);
  if (!found?.apimartImageBatch || found.canvasId !== context.canvasId) throw new Error('原图片批次不属于当前画布');
  if (found.status === 'delivered') { const { projectNativeMediaMessages } = await import('./nativeMediaMessages'); await projectNativeMediaMessages(); return; }
  // prepared槽位有持久的未发送证明，但重启续查仍不补发付费生成，只保留原请求集合。
  if (found.apimartImageBatch.submissions.some((submission) => submission.state === 'prepared')) found = await sealNativeImageBatchSubmissions(found);
  if (!['submitted', 'reviewed'].includes(found.status) || !found.remoteTaskId) throw new Error('原图片批次仍有未确认提交，请先在平台核对并确认原记录；不会重新发起生成');
  if (found.apimartImageBatch!.tasks.every((task) => task.state === 'failed')) {
    if (found.status === 'submitted') await sealNativeImageBatchSubmissions(found);
    throw new Error('已知原图片任务均已确认失败，原提交回执保留');
  }
  let record = await claimNativeMediaRecovery(operationId, context);
  const provider = useAppStore.getState().config.providers.apimart;
  const baseUrl = provider?.baseUrl?.trim() || APIMART_BASE_URL;
  const controller = new AbortController(), abort = () => controller.abort();
  externalSignal?.addEventListener('abort', abort, { once: true }); if (externalSignal?.aborted) controller.abort();
  const assertCurrent = () => { controller.signal.throwIfAborted(); if (!isProjectExpectedContextCurrent(context, useAppStore.getState(), { checkCanvasRevision: false })) throw new Error('原画布已切换，候选和原回执保留'); };
  const unsubscribe = useAppStore.subscribe(() => { if (!isProjectExpectedContextCurrent(context, useAppStore.getState(), { checkCanvasRevision: false })) controller.abort(); });
  const access = createMediaDownloadAccess('apimart', baseUrl, { type: 'bearer' });
  try {
    for (const taskId of record.apimartImageBatch!.tasks.map((task) => task.taskId)) {
      assertCurrent();
      const task = record.apimartImageBatch!.tasks.find((item) => item.taskId === taskId)!;
      if (task.state === 'failed') continue;
      if (task.state === 'completed') {
        try { for (const file of task.results!) await readNativeMediaLocalResult(record.canvasId, file); continue; }
        catch { assertCurrent(); /* 本机丢失时只重新查询原task；回取的完整字节集合必须与原本机回执相同。 */ }
      }
      try {
        if (!provider?.apiKey || normalizeNativeMediaProviderBase(baseUrl) !== record.providerBase
          || await sha256BytesHex(new TextEncoder().encode(APIMART_IMAGE_BATCH_PROTOCOL)) !== record.protocolDigest) throw new Error('原APIMart连接或图片批次协议已变化，尚未保存的候选需恢复原连接后继续查询；不会重新生成');
        const urls = await pollTask<ApimartTaskResult<{ images?: Array<{ url?: string | string[] }> }>, string[]>({
          fetchState: (signal) => fetchApimartTask(provider.apiKey!, baseUrl, taskId, signal, true),
          isComplete: (result) => {
            if (result.status !== 'completed') return null;
            const values = extractApimartImageUrls(result.result);
            if (!values.length || values.length > MAX_NATIVE_IMAGE_BATCH_RESULTS) throw new Error('原图片任务候选数量异常，未截断交付');
            return values;
          }, isFailed: (result) => ['failed', 'cancelled', 'error'].includes(result.status ?? '') ? 'APIMart已确认原图片任务失败' : null,
          interval: 2000, maxDuration: VIDEO_POLL_MAX_DURATION_MS, signal: controller.signal, onFetchError: 'throw',
        });
        if (nativeImageBatchResults(record).length - (task.results?.length ?? 0) + urls.length > MAX_NATIVE_IMAGE_BATCH_RESULTS) throw new Error('原批次候选超过安全上限，全部taskID保留，未截断交付');
        const files: NativeMediaLocalResult[] = [];
        for (const [ordinal, url] of urls.entries()) {
          assertCurrent(); if (!await isNativeMediaLeaseCurrent(record)) throw new Error('图片批次已由另一窗口接管，原回执保留');
          const saved = await persistMediaUrlToProjectData(url, record.canvasId, 'ai-image', `原批次 ${ordinal + 1}`,
            { signal: controller.signal, assertCurrent, mediaDownloadAccess: access });
          assertCurrent(); if (!saved.filePath) throw new Error('候选未完整保存，原task可继续查询');
          files.push(await captureNativeMediaLocalResult(record.canvasId, saved.filePath));
        }
        if (task.state === 'completed') {
          const signature = (values: readonly NativeMediaLocalResult[]) => values.map((file) => `${file.sha256}:${file.bytes}`).sort().join('|');
          if (signature(files) !== signature(task.results!)) throw new Error('平台原候选集合已变化，未替换既有本机结果');
          for (const original of task.results!) await readNativeMediaLocalResult(record.canvasId, original);
        } else record = await retainNativeImageBatchTask(record, taskId, { results: files });
      } catch (error) {
        if (error instanceof PollTaskFailedError && task.state !== 'completed') {
          record = await retainNativeImageBatchTask(record, taskId, { failed: true }); continue;
        }
        throw error;
      }
    }
    assertCurrent();
    if (!record.apimartImageBatch || !nativeImageBatchSettled(record.apimartImageBatch)) throw new Error('原图片批次尚未全部结算，继续查询原任务即可');
    const files = nativeImageBatchResults(record);
    if (!files.length) throw new Error('原图片任务均已确认失败，原回执保留');
    if (record.origin?.deliveryMode === 'chat') {
      const { commitNativeMediaMessageDelivery } = await import('./nativeMediaDelivery');
      await commitNativeMediaMessageDelivery(record, files[0].relativePath, { signal: controller.signal });
    } else await useAppStore.getState().commitNativeMediaResult(record, files[0].relativePath, context, controller.signal);
    const { projectNativeMediaMessages } = await import('./nativeMediaMessages');
    await projectNativeMediaMessages().catch(() => {});
  } finally { unsubscribe(); externalSignal?.removeEventListener('abort', abort); controller.abort(); }
}

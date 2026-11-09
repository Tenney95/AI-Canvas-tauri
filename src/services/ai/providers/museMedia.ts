/** Muse 的媒体执行器：先留存本机任务身份，上传后复核，再单次发送。 */
import type { AIImageGenParams, AIVideoGenParams, MediaTaskReceipt } from '../../../types/aiTypes';
import type { MediaProviderAdapter } from '../mediaProviderRegistry';
import { useAppStore } from '../../../store/useAppStore';
import { MUSE_BASE_URL, MUSE_IMAGE_MODEL, MUSE_VIDEO_MODEL } from '../museModels';
import { resolveImageDataUrlArray, loadImage } from '../imageUtils';
import { museImagePrompt, museVideoPrompt } from './musePrompt';
import { museInvoke, assertMuseTaskId, queryMuseTask, type MuseMediaKind } from '../../museService';
import { registerCanvasDerivation, isCanvasDerivationFresh, completeCanvasDerivation } from '../../canvasDerivationGuard';
import { isNativeWorkflowExecution, nativeWorkflowDigest } from '../../nativeWorkflowExecution';
import { savePendingTask, updatePendingTask, getPendingTasksForProject, pauseMediaTask, removeFailedMediaTask,
  registerNodePolling, cleanupNodePolling } from '../../pollManager';
import { PollTaskFailedError } from '../../pollTask';

export const museProtocolMaterial = (kind: MuseMediaKind) => ['muse-webview-v1', kind, kind === 'image' ? MUSE_IMAGE_MODEL : MUSE_VIDEO_MODEL];

async function executeMuse(params: AIImageGenParams | AIVideoGenParams, kind: MuseMediaKind, prompt: string,
  imageUrls: string[], externalSignal?: AbortSignal, beforeSubmit?: () => void | Promise<void>): Promise<{ url: string; taskReceipt?: MediaTaskReceipt }> {
  const modelId = params.model.replace(/^muse\//, '');
  if (modelId !== (kind === 'image' ? MUSE_IMAGE_MODEL : MUSE_VIDEO_MODEL)) throw new Error('Muse 模型与请求类型不匹配');
  const state = useAppStore.getState(), projectId = state.currentProjectId, nodeId = params.nodeId;
  const native = isNativeWorkflowExecution(beforeSubmit);
  if (!native && projectId && nodeId && getPendingTasksForProject(projectId).some((task) => task.nodeId === nodeId)) {
    throw new Error('此节点仍有未交付的媒体任务，请先继续查询原任务');
  }
  const controller = new AbortController();
  const guard = !native && nodeId ? registerCanvasDerivation(state, nodeId) : null;
  const nodeSignal = !native && nodeId ? registerNodePolling(nodeId, externalSignal) : externalSignal;
  const abort = () => controller.abort();
  nodeSignal?.addEventListener('abort', abort, { once: true }); if (nodeSignal?.aborted) abort();
  const fresh = () => {
    controller.signal.throwIfAborted();
    if (useAppStore.getState().currentProjectId !== projectId || !native && nodeId && (!guard || !isCanvasDerivationFresh(guard, useAppStore.getState()))) {
      throw new Error('原画布或输入已变化，Muse 任务保留，未继续发送');
    }
  };
  const unsubscribe = useAppStore.subscribe(() => { try { fresh(); } catch { controller.abort(); } });
  const signal = controller.signal;
  let taskId: string | undefined, receipt: MediaTaskReceipt | undefined;
  let images: string[] = [];
  const cancelPrepared = async () => { if (taskId) await museInvoke('muse_cancel_prepared', { taskId }).catch(() => {}); };
  const cancelOnAbort = () => { void cancelPrepared(); };
  signal.addEventListener('abort', cancelOnAbort);
  const submit = async (received?: (id: string) => Promise<void>) => {
    fresh(); await beforeSubmit?.(); fresh();
    const prepared = await museInvoke<{ taskId: string }>('muse_prepare', { kind });
    taskId = prepared.taskId; assertMuseTaskId(taskId);
    if (received) await received(taskId);
    else if (nodeId && projectId) receipt = savePendingTask({ nodeId, projectId, nodeType: kind === 'image' ? 'ai-image' : 'ai-video',
      provider: 'muse', providerConfigId: 'muse', taskType: 'muse', taskId, submitted: false });
    fresh();
    await museInvoke('muse_submit', { taskId, prompt, images });
    await beforeSubmit?.(); fresh();
    await museInvoke('muse_send', { taskId });
    if (receipt) receipt = updatePendingTask(nodeId!, { submitted: true }, taskId, receipt.attemptId) ?? receipt;
    return { taskId };
  };
  try {
    fresh();
    images = await resolveImageDataUrlArray(imageUrls, signal, { maxImages: 4, maxImageBytes: 8 * 1024 * 1024, maxTotalBytes: 24 * 1024 * 1024 });
    fresh();
    if (native) {
      const { submitNativeWorkflowTask } = await import('../../nativeWorkflowTasks');
      return await submitNativeWorkflowTask({ nodeId, signal, beforeSubmit, count: 1,
        descriptor: { adapter: 'muse-webview', connectionId: 'muse', providerBase: MUSE_BASE_URL, category: kind,
          modelId, digest: await nativeWorkflowDigest(museProtocolMaterial(kind)) },
        requestMaterial: { modelId, kind, prompt, images }, submit: async (_index, _signal, received) => submit(received) });
    }
    await submit();
    const url = await queryMuseTask(taskId!, kind, signal);
    if (receipt) receipt = updatePendingTask(nodeId!, { submitted: true, mediaSubmissionUncertain: false,
      mediaRecoveryState: 'delivery_pending' }, taskId, receipt.attemptId) ?? receipt;
    fresh();
    return { url, ...(receipt ? { taskReceipt: receipt } : {}) };
  } catch (error) {
    if (error instanceof PollTaskFailedError && receipt) removeFailedMediaTask(receipt);
    else if (receipt) throw pauseMediaTask(receipt, error) ?? error;
    throw error;
  } finally {
    // 仅撤销尚未发送的任务；已发送任务仍可按原 ID 取回，绝不重复点击。
    await cancelPrepared(); signal.removeEventListener('abort', cancelOnAbort);
    unsubscribe(); nodeSignal?.removeEventListener('abort', abort);
    if (guard) completeCanvasDerivation(guard);
    if (!native && nodeId) cleanupNodePolling(nodeId, nodeSignal);
  }
}

export const museMediaProviderAdapter: MediaProviderAdapter = {
  providerId: 'muse', capabilities: ['image', 'video'],
  generateImage: async ({ params, prompt, imageUrls, requestedCount, signal, beforeSubmit }) => {
    if (requestedCount !== 1) throw new Error('Muse 每次仅生成一张图片，请将数量设为 1');
    const result = await executeMuse(params, 'image', museImagePrompt(prompt, params.aspectRatio ?? '1:1', imageUrls.length), imageUrls, signal, beforeSubmit);
    let image: HTMLImageElement;
    try { image = await loadImage(result.url); }
    catch (error) { throw result.taskReceipt ? pauseMediaTask(result.taskReceipt, error, 'delivery_pending') ?? error : error; }
    return { requestedCount: 1, failedCount: 0, taskReceipt: result.taskReceipt,
      results: [{ ...result, width: image.naturalWidth, height: image.naturalHeight }] };
  },
  generateVideo: async ({ params, resolveReferenceInput, signal, beforeSubmit }) => {
    const input = await resolveReferenceInput();
    const references = input.references ?? input.imageUrls.map((url) => ({ kind: 'image' as const, role: 'reference' as const, origin: 'connection' as const, url }));
    if (input.videoUrls.length || input.audioUrls.length) throw new Error('Muse 不支持视频或音频参考');
    const request = museVideoPrompt(input.prompt, params.seedanceRatio ?? '16:9', params.seedanceDuration ?? 5, references);
    return executeMuse(params, 'video', request.prompt, request.images, signal, beforeSubmit);
  },
};

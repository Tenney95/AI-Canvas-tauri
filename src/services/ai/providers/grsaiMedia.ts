/** GRSAI H3 复用声明式提交、轮询与恢复；生成提交不重试。 */
import { GRSAI_BASE_URL } from '../../../constants/api';
import { useAppStore } from '../../../store/useAppStore';
import { captureLegacyCanvasContext } from '../../projectExecutionContext';
import { assertNativeVideoSubmissionInput, captureNativeVideoSubmissionBaseline, isNativeVideoSubmissionGuard, type NativeMediaSubmissionPreparation } from '../../nativeVideoSubmission';
import { assertNativeMediaPrepared, prepareNativeMediaTask, recordNativeMediaSubmission, type NativeMediaTaskRecord } from '../../indexedDb/nativeMediaTaskRepository';
import { sha256BytesHex } from '../../mediaDataUrl';
import { projectModelSourceToken } from '../../projectModelComparisonMaterial';
import { captureVideoTaskGeneration, cleanupNodePolling, pauseMediaTask, registerNodePolling, removeFailedMediaTask, savePendingTask, updatePendingTask } from '../../pollManager';
import { PollTaskFailedError } from '../../pollTask';
import { getHttpResponseError } from '../httpUtils';
import type { MediaTaskReceipt } from '../../../types/aiTypes';
import { resolveMediaReferenceUrl } from '../../uploadService';
import { getMediaReferenceUrl } from '../connectedReferenceMedia';
import { getGrsaiVideoCapability, GRSAI_H3_PROTOCOL } from '../grsaiModels';
import { extractModelName } from '../helpers';
import { resolveImageUrlArray } from '../imageUtils';
import { pollResolvedModelProtocol, submitModelProtocol } from '../modelProtocol';
import type { MediaProviderAdapter } from '../mediaProviderRegistry';
import { continueNativeMediaTask, createNativeMediaPendingError } from '../../nativeMediaTaskContinuation';
import { isSafeNativeProtocolTaskId } from '../../nativeProtocolContext';

export const grsaiMediaProviderAdapter: MediaProviderAdapter = {
  providerId: 'grsai', capabilities: ['video'],
  async generateVideo({ params, resolveReferenceInput, signal: externalSignal, beforeSubmit }) {
    const provider = useAppStore.getState().config.providers.grsai;
    if (!provider?.apiKey) throw new Error('请先配置 GRSAI 的 API Key');
    const baseUrl = provider.baseUrl?.trim() || GRSAI_BASE_URL;
    const model = extractModelName(params.model, params.provider);
    const capability = getGrsaiVideoCapability(model, params.seedanceResolution);
    if (!capability) throw new Error(`GRSAI 未适配视频模型 ${model}`);
    const input = await resolveReferenceInput();
    if (!input.prompt.trim()) throw new Error('提示词不能为空');
    if (input.videoUrls.length || input.operation === 'video-to-video') throw new Error('GRSAI H3 不支持参考视频');
    if (input.references?.some((ref) => ref.role === 'first_frame' || ref.role === 'last_frame')) {
      throw new Error('GRSAI H3 不支持专用首尾帧，请将图片设为普通参考图');
    }
    if (input.imageUrls.length > 9 || input.audioUrls.length > 3) throw new Error('GRSAI H3 最多支持 9 张参考图和 3 段参考音频');
    const resolution = params.seedanceResolution?.toLowerCase() ?? capability.defaultResolution!;
    if (!capability.resolutions!.includes(resolution)) throw new Error('GRSAI H3 分辨率仅支持 480p / 768p / 1080p');
    const ratio = params.seedanceRatio ?? capability.defaultRatio;
    if (!capability.ratios!.includes(ratio!)) throw new Error('GRSAI H3 比例仅支持 16:9 / 9:16');
    const duration = params.seedanceDuration ?? capability.defaultDuration!;
    if (!Number.isInteger(duration) || duration < 1 || duration > capability.maxDuration!) {
      throw new Error(`GRSAI H3 ${resolution} 时长仅支持 1–${capability.maxDuration} 秒`);
    }
    const nodeSignal = params.nodeId ? registerNodePolling(params.nodeId) : undefined;
    const projectId = useAppStore.getState().currentProjectId;
    const videoGeneration = captureVideoTaskGeneration(params.nodeId);
    let receipt: MediaTaskReceipt | undefined;
    let requestSent = false;
    let rejected = false;
    let nativeTask: NativeMediaTaskRecord | undefined;
    let nativePreparation: NativeMediaSubmissionPreparation | undefined;
    let nativeRemoteId: string | undefined;
    const nativeContext = captureLegacyCanvasContext(useAppStore.getState());
    const signal = nodeSignal && externalSignal ? AbortSignal.any([nodeSignal, externalSignal]) : nodeSignal ?? externalSignal;
    try {
      signal?.throwIfAborted();
      const imageReferences = input.references?.filter((ref) => ref.kind === 'image');
      const audioReferences = input.references?.filter((ref) => ref.kind === 'audio');
      const images = imageReferences?.length ? imageReferences.map(getMediaReferenceUrl) : input.imageUrls;
      const audios = audioReferences?.length ? audioReferences.map(getMediaReferenceUrl) : input.audioUrls;
      if (useAppStore.getState().projectExecutionContext !== undefined && !nativeContext) throw new Error('当前画布尚未就绪，未提交视频任务');
      if (nativeContext?.modelGeneration === 1 || isNativeVideoSubmissionGuard(beforeSubmit)) {
        await beforeSubmit?.();
        if (nativeContext?.modelGeneration !== 1) throw new Error('原生视频画布已切换，未提交请求');
        if (!isNativeVideoSubmissionGuard(beforeSubmit) || !params.nodeId) throw new Error('请从原画布视频节点发起任务，无法验证输入时不提交');
      }
      const imageUrls = await resolveImageUrlArray(images, 'grsai', signal);
      const audioUrls: string[] = [];
      for (const url of audios) audioUrls.push(await resolveMediaReferenceUrl(url, { provider: 'grsai', kind: 'audio', signal }));
      const variables = { model, prompt: input.prompt, resolution, duration, aspectRatio: ratio === '9:16' ? 'portrait' : 'landscape', imageUrls, audioUrls };
      if (nativeContext?.modelGeneration === 1 || isNativeVideoSubmissionGuard(beforeSubmit)) {
        await beforeSubmit?.();
        if (nativeContext?.modelGeneration !== 1) throw new Error('原生视频画布已切换，未提交请求');
        nativePreparation = await useAppStore.getState().beginNativeMediaSubmissionPreparation(nativeContext);
        signal?.throwIfAborted();
        const baseline = await captureNativeVideoSubmissionBaseline(nativeContext, params.nodeId!, undefined, 'media-input-v3', { preparedReferences: true, preparation: nativePreparation });
        const protocolDigest = await sha256BytesHex(new TextEncoder().encode(projectModelSourceToken(GRSAI_H3_PROTOCOL)));
        nativeTask = await prepareNativeMediaTask({ context: nativeContext, operationId: crypto.randomUUID(), nodeId: params.nodeId!,
          inputFingerprint: baseline.inputFingerprint, sourceCanvasRevision: baseline.canvasRevision, fingerprintScheme: 'media-input-v3',
          modelRef: `grsai/${model}`, protocolDigest, requestFingerprint: await sha256BytesHex(new TextEncoder().encode(projectModelSourceToken(variables))),
          recovery: { kind: 'builtin-video', modelId: model, digest: protocolDigest },
          providerConfigId: 'grsai', providerBase: baseUrl, category: 'video' });
      }
      signal?.throwIfAborted();
      if (beforeSubmit) await beforeSubmit();
      signal?.throwIfAborted();
      if (!nativeTask && params.nodeId && projectId) receipt = savePendingTask({ nodeId: params.nodeId, projectId, nodeType: 'ai-video',
        provider: 'grsai', providerConfigId: 'grsai', taskId: '', taskType: 'custom-protocol', videoGeneration, submitted: false });
      if (nativeTask) {
        if (!nativeContext) throw new Error('原媒体画布已变化');
        await assertNativeVideoSubmissionInput(nativeTask, nativeContext);
        await assertNativeMediaPrepared(nativeTask, { preparation: nativePreparation });
        await beforeSubmit?.();
        await assertNativeVideoSubmissionInput(nativeTask, nativeContext);
        signal?.throwIfAborted();
      }
      nativePreparation?.assertCurrent(); requestSent = true; nativePreparation?.release();
      const submitted = await submitModelProtocol({ apiKey: provider.apiKey, baseUrl, protocol: GRSAI_H3_PROTOCOL, signal,
        variables,
        validateResponse: (payload) => {
          const result = payload as { status?: string; error?: string } | null;
          if (result?.status === 'failed' || result?.status === 'violation') {
            rejected = true;
            throw new Error(result.error || 'GRSAI H3 提交失败');
          }
        },
      });
      if (!submitted.taskId || !submitted.poll) throw new Error('GRSAI H3 未返回任务 ID');
      if (nativeTask) {
        if (!isSafeNativeProtocolTaskId(submitted.taskId, [provider.apiKey])) throw new Error('原视频任务身份包含不安全字段，原提交已保留供核对');
        nativeRemoteId = submitted.taskId;
        await recordNativeMediaSubmission(nativeTask.operationId, nativeTask.lease, { taskId: nativeRemoteId });
        return await continueNativeMediaTask(nativeTask, signal);
      }
      if (params.nodeId) receipt = updatePendingTask(params.nodeId, { taskId: submitted.taskId,
        protocolPoll: submitted.poll, submitted: true }, receipt?.taskId, receipt?.attemptId) ?? receipt;
      const result = await pollResolvedModelProtocol(submitted.poll, provider.apiKey, signal, baseUrl);
      const url = result.urls?.[0];
      if (!url) throw new Error('GRSAI H3 完成但没有返回视频');
      if (receipt) receipt = updatePendingTask(receipt.nodeId, { mediaRecoveryState: 'delivery_pending' }, receipt.taskId, receipt.attemptId) ?? receipt;
      return { url, ...(receipt ? { taskReceipt: receipt } : {}) };
    } catch (error) {
      if (error instanceof Error && ['NativeMediaTaskPending', 'NativeMediaTaskDelivered', 'NativeMediaTaskFailed'].includes(error.name)) throw error;
      const certainHttpRejection = !receipt?.taskId && getHttpResponseError(error)?.definitiveFailure === true;
      if (nativeTask) {
        await recordNativeMediaSubmission(nativeTask.operationId, nativeTask.lease,
          nativeRemoteId ? { taskId: nativeRemoteId } : !requestSent || rejected || certainHttpRejection ? { notStarted: true } : { unknown: true }).catch(() => undefined);
        if (requestSent && !rejected && !certainHttpRejection) throw createNativeMediaPendingError(nativeTask, error);
      }
      if (receipt) {
        if (rejected || !requestSent || certainHttpRejection || error instanceof PollTaskFailedError) {
          removeFailedMediaTask(receipt);
        } else {
          const paused = pauseMediaTask(receipt, error, receipt.taskId ? undefined : 'submit_unknown');
          if (paused) throw paused;
        }
      }
      throw error;
    } finally {
      nativePreparation?.release();
      if (params.nodeId) cleanupNodePolling(params.nodeId, nodeSignal);
    }
  },
};

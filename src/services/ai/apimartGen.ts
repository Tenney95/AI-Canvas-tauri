/**
 * ai/apimartGen — APIMart 图片/视频生成 + 通用异步任务执行器
 */
import { useAppStore } from '../../store/useAppStore';
import { isCharacterImageTaskContext } from '../characterImageTaskContext';
import { captureLegacyCanvasContext } from '../projectExecutionContext';
import { assertNativeMediaPrepared, prepareNativeMediaTask, recordNativeMediaSubmission, type NativeMediaTaskRecord } from '../indexedDb/nativeMediaTaskRepository';
import { assertNativeVideoSubmissionInput, captureNativeVideoSubmissionBaseline, isNativeVideoSubmissionGuard, type NativeMediaSubmissionPreparation } from '../nativeVideoSubmission';
import { PollTaskFailedError } from '../pollTask';
import { savePendingTask, updatePendingTask, removePendingTask, removeFailedMediaTask, registerNodePolling, cleanupNodePolling, pauseMediaTask, VIDEO_POLL_MAX_DURATION_MS } from '../pollManager';
import { parseGeneralImageResponses, parseMultiPathResponse } from './helpers';
import type { BatchImageResult, MediaDownloadAccess, MediaTaskReceipt } from '../../types/aiTypes';
import {
  buildApimartSeedanceRequest,
  type ApimartSeedanceRequestParams,
} from './apimartVideoModels';
import { buildImageCapabilityRequest, getImageCapability } from './mediaModelCapabilities';
import { corsSafeFetch } from './httpTransport';
import { mapImageParameters } from './imageParameterMappings';
import { runBatchTasks } from './batchUtils';
import { resolveConfiguredImageBackground } from './modelCapabilityValidation';
import { redactModelProtocolError, redactModelProtocolErrorText, throwIfDefinitiveModelResponseFailure } from './modelProtocolHttp';
import { classifyHttpResponseFailure, getHttpResponseError, HttpResponseError } from './httpUtils';
import { createMediaDownloadAccess } from './mediaDownloadAccess';
import { continueNativeMediaTask, createNativeMediaPendingError } from '../nativeMediaTaskContinuation';
import { nativeBuiltinVideoProtocolDigest } from '../nativeBuiltinVideoProtocol';
import { sha256BytesHex } from '../mediaDataUrl';
import { projectModelSourceToken } from '../projectModelComparisonMaterial';
import { isSafeNativeProtocolTaskId } from '../nativeProtocolContext';
import { queryApimartImageResult } from './apimartImageResult';
import { queryApimartVideoResult } from './apimartVideoResult';
import { queryCompatibleMediaTask, readAsyncMediaResultUrls } from './asyncMediaResult';

export { fetchApimartTask, type ApimartTaskResult } from './apimartImageResult';

function discardFailedTask(receipt: MediaTaskReceipt | undefined): void {
  if (!receipt) return;
  removeFailedMediaTask(receipt);
}

/** 保留提交错误分类；脱敏必须早于已有的正文截断。 */
async function throwSubmitResponseError(response: Response, label: string, apiKey: string): Promise<never> {
  const body = await response.text().catch(() => '');
  let payload: unknown;
  try { payload = JSON.parse(body); } catch { /* 非 JSON 错误仍保留 HTTP 分类。 */ }
  throw new HttpResponseError(response.status,
    `${label} (${response.status}): ${redactModelProtocolErrorText(body, apiKey).slice(0, 200)}`,
    classifyHttpResponseFailure(response.status, payload));
}

/** APIMart 的业务拒绝只在没有可用任务 ID 时判定；网关/服务端错误仍可能已受理。 */
function throwApimartSubmissionFailure(payload: unknown, apiKey: string, label: string): void {
  const record = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? payload as Record<string, unknown> : undefined;
  if (typeof record?.code === 'number' && Number.isInteger(record.code)
    && record.code >= 400 && record.code < 500 && record.code !== 408) {
    const detail = typeof record.message === 'string' ? record.message : typeof record.msg === 'string' ? record.msg : '';
    throw new HttpResponseError(200,
      redactModelProtocolErrorText(detail.trim() || `${label}（业务码 ${record.code}）`, apiKey), true);
  }
  throwIfDefinitiveModelResponseFailure(payload, 200, undefined, apiKey);
}
/**
 * 通用异步任务执行器 — 提交 + 轮询，兼容支持 task_id 模式的 OpenAI 兼容接口
 */
export async function executeGeneralAsyncTask(
  apiKey: string,
  baseUrl: string,
  modelName: string,
  prompt: string,
  resultField: 'videos' | 'audios' | 'images',
  providerConfigId: string,
  nodeId?: string,
  externalSignal?: AbortSignal,
  requestBody?: Record<string, unknown>,
  beforeSubmit?: () => void | Promise<void>,
  modelRef?: string,
): Promise<{ url: string; taskReceipt?: MediaTaskReceipt; mediaDownloadAccess: MediaDownloadAccess }> {
  if (useAppStore.getState().projectExecutionContext?.modelGeneration === 1 || isNativeVideoSubmissionGuard(beforeSubmit) || isCharacterImageTaskContext(beforeSubmit)) {
    const { executeNativeGeneralAsyncTask } = await import('../nativeGeneralAsyncTask');
    return executeNativeGeneralAsyncTask({ apiKey, baseUrl, modelName, prompt, resultField, providerConfigId, nodeId,
      signal: externalSignal, requestBody, beforeSubmit, modelRef });
  }
  const mediaDownloadAccess = createMediaDownloadAccess(providerConfigId, baseUrl, { type: 'bearer' });
  let receipt: MediaTaskReceipt | undefined;
  let requestSent = false;
  const nodeSignal = nodeId ? registerNodePolling(nodeId, externalSignal) : undefined;
  const signal = nodeSignal ?? externalSignal;
  try {
    // 预存待续任务（在 fetch 之前），确保关窗重启后能恢复
    if (nodeId) {
      const projectId = useAppStore.getState().currentProjectId;
      if (projectId) {
        receipt = savePendingTask({
          nodeId,
          projectId,
          nodeType: resultField === 'videos' ? 'ai-video' : resultField === 'audios' ? 'ai-audio' : 'ai-image',
          provider: 'general',
          providerConfigId,
          mediaDownloadAccess,
          taskId: '',
          taskType: 'general',
          submitted: false,
        });
      }
    }

    const resource = resultField === 'audios' ? 'audio' : resultField;
    const apiUrl = `${baseUrl.replace(/\/+$/, '')}/${resource}/generations`;
    signal?.throwIfAborted();
    requestSent = true;
    const submitResp = await corsSafeFetch(apiUrl, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody ?? { model: modelName, prompt, n: 1 }),
      signal,
    });

    if (!submitResp.ok) {
      await throwSubmitResponseError(submitResp, '提交失败', apiKey);
    }

    const submitResult = await submitResp.json() as Record<string, unknown>;
    const taskId = (submitResult.data as Array<{ task_id: string }>)?.[0]?.task_id
      || (submitResult.task_id as string);

    // 无 task_id 时尝试直接从响应中解析结果（同步完成，无需轮询）
    if (!taskId) {
      const url = resultField === 'audios'
        ? readAsyncMediaResultUrls(submitResult, resultField, true, true)[0]
        : parseMultiPathResponse(submitResult, resultField)
          ?? (resultField === 'images' ? parseGeneralImageResponses(submitResult)[0] : undefined);
      if (url) {
        if (receipt) removePendingTask(receipt.nodeId, receipt.taskId, receipt.attemptId);
        return { url, mediaDownloadAccess };
      }
      // 尝试标准 OpenAI 图片格式
      const dataArr = submitResult.data as Array<{ url: string }> | undefined;
      if (dataArr?.[0]?.url) {
        if (receipt) removePendingTask(receipt.nodeId, receipt.taskId, receipt.attemptId);
        return { url: dataArr[0].url, mediaDownloadAccess };
      }
      throwIfDefinitiveModelResponseFailure(submitResult, submitResp.status, undefined, apiKey);
      throw new Error('响应格式异常：未返回 task_id 或结果 URL');
    }

    // 回填 taskId，标记为已提交
    if (nodeId) {
      receipt = updatePendingTask(nodeId, { taskId, submitted: true }, receipt?.taskId, receipt?.attemptId) ?? receipt;
    }

    const [url] = await queryCompatibleMediaTask(apiKey, baseUrl, taskId, resultField, {
      maxDuration: VIDEO_POLL_MAX_DURATION_MS, signal, timeoutAsPause: resultField !== 'images', allowPartial: true,
      firstOnly: resultField === 'audios',
    });
    if (receipt) receipt = updatePendingTask(receipt.nodeId, { mediaRecoveryState: 'delivery_pending' }, receipt.taskId, receipt.attemptId) ?? receipt;
    return { url, mediaDownloadAccess, ...(receipt ? { taskReceipt: receipt } : {}) };
  } catch (unsafeError) {
    const error = redactModelProtocolError(unsafeError, apiKey);
    const rejected = !receipt?.taskId && getHttpResponseError(error)?.definitiveFailure === true;
    if (rejected || !requestSent || error instanceof PollTaskFailedError) discardFailedTask(receipt);
    else if (receipt) {
      const paused = pauseMediaTask(receipt, error, receipt.taskId ? undefined : 'submit_unknown');
      if (paused) throw paused;
    }
    throw error;
  } finally {
    if (nodeId) cleanupNodePolling(nodeId, nodeSignal);
  }
}
export async function generateApimartImagesBatch(
  apiKey: string,
  baseUrl: string,
  model: string,
  prompt: string,
  imageSize: string,
  aspectRatio: string,
  dimensions: { width: number; height: number },
  imageUrls: string[] = [],
  count = 1,
  nodeId?: string,
  externalSignal?: AbortSignal,
  imageQuality?: string,
  imageBackground?: string,
  beforeSubmit?: () => void | Promise<void>,
): Promise<BatchImageResult> {
  // 能力表驱动：命中 APIMart 生图能力表时，按模型约束分辨率 / 批量数量 / 参考图，
  // 并复用能力表换算出的结果回填尺寸；未命中则回退通用提交逻辑（兼容旧模型）。
  const requestedBatchCount = Math.max(1, Math.floor(count));
  const capabilityModel = model.startsWith('apimart/') ? model : `apimart/${model}`;
  const capability = getImageCapability(capabilityModel);
  imageBackground = resolveConfiguredImageBackground(capability, imageBackground);
  const capabilityRequest = buildImageCapabilityRequest(capabilityModel, prompt, {
    resolution: imageSize,
    imageQuality,
    imageBackground,
    ratio: aspectRatio,
    count: requestedBatchCount,
    imageUrls,
  });
  const supportsNativeBatch = capability?.supportsBatch !== false;
  const requestedCount = capability && !supportsNativeBatch
    ? requestedBatchCount
    : (capabilityRequest?.requestedCount ?? requestedBatchCount);
  const effectiveDimensions = capabilityRequest?.dimensions ?? dimensions;
  const mediaDownloadAccess = createMediaDownloadAccess('apimart', baseUrl, { type: 'bearer' });
  let receipt: MediaTaskReceipt | undefined;
  let requestSent = false;
  let uncertainSubmission = false;
  let allTasksFailed = false;
  const nodeSignal = nodeId ? registerNodePolling(nodeId, externalSignal) : undefined;
  const signal = nodeSignal ?? externalSignal;
  // 原生批量模型一次提交 n 张；不支持 n 的模型拆成多次 n=1 提交。
  const nativeSubmitBody: Record<string, unknown> = capabilityRequest?.body ?? mapImageParameters(
    'apimart',
    model,
    {
      model,
      prompt,
      imageSize,
      imageQuality,
      imageBackground,
      aspectRatio,
      batchCount: requestedCount,
      referenceImageUrls: imageUrls,
    },
  );
  const submitBodies = supportsNativeBatch
    ? [nativeSubmitBody]
    : Array.from({ length: requestedCount }, () => ({ ...nativeSubmitBody, n: 1 }));
  try {
    if (isNativeVideoSubmissionGuard(beforeSubmit) || isCharacterImageTaskContext(beforeSubmit) || captureLegacyCanvasContext(useAppStore.getState())?.modelGeneration === 1) {
      const { submitNativeApimartImageBatch } = await import('../nativeApimartImageSubmission');
      return await submitNativeApimartImageBatch({ baseUrl, model, requestedCount, nodeId, imageUrls, bodies: submitBodies,
        requestHeaders: capability?.requestHeaders, signal, beforeSubmit,
        submit: async (body, taskSignal, submissionId) => {
          const response = await corsSafeFetch(`${baseUrl}/images/generations`, { method: 'POST', signal: taskSignal,
            headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', ...capability?.requestHeaders,
              ...(capability?.supportsIdempotency ? { 'Idempotency-Key': submissionId } : {}) }, body: JSON.stringify(body) });
          if (!response.ok) await throwSubmitResponseError(response, 'APIMart 生成提交失败', apiKey);
          const payload = await response.json() as { task_id?: string; data?: Array<{ task_id?: string }> | { task_id?: string } };
          const ids = Array.isArray(payload.data) ? payload.data.flatMap((item) => item.task_id ? [item.task_id] : [])
            : payload.data?.task_id ? [payload.data.task_id] : [];
          if (payload.task_id) ids.push(payload.task_id);
          if (!ids.length) { throwApimartSubmissionFailure(payload, apiKey, 'APIMart 生成提交失败'); throw new Error('APIMart 未返回原任务 ID'); }
          return ids;
        } });
    }
    // 预存待续任务（在 fetch 之前），确保关窗重启后能恢复
    if (nodeId) {
      const projectId = useAppStore.getState().currentProjectId;
      if (projectId) {
        receipt = savePendingTask({
          nodeId,
          projectId,
          nodeType: 'ai-image',
          provider: 'apimart',
          providerConfigId: 'apimart',
          mediaDownloadAccess,
          taskId: '',
          taskType: 'apimart',
          batchCount: requestedCount,
          submitted: false,
        });
      }
    }

    const taskIdsBySubmission: string[][] = [];
    let firstError: unknown;
    const submitted = await runBatchTasks(submitBodies.length, 3, async (index) => {
      let sent = false;
      try {
        signal?.throwIfAborted();
        sent = requestSent = true;
        const submitResp = await corsSafeFetch(`${baseUrl}/images/generations`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            ...capability?.requestHeaders,
            ...(capability?.supportsIdempotency ? { 'Idempotency-Key': crypto.randomUUID() } : {}),
          },
          body: JSON.stringify(submitBodies[index]),
          signal,
        });
        if (!submitResp.ok) {
          await throwSubmitResponseError(submitResp, 'APIMart 生成提交失败', apiKey);
        }
        const submitResult = await submitResp.json() as {
          task_id?: string;
          data?: Array<{ task_id?: string }> | { task_id?: string };
        };
        const dataTaskIds = Array.isArray(submitResult.data)
          ? submitResult.data.flatMap((item) => item.task_id ? [item.task_id] : [])
          : submitResult.data?.task_id ? [submitResult.data.task_id] : [];
        const taskIds = [...dataTaskIds, ...(submitResult.task_id ? [submitResult.task_id] : [])];
        if (taskIds.length === 0) {
          throwApimartSubmissionFailure(submitResult, apiKey, 'APIMart 生成提交失败');
          throw new Error('APIMart 生成提交失败: 未返回 task_id');
        }
        taskIdsBySubmission[index] = taskIds;
        if (nodeId) {
          const persistedTaskIds = taskIdsBySubmission.flatMap((ids) => ids ?? []);
          receipt = updatePendingTask(nodeId, {
            taskId: persistedTaskIds[0],
            taskIds: persistedTaskIds,
            submitted: true,
          }, receipt?.taskId, receipt?.attemptId) ?? receipt;
        }
        return taskIds;
      } catch (unsafeError) {
        const error = redactModelProtocolError(unsafeError, apiKey);
        const rejected = getHttpResponseError(error)?.definitiveFailure === true;
        if (sent && !rejected) uncertainSubmission = true;
        firstError ??= error;
        throw error;
      }
    });
    const taskIds = submitted.results.flat();
    // 其他子提交可能已被上游接受，不能用部分成功掩盖没有拿到 ID 的请求。
    if (uncertainSubmission) {
      if (receipt) updatePendingTask(receipt.nodeId, { mediaSubmissionUncertain: true }, receipt.taskId, receipt.attemptId);
      throw firstError || new Error('部分图片任务提交状态待确认');
    }
    if (taskIds.length === 0) throw firstError || new Error('APIMart 生成提交失败');

    // 单个任务可返回多张图，也可能一次提交返回多个任务；两种形态统一汇总。
    const failedTaskIds = new Set<string>();
    let queryInterrupted = false;
    const queryController = new AbortController();
    const batchQuerySignal = signal ? AbortSignal.any([signal, queryController.signal]) : queryController.signal;
    const completed = await runBatchTasks(taskIds.length, 3, async (index) => {
      try {
        return await queryApimartImageResult(apiKey, baseUrl, taskIds[index], {
          interval: 2000, maxDuration: VIDEO_POLL_MAX_DURATION_MS, signal: batchQuerySignal, timeoutAsPause: false,
        });
      } catch (unsafeError) {
        const error = redactModelProtocolError(unsafeError, apiKey);
        if (error instanceof PollTaskFailedError) failedTaskIds.add(taskIds[index]);
        else {
          queryInterrupted = true;
          queryController.abort(error);
        }
        firstError ??= error;
        throw error;
      }
    });
    // 未完成任务先一起保留，续取时仍查询原批次，避免部分回填后重复创建节点。
    if (queryInterrupted) throw firstError || new Error('图片任务查询已中断');
    const urls = completed.results.flat().slice(0, requestedCount);
    allTasksFailed = failedTaskIds.size === taskIds.length;
    if (urls.length === 0) throw firstError || new Error('APIMart 生成完成但未返回图片');
    if (nodeId && failedTaskIds.size) {
      const remaining = taskIds.filter((taskId) => !failedTaskIds.has(taskId));
      receipt = updatePendingTask(nodeId, { taskId: remaining[0], taskIds: remaining }, receipt?.taskId, receipt?.attemptId) ?? receipt;
    }
    if (receipt) receipt = updatePendingTask(receipt.nodeId, { mediaRecoveryState: 'delivery_pending' }, receipt.taskId, receipt.attemptId) ?? receipt;
    const results = urls.map((url) => ({
      url,
      mediaDownloadAccess,
      width: effectiveDimensions.width,
      height: effectiveDimensions.height,
      ...(receipt ? { taskReceipt: receipt } : {}),
    }));
    return {
      requestedCount,
      mediaDownloadAccess,
      results,
      failedCount: Math.max(0, requestedCount - results.length),
      allTasksSettled: true,
      ...(receipt ? { taskReceipt: receipt } : {}),
    };
  } catch (unsafeError) {
    if (unsafeError instanceof Error && ['NativeMediaTaskPending', 'NativeMediaTaskDelivered'].includes(unsafeError.name)) throw unsafeError;
    const error = redactModelProtocolError(unsafeError, apiKey);
    if (!requestSent || allTasksFailed || (!receipt?.taskId && !uncertainSubmission)) discardFailedTask(receipt);
    else if (receipt) {
      const paused = pauseMediaTask(receipt, error, uncertainSubmission ? 'submit_unknown' : undefined);
      if (paused) throw paused;
    }
    throw error;
  } finally {
    if (nodeId) cleanupNodePolling(nodeId, nodeSignal);
  }
}
/** APIMart 视频生成 — 异步提交 + 轮询 */
export async function generateApimartVideo(
  apiKey: string,
  baseUrl: string,
  model: string,
  prompt: string,
  nodeId?: string,
  params: ApimartSeedanceRequestParams = {},
  externalSignal?: AbortSignal,
  beforeSubmit?: () => void | Promise<void>,
): Promise<{ url: string; taskReceipt?: MediaTaskReceipt; mediaDownloadAccess: MediaDownloadAccess }> {
  const mediaDownloadAccess = createMediaDownloadAccess('apimart', baseUrl, { type: 'bearer' });
  let receipt: MediaTaskReceipt | undefined;
  let requestSent = false;
  let nativeTask: NativeMediaTaskRecord | undefined;
  let nativePreparation: NativeMediaSubmissionPreparation | undefined;
  let nativeRemoteId: string | undefined;
  const nativeContext = captureLegacyCanvasContext(useAppStore.getState());
  const nodeSignal = nodeId ? registerNodePolling(nodeId, externalSignal) : undefined;
  const signal = nodeSignal ?? externalSignal;
  try {
    if (useAppStore.getState().projectExecutionContext !== undefined && !nativeContext) throw new Error('当前画布尚未就绪，未提交视频任务');
    if (nativeContext?.modelGeneration === 1 || isNativeVideoSubmissionGuard(beforeSubmit)) {
      await beforeSubmit?.();
      if (nativeContext?.modelGeneration !== 1) throw new Error('原生视频画布已切换，未提交请求');
      if (!isNativeVideoSubmissionGuard(beforeSubmit)) throw new Error('请从原画布视频节点发起任务，无法验证输入时不提交');
      if (!nodeId) throw new Error('新项目视频任务需要原画布节点，未提交请求');
    } else if (nodeId) {
      const projectId = useAppStore.getState().currentProjectId;
      if (projectId) {
        receipt = savePendingTask({
          nodeId,
          projectId,
          nodeType: 'ai-video',
          provider: 'apimart',
          providerConfigId: 'apimart',
          mediaDownloadAccess,
          taskId: '',
          taskType: 'apimart',
          submitted: false,
        });
      }
    }

    const seedanceRequest = buildApimartSeedanceRequest(model, prompt, params);
    const submitPath = seedanceRequest ? '/videos/generations' : '/images/generations';
    const requestBody = seedanceRequest ?? mapImageParameters('apimart', model, {
      model,
      prompt,
      batchCount: 1,
    });
    if (nativeContext?.modelGeneration === 1 || isNativeVideoSubmissionGuard(beforeSubmit)) {
      await beforeSubmit?.();
      if (nativeContext?.modelGeneration !== 1) throw new Error('原生视频画布已切换，未提交请求');
      nativePreparation = await useAppStore.getState().beginNativeMediaSubmissionPreparation(nativeContext);
      signal?.throwIfAborted();
      const baseline = await captureNativeVideoSubmissionBaseline(nativeContext, nodeId!, undefined, 'media-input-v3', { preparedReferences: true, preparation: nativePreparation });
      const protocolDigest = await nativeBuiltinVideoProtocolDigest('apimart');
      nativeTask = await prepareNativeMediaTask({ context: nativeContext, operationId: crypto.randomUUID(), nodeId: nodeId!,
        inputFingerprint: baseline.inputFingerprint, sourceCanvasRevision: baseline.canvasRevision, fingerprintScheme: 'media-input-v3',
        modelRef: `apimart/${model}`, protocolDigest, requestFingerprint: await sha256BytesHex(new TextEncoder().encode(projectModelSourceToken(requestBody))),
        recovery: { kind: 'builtin-video', modelId: model, digest: protocolDigest }, providerConfigId: 'apimart', providerBase: baseUrl, category: 'video' });
    }

    // 步骤 1: 提交视频生成任务
    signal?.throwIfAborted();
    if (beforeSubmit) await beforeSubmit();
    signal?.throwIfAborted();
    if (nativeTask) {
      if (!nativeContext) throw new Error('原媒体画布已变化');
      await assertNativeVideoSubmissionInput(nativeTask, nativeContext);
      await assertNativeMediaPrepared(nativeTask, { preparation: nativePreparation });
      await beforeSubmit?.();
      await assertNativeVideoSubmissionInput(nativeTask, nativeContext);
      signal?.throwIfAborted();
    }
    nativePreparation?.assertCurrent(); requestSent = true; nativePreparation?.release();
    const submitResp = await corsSafeFetch(`${baseUrl}${submitPath}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
      signal,
    });

    if (!submitResp.ok) {
      await throwSubmitResponseError(submitResp, 'APIMart 视频提交失败', apiKey);
    }

    const submitResult = await submitResp.json() as { code: number; data: Array<{ task_id: string; status: string }> };
    const taskId = submitResult.data?.[0]?.task_id;
    if (!taskId) {
      throwApimartSubmissionFailure(submitResult, apiKey, 'APIMart 视频提交失败');
      throw new Error('APIMart 视频提交失败: 未返回 task_id');
    }

    if (nativeTask) {
      const taskIds = [...new Set(submitResult.data.map((item) => item.task_id))];
      if (!taskIds.length || taskIds.length > 128 || taskIds.some((id) => !isSafeNativeProtocolTaskId(id, [apiKey]))) throw new Error('原视频任务集合包含不安全身份，原提交已保留供核对');
      nativeRemoteId = taskId;
      await recordNativeMediaSubmission(nativeTask.operationId, nativeTask.lease, { taskId, pollContext: { taskIds } });
      return await continueNativeMediaTask(nativeTask, signal);
    }

    // 回填 taskId，标记为已提交
    if (nodeId) {
      receipt = updatePendingTask(nodeId, { taskId, submitted: true }, receipt?.taskId, receipt?.attemptId) ?? receipt;
    }

    // 步骤 2: 限制本地等待时间，不取消上游生成。
    const [url] = await queryApimartVideoResult(apiKey, baseUrl, taskId, {
      maxDuration: VIDEO_POLL_MAX_DURATION_MS,
      signal,
      allowPartial: true,
    });
    if (receipt) receipt = updatePendingTask(receipt.nodeId, { mediaRecoveryState: 'delivery_pending' }, receipt.taskId, receipt.attemptId) ?? receipt;
    return { url, mediaDownloadAccess, ...(receipt ? { taskReceipt: receipt } : {}) };
  } catch (unsafeError) {
    if (unsafeError instanceof Error && ['NativeMediaTaskPending', 'NativeMediaTaskDelivered', 'NativeMediaTaskFailed'].includes(unsafeError.name)) throw unsafeError;
    const error = redactModelProtocolError(unsafeError, apiKey);
    const rejected = !receipt?.taskId && getHttpResponseError(error)?.definitiveFailure === true;
    if (nativeTask) {
      await recordNativeMediaSubmission(nativeTask.operationId, nativeTask.lease,
        nativeRemoteId ? { taskId: nativeRemoteId } : !requestSent || rejected ? { notStarted: true } : { unknown: true }).catch(() => undefined);
      if (requestSent && !rejected) {
        // 原始异常可能回显连接凭据，只把脱敏后的异常保留为 cause。
        throw createNativeMediaPendingError(nativeTask, error);
      }
    }
    if (rejected || !requestSent || error instanceof PollTaskFailedError) discardFailedTask(receipt);
    else if (receipt) {
      const paused = pauseMediaTask(receipt, error, receipt.taskId ? undefined : 'submit_unknown');
      if (paused) throw paused;
    }
    throw error;
  } finally {
    nativePreparation?.release();
    if (nodeId) cleanupNodePolling(nodeId, nodeSignal);
  }
}

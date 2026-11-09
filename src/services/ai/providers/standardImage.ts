/**
 * ai/providers/standardImage — 标准 OpenAI 兼容图片生成
 *
 * 适用于 general 通用模型和任意 OpenAI 兼容 provider。
 * 缺省使用 /images/generations JSON；显式配置后，参考图请求使用 /images/edits multipart。
 */
import { isLocalMediaUrl } from '../../../utils/mediaUrl';
import { parseResponseError, buildAuthHeaders, classifyHttpResponseFailure, getHttpResponseError, HttpResponseError } from '../httpUtils';
import { corsSafeFetch } from '../httpTransport';
import {
  isOpenAIGptImageModel,
  formatImageSizeForModel,
  parseGeneralImageResponses,
} from '../helpers';
import { runBatchTasks } from '../batchUtils';
import { useAppStore } from '../../../store/useAppStore';
import { pollResolvedModelProtocol } from '../modelProtocol';
import { PollTaskFailedError } from '../../pollTask';
import { cleanupNodePolling, pauseMediaTask, registerNodePolling, removeFailedMediaTask, removePendingTask, savePendingTask, updatePendingTask, VIDEO_POLL_MAX_DURATION_MS } from '../../pollManager';
import type { ImageReferenceRequestMode } from '../../../types';
import type { BatchImageResult, ImageGenerationResult, MediaTaskReceipt, ResolvedModelProtocolPoll } from '../../../types/aiTypes';
import { buildStandardImageRequestBody } from '../imageParameterMappings';
import { prepareReferenceImageUpload } from '../referenceImageUpload';
import { redactModelProtocolError, throwIfDefinitiveModelResponseFailure } from '../modelProtocolHttp';
import { sha256BytesHex } from '../../mediaDataUrl';
import { isNativeVideoSubmissionGuard } from '../../nativeVideoSubmission';

export interface StandardImageParams {
  apiKey: string;
  baseUrl: string;
  modelName: string;
  prompt: string;
  dimensions: { width: number; height: number };
  imageQuality?: string;
  imageBackground?: string;
  imageUrls?: string[];
  imageReferenceRequestMode?: ImageReferenceRequestMode;
  /** 仅已确认的 CCC 连接允许按其 Tasks API 解释异步响应。 */
  asyncTaskProvider?: 'cccapi';
  providerConfigId?: string;
  nodeId?: string;
  modelRef?: string;
  beforeSubmit?: () => void | Promise<void>;
}

interface ReferenceImageFile {
  blob: Blob;
  filename: string;
}

const MIME_EXTENSION: Record<string, string> = {
  'image/avif': 'avif',
  'image/gif': 'gif',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

function usesWebViewFetch(url: string): boolean {
  return isLocalMediaUrl(url);
}

async function loadReferenceImage(
  url: string,
  index: number,
  signal?: AbortSignal,
): Promise<ReferenceImageFile> {
  const response = await (usesWebViewFetch(url)
    ? fetch(url, { signal })
    : corsSafeFetch(url, { signal }));
  if (!response.ok) {
    throw new Error(`读取参考图 ${index + 1} 失败 (${response.status})`);
  }
  const sourceBlob = await response.blob();
  if (sourceBlob.size === 0) throw new Error(`参考图 ${index + 1} 内容为空`);
  const blobMime = sourceBlob.type.split(';')[0].trim().toLowerCase();
  const responseMime = response.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase();
  const mimeType = blobMime || responseMime || 'application/octet-stream';
  const blob = sourceBlob.type === mimeType
    ? sourceBlob
    : new Blob([sourceBlob], { type: mimeType });
  return {
    blob,
    filename: `reference-${index + 1}.${MIME_EXTENSION[mimeType] || 'bin'}`,
  };
}

async function buildImageEditsBody(
  params: Pick<StandardImageParams, 'modelName' | 'prompt' | 'imageUrls' | 'imageQuality' | 'imageBackground'>,
  count: number,
  size: string,
  signal?: AbortSignal,
): Promise<FormData> {
  const imageUrls = params.imageUrls ?? [];
  const formData = new FormData();
  formData.append('model', params.modelName);
  formData.append('prompt', params.prompt);
  formData.append('n', String(count));
  formData.append('size', size);
  if (params.imageQuality) formData.append('quality', params.imageQuality);
  if (params.imageBackground) formData.append('background', params.imageBackground);
  if (params.imageBackground === 'transparent') formData.append('output_format', 'png');
  // 大参考图逐张做无损准备，保留原始尺寸与格式。
  for (const [index, url] of imageUrls.entries()) {
    signal?.throwIfAborted();
    const file = await loadReferenceImage(url, index, signal);
    const blob = await prepareReferenceImageUpload(file.blob, signal);
    const extension = MIME_EXTENSION[blob.type.split(';')[0].trim().toLowerCase()] || 'bin';
    const filename = blob === file.blob ? file.filename : `reference-${index + 1}.${extension}`;
    formData.append('image[]', blob, filename);
  }
  return formData;
}

function buildMultipartAuthHeaders(apiKey: string): Record<string, string> {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

export async function generateImageStandard(
  params: StandardImageParams,
  signal?: AbortSignal,
): Promise<{ url: string; width: number; height: number }> {
  const batch = await generateImageStandardBatch(params, 1, signal);
  const result = batch.results[0];
  if (!result) throw new Error('图片生成返回结果为空');
  return result;
}

async function requestStandardImages(
  params: StandardImageParams,
  count: number,
  signal?: AbortSignal,
  beforeSend?: () => void | Promise<void>,
  preparedMultipart?: FormData,
): Promise<Response> {
  const { apiKey, baseUrl, modelName, prompt, dimensions, imageUrls = [] } = params;

  const sizeStr = formatImageSizeForModel(modelName, dimensions);
  if (imageUrls.length > 0 && params.imageReferenceRequestMode === 'edits-multipart') {
    const apiUrl = baseUrl.replace(/\/+$/, '') + '/images/edits';
    const body = preparedMultipart ?? await buildImageEditsBody(params, count, sizeStr, signal);
    const files = body.getAll('image[]') as File[];
    const bytes = files.reduce((total, file) => total + file.size, 0);
    const startedAt = Date.now();
    try {
      signal?.throwIfAborted();
      await beforeSend?.();
      const response = await corsSafeFetch(apiUrl, {
        method: 'POST', headers: buildMultipartAuthHeaders(apiKey), body, signal,
      });
      return response;
    } catch (error) {
      if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) throw error;
      const message = error instanceof Error ? error.message : '图片请求传输失败';
      throw new Error(`${message}\n提交信息：模型 ${modelName}；参考图 ${files.length} 张，共 ${(bytes / 1048576).toFixed(2)} MiB；输出 ${sizeStr}；等待 ${Math.round((Date.now() - startedAt) / 1000)} 秒。`, { cause: error });
    }
  }

  const apiUrl = baseUrl.replace(/\/+$/, '') + '/images/generations';
  const requestBody = buildStandardImageRequestBody({
    modelName,
    prompt,
    count,
    size: sizeStr,
    imageQuality: params.imageQuality,
    imageBackground: params.imageBackground,
    imageUrls,
    imageReferenceRequestMode: params.imageReferenceRequestMode,
  });
  if (isOpenAIGptImageModel(modelName)) delete requestBody.response_format;

  signal?.throwIfAborted();
  await beforeSend?.();
  return corsSafeFetch(apiUrl, {
    method: 'POST',
    headers: buildAuthHeaders(apiKey),
    body: JSON.stringify(requestBody),
    signal,
  });
}

async function readStandardResponse(
  response: Response,
): Promise<Record<string, unknown>> {
  if (!response.ok) await parseResponseError(response, `图片生成失败 (${response.status})`);

  const responseText = await response.text();
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(responseText) as Record<string, unknown>;
  } catch {
    const contentType = response.headers.get('Content-Type') || '未知 Content-Type';
    if (/text\/html/i.test(contentType) || /^\s*<!doctype\s+html/i.test(responseText)) {
      throw new Error('图片接口返回了 HTML 页面，请检查连接地址是否指向 API 根路径（常见需要追加 /v1）');
    }
    throw new Error(`图片接口返回了非 JSON 响应 (${contentType})`);
  }
  return json;
}

function cccSubmissionFailureMessage(payload: Record<string, unknown>): string {
  const data = Array.isArray(payload.data) ? payload.data : [payload.data];
  const items = data.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item));
  const failed = items.find((item) => item.status === 'failed');
  for (const source of [failed, ...items, payload]) {
    if (!source) continue;
    const error = source.error;
    const detail = typeof error === 'string' ? error
      : error && typeof error === 'object' ? (error as Record<string, unknown>).message : source.message;
    if (typeof detail === 'string' && detail.trim()) return `CCC 图片生成失败：${detail.trim()}`;
  }
  return 'CCC 图片生成失败，平台已返回明确失败状态';
}

async function parseStandardResponse(
  response: Response,
  dimensions: { width: number; height: number },
): Promise<ImageGenerationResult[]> {
  const imageUrls = parseGeneralImageResponses(await readStandardResponse(response));
  return imageUrls.map((url) => ({ url, width: dimensions.width, height: dimensions.height }));
}

async function generateCccImagesBatch(
  params: StandardImageParams,
  requestedCount: number,
  externalSignal?: AbortSignal,
): Promise<BatchImageResult> {
  const projectId = useAppStore.getState().currentProjectId;
  const nodeSignal = params.nodeId ? registerNodePolling(params.nodeId) : undefined;
  const signal = nodeSignal && externalSignal ? AbortSignal.any([nodeSignal, externalSignal]) : nodeSignal ?? externalSignal;
  let receipt: MediaTaskReceipt | undefined;
  let requestSent = false;
  let allTasksFailed = false;
  try {
    if (params.nodeId && projectId && params.providerConfigId) {
      receipt = savePendingTask({ nodeId: params.nodeId, projectId, nodeType: 'ai-image',
        provider: 'general', providerConfigId: params.providerConfigId, taskType: 'custom-protocol',
        taskId: '', submitted: false, batchCount: requestedCount });
    }
    signal?.throwIfAborted();
    const response = await requestStandardImages(params, requestedCount, signal, () => { requestSent = true; });
    const payload = await readStandardResponse(response);
    const data = Array.isArray(payload.data) ? payload.data : [];
    const taskIds = [...new Set(data.flatMap((item) => item && typeof item === 'object'
      && typeof item.task_id === 'string' && item.task_id.trim() ? [item.task_id] : []))];
    if (!taskIds.length) {
      const urls = parseGeneralImageResponses(payload);
      if (!urls.length) {
        if (classifyHttpResponseFailure(response.status, payload)) {
          throw new HttpResponseError(response.status, cccSubmissionFailureMessage(payload), true);
        }
        throw new Error('CCC 图片响应未返回任务 ID 或图片结果，请先到平台确认提交状态');
      }
      if (receipt) removePendingTask(receipt.nodeId, receipt.taskId, receipt.attemptId);
      return { requestedCount, results: urls.slice(0, requestedCount).map((url) => ({ url, ...params.dimensions })),
        failedCount: Math.max(0, requestedCount - urls.length) };
    }
    // 同一连接解析出的 ID 只用于查询该次提交，绝不按缺少的图片数量重发生成。
    const polls: ResolvedModelProtocolPoll[] = taskIds.map((taskId) => ({
      method: 'GET', url: `${params.baseUrl.replace(/\/+$/, '')}/tasks/${encodeURIComponent(taskId)}`,
      auth: { type: 'bearer' }, statusPath: 'data.status', successValues: ['completed'], failureValues: ['failed'],
      resultUrlPath: 'data.result.images.*.url', intervalMs: 3000, maxDurationMs: VIDEO_POLL_MAX_DURATION_MS,
    }));
    if (params.nodeId) receipt = updatePendingTask(params.nodeId, { taskId: taskIds[0], taskIds,
      protocolPoll: polls[0], protocolPolls: polls, submitted: true }, receipt?.taskId, receipt?.attemptId) ?? receipt;
    const failedIds = new Set<string>();
    let interrupted: unknown;
    const queryController = new AbortController();
    const batchQuerySignal = signal ? AbortSignal.any([signal, queryController.signal]) : queryController.signal;
    const completed = await runBatchTasks(polls.length, 3, async (index) => {
      try {
        const result = await pollResolvedModelProtocol(polls[index], params.apiKey, batchQuerySignal, params.baseUrl, (raw) => {
          const payload = raw as { data?: { status?: string; error?: { message?: unknown } }; error?: { message?: unknown } } | null;
          if (payload?.data?.status !== 'failed') return;
          const detail = payload.data.error?.message ?? payload.error?.message;
          throw new PollTaskFailedError(typeof detail === 'string' && detail.trim() ? `CCC 图片任务失败：${detail}` : 'CCC 图片任务失败');
        });
        if (!result.urls?.length) throw new Error('CCC 任务完成但未返回图片');
        return result.urls;
      } catch (error) {
        if (error instanceof PollTaskFailedError) failedIds.add(taskIds[index]);
        else {
          interrupted ??= error;
          queryController.abort(error);
        }
        throw error;
      }
    });
    if (interrupted) throw interrupted;
    allTasksFailed = failedIds.size === taskIds.length;
    const urls = completed.results.flat().slice(0, requestedCount);
    if (!urls.length) throw new PollTaskFailedError('CCC 图片任务失败，请查看平台任务详情');
    if (params.nodeId && failedIds.size) {
      const remainingPolls = polls.filter((_, index) => !failedIds.has(taskIds[index]));
      const remainingIds = taskIds.filter((id) => !failedIds.has(id));
      receipt = updatePendingTask(params.nodeId, { taskId: remainingIds[0], taskIds: remainingIds,
        protocolPoll: remainingPolls[0], protocolPolls: remainingPolls }, receipt?.taskId, receipt?.attemptId) ?? receipt;
    }
    if (receipt) receipt = updatePendingTask(receipt.nodeId, { mediaRecoveryState: 'delivery_pending' }, receipt.taskId, receipt.attemptId) ?? receipt;
    return { requestedCount, results: urls.map((url) => ({ url, ...params.dimensions,
      ...(receipt ? { taskReceipt: receipt } : {}) })), failedCount: Math.max(0, requestedCount - urls.length),
      allTasksSettled: true, ...(receipt ? { taskReceipt: receipt } : {}) };
  } catch (error) {
    if (receipt) {
      const rejectedBeforeTaskId = !receipt.taskId && getHttpResponseError(error)?.definitiveFailure;
      if (!requestSent || rejectedBeforeTaskId || allTasksFailed) {
        removeFailedMediaTask(receipt);
      } else {
        const paused = pauseMediaTask(receipt, error, receipt.taskId ? undefined : 'submit_unknown');
        if (paused) throw paused;
      }
    }
    throw error;
  } finally {
    if (params.nodeId) cleanupNodePolling(params.nodeId, nodeSignal);
  }
}

export async function generateImageStandardBatch(
  params: StandardImageParams,
  count: number,
  signal?: AbortSignal,
): Promise<BatchImageResult> {
  const apiKey = params.apiKey;
  try {
    const requestedCount = Math.max(1, Math.floor(count));
    if (useAppStore.getState().projectExecutionContext?.modelGeneration === 1 || isNativeVideoSubmissionGuard(params.beforeSubmit)) {
      const { runNativeBuiltinImageTask } = await import('../../nativeBuiltinImageTask');
      const { createMediaDownloadAccess } = await import('../mediaDownloadAccess');
      const connectionId = params.providerConfigId;
      if (!connectionId) throw new Error('原生图片缺少原连接身份');
      const preparedMultipart = params.imageUrls?.length && params.imageReferenceRequestMode === 'edits-multipart'
        ? await buildImageEditsBody(params, requestedCount, formatImageSizeForModel(params.modelName, params.dimensions), signal) : undefined;
      const multipartMaterial: unknown[] = [];
      if (preparedMultipart) for (const [name, value] of preparedMultipart.entries()) {
        signal?.throwIfAborted();
        multipartMaterial.push(typeof value === 'string' ? [name, value]
          : [name, { bytes: value.size, mime: value.type, name: value.name, sha256: await sha256BytesHex(new Uint8Array(await value.arrayBuffer())) }]);
      }
      return await runNativeBuiltinImageTask({ nodeId: params.nodeId, mode: params.asyncTaskProvider === 'cccapi' ? 'ccc' : 'standard',
        modelId: params.modelName, modelRef: params.modelRef, connectionId, baseUrl: params.baseUrl, expectedCount: requestedCount,
        secrets: [params.apiKey],
        requestMaterial: [params.modelName, params.prompt, params.dimensions, params.imageQuality, params.imageBackground, params.imageUrls, params.imageReferenceRequestMode, requestedCount, multipartMaterial],
        signal, beforeSubmit: params.beforeSubmit, mediaDownloadAccess: createMediaDownloadAccess(connectionId, params.baseUrl, { type: 'bearer' }),
        execute: async (beforePost) => {
          const response = await requestStandardImages(params, requestedCount, signal, beforePost, preparedMultipart);
          const payload = await readStandardResponse(response);
          const data = Array.isArray(payload.data) ? payload.data : [];
          const taskIds = params.asyncTaskProvider === 'cccapi' ? [...new Set(data.flatMap((item) => item && typeof item === 'object'
            && typeof item.task_id === 'string' && item.task_id.trim() ? [item.task_id] : []))] : [];
          if (taskIds.length) return { taskIds };
          const urls = parseGeneralImageResponses(payload);
          if (!urls.length) {
            // 原文只用于展示；拒绝结算复用共享结构化证据，不按文案或语言猜测。
            const first = Array.isArray(payload.data) ? payload.data[0] : payload.data;
            const detail = first && typeof first === 'object' ? first as Record<string, unknown> : undefined;
            const prefix = Array.isArray(payload.data) ? 'data.0' : 'data';
            const errorPath = detail && typeof detail.error === 'string' ? `${prefix}.error`
              : detail && detail.error && typeof detail.error === 'object' && typeof (detail.error as Record<string, unknown>).message === 'string' ? `${prefix}.error.message`
                : detail && typeof detail.message === 'string' ? `${prefix}.message` : undefined;
            throwIfDefinitiveModelResponseFailure(payload, response.status, errorPath, params.apiKey);
          }
          return { urls };
        } });
    }
    if (params.asyncTaskProvider === 'cccapi') return await generateCccImagesBatch(params, requestedCount, signal);
    const initialResponse = await requestStandardImages(params, requestedCount, signal);

    // User-configured OpenAI-compatible endpoints do not always implement n.
    if (!initialResponse.ok && requestedCount > 1 && [400, 422].includes(initialResponse.status)) {
      const fallback = await runBatchTasks(requestedCount, 3, async () => {
        const response = await requestStandardImages(params, 1, signal);
        const results = await parseStandardResponse(response, params.dimensions);
        const result = results[0];
        if (!result) throw new Error('图片生成返回结果为空');
        return result;
      });
      if (fallback.results.length === 0) {
        throw new Error('批量图片生成失败：服务不支持批量参数，单图降级请求也全部失败');
      }
      return { requestedCount, ...fallback };
    }

    const initialResults = await parseStandardResponse(initialResponse, params.dimensions);
    if (initialResults.length === 0) throw new Error('图片生成返回结果为空');
    if (initialResults.length >= requestedCount) {
      return { requestedCount, results: initialResults.slice(0, requestedCount), failedCount: 0 };
    }

    const missingCount = requestedCount - initialResults.length;
    const supplement = await runBatchTasks(missingCount, 3, async () => {
      const response = await requestStandardImages(params, 1, signal);
      const results = await parseStandardResponse(response, params.dimensions);
      const result = results[0];
      if (!result) throw new Error('图片生成返回结果为空');
      return result;
    });

    return {
      requestedCount,
      results: [...initialResults, ...supplement.results].slice(0, requestedCount),
      failedCount: supplement.failedCount,
    };
  } catch (error) {
    if (error instanceof Error && ['NativeMediaTaskPending', 'NativeMediaTaskDelivered'].includes(error.name)) throw error;
    throw redactModelProtocolError(error, apiKey);
  }
}

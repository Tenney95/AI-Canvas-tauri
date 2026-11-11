/**
 * ai/providers/volcengineImage — 火山方舟 Seedream 图片生成
 *
 * 与标准 OpenAI 兼容流程的差异：
 *  - 使用 normalizeSeedreamSize 归一化画质到模型支持的尺寸
 *  - 请求体含 sequential_image_generation / watermark 等专属字段
 *  - 参考图通过 image 字段传递（非 image_urls）
 */
import { parseResponseError, buildAuthHeaders, getHttpResponseError } from '../httpUtils';
import { extractModelName, normalizeSeedreamSize, parseGeneralImageResponse, parseGeneralImageResponses } from '../helpers';
import { mapImageDimensions } from '../../aiDimensions';
import { getImageCapability } from '../mediaModelCapabilities';
import { runBatchTasks } from '../batchUtils';
import type { BatchImageResult } from '../../../types/aiTypes';
import { corsSafeFetch } from '../httpTransport';
import { mapImageParameters } from '../imageParameterMappings';
import { quoteVolcengineImage } from '../../billing/volcenginePricing';
import { createBillingRun, updateBillingRun } from '../../billing/volcengineBillingService';
import { isNativeVideoSubmissionGuard } from '../../nativeVideoSubmission';
import { redactModelProtocolError, throwIfDefinitiveModelResponseFailure } from '../modelProtocolHttp';

export interface VolcengineImageParams {
  apiKey: string;
  baseUrl: string;
  /** 原始 model value（含 provider/ 前缀） */
  model: string;
  /** provider id，用于 extractModelName */
  provider: string;
  prompt: string;
  imageSize: string;
  aspectRatio: string;
  imageUrls?: string[];
  nodeId?: string;
  beforeSubmit?: () => void | Promise<void>;
  collectCandidates?: boolean;
}

export async function generateVolcengineImage(
  params: VolcengineImageParams,
  signal?: AbortSignal,
): Promise<{ url: string; width: number; height: number; additionalResults?: Array<{ url: string; width: number; height: number }> }> {
  const { apiKey, baseUrl, model, provider, prompt, imageSize, aspectRatio, imageUrls = [] } = params;

  const modelName = extractModelName(model, provider);
  const seedreamSize = normalizeSeedreamSize(modelName, imageSize);
  const apiUrl = baseUrl.replace(/\/+$/, '') + '/images/generations';

  // Seedream 5.0 Pro / Flash 固定比例使用官方像素表；自适应只传分辨率档位。
  // 不能把 2K 当短边直接换算，否则 16:9 会超过方舟的总像素上限。
  const capability = getImageCapability(modelName);
  const singleImageOnly = capability?.supportsBatch === false;
  const adaptiveRatio = aspectRatio === '自适应' || aspectRatio === 'auto';
  const preset = adaptiveRatio ? undefined : capability?.dimensionPresets?.[seedreamSize]?.[aspectRatio];
  const dimensions = preset
    ? { width: preset[0], height: preset[1] }
    : mapImageDimensions(seedreamSize, adaptiveRatio ? '1:1' : aspectRatio);
  const requestSize = singleImageOnly && !adaptiveRatio
    ? `${dimensions.width}x${dimensions.height}`
    : seedreamSize;

  const requestBody = mapImageParameters('volcengine', modelName, {
    model: modelName,
    prompt,
    imageSize: requestSize,
    referenceImageUrls: imageUrls,
  });
  if (singleImageOnly) {
    // Pro / Flash 不支持组图或流式字段，即使 disabled / false 也不发送。
    delete requestBody.stream;
  } else {
    requestBody.sequential_image_generation = 'disabled';
  }
  if (imageUrls.length > 0) {
    requestBody.image = imageUrls;
  }

  const quote = quoteVolcengineImage({ modelId: modelName, inputImageCount: imageUrls.length, outputCount: 1,
    width: adaptiveRatio ? undefined : dimensions.width, height: adaptiveRatio ? undefined : dimensions.height });
  let run = await createBillingRun({
    nodeId: params.nodeId, modelType: 'image', modelId: modelName, prompt,
    details: { imageSize: requestSize, aspectRatio, width: dimensions.width, height: dimensions.height, inputImageCount: imageUrls.length, outputCountRequested: 1 },
    quote,
  });

  let requestSent = false;
  try {
    await params.beforeSubmit?.(); signal?.throwIfAborted(); requestSent = true;
    const response = await corsSafeFetch(apiUrl, {
      method: 'POST', headers: buildAuthHeaders(apiKey), body: JSON.stringify(requestBody), signal,
    });
    if (!response.ok) await parseResponseError(response, `图片生成失败 (${response.status})`);
    const json = await response.json();
    const imageUrl = parseGeneralImageResponse(json);
    if (!imageUrl) {
      throwIfDefinitiveModelResponseFailure(json, response.status, undefined, apiKey);
      throw new Error('图片生成返回结果为空');
    }
    const candidates = params.collectCandidates ? parseGeneralImageResponses(json) : [imageUrl];
    const completedQuote = params.collectCandidates ? quoteVolcengineImage({ modelId: modelName, inputImageCount: imageUrls.length,
      outputCount: candidates.length, width: adaptiveRatio ? undefined : dimensions.width, height: adaptiveRatio ? undefined : dimensions.height }) : quote;
    run = await updateBillingRun(run, {
      status: 'succeeded', finishedAt: Date.now(), calculatedMicros: completedQuote.amountMicros,
      amountConfidence: completedQuote.amountMicros === null ? 'unknown' : 'calculated',
      ...(params.collectCandidates ? { inputJson: JSON.stringify({ imageSize: requestSize, aspectRatio, width: dimensions.width, height: dimensions.height,
        inputImageCount: imageUrls.length, outputCountRequested: 1, outputCountSucceeded: candidates.length }) } : {}),
    });
    return { url: imageUrl, width: dimensions.width, height: dimensions.height,
      ...(params.collectCandidates ? { additionalResults: candidates.slice(1).map((url) => ({ url, ...dimensions })) } : {}) };
  } catch (error) {
    const safeError = redactModelProtocolError(error, apiKey);
    const explicitlyRejected = !requestSent || getHttpResponseError(safeError)?.definitiveFailure === true;
    await updateBillingRun(run, {
      status: explicitlyRejected ? 'failed' : 'unknown', finishedAt: Date.now(),
      calculatedMicros: explicitlyRejected ? 0 : null,
      amountConfidence: explicitlyRejected ? 'calculated' : 'unknown',
      errorMessage: safeError instanceof Error ? safeError.message.slice(0, 500) : '图片请求失败',
    });
    throw safeError;
  }
}

export async function generateVolcengineImagesBatch(
  params: VolcengineImageParams,
  count: number,
  signal?: AbortSignal,
): Promise<BatchImageResult> {
  const requestedCount = Math.max(1, Math.floor(count));
  const { useAppStore } = await import('../../../store/useAppStore');
  if (useAppStore.getState().projectExecutionContext?.modelGeneration === 1 || isNativeVideoSubmissionGuard(params.beforeSubmit)) {
    const { runNativeBuiltinImageTask } = await import('../../nativeBuiltinImageTask');
    const { createMediaDownloadAccess } = await import('../mediaDownloadAccess');
    return runNativeBuiltinImageTask({ nodeId: params.nodeId, mode: 'volcengine', modelId: extractModelName(params.model, params.provider),
      connectionId: params.provider, baseUrl: params.baseUrl, expectedCount: requestedCount,
      secrets: [params.apiKey],
      requestMaterial: [params.model, params.prompt, params.imageSize, params.aspectRatio, params.imageUrls], beforeSubmit: params.beforeSubmit, signal,
      mediaDownloadAccess: createMediaDownloadAccess(params.provider, params.baseUrl, { type: 'bearer' }),
      execute: async (beforePost) => {
        const result = await generateVolcengineImage({ ...params, beforeSubmit: beforePost, collectCandidates: true }, signal);
        return { urls: [result.url, ...(result.additionalResults ?? []).map((file) => file.url)] };
      } });
  }
  // 单图保留原始 HTTP / 取消错误，不经过会丢失失败原因的批处理汇总。
  if (requestedCount === 1) {
    return { requestedCount, results: [await generateVolcengineImage(params, signal)], failedCount: 0 };
  }
  const errors: unknown[] = [];
  const settled = await runBatchTasks(
    requestedCount,
    3,
    async () => {
      try {
        return await generateVolcengineImage(params, signal);
      } catch (error) {
        errors.push(error);
        throw error;
      }
    },
  );
  if (settled.results.length === 0) {
    // 任一请求结果未知时保留该错误，不能用另一项的明确拒绝推断整批未生成。
    throw errors.find((error) => !getHttpResponseError(error)?.definitiveFailure)
      ?? errors[0] ?? new Error('火山方舟图片生成失败');
  }
  return { requestedCount, ...settled };
}

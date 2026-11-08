/**
 * ai/providers/volcengineImage — 火山方舟 Seedream 图片生成
 *
 * 与标准 OpenAI 兼容流程的差异：
 *  - 使用 normalizeSeedreamSize 归一化画质到模型支持的尺寸
 *  - 请求体含 sequential_image_generation / watermark 等专属字段
 *  - 参考图通过 image 字段传递（非 image_urls）
 */
import { parseResponseError, buildAuthHeaders } from '../httpUtils';
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

  // Seedream 5.0 Pro 固定比例使用官方像素表；自适应只传分辨率档位。
  // 不能把 2K 当短边直接换算，否则 16:9 会超过方舟的总像素上限。
  const isPro = modelName.startsWith('doubao-seedream-5-0-pro');
  const adaptiveRatio = aspectRatio === '自适应' || aspectRatio === 'auto';
  const capability = isPro ? getImageCapability(modelName) : undefined;
  const preset = adaptiveRatio ? undefined : capability?.dimensionPresets?.[seedreamSize]?.[aspectRatio];
  const dimensions = preset
    ? { width: preset[0], height: preset[1] }
    : mapImageDimensions(seedreamSize, adaptiveRatio ? '1:1' : aspectRatio);
  const requestSize = isPro && !adaptiveRatio
    ? `${dimensions.width}x${dimensions.height}`
    : seedreamSize;

  const requestBody = mapImageParameters('volcengine', modelName, {
    model: modelName,
    prompt,
    imageSize: requestSize,
    referenceImageUrls: imageUrls,
  });
  if (!isPro) {
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

  let explicitlyRejected = false;
  let requestSent = false;
  try {
    await params.beforeSubmit?.(); signal?.throwIfAborted(); requestSent = true;
    const response = await corsSafeFetch(apiUrl, {
      method: 'POST', headers: buildAuthHeaders(apiKey), body: JSON.stringify(requestBody), signal,
    });
    explicitlyRejected = !response.ok;
    if (!response.ok) await parseResponseError(response, `图片生成失败 (${response.status})`);
    const json = await response.json();
    const imageUrl = parseGeneralImageResponse(json);
    if (!imageUrl) throw new Error('图片生成返回结果为空');
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
    await updateBillingRun(run, {
      status: explicitlyRejected || !requestSent ? 'failed' : 'unknown', finishedAt: Date.now(),
      calculatedMicros: explicitlyRejected || !requestSent ? 0 : null,
      amountConfidence: explicitlyRejected || !requestSent ? 'calculated' : 'unknown',
      errorMessage: error instanceof Error ? error.message.slice(0, 500) : '图片请求失败',
    });
    throw error;
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
  const settled = await runBatchTasks(
    requestedCount,
    3,
    () => generateVolcengineImage(params, signal),
  );
  if (settled.results.length === 0) {
    throw new Error('批量图片生成失败：所有火山方舟请求均失败');
  }
  return { requestedCount, ...settled };
}

/**
 * ai/providers/standardImage — 标准 OpenAI 兼容图片生成
 *
 * 适用于 general 通用模型和任意 OpenAI 兼容 provider。
 * 统一 POST /images/generations + 标准 data[0].url / b64_json 响应解析。
 */
import { parseResponseError, buildAuthHeaders } from '../httpUtils';
import {
  isOpenAIGptImageModel,
  formatImageSizeForModel,
  parseGeneralImageResponses,
} from '../helpers';
import { runBatchTasks } from '../batchUtils';
import type { BatchImageResult, ImageGenerationResult } from '../../../types/aiTypes';

export interface StandardImageParams {
  apiKey: string;
  baseUrl: string;
  modelName: string;
  prompt: string;
  dimensions: { width: number; height: number };
  imageUrls?: string[];
}

export async function generateImageStandard(
  params: StandardImageParams,
): Promise<{ url: string; width: number; height: number }> {
  const batch = await generateImageStandardBatch(params, 1);
  const result = batch.results[0];
  if (!result) throw new Error('图片生成返回结果为空');
  return result;
}

async function requestStandardImages(
  params: StandardImageParams,
  count: number,
): Promise<Response> {
  const { apiKey, baseUrl, modelName, prompt, dimensions, imageUrls = [] } = params;

  const apiUrl = baseUrl.replace(/\/+$/, '') + '/images/generations';
  const sizeStr = formatImageSizeForModel(modelName, dimensions);

  const requestBody: Record<string, unknown> = {
    model: modelName,
    prompt,
    n: count,
    size: sizeStr,
  };
  if (!isOpenAIGptImageModel(modelName)) {
    requestBody.response_format = 'url';
  }
  if (imageUrls.length > 0) {
    requestBody.image_urls = imageUrls;
  }

  return fetch(apiUrl, {
    method: 'POST',
    headers: buildAuthHeaders(apiKey),
    body: JSON.stringify(requestBody),
  });

}

async function parseStandardResponse(
  response: Response,
  dimensions: { width: number; height: number },
): Promise<ImageGenerationResult[]> {
  if (!response.ok) await parseResponseError(response, `图片生成失败 (${response.status})`);

  const json = await response.json();
  const imageUrls = parseGeneralImageResponses(json);
  return imageUrls.map((url) => ({ url, width: dimensions.width, height: dimensions.height }));
}

export async function generateImageStandardBatch(
  params: StandardImageParams,
  count: number,
): Promise<BatchImageResult> {
  const requestedCount = Math.max(1, Math.floor(count));
  const initialResponse = await requestStandardImages(params, requestedCount);

  // User-configured OpenAI-compatible endpoints do not always implement n.
  if (!initialResponse.ok && requestedCount > 1 && [400, 422].includes(initialResponse.status)) {
    const fallback = await runBatchTasks(requestedCount, 3, async () => {
      const response = await requestStandardImages(params, 1);
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
    const response = await requestStandardImages(params, 1);
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
}

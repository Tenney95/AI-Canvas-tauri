/**
 * ai/providers/standardImage — 标准 OpenAI 兼容图片生成
 *
 * 适用于 general 通用模型和任意 OpenAI 兼容 provider。
 * 缺省使用 /images/generations JSON；显式配置后，参考图请求使用 /images/edits multipart。
 */
import { parseResponseError, buildAuthHeaders } from '../httpUtils';
import { corsSafeFetch } from '../httpTransport';
import {
  isOpenAIGptImageModel,
  formatImageSizeForModel,
  parseGeneralImageResponses,
} from '../helpers';
import { runBatchTasks } from '../batchUtils';
import type { ImageReferenceRequestMode } from '../../../types';
import type { BatchImageResult, ImageGenerationResult } from '../../../types/aiTypes';

export interface StandardImageParams {
  apiKey: string;
  baseUrl: string;
  modelName: string;
  prompt: string;
  dimensions: { width: number; height: number };
  imageUrls?: string[];
  imageReferenceRequestMode?: ImageReferenceRequestMode;
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
  return /^(asset:|blob:|data:|file:)/i.test(url) || url.includes('asset.localhost');
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
  params: Pick<StandardImageParams, 'modelName' | 'prompt' | 'imageUrls'>,
  count: number,
  size: string,
  signal?: AbortSignal,
): Promise<FormData> {
  const imageUrls = params.imageUrls ?? [];
  const files = await Promise.all(
    imageUrls.map((url, index) => loadReferenceImage(url, index, signal)),
  );
  const formData = new FormData();
  formData.append('model', params.modelName);
  formData.append('prompt', params.prompt);
  formData.append('n', String(count));
  formData.append('size', size);
  for (const file of files) formData.append('image[]', file.blob, file.filename);
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
): Promise<Response> {
  const { apiKey, baseUrl, modelName, prompt, dimensions, imageUrls = [] } = params;

  const sizeStr = formatImageSizeForModel(modelName, dimensions);
  if (imageUrls.length > 0 && params.imageReferenceRequestMode === 'edits-multipart') {
    const apiUrl = baseUrl.replace(/\/+$/, '') + '/images/edits';
    return corsSafeFetch(apiUrl, {
      method: 'POST',
      headers: buildMultipartAuthHeaders(apiKey),
      body: await buildImageEditsBody(params, count, sizeStr, signal),
      signal,
    });
  }

  const apiUrl = baseUrl.replace(/\/+$/, '') + '/images/generations';
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

  return corsSafeFetch(apiUrl, {
    method: 'POST',
    headers: buildAuthHeaders(apiKey),
    body: JSON.stringify(requestBody),
    signal,
  });
}

async function parseStandardResponse(
  response: Response,
  dimensions: { width: number; height: number },
): Promise<ImageGenerationResult[]> {
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
  const imageUrls = parseGeneralImageResponses(json);
  return imageUrls.map((url) => ({ url, width: dimensions.width, height: dimensions.height }));
}

export async function generateImageStandardBatch(
  params: StandardImageParams,
  count: number,
  signal?: AbortSignal,
): Promise<BatchImageResult> {
  const requestedCount = Math.max(1, Math.floor(count));
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
}

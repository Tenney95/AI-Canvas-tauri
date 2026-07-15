/**
 * ai/providers/volcengineImage — 火山方舟 Seedream 图片生成
 *
 * 与标准 OpenAI 兼容流程的差异：
 *  - 使用 normalizeSeedreamSize 归一化画质到模型支持的尺寸
 *  - 请求体含 sequential_image_generation / watermark 等专属字段
 *  - 参考图通过 image 字段传递（非 image_urls）
 */
import { parseResponseError, buildAuthHeaders } from '../httpUtils';
import { extractModelName, normalizeSeedreamSize, parseGeneralImageResponse } from '../helpers';
import { mapImageDimensions } from '../../aiDimensions';
import { runBatchTasks } from '../batchUtils';
import type { BatchImageResult } from '../../../types/aiTypes';

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
}

export async function generateVolcengineImage(
  params: VolcengineImageParams,
): Promise<{ url: string; width: number; height: number }> {
  const { apiKey, baseUrl, model, provider, prompt, imageSize, aspectRatio, imageUrls = [] } = params;

  const modelName = extractModelName(model, provider);
  const seedreamSize = normalizeSeedreamSize(modelName, imageSize);
  const dimensions = mapImageDimensions(seedreamSize, aspectRatio);
  const apiUrl = baseUrl.replace(/\/+$/, '') + '/images/generations';

  // doubao-seedream-5-0-pro-260628 使用 WxH 格式，且不支持 sequential_image_generation
  const isPro = modelName === 'doubao-seedream-5-0-pro-260628';

  const requestBody: Record<string, unknown> = {
    model: modelName,
    prompt,
    response_format: 'url',
    size: isPro ? `${dimensions.width}x${dimensions.height}` : seedreamSize,
    stream: false,
    watermark: true,
  };
  if (!isPro) {
    requestBody.sequential_image_generation = 'disabled';
  }
  if (imageUrls.length > 0) {
    requestBody.image = imageUrls;
  }

  const response = await fetch(apiUrl, {
    method: 'POST',
    headers: buildAuthHeaders(apiKey),
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    await parseResponseError(response, `图片生成失败 (${response.status})`);
  }

  const json = await response.json();
  const imageUrl = parseGeneralImageResponse(json);
  if (!imageUrl) throw new Error('图片生成返回结果为空');

  return { url: imageUrl, width: dimensions.width, height: dimensions.height };
}

export async function generateVolcengineImagesBatch(
  params: VolcengineImageParams,
  count: number,
): Promise<BatchImageResult> {
  const requestedCount = Math.max(1, Math.floor(count));
  const settled = await runBatchTasks(
    requestedCount,
    3,
    () => generateVolcengineImage(params),
  );
  if (settled.results.length === 0) {
    throw new Error('批量图片生成失败：所有火山方舟请求均失败');
  }
  return { requestedCount, ...settled };
}

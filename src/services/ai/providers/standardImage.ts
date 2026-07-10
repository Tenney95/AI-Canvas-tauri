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
  parseGeneralImageResponse,
} from '../helpers';

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
  const { apiKey, baseUrl, modelName, prompt, dimensions, imageUrls = [] } = params;

  const apiUrl = baseUrl.replace(/\/+$/, '') + '/images/generations';
  const sizeStr = formatImageSizeForModel(modelName, dimensions);

  const requestBody: Record<string, unknown> = {
    model: modelName,
    prompt,
    n: 1,
    size: sizeStr,
  };
  if (!isOpenAIGptImageModel(modelName)) {
    requestBody.response_format = 'url';
  }
  if (imageUrls.length > 0) {
    requestBody.image_urls = imageUrls;
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

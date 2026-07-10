/**
 * ai/generateImage — 图片生成入口
 */
import { useAppStore } from '../../store/useAppStore';
import { DEFAULT_BASE_URLS } from '../../constants/api';
import { mapImageDimensions } from '../aiDimensions';
import { generateDreaminaImage } from '../dreaminaService';
import { executeComfyUIGenerate } from '../comfyWorkflowService';
import type { AIImageGenParams } from '../../types/aiTypes';
import {
  extractModelName,
  isOpenAIGptImageModel,
  toImageDataUrl,
  formatImageSizeForModel,
  normalizeSeedreamSize,
  resolveGeneralModel,
  parseGeneralImageResponse,
} from './helpers';
import { resolvePromptWithImageRefs } from './promptResolver';
import { resolveImageUrlArray } from './imageUtils';
import { generateApimartImage } from './apimartGen';

export async function generateImage(params: AIImageGenParams): Promise<{ url: string; width: number; height: number }> {
  const { prompt: rawPrompt, model, provider, imageSize = '2K', aspectRatio = '1:1' } = params;

  // 解析 @{nodeId:label} 引用：图片 URL 提取到 image_urls，文本内联替换到 prompt
  const { prompt, imageUrls } = await resolvePromptWithImageRefs(rawPrompt);

  // 合并调用方传入的 image_urls 与从 prompt 中解析出的 imageUrls
  let allImageUrls = [...(params.image_urls || []), ...imageUrls];

  // 即梦：直接把本地/原始图片 URL 交给 CLI（CLI 端本地化），不走图床上传
  if (provider === 'dreamina') {
    if (!prompt.trim()) throw new Error('提示词不能为空');
    return generateDreaminaImage({ prompt, model, imageSize, aspectRatio, imageUrls: allImageUrls, nodeId: params.nodeId });
  }

  // 将本地图片 URL 上传到远端图床，转为公网 URL
  allImageUrls = await resolveImageUrlArray(allImageUrls);

  // ComfyUI 工作流执行路径
  if (params.workflowId) {
    return executeComfyUIGenerate({ ...params, prompt });
  }

  if (!prompt.trim()) {
    throw new Error('提示词不能为空');
  }

  const config = useAppStore.getState().config;

  // APIMart 使用异步任务轮询格式（与 OpenAI 不兼容）
  if (provider === 'apimart') {
    const providerConfig = config.providers.apimart;
    const apiKey = providerConfig?.apiKey || '';
    if (!apiKey) {
      throw new Error('未配置 apimart 的 API Key\n请在「设置 → API Key」中配置');
    }
    let baseUrl = providerConfig?.baseUrl || DEFAULT_BASE_URLS.apimart || '';
    if (!baseUrl) {
      throw new Error('未配置 apimart 的服务地址\n请在「设置 → API Key」中添加');
    }
    baseUrl = baseUrl.replace(/\/+$/, '');
    const modelName = extractModelName(model, provider);
    const dimensions = mapImageDimensions(imageSize, aspectRatio);
    return generateApimartImage(apiKey, baseUrl, modelName, prompt, imageSize, aspectRatio, dimensions, allImageUrls, params.nodeId);
  }

  // ── 通用模型图片生成 ──
  if (provider === 'general') {
    const gm = resolveGeneralModel(model);
    if (!gm) throw new Error('未找到该通用模型配置\n请在「设置 → API Key」中检查');
    if (!gm.openaiUrl) throw new Error(`通用模型 "${gm.name}" 未配置接口地址`);
    const dimensions = mapImageDimensions(imageSize, aspectRatio);
    const sizeStr = formatImageSizeForModel(gm.modelId, dimensions);
    const apiUrl = gm.openaiUrl.replace(/\/+$/, '') + '/images/generations';
    const requestBody: Record<string, unknown> = {
      model: gm.modelId,
      prompt,
      n: 1,
      size: sizeStr,
    };
    if (!isOpenAIGptImageModel(gm.modelId)) {
      requestBody.response_format = 'url';
    }
    if (allImageUrls.length > 0) {
      requestBody.image_urls = allImageUrls;
    }

    const controller = new AbortController();
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${gm.apiKey || ''}`,
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '');
      let errorMsg = `图片生成失败 (${response.status})`;
      try {
        const err = JSON.parse(errorBody);
        errorMsg = err.error?.message || errorMsg;
      } catch {
        if (errorBody) errorMsg += `: ${errorBody.slice(0, 200)}`;
      }
      throw new Error(errorMsg);
    }

    const json = await response.json();
    const imageUrl = parseGeneralImageResponse(json);
    if (!imageUrl) throw new Error('图片生成返回结果为空');
    return { url: imageUrl, width: dimensions.width, height: dimensions.height };
  }

  // ── 火山方舟 Seedream 图片生成 ──
  if (provider === 'volcengine') {
    const providerConfig = config.providers.volcengine;
    const apiKey = providerConfig?.apiKey || '';
    if (!apiKey) {
      throw new Error('未配置 火山方舟 的 API Key\n请在「设置 → API Key」中配置');
    }
    const baseUrl = providerConfig?.baseUrl || DEFAULT_BASE_URLS.volcengine || '';
    if (!baseUrl) {
      throw new Error('未配置 火山方舟 的服务地址\n请在「设置 → API Key」中添加');
    }
    const modelName = extractModelName(model, provider);
    const seedreamSize = normalizeSeedreamSize(modelName, imageSize);
    const dimensions = mapImageDimensions(seedreamSize, aspectRatio);
    const apiUrl = baseUrl.replace(/\/+$/, '') + '/images/generations';

    const requestBody: Record<string, unknown> = {
      model: modelName,
      prompt,
      sequential_image_generation: 'disabled',
      response_format: 'url',
      size: seedreamSize,
      stream: false,
      watermark: true,
    };
    if (allImageUrls.length > 0) {
      requestBody.image = allImageUrls;
    }

    const controller = new AbortController();
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '');
      let errorMsg = `图片生成失败 (${response.status})`;
      try {
        const err = JSON.parse(errorBody);
        errorMsg = err.error?.message || errorMsg;
      } catch {
        if (errorBody) errorMsg += `: ${errorBody.slice(0, 200)}`;
      }
      throw new Error(errorMsg);
    }

    const json = await response.json();
    const imageUrl = json.data?.[0]?.url || (json.data?.[0]?.b64_json ? toImageDataUrl(json.data[0].b64_json) : undefined);
    if (!imageUrl) {
      throw new Error('图片生成返回结果为空');
    }

    return { url: imageUrl, width: dimensions.width, height: dimensions.height };
  }

  const dimensions = mapImageDimensions(imageSize, aspectRatio);

  if (provider === 'localllm') {
    // 已合并到通用模型，此处保留兼容旧数据
    throw new Error('本地大模型已迁移到「通用模型」，请重新选择模型\n请在「设置 → API Key」中添加通用模型');
  }

  const providerConfig = config.providers[provider];
  const apiKey = providerConfig?.apiKey || '';
  if (!apiKey) {
    throw new Error(`未配置 ${provider} 的 API Key\n请在「设置 → API Key」中配置`);
  }
  const baseUrl = providerConfig?.baseUrl || DEFAULT_BASE_URLS[provider] || '';

  if (!baseUrl) {
    throw new Error(`未配置 ${provider} 的服务地址\n请在「设置 → API Key」中添加`);
  }

  // 图片生成端点
  const apiUrl = baseUrl.replace(/\/+$/, '') + '/images/generations';

  const modelName = extractModelName(model, provider);
  const sizeStr = formatImageSizeForModel(modelName, dimensions);

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  const controller = new AbortController();

  const requestBody: Record<string, unknown> = {
    model: modelName,
    prompt,
    n: 1,
    size: sizeStr,
  };
  if (!isOpenAIGptImageModel(modelName)) {
    requestBody.response_format = 'url';
  }
  if (allImageUrls.length > 0) {
    requestBody.image_urls = allImageUrls;
  }

  const response = await fetch(apiUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(requestBody),
    signal: controller.signal,
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => '');
    let errorMsg = `图片生成失败 (${response.status})`;
    try {
      const err = JSON.parse(errorBody);
      errorMsg = err.error?.message || errorMsg;
    } catch {
      if (errorBody) errorMsg += `: ${errorBody.slice(0, 200)}`;
    }
    throw new Error(errorMsg);
  }

  const json = await response.json();
  const imageUrl = json.data?.[0]?.url || (json.data?.[0]?.b64_json ? toImageDataUrl(json.data[0].b64_json) : undefined);
  if (!imageUrl) {
    throw new Error('图片生成返回结果为空');
  }

  return { url: imageUrl, width: dimensions.width, height: dimensions.height };
}

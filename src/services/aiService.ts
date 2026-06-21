/**
 * aiService AI 生成服务 — 统一封装各厂商 AI 生成 API，支持文本/图像/视频/音频生成、ComfyUI/RunningHUB 工作流执行
 */
import { useAppStore } from '../store/useAppStore';
import { uploadToRemote, isLocalImageUrl } from './uploadService';
import { readFileToDataUrl, getFileCategory, getAssetUrlFromPath } from './fileService';
import { mapImageDimensions } from './aiDimensions';
import { resolveNodeReferences } from './nodeReferenceService';
import { generateDreaminaImage, generateDreaminaVideo } from './dreaminaService';
import type { AIAudioGenParams, AIGenerateParams, AIImageGenParams, AIVideoGenParams } from './aiTypes';
import {
  executeComfyUIAudioGenerate,
  executeComfyUIGenerate,
  executeComfyUIVideoGenerate,
} from './comfyWorkflowService';

export type { AIAudioGenParams, AIGenerateParams, AIImageGenParams, AIVideoGenParams } from './aiTypes';


const DEFAULT_BASE_URLS: Record<string, string> = {
  apimart: 'https://api.apib.ai/v1',
  volcengine: 'https://ark.cn-beijing.volces.com/api/v3',
  grsai: 'https://api.grsai.com',
  dreamina: 'https://api.dreamina.com',
  runninghub: 'https://api.runninghub.cn',
  runninghubwf: 'https://api.runninghub.cn',
};

/** 加载图片（自动处理远程 URL 的 CORS） */
async function loadImage(src: string): Promise<HTMLImageElement> {
  // 远程 URL 通过 fetch 下载为 blob 再加载，避免 canvas 被污染
  if (src.startsWith('http://') || src.startsWith('https://')) {
    const response = await fetch(src);
    if (!response.ok) throw new Error(`Failed to fetch image: ${response.status}`);
    const blob = await response.blob();
    const objectUrl = URL.createObjectURL(blob);
    return new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(objectUrl);
        resolve(img);
      };
      img.onerror = () => {
        URL.revokeObjectURL(objectUrl);
        reject(new Error('Failed to load image'));
      };
      img.src = objectUrl;
    });
  }
  // 本地 URL（data: / blob: / file: / asset:）
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Failed to load image'));
    img.src = src;
  });
}

/** 用 <img> 加载探测线上图片 URL 是否仍可达（避免 CORS：图片加载不受 CORS 限制）*/
function imageUrlReachable(url: string, timeoutMs = 6000): Promise<boolean> {
  return new Promise((resolve) => {
    if (typeof Image === 'undefined') { resolve(true); return; }
    const img = new Image();
    let settled = false;
    const finish = (v: boolean) => { if (!settled) { settled = true; clearTimeout(timer); resolve(v); } };
    const timer = setTimeout(() => finish(false), timeoutMs);
    img.onload = () => finish(true);
    img.onerror = () => finish(false);
    img.src = url;
  });
}

/**
 * 解析图片节点的可用 URL：
 *  - 本地/内联 URL（asset://、data:、blob:）直接用；
 *  - 线上 http(s) URL 先验证是否可达，失效且有本地 filePath 时改用本地 asset URL
 *    （随后由 resolveImageUrlArray/resolveContentImageUrls 的本地→远端上传流程接管）。
 */
async function resolveNodeImageUrl(url: string, filePath?: string): Promise<string> {
  // 本地/内联 URL（asset://、data:、blob:、http://asset.localhost）无需校验
  if (!url || !/^https?:/i.test(url) || url.includes('asset.localhost')) return url;
  if (await imageUrlReachable(url)) return url;
  if (filePath) {
    try {
      const local = await getAssetUrlFromPath(filePath);
      if (local) return local;
    } catch { /* ignore, fall through */ }
  }
  return url; // 无本地兜底则维持原样
}

/** 将蒙版/标注叠加层与原图合并，返回合成后的 data URL */
async function mergeImageWithOverlays(
  imageUrl: string,
  mattingMask?: string,
  annotation?: string,
): Promise<string> {
  const img = await loadImage(imageUrl);
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext('2d')!;

  // 绘制原图
  ctx.drawImage(img, 0, 0);

  // 叠加蒙版（如果有）
  if (mattingMask) {
    const maskImg = await loadImage(mattingMask);
    ctx.drawImage(maskImg, 0, 0, canvas.width, canvas.height);
  }

  // 叠加标注（如果有，绘制在最上层）
  if (annotation) {
    const annotateImg = await loadImage(annotation);
    ctx.drawImage(annotateImg, 0, 0, canvas.width, canvas.height);
  }

  return canvas.toDataURL('image/png');
}

/** 上传 content 数组中本地图片 URL 到远端，替换为公网 URL */
async function resolveContentImageUrls(
  content: string | Array<{ type: string; text?: string; image_url?: { url: string } }>,
): Promise<string | Array<{ type: string; text?: string; image_url?: { url: string } }>> {
  if (typeof content === 'string') return content;
  const resolved = await Promise.all(
    content.map(async (part) => {
      if (part.type === 'image_url' && part.image_url?.url && isLocalImageUrl(part.image_url.url)) {
        try {
          const publicUrl = await uploadToRemote(part.image_url.url);
          return { ...part, image_url: { url: publicUrl } };
        } catch (err) {
          console.error('[aiService] Failed to upload local image URL:', part.image_url.url, err);
          return part;
        }
      }
      return part;
    }),
  );
  return resolved;
}

/** 上传 imageUrls 数组中的本地图片到远端 */
async function resolveImageUrlArray(urls: string[]): Promise<string[]> {
  return Promise.all(
    urls.map(async (url) => {
      if (isLocalImageUrl(url)) {
        try {
          return await uploadToRemote(url);
        } catch (err) {
          console.error('[aiService] Failed to upload local image URL:', url, err);
          return url;
        }
      }
      return url;
    }),
  );
}

/** 去掉 model value 中的 provider/ 前缀，得到实际的模型名 */
function extractModelName(modelValue: string, provider: string): string {
  const prefix = `${provider}/`;
  if (modelValue.startsWith(prefix)) {
    return modelValue.slice(prefix.length);
  }
  return modelValue;
}

function isOpenAIGptImageModel(modelName: string): boolean {
  return /^gpt-image-\d/.test(modelName);
}

function toImageDataUrl(base64: string, format = 'png'): string {
  if (/^(data:|https?:|blob:)/.test(base64)) return base64;
  return `data:image/${format};base64,${base64}`;
}

function formatImageSizeForModel(
  modelName: string,
  dimensions: { width: number; height: number },
): string {
  if (!isOpenAIGptImageModel(modelName)) {
    return `${dimensions.width}x${dimensions.height}`;
  }

  const toMultipleOf16 = (value: number) => Math.max(16, Math.round(value / 16) * 16);
  return `${toMultipleOf16(dimensions.width)}x${toMultipleOf16(dimensions.height)}`;
}

/** 从 store 中查找通用模型配置 */
function resolveGeneralModel(modelValue: string) {
  const config = useAppStore.getState().config;
  const gmId = modelValue.replace(/^general\//, '');
  return config.generalModels?.find((m) => m.id === gmId);
}

/**
 * 多路径响应解析 — 兼容不同厂商的返回值格式
 * @param json 响应 JSON
 * @param primaryField 优先查找的字段名（如 'videos', 'audios', 'images'）
 * @param fallbackFields 兜底字段列表
 */
function parseMultiPathResponse(
  json: Record<string, unknown>,
  primaryField: string,
  fallbackFields: string[] = ['images'],
): string | undefined {
  // 优先取值
  const primary = (json as Record<string, unknown[]>)[primaryField];
  if (Array.isArray(primary) && primary.length > 0) {
    const item = primary[0] as Record<string, unknown>;
    if (Array.isArray(item.url)) return item.url[0] as string | undefined;
    if (typeof item.url === 'string') return item.url;
  }
  // 兜底
  for (const field of fallbackFields) {
    const arr = (json as Record<string, unknown[]>)[field];
    if (Array.isArray(arr) && arr.length > 0) {
      const item = arr[0] as Record<string, unknown>;
      if (Array.isArray(item.url)) return item.url[0] as string | undefined;
      if (typeof item.url === 'string') return item.url;
    }
  }
  return undefined;
}

/**
 * 通用异步任务执行器 — 提交 + 轮询，兼容支持 task_id 模式的 OpenAI 兼容接口
 */
async function executeGeneralAsyncTask(
  apiKey: string,
  baseUrl: string,
  modelName: string,
  prompt: string,
  resultField: 'videos' | 'audios' | 'images',
): Promise<{ url: string }> {
  const apiUrl = baseUrl.replace(/\/+$/, '') + '/images/generations';
  const submitResp = await fetch(apiUrl, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: modelName, prompt, n: 1 }),
  });

  if (!submitResp.ok) {
    const errBody = await submitResp.text().catch(() => '');
    throw new Error(`提交失败 (${submitResp.status}): ${errBody.slice(0, 200)}`);
  }

  const submitResult = await submitResp.json() as Record<string, unknown>;
  const taskId = (submitResult.data as Array<{ task_id: string }>)?.[0]?.task_id
    || (submitResult.task_id as string);

  // 无 task_id 时尝试直接从响应中解析结果
  if (!taskId) {
    const url = parseMultiPathResponse(submitResult, resultField);
    if (url) return { url };
    // 尝试标准 OpenAI 图片格式
    const dataArr = submitResult.data as Array<{ url: string }> | undefined;
    if (dataArr?.[0]?.url) return { url: dataArr[0].url };
    throw new Error('响应格式异常：未返回 task_id 或结果 URL');
  }

  const POLL_INTERVAL = 3000;

  // 不设超时：轮询直到任务完成/失败（仅 ComfyUI 才设超时）
  while (true) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL));
    const pollResp = await fetch(`${baseUrl}/tasks/${taskId}?language=zh`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    if (!pollResp.ok) continue;

    const pollResult = await pollResp.json() as Record<string, unknown>;
    const task = (pollResult.data ?? pollResult) as Record<string, unknown>;

    if (task.status === 'completed') {
      const url = parseMultiPathResponse((task.result ?? pollResult) as Record<string, unknown>, resultField);
      if (url) return { url };
      throw new Error('任务完成但未返回结果');
    }

    if (task.status === 'failed' || task.status === 'error') {
      throw new Error(`任务失败: ${task.status}`);
    }
  }
}

/**
 * 通用模型的文本响应解析 — 兼容多字段名格式
 */
function parseGeneralTextResponse(json: Record<string, unknown>): string {
  // 标准 OpenAI Chat
  const choices = json.choices as Array<{ message?: { content?: string } }> | undefined;
  if (choices?.[0]?.message?.content) return choices[0].message.content;

  // DeepSeek 等简化的 chat 格式
  const data = json.data as { content?: string; text?: string; output?: string; response?: string } | undefined;
  if (data?.content) return data.content;
  if (data?.text) return data.text;
  if (data?.output) return data.output;
  if (data?.response) return data.response;

  // 顶层 content/text
  if (typeof json.content === 'string') return json.content;
  if (typeof json.text === 'string') return json.text;

  throw new Error('无法解析模型返回的文本内容');
}

/**
 * 通用模型的图片响应解析 — 兼容多格式
 */
function parseGeneralImageResponse(json: Record<string, unknown>): string | undefined {
  // OpenAI Images
  const dataArr = json.data as Array<{ url?: string; b64_json?: string }> | undefined;
  if (dataArr?.[0]?.url) return dataArr[0].url;
  if (dataArr?.[0]?.b64_json) return toImageDataUrl(dataArr[0].b64_json);

  // result.images 格式（异步任务）
  const images = (json.result as Record<string, Array<{ url: string[] }>>)?.['images'];
  if (images?.[0]?.url?.[0]) return images[0].url[0];

  // 顶层 url
  if (typeof json.url === 'string') return json.url;

  return undefined;
}

/**
 * 调用 OpenAI 兼容的 /chat/completions 接口生成文本
 * 根据 provider 自动解析 API Key 和 Base URL
 * 支持多模态：当 prompt 中引用图片节点时，自动构建 image_url 格式的 content 数组
 */
export async function generateText(params: AIGenerateParams): Promise<string> {
  const { prompt: rawPrompt, model, provider } = params;

  const config = useAppStore.getState().config;

  let baseUrl: string;
  let apiKey: string;
  let modelName = '';

  // ── 通用模型 ──
  if (provider === 'general') {
    const gm = resolveGeneralModel(model);
    if (!gm) throw new Error('未找到该通用模型配置\n请在「设置 → API Key」中检查');
    if (!gm.openaiUrl) throw new Error(`通用模型 "${gm.name}" 未配置接口地址`);
    apiKey = gm.apiKey || '';
    baseUrl = gm.openaiUrl;
    modelName = gm.modelId;
  } else if (provider === 'localllm') {
    // 已合并到通用模型，此处保留兼容旧数据
    throw new Error('本地大模型已迁移到「通用模型」，请重新选择模型\n请在「设置 → API Key」中添加通用模型');
  } else {
    const providerConfig = config.providers[provider];
    apiKey = providerConfig?.apiKey || '';
    if (!apiKey) {
      throw new Error(`未配置 ${provider} 的 API Key\n请在「设置 → API Key」中配置`);
    }
    baseUrl = providerConfig?.baseUrl || DEFAULT_BASE_URLS[provider] || '';
  }

  if (!baseUrl) {
    throw new Error(`未配置 ${provider === 'general' ? resolveGeneralModel(model)?.name || '通用模型' : provider} 的服务地址\n请在「设置 → API Key」中添加`);
  }

  // 去掉末尾斜杠，拼接 /chat/completions
  const apiUrl = baseUrl.replace(/\/+$/, '') + '/chat/completions';

  if (provider !== 'general') {
    modelName = extractModelName(model, provider);
  }

  // 解析 @{nodeId:label} 引用：图片节点构建 image_url，其他节点内联文本
  const { content, textContent } = await resolvePromptToChatContent(rawPrompt);
  if (!textContent.trim()) {
    throw new Error('提示词不能为空');
  }

  // 将本地图片 URL 上传到远端图床，转为公网 URL
  const resolvedContent = await resolveContentImageUrls(content);

  const messages: Array<{ role: string; content: string | Array<{ type: string; text?: string; image_url?: { url: string } }> }> = [];
  messages.push({ role: 'user', content: resolvedContent });

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  // 不设超时（仅 ComfyUI 才设超时）
  const response = await fetch(apiUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: modelName,
      messages,
      stream: false,
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => '');
    let errorMsg = `API 请求失败 (${response.status})`;
    try {
      const err = JSON.parse(errorBody);
      errorMsg = err.error?.message || errorMsg;
    } catch {
      if (errorBody) errorMsg += `: ${errorBody.slice(0, 200)}`;
    }
    throw new Error(errorMsg);
  }

  const json = await response.json();
  // 通用模型使用灵活的响应解析
  const replyText = provider === 'general'
    ? parseGeneralTextResponse(json)
    : (json.choices?.[0]?.message?.content);
  if (!replyText) {
    throw new Error('模型返回结果为空');
  }
  return replyText;
}

/**
 * 调用 OpenAI 兼容的 /images/generations 接口生成图片
 * 主流图片 API 均遵循此格式（DALL-E、Flux、Stable Diffusion 等）
 * APIMart 走异步轮询路径（其 API 格式与 OpenAI 不兼容）
 */
export async function generateImage(params: AIImageGenParams): Promise<{ url: string; width: number; height: number }> {
  const { prompt: rawPrompt, model, provider, imageSize = '2K', aspectRatio = '1:1' } = params;

  // 解析 @{nodeId:label} 引用：图片 URL 提取到 image_urls，文本内联替换到 prompt
  const { prompt, imageUrls } = await resolvePromptWithImageRefs(rawPrompt);

  // 合并调用方传入的 image_urls 与从 prompt 中解析出的 imageUrls
  let allImageUrls = [...(params.image_urls || []), ...imageUrls];

  // 即梦：直接把本地/原始图片 URL 交给 CLI（CLI 端本地化），不走图床上传
  if (provider === 'dreamina') {
    if (!prompt.trim()) throw new Error('提示词不能为空');
    return generateDreaminaImage({ prompt, model, imageSize, aspectRatio, imageUrls: allImageUrls });
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
    return generateApimartImage(apiKey, baseUrl, modelName, prompt, imageSize, aspectRatio, dimensions, allImageUrls);
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

/** APIMart 图片生成 — 异步提交 + 轮询，格式与 FreeAngle 面板一致 */
async function generateApimartImage(
  apiKey: string,
  baseUrl: string,
  model: string,
  prompt: string,
  imageSize: string,
  aspectRatio: string,
  dimensions: { width: number; height: number },
  imageUrls: string[] = [],
): Promise<{ url: string; width: number; height: number }> {
  // 步骤 1: 提交生成任务
  const submitBody: Record<string, unknown> = {
    model,
    prompt,
    n: 1,
    resolution: imageSize,
    size: aspectRatio,
  };
  if (imageUrls.length > 0) {
    submitBody.image_urls = imageUrls;
  }
  const submitResp = await fetch(`${baseUrl}/images/generations`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(submitBody),
  });

  if (!submitResp.ok) {
    const errBody = await submitResp.text().catch(() => '');
    throw new Error(`APIMart 生成提交失败 (${submitResp.status}): ${errBody.slice(0, 200)}`);
  }

  const submitResult = await submitResp.json() as { code: number; data: Array<{ task_id: string; status: string }> };
  const taskId = submitResult.data?.[0]?.task_id;
  if (!taskId) {
    throw new Error('APIMart 生成提交失败: 未返回 task_id');
  }

  // 步骤 2: 轮询任务直到完成/失败（不设超时，仅 ComfyUI 才设超时）
  const POLL_INTERVAL = 2000;

  while (true) {
    const pollResp = await fetch(`${baseUrl}/tasks/${taskId}?language=zh`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    if (!pollResp.ok) {
      const errBody = await pollResp.text().catch(() => '');
      throw new Error(`APIMart 任务查询失败 (${pollResp.status}): ${errBody.slice(0, 200)}`);
    }

    const pollResult = await pollResp.json() as {
      code: number;
      data?: { status: string; progress?: number; result?: { images?: Array<{ url: string[] }> } };
      status?: string;
      progress?: number;
      result?: { images?: Array<{ url: string[] }> };
    };
    const task = pollResult.data ?? pollResult;

    if (task.status === 'completed') {
      const imageUrls = task.result?.images?.flatMap((img) => img.url) ?? [];
      if (imageUrls.length === 0) {
        throw new Error('APIMart 生成完成但未返回图片');
      }
      return { url: imageUrls[0], width: dimensions.width, height: dimensions.height };
    }

    if (task.status === 'failed' || task.status === 'error') {
      throw new Error(`APIMart 生成任务失败: ${task.status}`);
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

/** APIMart 视频生成 — 异步提交 + 轮询，与图片生成相同的任务模式 */
async function generateApimartVideo(
  apiKey: string,
  baseUrl: string,
  model: string,
  prompt: string,
): Promise<{ url: string }> {
  // 步骤 1: 提交视频生成任务
  const submitResp = await fetch(`${baseUrl}/images/generations`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      prompt,
      n: 1,
    }),
  });

  if (!submitResp.ok) {
    const errBody = await submitResp.text().catch(() => '');
    throw new Error(`APIMart 视频提交失败 (${submitResp.status}): ${errBody.slice(0, 200)}`);
  }

  const submitResult = await submitResp.json() as { code: number; data: Array<{ task_id: string; status: string }> };
  const taskId = submitResult.data?.[0]?.task_id;
  if (!taskId) {
    throw new Error('APIMart 视频提交失败: 未返回 task_id');
  }

  // 步骤 2: 轮询（不设超时，仅 ComfyUI 才设超时）
  const POLL_INTERVAL = 3000;         // 3 秒轮询

  while (true) {
    const pollResp = await fetch(`${baseUrl}/tasks/${taskId}?language=zh`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    if (!pollResp.ok) {
      const errBody = await pollResp.text().catch(() => '');
      throw new Error(`APIMart 视频任务查询失败 (${pollResp.status}): ${errBody.slice(0, 200)}`);
    }

    const pollResult = await pollResp.json() as {
      code: number;
      data?: {
        status: string;
        progress?: number;
        result?: {
          images?: Array<{ url: string[] }>;
          videos?: Array<{ url: string[] }>;
        };
      };
      status?: string;
      progress?: number;
      result?: {
        images?: Array<{ url: string[] }>;
        videos?: Array<{ url: string[] }>;
      };
    };
    const task = pollResult.data ?? pollResult;

    if (task.status === 'completed') {
      // 优先取 videos，其次 images
      const videoUrls = task.result?.videos?.flatMap((v) => v.url) ?? [];
      const imageUrls = task.result?.images?.flatMap((img) => img.url) ?? [];
      const allUrls = videoUrls.length > 0 ? videoUrls : imageUrls;
      if (allUrls.length === 0) {
        throw new Error('APIMart 视频生成完成但未返回结果');
      }
      return { url: allUrls[0] };
    }

    if (task.status === 'failed' || task.status === 'error') {
      throw new Error(`APIMart 视频生成任务失败: ${task.status}`);
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

/** 解析 prompt 中的 @{nodeId:label} 引用，返回适合 /chat/completions 的 content 字段
 *  - 仅含文本引用时返回纯字符串
 *  - 含图片引用时返回多模态数组 [{type:"text",text:...}, {type:"image_url",image_url:{url:...}}]
 *  同时返回纯文本版本 textContent，用于空值校验和系统提示拼接
 *  图片节点有蒙版/标注时自动合并到原图 */
async function resolvePromptToChatContent(rawPrompt: string): Promise<{
  content: string | Array<{ type: string; text?: string; image_url?: { url: string } }>;
  textContent: string;
}> {
  const { nodes } = useAppStore.getState();
  const chipRegex = /@asset\{([^}]+)\}|@\{([^:]+):([^}]+)\}/g;
  const imageEntries: Array<{ url: string; mattingMask?: string; annotation?: string; filePath?: string }> = [];
  // 多参考图：按 prompt 中首次出现顺序为每张图编号（去重），芯片原位替换成「图片N」，
  // 让模型能把 image_urls[N-1] 与文本里的「图片N」角色对应起来。
  const imageKeyToIndex = new Map<string, number>();
  const parts: string[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = chipRegex.exec(rawPrompt)) !== null) {
    // 保留 chip 之前的文本
    if (match.index > lastIndex) {
      parts.push(rawPrompt.slice(lastIndex, match.index));
    }

    // 资产引用：图片资产读为 data URL 作为参考图，原位替换成「图片N」；其余忽略
    if (match[1] !== undefined) {
      let assetPath = match[1];
      try { assetPath = decodeURIComponent(match[1]); } catch { /* keep raw */ }
      const assetName = assetPath.split(/[\\/]/).pop() || '';
      if (getFileCategory(assetName) === 'image') {
        const key = `asset:${match[1]}`;
        let idx = imageKeyToIndex.get(key);
        if (idx === undefined) {
          const dataUrl = await readFileToDataUrl(assetPath);
          if (dataUrl) {
            idx = imageEntries.length + 1;
            imageKeyToIndex.set(key, idx);
            imageEntries.push({ url: dataUrl });
          }
        }
        if (idx !== undefined) parts.push(`图片${idx}`);
      }
      lastIndex = chipRegex.lastIndex;
      continue;
    }

    const nodeId = match[2];
    const node = nodes.find((n) => n.id === nodeId);
    if (!node) {
      parts.push(match[0]); // 未找到节点则保留原文
    } else {
      const nodeType = (node.data.type as string) || '';
      // 图片类节点：提取 imageUrl 到 image_urls，原位替换成「图片N」
      if (nodeType === 'ai-image' || nodeType === 'source-image') {
        const imageUrl = node.data.imageUrl as string | undefined;
        if (typeof imageUrl === 'string' && imageUrl.trim()) {
          const key = `node:${nodeId}`;
          let idx = imageKeyToIndex.get(key);
          if (idx === undefined) {
            idx = imageEntries.length + 1;
            imageKeyToIndex.set(key, idx);
            imageEntries.push({
              url: imageUrl,
              mattingMask: (node.data.mattingMask as string | undefined) || undefined,
              annotation: (node.data.annotation as string | undefined) || undefined,
              filePath: (node.data.filePath as string | undefined) || undefined,
            });
          }
          parts.push(`图片${idx}`);
        }
      } else {
        // 文本/视频/音频节点：内联替换 output/url
        const output = node.data.output as string | undefined;
        if (typeof output === 'string' && output.trim()) {
          parts.push(output);
        } else {
          const videoUrl = node.data.videoUrl as string | undefined;
          if (typeof videoUrl === 'string' && videoUrl.trim()) {
            parts.push(videoUrl);
          } else {
            const audioUrl = node.data.audioUrl as string | undefined;
            if (typeof audioUrl === 'string' && audioUrl.trim()) {
              parts.push(audioUrl);
            }
          }
        }
      }
    }
    lastIndex = chipRegex.lastIndex;
  }

  // 保留最后一个 chip 之后的文本
  if (lastIndex < rawPrompt.length) {
    parts.push(rawPrompt.slice(lastIndex));
  }

  const textContent = parts.join('').trim();

  // 无图片时返回纯字符串
  if (imageEntries.length === 0) {
    return { content: textContent || rawPrompt.trim(), textContent: textContent || rawPrompt.trim() };
  }

  // 线上图片先验证可达性（失效改用本地），再合并蒙版/标注（异步）
  const imageUrls = await Promise.all(
    imageEntries.map(async (entry) => {
      const url = await resolveNodeImageUrl(entry.url, entry.filePath);
      if (!entry.mattingMask && !entry.annotation) return url;
      try {
        return await mergeImageWithOverlays(url, entry.mattingMask, entry.annotation);
      } catch (err) {
        console.error('[aiService] Failed to merge overlays:', err);
        return url;
      }
    }),
  );

  // 含图片时构建多模态数组
  const contentArr: Array<{ type: string; text?: string; image_url?: { url: string } }> = [];
  if (textContent) {
    contentArr.push({ type: 'text', text: textContent });
  }
  for (const url of imageUrls) {
    contentArr.push({ type: 'image_url', image_url: { url } });
  }

  return { content: contentArr, textContent: textContent || rawPrompt.trim() };
}

/** 解析 prompt 中的 @{nodeId:label} 引用：图片节点 URL 提取到 image_urls，文本/视频/音频节点内联替换到 prompt
 *  图片节点有蒙版/标注时自动合并到原图 */
async function resolvePromptWithImageRefs(rawPrompt: string): Promise<{ prompt: string; imageUrls: string[] }> {
  const { nodes } = useAppStore.getState();
  const imageEntries: Array<{ url: string; mattingMask?: string; annotation?: string; filePath?: string }> = [];

  // 预读图片资产为 data URL（replace 回调是同步的，需提前异步读取）
  const assetImageMap = new Map<string, string>();
  for (const m of rawPrompt.matchAll(/@asset\{([^}]+)\}/g)) {
    let p = m[1];
    try { p = decodeURIComponent(m[1]); } catch { /* keep raw */ }
    const name = p.split(/[\\/]/).pop() || '';
    if (getFileCategory(name) === 'image' && !assetImageMap.has(m[1])) {
      const dataUrl = await readFileToDataUrl(p);
      if (dataUrl) assetImageMap.set(m[1], dataUrl);
    }
  }

  // 多参考图：按首次出现顺序编号、去重；芯片原位替换成「图片N」，与 image_urls 同序对应
  const imageKeyToIndex = new Map<string, number>();

  const chipRegex = /@asset\{([^}]+)\}|@\{([^:]+):([^}]+)\}/g;
  const prompt = rawPrompt.replace(chipRegex, (_match, assetEnc: string | undefined, nodeId: string) => {
    // 资产引用：图片入 image_urls，原位替换成「图片N」；非图片忽略
    if (assetEnc !== undefined) {
      const dataUrl = assetImageMap.get(assetEnc);
      if (!dataUrl) return '';
      const key = `asset:${assetEnc}`;
      let idx = imageKeyToIndex.get(key);
      if (idx === undefined) {
        idx = imageEntries.length + 1;
        imageKeyToIndex.set(key, idx);
        imageEntries.push({ url: dataUrl });
      }
      return `图片${idx}`;
    }
    const node = nodes.find((n) => n.id === nodeId);
    if (!node) return '';

    const nodeType = (node.data.type as string) || '';

    // 图片类节点（ai-image / source-image）：提取 imageUrl 到 image_urls，原位替换成「图片N」
    if (nodeType === 'ai-image' || nodeType === 'source-image') {
      const imageUrl = node.data.imageUrl as string | undefined;
      if (typeof imageUrl !== 'string' || !imageUrl.trim()) return '';
      const key = `node:${nodeId}`;
      let idx = imageKeyToIndex.get(key);
      if (idx === undefined) {
        idx = imageEntries.length + 1;
        imageKeyToIndex.set(key, idx);
        imageEntries.push({
          url: imageUrl,
          mattingMask: (node.data.mattingMask as string | undefined) || undefined,
          annotation: (node.data.annotation as string | undefined) || undefined,
          filePath: (node.data.filePath as string | undefined) || undefined,
        });
      }
      return `图片${idx}`;
    }

    // 文本节点：内联替换 output
    if (nodeType === 'ai-text' || nodeType === 'source-text') {
      const output = node.data.output as string | undefined;
      if (typeof output === 'string' && output.trim()) return output;
      return '';
    }

    // 视频 / 音频节点：内联替换对应 URL
    const videoUrl = node.data.videoUrl as string | undefined;
    if (typeof videoUrl === 'string' && videoUrl.trim()) return videoUrl;
    const audioUrl = node.data.audioUrl as string | undefined;
    if (typeof audioUrl === 'string' && audioUrl.trim()) return audioUrl;

    return '';
  }).trim();

  // 线上图片先验证可达性（失效改用本地），再合并蒙版/标注（异步）
  const imageUrls = await Promise.all(
    imageEntries.map(async (entry) => {
      const url = await resolveNodeImageUrl(entry.url, entry.filePath);
      if (!entry.mattingMask && !entry.annotation) return url;
      try {
        return await mergeImageWithOverlays(url, entry.mattingMask, entry.annotation);
      } catch (err) {
        console.error('[aiService] Failed to merge overlays:', err);
        return url; // 合并失败时回退到原图
      }
    }),
  );

  return { prompt, imageUrls };
}

/** 视频生成入口 */
export async function generateVideo(params: AIVideoGenParams): Promise<{ url: string }> {
  const { prompt: rawPrompt, model, provider } = params;

  // 解析 @{nodeId:label} 引用为对应节点的实际输出内容
  const prompt = resolveNodeReferences(rawPrompt);

  // ComfyUI 工作流执行路径
  if (params.workflowId) {
    return executeComfyUIVideoGenerate({ ...params, prompt });
  }

  // 即梦视频：无参考图 → text2video；有参考图 → image2video
  if (provider === 'dreamina') {
    const { prompt: dreaminaPrompt, imageUrls } = await resolvePromptWithImageRefs(rawPrompt);
    if (!dreaminaPrompt.trim()) throw new Error('提示词不能为空');
    return generateDreaminaVideo({ prompt: dreaminaPrompt, model, imageUrls });
  }

  // APIMart 视频生成 — 异步提交 + 轮询
  if (provider === 'apimart') {
    const config = useAppStore.getState().config;
    const providerConfig = config.providers.apimart;
    const apiKey = providerConfig?.apiKey || '';
    if (!apiKey) {
      throw new Error('未配置 apimart 的 API Key\n请在「设置 → API Key」中配置');
    }
    const baseUrl = (providerConfig?.baseUrl || DEFAULT_BASE_URLS.apimart || '').replace(/\/+$/, '');
    if (!baseUrl) {
      throw new Error('未配置 apimart 的服务地址\n请在「设置 → API Key」中添加');
    }
    const modelName = extractModelName(model, provider);
    return generateApimartVideo(apiKey, baseUrl, modelName, prompt);
  }

  // ── 通用模型视频生成 ──
  if (provider === 'general') {
    const gm = resolveGeneralModel(model);
    if (!gm) throw new Error('未找到该通用模型配置\n请在「设置 → API Key」中检查');
    if (!gm.openaiUrl) throw new Error(`通用模型 "${gm.name}" 未配置接口地址`);
    return executeGeneralAsyncTask(gm.apiKey || '', gm.openaiUrl, gm.modelId, prompt, 'videos');
  }

  // 无 workflowId 时暂不支持直接调用 API，提示配置
  throw new Error('视频生成需要选择 ComfyUI 工作流\n请在模型选择器中导入并选择工作流');
}

// ============================================
// 音频生成
// ============================================

/** APIMart 音频生成 — 异步提交 + 轮询，与图片/视频生成相同的任务模式 */
async function generateApimartAudio(
  apiKey: string,
  baseUrl: string,
  model: string,
  prompt: string,
): Promise<{ url: string }> {
  // 步骤 1: 提交音频生成任务
  const submitResp = await fetch(`${baseUrl}/images/generations`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      prompt,
      n: 1,
    }),
  });

  if (!submitResp.ok) {
    const errBody = await submitResp.text().catch(() => '');
    throw new Error(`APIMart 音频提交失败 (${submitResp.status}): ${errBody.slice(0, 200)}`);
  }

  const submitResult = await submitResp.json() as { code: number; data: Array<{ task_id: string; status: string }> };
  const taskId = submitResult.data?.[0]?.task_id;
  if (!taskId) {
    throw new Error('APIMart 音频提交失败: 未返回 task_id');
  }

  // 步骤 2: 轮询（不设超时，仅 ComfyUI 才设超时）
  const POLL_INTERVAL = 3000;         // 3 秒轮询

  while (true) {
    const pollResp = await fetch(`${baseUrl}/tasks/${taskId}?language=zh`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    if (!pollResp.ok) {
      const errBody = await pollResp.text().catch(() => '');
      throw new Error(`APIMart 音频任务查询失败 (${pollResp.status}): ${errBody.slice(0, 200)}`);
    }

    const pollResult = await pollResp.json() as {
      code: number;
      data?: {
        status: string;
        progress?: number;
        result?: {
          audios?: Array<{ url: string[] }>;
          images?: Array<{ url: string[] }>;
          videos?: Array<{ url: string[] }>;
        };
      };
      status?: string;
      progress?: number;
      result?: {
        audios?: Array<{ url: string[] }>;
        images?: Array<{ url: string[] }>;
        videos?: Array<{ url: string[] }>;
      };
    };
    const task = pollResult.data ?? pollResult;

    if (task.status === 'completed') {
      // 优先取 audios，其次 fallback
      const audioUrls = task.result?.audios?.flatMap((a) => a.url) ?? [];
      const allUrls = audioUrls.length > 0 ? audioUrls : [];
      if (allUrls.length === 0) {
        throw new Error('APIMart 音频生成完成但未返回结果');
      }
      return { url: allUrls[0] };
    }

    if (task.status === 'failed' || task.status === 'error') {
      throw new Error(`APIMart 音频生成任务失败: ${task.status}`);
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

/** 音频生成入口 */
export async function generateAudio(params: AIAudioGenParams): Promise<{ url: string }> {
  const { prompt: rawPrompt, model, provider } = params;

  // 解析 @{nodeId:label} 引用为对应节点的实际输出内容
  const prompt = resolveNodeReferences(rawPrompt);

  // ComfyUI 工作流执行路径
  if (params.workflowId) {
    return executeComfyUIAudioGenerate({ ...params, prompt });
  }

  // APIMart 音频生成 — 异步提交 + 轮询
  if (provider === 'apimart') {
    const config = useAppStore.getState().config;
    const providerConfig = config.providers.apimart;
    const apiKey = providerConfig?.apiKey || '';
    if (!apiKey) {
      throw new Error('未配置 apimart 的 API Key\n请在「设置 → API Key」中配置');
    }
    const baseUrl = (providerConfig?.baseUrl || DEFAULT_BASE_URLS.apimart || '').replace(/\/+$/, '');
    if (!baseUrl) {
      throw new Error('未配置 apimart 的服务地址\n请在「设置 → API Key」中添加');
    }
    const modelName = extractModelName(model, provider);
    return generateApimartAudio(apiKey, baseUrl, modelName, prompt);
  }

  // ── 通用模型音频生成 ──
  if (provider === 'general') {
    const gm = resolveGeneralModel(model);
    if (!gm) throw new Error('未找到该通用模型配置\n请在「设置 → API Key」中检查');
    if (!gm.openaiUrl) throw new Error(`通用模型 "${gm.name}" 未配置接口地址`);
    return executeGeneralAsyncTask(gm.apiKey || '', gm.openaiUrl, gm.modelId, prompt, 'audios');
  }

  // 无 workflowId 时暂不支持直接调用 API，提示配置
  throw new Error('音频生成需要选择 ComfyUI 工作流\n请在模型选择器中导入并选择工作流');
}

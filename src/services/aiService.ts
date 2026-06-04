/**
 * aiService AI 生成服务 — 统一封装各厂商 AI 生成 API，支持文本/图像/视频/音频生成、ComfyUI/RunningHUB 工作流执行
 */
import { useAppStore } from '../store/useAppStore';
import type { WorkflowIONode } from '../types';

/** 本地模型调用超时（30 分钟） */
const LOCAL_MODEL_TIMEOUT_MS = 30 * 60 * 1000;

const DEFAULT_BASE_URLS: Record<string, string> = {
  openai: 'https://api.openai.com',
  ppio: 'https://api.ppio.ai',
  apimart: 'https://api.apimart.ai/v1',
  volcengine: 'https://ark.cn-beijing.volces.com/api/v3',
  grsai: 'https://api.grsai.com',
  dreamina: 'https://api.dreamina.com',
  runninghub: 'https://api.runninghub.cn',
  runninghubwf: 'https://api.runninghub.cn',
};

/** 去掉 model value 中的 provider/ 前缀，得到实际的模型名 */
function extractModelName(modelValue: string, provider: string): string {
  const prefix = `${provider}/`;
  if (modelValue.startsWith(prefix)) {
    return modelValue.slice(prefix.length);
  }
  return modelValue;
}

export interface AIGenerateParams {
  prompt: string;
  model: string;      // model value (e.g. 'ppio/qwen/qwen3.5-397b-a17b')
  provider: string;   // provider id (e.g. 'ppio')
}

export interface AIImageGenParams extends AIGenerateParams {
  imageSize?: string;     // '1K' | '2K' | '4K'
  aspectRatio?: string;   // '1:1' | '16:9' | '9:16' | ...
  image_urls?: string[];  // 参考图片 URL（从 @图片节点 引用中提取）
  workflowId?: string;    // ComfyUI 工作流 ID（存在时走 ComfyUI 执行）
  workflowInputs?: Record<string, string>; // IO 节点赋值映射
}

export interface AIVideoGenParams {
  prompt: string;
  model: string;
  provider: string;
  videoResolution?: number;  // 视频分辨率 (e.g. 832)
  videoFps?: number;         // 帧率 (e.g. 24)
  videoFrames?: number;      // 帧数 (e.g. 77)
  workflowId?: string;       // ComfyUI 工作流 ID
  workflowInputs?: Record<string, string>; // IO 节点赋值映射
}

/** 将画质 + 比例映射为像素尺寸 */
function mapImageDimensions(
  imageSize: string,
  aspectRatio: string,
): { width: number; height: number } {
  const shortSideMap: Record<string, number> = { '720p': 720, '1K': 1024, '2K': 2048, '4K': 4096 };
  const shortSide = shortSideMap[imageSize] || 1024;

  const [w, h] = aspectRatio.split(':').map(Number);
  if (!w || !h) return { width: shortSide, height: shortSide };

  if (w >= h) {
    return { width: Math.round(shortSide * (w / h)), height: shortSide };
  }
  return { width: shortSide, height: Math.round(shortSide * (h / w)) };
}

/**
 * 调用 OpenAI 兼容的 /chat/completions 接口生成文本
 * 根据 provider 自动解析 API Key 和 Base URL
 */
export async function generateText(params: AIGenerateParams): Promise<string> {
  const { prompt: rawPrompt, model, provider } = params;

  // 解析 @{nodeId:label} 引用为对应节点的实际输出内容
  const prompt = resolveNodeReferences(rawPrompt);
  if (!prompt.trim()) {
    throw new Error('提示词不能为空');
  }

  const config = useAppStore.getState().config;

  let baseUrl: string;
  let apiKey: string;

  if (provider === 'localllm') {
    baseUrl = config.localLLMUrl?.trim() || '';
    apiKey = '';
    if (!baseUrl) {
      throw new Error('未配置本地大模型调用地址\n请在「设置 → 服务地址」中配置');
    }
  } else {
    const providerConfig = config.providers[provider];
    apiKey = providerConfig?.apiKey || '';
    if (!apiKey) {
      throw new Error(`未配置 ${provider} 的 API Key\n请在「设置 → API Key」中配置`);
    }
    baseUrl = providerConfig?.baseUrl || DEFAULT_BASE_URLS[provider] || '';
  }

  if (!baseUrl) {
    throw new Error(`未配置 ${provider} 的服务地址\n请在「设置 → API Key」中添加`);
  }

  // 去掉末尾斜杠，拼接 /chat/completions
  const apiUrl = baseUrl.replace(/\/+$/, '') + '/chat/completions';

  const modelName = extractModelName(model, provider);

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  const controller = new AbortController();
  const timeoutId = provider === 'localllm' ? setTimeout(() => controller.abort(), LOCAL_MODEL_TIMEOUT_MS) : undefined;

  const response = await fetch(apiUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: modelName,
      messages: [{ role: 'user', content: prompt }],
      stream: false,
    }),
    signal: controller.signal,
  }).finally(() => {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
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
  const content = json.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error('模型返回结果为空');
  }
  return content;
}

/**
 * 调用 OpenAI 兼容的 /images/generations 接口生成图片
 * 主流图片 API 均遵循此格式（DALL-E、Flux、Stable Diffusion 等）
 * APIMart 走异步轮询路径（其 API 格式与 OpenAI 不兼容）
 */
export async function generateImage(params: AIImageGenParams): Promise<{ url: string; width: number; height: number }> {
  const { prompt: rawPrompt, model, provider, imageSize = '2K', aspectRatio = '1:1' } = params;

  // 解析 @{nodeId:label} 引用：图片 URL 提取到 image_urls，文本内联替换到 prompt
  const { prompt, imageUrls } = resolvePromptWithImageRefs(rawPrompt);

  // 合并调用方传入的 image_urls 与从 prompt 中解析出的 imageUrls
  const allImageUrls = [...(params.image_urls || []), ...imageUrls];

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
    let apiKey: string;
    let baseUrl: string;
    const providerConfig = config.providers.apimart;
    apiKey = providerConfig?.apiKey || '';
    if (!apiKey) {
      throw new Error('未配置 apimart 的 API Key\n请在「设置 → API Key」中配置');
    }
    baseUrl = providerConfig?.baseUrl || DEFAULT_BASE_URLS.apimart || '';
    if (!baseUrl) {
      throw new Error('未配置 apimart 的服务地址\n请在「设置 → API Key」中添加');
    }
    baseUrl = baseUrl.replace(/\/+$/, '');
    const modelName = extractModelName(model, provider);
    const dimensions = mapImageDimensions(imageSize, aspectRatio);
    return generateApimartImage(apiKey, baseUrl, modelName, prompt, imageSize, aspectRatio, dimensions, allImageUrls);
  }

  const dimensions = mapImageDimensions(imageSize, aspectRatio);

  let baseUrl: string;
  let apiKey: string;

  if (provider === 'localllm') {
    baseUrl = config.localLLMUrl?.trim() || '';
    apiKey = '';
    if (!baseUrl) {
      throw new Error('未配置本地大模型调用地址\n请在「设置 → 服务地址」中配置');
    }
  } else {
    const providerConfig = config.providers[provider];
    apiKey = providerConfig?.apiKey || '';
    if (!apiKey) {
      throw new Error(`未配置 ${provider} 的 API Key\n请在「设置 → API Key」中配置`);
    }
    baseUrl = providerConfig?.baseUrl || DEFAULT_BASE_URLS[provider] || '';
  }

  if (!baseUrl) {
    throw new Error(`未配置 ${provider} 的服务地址\n请在「设置 → API Key」中添加`);
  }

  // 图片生成端点
  const apiUrl = baseUrl.replace(/\/+$/, '') + '/images/generations';

  const modelName = extractModelName(model, provider);
  const sizeStr = `${dimensions.width}x${dimensions.height}`;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  const controller = new AbortController();
  const timeoutId = provider === 'localllm' ? setTimeout(() => controller.abort(), LOCAL_MODEL_TIMEOUT_MS) : undefined;

  const requestBody: Record<string, unknown> = {
    model: modelName,
    prompt,
    n: 1,
    size: sizeStr,
    response_format: 'url',
  };
  if (allImageUrls.length > 0) {
    requestBody.image_urls = allImageUrls;
  }

  const response = await fetch(apiUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(requestBody),
    signal: controller.signal,
  }).finally(() => {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
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
  const imageUrl = json.data?.[0]?.url || json.data?.[0]?.b64_json;
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

  // 步骤 2: 轮询任务直到完成
  const MAX_WAIT_MS = 5 * 60 * 1000;
  const POLL_INTERVAL = 2000;
  const start = Date.now();

  while (Date.now() - start < MAX_WAIT_MS) {
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

  throw new Error('APIMart 生成任务超时，请稍后再试');
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

  // 步骤 2: 轮询（视频生成时间更长，延长超时和间隔）
  const MAX_WAIT_MS = 15 * 60 * 1000; // 15 分钟
  const POLL_INTERVAL = 3000;         // 3 秒轮询
  const start = Date.now();

  while (Date.now() - start < MAX_WAIT_MS) {
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

  throw new Error('APIMart 视频生成任务超时，请稍后再试');
}

// ============================================
// ComfyUI 工作流执行
// ============================================

/** 从 Store 获取 ComfyUI 配置并校验 */
function getComfyUIConfig() {
  const config = useAppStore.getState().config;
  const comfyUrl = config.comfyUIUrl?.trim();
  if (!comfyUrl) {
    throw new Error('未配置 ComfyUI 服务地址\n请在「设置 → 服务地址」中配置');
  }
  return comfyUrl.replace(/\/+$/, '');
}

/** 解析 workflowInputs 值中的 @{nodeId:label} 引用，替换为对应节点的实际输出内容 */
function resolveNodeReferences(value: string): string {
  const { nodes } = useAppStore.getState();
  const chipRegex = /@\{([^:]+):([^}]+)\}/g;
  return value.replace(chipRegex, (_match, nodeId: string) => {
    const node = nodes.find((n) => n.id === nodeId);
    if (!node) return _match;
    // 文本节点的输出在 data.output 中
    const output = node.data.output as string | undefined;
    if (typeof output === 'string' && output.trim()) return output;
    // 图片节点的输出在 data.imageUrl 中
    const imageUrl = node.data.imageUrl as string | undefined;
    if (typeof imageUrl === 'string' && imageUrl.trim()) return imageUrl;
    // 视频 / 音频同理
    const videoUrl = node.data.videoUrl as string | undefined;
    if (typeof videoUrl === 'string' && videoUrl.trim()) return videoUrl;
    const audioUrl = node.data.audioUrl as string | undefined;
    if (typeof audioUrl === 'string' && audioUrl.trim()) return audioUrl;
    // 无法解析，保留原文
    return _match;
  });
}

/** 解析 prompt 中的 @{nodeId:label} 引用：图片节点 URL 提取到 image_urls，文本/视频/音频节点内联替换到 prompt */
function resolvePromptWithImageRefs(rawPrompt: string): { prompt: string; imageUrls: string[] } {
  const { nodes } = useAppStore.getState();
  const chipRegex = /@\{([^:]+):([^}]+)\}/g;
  const imageUrls: string[] = [];

  const prompt = rawPrompt.replace(chipRegex, (_match, nodeId: string) => {
    const node = nodes.find((n) => n.id === nodeId);
    if (!node) return '';

    const nodeType = (node.data.type as string) || '';

    // 图片类节点（ai-image / source-image）：提取 imageUrl 到 image_urls，从 prompt 中移除 chip
    if (nodeType === 'ai-image' || nodeType === 'source-image') {
      const imageUrl = node.data.imageUrl as string | undefined;
      if (typeof imageUrl === 'string' && imageUrl.trim()) {
        imageUrls.push(imageUrl);
      }
      return '';
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

  return { prompt, imageUrls };
}

/** 将提示词注入到 ComfyUI workflow JSON 的 prompt 类型 IO 节点中 */
function injectPromptsIntoWorkflow(
  workflowObj: Record<string, Record<string, unknown>>,
  workflowInputs: Record<string, string> | undefined,
  fallbackPrompt: string,
  ioNodeIds: string[],
): void {
  if (!workflowInputs || Object.keys(workflowInputs).length === 0) {
    // 没有 explicit IO 赋值时，遍历所有文本节点做兜底替换
    for (const [, nodeData] of Object.entries(workflowObj)) {
      if (!nodeData || typeof nodeData !== 'object') continue;
      const inputs = nodeData.inputs as Record<string, unknown> | undefined;
      if (!inputs) continue;
      const textKey = Object.keys(inputs).find((k) => (k === 'text' || k === 'prompt') && typeof inputs[k] === 'string');
      if (!textKey || !(inputs[textKey] as string)?.trim()) continue;
      const currentValue = (inputs[textKey] as string) || '';
      // 只替换短占位符（如 "t-1"）
      if (currentValue.length < 10 && !currentValue.includes(' ')) {
        inputs[textKey] = fallbackPrompt;
      }
    }
    return;
  }

  // 有 explicit IO 赋值：只替换用户在 workflowInputs 中明确赋值的节点，未被 @ 的节点保持原值
  const mentionedNodeIds = Object.keys(workflowInputs);
  for (const ioNodeId of mentionedNodeIds) {
    // 只处理同时存在于 ioNodeIds 和 workflowInputs 中的节点（被 @ 命中的）
    if (!ioNodeIds.includes(ioNodeId)) continue;

    const rawValue = workflowInputs[ioNodeId];
    const resolvedValue = rawValue !== undefined ? resolveNodeReferences(rawValue) : undefined;
    const finalValue = (resolvedValue && resolvedValue.trim()) ? resolvedValue : fallbackPrompt;

    const jsonNode = workflowObj[ioNodeId];
    if (!jsonNode) continue;
    const inputs = jsonNode.inputs as Record<string, unknown> | undefined;
    if (!inputs) continue;

    const textKey = Object.keys(inputs).find((k) => (k === 'text' || k === 'prompt'));
    if (textKey) {
      inputs[textKey] = finalValue;
    }
  }
}

/** 将图片上传到 ComfyUI 服务器，返回 filename/subfolder/type */
async function uploadImageToComfyUI(
  baseUrl: string,
  imageUrl: string,
): Promise<{ name: string; subfolder?: string; type?: string }> {
  // 1. 获取图片 Blob（支持 data URL 和远程 URL）
  let blob: Blob;
  let ext = 'png';

  if (imageUrl.startsWith('data:')) {
    // data URL → 直接解析
    const match = imageUrl.match(/^data:(image\/\w+);base64,(.+)$/);
    if (!match) throw new Error('不支持的 data URL 格式');
    const mimeType = match[1];
    const base64 = match[2];
    const byteChars = atob(base64);
    const byteArr = new Uint8Array(byteChars.length);
    for (let i = 0; i < byteChars.length; i++) {
      byteArr[i] = byteChars.charCodeAt(i);
    }
    blob = new Blob([byteArr], { type: mimeType });
    ext = mimeType.split('/')[1] || 'png';
  } else {
    // 远程 URL → fetch 获取
    const response = await fetch(imageUrl);
    if (!response.ok) {
      throw new Error(`下载图片失败 (${response.status})`);
    }
    blob = await response.blob();
    // 从 Content-Type 或 URL 推断扩展名
    const contentType = response.headers.get('Content-Type') || '';
    ext = contentType.split('/')[1] || imageUrl.split('.').pop()?.split('?')[0] || 'png';
  }

  // 2. 上传到 ComfyUI /upload/image
  const formData = new FormData();
  formData.append('image', blob, `upload_${Date.now()}.${ext}`);
  // 覆盖同名文件，避免重复堆积
  formData.append('overwrite', 'true');

  const uploadRes = await fetch(`${baseUrl}/upload/image`, {
    method: 'POST',
    body: formData,
  });

  if (!uploadRes.ok) {
    const errorBody = await uploadRes.text().catch(() => '');
    throw new Error(`ComfyUI 图片上传失败 (${uploadRes.status})${errorBody ? ': ' + errorBody.slice(0, 200) : ''}`);
  }

  const uploadResult = (await uploadRes.json()) as { name: string; subfolder?: string; type?: string };
  if (!uploadResult.name) {
    throw new Error('ComfyUI 上传返回结果异常：缺少文件名');
  }

  return uploadResult;
}

/** 将图片注入到 ComfyUI workflow JSON 的 image 类型 IO 节点中 */
async function injectImagesIntoWorkflow(
  workflowObj: Record<string, Record<string, unknown>>,
  workflowInputs: Record<string, string> | undefined,
  ioNodes: WorkflowIONode[],
  baseUrl: string,
): Promise<void> {
  if (!workflowInputs || Object.keys(workflowInputs).length === 0) return;

  // 构建 nodeId → type 映射
  const typeMap = new Map(ioNodes.map((io) => [io.nodeId, io.type]));

  const mentionedNodeIds = Object.keys(workflowInputs);
  for (const ioNodeId of mentionedNodeIds) {
    // 只处理 image 类型的 IO 节点
    if (typeMap.get(ioNodeId) !== 'image') continue;

    const rawValue = workflowInputs[ioNodeId];
    // 解析 @{nodeId:label} 引用，获取实际图片 URL
    const resolvedValue = rawValue !== undefined ? resolveNodeReferences(rawValue) : '';
    if (!resolvedValue || !resolvedValue.trim()) continue;

    const imageUrl = resolvedValue.trim();

    // 跳过无效值（比如解析后仍然是 @{...} 占位符）
    if (imageUrl.startsWith('@{')) continue;

    // 上传图片到 ComfyUI
    const uploadResult = await uploadImageToComfyUI(baseUrl, imageUrl);

    // 写入工作流 JSON：LoadImage 节点的 inputs.image 为上传后的文件名
    const jsonNode = workflowObj[ioNodeId];
    if (!jsonNode) continue;
    const inputs = jsonNode.inputs as Record<string, unknown> | undefined;
    if (!inputs) continue;

    inputs.image = uploadResult.name;
    // 标准 ComfyUI LoadImage 节点还需要 upload 字段
    if (inputs.upload !== undefined) {
      inputs.upload = 'image';
    }
  }
}

/** 将画布选择的尺寸/比例注入到被 @ 提及的节点中；若未指定任何节点则全量注入 */
function injectDimensionsIntoWorkflow(
  workflowObj: Record<string, Record<string, unknown>>,
  imageSize: string,
  aspectRatio: string,
  mentionedNodeIds?: string[],
): void {
  const dims = mapImageDimensions(imageSize, aspectRatio);
  for (const [nodeId, nodeData] of Object.entries(workflowObj)) {
    if (!nodeData || typeof nodeData !== 'object') continue;
    // 有指定节点时，只修改被 @ 的节点
    if (mentionedNodeIds && mentionedNodeIds.length > 0 && !mentionedNodeIds.includes(nodeId)) continue;
    const inputs = nodeData.inputs as Record<string, unknown> | undefined;
    if (!inputs) continue;
    // 匹配包含 width 和 height 的节点（EmptyLatentImage、EmptySD3LatentImage 等）
    if (inputs.width !== undefined && typeof inputs.width === 'number' && inputs.height !== undefined && typeof inputs.height === 'number') {
      inputs.width = dims.width;
      inputs.height = dims.height;
    }
  }
}

/** 将视频参数注入到被 @ 提及的节点中；若未指定任何节点则全量注入 */
function injectVideoParamsIntoWorkflow(
  workflowObj: Record<string, Record<string, unknown>>,
  videoResolution: number,
  videoFps: number,
  videoFrames: number,
  mentionedNodeIds?: string[],
): void {
  for (const [nodeId, nodeData] of Object.entries(workflowObj)) {
    if (!nodeData || typeof nodeData !== 'object') continue;
    // 有指定节点时，只修改被 @ 的节点
    if (mentionedNodeIds && mentionedNodeIds.length > 0 && !mentionedNodeIds.includes(nodeId)) continue;
    const inputs = nodeData.inputs as Record<string, unknown> | undefined;
    if (!inputs) continue;

    // 注入 width/height 到 latent 或 image 节点
    if (inputs.width !== undefined && typeof inputs.width === 'number' && inputs.height !== undefined && typeof inputs.height === 'number') {
      inputs.width = videoResolution;
      inputs.height = videoResolution;
    }

    // 注入帧率到视频相关节点
    if (inputs.frame_rate !== undefined) {
      inputs.frame_rate = videoFps;
    }
    if (inputs.fps !== undefined && typeof inputs.fps === 'number') {
      inputs.fps = videoFps;
    }

    // 注入帧数
    if (inputs.frame_count !== undefined && typeof inputs.frame_count === 'number') {
      inputs.frame_count = videoFrames;
    }
    if (inputs.frames !== undefined && typeof inputs.frames === 'number') {
      inputs.frames = videoFrames;
    }
    if (inputs.length !== undefined && inputs.frame_count !== undefined && typeof inputs.length === 'number') {
      inputs.length = videoFrames;
    }
  }
}

/** 提交工作流到 ComfyUI，返回 baseUrl 和 promptId */
async function submitComfyUIWorkflow(
  workflowId: string,
  workflowInputs: Record<string, string> | undefined,
  prompt: string,
): Promise<{ baseUrl: string; promptId: string; workflowObj: Record<string, Record<string, unknown>> }> {
  const baseUrl = getComfyUIConfig();

  // 从 store 中获取工作流定义
  const workflows = useAppStore.getState().workflows;
  const wf = workflows.find((w) => w.id === workflowId);
  if (!wf) {
    throw new Error('所选工作流未找到，请重新导入');
  }

  // 解析工作流 JSON
  let workflowObj: Record<string, Record<string, unknown>>;
  try {
    workflowObj = JSON.parse(wf.fileContent);
  } catch {
    throw new Error('工作流 JSON 解析失败');
  }

  // 收集所有 IO 节点信息
  const ioNodes = wf.ioNodes || [];
  const ioNodeIds = ioNodes.map((io) => io.nodeId);

  // 注入提示词到 prompt 类型 IO 节点
  injectPromptsIntoWorkflow(workflowObj, workflowInputs, prompt, ioNodeIds);

  // 注入图片到 image 类型 IO 节点（上传 → 替换文件名）
  await injectImagesIntoWorkflow(workflowObj, workflowInputs, ioNodes, baseUrl);

  // 返回 workflowObj 让调用方注入尺寸/视频参数后再提交
  return { baseUrl, promptId: '', workflowObj };
}

/** 提交 workflowObj 到 ComfyUI 并返回 promptId */
async function promptComfyUIWorkflow(
  baseUrl: string,
  workflowObj: Record<string, Record<string, unknown>>,
): Promise<string> {
  const promptRes = await fetch(`${baseUrl}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: workflowObj }),
  });

  if (!promptRes.ok) {
    const errorBody = await promptRes.text().catch(() => '');
    throw new Error(`ComfyUI 提交工作流失败 (${promptRes.status})${errorBody ? ': ' + errorBody.slice(0, 200) : ''}`);
  }

  const promptResult = (await promptRes.json()) as { prompt_id?: string; error?: string };
  if (promptResult.error) {
    throw new Error(`ComfyUI 错误: ${promptResult.error}`);
  }
  if (!promptResult.prompt_id) {
    throw new Error('ComfyUI 未返回 prompt_id');
  }

  return promptResult.prompt_id;
}

/** 轮询 ComfyUI 执行历史，等待图片生成完成 */
async function pollComfyUIHistory(
  baseUrl: string,
  promptId: string,
  dimensions: { width: number; height: number },
): Promise<{ url: string; width: number; height: number }> {
  // 最多轮询 900 次，每次间隔 2 秒 = 2700 秒（45 分钟）超时
  for (let attempt = 0; attempt < 900; attempt++) {
    await new Promise((r) => setTimeout(r, 3000));

    try {
      const res = await fetch(`${baseUrl}/history/${promptId}`);
      if (!res.ok) continue;

      const history: Record<string, unknown> = await res.json();
      const entry = history[promptId] as Record<string, unknown> | undefined;
      if (!entry) continue;

      const outputs = entry.outputs as Record<string, { images?: Array<{ filename: string; subfolder?: string; type?: string }> }> | undefined;
      if (!outputs) continue;

      // 遍历所有节点的输出，找第一个包含图片的
      for (const nodeOutput of Object.values(outputs)) {
        if (nodeOutput.images && nodeOutput.images.length > 0) {
          const img = nodeOutput.images[0];
          const subfolder = img.subfolder ? `&subfolder=${encodeURIComponent(img.subfolder)}` : '';
          const type = img.type ? `&type=${encodeURIComponent(img.type)}` : '&type=output';
          const url = `${baseUrl}/view?filename=${encodeURIComponent(img.filename)}${subfolder}${type}`;
          return { url, width: dimensions.width, height: dimensions.height };
        }
      }
    } catch {
      // 网络错误时继续轮询
    }
  }

  throw new Error('ComfyUI 图片生成超时（30 分钟）');
}

/** 通过 ComfyUI 工作流执行图片生成 */
async function executeComfyUIGenerate(params: AIImageGenParams): Promise<{ url: string; width: number; height: number }> {
  const { workflowId, workflowInputs, prompt, imageSize = '2K', aspectRatio = '1:1' } = params;

  const { baseUrl, workflowObj } = await submitComfyUIWorkflow(workflowId!, workflowInputs, prompt);

  // 注入画布选择的尺寸（仅对 @提及的节点）
  injectDimensionsIntoWorkflow(
    workflowObj,
    imageSize,
    aspectRatio,
    workflowInputs ? Object.keys(workflowInputs) : undefined,
  );

  // 提交工作流
  const promptId = await promptComfyUIWorkflow(baseUrl, workflowObj);

  // 计算最终输出尺寸（用于节点显示）
  const dims = mapImageDimensions(imageSize, aspectRatio);

  // 轮询等待结果
  return pollComfyUIHistory(baseUrl, promptId, dims);
}

/** 轮询 ComfyUI 执行历史，等待视频生成完成 */
async function pollComfyUIHistoryForVideo(
  baseUrl: string,
  promptId: string,
): Promise<{ url: string }> {
  for (let attempt = 0; attempt < 900; attempt++) {
    await new Promise((r) => setTimeout(r, 3000));

    try {
      const res = await fetch(`${baseUrl}/history/${promptId}`);
      if (!res.ok) continue;

      const history: Record<string, unknown> = await res.json();
      const entry = history[promptId] as Record<string, unknown> | undefined;
      if (!entry) continue;

      const outputs = entry.outputs as Record<string, { gifs?: Array<{ filename: string; subfolder?: string; type?: string }>; videos?: Array<{ filename: string; subfolder?: string; type?: string }>; images?: Array<{ filename: string; subfolder?: string; type?: string }> }> | undefined;
      if (!outputs) continue;

      // 遍历所有节点输出，先找视频/gif，再 fallback 到图片
      for (const nodeOutput of Object.values(outputs)) {
        // 视频输出
        if (nodeOutput.videos && nodeOutput.videos.length > 0) {
          const vid = nodeOutput.videos[0];
          const subfolder = vid.subfolder ? `&subfolder=${encodeURIComponent(vid.subfolder)}` : '';
          const type = vid.type ? `&type=${encodeURIComponent(vid.type)}` : '&type=output';
          const url = `${baseUrl}/view?filename=${encodeURIComponent(vid.filename)}${subfolder}${type}`;
          return { url };
        }
        // GIF 输出
        if (nodeOutput.gifs && nodeOutput.gifs.length > 0) {
          const gif = nodeOutput.gifs[0];
          const subfolder = gif.subfolder ? `&subfolder=${encodeURIComponent(gif.subfolder)}` : '';
          const type = gif.type ? `&type=${encodeURIComponent(gif.type)}` : '&type=output';
          const url = `${baseUrl}/view?filename=${encodeURIComponent(gif.filename)}${subfolder}${type}`;
          return { url };
        }
        // 图片 fallback
        if (nodeOutput.images && nodeOutput.images.length > 0) {
          const img = nodeOutput.images[0];
          const subfolder = img.subfolder ? `&subfolder=${encodeURIComponent(img.subfolder)}` : '';
          const type = img.type ? `&type=${encodeURIComponent(img.type)}` : '&type=output';
          const url = `${baseUrl}/view?filename=${encodeURIComponent(img.filename)}${subfolder}${type}`;
          return { url };
        }
      }
    } catch {
      // 网络错误时继续轮询
    }
  }

  throw new Error('ComfyUI 视频生成超时（45 分钟）');
}

/** 通过 ComfyUI 工作流执行视频生成 */
async function executeComfyUIVideoGenerate(params: AIVideoGenParams): Promise<{ url: string }> {
  const { workflowId, workflowInputs, prompt, videoResolution = 832, videoFps = 24, videoFrames = 77 } = params;

  const { baseUrl, workflowObj } = await submitComfyUIWorkflow(workflowId!, workflowInputs, prompt);

  // 注入视频参数（仅对 @提及的节点）
  injectVideoParamsIntoWorkflow(
    workflowObj,
    videoResolution,
    videoFps,
    videoFrames,
    workflowInputs ? Object.keys(workflowInputs) : undefined,
  );

  // 提交工作流
  const promptId = await promptComfyUIWorkflow(baseUrl, workflowObj);

  // 轮询等待结果
  return pollComfyUIHistoryForVideo(baseUrl, promptId);
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

  // 无 workflowId 时暂不支持直接调用 API，提示配置
  throw new Error('视频生成需要选择 ComfyUI 工作流\n请在模型选择器中导入并选择工作流');
}

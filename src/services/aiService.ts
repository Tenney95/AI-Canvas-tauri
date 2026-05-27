import { useAppStore } from '../store/useAppStore';

/** 本地模型调用超时（30 分钟） */
const LOCAL_MODEL_TIMEOUT_MS = 30 * 60 * 1000;

const DEFAULT_BASE_URLS: Record<string, string> = {
  openai: 'https://api.openai.com',
  ppio: 'https://api.ppio.ai',
  apimart: 'https://api.apimart.com',
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
  workflowId?: string;    // ComfyUI 工作流 ID（存在时走 ComfyUI 执行）
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
  const { prompt, model, provider } = params;

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
 */
export async function generateImage(params: AIImageGenParams): Promise<{ url: string; width: number; height: number }> {
  // ComfyUI 工作流执行路径
  if (params.workflowId) {
    return executeComfyUIGenerate(params);
  }

  const { prompt, model, provider, imageSize = '2K', aspectRatio = '1:1' } = params;

  if (!prompt.trim()) {
    throw new Error('提示词不能为空');
  }

  const config = useAppStore.getState().config;
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

  const response = await fetch(apiUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: modelName,
      prompt,
      n: 1,
      size: sizeStr,
      response_format: 'url',
    }),
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

  // 有 explicit IO 赋值：通过 ioNodeIds 精确匹配 workflow JSON 节点
  for (const ioNodeId of ioNodeIds) {
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

/** 将画布选择的尺寸/比例注入到工作流 JSON 中包含 width/height 的节点 */
function injectDimensionsIntoWorkflow(
  workflowObj: Record<string, Record<string, unknown>>,
  imageSize: string,
  aspectRatio: string,
): void {
  const dims = mapImageDimensions(imageSize, aspectRatio);
  for (const [, nodeData] of Object.entries(workflowObj)) {
    if (!nodeData || typeof nodeData !== 'object') continue;
    const inputs = nodeData.inputs as Record<string, unknown> | undefined;
    if (!inputs) continue;
    // 匹配包含 width 和 height 的节点（EmptyLatentImage、EmptySD3LatentImage 等）
    if (inputs.width !== undefined && typeof inputs.width === 'number' && inputs.height !== undefined && typeof inputs.height === 'number') {
      inputs.width = dims.width;
      inputs.height = dims.height;
    }
  }
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

  // 收集所有 IO 节点 ID（用于 prompt 注入精确匹配）
  const ioNodeIds = (wf.ioNodes || []).map((io) => io.nodeId);

  // 注入提示词到 prompt 类型 IO 节点
  injectPromptsIntoWorkflow(workflowObj, workflowInputs, prompt, ioNodeIds);

  // 注入画布选择的尺寸到工作流中 width/height 节点
  injectDimensionsIntoWorkflow(workflowObj, imageSize, aspectRatio);

  // 步骤 1：提交工作流
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

  // 计算最终输出尺寸（用于节点显示）
  const dims = mapImageDimensions(imageSize, aspectRatio);

  // 步骤 2：轮询等待结果
  return pollComfyUIHistory(baseUrl, promptResult.prompt_id, dims);
}

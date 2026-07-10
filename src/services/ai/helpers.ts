/**
 * ai/helpers — 模型解析、尺寸格式化、响应解析
 */
import { useAppStore } from '../../store/useAppStore';

/** 去掉 model value 中的 provider/ 前缀，得到实际的模型名 */
export function extractModelName(modelValue: string, provider: string): string {
  const prefix = `${provider}/`;
  if (modelValue.startsWith(prefix)) {
    return modelValue.slice(prefix.length);
  }
  return modelValue;
}

export function isOpenAIGptImageModel(modelName: string): boolean {
  return /^gpt-image-\d/.test(modelName);
}

export function toImageDataUrl(base64: string, format = 'png'): string {
  if (/^(data:|https?:|blob:)/.test(base64)) return base64;
  return `data:image/${format};base64,${base64}`;
}

export function formatImageSizeForModel(
  modelName: string,
  dimensions: { width: number; height: number },
): string {
  if (!isOpenAIGptImageModel(modelName)) {
    return `${dimensions.width}x${dimensions.height}`;
  }

  const toMultipleOf16 = (value: number) => Math.max(16, Math.round(value / 16) * 16);
  return `${toMultipleOf16(dimensions.width)}x${toMultipleOf16(dimensions.height)}`;
}

/**
 * 将 UI 选择的画质值映射为 Seedream API 支持的有效 size
 * 各模型支持的画质范围不同，未支持的分辨率自动降级到最接近的有效值
 */
const SEEDREAM_SIZE_SUPPORT: Record<string, string[]> = {
  'doubao-seedream-5-0-pro': ['1K', '2K'],
  'doubao-seedream-5-0-lite': ['2K', '3K', '4K'],
  'doubao-seedream-4-5': ['2K', '4K'],
  'doubao-seedream-4-0': ['1K', '2K', '4K'],
};

export function normalizeSeedreamSize(modelName: string, requestedSize: string): string {
  // 查找匹配的模型支持列表
  const baseName = Object.keys(SEEDREAM_SIZE_SUPPORT).find((k) => modelName.startsWith(k));
  const supported = baseName ? SEEDREAM_SIZE_SUPPORT[baseName] : ['1K', '2K', '4K'];
  if (supported.includes(requestedSize)) return requestedSize;

  // 将 UI 画质字符串转换为像素短边用于比较
  const numeric = (s: string) => {
    const map: Record<string, number> = { '720p': 720, '1K': 1024, '2K': 2048, '3K': 3072, '4K': 4096 };
    return map[s] ?? 2048;
  };
  const target = numeric(requestedSize);
  // 找到数值上最接近的支持尺寸
  let best = supported[0];
  let bestDiff = Math.abs(numeric(best) - target);
  for (const s of supported) {
    const diff = Math.abs(numeric(s) - target);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = s;
    }
  }
  return best;
}

/** 从 store 中查找通用模型配置 */
export function resolveGeneralModel(modelValue: string) {
  const config = useAppStore.getState().config;
  const gmId = modelValue.replace(/^general\//, '');
  return config.generalModels?.find((m) => m.id === gmId);
}

/**
 * 多路径响应解析 — 兼容不同厂商的返回值格式
 */
export function parseMultiPathResponse(
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
 * 通用模型的文本响应解析 — 兼容多字段名格式
 */
export function parseGeneralTextResponse(json: Record<string, unknown>): string {
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
export function parseGeneralImageResponse(json: Record<string, unknown>): string | undefined {
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

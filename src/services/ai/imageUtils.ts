/**
 * ai/imageUtils — 图片加载、URL 解析、上传辅助
 */
import { isLocalMediaUrl, isRemoteMediaUrl } from '../../utils/mediaUrl';
import { uploadToRemote, isLocalImageUrl, prepareReferenceImageDataUrl } from '../uploadService';
import { assertMediaDataUrlSize, getAssetUrlFromPath } from '../fileService';
import { bytePartsToBase64Async } from '../fs/core';
import { MEDIA_DATA_URL_BYTE_LIMITS } from '../mediaDataUrl';
import { corsSafeFetch } from './httpTransport';
import { readNativeComfyImageBlob, shouldLoadNativeComfyImage } from '../comfyImageSource';
import { mapReferenceImagesInOrder, prepareReferenceImageUpload } from './referenceImageUpload';

const BASE64_IMAGE_DATA_URL_RE = /^data:image\/[^;,]+(?:;[^,]*)*;base64,/i;
export const VLM_MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const VLM_MAX_IMAGES = 6;
export const VLM_MAX_TOTAL_IMAGE_BYTES = 24 * 1024 * 1024;

interface ImageDataUrlBudget {
  maxImages?: number;
  maxImageBytes: number;
  maxTotalBytes: number;
}

const VLM_IMAGE_DATA_URL_BUDGET: Readonly<ImageDataUrlBudget> = {
  maxImages: VLM_MAX_IMAGES,
  maxImageBytes: VLM_MAX_IMAGE_BYTES,
  maxTotalBytes: VLM_MAX_TOTAL_IMAGE_BYTES,
};

// 生图数量由模型能力检查；32 MiB 沿用图片读取边界，48 MiB Base64 后为 64 MiB，
// 为既有 65 MiB 整份请求上限预留 JSON／提示词空间。这是应用预算，不是厂商限制。
export const IMAGE_GENERATION_DATA_URL_BUDGET: Readonly<ImageDataUrlBudget> = {
  maxImageBytes: MEDIA_DATA_URL_BYTE_LIMITS.image,
  maxTotalBytes: 48 * 1024 * 1024,
};

const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  avif: 'image/avif',
  gif: 'image/gif',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};

function inferImageMimeType(url: string): string | undefined {
  const path = (() => {
    try {
      return new URL(url).pathname;
    } catch {
      return url.split(/[?#]/, 1)[0];
    }
  })();
  const extension = path.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase();
  return extension ? IMAGE_MIME_BY_EXTENSION[extension] : undefined;
}

async function referenceImageToDataUrl(
  url: string,
  index: number,
  accountBytes: (bytes: number) => void,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  if (BASE64_IMAGE_DATA_URL_RE.test(url)) {
    const prepared = await prepareReferenceImageDataUrl(url, signal);
    const encoded = prepared.slice(prepared.indexOf(',') + 1).replace(/\s/g, '');
    const estimatedBytes = Math.floor(encoded.length * 3 / 4) - (encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0);
    accountBytes(estimatedBytes);
    return prepared;
  }

  const usesWebViewFetch = isLocalMediaUrl(url);
  const response = await (usesWebViewFetch
    ? fetch(url, { signal })
    : corsSafeFetch(url, { signal }));
  if (!response.ok) {
    throw new Error(`读取参考图 ${index + 1} 失败 (${response.status})`);
  }

  assertMediaDataUrlSize(Number(response.headers.get('Content-Length')) || 0, 'image', `参考图 ${index + 1}`);
  const blob = await response.blob();
  if (blob.size === 0) throw new Error(`参考图 ${index + 1} 内容为空`);
  assertMediaDataUrlSize(blob.size, 'image', `参考图 ${index + 1}`);
  const blobMime = blob.type.split(';')[0].trim().toLowerCase();
  const responseMime = response.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase();
  const mimeType = [blobMime, responseMime].find((value) => value?.startsWith('image/'))
    ?? inferImageMimeType(url);
  if (!mimeType?.startsWith('image/')) {
    throw new Error(`参考图 ${index + 1} 不是受支持的图片格式`);
  }

  const prepared = await prepareReferenceImageUpload(blob.type === mimeType ? blob : new Blob([blob], { type: mimeType }), signal);
  accountBytes(prepared.size);
  const bytes = new Uint8Array(await prepared.arrayBuffer());
  const encoded = await bytePartsToBase64Async([bytes], signal);
  signal?.throwIfAborted();
  return `data:${prepared.type};base64,${encoded}`;
}

async function loadNativeComfyImage(src: string, signal: AbortSignal): Promise<HTMLImageElement> {
  const blob = await readNativeComfyImageBlob(src, signal);
  signal.throwIfAborted();
  const objectUrl = URL.createObjectURL(blob);
  try {
    return await new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image();
      let settled = false;
      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', abort);
        image.onload = image.onerror = null;
        if (error) { image.removeAttribute('src'); reject(error); }
        else resolve(image);
      };
      const abort = () => finish(signal.reason ?? new DOMException('图片读取已取消', 'AbortError'));
      image.onload = () => {
        if (typeof image.decode === 'function') void image.decode().then(() => finish(), finish);
        else finish();
      };
      image.onerror = () => finish(new Error('ComfyUI 图片解码失败'));
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      else image.src = objectUrl;
    });
  } finally {
    // 返回的 HTMLImageElement 已完成解码；只用于绘制，不把临时 src 写回引用。
    URL.revokeObjectURL(objectUrl);
  }
}

/** 加载图片：ComfyUI 取件在桌面端经原生读取，其他来源沿用既有行为。 */
export async function loadImage(src: string): Promise<HTMLImageElement> {
  if (shouldLoadNativeComfyImage(src)) {
    return loadNativeComfyImage(src, AbortSignal.timeout(15_000));
  }
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

/** ComfyUI 原生读取后探测解码，其他来源沿用原来的 <img> 可达性检查。 */
export function imageUrlReachable(url: string, timeoutMs = 6000): Promise<boolean> {
  if (shouldLoadNativeComfyImage(url)) {
    return loadNativeComfyImage(url, AbortSignal.timeout(timeoutMs)).then(() => true, () => false);
  }
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
 *  - 线上 http(s) URL 有本地 filePath 时优先用本地副本，
 *    后续上传会复用 2.5 小时缓存，到期后重传，不再依赖旧地址能否加载。
 */
export async function resolveNodeImageUrl(url: string, filePath?: string): Promise<string> {
  // 本地/内联 URL（asset://、data:、blob:、http://asset.localhost）无需校验
  if (!isRemoteMediaUrl(url)) return url;
  if (filePath) {
    try {
      const local = await getAssetUrlFromPath(filePath);
      if (local) return local;
    } catch { /* ignore, fall through */ }
  }
  return url; // 无本地兜底则维持原样
}

/** 将蒙版/标注叠加层与原图合并，返回合成后的 data URL */
export async function mergeImageWithOverlays(
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
export async function resolveContentImageUrls(
  content: string | Array<{ type: string; text?: string; image_url?: { url: string } }>,
  provider = '',
  signal?: AbortSignal,
): Promise<string | Array<{ type: string; text?: string; image_url?: { url: string } }>> {
  if (typeof content === 'string') return content;
  return mapReferenceImagesInOrder(
    content, async (part) => {
      if (part.type === 'image_url' && part.image_url?.url && isLocalImageUrl(part.image_url.url)) {
        const publicUrl = await uploadToRemote(part.image_url.url, provider, 'image', signal);
        return { ...part, image_url: { url: publicUrl } };
      }
      return part;
    }, signal,
  );
}

/** 上传 imageUrls 数组中的本地图片到远端 */
export async function resolveImageUrlArray(
  urls: string[],
  provider = '',
  signal?: AbortSignal,
): Promise<string[]> {
  return mapReferenceImagesInOrder(
    urls, async (url) => {
      if (isLocalImageUrl(url)) {
        return await uploadToRemote(url, provider, 'image', signal);
      }
      return url;
    }, signal,
  );
}

/** 转换参考图并逐张计入预算；默认保留文本视觉限制，生图可显式使用独立预算。 */
export async function resolveImageDataUrlArray(
  urls: string[],
  signal?: AbortSignal,
  budget: Readonly<ImageDataUrlBudget> = VLM_IMAGE_DATA_URL_BUDGET,
): Promise<string[]> {
  if (budget.maxImages !== undefined && urls.length > budget.maxImages) {
    throw new Error(`视觉输入最多允许 ${budget.maxImages} 张图片`);
  }
  let totalBytes = 0;
  return mapReferenceImagesInOrder(urls, (url, index) => referenceImageToDataUrl(url, index, (bytes) => {
    if (bytes > budget.maxImageBytes) {
      throw new Error(`参考图 ${index + 1} 超过应用单图转换上限（${budget.maxImageBytes / 1024 / 1024} MiB）`);
    }
    totalBytes += bytes;
    if (totalBytes > budget.maxTotalBytes) {
      throw new Error(`参考图合计超过应用转换上限（${budget.maxTotalBytes / 1024 / 1024} MiB）`);
    }
  }, signal), signal);
}

export type OpenAiChatContent = string | Array<{
  type: string;
  text?: string;
  image_url?: { url: string };
}>;

/** 把 OpenAI 兼容多模态 content 中的图片统一变为受限 Base64 data URL。 */
export async function resolveChatContentImageDataUrls(
  content: OpenAiChatContent,
  signal?: AbortSignal,
): Promise<OpenAiChatContent> {
  if (typeof content === 'string') return content;
  const imageParts = content.filter((part) => part.type === 'image_url' && part.image_url?.url);
  const dataUrls = await resolveImageDataUrlArray(
    imageParts.map((part) => part.image_url!.url),
    signal,
  );
  let imageIndex = 0;
  return content.map((part) => part.type === 'image_url' && part.image_url?.url
    ? { ...part, image_url: { url: dataUrls[imageIndex++] } }
    : part);
}

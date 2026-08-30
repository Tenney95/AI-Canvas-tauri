/**
 * ai/imageUtils — 图片加载、URL 解析、上传辅助
 */
import { uploadToRemote, isLocalImageUrl } from '../uploadService';
import { getAssetUrlFromPath } from '../fileService';
import { corsSafeFetch } from './httpTransport';

const BASE64_IMAGE_DATA_URL_RE = /^data:image\/[^;,]+(?:;[^,]*)*;base64,/i;
export const VLM_MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const VLM_MAX_IMAGES = 6;
export const VLM_MAX_TOTAL_IMAGE_BYTES = 24 * 1024 * 1024;

const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  avif: 'image/avif',
  gif: 'image/gif',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};

function encodeBytesBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

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
  signal?: AbortSignal,
): Promise<string> {
  if (BASE64_IMAGE_DATA_URL_RE.test(url)) {
    const encoded = url.slice(url.indexOf(',') + 1).replace(/\s/g, '');
    const estimatedBytes = Math.floor(encoded.length * 3 / 4);
    if (estimatedBytes > VLM_MAX_IMAGE_BYTES) {
      throw new Error(`参考图 ${index + 1} 超过 8 MB 上限`);
    }
    return url;
  }

  const usesWebViewFetch = /^(asset:|blob:|data:|file:)/i.test(url)
    || url.includes('asset.localhost');
  const response = await (usesWebViewFetch
    ? fetch(url, { signal })
    : corsSafeFetch(url, { signal }));
  if (!response.ok) {
    throw new Error(`读取参考图 ${index + 1} 失败 (${response.status})`);
  }

  const blob = await response.blob();
  if (blob.size === 0) throw new Error(`参考图 ${index + 1} 内容为空`);
  if (blob.size > VLM_MAX_IMAGE_BYTES) throw new Error(`参考图 ${index + 1} 超过 8 MB 上限`);
  const blobMime = blob.type.split(';')[0].trim().toLowerCase();
  const responseMime = response.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase();
  const mimeType = [blobMime, responseMime].find((value) => value?.startsWith('image/'))
    ?? inferImageMimeType(url);
  if (!mimeType?.startsWith('image/')) {
    throw new Error(`参考图 ${index + 1} 不是受支持的图片格式`);
  }

  const bytes = new Uint8Array(await blob.arrayBuffer());
  return `data:${mimeType};base64,${encodeBytesBase64(bytes)}`;
}

/** 加载图片（自动处理远程 URL 的 CORS） */
export async function loadImage(src: string): Promise<HTMLImageElement> {
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
export function imageUrlReachable(url: string, timeoutMs = 6000): Promise<boolean> {
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
export async function resolveNodeImageUrl(url: string, filePath?: string): Promise<string> {
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
  const resolved = await Promise.all(
    content.map(async (part) => {
      if (part.type === 'image_url' && part.image_url?.url && isLocalImageUrl(part.image_url.url)) {
        const publicUrl = await uploadToRemote(part.image_url.url, provider, 'image', signal);
        return { ...part, image_url: { url: publicUrl } };
      }
      return part;
    }),
  );
  return resolved;
}

/** 上传 imageUrls 数组中的本地图片到远端 */
export async function resolveImageUrlArray(
  urls: string[],
  provider = '',
  signal?: AbortSignal,
): Promise<string[]> {
  return Promise.all(
    urls.map(async (url) => {
      if (isLocalImageUrl(url)) {
        return await uploadToRemote(url, provider, 'image', signal);
      }
      return url;
    }),
  );
}

/** 将参考图统一转换为 JSON 图片接口可接收的 base64 data URL 数组。 */
export async function resolveImageDataUrlArray(
  urls: string[],
  signal?: AbortSignal,
): Promise<string[]> {
  if (urls.length > VLM_MAX_IMAGES) throw new Error(`视觉输入最多允许 ${VLM_MAX_IMAGES} 张图片`);
  const values = await Promise.all(urls.map((url, index) => referenceImageToDataUrl(url, index, signal)));
  const totalBytes = values.reduce((sum, value) => {
    const encoded = value.slice(value.indexOf(',') + 1).replace(/\s/g, '');
    return sum + Math.floor(encoded.length * 3 / 4);
  }, 0);
  if (totalBytes > VLM_MAX_TOTAL_IMAGE_BYTES) throw new Error('视觉输入图片总大小超过 24 MB 上限');
  return values;
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

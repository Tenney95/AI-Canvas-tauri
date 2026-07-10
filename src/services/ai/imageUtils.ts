/**
 * ai/imageUtils — 图片加载、URL 解析、上传辅助
 */
import { uploadToRemote, isLocalImageUrl } from '../uploadService';
import { getAssetUrlFromPath } from '../fileService';

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
export async function resolveImageUrlArray(urls: string[]): Promise<string[]> {
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

/**
 * uploadService — 本地图片上传到远端图床
 * 将 asset://localhost/... 或 data:... 等本地图片转为公网可访问的 URL
 */
import { useAppStore } from '../store/useAppStore';

/** 默认上传端点（APIMart） */
import { APIMART_BASE_URL } from '../constants/api';
const DEFAULT_UPLOAD_BASE = APIMART_BASE_URL;

/** 内存缓存：本地 URL → 公网 URL，避免同一张图重复上传 */
const urlCache = new Map<string, string>();

/** 判断是否为本地图片 URL（需上传后才能发给远程 AI） */
export function isLocalImageUrl(url: string): boolean {
  if (!url) return false;
  if (url.startsWith('data:')) return true;
  if (url.startsWith('asset://') || url.includes('asset.localhost')) return true;
  if (url.startsWith('file://')) return true;
  return false;
}

/** data URL → Blob */
function dataUrlToBlob(dataUrl: string): { blob: Blob; ext: string } {
  const [header, base64] = dataUrl.split(',');
  const mime = header.match(/:(.*?);/)?.[1] || 'image/png';
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return { blob: new Blob([bytes], { type: mime }), ext: mime.split('/')[1] || 'png' };
}

/** fetch URL → Blob（Tauri asset protocol 的本地 URL 可通过 fetch 获取） */
async function fetchUrlToBlob(url: string): Promise<{ blob: Blob; ext: string }> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`获取本地图片失败 (${response.status})`);
  }
  const blob = await response.blob();
  const contentType = response.headers.get('Content-Type') || '';
  const ext = contentType.split('/')[1] || url.split('.').pop()?.split('?')[0] || 'png';
  return { blob, ext };
}

/**
 * 上传单张本地图片到远端图床
 * @returns 公网可访问的图片 URL
 */
export async function uploadToRemote(url: string): Promise<string> {
  // 非本地 URL 直接返回
  if (!isLocalImageUrl(url)) return url;

  // 命中缓存
  const cached = urlCache.get(url);
  if (cached) return cached;

  const config = useAppStore.getState().config;

  // 优先取 apimart 的 API Key（上传端点固定为 APIMart）
  let apiKey = '';
  let uploadBaseUrl = DEFAULT_UPLOAD_BASE;
  const apimartConfig = config.providers.apimart;
  if (apimartConfig?.apiKey) {
    apiKey = apimartConfig.apiKey;
    if (apimartConfig.baseUrl) {
      uploadBaseUrl = apimartConfig.baseUrl.replace(/\/+$/, '');
    }
  } else {
    // 降级：取第一个配置了 apiKey 的 provider
    for (const [, providerConfig] of Object.entries(config.providers)) {
      if (providerConfig?.apiKey) {
        apiKey = providerConfig.apiKey;
        if (providerConfig.baseUrl) {
          uploadBaseUrl = providerConfig.baseUrl.replace(/\/+$/, '');
        }
        break;
      }
    }
  }

  if (!apiKey) {
    throw new Error('未配置任何 API Key，无法上传图片\n请在「设置 → API Key」中配置');
  }

  try {
    const { blob, ext } = url.startsWith('data:')
      ? dataUrlToBlob(url)
      : await fetchUrlToBlob(url);

    const formData = new FormData();
    formData.append('file', blob, `canvas-upload-${Date.now()}.${ext}`);

    const resp = await fetch(`${uploadBaseUrl}/uploads/images`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: formData,
    });

    if (!resp.ok) {
      const errBody = await resp.text().catch(() => '');
      throw new Error(`图片上传失败 (${resp.status}): ${errBody.slice(0, 200)}`);
    }

    const result = (await resp.json()) as { url: string };
    if (!result.url) {
      throw new Error('图片上传失败: 未返回 url');
    }

    urlCache.set(url, result.url);
    return result.url;
  } catch (err) {
    console.error('[uploadService] Upload failed:', url, err);
    throw err;
  }
}

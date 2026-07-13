/**
 * uploadService — 本地图片上传到远端图床
 * 将 asset://localhost/... 或 data:... 等本地图片转为公网可访问的 URL
 *
 * 上传策略：
 *  - provider === 'apimart' → APIMart /uploads/images（需 API Key）
 *  - 其他所有 provider  → uguu.se 免费图床（无需 API Key，直接返回无轮询）
 *
 * 缓存策略：
 *  - 内存缓存：同一进程内即时复用
 *  - localStorage 持久化缓存：跨进程/Session 复用，3 小时过期后自动重传
 */
import { useAppStore } from '../store/useAppStore';
import { APIMART_BASE_URL } from '../constants/api';
import { isTauriEnv } from './fs/core';

const DEFAULT_UPLOAD_BASE = APIMART_BASE_URL;

/** uguu.se 免费图床上传地址 */
const UGUU_UPLOAD_URL = 'https://uguu.se/upload';

/** 上传缓存 TTL：3 小时 */
const UPLOAD_TTL_MS = 3 * 60 * 60 * 1000;

/** localStorage key */
const CACHE_STORAGE_KEY = 'canvas-upload-cache-v2';

// ── 持久化缓存 ──

interface CacheEntry {
  remoteUrl: string;
  uploadedAt: number;
}

function loadPersistentCache(): Record<string, CacheEntry> {
  try {
    const raw = localStorage.getItem(CACHE_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Record<string, CacheEntry>) : {};
  } catch {
    return {};
  }
}

function savePersistentCache(cache: Record<string, CacheEntry>) {
  try {
    localStorage.setItem(CACHE_STORAGE_KEY, JSON.stringify(cache));
  } catch {
    // localStorage 满了则清理过期项后重试一次
    pruneExpiredCache(cache);
    try { localStorage.setItem(CACHE_STORAGE_KEY, JSON.stringify(cache)); } catch { /* ignore */ }
  }
}

function pruneExpiredCache(cache: Record<string, CacheEntry>) {
  const now = Date.now();
  for (const key of Object.keys(cache)) {
    if (now - cache[key].uploadedAt > UPLOAD_TTL_MS) {
      delete cache[key];
    }
  }
}

/** 对 data: URL 取 hash，避免超长 key 撑爆 localStorage */
function cacheKey(url: string): string {
  if (!url.startsWith('data:')) return url;
  let hash = 0;
  const base64 = url.split(',')[1] || '';
  for (let i = 0; i < base64.length; i++) {
    hash = ((hash << 5) - hash) + base64.charCodeAt(i);
    hash |= 0;
  }
  return 'data:' + Math.abs(hash).toString(36);
}

/** 内存缓存：本地 URL → 公网 URL，避免同一进程重复上传 */
const memCache = new Map<string, string>();

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

/** URL → Blob（自动判定 data: 或 asset:） */
async function urlToBlob(url: string): Promise<{ blob: Blob; ext: string }> {
  return url.startsWith('data:') ? dataUrlToBlob(url) : fetchUrlToBlob(url);
}

// ── APIMart 上传 ──

async function uploadToApimart(url: string): Promise<string> {
  const config = useAppStore.getState().config;
  const apimartConfig = config.providers.apimart;
  let apiKey = apimartConfig?.apiKey || '';
  let uploadBaseUrl = (apimartConfig?.baseUrl || DEFAULT_UPLOAD_BASE).replace(/\/+$/, '');

  if (!apiKey) {
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

  const { blob, ext } = await urlToBlob(url);

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

  return result.url;
}

// ── uguu.se 免费图床上传 ──

/** 将 FormData 序列化为 base64 编码的 multipart 字节流（用于 Tauri proxy_fetch） */
async function formDataToBase64(formData: FormData): Promise<{ body: string; contentType: string }> {
  const boundary = '----WebKitFormBoundary' + Math.random().toString(36).substring(2);
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];

  // uploadToUguu 只 append 了一个 files[] 字段，直接用 get 取值
  const file = formData.get('files[]');
  if (!(file instanceof Blob)) throw new Error('FormData 中未找到文件');

  const filename = (file as File).name || 'blob';
  let header = `--${boundary}\r\n`;
  header += `Content-Disposition: form-data; name="files[]"; filename="${filename}"\r\n`;
  header += `Content-Type: ${file.type || 'application/octet-stream'}\r\n\r\n`;
  parts.push(encoder.encode(header));
  parts.push(new Uint8Array(await file.arrayBuffer()));
  parts.push(encoder.encode('\r\n'));

  parts.push(encoder.encode(`--${boundary}--\r\n`));

  const totalLen = parts.reduce((acc, p) => acc + p.length, 0);
  const merged = new Uint8Array(totalLen);
  let offset = 0;
  for (const p of parts) {
    merged.set(p, offset);
    offset += p.length;
  }

  let binary = '';
  for (let i = 0; i < merged.length; i++) binary += String.fromCharCode(merged[i]);
  return { body: btoa(binary), contentType: `multipart/form-data; boundary=${boundary}` };
}

async function uploadToUguu(url: string): Promise<string> {
  const { blob, ext } = await urlToBlob(url);

  const formData = new FormData();
  formData.append('files[]', blob, `canvas-upload-${Date.now()}.${ext}`);

  // Tauri 环境：走 Rust proxy_fetch 绕过浏览器 CORS
  if (isTauriEnv()) {
    const { invoke } = await import('@tauri-apps/api/core');
    const { body, contentType } = await formDataToBase64(formData);
    const result = await invoke<{ status: number; body: string }>('proxy_fetch', {
      req: {
        url: UGUU_UPLOAD_URL,
        method: 'POST',
        headers: [
          ['Content-Type', contentType],
          ['User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'],
          ['Accept', '*/*'],
          ['Accept-Language', 'zh-CN,zh;q=0.9,en;q=0.8'],
        ],
        body,
      },
    });

    if (result.status < 200 || result.status >= 300) {
      const errBody = (() => { try { return atob(result.body); } catch { return result.body; } })();
      throw new Error(`Uguu 上传失败 (${result.status}): ${errBody.slice(0, 200)}`);
    }

    const json = JSON.parse(atob(result.body)) as { success: boolean; files?: Array<{ url: string }> };
    const publicUrl = json?.files?.[0]?.url;
    if (!publicUrl) throw new Error('Uguu 未返回图片 URL');
    return publicUrl;
  }

  // 浏览器开发模式：直接 fetch（ugu.se 无 CORS 头，仅在开发代理下可用）
  const resp = await fetch(UGUU_UPLOAD_URL, { method: 'POST', body: formData });

  if (!resp.ok) {
    const errBody = await resp.text().catch(() => '');
    throw new Error(`Uguu 上传失败 (${resp.status}): ${errBody.slice(0, 200)}`);
  }

  const result = (await resp.json()) as { success: boolean; files?: Array<{ url: string }> };
  const publicUrl = result?.files?.[0]?.url;
  if (!publicUrl) throw new Error('Uguu 未返回图片 URL');

  return publicUrl;
}

// ── 缓存查/写 ──

/** 查缓存：先内存后 localStorage，命中且未过期则返回，过期则清除 */
function getCachedUrl(url: string): string | null {
  // 内存缓存（最快）
  const mem = memCache.get(url);
  if (mem) return mem;

  // localStorage 持久化缓存
  const key = cacheKey(url);
  const persistent = loadPersistentCache();
  const entry = persistent[key];
  if (entry && Date.now() - entry.uploadedAt < UPLOAD_TTL_MS) {
    memCache.set(url, entry.remoteUrl);
    return entry.remoteUrl;
  }

  // 过期则清理
  if (entry) {
    delete persistent[key];
    savePersistentCache(persistent);
  }

  return null;
}

/** 写缓存：同时写内存和 localStorage */
function setCachedUrl(url: string, remoteUrl: string) {
  memCache.set(url, remoteUrl);

  const key = cacheKey(url);
  const persistent = loadPersistentCache();
  persistent[key] = { remoteUrl, uploadedAt: Date.now() };
  savePersistentCache(persistent);
}

/**
 * 上传单张本地图片到远端图床
 * @param url    本地图片 URL（data: / asset: / file:）
 * @param provider 提供商标识：'apimart' 走 APIMart 图床，其他走 uguu.se
 * @returns 公网可访问的图片 URL
 */
export async function uploadToRemote(url: string, provider = ''): Promise<string> {
  if (!isLocalImageUrl(url)) return url;

  // 查缓存（内存 → localStorage），命中且未过期则直接返回
  const cached = getCachedUrl(url);
  if (cached) return cached;

  try {
    const publicUrl = provider === 'apimart'
      ? await uploadToApimart(url)
      : await uploadToUguu(url);

    // 写入双层缓存（3 小时有效期）
    setCachedUrl(url, publicUrl);
    return publicUrl;
  } catch (err) {
    console.error('[uploadService] Upload failed:', url, provider, err);
    throw err;
  }
}

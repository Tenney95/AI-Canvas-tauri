import { invoke } from '@tauri-apps/api/core';
import { readFile as tauriReadFile, stat } from '@tauri-apps/plugin-fs';
import { isLocalMediaUrl, isRemoteMediaUrl, localMediaUrlToPath } from '../../utils/mediaUrl';
import { corsSafeFetch } from '../ai/httpTransport';
import { shouldLoadNativeComfyImage } from '../comfyImageSource';
import { downloadGithubBytes, githubMirrorUrl } from '../githubDownloadService';
import { MEDIA_DATA_URL_BYTE_LIMITS } from '../mediaDataUrl';
import { bytePartsToBase64Async, getAssetUrlFromPath, getMimeType, isTauriEnv } from './core';

export type MediaDataUrlKind = 'image' | 'video' | 'audio' | 'other';

/**
 * Data URL / Base64 兼容路径会在 JS 和 IPC 间产生多份副本，因此必须在读取前限制原始字节数。
 * 正常项目文件走原生流式拷贝，不受这些上限影响。
 */
export const MEDIA_DATA_URL_MAX_BYTES: Readonly<Record<MediaDataUrlKind, number>> = {
  ...MEDIA_DATA_URL_BYTE_LIMITS,
};

/** 单次模型请求内允许同时保留的 Data URL 原始字节总量。 */
export const MEDIA_DATA_URL_TOTAL_MAX_BYTES = 128 * 1024 * 1024;

/** Data URL 元数据只应包含 MIME 和少量参数，限制长度避免缓存键/解析产生巨型副本。 */
export const MEDIA_DATA_URL_MAX_HEADER_CHARS = 4096;

export const MEDIA_KIND_LABELS: Readonly<Record<MediaDataUrlKind, string>> = {
  image: '图片',
  video: '视频',
  audio: '音频',
  other: '文件',
};

export class MediaDataUrlTooLargeError extends Error {
  readonly actualBytes: number;
  readonly maxBytes: number;
  readonly kind: MediaDataUrlKind;

  constructor(
    actualBytes: number,
    maxBytes: number,
    kind: MediaDataUrlKind,
    label = MEDIA_KIND_LABELS[kind],
  ) {
    super(
      `${label}大小为 ${formatMiB(actualBytes)}，超过内存转换上限 ${formatMiB(maxBytes)}；`
      + '请压缩素材，或先导入正式项目以使用原生文件存储',
    );
    this.name = 'MediaDataUrlTooLargeError';
    this.actualBytes = actualBytes;
    this.maxBytes = maxBytes;
    this.kind = kind;
  }
}

export class MediaDataUrlTotalTooLargeError extends Error {
  readonly actualBytes: number;
  readonly maxBytes: number;

  constructor(actualBytes: number, maxBytes: number, label = '本次参考媒体') {
    super(
      `${label}累计大小为 ${formatMiB(actualBytes)}，超过内存转换总上限 ${formatMiB(maxBytes)}；`
      + '请减少参考素材数量或压缩素材后重试',
    );
    this.name = 'MediaDataUrlTotalTooLargeError';
    this.actualBytes = actualBytes;
    this.maxBytes = maxBytes;
  }
}

export class MediaDataUrlHeaderTooLargeError extends Error {
  readonly actualChars: number;
  readonly maxChars: number;

  constructor(actualChars: number, maxChars = MEDIA_DATA_URL_MAX_HEADER_CHARS) {
    super(`Data URL 元数据长度为 ${actualChars}，超过上限 ${maxChars}；请重新导入媒体文件`);
    this.name = 'MediaDataUrlHeaderTooLargeError';
    this.actualChars = actualChars;
    this.maxChars = maxChars;
  }
}

export interface MediaDataUrlBudget {
  usedBytes: number;
  readonly maxBytes: number;
  readonly label: string;
}

export function createMediaDataUrlBudget(
  label = '本次参考媒体',
  maxBytes = MEDIA_DATA_URL_TOTAL_MAX_BYTES,
): MediaDataUrlBudget {
  return { usedBytes: 0, maxBytes, label };
}

function formatMiB(bytes: number): string {
  return `${Number((bytes / 1024 / 1024).toFixed(2))} MiB`;
}

/** Data URL scheme 不区分大小写，所有上传/预算路径必须共用此判定。 */
export function isMediaDataUrl(source: string): boolean {
  return source.length >= 5 && source.slice(0, 5).toLowerCase() === 'data:';
}

export function inferMediaDataUrlKind(source: string): MediaDataUrlKind {
  let firstNonWhitespace = 0;
  while (firstNonWhitespace < source.length && /\s/.test(source[firstNonWhitespace])) {
    firstNonWhitespace += 1;
  }
  if (source.slice(firstNonWhitespace, firstNonWhitespace + 5).toLowerCase() === 'data:') {
    const headerLimit = firstNonWhitespace + MEDIA_DATA_URL_MAX_HEADER_CHARS + 1;
    const boundedHeader = source.slice(firstNonWhitespace, headerLimit + 1);
    const relativeCommaIndex = boundedHeader.indexOf(',');
    const headerEnd = relativeCommaIndex >= 0
      ? firstNonWhitespace + relativeCommaIndex
      : Math.min(source.length, headerLimit);
    const header = source.slice(firstNonWhitespace, headerEnd).toLowerCase();
    const mime = /^data:([^;,]+)/.exec(header)?.[1] ?? '';
    if (mime.startsWith('image/')) return 'image';
    if (mime.startsWith('video/')) return 'video';
    if (mime.startsWith('audio/')) return 'audio';
    return 'other';
  }

  const normalized = source.trim().toLowerCase();
  const mime = /^[a-z]+\/[a-z0-9.+-]+$/i.test(normalized) ? normalized : '';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';

  const pathWithoutQuery = normalized.split(/[?#]/, 1)[0];
  const ext = pathWithoutQuery.split('.').pop() || '';
  const inferredMime = getMimeType(ext);
  if (inferredMime.startsWith('image/')) return 'image';
  if (inferredMime.startsWith('video/')) return 'video';
  if (inferredMime.startsWith('audio/')) return 'audio';
  return 'other';
}

export function assertMediaDataUrlSize(
  bytes: number,
  kind: MediaDataUrlKind,
  label?: string,
): void {
  const maxBytes = MEDIA_DATA_URL_MAX_BYTES[kind];
  if (bytes > maxBytes) {
    throw new MediaDataUrlTooLargeError(bytes, maxBytes, kind, label);
  }
}

/** 不解码 payload 即估算 Data URL 的原始字节数，避免超大输入先触发 atob。 */
export function assertMediaDataUrlWithinLimit(
  dataUrl: string,
  kind: MediaDataUrlKind,
  label?: string,
): void {
  const bytes = estimateMediaDataUrlBytes(dataUrl);
  assertMediaDataUrlSize(bytes, kind, label);
}

/** 大 Data URL 的可取消预算扫描，避免长时间阻塞 WebView 事件循环。 */
export async function assertMediaDataUrlWithinLimitAsync(
  dataUrl: string,
  kind: MediaDataUrlKind,
  label?: string,
  signal?: AbortSignal,
): Promise<number> {
  const bytes = await estimateMediaDataUrlBytesAsync(dataUrl, signal);
  assertMediaDataUrlSize(bytes, kind, label);
  return bytes;
}

function resolveDataUrlMetadata(dataUrl: string): { commaIndex: number; metadata: string } {
  const boundedHeader = dataUrl.slice(0, MEDIA_DATA_URL_MAX_HEADER_CHARS + 2);
  const commaIndex = boundedHeader.indexOf(',');
  if (commaIndex < 0) {
    if (dataUrl.length > MEDIA_DATA_URL_MAX_HEADER_CHARS + 1) {
      throw new MediaDataUrlHeaderTooLargeError(MEDIA_DATA_URL_MAX_HEADER_CHARS + 1);
    }
    throw new Error('Data URL 格式无效：缺少元数据与内容分隔符');
  }
  if (commaIndex > MEDIA_DATA_URL_MAX_HEADER_CHARS) {
    throw new MediaDataUrlHeaderTooLargeError(commaIndex);
  }
  return { commaIndex, metadata: dataUrl.slice(0, commaIndex) };
}

function estimateScannedDataUrlBytes(
  metadata: string,
  payloadLength: number,
  lastCharacter: string,
  secondLastCharacter: string,
): number {
  if (!/;base64(?:;|$)/i.test(metadata)) return payloadLength;
  const padding = lastCharacter === '=' ? (secondLastCharacter === '=' ? 2 : 1) : 0;
  return Math.max(0, Math.floor((payloadLength * 3) / 4) - padding);
}

/** 不解码 payload 即估算 Data URL 的原始字节数。 */
export function estimateMediaDataUrlBytes(dataUrl: string): number {
  const { commaIndex, metadata } = resolveDataUrlMetadata(dataUrl);
  let payloadLength = 0;
  let lastCharacter = '';
  let secondLastCharacter = '';
  for (let index = commaIndex + 1; index < dataUrl.length; index += 1) {
    const characterCode = dataUrl.charCodeAt(index);
    if (characterCode === 32 || (characterCode >= 9 && characterCode <= 13)) continue;
    payloadLength += 1;
    secondLastCharacter = lastCharacter;
    lastCharacter = dataUrl[index];
  }
  return estimateScannedDataUrlBytes(
    metadata,
    payloadLength,
    lastCharacter,
    secondLastCharacter,
  );
}

export async function estimateMediaDataUrlBytesAsync(
  dataUrl: string,
  signal?: AbortSignal,
): Promise<number> {
  throwIfMediaReadAborted(signal);
  const { commaIndex, metadata } = resolveDataUrlMetadata(dataUrl);
  let payloadLength = 0;
  let lastCharacter = '';
  let secondLastCharacter = '';
  const yieldEveryChars = 1024 * 1024;
  for (let index = commaIndex + 1; index < dataUrl.length; index += 1) {
    const characterCode = dataUrl.charCodeAt(index);
    if (characterCode !== 32 && (characterCode < 9 || characterCode > 13)) {
      payloadLength += 1;
      secondLastCharacter = lastCharacter;
      lastCharacter = dataUrl[index];
    }
    if ((index - commaIndex) % yieldEveryChars === 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      throwIfMediaReadAborted(signal);
    }
  }
  throwIfMediaReadAborted(signal);
  return estimateScannedDataUrlBytes(
    metadata,
    payloadLength,
    lastCharacter,
    secondLastCharacter,
  );
}

/** 把一个已生成/既有的 Data URL 计入请求级总预算。 */
export function consumeMediaDataUrlBudget(
  budget: MediaDataUrlBudget | undefined,
  dataUrl: string,
): void {
  if (!budget || !isMediaDataUrl(dataUrl)) return;
  const bytes = estimateMediaDataUrlBytes(dataUrl);
  consumeMediaDataUrlBudgetBytes(budget, bytes);
}

/** 已知原始字节数时直接计入预算，避免对新生成的 Base64 再扫描一遍。 */
export function consumeMediaDataUrlBudgetBytes(
  budget: MediaDataUrlBudget | undefined,
  bytes: number,
): void {
  if (!budget) return;
  assertMediaDataUrlBudgetAvailable(budget, bytes);
  budget.usedBytes += bytes;
}

/** 在读取/编码前用已知原始字节数预检请求级剩余预算，不提前占用额度。 */
export function assertMediaDataUrlBudgetAvailable(
  budget: MediaDataUrlBudget | undefined,
  bytes: number,
): void {
  if (!budget) return;
  const nextBytes = budget.usedBytes + bytes;
  if (nextBytes > budget.maxBytes) {
    throw new MediaDataUrlTotalTooLargeError(nextBytes, budget.maxBytes, budget.label);
  }
}

/** 解析裁剪来源，本地文件使用 asset URL，远程图片按需绕过 CORS。 */
export async function fetchImageForCrop(imageUrl: string): Promise<string> {
  if (isLocalMediaUrl(imageUrl)) {
    const localPath = localMediaUrlToPath(imageUrl);
    if (localPath && isTauriEnv()) return getAssetUrlFromPath(localPath);
    return imageUrl;
  }
  // 远程 URL：通过 Rust 端 reqwest 原生 HTTP 下载（WebView CORS 不适用）
  if (isTauriEnv() && isRemoteMediaUrl(imageUrl)) {
    const requireNativeSource = shouldLoadNativeComfyImage(imageUrl);
    try {
      const dataUrl: string = await invoke('fetch_image_data_url', { url: imageUrl });
      return dataUrl;
    } catch (err) {
      if (requireNativeSource) {
        // 原生异常可能含地址或凭据；用固定网络异常跨过界面边界，不保留原始 cause。
        throw new DOMException('ComfyUI 图片读取失败，请检查服务连接或访问权限后重试', 'NetworkError');
      }
      console.warn('[fileService] fetchImageForCrop via Rust failed, fallback to original URL:', err);
      return imageUrl;
    }
  }
  return imageUrl;
}

export interface ReadFileToDataUrlOptions {
  kind?: MediaDataUrlKind;
  label?: string;
  dataUrlBudget?: MediaDataUrlBudget;
  signal?: AbortSignal;
}

export function mediaReadAbortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('读取已取消', 'AbortError');
}

export function throwIfMediaReadAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw mediaReadAbortReason(signal);
}

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function readBlobAsDataUrl(blob: Blob, signal?: AbortSignal): Promise<string> {
  throwIfMediaReadAborted(signal);
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    const cleanup = () => signal?.removeEventListener('abort', onAbort);
    const onAbort = () => {
      if (reader.readyState === FileReader.LOADING) reader.abort();
      cleanup();
      reject(mediaReadAbortReason(signal!));
    };
    reader.onload = () => {
      cleanup();
      resolve(reader.result as string);
    };
    reader.onerror = () => {
      cleanup();
      reject(reader.error ?? new Error('媒体读取失败'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    reader.readAsDataURL(blob);
  });
}

/** 读取本地路径或媒体 URL，返回有明确内存预算的 data URL。 */
export async function readFileToDataUrl(
  filePath: string,
  options: ReadFileToDataUrlOptions = {},
): Promise<string | null> {
  try {
    throwIfMediaReadAborted(options.signal);
    const localPath = localMediaUrlToPath(filePath);
    const readPath = localPath ?? filePath;
    const normalized = readPath.replace(/\\/g, '/');
    const ext = normalized.split('.').pop()?.toLowerCase() || '';
    const kind = options.kind ?? inferMediaDataUrlKind(normalized);
    const label = options.label ?? MEDIA_KIND_LABELS[kind];

    if (isMediaDataUrl(filePath)) {
      const bytes = await assertMediaDataUrlWithinLimitAsync(filePath, kind, label, options.signal);
      consumeMediaDataUrlBudgetBytes(options.dataUrlBudget, bytes);
      return filePath;
    }

    if (isTauriEnv() && (localPath !== undefined || (!isLocalMediaUrl(filePath) && !isRemoteMediaUrl(filePath)))) {
      // 授权路径可 stat 时先拒绝，避免先把整个大文件读进 WebView 内存。
      try {
        const fileInfo = await stat(readPath);
        throwIfMediaReadAborted(options.signal);
        assertMediaDataUrlSize(fileInfo.size, kind, label);
        assertMediaDataUrlBudgetAvailable(options.dataUrlBudget, fileInfo.size);
      } catch (error) {
        if (options.signal?.aborted) throw mediaReadAbortReason(options.signal);
        if (
          error instanceof MediaDataUrlTooLargeError
          || error instanceof MediaDataUrlTotalTooLargeError
          || isAbortError(error)
        ) throw error;
        // stat 不可用时，授权读取后仍会在 Base64 转换前二次检查。
      }
      const content = await tauriReadFile(readPath);
      throwIfMediaReadAborted(options.signal);
      assertMediaDataUrlSize(content.byteLength, kind, label);
      assertMediaDataUrlBudgetAvailable(options.dataUrlBudget, content.byteLength);
      const base64 = await bytePartsToBase64Async([content], options.signal);
      const mimeType = getMimeType(ext);
      const dataUrl = `data:${mimeType};base64,${base64}`;
      consumeMediaDataUrlBudgetBytes(options.dataUrlBudget, content.byteLength);
      return dataUrl;
    }

    // ComfyUI 取件使用原生代理；asset/blob 与其他既有来源保留原读取方式。
    const resp = githubMirrorUrl(filePath)
      ? new Response(await downloadGithubBytes(filePath, { signal: options.signal, maxBytes: MEDIA_DATA_URL_BYTE_LIMITS[kind] }),
        { headers: { 'Content-Type': getMimeType(ext) } })
      : await (shouldLoadNativeComfyImage(filePath) ? corsSafeFetch : fetch)(filePath, { signal: options.signal });
    throwIfMediaReadAborted(options.signal);
    if (!resp.ok) throw new Error(`读取本地文件失败 (${resp.status})`);
    const contentLength = Number(resp.headers.get('Content-Length'));
    if (Number.isFinite(contentLength) && contentLength >= 0) {
      assertMediaDataUrlSize(contentLength, kind, label);
      assertMediaDataUrlBudgetAvailable(options.dataUrlBudget, contentLength);
    }
    const blob = await resp.blob();
    throwIfMediaReadAborted(options.signal);
    assertMediaDataUrlSize(blob.size, kind, label);
    assertMediaDataUrlBudgetAvailable(options.dataUrlBudget, blob.size);
    const dataUrl = await readBlobAsDataUrl(blob, options.signal);
    consumeMediaDataUrlBudgetBytes(options.dataUrlBudget, blob.size);
    return dataUrl;
  } catch (error) {
    if (options.signal?.aborted) throw mediaReadAbortReason(options.signal);
    if (
      error instanceof MediaDataUrlTooLargeError
      || error instanceof MediaDataUrlTotalTooLargeError
      || error instanceof MediaDataUrlHeaderTooLargeError
      || isAbortError(error)
    ) throw error;
    console.error('readFileToDataUrl failed:', error);
    return null;
  }
}

/**
 * fileService 文件操作服务 — 项目媒体文件的拷贝/保存/下载/重命名、源文件上传、
 * 节点输出另存为、系统文件管理器定位。基础设施见 ./fs/core，删除域见 ./fs/trash，
 * 全局资产库见 ./fs/assetLibrary（均通过本模块统一对外导出）。
 */
import { writeFile, readFile as tauriReadFile, stat, rename } from '@tauri-apps/plugin-fs';
import { open, save } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { identifyAsset } from './fs/assetIndex';
import { walkDirectoryFiles } from './fs/assetLibrary';
import {
  isTauriEnv,
  getMimeType,
  arrayBufferToBase64,
  bytePartsToBase64Async,
  sanitizeFileName,
  stripVerbatimPrefix,
  getConvertFileSrc,
  ensureProjectDataDir,
  getProjectDataDir,
  resolveUniqueDestPath,
  buildNodeFileName,
  notifyProjectDiskChanged,
  getFileCategory,
  type AssetFileEntry,
} from './fs/core';

export interface FileTransferProgress {
  taskId: string;
  transferredBytes: number;
  totalBytes: number | null;
}

export interface FileTransferOptions {
  signal?: AbortSignal;
  onProgress?: (progress: FileTransferProgress) => void;
}

interface NativeFileTransferResult {
  path: string;
  totalBytes: number;
  contentType: string | null;
}

const downloadDestinationQueues = new Map<string, Promise<void>>();

export type MediaDataUrlKind = 'image' | 'video' | 'audio' | 'other';

/**
 * Data URL / Base64 兼容路径会在 JS 和 IPC 间产生多份副本，因此必须在读取前限制原始字节数。
 * 正常项目文件走原生流式拷贝，不受这些上限影响。
 */
export const MEDIA_DATA_URL_MAX_BYTES: Readonly<Record<MediaDataUrlKind, number>> = {
  image: 32 * 1024 * 1024,
  video: 64 * 1024 * 1024,
  audio: 32 * 1024 * 1024,
  other: 8 * 1024 * 1024,
};

/** 单次模型请求内允许同时保留的 Data URL 原始字节总量。 */
export const MEDIA_DATA_URL_TOTAL_MAX_BYTES = 128 * 1024 * 1024;

/** Data URL 元数据只应包含 MIME 和少量参数，限制长度避免缓存键/解析产生巨型副本。 */
export const MEDIA_DATA_URL_MAX_HEADER_CHARS = 4096;

const MEDIA_KIND_LABELS: Readonly<Record<MediaDataUrlKind, string>> = {
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

async function withDownloadDestinationLock<T>(
  dataDir: string,
  fileName: string,
  operation: () => Promise<T>,
): Promise<T> {
  const lockKey = `${dataDir}\n${sanitizeFileName(fileName)}`;
  const previous = downloadDestinationQueues.get(lockKey);
  const waitForTurn = previous?.catch(() => undefined) ?? Promise.resolve();
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = waitForTurn.then(() => gate);
  downloadDestinationQueues.set(lockKey, tail);

  await waitForTurn;
  try {
    return await operation();
  } finally {
    release();
    if (downloadDestinationQueues.get(lockKey) === tail) {
      downloadDestinationQueues.delete(lockKey);
    }
  }
}

function createTransferTaskId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `transfer-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function runNativeFileTransfer(
  command: 'copy_file_streamed' | 'download_file_streamed',
  args: Record<string, string>,
  options?: FileTransferOptions,
): Promise<NativeFileTransferResult> {
  const taskId = createTransferTaskId();
  let unlisten: UnlistenFn | undefined;
  let cancelRequested = false;

  const cancel = () => {
    if (cancelRequested) return;
    cancelRequested = true;
    void invoke('cancel_file_transfer', { taskId }).catch((error) => {
      console.warn('[fileService] cancel_file_transfer failed:', error);
    });
  };

  if (options?.signal?.aborted) {
    throw new DOMException('File transfer aborted', 'AbortError');
  }

  try {
    if (options?.onProgress) {
      unlisten = await listen<FileTransferProgress>('file-transfer-progress', ({ payload }) => {
        if (payload.taskId === taskId) options.onProgress?.(payload);
      });
    }
    options?.signal?.addEventListener('abort', cancel, { once: true });
    return await invoke<NativeFileTransferResult>(command, { taskId, ...args });
  } finally {
    options?.signal?.removeEventListener('abort', cancel);
    unlisten?.();
  }
}

// ── 统一对外导出：存储、基础设施、删除域、资产库域 ──
export {
  saveProject,
  loadProjectsList,
  loadProjectData,
  deleteProjectData,
  saveWorkflow,
  loadWorkflows,
  deleteWorkflow,
  saveConfig,
  loadConfig,
  loadConfigWithSecrets,
  loadConfigWithoutSecrets,
  savePreset,
  loadPresets,
  deletePreset,
  saveSkill,
  loadSkills,
  deleteSkill,
  saveStyle,
  loadStyles,
  deleteStyle,
  type ProjectSaveData,
  type WorkflowRecord,
  type PresetRecord,
  type SkillRecord,
  type CustomStyleRecord,
} from './storageService';
export * from './fs/core';
export * from './fs/assetIndex';
export * from './fs/trash';
export * from './fs/assetLibrary';
export * from './fs/skillFiles';
export * from './fs/externalEditors';

/**
 * 同步用户明确选择的文件目录白名单。
 * 仅保存根目录和素材文件夹可进入；ComfyUI 等其他配置路径不得传入。
 *
 * 保存根目录会额外同步给原生侧作为用户存储根：智能体压缩包解压目录等派生数据
 * 据此落到用户指定的磁盘，而不是系统盘。传 null 表示未设置，原生侧回退到默认目录。
 */
export async function syncAuthorizedDirectories(config: {
  baseDataDir?: string;
  assetFolders?: string[];
}): Promise<void> {
  if (!isTauriEnv()) return;

  const directories = [config.baseDataDir, ...(config.assetFolders ?? [])]
    .map((path) => path?.trim())
    .filter((path): path is string => !!path);

  const rejected = await invoke<string[]>('sync_authorized_directories', {
    directories: [...new Set(directories)],
    baseDataDir: config.baseDataDir?.trim() || null,
  });
  if (rejected.length > 0) {
    console.warn('[fileService] 已跳过不存在或无效的授权目录:', rejected);
  }
}

/** 浏览器降级：通过 file input 读取文件 */
function browserOpenFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.style.display = 'none';
    document.body.appendChild(input);
    input.addEventListener('change', () => {
      document.body.removeChild(input);
      resolve(input.files?.[0] ?? null);
    });
    input.addEventListener('cancel', () => {
      document.body.removeChild(input);
      resolve(null);
    });
    input.click();
    window.addEventListener(
      'focus',
      () => {
        setTimeout(() => {
          if (document.body.contains(input)) {
            document.body.removeChild(input);
            resolve(null);
          }
        }, 300);
      },
      { once: true }
    );
  });
}

/** 读取本地文件路径，返回 data URL（供剪贴板粘贴等场景使用） */
export async function fetchImageForCrop(imageUrl: string): Promise<string> {
  // data:/blob: 是同源 URL，asset:// / asset.localhost 是 Tauri 本地资源，不需要绕过 CORS
  if (
    imageUrl.startsWith('data:') ||
    imageUrl.startsWith('blob:') ||
    imageUrl.startsWith('asset://') ||
    imageUrl.includes('asset.localhost')
  ) {
    return imageUrl;
  }
  // 远程 URL：通过 Rust 端 reqwest 原生 HTTP 下载（WebView CORS 不适用）
  if (isTauriEnv() && /^https?:\/\//i.test(imageUrl)) {
    try {
      const dataUrl: string = await invoke('fetch_image_data_url', { url: imageUrl });
      return dataUrl;
    } catch (err) {
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

function mediaReadAbortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('读取已取消', 'AbortError');
}

function throwIfMediaReadAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw mediaReadAbortReason(signal);
}

function isAbortError(error: unknown): boolean {
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

/** 读取本地文件路径，返回有明确内存预算的 data URL。 */
export async function readFileToDataUrl(
  filePath: string,
  options: ReadFileToDataUrlOptions = {},
): Promise<string | null> {
  try {
    throwIfMediaReadAborted(options.signal);
    // Normalize Windows backslash paths
    const normalized = filePath.replace(/\\/g, '/');
    const ext = normalized.split('.').pop()?.toLowerCase() || '';
    const kind = options.kind ?? inferMediaDataUrlKind(normalized);
    const label = options.label ?? MEDIA_KIND_LABELS[kind];

    if (isTauriEnv()) {
      // 授权路径可 stat 时先拒绝，避免先把整个大文件读进 WebView 内存。
      try {
        const fileInfo = await stat(filePath);
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
        // 某些 asset/file URL 无法直接 stat，读取后仍会在 Base64 转换前二次检查。
      }
      const content = await tauriReadFile(filePath);
      throwIfMediaReadAborted(options.signal);
      assertMediaDataUrlSize(content.byteLength, kind, label);
      assertMediaDataUrlBudgetAvailable(options.dataUrlBudget, content.byteLength);
      const base64 = await bytePartsToBase64Async([content], options.signal);
      const mimeType = getMimeType(ext);
      const dataUrl = `data:${mimeType};base64,${base64}`;
      consumeMediaDataUrlBudgetBytes(options.dataUrlBudget, content.byteLength);
      return dataUrl;
    }

    // Browser fallback: try fetch for http(s) URLs, or file:// for local dev
    const resp = await fetch(normalized, { signal: options.signal });
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
    console.error('readFileToDataUrl failed:', filePath, error);
    return null;
  }
}

// ============================================
// Project data files — 项目媒体文件读写
// ============================================

/**
 * 将文件拷贝到项目数据目录，返回本地路径和 asset URL
 * 如文件已存在于目标目录则跳过拷贝
 */
export async function copyFileToProjectData(
  sourcePath: string,
  projectId: string,
  options?: FileTransferOptions,
): Promise<{ filePath: string; assetUrl: string; fileName: string } | null> {
  if (!isTauriEnv()) return null;

  const dataDir = await ensureProjectDataDir(projectId);
  if (!dataDir) return null;

  const fileName = sourcePath.split(/[/\\]/).pop() || 'file';
  const destPath = await resolveUniqueDestPath(dataDir, fileName);

  try {
    await runNativeFileTransfer('copy_file_streamed', { sourcePath, destinationPath: destPath }, options);
    notifyProjectDiskChanged();
  } catch (err) {
    console.error('Failed to copy file to project data:', sourcePath, err);
    // Don't fallback to convertFileSrc on external paths — asset protocol won't serve them
    // Return null so caller can fallback to readFile → base64 in-memory loading
    return null;
  }

  const convertFileSrc = await getConvertFileSrc();
  if (!convertFileSrc) {
    // If convertFileSrc unavailable, still return the path
    return { filePath: destPath, assetUrl: '', fileName };
  }

  return { filePath: destPath, assetUrl: convertFileSrc(destPath), fileName };
}

/**
 * 将 data URL 的内容保存到项目数据目录
 * 用于 AI 生成的图片等场景
 */
export async function saveDataUrlToProjectData(
  dataUrl: string,
  projectId: string,
  fileName: string,
): Promise<{ filePath: string; assetUrl: string } | null> {
  if (!isTauriEnv()) return null;

  const dataDir = await ensureProjectDataDir(projectId);
  if (!dataDir) return null;

  try {
    // Parse data URL to binary
    const match = dataUrl.match(/^data:(.+?);base64,(.+)$/i);
    let bytes: Uint8Array;
    if (match) {
      const b64 = match[2];
      const binaryStr = atob(b64);
      bytes = new Uint8Array(binaryStr.length);
      for (let i = 0; i < binaryStr.length; i++) {
        bytes[i] = binaryStr.charCodeAt(i);
      }
    } else {
      // Non-base64 data URL: fetch and convert
      const resp = await fetch(dataUrl);
      const buffer = await resp.arrayBuffer();
      bytes = new Uint8Array(buffer);
    }

    const destPath = await resolveUniqueDestPath(dataDir, fileName);
    await writeFile(destPath, bytes);
    notifyProjectDiskChanged();

    const convertFileSrc = await getConvertFileSrc();
    const assetUrl = convertFileSrc ? convertFileSrc(destPath) : '';

    return { filePath: destPath, assetUrl };
  } catch (err) {
    console.error('Failed to save data URL to project data:', fileName, err);
    return null;
  }
}

/**
 * 将二进制数据保存到项目数据目录（用于粘贴/裁剪等无源路径的场景）
 * @returns { filePath, assetUrl } 或 null（非 Tauri 或失败）
 */
export async function saveBinaryToProjectData(
  data: Uint8Array,
  projectId: string,
  fileName: string,
): Promise<{ filePath: string; assetUrl: string } | null> {
  if (!isTauriEnv()) return null;

  const dataDir = await ensureProjectDataDir(projectId);
  if (!dataDir) return null;

  const destPath = await resolveUniqueDestPath(dataDir, fileName);

  try {
    await writeFile(destPath, data);
    notifyProjectDiskChanged();
  } catch (err) {
    console.error('Failed to save binary to project data:', destPath, err);
    return null;
  }

  const convertFileSrc = await getConvertFileSrc();
  const assetUrl = convertFileSrc ? convertFileSrc(destPath) : '';

  return { filePath: destPath, assetUrl };
}

/**
 * 为会自行写入结果的本地处理器（如 ONNX）分配项目目录内的唯一输出路径。
 * 只返回路径，不预先创建文件。
 */
export async function resolveProjectOutputPath(
  projectId: string,
  fileName: string,
): Promise<string | null> {
  if (!isTauriEnv()) return null;
  const dataDir = await ensureProjectDataDir(projectId);
  if (!dataDir) return null;
  return resolveUniqueDestPath(dataDir, sanitizeFileName(fileName));
}

/**
 * 把已生成的二进制结果另存到用户选择的本地位置。
 * 路径只来自系统保存对话框，文件写入仍统一收口在 fileService。
 */
export async function saveBinaryToLocalFile(
  data: Uint8Array,
  fileName: string,
  filters: { name: string; extensions: string[] }[] = [
    { name: '视频文件', extensions: ['mp4'] },
  ],
): Promise<string | null> {
  if (!isTauriEnv()) return null;
  const destPath = await save({ defaultPath: fileName, filters });
  if (!destPath) return null;
  await writeFile(destPath, data);
  return destPath;
}

/** 从 URL 中提取文件名 */
function extractFileNameFromUrl(url: string, fallbackPrefix: string): string {
  // ComfyUI: /view?filename=xxx.png&...
  try {
    const u = new URL(url);
    const filename = u.searchParams.get('filename');
    if (filename) return sanitizeFileName(filename.split(/[/\\]/).pop()!);
    // 普通路径 URL: https://cdn.com/path/to/file.png
    const pathname = u.pathname;
    const lastSegment = pathname.split('/').pop() || '';
    if (lastSegment && lastSegment.includes('.')) return sanitizeFileName(lastSegment);
  } catch { /* invalid URL, fall through */ }
  // 兜底：时间戳命名
  const ts = Date.now();
  return `${fallbackPrefix}-${ts}`;
}

/** MIME → 扩展名（带点），用于无法从 URL 推断扩展名时兜底 */
const MIME_TO_EXT: Record<string, string> = {
  'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif',
  'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov',
  'audio/mpeg': '.mp3', 'audio/wav': '.wav', 'audio/ogg': '.ogg', 'audio/aac': '.aac',
};

/** 从 URL 路径或 MIME 推断文件扩展名（带点），都失败时按 fallbackPrefix 给默认值 */
function guessExtension(url: string, mime: string | undefined, fallbackPrefix: string): string {
  try {
    const u = new URL(url);
    const fn = u.searchParams.get('filename') || u.pathname.split('/').pop() || '';
    const dot = fn.lastIndexOf('.');
    if (dot > 0 && dot < fn.length - 1) return fn.slice(dot).toLowerCase();
  } catch { /* invalid URL, fall through */ }
  if (mime && MIME_TO_EXT[mime]) return MIME_TO_EXT[mime];
  if (fallbackPrefix.includes('video')) return '.mp4';
  if (fallbackPrefix.includes('audio')) return '.mp3';
  return '.png';
}

/** Data URL / Blob URL 只是内存载体，不能进入项目、历史或对话持久化。 */
export function isTransientMediaUrl(url: string | undefined): boolean {
  return Boolean(url && (/^data:/i.test(url) || /^blob:/i.test(url)));
}

export interface PersistedProjectMedia {
  filePath?: string;
  assetUrl?: string;
  /** 展示用 URL；落盘成功时指向项目文件。 */
  mediaUrl: string;
  /** 可持久化的来源 URL；内嵌/临时 URL 会被本地 asset URL 替换。 */
  sourceUrl: string;
}

/**
 * 将一次媒体生成结果收敛为可持久化的项目文件引用。
 * 没有项目目录时（浏览器环境）无法落盘：远程 URL 仍可展示，但内嵌媒体一旦进入
 * 持久化就是死数据，只能失败关闭。有项目目录时落盘失败同样必须失败关闭，
 * data:/blob: 落盘后还会把来源改为 asset URL，避免把完整媒体正文回写进 IndexedDB。
 */
export async function persistMediaUrlToProjectData(
  url: string,
  projectId: string,
  fallbackPrefix: string,
  baseName?: string,
  options?: FileTransferOptions,
): Promise<PersistedProjectMedia> {
  if (!isTauriEnv()) {
    if (isTransientMediaUrl(url)) throw new Error('当前环境没有项目目录，无法保存内嵌媒体');
    return { mediaUrl: url, sourceUrl: url };
  }
  const saved = await downloadUrlAndSave(url, projectId, fallbackPrefix, baseName, options);
  if (!saved?.filePath || !saved.assetUrl) {
    throw new Error('生成媒体未能写入项目目录');
  }
  if (isTransientMediaUrl(url)) {
    return { ...saved, mediaUrl: saved.assetUrl, sourceUrl: saved.assetUrl };
  }
  return {
    ...saved,
    mediaUrl: saved.assetUrl,
    sourceUrl: url,
  };
}

/**
 * 下载远程 URL 文件并保存到项目数据目录
 * @param baseName 可选，优先用作文件名主体（通常为节点名）；为空时从 URL 提取或用 fallbackPrefix
 * @returns { filePath, assetUrl } 或 null（失败/非 Tauri）
 */
export async function downloadUrlAndSave(
  url: string,
  projectId: string,
  fallbackPrefix: string,
  baseName?: string,
  options?: FileTransferOptions,
): Promise<{ filePath: string; assetUrl: string } | null> {
  if (!isTauriEnv()) return null;
  try {
    if (isMediaDataUrl(url)) {
      const mime = /^data:([^;,]+)/i.exec(url)?.[1];
      const fileName = baseName && baseName.trim()
        ? buildNodeFileName(baseName, guessExtension(url, mime, fallbackPrefix), fallbackPrefix)
        : `${sanitizeFileName(fallbackPrefix)}-${Date.now()}${guessExtension('', mime, fallbackPrefix)}`;
      return saveDataUrlToProjectData(url, projectId, fileName);
    }

    if (/^blob:/i.test(url)) {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`读取临时媒体失败：HTTP ${response.status}`);
      const mime = response.headers.get('content-type') || undefined;
      const fileName = baseName && baseName.trim()
        ? buildNodeFileName(baseName, guessExtension(url, mime, fallbackPrefix), fallbackPrefix)
        : `${sanitizeFileName(fallbackPrefix)}-${Date.now()}${guessExtension('', mime, fallbackPrefix)}`;
      const bytes = new Uint8Array(await response.arrayBuffer());
      return saveBinaryToProjectData(bytes, projectId, fileName);
    }

    // 优先用节点名命名；否则沿用从 URL 提取文件名的旧逻辑
    const fileName = baseName && baseName.trim()
      ? buildNodeFileName(baseName, guessExtension(url, undefined, fallbackPrefix), fallbackPrefix)
      : extractFileNameFromUrl(url, fallbackPrefix);
    const dataDir = await ensureProjectDataDir(projectId);
    if (!dataDir) return null;
    const result = await withDownloadDestinationLock(
      dataDir,
      fileName,
      async () => {
        const destPath = await resolveUniqueDestPath(dataDir, fileName);
        return runNativeFileTransfer(
          'download_file_streamed',
          { url, destinationPath: destPath },
          options,
        );
      },
    );
    notifyProjectDiskChanged();
    const toAssetUrl = await getConvertFileSrc();
    return { filePath: result.path, assetUrl: toAssetUrl ? toAssetUrl(result.path) : '' };
  } catch (err) {
    console.warn('[fileService] downloadUrlAndSave failed:', url, err);
    return null;
  }
}

/**
 * 将项目数据目录内的文件重命名为与节点名一致（保留扩展名，冲突时加序号）。
 * 仅处理位于当前项目目录内的文件；外部引用文件、非 Tauri 环境、无变化时返回 null。
 * @returns 新的 { filePath, assetUrl, fileName }，或 null
 */
export async function renameProjectFileToLabel(
  filePath: string,
  newLabel: string,
  projectId: string,
): Promise<{ filePath: string; assetUrl: string; fileName: string } | null> {
  if (!isTauriEnv() || !filePath) return null;
  const projectDir = await getProjectDataDir(projectId);
  if (!projectDir) return null;

  const normPath = stripVerbatimPrefix(filePath).replace(/\\/g, '/');
  const normDir = projectDir.replace(/\\/g, '/').replace(/\/+$/, '');
  // 只重命名项目目录内的文件，外部引用文件保持不动
  if (!normPath.startsWith(`${normDir}/`)) return null;

  const oldName = normPath.split('/').pop() || '';
  const dotIndex = oldName.lastIndexOf('.');
  const ext = dotIndex > 0 ? oldName.slice(dotIndex) : '';
  // 若用户输入已带相同扩展名（显示名常含扩展名），先去掉避免重复后缀
  let baseLabel = newLabel;
  if (ext && baseLabel.toLowerCase().endsWith(ext.toLowerCase())) {
    baseLabel = baseLabel.slice(0, -ext.length);
  }
  const newName = buildNodeFileName(baseLabel, ext, 'file');
  if (newName === oldName) return null; // 名称未变化

  try {
    // 就地改名：分组内的文件留在自己的子文件夹，否则会被搬回项目根目录
    const currentDir = normPath.slice(0, normPath.length - oldName.length - 1);
    const destPath = await resolveUniqueDestPath(currentDir, newName);
    await rename(filePath, destPath);
    notifyProjectDiskChanged();
    const convertFileSrc = await getConvertFileSrc();
    const assetUrl = convertFileSrc ? convertFileSrc(destPath) : '';
    const fileName = destPath.replace(/\\/g, '/').split('/').pop() || newName;
    return { filePath: destPath, assetUrl, fileName };
  } catch (err) {
    console.warn('[fileService] renameProjectFileToLabel failed:', filePath, err);
    return null;
  }
}

/** 获取项目文件列表 */
export async function listProjectFiles(projectId: string): Promise<AssetFileEntry[]> {
  const projectDir = await getProjectDataDir(projectId);
  if (!projectDir) return [];
  // 递归：节点文件可能位于分组子文件夹内
  const allFiles = await walkDirectoryFiles(projectDir);
  // Filter out files inside AppData / .trash subdirectories (可能嵌套在分组文件夹内)
  const files = allFiles.filter((f) => {
    const relative = f.path.substring(projectDir.length).replace(/\\/g, '/').replace(/^\//, '');
    return !relative.split('/').slice(0, -1).some((dir) => dir === 'AppData' || dir === '.trash');
  });
  return Promise.all(files.map(async (file) => {
    const identity = await identifyAsset(file.path, {
      rootPath: projectDir,
      projectId,
      source: 'project',
      size: file.size,
    });
    return {
      ...file,
      assetId: identity.assetId,
      relativePath: identity.relativePath,
      source: 'project' as const,
      availability: 'online' as const,
    };
  }));
}

export interface AgentTextFileSelection {
  path: string;
  fileName: string;
  size: number;
  extension: string;
}

const AGENT_TEXT_EXTENSIONS = [
  'txt', 'md', 'markdown', 'json', 'csv', 'tsv', 'yaml', 'yml',
  'xml', 'html', 'htm', 'css', 'js', 'jsx', 'ts', 'tsx', 'log',
];

/** 通过原生选择器选择 Agent 可读取的文本文件；路径只返回给授权服务，不进入模型。 */
export async function selectAgentTextFiles(
  title = '授权当前对话读取本地文件',
): Promise<AgentTextFileSelection[]> {
  if (!isTauriEnv()) throw new Error('本地文件授权仅在 Tauri 桌面环境可用');
  const selected = await open({
    multiple: true,
    directory: false,
    title,
    filters: [{ name: '文本与数据文件', extensions: AGENT_TEXT_EXTENSIONS }],
  });
  if (!selected) return [];
  const paths = Array.isArray(selected) ? selected : [selected];
  const files: AgentTextFileSelection[] = [];
  for (const path of paths.slice(0, 10)) {
    const fileName = path.split(/[/\\]/).pop() || '未命名文件';
    const extension = fileName.split('.').pop()?.toLowerCase() || '';
    if (!AGENT_TEXT_EXTENSIONS.includes(extension)) continue;
    const metadata = await stat(path);
    if (!metadata.isFile) continue;
    files.push({ path, fileName, size: metadata.size, extension });
  }
  return files;
}

/** 读取已经由授权服务复核过的路径；严格限制字节数并使用 UTF-8 解码。 */
export async function readAgentAuthorizedTextFile(
  path: string,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<string> {
  if (!isTauriEnv()) throw new Error('本地文件读取仅在 Tauri 桌面环境可用');
  if (signal?.aborted) throw new DOMException('读取已取消', 'AbortError');
  const metadata = await stat(path);
  if (!metadata.isFile) throw new Error('授权目标已不再是文件');
  if (metadata.size > maxBytes) throw new Error(`文件超过 ${Math.floor(maxBytes / 1024)} KB 读取限制`);
  const bytes = await tauriReadFile(path);
  if (signal?.aborted) throw new DOMException('读取已取消', 'AbortError');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('文件不是有效的 UTF-8 文本');
  }
}

/** 用户确认后通过原生保存对话框写入文本；返回值不包含绝对路径。 */
export async function saveAgentTextOutput(
  content: string,
  suggestedName: string,
  title = '保存 Agent 输出',
): Promise<{ fileName: string } | null> {
  if (!isTauriEnv()) throw new Error('本地文件写入仅在 Tauri 桌面环境可用');
  const safeName = sanitizeFileName(suggestedName || 'agent-output.txt');
  const destPath = await save({
    defaultPath: safeName,
    title,
    filters: [{ name: '文本文件', extensions: ['txt', 'md', 'json', 'csv'] }],
  });
  if (!destPath) return null;
  await writeFile(destPath, new TextEncoder().encode(content));
  return { fileName: destPath.split(/[/\\]/).pop() || safeName };
}

// ============================================
// Source node file upload (returns dataUrl + fileName)
// ============================================

export interface UploadResult {
  dataUrl: string;
  fileName: string;
  fileSize: number;
}

/**
 * 上传文件并保存到项目数据目录（Tauri 端拷贝，浏览器端 base64）
 * @param projectId 项目 ID，为空时退回 base64 模式
 */
export async function uploadSourceFileToProject(
  accept?: string,
  projectId?: string | null,
): Promise<UploadResult & { filePath?: string } | null> {
  try {
    if (isTauriEnv()) {
      // '*/*' 是 MIME 通配符，不是有效扩展名；传空 filters 让 Tauri 显示所有文件
      const isWildcard = !accept || accept === '*/*' || accept.trim() === '*/*';
      const filters = isWildcard
        ? []
        : [{ name: '支持的文件', extensions: accept.split(',').map((e) => e.trim().replace('.', '')) }];
      const filePath = await open({
        multiple: false,
        title: '选择文件',
        filters,
      });

      if (!filePath) return null;

      const fileName = filePath.split(/[\\/]/).pop() || 'file';

      // Try to get file size (may fail for paths outside fs scope)
      let fileSize = 0;
      try {
        const sourceStat = await stat(filePath);
        fileSize = sourceStat.size;
      } catch {
        // stat not allowed — size will be obtained from content.byteLength later
      }

      // If projectId is provided, copy to project data dir
      if (projectId && projectId !== 'default') {
        const result = await copyFileToProjectData(filePath, projectId);
        if (result) {
          return { dataUrl: result.assetUrl, fileName: result.fileName, fileSize, filePath: result.filePath };
        }
      }

      // Fallback: read into memory
      const ext = fileName.split('.').pop()?.toLowerCase() || '';
      const kind = inferMediaDataUrlKind(fileName);
      if (fileSize > 0) assertMediaDataUrlSize(fileSize, kind, `${MEDIA_KIND_LABELS[kind]}「${fileName}」`);
      const content = await tauriReadFile(filePath);
      assertMediaDataUrlSize(content.byteLength, kind, `${MEDIA_KIND_LABELS[kind]}「${fileName}」`);
      const base64 = arrayBufferToBase64(content.buffer);
      const mimeType = getMimeType(ext);
      return {
        dataUrl: `data:${mimeType};base64,${base64}`,
        fileName,
        fileSize: content.byteLength,
      };
    }

    // Browser fallback
    const file = await browserOpenFile(accept || '*/*');
    if (!file) return null;

    const mimeKind = inferMediaDataUrlKind(file.type);
    const kind = mimeKind === 'other' ? inferMediaDataUrlKind(file.name) : mimeKind;
    assertMediaDataUrlSize(file.size, kind, `${MEDIA_KIND_LABELS[kind]}「${file.name}」`);
    const buffer = await file.arrayBuffer();
    const base64 = arrayBufferToBase64(buffer);
    const ext = file.name.split('.').pop()?.toLowerCase() || '';
    const mimeType = getMimeType(ext);

    return {
      dataUrl: `data:${mimeType};base64,${base64}`,
      fileName: file.name,
      fileSize: file.size,
    };
  } catch (error) {
    console.error('Upload to project failed:', error);
    throw error;
  }
}

/** 为源节点上传文件 — 返回 data URL + 文件名 + 大小（向后兼容，不保存到项目目录） */
export async function uploadSourceFile(accept?: string): Promise<UploadResult | null> {
  return uploadSourceFileToProject(accept);
}

/**
 * 从节点数据直接提取文件引用（纯同步，不依赖 Tauri stat）
 * 扫描 imageUrl / videoUrl / audioUrl / fileName / filePath
 */
export function extractFilesFromNodeData(
  nodeData: Record<string, unknown>,
): AssetFileEntry | null {
  const fileName = (nodeData.fileName as string) || '';
  const imgUrl = nodeData.imageUrl as string | undefined;
  const vidUrl = nodeData.videoUrl as string | undefined;
  const audUrl = nodeData.audioUrl as string | undefined;
  const fp = nodeData.filePath as string | undefined;

  const assetUrl = imgUrl || vidUrl || audUrl;
  if (!assetUrl && !fp) return null;

  // Derive name: fileName > filePath basename > URL basename > fallback
  let name = fileName;
  if (!name && fp) {
    name = fp.split(/[\\/]/).pop() || '';
  }
  if (!name && assetUrl) {
    if (assetUrl.startsWith('data:')) {
      name = '';
    } else {
      try {
        const u = new URL(assetUrl);
        const pathname = decodeURIComponent(u.pathname);
        name = pathname.split(/[\\/]/).pop() || '';
      } catch {
        name = '';
      }
    }
  }
  if (!name) name = 'file';

  const category = getFileCategory(name);

  // Use filePath as identifier if available, otherwise derive from name + node id
  const entryPath = fp || `node://${name}`;

  return {
    assetId: nodeData.assetId as string | undefined,
    name,
    path: entryPath,
    relativePath: nodeData.relativePath as string | undefined,
    assetUrl: assetUrl || undefined,
    size: 0,
    category,
  };
}

// ============================================
// 节点输出文件另存为 — 将节点的媒体输出或文本输出保存到用户指定位置
// ============================================

/** 根据节点类型推断默认文件扩展名 */
function getDefaultExtension(nodeType: string): string {
  switch (nodeType) {
    case 'ai-text':      return '.txt';
    case 'ai-markdown':  return '.md';
    case 'ai-image':
    case 'source-image': return '.png';
    case 'ai-video':
    case 'source-video': return '.mp4';
    case 'ai-audio':
    case 'source-audio': return '.mp3';
    case 'ai-panorama':  return '.png';
    default:             return '.txt';
  }
}

/** 根据节点类型和默认扩展名生成文件过滤器 */
function getSaveFilter(nodeType: string): { name: string; extensions: string[] }[] {
  switch (nodeType) {
    case 'ai-text':      return [{ name: '文本文件', extensions: ['txt'] }, { name: '所有文件', extensions: ['*'] }];
    case 'ai-markdown':  return [{ name: 'Markdown 文件', extensions: ['md'] }, { name: '所有文件', extensions: ['*'] }];
    case 'ai-image':
    case 'source-image':
    case 'ai-panorama':  return [{ name: '图片文件', extensions: ['png', 'jpg', 'jpeg', 'webp'] }, { name: '所有文件', extensions: ['*'] }];
    case 'ai-video':
    case 'source-video': return [{ name: '视频文件', extensions: ['mp4', 'webm', 'mov'] }, { name: '所有文件', extensions: ['*'] }];
    case 'ai-audio':
    case 'source-audio': return [{ name: '音频文件', extensions: ['mp3', 'wav', 'ogg'] }, { name: '所有文件', extensions: ['*'] }];
    default:             return [{ name: '所有文件', extensions: ['*'] }];
  }
}

/**
 * 将节点的输出内容另存为用户指定路径的文件
 * - 媒体节点（image/video/audio）：优先从 filePath 读取再写入目标
 * - data: URL：解码 base64 后写入
 * - 文本节点（text/markdown）：直接写入 output 文本
 *
 * @returns 成功返回保存路径，失败或取消返回 null
 */
export async function saveNodeOutputToFile(opts: {
  filePath?: string;
  mediaUrl?: string;
  textOutput?: string;
  nodeType: string;
  fileName?: string;
}): Promise<string | null> {
  const { filePath, mediaUrl, textOutput, nodeType, fileName } = opts;
  const defExt = getDefaultExtension(nodeType);

  if (!isTauriEnv()) {
    console.warn('[fileService] saveNodeOutputToFile: 仅 Tauri 桌面环境支持');
    return null;
  }

  // Determine default filename
  let defaultName = fileName || 'output';
  // Remove existing extension if present
  const lastDot = defaultName.lastIndexOf('.');
  if (lastDot > 0) defaultName = defaultName.substring(0, lastDot);
  defaultName += defExt;

  // Open save dialog
  const filters = getSaveFilter(nodeType);
  const destPath = await save({
    defaultPath: defaultName,
    filters,
  });

  if (!destPath) return null; // User cancelled

  try {
    // 1. Media: try real file path first
    if (filePath) {
      try {
        await writeFile(destPath, await tauriReadFile(filePath));
        return destPath;
      } catch (err) {
        // 源文件被移动/删除时不整体放弃，落到下面的 URL / 文本分支再试一次
        if (!mediaUrl && !textOutput) throw err;
        console.warn('[fileService] saveNodeOutputToFile: 源文件读取失败，改用节点 URL:', filePath, err);
      }
    }

    // 2. data: URL
    if (mediaUrl && mediaUrl.startsWith('data:')) {
      const commaIdx = mediaUrl.indexOf(',');
      const b64 = commaIdx > 0 ? mediaUrl.substring(commaIdx + 1) : '';
      const binaryStr = atob(b64);
      const bytes = new Uint8Array(binaryStr.length);
      for (let i = 0; i < binaryStr.length; i++) {
        bytes[i] = binaryStr.charCodeAt(i);
      }
      await writeFile(destPath, bytes);
      return destPath;
    }

    // 3. 其余 URL（asset://localhost、http://asset.localhost、blob:、http(s)://）直接 fetch。
    //    节点里的 asset URL 已经是 convertFileSrc 的产物，再转一次会把整个 URL 当成路径编码进去 —
    //    Windows 的 asset URL 是 http://asset.localhost/… 走不到这一步，mac 的 asset:// 才会踩到。
    if (mediaUrl && /^(asset:|blob:|https?:)/.test(mediaUrl)) {
      const resp = await fetch(mediaUrl);
      if (!resp.ok) throw new Error(`读取媒体失败：HTTP ${resp.status}`);
      const buffer = await resp.arrayBuffer();
      await writeFile(destPath, new Uint8Array(buffer));
      return destPath;
    }

    // 5. Text output (ai-text / ai-markdown)
    if (textOutput) {
      const encoder = new TextEncoder();
      await writeFile(destPath, encoder.encode(textOutput));
      return destPath;
    }

    console.warn('[fileService] saveNodeOutputToFile: 无可保存的内容');
    return null;
  } catch (err) {
    console.error('[fileService] saveNodeOutputToFile 失败:', err);
    throw err;
  }
}

/**
 * fileService 文件操作服务 — 项目媒体文件的拷贝/保存/下载/重命名、源文件上传、
 * 节点输出另存为、系统文件管理器定位。基础设施见 ./fs/core，删除域见 ./fs/trash，
 * 全局资产库见 ./fs/assetLibrary（均通过本模块统一对外导出）。
 */
import { exists, writeFile, readFile as tauriReadFile, readDir, stat, lstat, rename, mkdir } from '@tauri-apps/plugin-fs';
import { open, save } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { isLocalMediaUrl, isRemoteMediaUrl, localMediaUrlToPath } from '../utils/mediaUrl';
import { identifyAsset, getRelativeAssetPath } from './fs/assetIndex';
import { readAssetTextFile } from './fs/assetTextFiles';
import { walkDirectoryFiles } from './fs/assetLibrary';
import { completeMediaRelocation, mediaFileAllocationKey, persistMediaRelocation, retiredMediaPaths, type MediaRelocation } from './indexedDb/mediaRelocations';
import {
  decodeDataUrlBytesAsync,
  MEDIA_DATA_URL_BYTE_LIMITS,
  sha256BytesHex,
} from './mediaDataUrl';
import {
  isTauriEnv,
  getMimeType,
  arrayBufferToBase64,
  bytePartsToBase64Async,
  sanitizeFileName,
  stripVerbatimPrefix,
  getConvertFileSrc,
  getAssetUrlFromPath,
  getBaseDir,
  ensureProjectDataDir,
  getProjectDataDir,
  joinPath,
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

export interface NodeOutputDownloadProgress {
  transferredBytes: number;
  totalBytes: number | null;
  phase: 'downloading' | 'saving';
}

export interface FileTransferOptions {
  /** 创作资产集中放到项目的 Library 文件夹。 */
  projectSubdirectory?: 'Library';
  signal?: AbortSignal;
  /** Agent/MCP 导入不把调用方的本地路径或原生错误写入控制台。 */
  redactErrors?: boolean;
  onProgress?: (progress: FileTransferProgress) => void;
  /** 内嵌媒体按名称和内容摘要复用已有文件，供持久化迁移重试使用。 */
  deduplicateByContent?: boolean;
  /** 持久化入口需要接收底层异常，再转换为不含路径、链接或凭据的错误。 */
  throwOnError?: boolean;
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
  ...MEDIA_DATA_URL_BYTE_LIMITS,
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
  const normalizedDir = stripVerbatimPrefix(dataDir).replace(/\\/g, '/').replace(/\/+$/, '');
  const identity = `${normalizedDir}\n${sanitizeFileName(fileName)}`;
  const lockKey = mediaFileAllocationKey(identity);
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

async function runNativeFileTransfer<T = NativeFileTransferResult>(
  command: 'copy_file_streamed' | 'download_file_streamed' | 'copy_asset_folder' | 'copy_asset_file_to_folder',
  args: Record<string, string>,
  options?: FileTransferOptions,
): Promise<T> {
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
    if (options?.signal?.aborted) throw new DOMException('File transfer aborted', 'AbortError');
    return await invoke<T>(command, { taskId, ...args });
  } finally {
    options?.signal?.removeEventListener('abort', cancel);
    unlisten?.();
  }
}

/** 复制真实目录；原生端负责授权、禁止覆盖、进度及取消。 */
export async function copyAssetFolder(sourcePath: string, destinationDirectory: string, options?: FileTransferOptions): Promise<string> {
  if (!isTauriEnv()) throw new Error('文件夹粘贴仅支持桌面应用');
  const result = await runNativeFileTransfer('copy_asset_folder', { sourcePath, destinationDirectory }, options);
  return result.path;
}

export interface AssetFileCopyResult {
  path: string;
  totalBytes: number;
  digest: string;
}

/** 验证内容后落盘，同名自动加序号；原文件始终保留。 */
export async function copyAssetFileToFolder(sourcePath: string, destinationDirectory: string, options?: FileTransferOptions): Promise<AssetFileCopyResult> {
  if (!isTauriEnv()) throw new Error('文件拖放仅支持桌面应用');
  return runNativeFileTransfer<AssetFileCopyResult>('copy_asset_file_to_folder', { sourcePath, destinationDirectory }, options);
}

/** 引用迁移成功后再次验证两份内容，才允许将源文件放入回收站。 */
export async function finishAssetFileMove(sourcePath: string, copy: AssetFileCopyResult): Promise<void> {
  await invoke('finish_asset_file_move', { sourcePath, destinationPath: copy.path, expectedDigest: copy.digest, expectedBytes: copy.totalBytes });
}

/** 图片信息的引用副本只写应用自有目录，复用原生受控、可取消的流式复制。 */
export async function copyAssetImageReference(sourcePath: string, relativePath: string, expectedRoot: string, options?: FileTransferOptions): Promise<void> {
  if (!isTauriEnv()) throw new Error('参考图保存仅支持桌面应用');
  if (!/^asset-image-references\/[a-f0-9-]{36}\.[a-z0-9]{1,8}$/.test(relativePath)) throw new Error('参考图引用无效');
  const root = await getBaseDir();
  if (!root || root !== expectedRoot) throw new Error('保存目录已变化，请重试');
  await mkdir(joinPath(root, 'asset-image-references'), { recursive: true });
  await runNativeFileTransfer('copy_file_streamed', { sourcePath, destinationPath: joinPath(root, relativePath) }, options);
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
  savePresetFolder,
  loadPresetFolders,
  deletePresetFolder,
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
export * from './fs/assetTextFiles';
export * from './fs/assetIndex';
export * from './fs/trash';
export * from './fs/assetLibrary';
export * from './fs/assetFileMove';
export * from './fs/skillFiles';
export * from './fs/externalEditors';
export * from './fs/jsonFileTransfer';

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

/** 解析裁剪来源，本地文件使用 asset URL，远程图片按需绕过 CORS。 */
export async function fetchImageForCrop(imageUrl: string): Promise<string> {
  if (isLocalMediaUrl(imageUrl)) {
    const localPath = localMediaUrlToPath(imageUrl);
    if (localPath && isTauriEnv()) return getAssetUrlFromPath(localPath);
    return imageUrl;
  }
  // 远程 URL：通过 Rust 端 reqwest 原生 HTTP 下载（WebView CORS 不适用）
  if (isTauriEnv() && isRemoteMediaUrl(imageUrl)) {
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

    // blob 与浏览器可访问的 URL 由 WebView 读取，不把 URL 当文件路径。
    const resp = await fetch(filePath, { signal: options.signal });
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

// ============================================
// Project data files — 项目媒体文件读写
// ============================================

/** 去重摘要只用于校验内容，不再拼到用户可见的文件名中。 */
async function saveProjectBytes(
  dataDir: string,
  fileName: string,
  bytes: Uint8Array,
  deduplicateByContent = false,
  signal?: AbortSignal,
): Promise<string> {
  const save = async () => {
    throwIfMediaReadAborted(signal);
    if (deduplicateByContent) {
      const digest = await sha256BytesHex(bytes);
      const normalizedName = sanitizeFileName(fileName);
      const dotIndex = normalizedName.lastIndexOf('.');
      const stem = sanitizeFileName((dotIndex > 0 ? normalizedName.slice(0, dotIndex) : normalizedName).replace(/--[a-f0-9]{32}$/i, '')) || 'file';
      const extension = dotIndex > 0 ? normalizedName.slice(dotIndex) : '';
      const numberedStem = stem.replace(/_[1-9]\d*$/, '') || stem;
      const prefix = `${mediaFileAllocationKey(dataDir)}/`;
      const nameKey = (name: string) => mediaFileAllocationKey(`${prefix}${name}`).slice(prefix.length);
      const base = nameKey(stem);
      const family = nameKey(numberedStem);
      const ext = nameKey(extension);
      const retired = await retiredMediaPaths();
      const entries = await readDir(dataDir);
      for (const entry of entries) {
        throwIfMediaReadAborted(signal);
        if (!entry.isFile || entry.isSymlink) continue;
        const name = nameKey(entry.name);
        if (ext && !name.endsWith(ext)) continue;
        const entryStem = ext ? name.slice(0, -ext.length) : name;
        const sequence = entryStem.startsWith(`${family}_`) ? entryStem.slice(family.length + 1) : '';
        // 同时兼容以前的内容摘要文件，但不重命名已有文件。
        if (entryStem !== base && !/^[1-9]\d*$/.test(sequence)
          && entryStem !== `${base}-${digest.slice(0, 20)}`) continue;
        const path = joinPath(dataDir, entry.name);
        if (retired.has(mediaFileAllocationKey(path))) continue;
        let matches: boolean;
        try {
          const info = await lstat(path);
          if (!info.isFile || info.isSymlink || info.size !== bytes.byteLength) continue;
          matches = await sha256BytesHex(await tauriReadFile(path)) === digest;
        } catch (error) {
          // readDir 之后分组迁移可能已清理此文件；只跳过不存在，不吞权限和读取错误。
          const message = error instanceof Error ? error.message : String(error);
          if (/no such file|path not found|找不到指定|ENOENT|os error [23]\b/i.test(message)) continue;
          throw error;
        }
        throwIfMediaReadAborted(signal);
        if (matches) {
          const latestRetired = await retiredMediaPaths();
          throwIfMediaReadAborted(signal);
          if (!latestRetired.has(mediaFileAllocationKey(path))) return path;
        }
      }
    }
    throwIfMediaReadAborted(signal);
    const destPath = await resolveUniqueDestPath(dataDir, fileName, true);
    throwIfMediaReadAborted(signal);
    await writeFile(destPath, bytes, { createNew: true });
    notifyProjectDiskChanged();
    return destPath;
  };
  // 去重查询与写入属于同一临界区，并发的同内容重试也只创建一份文件。
  return deduplicateByContent ? withDownloadDestinationLock(dataDir, fileName, save) : save();
}

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

  let dataDir = await ensureProjectDataDir(projectId);
  if (!dataDir) return null;
  if (options?.projectSubdirectory) {
    dataDir = joinPath(dataDir, options.projectSubdirectory);
    await mkdir(dataDir, { recursive: true });
  }

  const fileName = sourcePath.split(/[/\\]/).pop() || 'file';
  let destPath: string;
  try {
    destPath = await resolveUniqueDestPath(dataDir, fileName, true);
    await runNativeFileTransfer('copy_file_streamed', { sourcePath, destinationPath: destPath }, options);
    notifyProjectDiskChanged();
  } catch (err) {
    if (!options?.redactErrors) console.error('Failed to copy file to project data:', sourcePath, err);
    // Don't fallback to convertFileSrc on external paths — asset protocol won't serve them
    // Return null so caller can fallback to readFile → base64 in-memory loading
    return null;
  }

  const convertFileSrc = await getConvertFileSrc();
  const savedFileName = destPath.split(/[/\\]/).pop() || fileName;
  if (!convertFileSrc) {
    // If convertFileSrc unavailable, still return the path
    return { filePath: destPath, assetUrl: '', fileName: savedFileName };
  }

  return { filePath: destPath, assetUrl: convertFileSrc(destPath), fileName: savedFileName };
}

/**
 * 将 data URL 的内容保存到项目数据目录
 * 用于 AI 生成的图片等场景
 */
export async function saveDataUrlToProjectData(
  dataUrl: string,
  projectId: string,
  fileName: string,
  options: Pick<FileTransferOptions, 'deduplicateByContent' | 'throwOnError'> = {},
): Promise<{ filePath: string; assetUrl: string } | null> {
  if (!isTauriEnv()) return null;

  const dataDir = await ensureProjectDataDir(projectId, { throwOnError: options.throwOnError });
  if (!dataDir) return null;

  try {
    const kind = inferMediaDataUrlKind(dataUrl);
    const expectedBytes = await assertMediaDataUrlWithinLimitAsync(dataUrl, kind, fileName);
    const bytes = await decodeDataUrlBytesAsync(dataUrl, {
      expectedBytes,
      maxBytes: MEDIA_DATA_URL_MAX_BYTES[kind],
      label: fileName,
    });

    const destPath = await saveProjectBytes(dataDir, fileName, bytes, options.deduplicateByContent);

    const convertFileSrc = await getConvertFileSrc();
    const assetUrl = convertFileSrc ? convertFileSrc(destPath) : '';

    return { filePath: destPath, assetUrl };
  } catch (err) {
    if (options.throwOnError) throw err;
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
  options: Pick<FileTransferOptions, 'throwOnError'> = {},
): Promise<{ filePath: string; assetUrl: string } | null> {
  if (!isTauriEnv()) return null;

  const dataDir = await ensureProjectDataDir(projectId, { throwOnError: options.throwOnError });
  if (!dataDir) return null;

  let destPath: string;
  try {
    destPath = await resolveUniqueDestPath(dataDir, fileName, true);
    await writeFile(destPath, data, { createNew: true });
    notifyProjectDiskChanged();
  } catch (err) {
    if (options.throwOnError) throw err;
    console.error('Failed to save binary to project data:', fileName, err);
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
  return resolveUniqueDestPath(dataDir, sanitizeFileName(fileName), true);
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
  'audio/mpeg': '.mp3', 'audio/mp3': '.mp3',
  'audio/wav': '.wav', 'audio/x-wav': '.wav', 'audio/wave': '.wav',
  'audio/ogg': '.ogg', 'audio/aac': '.aac',
  'audio/flac': '.flac', 'audio/x-flac': '.flac',
  'audio/mp4': '.m4a', 'audio/x-m4a': '.m4a',
  'audio/opus': '.opus', 'audio/x-ms-wma': '.wma',
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

/** 原始异常只用于本次分类，不把路径、签名 URL 或响应正文传入节点和历史。 */
function describeMediaPersistenceFailure(error: unknown): string {
  const message = typeof error === 'string' ? error : error instanceof Error ? error.message : '';
  if (/forbidden path|路径未获授权|not allowed on the scope/i.test(message)) {
    return '应用拒绝访问项目文件，请在设置中重新选择文件保存目录';
  }
  if (/permission denied|access is denied|拒绝访问|os error 5\b|EACCES|EPERM/i.test(message)) {
    return '系统拒绝写入项目目录，请检查目录的写入权限';
  }
  if (/no space|disk.*full|磁盘.*不足|空间不足|ENOSPC|os error 112\b/i.test(message)) {
    return '目标磁盘空间不足';
  }
  const httpStatus = /\bHTTP\s+(\d{3})\b/i.exec(message)?.[1];
  if (httpStatus) return `图片或媒体下载失败（HTTP ${httpStatus}）`;
  if (/下载请求失败|failed to fetch|network|timed?\s*out|超时/i.test(message)) {
    return '下载媒体失败，请检查网络或媒体链接是否已失效';
  }
  if (/目录.*不存在|no such file|path not found|找不到指定|ENOENT|os error [23]\b/i.test(message)) {
    return '项目目录或源文件不存在，请检查文件保存位置';
  }
  if (error instanceof MediaDataUrlTooLargeError || error instanceof MediaDataUrlTotalTooLargeError) {
    return '媒体超过内存保存上限';
  }
  return '保存过程发生异常，请检查文件保存目录和媒体来源';
}

/**
 * 将一次媒体生成结果收敛为可持久化的项目文件引用。
 * 没有项目目录时（浏览器环境）无法落盘：远程 URL 仍可展示，但内嵌媒体一旦进入
 * 持久化就是死数据，只能失败关闭。有项目目录时落盘失败同样必须失败关闭，
 * 本地媒体落盘后把来源改为项目 asset URL，避免保留临时正文或旧目录引用。
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
  let saved: Awaited<ReturnType<typeof downloadUrlAndSave>>;
  try {
    saved = await downloadUrlAndSave(url, projectId, fallbackPrefix, baseName, { ...options, throwOnError: true });
  } catch (error) {
    if (isAbortError(error) || options?.signal?.aborted) {
      throw new DOMException('媒体保存已取消', 'AbortError');
    }
    // eslint-disable-next-line preserve-caught-error -- 原始异常可能包含路径、签名 URL 或凭据，不保留 cause。
    throw new Error(`生成媒体未能写入项目目录：${describeMediaPersistenceFailure(error)}`);
  }
  if (!saved?.filePath || !saved.assetUrl) {
    throw new Error('生成媒体未能写入项目目录：项目目录或本地媒体地址不可用');
  }
  if (isLocalMediaUrl(url)) {
    return { ...saved, mediaUrl: saved.assetUrl, sourceUrl: saved.assetUrl };
  }
  return {
    ...saved,
    mediaUrl: saved.assetUrl,
    sourceUrl: url,
  };
}

/**
 * 将媒体 URL 保存到项目数据目录：本地资源复制，远程资源下载。
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
    throwIfMediaReadAborted(options?.signal);
    if (isMediaDataUrl(url)) {
      const mime = /^data:([^;,]+)/i.exec(url)?.[1];
      const fileName = baseName && baseName.trim()
        ? buildNodeFileName(baseName, guessExtension(url, mime, fallbackPrefix), fallbackPrefix)
        : `${sanitizeFileName(fallbackPrefix)}-${Date.now()}${guessExtension('', mime, fallbackPrefix)}`;
      return await saveDataUrlToProjectData(url, projectId, fileName, options);
    }

    if (/^blob:/i.test(url)) {
      const response = await fetch(url, { signal: options?.signal });
      if (!response.ok) throw new Error(`读取临时媒体失败：HTTP ${response.status}`);
      const mime = response.headers.get('content-type') || undefined;
      const kind = inferMediaDataUrlKind(mime ?? fallbackPrefix);
      const fileName = baseName && baseName.trim()
        ? buildNodeFileName(baseName, guessExtension(url, mime, fallbackPrefix), fallbackPrefix)
        : `${sanitizeFileName(fallbackPrefix)}-${Date.now()}${guessExtension('', mime, fallbackPrefix)}`;
      const contentLength = Number(response.headers.get('content-length'));
      if (Number.isFinite(contentLength) && contentLength >= 0) {
        assertMediaDataUrlSize(contentLength, kind, fileName);
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      throwIfMediaReadAborted(options?.signal);
      assertMediaDataUrlSize(bytes.byteLength, kind, fileName);
      if (options?.deduplicateByContent) {
        const dataDir = await ensureProjectDataDir(projectId, { throwOnError: options.throwOnError });
        if (!dataDir) return null;
        throwIfMediaReadAborted(options?.signal);
        const destPath = await saveProjectBytes(dataDir, fileName, bytes, true, options?.signal);
        const convertFileSrc = await getConvertFileSrc();
        return {
          filePath: destPath,
          assetUrl: convertFileSrc ? convertFileSrc(destPath) : '',
        };
      }
      return await saveBinaryToProjectData(bytes, projectId, fileName, options);
    }

    const sourcePath = localMediaUrlToPath(url);
    if (!sourcePath && !isRemoteMediaUrl(url)) throw new Error('不支持的媒体地址');
    // 本地 URL 还原为授权文件路径，保留原生流式复制的取消与进度。
    const sourceName = sourcePath?.replace(/\\/g, '/').split('/').pop();
    const fileName = baseName && baseName.trim()
      ? buildNodeFileName(baseName, guessExtension(sourceName ?? url, undefined, fallbackPrefix), fallbackPrefix)
      : sourceName ? sanitizeFileName(sourceName) : extractFileNameFromUrl(url, fallbackPrefix);
    const dataDir = await ensureProjectDataDir(projectId, { throwOnError: options?.throwOnError });
    if (!dataDir) return null;
    const result = await withDownloadDestinationLock(
      dataDir,
      fileName,
      async () => {
        const destPath = await resolveUniqueDestPath(dataDir, fileName, true);
        return runNativeFileTransfer(
          sourcePath ? 'copy_file_streamed' : 'download_file_streamed',
          sourcePath ? { sourcePath, destinationPath: destPath } : { url, destinationPath: destPath },
          options,
        );
      },
    );
    notifyProjectDiskChanged();
    const toAssetUrl = await getConvertFileSrc();
    return { filePath: result.path, assetUrl: toAssetUrl ? toAssetUrl(result.path) : '' };
  } catch (err) {
    if (options?.throwOnError) throw err;
    console.warn('[fileService] downloadUrlAndSave failed:', err);
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
    const destPath = await resolveUniqueDestPath(currentDir, newName, true);
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

/** 磁盘改名结果；部分完成时同时返回最新位置和提醒。 */
export interface AssetFileRenameResult {
  file: AssetFileEntry;
  warning?: string;
}

const assetRenameLocks = new Set<string>();

/** 就地改名图片或文档；保留资产身份，引用同步失败时恢复磁盘原名。 */
export async function renameAssetFile(
  file: AssetFileEntry, label: string, projectId: string | undefined, roots: readonly string[],
  onRelocated: (move: MediaRelocation) => void,
): Promise<AssetFileRenameResult> {
  if (!isTauriEnv() || !['image', 'text'].includes(file.category) || file.availability === 'offline') throw new Error('仅支持重命名可访问的本地图片或文本文件');
  const path = stripVerbatimPrefix(file.path).replace(/\\/g, '/');
  if (path.split('/').some((part) => part === '.' || part === '..' || part === '.trash')) throw new Error('文件位置无效');
  const oldName = path.split('/').pop() ?? '';
  const extension = oldName.lastIndexOf('.') > 0 ? oldName.slice(oldName.lastIndexOf('.')) : '';
  let base = label.trim();
  if (extension && base.toLowerCase().endsWith(extension.toLowerCase())) base = base.slice(0, -extension.length);
  if (!base || /[<>:"/\\|?*]/.test(base) || Array.from(base).some((char) => char.charCodeAt(0) < 32) || /[. ]$/.test(base)
    || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(base) || base.length + extension.length > 255) {
    throw new Error('文件名无效，请勿使用路径、特殊字符、保留名称或过长名称');
  }
  const name = `${base}${extension}`;
  if (name === oldName) return { file };
  const newPath = `${path.slice(0, path.lastIndexOf('/') + 1)}${name}`;
  const lockKey = /^[a-z]:\//i.test(path) ? path.toLowerCase() : path;
  if (assetRenameLocks.has(lockKey)) throw new Error('此文件正在改名，请稍候');
  assetRenameLocks.add(lockKey);
  try {
    const { getAssetIndexById, getAssetIndexByPath } = await import('./indexedDbService');
    const { getGlobalFilesDir } = await import('./fs/assetLibrary');
    const { fingerprintAssetImage } = await import('./fs/assetImageMetadata');
    const indexed = file.assetId ? await getAssetIndexById(file.assetId) : await getAssetIndexByPath(path);
    const samePath = (value: string) => /^[a-z]:\//i.test(value) ? value.toLowerCase() : value;
    if (indexed && samePath(indexed.path.replace(/\\/g, '/')) !== samePath(path)) throw new Error('文件位置已变化，请刷新后重试');
    const source = indexed?.source ?? file.source;
    const ownerId = projectId ?? indexed?.projectId;
    const root = source === 'project' && ownerId ? await getProjectDataDir(ownerId)
      : source === 'global' ? await getGlobalFilesDir()
      : source === 'folder' ? roots.find((candidate) => getRelativeAssetPath(path, candidate) !== undefined) : undefined;
    const relativePath = root ? getRelativeAssetPath(newPath, root) : undefined;
    if (!root || !relativePath || getRelativeAssetPath(path, root) === undefined) throw new Error('文件不在已登记的资产目录内');
    // 内部 JSON 按固定路径和摘要引用，不能按普通素材的方式改名。
    if (file.category === 'text' && source === 'project'
      && /^(?:(?:director\/previs|ai-apps)\/[a-f0-9]{64}|director\/scenes\/[^/]+\/(?:scene-r\d+|results\/manifest-r\d+)-[a-f0-9]{64})\.json$/i.test(getRelativeAssetPath(path, root)!)) {
      throw new Error('此文件由应用内部管理，需要保留原名；请先复制为普通文本文件再改名');
    }
    const info = await lstat(path);
    if (!info.isFile || info.isSymlink) throw new Error('仅支持普通图片或文本文件');
    if (await exists(newPath)) throw new Error('已有同名文件，请换一个名称');
    const identity = await identifyAsset(path, { assetId: file.assetId, source: source!, rootPath: root, projectId: ownerId });
    const content = file.category === 'text' ? await readAssetTextFile(path) : await fingerprintAssetImage(path);
    const assetUrl = await getAssetUrlFromPath(newPath);
    if (!assetUrl) throw new Error('无法解析改名后的文件位置');
    const move: MediaRelocation = { oldPath: path, newPath, oldAssetUrl: file.assetUrl, assetUrl, relativePath,
      projectId: ownerId ?? 'asset-rename', renamedFileName: name,
      ...(source !== 'project' ? { assetMove: { assetId: identity.assetId, rootPath: root, source: source as 'global' | 'folder',
        digest: content.digest, totalBytes: 'bytes' in content ? content.bytes : content.size, mtimeMs: info.mtime?.getTime() ?? 0 } } : {}) };
    const next: AssetFileEntry = { ...file, assetId: identity.assetId, name, path: newPath, assetUrl, relativePath };
    // 再次检查目标，名称冲突时不使用自动加序号或覆盖路径。
    if (await exists(newPath)) throw new Error('已有同名文件，请换一个名称');
    await rename(path, newPath);
    try {
      await persistMediaRelocation(move);
    } catch {
      try {
        if (await exists(path)) throw new Error('原位置已被占用');
        await rename(newPath, path);
      } catch {
        onRelocated(move);
        notifyProjectDiskChanged();
        return { file: next, warning: '磁盘文件已改名，但引用同步失败且无法恢复原名，请重新打开资源库检查。' };
      }
      throw new Error('引用同步失败，已恢复磁盘原文件名');
    }
    onRelocated(move);
    notifyProjectDiskChanged();
    try { await completeMediaRelocation(move); }
    catch { return { file: next, warning: '文件已改名，引用已同步，但操作记录尚未完成清理。' }; }
    return { file: next };
  } finally { assetRenameLocks.delete(lockKey); }
}

/** 获取项目文件列表 */
export async function listProjectFiles(projectId: string): Promise<AssetFileEntry[]> {
  const projectDir = await getProjectDataDir(projectId);
  if (!projectDir) return [];
  // 递归：节点文件可能位于分组子文件夹内
  const allFiles = await walkDirectoryFiles(projectDir, { excludedRootDirectories: ['.thumbnail'] });
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
  projectSubdirectory?: 'Library',
): Promise<UploadResult & { filePath?: string } | null> {
  try {
    if (isTauriEnv()) {
      if (projectSubdirectory && (!projectId || projectId === 'default')) {
        throw new Error('请先保存项目，再上传创作资产');
      }
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
      if (projectSubdirectory && !/\.(png|jpe?g|webp|gif|bmp)$/i.test(fileName)) {
        throw new Error('请选择支持的图片文件');
      }

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
        const result = await copyFileToProjectData(filePath, projectId, { projectSubdirectory, redactErrors: Boolean(projectSubdirectory) });
        if (result && (!projectSubdirectory || result.assetUrl)) {
          return { dataUrl: result.assetUrl, fileName: result.fileName, fileSize, filePath: result.filePath };
        }
      }

      if (projectSubdirectory) throw new Error('素材保存到 Library 失败，请重试');

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
    if (!projectSubdirectory) console.error('Upload to project failed:', error);
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

/** 音频另存为只复制原始字节，扩展名沿用本地文件，再回退到文件名、URL 或 MIME。 */
function getAudioSaveExtension(filePath?: string, fileName?: string, mediaUrl?: string): string {
  for (const source of [filePath, fileName, localMediaUrlToPath(mediaUrl)]) {
    const extension = source?.split(/[\\/]/).pop()?.match(/\.[^.]+$/)?.[0];
    if (extension) return extension.toLowerCase();
  }
  const mime = /^data:([^;,]+)/i.exec(mediaUrl || '')?.[1]?.toLowerCase();
  return guessExtension(mediaUrl || '', mime, 'audio');
}

/** 根据节点类型和默认扩展名生成文件过滤器 */
function getSaveFilter(nodeType: string, defaultExtension: string): { name: string; extensions: string[] }[] {
  switch (nodeType) {
    case 'ai-text':      return [{ name: '文本文件', extensions: ['txt'] }, { name: '所有文件', extensions: ['*'] }];
    case 'ai-markdown':  return [{ name: 'Markdown 文件', extensions: ['md'] }, { name: '所有文件', extensions: ['*'] }];
    case 'ai-image':
    case 'source-image':
    case 'ai-panorama':  return [{ name: '图片文件', extensions: ['png', 'jpg', 'jpeg', 'webp'] }, { name: '所有文件', extensions: ['*'] }];
    case 'ai-video':
    case 'source-video': return [{ name: '视频文件', extensions: ['mp4', 'webm', 'mov'] }, { name: '所有文件', extensions: ['*'] }];
    case 'ai-audio':
    case 'source-audio': return [{ name: '音频文件', extensions: [defaultExtension.slice(1)] }, { name: '所有文件', extensions: ['*'] }];
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
  signal?: AbortSignal;
  onProgress?: (progress: NodeOutputDownloadProgress) => void;
}): Promise<string | null> {
  const { filePath, mediaUrl, textOutput, nodeType, fileName, signal, onProgress } = opts;
  throwIfMediaReadAborted(signal);
  const defExt = nodeType === 'ai-audio' || nodeType === 'source-audio'
    ? getAudioSaveExtension(filePath, fileName, mediaUrl)
    : getDefaultExtension(nodeType);

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
  const filters = getSaveFilter(nodeType, defExt);
  const destPath = await save({
    defaultPath: defaultName,
    filters,
  });

  if (!destPath) return null; // User cancelled

  try {
    throwIfMediaReadAborted(signal);
    // 1. Media: try real file path first
    if (filePath) {
      try {
        const bytes = await tauriReadFile(filePath);
        throwIfMediaReadAborted(signal);
        await writeFile(destPath, bytes);
        return destPath;
      } catch (err) {
        if (signal?.aborted || isAbortError(err)) throw err;
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
      throwIfMediaReadAborted(signal);
      await writeFile(destPath, bytes);
      return destPath;
    }

    // 3. 其余 URL（asset://localhost、http://asset.localhost、blob:、http(s)://）直接 fetch。
    //    节点里的 asset URL 已经是 convertFileSrc 的产物，再转一次会把整个 URL 当成路径编码进去 —
    //    Windows 的 asset URL 是 http://asset.localhost/… 走不到这一步，mac 的 asset:// 才会踩到。
    if (mediaUrl && /^(asset:|blob:|https?:)/.test(mediaUrl)) {
      const reportProgress = isRemoteMediaUrl(mediaUrl) ? onProgress : undefined;
      reportProgress?.({ transferredBytes: 0, totalBytes: null, phase: 'downloading' });
      const resp = await fetch(mediaUrl, { signal });
      if (!resp.ok) throw new Error(`读取媒体失败：HTTP ${resp.status}`);
      let bytes: Uint8Array;
      if (reportProgress) {
        const contentLength = resp.headers.get('content-length');
        const encoding = resp.headers.get('content-encoding');
        // fetch 可能已解压响应，压缩传输长度不能作为已读取字节的分母。
        let totalBytes = (!encoding || encoding.toLowerCase() === 'identity')
          && contentLength !== null && /^\d+$/.test(contentLength)
          && Number.isSafeInteger(Number(contentLength)) ? Number(contentLength) : null;
        let transferredBytes = 0;
        reportProgress({ transferredBytes, totalBytes, phase: 'downloading' });
        const reader = resp.body?.getReader();
        if (reader) {
          const chunks: Uint8Array[] = [];
          try {
            while (true) {
              throwIfMediaReadAborted(signal);
              const { done, value } = await reader.read();
              if (done) break;
              chunks.push(value);
              transferredBytes += value.byteLength;
              if (totalBytes !== null && transferredBytes > totalBytes) totalBytes = null;
              reportProgress({ transferredBytes, totalBytes, phase: 'downloading' });
            }
          } finally {
            reader.releaseLock();
          }
          bytes = new Uint8Array(transferredBytes);
          let offset = 0;
          for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.byteLength;
          }
        } else {
          bytes = new Uint8Array(await resp.arrayBuffer());
          transferredBytes = bytes.byteLength;
          if (totalBytes !== null && transferredBytes > totalBytes) totalBytes = null;
        }
        throwIfMediaReadAborted(signal);
        if (totalBytes !== null && transferredBytes !== totalBytes) throw new Error('媒体下载不完整，请重试');
        reportProgress({ transferredBytes, totalBytes, phase: 'saving' });
      } else {
        bytes = new Uint8Array(await resp.arrayBuffer());
      }
      throwIfMediaReadAborted(signal);
      await writeFile(destPath, bytes);
      return destPath;
    }

    // 5. Text output (ai-text / ai-markdown)
    if (textOutput) {
      const encoder = new TextEncoder();
      throwIfMediaReadAborted(signal);
      await writeFile(destPath, encoder.encode(textOutput));
      return destPath;
    }

    console.warn('[fileService] saveNodeOutputToFile: 无可保存的内容');
    return null;
  } catch (err) {
    if (signal?.aborted) throw mediaReadAbortReason(signal);
    console.error('[fileService] saveNodeOutputToFile 失败:', err);
    throw err;
  }
}

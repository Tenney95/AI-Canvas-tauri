/**
 * fileService 文件操作服务 — 项目媒体文件的拷贝/保存/下载/重命名、源文件上传、
 * 节点输出另存为、系统文件管理器定位。基础设施见 ./fs/core，删除域见 ./fs/trash，
 * 全局资产库见 ./fs/assetLibrary（均通过本模块统一对外导出）。
 */
import { exists, writeFile, readFile as tauriReadFile, open as fsOpen, readDir, stat, lstat, rename, mkdir, remove } from '@tauri-apps/plugin-fs';
import { open, save } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { isLocalMediaUrl, isRemoteMediaUrl, localMediaUrlToPath } from '../utils/mediaUrl';
import { isNativeProjectBindingFile } from '../utils/nativeProjectBindingFile';
import { shouldLoadNativeComfyImage } from './comfyImageSource';
import type { MediaDownloadRequest } from './ai/mediaDownloadAccess';
import { downloadGithubBytes, githubMirrorUrl } from './githubDownloadService';
import { identifyAsset, getRelativeAssetPath } from './fs/assetIndex';
import { readAssetTextFile } from './fs/assetTextFiles';
import { canReuseProjectFile, type ProjectFileStaging } from './fs/projectFileStaging';
import { walkDirectoryFiles, type AssetScanOptions } from './fs/assetLibrary';
import { isNativeProjectMediaContentPath } from './nativeMediaContentPath';
import { completeMediaRelocation, mediaFileAllocationKey, persistMediaRelocation, retiredMediaPaths, type MediaRelocation } from './indexedDb/mediaRelocations';
import {
  decodeDataUrlBytesAsync,
  sha256BytesHex,
} from './mediaDataUrl';
import {
  browserOpenFile,
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
  getNativeProjectOwner,
  getProjectDataDir,
  joinPath,
  resolveUniqueDestPath,
  buildNodeFileName,
  notifyProjectDiskChanged,
  getFileCategory,
  type AssetFileEntry,
} from './fs/core';

import {
  MEDIA_KIND_LABELS,
  mediaReadAbortReason,
  throwIfMediaReadAborted,
  isAbortError,
  MEDIA_DATA_URL_MAX_BYTES,
  MediaDataUrlTooLargeError,
  MediaDataUrlTotalTooLargeError,
  isMediaDataUrl,
  inferMediaDataUrlKind,
  assertMediaDataUrlSize,
  assertMediaDataUrlWithinLimitAsync,
} from './fs/mediaDataUrlRead';

export {
  type MediaDataUrlKind,
  MEDIA_DATA_URL_MAX_BYTES,
  MEDIA_DATA_URL_TOTAL_MAX_BYTES,
  MEDIA_DATA_URL_MAX_HEADER_CHARS,
  MediaDataUrlTooLargeError,
  MediaDataUrlTotalTooLargeError,
  MediaDataUrlHeaderTooLargeError,
  type MediaDataUrlBudget,
  createMediaDataUrlBudget,
  isMediaDataUrl,
  inferMediaDataUrlKind,
  assertMediaDataUrlSize,
  assertMediaDataUrlWithinLimit,
  assertMediaDataUrlWithinLimitAsync,
  estimateMediaDataUrlBytes,
  estimateMediaDataUrlBytesAsync,
  consumeMediaDataUrlBudget,
  consumeMediaDataUrlBudgetBytes,
  assertMediaDataUrlBudgetAvailable,
  fetchImageForCrop,
  type ReadFileToDataUrlOptions,
  readFileToDataUrl,
} from './fs/mediaDataUrlRead';
export * from './fs/agentFileAccess';

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
  /** 批量导入的独占新文件在画布提交后交付，复用已有文件时不登记。 */
  staging?: ProjectFileStaging;
  /** 调用方的运行时/持久代际复核，不序列化；可在系统对话框后撤销原写入。 */
  assertCurrent?: () => void | Promise<void>;
  /** 仅本次生成交付使用；原任务恢复时从当前连接重建鉴权，不保存 Key。 */
  mediaDownloadAccess?: import('../types/aiTypes').MediaDownloadAccess;
  /** 创作资产集中放到项目的 Library 文件夹。 */
  projectSubdirectory?: 'Library';
  signal?: AbortSignal;
  /** Agent/MCP 导入不把调用方的本地路径或原生错误写入控制台。 */
  redactErrors?: boolean;
  onProgress?: (progress: FileTransferProgress) => void;
  /** 内嵌媒体按名称和内容摘要复用已有文件，供持久化迁移重试使用。 */
  deduplicateByContent?: boolean;
  /** MCP 创建分集素材节点时复用共享项目目录中的原文件，普通节点复制不启用。 */
  reuseExistingProjectFile?: boolean;
  /** 持久化入口需要接收底层异常，再转换为不含路径、链接或凭据的错误。 */
  throwOnError?: boolean;
}

interface NativeFileTransferResult {
  path: string;
  totalBytes: number;
  contentType: string | null;
}

const downloadDestinationQueues = new Map<string, Promise<void>>();

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
  args: Record<string, unknown>,
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
    await options?.assertCurrent?.();
    if (options?.signal?.aborted) throw new DOMException('File transfer aborted', 'AbortError');
    const result = await invoke<T>(command, { taskId, ...args });
    await options?.assertCurrent?.();
    return result;
  } finally {
    options?.signal?.removeEventListener('abort', cancel);
    unlisten?.();
  }
}

/** 原生流式复制到新目标；目标已存在或传输失败时不覆盖、不回退内存写入。 */
export async function copyLocalFileStreamed(
  sourcePath: string,
  destinationPath: string,
  options?: FileTransferOptions,
): Promise<{ path: string; totalBytes: number }> {
  if (!isTauriEnv()) throw new Error('文件复制仅支持桌面应用');
  const result = await runNativeFileTransfer('copy_file_streamed', { sourcePath, destinationPath }, options);
  return { path: stripVerbatimPrefix(result.path), totalBytes: result.totalBytes };
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
export async function copyAssetFileToFolder(sourcePath: string, destinationDirectory: string, options?: FileTransferOptions,
  movePlan?: { kind: 'plan'; reservedNames: string[] } | { kind: 'publish'; copy: AssetFileCopyResult; resume: boolean }): Promise<AssetFileCopyResult> {
  if (!isTauriEnv()) throw new Error('文件拖放仅支持桌面应用');
  // 旧运行时只接受目录字符串，必须在写盘前拒绝它无法识别的移动计划。
  const destination = movePlan ? { directory: destinationDirectory, plan: movePlan } : destinationDirectory;
  return runNativeFileTransfer<AssetFileCopyResult>('copy_asset_file_to_folder', { sourcePath, destinationDirectory: destination }, options);
}

/** 资产包暂存使用已有原生下载边界；调用方只提供本轮专属目录中的目标文件。 */
export async function downloadAssetArchiveMedia(url: string, destinationPath: string, kind: 'image' | 'audio' | 'video', options?: FileTransferOptions): Promise<string> {
  if (!isTauriEnv()) throw new Error('资产包媒体下载仅支持桌面应用');
  const result = await runNativeFileTransfer('download_file_streamed', {
    url, destinationPath, ...(kind === 'video' ? { expectedMediaKind: 'video' } : {}),
  }, options);
  return result.path;
}

/** 把生成图片下载到本次任务的暂存位置，保留厂商原鉴权边界并校验图片容器。 */
export async function downloadGeneratedImageToPath(url: string, destinationPath: string, options?: FileTransferOptions): Promise<string> {
  if (!isTauriEnv() || !isRemoteMediaUrl(url)) throw new Error('生成图片下载地址不可用');
  const request = options?.mediaDownloadAccess
    ? await (await import('./ai/mediaDownloadAccess')).resolveMediaDownloadRequest(url, options.mediaDownloadAccess)
    : { url };
  const result = await downloadRemoteMediaToPath(request, destinationPath, 'image', options);
  return result.path;
}

function downloadRemoteMediaToPath(
  request: MediaDownloadRequest,
  destinationPath: string,
  expectedMediaKind: 'image' | 'video' | undefined,
  options?: FileTransferOptions,
): Promise<NativeFileTransferResult> {
  return runNativeFileTransfer('download_file_streamed', {
    ...request, destinationPath, ...(expectedMediaKind ? { expectedMediaKind } : {}),
  }, options);
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
export * from './fs/mediaRead';
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
  assertCurrent?: () => void | Promise<void>,
  staging?: ProjectFileStaging,
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
        if (retired.has(mediaFileAllocationKey(path)) || !canReuseProjectFile(path, staging)) continue;
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
          await assertCurrent?.();
          if (!latestRetired.has(mediaFileAllocationKey(path)) && canReuseProjectFile(path, staging)) return path;
        }
      }
    }
    throwIfMediaReadAborted(signal);
    const destPath = await resolveUniqueDestPath(dataDir, fileName, true);
    throwIfMediaReadAborted(signal);
    await assertCurrent?.();
    if (staging) {
      await staging.write(destPath, async (markCreated) => {
        const file = await fsOpen(destPath, { write: true, createNew: true });
        markCreated();
        try {
          for (let offset = 0; offset < bytes.byteLength;) {
            await assertCurrent?.();
            const chunk = bytes.subarray(offset, offset + 1024 * 1024);
            const written = await file.write(chunk);
            if (written <= 0 || written > chunk.length) throw new Error('写入素材失败');
            offset += written;
          }
        } finally { await file.close(); }
      });
    } else await writeFile(destPath, bytes, { createNew: true });
    await assertCurrent?.();
    notifyProjectDiskChanged();
    return destPath;
  };
  // 去重查询与写入属于同一临界区，并发的同内容重试也只创建一份文件。
  return deduplicateByContent ? withDownloadDestinationLock(dataDir, fileName, save) : save();
}

/**
 * 将文件拷贝到项目数据目录，返回本地路径和 asset URL
 * 默认创建独立副本；显式启用 reuseExistingProjectFile 时可复用项目目录内原文件。
 */
export async function copyFileToProjectData(
  sourcePath: string,
  projectId: string,
  options?: FileTransferOptions,
): Promise<{ filePath: string; assetUrl: string; fileName: string } | null> {
  if (!isTauriEnv()) return null;
  await options?.assertCurrent?.();

  let dataDir = await ensureProjectDataDir(projectId);
  await options?.assertCurrent?.();
  if (!dataDir) return null;
  if (options?.projectSubdirectory) {
    dataDir = joinPath(dataDir, options.projectSubdirectory);
    await options.assertCurrent?.();
    await mkdir(dataDir, { recursive: true });
  }

  const fileName = sourcePath.split(/[/\\]/).pop() || 'file';
  let destPath: string;
  try {
    const relative = options?.reuseExistingProjectFile ? getRelativeAssetPath(sourcePath, dataDir) : undefined;
    const reuse = !!relative && relative.split('/').every((part) => !!part && !part.startsWith('.'));
    if (reuse) {
      throwIfMediaReadAborted(options?.signal);
      if (!canReuseProjectFile(sourcePath, options?.staging)) throw new Error('素材正在导入，请稍后重试');
      if ((await retiredMediaPaths()).has(mediaFileAllocationKey(sourcePath))) {
        throw new Error('素材路径已迁移，请刷新后重试');
      }
      // 原生端以真实路径再次核对归属，不能仅凭字符串前缀绕过目录授权。
      const existing = await runNativeFileTransfer('copy_file_streamed', {
        sourcePath, destinationPath: sourcePath, reuseRoot: dataDir,
      }, options);
      destPath = stripVerbatimPrefix(existing.path);
    } else {
      destPath = await resolveUniqueDestPath(dataDir, fileName, true);
      const staging = options?.staging;
      const writeNew = () => runNativeFileTransfer('copy_file_streamed', { sourcePath, destinationPath: destPath },
        staging ? { ...options, assertCurrent: undefined } : options);
      if (staging) {
        await options.assertCurrent?.();
        await staging.write(destPath, writeNew);
        await options.assertCurrent?.();
      } else await writeNew();
      notifyProjectDiskChanged();
    }
  } catch (err) {
    if (options?.assertCurrent) throw err;
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
  options: Pick<FileTransferOptions, 'deduplicateByContent' | 'throwOnError' | 'assertCurrent' | 'staging'> = {},
): Promise<{ filePath: string; assetUrl: string } | null> {
  if (!isTauriEnv()) return null;
  await options.assertCurrent?.();

  const dataDir = await ensureProjectDataDir(projectId, { throwOnError: options.throwOnError });
  await options.assertCurrent?.();
  if (!dataDir) return null;

  try {
    const kind = inferMediaDataUrlKind(dataUrl);
    const expectedBytes = await assertMediaDataUrlWithinLimitAsync(dataUrl, kind, fileName);
    const bytes = await decodeDataUrlBytesAsync(dataUrl, {
      expectedBytes,
      maxBytes: MEDIA_DATA_URL_MAX_BYTES[kind],
      label: fileName,
    });

    const destPath = await saveProjectBytes(dataDir, fileName, bytes, options.deduplicateByContent, undefined, options.assertCurrent, options.staging);

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
  options: Pick<FileTransferOptions, 'throwOnError' | 'assertCurrent'> = {},
): Promise<{ filePath: string; assetUrl: string } | null> {
  if (!isTauriEnv()) return null;
  await options.assertCurrent?.();

  const dataDir = await ensureProjectDataDir(projectId, { throwOnError: options.throwOnError });
  await options.assertCurrent?.();
  if (!dataDir) return null;

  let destPath: string;
  try {
    destPath = await resolveUniqueDestPath(dataDir, fileName, true);
    await options.assertCurrent?.();
    await writeFile(destPath, data, { createNew: true });
    await options.assertCurrent?.();
    notifyProjectDiskChanged();
  } catch (err) {
    if (options.throwOnError || options.assertCurrent) throw err;
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
  options: Pick<FileTransferOptions, 'assertCurrent'> = {},
): Promise<string | null> {
  if (!isTauriEnv()) return null;
  await options.assertCurrent?.();
  const destPath = await save({ defaultPath: fileName, filters });
  if (!destPath) return null;
  await options.assertCurrent?.();
  await writeFile(destPath, data);
  await options.assertCurrent?.();
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
  'image/svg+xml': '.svg', 'image/avif': '.avif', 'image/bmp': '.bmp', 'image/tiff': '.tiff',
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
  /** GIF/SVG 原件的实际逻辑画布尺寸，不以请求尺寸覆盖。 */
  width?: number;
  height?: number;
  /** 展示用 URL；落盘成功时指向项目文件。 */
  mediaUrl: string;
  /** 可持久化的来源 URL；内嵌/临时 URL 会被本地 asset URL 替换。 */
  sourceUrl: string;
}

async function readPersistedImageDimensions(path: string, options?: FileTransferOptions): Promise<{ width: number; height: number }> {
  throwIfMediaReadAborted(options?.signal);
  const file = await fsOpen(path, { read: true });
  try {
    const header = new Uint8Array(256 * 1024);
    let size = 0;
    while (size < header.length) {
      throwIfMediaReadAborted(options?.signal);
      const count = await file.read(header.subarray(size));
      if (count === null || count === 0) break;
      if (!Number.isSafeInteger(count) || count < 0 || count > header.length - size) throw new Error('图片文件头读取失败');
      size += count;
    }
    throwIfMediaReadAborted(options?.signal);
    const bytes = header.subarray(0, size);
    // 只整理用于读取元数据的头部；落盘原件始终不经过编码或净化。
    const metadataBytes = /\.svg$/i.test(path)
      ? new TextEncoder().encode(new TextDecoder().decode(bytes).trimStart()
        .replace(/^(?:(?:<\?xml\b[^>]*\?>|<!--[\s\S]*?-->)\s*)+/, ''))
      : bytes;
    const { parseRasterImageDimensions } = await import('./rasterImageDimensions');
    const dimensions = parseRasterImageDimensions(metadataBytes);
    if (!dimensions || dimensions.width * dimensions.height > 64 * 1024 * 1024) throw new Error('图片文件头或实际尺寸无效');
    await options?.assertCurrent?.();
    throwIfMediaReadAborted(options?.signal);
    return dimensions;
  } finally { await file.close(); }
}

export type MediaPersistenceFailureKind = 'http' | 'timeout' | 'network' | 'path_access' | 'permission'
  | 'disk_space' | 'missing_file' | 'invalid_media' | 'connection_changed' | 'missing_key' | 'unknown';

interface MediaPersistenceFailure {
  kind: MediaPersistenceFailureKind;
  message: string;
  httpStatus?: number;
}

/** 原始异常只用于本次分类，不把路径、签名 URL 或响应正文传入节点和历史。 */
function describeMediaPersistenceFailure(error: unknown): MediaPersistenceFailure {
  const message = typeof error === 'string' ? error : error instanceof Error ? error.message : '';
  if (/视频下载返回空文件/.test(message)) return { kind: 'invalid_media', message: '视频下载返回空文件，可重试下载原任务' };
  if (/下载结果不是有效视频/.test(message)) return { kind: 'invalid_media', message: '下载结果不是有效视频，请检查输出格式或下载服务' };
  if (/下载结果不是受支持的图片|图片文件头或实际尺寸无效|图片文件头读取失败/.test(message)) {
    return { kind: 'invalid_media', message: '图片原件格式或实际尺寸无效，请检查输出格式或下载服务' };
  }
  if (/下载返回不完整的分段内容/.test(message)) return { kind: 'invalid_media', message: '下载返回了不完整的视频或媒体，可重试下载原任务' };
  if (message === '项目目录或本地媒体地址不可用') return { kind: 'missing_file', message };
  if (/原(?:媒体)?连接.*(?:不存在|已变化)|接口地址已变化|媒体下载地址与厂商连接不同源/.test(message)) {
    return { kind: 'connection_changed', message: '原媒体连接或接口地址已变化，请检查原连接配置' };
  }
  if (/原媒体连接尚未填写 API Key|API Key.*(?:缺失|未填写)|未(?:填写|配置).*(?:API Key|密钥)/i.test(message)) {
    return { kind: 'missing_key', message: '原媒体连接尚未填写 API Key，请补填后继续保存' };
  }
  if (/forbidden path|路径未获授权|not allowed on the scope/i.test(message)) {
    return { kind: 'path_access', message: '应用拒绝访问项目文件，请在设置中重新选择文件保存目录' };
  }
  if (/permission denied|access is denied|拒绝访问|os error 5\b|EACCES|EPERM/i.test(message)) {
    return { kind: 'permission', message: '系统拒绝写入项目目录，请检查目录的写入权限' };
  }
  if (/no space|disk.*full|磁盘.*不足|空间不足|ENOSPC|os error 112\b/i.test(message)) {
    return { kind: 'disk_space', message: '目标磁盘空间不足' };
  }
  const httpStatus = /\bHTTP\s+(\d{3})\b/i.exec(message)?.[1];
  if (httpStatus && Number(httpStatus) >= 400 && Number(httpStatus) <= 599) {
    return { kind: 'http', httpStatus: Number(httpStatus), message: `图片或媒体下载失败（HTTP ${httpStatus}）` };
  }
  if (/timed?\s*out|timeout|超时/i.test(message)) {
    return { kind: 'timeout', message: '下载媒体失败，请检查网络或媒体链接是否已失效' };
  }
  if (/下载请求失败|媒体下载连接失败|读取下载数据失败|failed to fetch|network|connection (?:reset|closed|refused)|连接.*(?:失败|中断)|读取.*中断/i.test(message)) {
    return { kind: 'network', message: '下载媒体失败，请检查网络或媒体链接是否已失效' };
  }
  if (/目录.*不存在|no such file|path not found|找不到指定|ENOENT|os error [23]\b/i.test(message)) {
    return { kind: 'missing_file', message: '项目目录或源文件不存在，请检查文件保存位置' };
  }
  if (error instanceof MediaDataUrlTooLargeError || error instanceof MediaDataUrlTotalTooLargeError) {
    return { kind: 'invalid_media', message: '媒体超过内存保存上限' };
  }
  return { kind: 'unknown', message: '保存过程发生异常，请检查文件保存目录和媒体来源' };
}

/** 只携带固定分类后的原因，供待恢复任务展示；不保留原生异常或 cause。 */
export class MediaPersistenceError extends Error {
  readonly failureKind: MediaPersistenceFailureKind;
  readonly httpStatus?: number;

  constructor(error: unknown) {
    const failure = describeMediaPersistenceFailure(error);
    super(`生成媒体未能写入项目目录：${failure.message}`);
    this.name = 'MediaPersistenceError';
    this.failureKind = failure.kind;
    if (failure.httpStatus !== undefined) this.httpStatus = failure.httpStatus;
  }
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
  let dimensions: { width: number; height: number } | undefined;
  try {
    saved = await downloadUrlAndSave(url, projectId, fallbackPrefix, baseName, { ...options, throwOnError: true });
    if (saved?.filePath && /\.(?:gif|svg)$/i.test(saved.filePath)) {
      dimensions = await readPersistedImageDimensions(saved.filePath, options);
    }
  } catch (error) {
    if (isAbortError(error) || options?.signal?.aborted) {
      throw new DOMException('媒体保存已取消', 'AbortError');
    }
    // 仅保留固定分类后的原因，不携带原始路径、链接或凭据。
    throw new MediaPersistenceError(error);
  }
  if (!saved?.filePath || !saved.assetUrl) {
    throw new MediaPersistenceError('项目目录或本地媒体地址不可用');
  }
  if (isLocalMediaUrl(url)) {
    return { ...saved, ...dimensions, mediaUrl: saved.assetUrl, sourceUrl: saved.assetUrl };
  }
  return {
    ...saved,
    ...dimensions,
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
    await options?.assertCurrent?.();
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
        const destPath = await saveProjectBytes(dataDir, fileName, bytes, true, options?.signal, options.assertCurrent);
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
    const downloadAccessService = !sourcePath && options?.mediaDownloadAccess
      ? await import('./ai/mediaDownloadAccess') : undefined;
    const remoteRequest = downloadAccessService
      ? await downloadAccessService.resolveMediaDownloadRequest(url, options?.mediaDownloadAccess)
      : { url };
    throwIfMediaReadAborted(options?.signal);
    // 本地 URL 还原为授权文件路径，保留原生流式复制的取消与进度。
    const sourceName = sourcePath?.replace(/\\/g, '/').split('/').pop();
    const fileName = baseName && baseName.trim()
      ? buildNodeFileName(baseName, guessExtension(sourceName ?? url, undefined, fallbackPrefix), fallbackPrefix)
      : sourceName ? sanitizeFileName(sourceName) : extractFileNameFromUrl(url, fallbackPrefix);
    const dataDir = await ensureProjectDataDir(projectId, { throwOnError: options?.throwOnError });
    if (!dataDir) return null;
    const generatedImage = /image|panorama/i.test(fallbackPrefix)
      && downloadAccessService?.requiresImageContainerValidation(options?.mediaDownloadAccess) === true;
    const result = await withDownloadDestinationLock(
      dataDir,
      // 真实格式可能不同于 URL：同一显示名的各图片后缀共用分配锁。
      generatedImage ? fileName.replace(/\.[^.]+$/, '') : fileName,
      async () => {
        const destPath = await resolveUniqueDestPath(dataDir, fileName, true);
        const expectedMediaKind = generatedImage ? 'image' : fallbackPrefix.includes('video') ? 'video' : undefined;
        const downloaded = sourcePath
          ? await runNativeFileTransfer('copy_file_streamed', { sourcePath, destinationPath: destPath }, options)
          : await downloadRemoteMediaToPath(remoteRequest, destPath, expectedMediaKind, options);
        const actualExtension = generatedImage && downloaded.contentType ? MIME_TO_EXT[downloaded.contentType] : undefined;
        const currentExtension = /\.[^./\\]+$/.exec(downloaded.path)?.[0].toLowerCase();
        if (!actualExtension || currentExtension === actualExtension
          || (actualExtension === '.jpg' && currentExtension === '.jpeg')) return downloaded;
        throwIfMediaReadAborted(options?.signal);
        const actualFileName = `${fileName.replace(/\.[^.]+$/, '')}${actualExtension}`;
        const actualPath = await resolveUniqueDestPath(dataDir, actualFileName, true);
        // 独占复制保留原字节；失败保留下载副本，不能 rename 覆盖另一个调用的文件。
        const published = await runNativeFileTransfer('copy_file_streamed', {
          sourcePath: downloaded.path, destinationPath: actualPath,
        }, options);
        throwIfMediaReadAborted(options?.signal);
        await remove(downloaded.path).catch(() => undefined);
        return { ...published, contentType: downloaded.contentType };
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
 * 仅处理当前项目目录内的普通文件。按摘要引用的新项目产物只允许修改节点标题。
 * @returns 新的 { filePath, assetUrl, fileName }，或 null
 */
export async function renameProjectFileToLabel(
  filePath: string,
  newLabel: string,
  projectId: string,
): Promise<{ filePath: string; assetUrl: string; fileName: string } | null> {
  if (!isTauriEnv() || !filePath || isNativeProjectBindingFile(filePath)) return null;
  const projectDir = await getProjectDataDir(projectId);
  if (!projectDir) return null;

  const relativePath = getRelativeAssetPath(filePath, projectDir);
  const native = Boolean(getNativeProjectOwner(projectId));
  if (!relativePath || relativePath.split('/').some((part) => !part || part === '.' || part === '..')
    || native && isNativeProjectMediaContentPath(relativePath)) return null;

  const normPath = stripVerbatimPrefix(filePath).replace(/\\/g, '/');
  const oldName = normPath.split('/').pop() || '';
  const dotIndex = oldName.lastIndexOf('.');
  const ext = dotIndex > 0 ? oldName.slice(dotIndex) : '';
  // 若用户输入已带相同扩展名（显示名常含扩展名），先去掉避免重复后缀
  let baseLabel = newLabel;
  if (ext && baseLabel.toLowerCase().endsWith(ext.toLowerCase())) {
    baseLabel = baseLabel.slice(0, -ext.length);
  }
  const newName = buildNodeFileName(baseLabel, ext, 'file');
  if (newName === oldName || isNativeProjectBindingFile(newName)) return null;

  try {
    // 就地改名：分组内的文件留在自己的子文件夹，否则会被搬回项目根目录
    const currentDir = normPath.slice(0, normPath.length - oldName.length - 1);
    const destPath = await resolveUniqueDestPath(currentDir, newName, true);
    if (native && isNativeProjectMediaContentPath(getRelativeAssetPath(destPath, projectDir))) return null;
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
  if (isNativeProjectBindingFile(path) || isNativeProjectBindingFile(name)) throw new Error('项目归属标记由应用管理，不能改名');
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
    if (indexed?.assetId.startsWith('na2-')) throw new Error('此文件属于项目恢复点的固定素材副本，请先复制为普通素材再改名');
    const samePath = (value: string) => /^[a-z]:\//i.test(value) ? value.toLowerCase() : value;
    if (indexed && samePath(indexed.path.replace(/\\/g, '/')) !== samePath(path)) throw new Error('文件位置已变化，请刷新后重试');
    const source = indexed?.source ?? file.source;
    const ownerId = projectId ?? indexed?.projectId;
    const root = source === 'project' && ownerId ? await getProjectDataDir(ownerId)
      : source === 'global' ? await getGlobalFilesDir()
      : source === 'folder' ? roots.find((candidate) => getRelativeAssetPath(path, candidate) !== undefined) : undefined;
    const relativePath = root ? getRelativeAssetPath(newPath, root) : undefined;
    const oldRelativePath = root ? getRelativeAssetPath(path, root) : undefined;
    if (!root || !relativePath || oldRelativePath === undefined) throw new Error('文件不在已登记的资产目录内');
    if (source === 'project' && ownerId && getNativeProjectOwner(ownerId)
      && (isNativeProjectMediaContentPath(oldRelativePath) || isNativeProjectMediaContentPath(relativePath))) {
      throw new Error('此文件由应用内部管理，需要保留原名；请先复制为普通素材再改名');
    }
    // 内部 JSON 按固定路径和摘要引用，不能按普通素材的方式改名。
    if (file.category === 'text' && source === 'project'
      && /^(?:(?:director\/previs|ai-apps)\/[a-f0-9]{64}|director\/scenes\/[^/]+\/(?:scene-r\d+|results\/manifest-r\d+)-[a-f0-9]{64})\.json$/i.test(oldRelativePath)) {
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
export async function listProjectFiles(projectId: string, options: AssetScanOptions = {}): Promise<AssetFileEntry[]> {
  if (options.signal?.aborted) throw new DOMException('资源扫描已取消', 'AbortError');
  const projectDir = await getProjectDataDir(projectId);
  if (options.signal?.aborted) throw new DOMException('资源扫描已取消', 'AbortError');
  if (!projectDir) return [];
  // 一次扫描完成项目身份识别；派生缓存与内部目录在遍历前排除，增量和最终结果保持一致。
  const files = await walkDirectoryFiles(projectDir, {
    ...options,
    source: 'project',
    projectId,
    excludedRootDirectories: ['.thumbnail'],
    excludedDirectories: ['AppData', '.trash', '.shared-sync'],
  });
  return files;
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
  options: Pick<FileTransferOptions, 'assertCurrent'> = {},
): Promise<UploadResult & { filePath?: string } | null> {
  try {
    await options.assertCurrent?.();
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
      await options.assertCurrent?.();

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
        const result = await copyFileToProjectData(filePath, projectId, { projectSubdirectory, redactErrors: Boolean(projectSubdirectory), assertCurrent: options.assertCurrent });
        await options.assertCurrent?.();
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
      const base64 = await bytePartsToBase64Async([content]);
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
  owner?: { projectId: string; nodeId: string },
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
      const mime = /^data:([^;,]+)[;,]/i.exec(assetUrl.slice(0, 128))?.[1].toLowerCase();
      name = `file${mime ? MIME_TO_EXT[mime] ?? '' : ''}`;
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

  // 内嵌素材可能同名，归属节点在文件落盘前提供稳定身份。
  const entryPath = fp || (owner?.nodeId
    ? `node://${encodeURIComponent(owner.projectId)}/${encodeURIComponent(owner.nodeId)}`
    : `node://${name}`);

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

/** 图片保存原文件，不因图片节点的默认值把 GIF/SVG 改成 PNG 后缀。 */
function getImageSaveExtension(filePath?: string, fileName?: string, mediaUrl?: string): string {
  for (const source of [filePath, fileName, localMediaUrlToPath(mediaUrl)]) {
    const extension = source?.split(/[\\/]/).pop()?.match(/\.[^.]+$/)?.[0].toLowerCase();
    if (extension && ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.avif', '.bmp'].includes(extension)) return extension;
  }
  const mime = /^data:([^;,]+)/i.exec(mediaUrl || '')?.[1]?.toLowerCase();
  return guessExtension(mediaUrl || '', mime, 'image');
}

/** 根据节点类型和默认扩展名生成文件过滤器 */
function getSaveFilter(nodeType: string, defaultExtension: string): { name: string; extensions: string[] }[] {
  switch (nodeType) {
    case 'ai-text':      return [{ name: '文本文件', extensions: ['txt'] }, { name: '所有文件', extensions: ['*'] }];
    case 'ai-markdown':  return [{ name: 'Markdown 文件', extensions: ['md'] }, { name: '所有文件', extensions: ['*'] }];
    case 'ai-image':
    case 'source-image':
    case 'ai-panorama':  return [{ name: '图片文件', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg'] }, { name: '所有文件', extensions: ['*'] }];
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
  const nativeComfySource = shouldLoadNativeComfyImage(mediaUrl);
  throwIfMediaReadAborted(signal);
  const defExt = nodeType === 'ai-audio' || nodeType === 'source-audio'
    ? getAudioSaveExtension(filePath, fileName, mediaUrl)
    : ['ai-image', 'source-image', 'ai-panorama'].includes(nodeType)
      ? getImageSaveExtension(filePath, fileName, mediaUrl)
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
    // 新目标走独占发布；复制开始后的任何失败都不能落到可能覆盖目标的 URL 回退。
    // 源路径已经缺失时仍保留下面的读取失败回退，已有目标沿用保存对话框的覆盖语义。
    if (filePath && !(await exists(destPath)) && await exists(filePath)) {
      throwIfMediaReadAborted(signal);
      onProgress?.({ transferredBytes: 0, totalBytes: null, phase: 'saving' });
      const result = await copyLocalFileStreamed(filePath, destPath, {
        signal,
        onProgress: onProgress ? ({ transferredBytes, totalBytes }) => onProgress({
          transferredBytes, totalBytes, phase: 'saving',
        }) : undefined,
      });
      throwIfMediaReadAborted(signal);
      onProgress?.({ transferredBytes: result.totalBytes, totalBytes: result.totalBytes, phase: 'saving' });
      return result.path;
    }
    // 1. Media: try real file path first
    if (filePath) {
      try {
        throwIfMediaReadAborted(signal);
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
      const bytes = await decodeDataUrlBytesAsync(mediaUrl, { signal });
      throwIfMediaReadAborted(signal);
      await writeFile(destPath, bytes);
      return destPath;
    }

    // 3. ComfyUI 与普通远程 URL 的新目标走原生流下载；覆盖与 GitHub 切源保留既有入口。
    //    节点里的 asset URL 已经是 convertFileSrc 的产物，再转一次会把整个 URL 当成路径编码进去 —
    //    Windows 的 asset URL 是 http://asset.localhost/… 走不到这一步，mac 的 asset:// 才会踩到。
    if (mediaUrl && /^(asset:|blob:|https?:)/.test(mediaUrl)) {
      const githubSource = githubMirrorUrl(mediaUrl);
      const nativeRemoteSource = !nativeComfySource && !githubSource && isRemoteMediaUrl(mediaUrl) && !(await exists(destPath));
      if (nativeComfySource || nativeRemoteSource) {
        // 复用原生临时文件与提交保护；不得删除或覆盖用户已有的目标文件。
        if (nativeComfySource && await exists(destPath)) throw new Error('目标文件已存在，请改用新文件名保存');
        throwIfMediaReadAborted(signal);
        onProgress?.({ transferredBytes: 0, totalBytes: null, phase: 'downloading' });
        const result = await runNativeFileTransfer('download_file_streamed', {
          url: mediaUrl, destinationPath: destPath,
          ...(nativeComfySource && nodeType.includes('video') ? { expectedMediaKind: 'video' } : {}),
        }, {
          signal,
          onProgress: onProgress ? ({ transferredBytes, totalBytes }) => onProgress({
            transferredBytes, totalBytes, phase: 'downloading',
          }) : undefined,
        });
        throwIfMediaReadAborted(signal);
        onProgress?.({ transferredBytes: result.totalBytes, totalBytes: result.totalBytes, phase: 'saving' });
        return result.path;
      }
      if (githubSource) {
        const bytes = await downloadGithubBytes(mediaUrl, { signal, onProgress: (transferredBytes, totalBytes) =>
          onProgress?.({ transferredBytes, totalBytes: totalBytes ?? null, phase: 'downloading' }) });
        throwIfMediaReadAborted(signal);
        onProgress?.({ transferredBytes: bytes.byteLength, totalBytes: bytes.byteLength, phase: 'saving' });
        await writeFile(destPath, bytes);
        return destPath;
      }
      const reportProgress = isRemoteMediaUrl(mediaUrl) ? onProgress : undefined;
      reportProgress?.({ transferredBytes: 0, totalBytes: null, phase: 'downloading' });
      throwIfMediaReadAborted(signal);
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

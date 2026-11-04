/**
 * dramaAssetArchive — 管理短剧资产归档的临时工作区与清理。
 */
import { mkdir, remove, rename, stat, writeFile } from '@tauri-apps/plugin-fs';
import { invoke } from '@tauri-apps/api/core';
import { assertDramaAssetWriteCurrent, type DramaAssetWriteOptions } from '../../types/dramaAssets';
import { getBaseDir, ensureProjectDataDir, joinPath, stripVerbatimPrefix } from './core';
import { copyAssetFileToFolder, downloadAssetArchiveMedia, getGlobalFilesDir, readFileToDataUrl, type AssetFileCopyResult } from '../fileService';
import { decodeDataUrlBytesAsync, MEDIA_DATA_URL_BYTE_LIMITS } from '../mediaDataUrl';

export interface DramaAssetArchiveWorkspace {
  directory: string;
  assetsDirectory: string;
  mediaDirectory: string;
  incomingDirectory: string;
}

export interface DramaAssetImportFolder { directory: string; rootDirectory: string; relativeDirectory: string }
export interface DramaAssetArchiveUnpacked { texts: Record<string, string>; assetPaths: string[]; assetBytes: number }
const ownedDirectories = new Set<string>();

export async function guardedDramaAssetTransfer<T>(work: () => Promise<T>, options: DramaAssetWriteOptions = {}): Promise<T> {
  assertDramaAssetWriteCurrent(options);
  const result = await work();
  assertDramaAssetWriteCurrent(options);
  return result;
}

/** 清理能力只接受当前进程亲自创建的专属目录，不能接收归档中的任意路径。 */
export async function cleanupDramaAssetTransferDirectory(directory: string): Promise<void> {
  if (!ownedDirectories.has(directory)) throw new Error('资产包临时目录无效');
  await remove(directory, { recursive: true });
  ownedDirectories.delete(directory);
}

/** 进入元数据保存后媒体须保留，同时撤销本轮临时清理能力。 */
export function retainDramaAssetTransferDirectory(directory: string): void {
  ownedDirectories.delete(directory);
}

async function createOwnedDirectory(parent: string, prefix: string, options: DramaAssetWriteOptions): Promise<string> {
  await guardedDramaAssetTransfer(() => mkdir(parent, { recursive: true }), options);
  const directory = joinPath(parent, `${prefix}${crypto.randomUUID()}`);
  await mkdir(directory);
  ownedDirectories.add(directory);
  try { assertDramaAssetWriteCurrent(options); return directory; }
  catch (error) { await cleanupDramaAssetTransferDirectory(directory).catch(() => undefined); throw error; }
}

export async function createDramaAssetArchiveWorkspace(options: DramaAssetWriteOptions = {}): Promise<DramaAssetArchiveWorkspace> {
  const base = await guardedDramaAssetTransfer(getBaseDir, options);
  if (!base) throw new Error('资产包暂存目录不可用');
  const directory = await createOwnedDirectory(base, '.aicassets-stage-', options);
  try {
    const assetsDirectory = joinPath(directory, 'assets');
    const mediaDirectory = joinPath(assetsDirectory, 'media');
    const incomingDirectory = joinPath(directory, 'incoming');
    // 导入目标必须为空；导出媒体目录由首次写入按需创建。
    await guardedDramaAssetTransfer(() => mkdir(assetsDirectory), options);
    await guardedDramaAssetTransfer(() => mkdir(incomingDirectory), options);
    return { directory, assetsDirectory, mediaDirectory, incomingDirectory };
  } catch (error) { await cleanupDramaAssetTransferDirectory(directory).catch(() => undefined); throw error; }
}

export async function createDramaAssetImportFolder(ownerId: string, options: DramaAssetWriteOptions = {}): Promise<DramaAssetImportFolder> {
  const projectDirectory = await guardedDramaAssetTransfer(() => ensureProjectDataDir(ownerId, { throwOnError: true }), options);
  if (!projectDirectory) throw new Error('项目素材目录不可用');
  const directory = await createOwnedDirectory(joinPath(projectDirectory, 'Library'), 'import-', options);
  return { directory, rootDirectory: projectDirectory, relativeDirectory: `Library/${directory.replace(/\\/g, '/').split('/').pop()!}` };
}

export async function createGlobalDramaAssetImportFolder(options: DramaAssetWriteOptions = {}): Promise<DramaAssetImportFolder> {
  const rootDirectory = await guardedDramaAssetTransfer(getGlobalFilesDir, options);
  if (!rootDirectory) throw new Error('全局素材目录不可用');
  const directory = await createOwnedDirectory(rootDirectory, 'import-', options);
  return { directory, rootDirectory, relativeDirectory: directory.replace(/\\/g, '/').split('/').pop()! };
}

/** 所有来源最终通过受控复制得到一致的字节数与 SHA-256，不将视频搬入 JS 内存。 */
export async function stageDramaAssetArchiveMedia(
  workspace: DramaAssetArchiveWorkspace, source: { filePath?: string; url?: string },
  id: string, extension: string, kind: 'image' | 'audio' | 'video', options: DramaAssetWriteOptions = {},
): Promise<AssetFileCopyResult & { relativePath: string }> {
  if (!/^[a-zA-Z0-9_-]+$/.test(id) || !/^[a-z0-9]{1,8}$/.test(extension)) throw new Error('资产包媒体名称无效');
  await guardedDramaAssetTransfer(() => mkdir(workspace.mediaDirectory, { recursive: true }), options);
  let sourcePath = source.filePath;
  if (!sourcePath) {
    const url = source.url;
    if (!url) throw new Error('创作资产媒体缺失');
    const rawPath = joinPath(workspace.incomingDirectory, `${id}.${extension}`);
    if (/^https?:/i.test(url)) {
      sourcePath = await guardedDramaAssetTransfer(() => downloadAssetArchiveMedia(url, rawPath, kind, { signal: options.signal }), options);
    } else if (/^(?:data:|blob:)/i.test(url)) {
      const dataUrl = /^data:/i.test(url) ? url
        : await guardedDramaAssetTransfer(() => readFileToDataUrl(url, { kind, signal: options.signal }), options);
      if (!dataUrl) throw new Error('创作资产媒体缺失');
      const bytes = await guardedDramaAssetTransfer(() => decodeDataUrlBytesAsync(dataUrl, {
        maxBytes: MEDIA_DATA_URL_BYTE_LIMITS[kind], signal: options.signal, label: '创作资产媒体',
      }), options);
      await guardedDramaAssetTransfer(() => writeFile(rawPath, bytes, { createNew: true }), options);
      sourcePath = rawPath;
    } else throw new Error('创作资产媒体地址不可用');
  }
  const copied = await guardedDramaAssetTransfer(() => copyAssetFileToFolder(sourcePath!, workspace.mediaDirectory, { signal: options.signal }), options);
  const path = joinPath(workspace.mediaDirectory, `${id}.${extension}`);
  if (stripVerbatimPrefix(copied.path).replace(/\\/g, '/') !== path) await guardedDramaAssetTransfer(() => rename(copied.path, path), options);
  return { ...copied, path, relativePath: `media/${id}.${extension}` };
}

export async function copyImportedDramaAssetMedia(sourcePath: string, directory: string, options: DramaAssetWriteOptions = {}): Promise<AssetFileCopyResult> {
  return guardedDramaAssetTransfer(() => copyAssetFileToFolder(sourcePath, directory, { signal: options.signal }), options);
}

export async function readImportedDramaAssetStat(path: string, options: DramaAssetWriteOptions = {}): Promise<{ size: number; mtimeMs: number }> {
  const info = await guardedDramaAssetTransfer(() => stat(path), options);
  if (!info.isFile || info.isSymlink) throw new Error('导入媒体不是普通文件');
  return { size: info.size, mtimeMs: info.mtime?.getTime() ?? 0 };
}

export async function packDramaAssetArchive(workspace: DramaAssetArchiveWorkspace, outputPath: string, content: string): Promise<{ assetCount: number }> {
  return invoke('pack_project_archive', { assetsDir: workspace.assetsDirectory, outputPath, entries: [{ path: 'manifest.json', content }] });
}

export async function unpackDramaAssetArchive(workspace: DramaAssetArchiveWorkspace, archivePath: string): Promise<DramaAssetArchiveUnpacked> {
  return invoke('unpack_project_archive', { archivePath, assetsDir: workspace.assetsDirectory });
}

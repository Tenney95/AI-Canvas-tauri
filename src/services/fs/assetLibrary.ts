/**
 * fs/assetLibrary — 全局资产库（项目无关）+ 外部文件夹 + 全局资产
 * 全局 file 目录、递归遍历外部文件夹、添加文件/文件夹、保存到永久目录、删除永久文件。
 */
import { writeFile, readFile as tauriReadFile, mkdir, exists, stat, readDir } from '@tauri-apps/plugin-fs';
import { open } from '@tauri-apps/plugin-dialog';
import {
  isTauriEnv,
  joinPath,
  getBaseDir,
  getConvertFileSrc,
  resolveUniqueDestPath,
  getFileCategory,
  stripVerbatimPrefix,
  CATEGORY_EXTENSIONS,
  type AssetFileEntry,
} from './core';
import { moveToTrash } from './trash';
import { getRelativeAssetPath, identifyAsset, identifyAssetBatch } from './assetIndex';
import { getAssetIndexByPath, putAssetIndex } from '../indexedDbService';

/** 仅用于目录浏览的运行时条目，不写入资产索引或持久化配置。 */
export interface AssetFolderEntry {
  rootPath: string;
  relativePath: string;
  parentRelativePath: string | null;
  name: string;
  fileCount: number;
  availability: 'online' | 'offline' | 'unscanned';
}

export type AssetFolderSelection =
  | { kind: 'all' }
  | { kind: 'global' }
  | { kind: 'folder'; rootPath: string; relativePath: string };

export interface AssetScanOptions {
  signal?: AbortSignal;
  /** 调用方已知的历史版本路径；在 stat 与身份识别前排除，不为旧版本分配新共享身份。 */
  excludedFilePaths?: readonly string[];
  /** 精确项目路径模式：只复用这些项目的现有身份，新路径不从丢失指纹候选接管身份。 */
  projectIdentityScope?: readonly string[];
  /** 已完成稳定身份识别的新增条目；完整列表仍通过返回值获取。 */
  onFiles?: (batch: AssetFileEntry[]) => void;
}

/** 同步必须区分完整扫描与受限／失败的部分结果，不能据部分结果推断删除。 */
export interface AssetDirectoryScanResult {
  files: AssetFileEntry[];
  folders: AssetFolderEntry[];
  truncated: boolean;
  complete: boolean;
  failedDirectories: number;
  failedFiles: number;
}

function throwIfScanAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('资源扫描已取消', 'AbortError');
}

function comparablePath(path: string): string {
  const normalized = stripVerbatimPrefix(path).replace(/\\/g, '/').replace(/\/+$/, '');
  return /^[a-z]:\//i.test(normalized) || normalized.startsWith('//') ? normalized.toLowerCase() : normalized;
}

/** 按实际父目录筛选，兼容 Windows 分隔符和重复登记的父/子目录。 */
export function selectAssetFolderFiles(files: AssetFileEntry[], selection: AssetFolderSelection): AssetFileEntry[] {
  if (selection.kind === 'all') return files;
  if (selection.kind === 'global') return files.filter((file) => file.source === 'global' && !file.relativePath?.includes('/'));
  const directory = comparablePath(`${selection.rootPath.replace(/[\\/]+$/, '')}/${selection.relativePath}`);
  return files.filter((file) => {
    const path = comparablePath(file.path);
    return path.slice(0, path.lastIndexOf('/')) === directory;
  });
}

/** 全局文件目录：{baseDataDir}/file（手动添加的单文件落此处）*/
export async function getGlobalFilesDir(): Promise<string | null> {
  const base = await getBaseDir();
  if (!base) return null;
  return joinPath(base, 'file');
}

async function ensureGlobalFilesDir(): Promise<string | null> {
  if (!isTauriEnv()) return null;
  const dir = await getGlobalFilesDir();
  if (!dir) return null;
  try {
    if (!(await exists(dir))) await mkdir(dir, { recursive: true });
    return dir;
  } catch (err) {
    console.error('Failed to create global files dir:', dir, err);
    return null;
  }
}

/** 列出全局 file 目录的文件，包含用户创建的子目录。 */
export async function listGlobalFiles(options: AssetScanOptions = {}): Promise<AssetFileEntry[]> {
  return (await listGlobalFolderContents(options)).files;
}

export async function listGlobalFolderContents(options: AssetScanOptions = {}): Promise<{ files: AssetFileEntry[]; folders: AssetFolderEntry[]; truncated: boolean; rootPath: string | null }> {
  throwIfScanAborted(options.signal);
  const dir = await getGlobalFilesDir();
  const available = dir && await exists(dir).catch(() => false);
  throwIfScanAborted(options.signal);
  if (!dir || !available) return { files: [], folders: [], truncated: false, rootPath: dir };
  return { ...await scanDirectoryFiles(dir, { ...options, source: 'global' }), rootPath: dir };
}

/** 只把已登记目录或全局目录作为写入目标，不接受聚合视图。 */
export async function resolveAssetFolderDirectory(selection: AssetFolderSelection, roots: readonly string[]): Promise<string> {
  if (!isTauriEnv()) throw new Error('目录操作仅支持桌面应用');
  const globalRoot = await getGlobalFilesDir();
  if (selection.kind === 'all') throw new Error('请选择具体文件夹');
  if (selection.kind === 'global') {
    const directory = await ensureGlobalFilesDir();
    if (!directory) throw new Error('无法访问导入文件目录');
    return directory;
  }
  if (![...roots, ...(globalRoot ? [globalRoot] : [])].some((root) => comparablePath(root) === comparablePath(selection.rootPath))) {
    throw new Error('该文件夹引用已移除');
  }
  if (selection.relativePath && selection.relativePath.split(/[\\/]/).some((part) => !part || part === '.' || part === '..' || part.includes(':'))) {
    throw new Error('文件夹相对路径无效');
  }
  return selection.relativePath ? joinPath(selection.rootPath, selection.relativePath) : selection.rootPath;
}

export async function createAssetSubfolder(selection: AssetFolderSelection, roots: readonly string[], name: string): Promise<string> {
  const clean = name.trim();
  if (!clean || clean === '.' || clean === '..' || /[\\/:*?"<>|]/.test(clean) || [...clean].some((char) => char.charCodeAt(0) < 32)
    || /[. ]$/.test(clean) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(clean) || clean.length > 255) {
    throw new Error('文件夹名称无效，请去掉特殊字符');
  }
  const parent = await resolveAssetFolderDirectory(selection, roots);
  const directory = joinPath(parent, clean);
  if (await exists(directory)) throw new Error('同名文件夹或文件已存在');
  // 非 recursive 创建不覆盖同名目录；权限仍由 fs 插件 scope 校验。
  await mkdir(directory);
  return directory;
}

/**
 * 递归遍历目录收集文件（带数量/深度上限，避免超大目录卡死）。
 * stat 小批并行，身份识别串行；边扫描边返回稳定条目，整体用栈迭代而非深递归。
 */
export async function scanDirectoryFiles(
  rootDir: string,
  opts: AssetScanOptions & {
    maxFiles?: number; maxDepth?: number; maxDirectories?: number;
    excludedRootDirectories?: readonly string[]; excludedDirectories?: readonly string[];
    source?: 'project' | 'folder' | 'global'; projectId?: string;
  } = {},
): Promise<AssetDirectoryScanResult> {
  throwIfScanAborted(opts.signal);
  if (!isTauriEnv()) return { files: [], folders: [], truncated: false, complete: false, failedDirectories: 0, failedFiles: 0 };
  const maxFiles = opts.maxFiles ?? 3000;
  const maxDepth = opts.maxDepth ?? 8;
  const maxDirectories = Math.max(1, opts.maxDirectories ?? 3000);
  const excludedFiles = new Set((opts.excludedFilePaths ?? []).map(comparablePath));
  const convertFileSrc = await getConvertFileSrc();
  throwIfScanAborted(opts.signal);
  const out: AssetFileEntry[] = [];
  const root: AssetFolderEntry = {
    rootPath: rootDir, relativePath: '', parentRelativePath: null,
    name: rootDir.split(/[\\/]/).filter(Boolean).pop() || rootDir, fileCount: 0, availability: 'unscanned',
  };
  const folders: AssetFolderEntry[] = [root];
  const stack: { dir: string; depth: number; folder: AssetFolderEntry }[] = [{ dir: rootDir, depth: 0, folder: root }];
  let truncated = false;
  let failedDirectories = 0;
  let failedFiles = 0;

  while (stack.length > 0 && out.length < maxFiles) {
    throwIfScanAborted(opts.signal);
    const { dir, depth, folder } = stack.pop()!;
    let entries: Awaited<ReturnType<typeof readDir>>;
    try {
      entries = await readDir(dir);
      folder.availability = 'online';
    } catch {
      throwIfScanAborted(opts.signal);
      folder.availability = 'offline';
      failedDirectories++;
      continue;
    }
    throwIfScanAborted(opts.signal);
    // 不跟随符号链接扩大外部目录授权或形成遍历环。
    const fileEntries = entries.filter((e) => e.isFile && !e.isSymlink
      && !excludedFiles.has(comparablePath(joinPath(dir, e.name))));
    const subDirs = entries.filter((e) => e.isDirectory && !e.isSymlink
      && !opts.excludedDirectories?.includes(e.name)
      && !(depth === 0 && opts.excludedRootDirectories?.includes(e.name)));

    const initialFileCount = out.length;
    const statBatchSize = 12;
    for (let offset = 0; offset < fileEntries.length && out.length < maxFiles; offset += statBatchSize) {
      throwIfScanAborted(opts.signal);
      const batchEntries = fileEntries.slice(offset, offset + statBatchSize);
      const statResults = await Promise.all(batchEntries.map(async (e) => {
        const filePath = joinPath(dir, e.name);
        try {
          const s = await stat(filePath);
          const createdAt = s.birthtime?.getTime();
          const modifiedAt = s.mtime?.getTime();
          return { name: e.name, filePath, size: s.size ?? 0, mtimeMs: modifiedAt ?? 0,
            createdAt: Number.isFinite(createdAt) ? createdAt : undefined,
            modifiedAt: Number.isFinite(modifiedAt) ? modifiedAt : undefined };
        } catch {
          return null;
        }
      }));
      throwIfScanAborted(opts.signal);
      const batch: AssetFileEntry[] = [];
      // 首批仍逐项发布首个结果；后续普通扫描合并已知身份刷新，精确项目扫描保留原隔离流程。
      const validResults = statResults.filter((entry): entry is NonNullable<typeof entry> => entry !== null)
        .slice(0, maxFiles - out.length);
      const batchIdentities = out.length > 0 && !opts.projectIdentityScope
        ? await identifyAssetBatch(validResults.map((entry) => ({ path: entry.filePath, options: {
            rootPath: rootDir, source: opts.source ?? 'folder', projectId: opts.projectId,
            size: entry.size, mtimeMs: entry.mtimeMs,
          } })), opts.signal)
        : undefined;
      const identitiesByPath = batchIdentities
        ? new Map(validResults.map((entry, index) => [entry.filePath, batchIdentities[index]])) : undefined;
      throwIfScanAborted(opts.signal);
      for (const r of statResults) {
        if (!r) { failedFiles++; continue; }
        if (out.length >= maxFiles) { truncated = true; break; }
        throwIfScanAborted(opts.signal);
        const ext = `.${r.name.split('.').pop()?.toLowerCase()}`;
        const assetUrl = CATEGORY_EXTENSIONS.image.includes(ext) && convertFileSrc ? convertFileSrc(r.filePath) : undefined;
        let assetId: string | undefined;
        if (opts.projectIdentityScope) {
          const relativePath = getRelativeAssetPath(r.filePath, rootDir);
          if (opts.source !== 'project' || !opts.projectId || !opts.projectIdentityScope.includes(opts.projectId) || !relativePath) {
            throw new Error('项目文件身份范围无效，请重新预览');
          }
          const indexed = await getAssetIndexByPath(r.filePath);
          if (indexed && (indexed.source !== 'project' || !indexed.projectId || !opts.projectIdentityScope.includes(indexed.projectId))) {
            throw new Error('项目文件包含其他来源的资产身份，请先复制为独立项目资产');
          }
          assetId = indexed?.assetId ?? crypto.randomUUID();
          if (!indexed) {
            // 先登记全新身份，让既有识别器仅刷新精确路径，不接管其他来源的丢失记录。
            // path 唯一索引会拒绝并发登记，保留原记录。
            await putAssetIndex({ assetId, path: stripVerbatimPrefix(r.filePath).replace(/\\/g, '/'),
              rootPath: stripVerbatimPrefix(rootDir).replace(/\\/g, '/'), relativePath, projectId: opts.projectId,
              source: 'project', size: r.size, mtimeMs: r.mtimeMs, fingerprint: `${r.size}:${r.mtimeMs}`,
              status: 'online', updatedAt: Date.now() });
            throwIfScanAborted(opts.signal);
          }
        }
        const identity = identitiesByPath?.get(r.filePath) ?? await identifyAsset(r.filePath, {
          assetId,
          rootPath: rootDir,
          source: opts.source ?? 'folder',
          projectId: opts.projectId,
          size: r.size,
          mtimeMs: r.mtimeMs,
        });
        throwIfScanAborted(opts.signal);
        const file: AssetFileEntry = {
          assetId: identity.assetId,
          name: r.name,
          path: r.filePath,
          relativePath: identity.relativePath,
          assetUrl,
          size: r.size,
          createdAt: r.createdAt,
          modifiedAt: r.modifiedAt,
          category: getFileCategory(r.name),
          availability: 'online',
          source: opts.source,
        };
        out.push(file);
        batch.push(file);
        // 首个条目立即可见，后续合并通知，避免逐文件触发渲染。
        if (out.length === 1) opts.onFiles?.(batch.splice(0));
      }
      throwIfScanAborted(opts.signal);
      if (batch.length) opts.onFiles?.(batch);
      if (out.length >= maxFiles && offset + batchEntries.length < fileEntries.length) truncated = true;
    }

    folder.fileCount = out.length - initialFileCount;
    if (depth < maxDepth) {
      for (const d of subDirs) {
        if (opts.excludedDirectories?.includes(d.name)) continue;
        // 项目派生缓存只占用根目录；分组和外部目录内的同名文件夹仍是用户素材。
        if (depth === 0 && opts.excludedRootDirectories?.includes(d.name)) continue;
        if (folders.length >= maxDirectories) { truncated = true; break; }
        const child: AssetFolderEntry = {
          rootPath: rootDir,
          relativePath: folder.relativePath ? `${folder.relativePath}/${d.name}` : d.name,
          parentRelativePath: folder.relativePath,
          name: d.name,
          fileCount: 0,
          availability: 'unscanned',
        };
        folders.push(child);
        stack.push({ dir: joinPath(dir, d.name), depth: depth + 1, folder: child });
      }
    } else if (subDirs.length > 0) {
      truncated = true;
    }
  }
  throwIfScanAborted(opts.signal);
  truncated ||= stack.length > 0;
  return { files: out, folders, truncated, complete: !truncated && failedDirectories === 0 && failedFiles === 0,
    failedDirectories, failedFiles };
}

/** 保留原文件扫描接口，项目文件和独立资源搜索继续返回扁平列表。 */
export async function walkDirectoryFiles(
  rootDir: string,
  opts: AssetScanOptions & {
    maxFiles?: number; maxDepth?: number;
    excludedRootDirectories?: readonly string[]; excludedDirectories?: readonly string[];
    source?: 'project' | 'folder' | 'global'; projectId?: string;
  } = {},
): Promise<AssetFileEntry[]> {
  return (await scanDirectoryFiles(rootDir, opts)).files;
}

/** 一次扫描同时收集真实目录和文件，空目录也可浏览。 */
export async function listExternalFolderContents(
  roots: string[],
  opts: AssetScanOptions & { maxFilesPerFolder?: number; maxDepth?: number; maxDirectories?: number } = {},
): Promise<{ files: AssetFileEntry[]; folders: AssetFolderEntry[]; truncated: boolean }> {
  throwIfScanAborted(opts.signal);
  if (!isTauriEnv()) return { files: [], folders: [], truncated: false };
  const results = await Promise.all(roots.map(async (root) => {
    const withFolderRoot = (file: AssetFileEntry): AssetFileEntry => ({ ...file, source: 'folder', folderRoot: root });
    const result = await scanDirectoryFiles(root, {
      maxFiles: opts.maxFilesPerFolder, maxDepth: opts.maxDepth, maxDirectories: opts.maxDirectories,
      source: 'folder', signal: opts.signal,
      onFiles: opts.onFiles ? (batch) => opts.onFiles?.(batch.map(withFolderRoot)) : undefined,
    });
    return { ...result, files: result.files.map(withFolderRoot) };
  }));
  throwIfScanAborted(opts.signal);
  return {
    files: results.flatMap((result) => result.files),
    folders: results.flatMap((result) => result.folders),
    truncated: results.some((result) => result.truncated),
  };
}

/** 列出登记的外部文件夹中的全部文件（递归，整体上限） */
export async function listExternalFolderFiles(
  folders: string[],
  opts: { maxFilesPerFolder?: number } = {},
): Promise<AssetFileEntry[]> {
  if (!isTauriEnv() || folders.length === 0) return [];
  const perFolder = opts.maxFilesPerFolder ?? 3000;
  const results = await Promise.all(
    folders.map(async (folder) => {
      if (!(await exists(folder).catch(() => false))) return [];
      const files = await walkDirectoryFiles(folder, { maxFiles: perFolder });
      return files.map((f) => ({ ...f, source: 'folder' as const, folderRoot: folder }));
    }),
  );
  return results.flat();
}

/** 选择本地文件（可多选）拷贝到指定资产目录；未指定时沿用全局 file 根目录。 */
export async function addAssetFilesToGlobal(
  selection: AssetFolderSelection = { kind: 'global' }, roots: readonly string[] = [],
): Promise<number> {
  if (!isTauriEnv()) return 0;
  const selected = await open({ multiple: true, title: '添加文件到资产库' });
  if (!selected) return 0;
  const paths = Array.isArray(selected) ? selected : [selected];
  const destDir = await resolveAssetFolderDirectory(selection, roots);

  let count = 0;
  for (const src of paths) {
    try {
      const fileName = src.split(/[\\/]/).pop() || 'file';
      const destPath = await resolveUniqueDestPath(destDir, fileName);
      const data = await tauriReadFile(src);
      await writeFile(destPath, data);
      count++;
    } catch (err) {
      console.error('Failed to add file to global:', src, err);
    }
  }
  return count;
}

/** 选择一个本地文件夹，返回其路径（仅登记引用，不拷贝） */
export async function pickAssetFolder(): Promise<string | null> {
  if (!isTauriEnv()) return null;
  const selected = await open({ directory: true, title: '添加本地文件夹' });
  if (!selected || Array.isArray(selected)) return typeof selected === 'string' ? selected : null;
  return selected;
}

/** 将文件拷贝到全局永久目录 {baseDataDir}/file */
export async function saveToPermanent(filePath: string): Promise<string | null> {
  if (!isTauriEnv()) return null;
  const destDir = await ensureGlobalFilesDir();
  if (!destDir) return null;

  try {
    const fileName = filePath.split(/[\\/]/).pop() || 'file';
    const destPath = await resolveUniqueDestPath(destDir, fileName);
    const data = await tauriReadFile(filePath);
    await writeFile(destPath, data);
    return destPath;
  } catch (err) {
    console.error('Failed to save file to permanent:', filePath, err);
    return null;
  }
}

/**
 * 将 asset entry 保存到永久目录 — 支持磁盘文件和 data URL 两种来源
 * virtual:// 路径会从 entry.assetUrl（data URL）解码写入
 */
export async function saveAssetToPermanent(
  entry: AssetFileEntry,
): Promise<string | null> {
  if (!isTauriEnv()) return null;

  // 虚拟路径：从 data URL 解码写入
  if (entry.path.startsWith('virtual://')) {
    if (!entry.assetUrl || !entry.assetUrl.startsWith('data:')) return null;
    const destDir = await ensureGlobalFilesDir();
    if (!destDir) return null;

    try {
      const destPath = await resolveUniqueDestPath(destDir, entry.name);

      const match = entry.assetUrl.match(/^data:(.+?);base64,(.+)$/);
      if (match) {
        const b64 = match[2];
        const binaryStr = atob(b64);
        const bytes = new Uint8Array(binaryStr.length);
        for (let i = 0; i < binaryStr.length; i++) {
          bytes[i] = binaryStr.charCodeAt(i);
        }
        await writeFile(destPath, bytes);
      } else {
        const resp = await fetch(entry.assetUrl);
        const buffer = await resp.arrayBuffer();
        await writeFile(destPath, new Uint8Array(buffer));
      }
      return destPath;
    } catch (err) {
      console.error('Failed to save virtual asset to permanent:', entry.name, err);
      return null;
    }
  }

  // 真实磁盘路径
  return saveToPermanent(entry.path);
}

/** 删除全局资产的文件（移入回收站） */
export async function deletePermanentFile(filePath: string): Promise<void> {
  await moveToTrash(filePath, { throwOnError: true });
}

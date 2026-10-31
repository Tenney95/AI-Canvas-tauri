/**
 * fs/core — 文件服务的基础设施层
 * 环境探测、路径/MIME 工具、asset 协议、数据根目录与「项目名-短ID」目录映射、
 * 同名加序号、文件分类与目录列举。被 fs 下其它模块及 fileService 共用。
 */
import {
  exists,
  mkdir,
  lstat,
  open as fsOpen,
  remove,
  readDir,
  readFile,
  rename,
  stat,
  watch,
  writeFile,
  type DebouncedWatchOptions,
  type WatchEvent,
} from '@tauri-apps/plugin-fs';
import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { appDataDir, executableDir } from '@tauri-apps/api/path';
import { mediaFileAllocationKey, retiredMediaPaths } from '../indexedDb/mediaRelocations';

/** 检测是否运行在 Tauri 桌面环境中 */
export function isTauriEnv(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/** 浏览器降级文件选择；选择、取消与返回焦点共用一次收尾。 */
export function browserOpenFile(accept: string): Promise<File | null> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.hidden = true;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      if (timer !== undefined) clearTimeout(timer);
      window.removeEventListener('focus', onFocus);
      input.removeEventListener('change', onChange);
      input.removeEventListener('cancel', onCancel);
      input.remove();
    };
    const finish = (file: File | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(file);
    };
    const onChange = () => finish(input.files?.[0] ?? null);
    const onCancel = () => finish(null);
    const onFocus = () => { timer = setTimeout(onChange, 300); };
    input.addEventListener('change', onChange);
    input.addEventListener('cancel', onCancel);
    window.addEventListener('focus', onFocus, { once: true });
    document.body.appendChild(input);
    try { input.click(); } catch (error) { cleanup(); reject(error); }
  });
}

/** 项目目录磁盘内容发生增删改时派发的事件名（由 useAutoSave 监听，触发静默保存） */
export const PROJECT_DISK_CHANGED_EVENT = 'project-disk-changed';

/** 通知监听方：当前项目的磁盘内容发生了增删改 */
export function notifyProjectDiskChanged(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(PROJECT_DISK_CHANGED_EVENT));
}

export function getMimeType(ext: string): string {
    const mimeMap: Record<string, string> = {
      txt: 'text/plain',
      md: 'text/markdown',
      csv: 'text/csv',
      json: 'application/json',
      yaml: 'application/yaml',
      yml: 'application/yaml',
      xml: 'application/xml',
      html: 'text/html',
      css: 'text/css',
      png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    bmp: 'image/bmp',
    svg: 'image/svg+xml',
    mp4: 'video/mp4',
    webm: 'video/webm',
    avi: 'video/x-msvideo',
    mov: 'video/quicktime',
    mkv: 'video/x-matroska',
    m4v: 'video/x-m4v',
    flv: 'video/x-flv',
    wmv: 'video/x-ms-wmv',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    ogg: 'audio/ogg',
    flac: 'audio/flac',
    aac: 'audio/aac',
    m4a: 'audio/mp4',
    opus: 'audio/opus',
    wma: 'audio/x-ms-wma',
  };
  return mimeMap[ext] || 'application/octet-stream';
}

/** 逐块产生 Base64；parts 被视为一段连续字节流。 */
function* encodeByteParts(parts: readonly Uint8Array[]): Generator<string> {
  const chunkSize = 3 * 0x2000;
  let carry: number[] = [];

  for (const bytes of parts) {
    let offset = 0;
    if (carry.length > 0) {
      while (carry.length < 3 && offset < bytes.length) {
        carry.push(bytes[offset]);
        offset += 1;
      }
      if (carry.length === 3) {
        yield btoa(String.fromCharCode(...carry));
        carry = [];
      }
    }

    const fullEnd = offset + Math.floor((bytes.length - offset) / 3) * 3;
    while (offset < fullEnd) {
      const chunkEnd = Math.min(offset + chunkSize, fullEnd);
      yield btoa(String.fromCharCode(...bytes.subarray(offset, chunkEnd)));
      offset = chunkEnd;
    }
    while (offset < bytes.length) {
      carry.push(bytes[offset]);
      offset += 1;
    }
  }

  if (carry.length > 0) yield btoa(String.fromCharCode(...carry));
}

function throwIfBase64EncodingAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException('转换已取消', 'AbortError');
  }
}

/**
 * 按 3 字节边界分块编码，避免先构造与整个文件等大的 JS 二进制字符串。
 * parts 会被视为一段连续字节流，跨分块的 1-2 个尾字节会正确拼到下一块。
 */
export function bytePartsToBase64(parts: readonly Uint8Array[]): string {
  return [...encodeByteParts(parts)].join('');
}

/**
 * 可取消的分块 Base64 编码。每约 768 KiB 让出一次事件循环，
 * 避免大媒体转换期间用户取消和超时信号无法被处理。
 */
export async function bytePartsToBase64Async(
  parts: readonly Uint8Array[],
  signal?: AbortSignal,
): Promise<string> {
  throwIfBase64EncodingAborted(signal);
  const encodedParts: string[] = [];
  let chunksSinceYield = 0;
  for (const encoded of encodeByteParts(parts)) {
    encodedParts.push(encoded);
    chunksSinceYield += 1;
    if (chunksSinceYield >= 32) {
      chunksSinceYield = 0;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      throwIfBase64EncodingAborted(signal);
    }
  }
  throwIfBase64EncodingAborted(signal);
  return encodedParts.join('');
}

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  return bytePartsToBase64([new Uint8Array(buffer)]);
}

export type FileWatchEvent = WatchEvent;

/** 通过文件服务边界读取 Tauri 已授权的本地二进制文件。 */
export async function readBinaryFile(filePath: string): Promise<Uint8Array<ArrayBuffer>> {
  return readFile(filePath);
}

const TEXT_PREVIEW_CACHE_MAX = 300;
const textPreviewCache = new Map<string, string>();

/** 同步读取已缓存的文本预览片段（若存在） */
export function getCachedTextPreview(filePath: string, size?: number): string | undefined {
  if (!filePath) return undefined;
  return textPreviewCache.get(`${filePath}:${size ?? 0}`);
}

/** 清理文本预览缓存（测试或重置时使用） */
export function clearTextPreviewCache(): void {
  textPreviewCache.clear();
}

/** 保存文本后刷新等尺寸文件的已挂载缩略内容。 */
export const ASSET_TEXT_UPDATED_EVENT = 'asset-text-updated';
export function invalidateTextPreview(filePath: string): void {
  for (const key of textPreviewCache.keys()) {
    if (key.startsWith(`${filePath}:`)) textPreviewCache.delete(key);
  }
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(ASSET_TEXT_UPDATED_EVENT, { detail: filePath }));
}

function setPreviewCache(key: string, val: string): void {
  if (textPreviewCache.size >= TEXT_PREVIEW_CACHE_MAX) {
    const firstKey = textPreviewCache.keys().next().value;
    if (firstKey) textPreviewCache.delete(firstKey);
  }
  textPreviewCache.set(key, val);
}

/**
 * 读取文本文件的前若干字节（默认 2048 字节）作为预览字符串。
 * 内存缓存避免在瀑布流滚动时频繁读取磁盘。
 */
export async function readTextFilePreview(
  filePath: string,
  size?: number,
  maxBytes = 2048,
): Promise<string> {
  if (!filePath) return '';
  const cacheKey = `${filePath}:${size ?? 0}`;
  const cached = textPreviewCache.get(cacheKey);
  if (cached !== undefined) return cached;

  if (size === 0) {
    setPreviewCache(cacheKey, '');
    return '';
  }

  if (!isTauriEnv()) return '';

  try {
    let bytes: Uint8Array | null = null;
    if (typeof fsOpen === 'function') {
      const file = await fsOpen(filePath, { read: true });
      try {
        const buf = new Uint8Array(maxBytes);
        const n = await file.read(buf);
        if (n && n > 0) {
          bytes = buf.subarray(0, n);
        } else {
          bytes = new Uint8Array(0);
        }
      } finally {
        await file.close();
      }
    }

    // 局部读取失败就停止预览，不能为了几 KB 摘要把整个大文件搬进 WebView。

    if (!bytes || bytes.length === 0) {
      setPreviewCache(cacheKey, '');
      return '';
    }

    const decoder = new TextDecoder('utf-8', { fatal: false });
    const text = decoder.decode(bytes).replace(/\uFFFD+$/, '').replace(/^\uFEFF/, '');
    if (text.includes('\0')) {
      setPreviewCache(cacheKey, '');
      return '';
    }

    setPreviewCache(cacheKey, text);
    return text;
  } catch {
    return '';
  }
}

/** 确保二进制文件存在；已存在时不覆盖。 */
export async function ensureBinaryFile(filePath: string, data: Uint8Array): Promise<void> {
  if (await exists(filePath)) return;

  const parentDir = filePath.replace(/[/\\][^/\\]+$/, '');
  if (parentDir && !(await exists(parentDir))) {
    await mkdir(parentDir, { recursive: true });
  }
  await writeFile(filePath, data);
}

/** 通过文件服务边界监听 Tauri 已授权的文件或目录。 */
export async function watchFilePaths(
  paths: string | string[],
  callback: (event: FileWatchEvent) => void,
  options?: DebouncedWatchOptions,
): Promise<() => void> {
  return watch(paths, callback, options);
}

// ============================================
// Cross-platform utilities
// ============================================

/** Cross-platform path join using forward slashes (Tauri FS accepts both / and \ on all platforms) */
export function joinPath(...segments: string[]): string {
  return segments
    .map((s) => s.replace(/\\/g, '/').replace(/\/+$/, ''))
    .join('/')
    .replace(/\/+/g, '/');
}

/**
 * Convert a file:// URI to a native file-system path.
 * Works correctly on Windows (file:///C:/...) and Unix (file:///home/...).
 */
export function fileUriToPath(uri: string): string {
  try {
    const url = new URL(uri);
    const pathname = decodeURIComponent(url.pathname);
    // Windows: /C:/Users/... → C:/Users/...
    if (/^\/[A-Za-z]:[/\\]/.test(pathname)) {
      return pathname.slice(1);
    }
    return pathname;
  } catch {
    // Fallback: strip the file:// prefix
    const stripped = decodeURIComponent(uri.replace(/^file:\/\/+/, ''));
    // If it looks like a Windows absolute path (e.g. C:/foo), return as-is
    if (/^[A-Za-z]:[/\\]/.test(stripped)) {
      return stripped;
    }
    // Unix absolute path
    return '/' + stripped;
  }
}

/** Characters illegal in filenames. Windows is stricter; Unix only forbids / and \0. */
const IS_WINDOWS = typeof navigator !== 'undefined' && /^win/i.test(navigator.platform || '');
const FILENAME_ILLEGAL_CHARS = IS_WINDOWS ? /[<>:"|?*]/g : /[/]/g;

/** Sanitize a filename for the current platform */
export function sanitizeFileName(name: string): string {
  const clean = name.replace(FILENAME_ILLEGAL_CHARS, '_');
  // 随机后缀取消后，用户标题可能直接成为 Windows 保留设备名。
  return IS_WINDOWS && /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(clean) ? `_${clean}` : clean;
}

/**
 * 去掉 Windows 的 `\\?\` verbatim 前缀。
 * 旧版本的原生命令把 canonicalize 后的路径直接返回给前端，这类路径被存进了节点数据，
 * 会让所有「文件是否在项目目录内」的前缀比较失配（改名不同步文件、分组搬运被跳过、
 * relativePath 写不进去），且全是静默失败。新路径已在 Rust 侧去前缀，这里只修旧数据。
 */
export function stripVerbatimPrefix(path: string): string {
  const match = /^[\\/]{2}\?[\\/](UNC[\\/])?/.exec(path);
  if (!match) return path;
  const rest = path.slice(match[0].length);
  return match[1] ? `\\\\${rest}` : rest;
}

// ============================================
// Project data directory — local file storage for media assets
// ============================================

/** 获取 Tauri 的 convertFileSrc 函数 */
export function getConvertFileSrc(): ((path: string) => string) | null {
  return (isTauriEnv() ? convertFileSrc : null) as ((path: string) => string) | null;
}

/** 获取应用数据根目录（Tauri: appDataDir, 浏览器: null） */
async function getAppDataDir(): Promise<string | null> {
  if (!isTauriEnv()) return null;
  try {
    return await appDataDir();
  } catch {
    return null;
  }
}

/** 获取应用可执行文件所在目录（Tauri: executableDir, 浏览器: null） */
export async function getAppExecutableDir(): Promise<string | null> {
  if (!isTauriEnv()) return null;
  try {
    return await executableDir();
  } catch {
    return null;
  }
}

/** 获取系统默认的文件保存根目录，不受用户自定义目录影响 */
export async function getDefaultBaseDir(): Promise<string | null> {
  const base = await getAppDataDir();
  if (!base) return null;
  return joinPath(base, 'data');
}

/** 用户自定义的文件保存根目录，由 store.config 在加载配置时注入 */
let _baseDataDir: string | null = null;

/** 设置用户自定义的文件保存根目录 */
export function setBaseDataDir(dir: string | undefined): void {
  _baseDataDir = dir && dir.trim() ? dir.trim() : null;
}

/** 获取文件保存根目录（用户自定义或系统默认），不含项目 ID */
export async function getBaseDir(): Promise<string | null> {
  if (_baseDataDir) return _baseDataDir;
  return getDefaultBaseDir();
}

/**
 * projectId → 数据文件夹名（形如「项目名-短ID」）。由 store 在创建/加载项目时注入。
 * 缺失时回退到 projectId 本身，从而兼容历史上以 projectId 命名的旧项目目录。
 */
const _projectFolders = new Map<string, string>();

/** 注册/更新单个项目的数据文件夹名 */
export function registerProjectFolder(projectId: string, folderName: string | undefined): void {
  if (folderName && folderName.trim()) _projectFolders.set(projectId, folderName.trim());
}

/** 批量注册项目数据文件夹名（启动时从项目列表同步） */
export function registerProjectFolders(list: { id: string; dataFolder?: string }[]): void {
  for (const p of list) registerProjectFolder(p.id, p.dataFolder);
}

/** 将项目名清洗为安全的文件夹名片段：去非法字符/控制字符，去首尾点和空白，限长 */
export function sanitizeFolderName(name: string): string {
  const cleaned = Array.from(name || '')
    .filter((ch) => ch.charCodeAt(0) > 31)  // 去除控制字符
    .join('')
    .replace(/[<>:"|?*/\\]/g, '_')          // 跨平台非法字符
    .replace(/^[.\s]+|[.\s]+$/g, '')        // 去掉首尾的点和空白
    .trim();
  return cleaned.slice(0, 80) || 'project';
}

/** 生成稳定且可读的项目数据文件夹名：{清洗后的项目名}-{短ID} */
export function buildProjectFolderName(name: string, projectId: string): string {
  const shortId = projectId.replace(/-/g, '').slice(0, 8) || projectId;
  return `${sanitizeFolderName(name)}-${shortId}`;
}

/** 解析项目实际使用的数据文件夹名（已注册的「项目名-短ID」，或回退到 projectId） */
function resolveProjectFolder(projectId: string): string {
  return _projectFolders.get(projectId) ?? projectId;
}

/** 剧集和分集共用目录时，节点只拥有画布引用，不能随节点删除共享文件。 */
export function isSharedProjectDataDir(projectId: string): boolean {
  const folder = resolveProjectFolder(projectId);
  return [..._projectFolders].some(([id, otherFolder]) => id !== projectId && otherFolder === folder);
}

/** 获取项目的本地数据目录路径 */
export async function getProjectDataDir(projectId: string): Promise<string | null> {
  const folder = resolveProjectFolder(projectId);
  // 优先使用用户自定义的根目录，结构为 {baseDataDir}/{文件夹名}
  if (_baseDataDir) {
    return joinPath(_baseDataDir, folder);
  }
  // 回退到系统应用数据目录
  const base = await getAppDataDir();
  if (!base) return null;
  return joinPath(base, 'data', folder);
}

/** 确保项目数据目录存在（Tauri 端） */
export async function ensureProjectDataDir(
  projectId: string,
  options: { throwOnError?: boolean } = {},
): Promise<string | null> {
  if (!isTauriEnv()) return null;
  const dirPath = await getProjectDataDir(projectId);
  if (!dirPath) return null;
  try {
    const dirExists = await exists(dirPath);
    if (!dirExists) await mkdir(dirPath, { recursive: true });
    return dirPath;
  } catch (err) {
    if (options.throwOnError) throw err;
    console.error('Failed to create project data dir:', dirPath, err);
    return null;
  }
}

/** 为画布分组在项目目录下创建同名子文件夹（已存在则复用） */
export async function ensureGroupFolder(
  projectId: string | null,
  groupName: string,
): Promise<string | null> {
  if (!isTauriEnv() || !projectId) return null;
  const dataDir = await ensureProjectDataDir(projectId);
  if (!dataDir) return null;
  const dirPath = joinPath(dataDir, sanitizeFolderName(groupName));
  try {
    if (!(await exists(dirPath))) {
      await mkdir(dirPath, { recursive: true });
      notifyProjectDiskChanged();
    }
    return dirPath;
  } catch (err) {
    console.warn('[fileService] ensureGroupFolder failed:', dirPath, err);
    return null;
  }
}

/** 分组改名时同步重命名其本地文件夹；目标已存在或改名失败时返回 false */
export async function renameGroupFolder(
  projectId: string | null,
  oldName: string,
  newName: string,
): Promise<boolean> {
  if (!isTauriEnv() || !projectId) return true;
  const dataDir = await getProjectDataDir(projectId);
  if (!dataDir) return true;
  const oldPath = joinPath(dataDir, sanitizeFolderName(oldName));
  const newPath = joinPath(dataDir, sanitizeFolderName(newName));
  if (oldPath === newPath) return true;
  try {
    if (await exists(newPath)) return false;
    // 旧文件夹不存在（如旧项目的分组）时直接建新的
    if (await exists(oldPath)) await rename(oldPath, newPath);
    else await mkdir(newPath, { recursive: true });
    notifyProjectDiskChanged();
    return true;
  } catch (err) {
    console.warn('[fileService] renameGroupFolder failed:', oldPath, '→', newPath, err);
    return false;
  }
}

function isRelocatableProjectPart(part: string): boolean {
  return !!part && !part.startsWith('.') && !/[\\/\0]/.test(part)
    && !/^(?:appdata|agent-private|plugin-private|blender-private|secrets)$/i.test(part);
}

/**
 * 把项目目录内的文件移动到分组文件夹（groupFolder 为 null 表示移回项目根目录）。
 * 入组支持普通嵌套目录；未分组的深层文件保持原目录。外部引用、隐藏/私有目录、
 * 路径穿越、链接及已在目标目录的文件不动，返回 null。
 * preserveSource 用于画布归档的准备阶段，引用提交后再清理旧路径；forceCopy 拆分旧共享文件。
 * @returns 新的绝对路径，未移动或失败时为 null
 */
export async function moveProjectFileToFolder(
  filePath: string | undefined,
  projectDir: string,
  groupFolder: string | null,
  options: { preserveSource?: boolean; forceCopy?: boolean } = {},
): Promise<string | null> {
  if (!isTauriEnv() || !filePath) return null;
  const root = stripVerbatimPrefix(projectDir).replace(/\\/g, '/').replace(/\/+$/, '');
  const normalized = stripVerbatimPrefix(filePath).replace(/\\/g, '/');
  if (!normalized.startsWith(`${root}/`)) return null;
  const segments = normalized.slice(root.length + 1).split('/');
  if (!segments.every(isRelocatableProjectPart)
    || (groupFolder !== null && !isRelocatableProjectPart(groupFolder))
    || (!groupFolder && segments.length > 2)) return null;
  const currentFolder = segments.length > 1 ? segments.slice(0, -1).join('/') : null;
  if (currentFolder === groupFolder && !options.forceCopy) return null;

  const fileName = segments[segments.length - 1];
  const targetDir = groupFolder ? joinPath(root, groupFolder) : root;
  try {
    // 源文件可能已被删除或随文件夹改名搬走，此时不该建目录也不该报错
    if (!(await exists(normalized))) return null;
    let sourceParent = root;
    for (const part of segments.slice(0, -1)) {
      sourceParent += `/${part}`;
      const info = await lstat(sourceParent);
      if (!info.isDirectory || info.isSymlink) return null;
    }
    const sourceInfo = await lstat(normalized);
    if (!sourceInfo.isFile || sourceInfo.isSymlink) return null;
    if (groupFolder && !(await exists(targetDir))) await mkdir(targetDir, { recursive: true });
    if (groupFolder) {
      const info = await lstat(targetDir);
      if (!info.isDirectory || info.isSymlink) return null;
    }
    const destPath = await resolveUniqueDestPath(targetDir, fileName, true);
    if (options.preserveSource || options.forceCopy) await invoke('copy_file_streamed', {
      taskId: crypto.randomUUID(), sourcePath: normalized, destinationPath: destPath,
    });
    else await rename(normalized, destPath);
    return destPath;
  } catch (err) {
    console.warn('[fileService] moveProjectFileToFolder failed:', normalized, '→', targetDir, err);
    return null;
  }
}

/** Finalize a committed relocation. Never recursively delete a folder or remove the destination. */
export async function finishProjectFileRelocation(oldPath: string, newPath: string, projectDir: string): Promise<void> {
  if (!isTauriEnv()) return;
  const root = stripVerbatimPrefix(projectDir).replace(/\\/g, '/').replace(/\/+$/, '');
  const source = stripVerbatimPrefix(oldPath).replace(/\\/g, '/');
  const target = stripVerbatimPrefix(newPath).replace(/\\/g, '/');
  const safe = (path: string) => path.startsWith(`${root}/`)
    && path.slice(root.length + 1).split('/').every(isRelocatableProjectPart);
  if (!safe(source) || !safe(target) || source === target) throw new Error('文件迁移清理范围无效');
  for (const path of [source, target]) {
    const parents = path.slice(root.length + 1).split('/').slice(0, -1);
    let directory = root;
    for (const part of parents) {
      directory += `/${part}`;
      if (path === source && !await exists(directory)) break;
      const info = await lstat(directory);
      if (!info.isDirectory || info.isSymlink) throw new Error('文件迁移目录已变化，停止清理');
    }
  }
  const destination = await lstat(target);
  if (!destination.isFile || destination.isSymlink) throw new Error('目标文件未就绪，保留原文件');
  if (await exists(source)) {
    const original = await lstat(source);
    if (!original.isFile || original.isSymlink || original.size !== destination.size
      || (original.mtime && destination.mtime && original.mtime > destination.mtime)) throw new Error('原文件已变化，停止清理');
    await remove(source);
  }
  const parent = source.slice(0, source.lastIndexOf('/'));
  if (parent !== root && await exists(parent)) {
    const info = await lstat(parent);
    if (info.isDirectory && !info.isSymlink && (await readDir(parent)).length === 0) {
      await remove(parent); // non-recursive: newly added files make this fail safely
    }
  }
  notifyProjectDiskChanged();
}

export async function removeEmptyProjectGroupFolder(projectDir: string, name: string): Promise<void> {
  if (!isTauriEnv()) return;
  const folder = sanitizeFolderName(name);
  if (!folder || folder.startsWith('.') || folder === 'AppData') return;
  const path = joinPath(projectDir, folder);
  if (!await exists(path)) return;
  const info = await lstat(path);
  if (info.isDirectory && !info.isSymlink && (await readDir(path)).length === 0) await remove(path);
}

export interface ProjectDataDirRenameResult {
  oldDir: string;
  newDir: string;
  oldFolder: string;
  dataFolder: string;
  renamed: boolean;
}

/** 将项目数据目录从旧文件夹名重命名为新文件夹名，并更新内存映射。 */
export async function renameProjectDataDir(
  projectId: string,
  oldFolderName: string | undefined,
  newFolderName: string,
): Promise<ProjectDataDirRenameResult | null> {
  if (!isTauriEnv()) {
    registerProjectFolder(projectId, newFolderName);
    return null;
  }

  const oldFolder = oldFolderName?.trim() || resolveProjectFolder(projectId);
  const baseDir = _baseDataDir || await getAppDataDir();
  if (!baseDir) return null;

  const oldDir = _baseDataDir
    ? joinPath(baseDir, oldFolder)
    : joinPath(baseDir, 'data', oldFolder);
  const newDir = _baseDataDir
    ? joinPath(baseDir, newFolderName)
    : joinPath(baseDir, 'data', newFolderName);

  if (!oldDir || !newDir || oldDir === newDir) {
    registerProjectFolder(projectId, newFolderName);
    return oldDir && newDir ? { oldDir, newDir, oldFolder, dataFolder: newFolderName, renamed: false } : null;
  }

  try {
    const oldExists = await exists(oldDir);
    const newExists = await exists(newDir);
    if (oldExists && !newExists) {
      await rename(oldDir, newDir);
      registerProjectFolder(projectId, newFolderName);
      notifyProjectDiskChanged();
      return { oldDir, newDir, oldFolder, dataFolder: newFolderName, renamed: true };
    }

    if (!oldExists) {
      registerProjectFolder(projectId, newFolderName);
      await mkdir(newDir, { recursive: true });
      return { oldDir, newDir, oldFolder, dataFolder: newFolderName, renamed: false };
    }

    console.warn('[fileService] Project data dir rename skipped because target exists:', newDir);
    return null;
  } catch (err) {
    console.warn('[fileService] renameProjectDataDir failed:', oldDir, '→', newDir, err);
    return null;
  }
}

/**
 * 回滚 renameProjectDataDir：把目录改回旧路径，并恢复文件夹名映射。
 * 供重命名事务的后续步骤（路径重映射、落盘）失败时调用，避免磁盘目录、
 * 内存映射与已持久化的 dataFolder 三者不一致导致重启后找不到素材。
 */
export async function revertProjectDataDirRename(
  projectId: string,
  result: ProjectDataDirRenameResult | null,
  fallbackFolderName?: string,
): Promise<void> {
  const restoredFolder = result?.oldFolder?.trim() || fallbackFolderName?.trim();
  if (restoredFolder) _projectFolders.set(projectId, restoredFolder);
  else _projectFolders.delete(projectId);

  if (!result?.renamed || !isTauriEnv()) return;
  try {
    if (await exists(result.newDir) && !(await exists(result.oldDir))) {
      await rename(result.newDir, result.oldDir);
      notifyProjectDiskChanged();
    }
  } catch (err) {
    console.error('[fileService] revertProjectDataDirRename failed:', result.newDir, '→', result.oldDir, err);
  }
}

// 项目输出路径也可能交给稍后才写入的原生处理器；当次会话中不重复分配这些身份。
const allocatedMediaPaths = new Set<string>();

/**
 * 在目标目录中为文件名找到不冲突的完整路径，冲突时在主名后追加 _1、_2 …
 * 项目媒体同时占用会话内已分配的名字与引用迁移旧路径，避免并发写入和旧引用串联。
 * 查重失败必须终止，不能继续写入未经确认的路径。
 */
export async function resolveUniqueDestPath(dataDir: string, fileName: string, reserveIdentity = false): Promise<string> {
  const sanitized = sanitizeFileName(fileName);
  const dotIndex = sanitized.lastIndexOf('.');
  const rawBase = dotIndex > 0 ? sanitized.slice(0, dotIndex) : sanitized;
  const baseName = reserveIdentity ? sanitizeFileName(rawBase.replace(/--[a-f0-9]{32}$/i, '')) || 'file' : rawBase;
  const ext = dotIndex > 0 ? sanitized.slice(dotIndex) : '';
  const retired = reserveIdentity ? await retiredMediaPaths() : new Set<string>();
  // 已带自动序号的文件发生冲突时继续递增，避免生成 _1_1。
  const suffix = /^(.*)_([1-9]\d*)$/.exec(baseName);
  const numbered = suffix && Number.isSafeInteger(Number(suffix[2])) && Number(suffix[2]) < Number.MAX_SAFE_INTEGER ? suffix : null;
  const stem = numbered ? numbered[1] : baseName;
  let counter = numbered ? Number(numbered[2]) + 1 : 1;
  let destPath = joinPath(dataDir, `${baseName}${ext}`);
  while (true) {
    const key = mediaFileAllocationKey(destPath);
    if (!allocatedMediaPaths.has(key) && !retired.has(key) && !await exists(destPath)
      // exists 是异步的；等待期间可能有另一位写入方已经占用这个名字。
      && !allocatedMediaPaths.has(key)) {
      if (!reserveIdentity) return destPath;
      allocatedMediaPaths.add(key);
      try {
        // 文件查重期间分组迁移可能刚提交日志；占位后复核，不能复用刚清空的旧位置。
        if (!(await retiredMediaPaths()).has(key)) return destPath;
      } catch (error) {
        allocatedMediaPaths.delete(key);
        throw error;
      }
      allocatedMediaPaths.delete(key);
    }
    destPath = joinPath(dataDir, `${stem}_${counter}${ext}`);
    counter++;
  }
}

/**
 * 由节点名 + 扩展名构造文件名；节点名为空时回退到 fallback。
 * 扩展名带点（如 ".png"），节点名会被 sanitize 并去掉首尾点/空白。
 */
export function buildNodeFileName(label: string | undefined, ext: string, fallback: string): string {
  const hasLabel = !!(label && label.trim());
  let base = hasLabel ? sanitizeFolderName(label) : sanitizeFolderName(fallback);
  const dottedExt = ext ? (ext.startsWith('.') ? ext : `.${ext}`) : '';
  if (dottedExt && base.toLowerCase().endsWith(dottedExt.toLowerCase())) base = base.slice(0, -dottedExt.length) || 'file';
  return `${base}${dottedExt}`;
}

/**
 * 通过文件路径获取 asset URL（Tauri 端）
 */
export async function getAssetUrlFromPath(filePath: string): Promise<string> {
  const convertFileSrc = await getConvertFileSrc();
  return convertFileSrc ? convertFileSrc(filePath) : filePath;
}

// ============================================
// 文件分类 & 目录列举
// ============================================

export type FileCategory = 'image' | 'video' | 'audio' | 'text' | 'other';

export const CATEGORY_EXTENSIONS: Record<FileCategory, string[]> = {
  image: ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico', '.tiff', '.tif'],
  video: ['.mp4', '.webm', '.mov', '.avi', '.mkv', '.flv', '.wmv', '.m4v'],
  audio: ['.mp3', '.wav', '.ogg', '.aac', '.flac', '.wma', '.m4a', '.opus'],
  text: ['.txt', '.md', '.json', '.csv', '.xml', '.html', '.css', '.js', '.ts', '.jsx', '.tsx', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.log'],
  other: [],
};

export function getFileCategory(fileName: string): FileCategory {
  const ext = `.${fileName.split('.').pop()?.toLowerCase()}`;
  for (const [cat, exts] of Object.entries(CATEGORY_EXTENSIONS)) {
    if (exts.includes(ext)) return cat as FileCategory;
  }
  return 'other';
}

export const CATEGORY_LABELS: Record<FileCategory, string> = {
  image: '图片',
  video: '视频',
  audio: '音频',
  text: '文本',
  other: '其他',
};

export interface AssetFileEntry {
  assetId?: string;                                 // 稳定身份；旧/虚拟条目可能暂缺
  name: string;
  path: string;
  relativePath?: string;                            // 相对 source root 的位置
  assetUrl?: string;
  size: number;
  createdAt?: number;                               // 文件系统创建时间（毫秒）；不支持或未知时缺省
  modifiedAt?: number;                              // 文件系统修改时间（毫秒）；未知时缺省
  category: FileCategory;
  availability?: 'online' | 'offline';
  tags?: string[];                                  // 合并自 assetMeta
  source?: 'project' | 'global' | 'folder';         // 来源：项目永久 / 全局 file / 外部文件夹
  folderRoot?: string;                              // source=folder 时所属的登记文件夹
}

/** 列出目录中的所有文件 */
export async function listDirectoryFiles(dirPath: string): Promise<AssetFileEntry[]> {
  if (!isTauriEnv()) return [];
  try {
    const entries = await readDir(dirPath);
    const files: AssetFileEntry[] = [];

    for (const entry of entries) {
      if (!entry.isFile) continue;
      try {
        const filePath = joinPath(dirPath, entry.name);
        const fileStat = await stat(filePath);
        const convertFileSrc = await getConvertFileSrc();
        const fileSize = fileStat.size ?? 0;
        const createdAt = fileStat.birthtime?.getTime();
        const modifiedAt = fileStat.mtime?.getTime();
        const ext = `.${entry.name.split('.').pop()?.toLowerCase()}`;
        const extLower = ext.toLowerCase();

        // Only generate assetUrl for image types
        let assetUrl: string | undefined;
        if (CATEGORY_EXTENSIONS.image.includes(extLower) && convertFileSrc) {
          assetUrl = convertFileSrc(filePath);
        }

        files.push({
          name: entry.name,
          path: filePath,
          assetUrl,
          size: fileSize,
          createdAt: Number.isFinite(createdAt) ? createdAt : undefined,
          modifiedAt: Number.isFinite(modifiedAt) ? modifiedAt : undefined,
          category: getFileCategory(entry.name),
        });
      } catch {
        // Skip files we can't stat
      }
    }

    // Sort by name
    files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    return files;
  } catch {
    return [];
  }
}

/**
 * fs/core — 文件服务的基础设施层
 * 环境探测、路径/MIME 工具、asset 协议、数据根目录与「项目名-短ID」目录映射、
 * 同名加序号、文件分类与目录列举。被 fs 下其它模块及 fileService 共用。
 */
import { exists, mkdir, rename, stat, readDir } from '@tauri-apps/plugin-fs';
import { convertFileSrc } from '@tauri-apps/api/core';
import { appDataDir, executableDir } from '@tauri-apps/api/path';

/** 检测是否运行在 Tauri 桌面环境中 */
export function isTauriEnv(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
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
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    ogg: 'audio/ogg',
    flac: 'audio/flac',
    aac: 'audio/aac',
  };
  return mimeMap[ext] || 'application/octet-stream';
}

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
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
const IS_WINDOWS = typeof navigator !== 'undefined' && /win/i.test(navigator.platform || '');
const FILENAME_ILLEGAL_CHARS = IS_WINDOWS ? /[<>:"|?*]/g : /[/]/g;

/** Sanitize a filename for the current platform */
export function sanitizeFileName(name: string): string {
  return name.replace(FILENAME_ILLEGAL_CHARS, '_');
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
export async function ensureProjectDataDir(projectId: string): Promise<string | null> {
  if (!isTauriEnv()) return null;
  const dirPath = await getProjectDataDir(projectId);
  if (!dirPath) return null;
  try {
    const dirExists = await exists(dirPath);
    if (!dirExists) await mkdir(dirPath, { recursive: true });
    return dirPath;
  } catch (err) {
    console.error('Failed to create project data dir:', dirPath, err);
    return null;
  }
}

export interface ProjectDataDirRenameResult {
  oldDir: string;
  newDir: string;
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
    return oldDir && newDir ? { oldDir, newDir, dataFolder: newFolderName, renamed: false } : null;
  }

  try {
    const oldExists = await exists(oldDir);
    const newExists = await exists(newDir);
    if (oldExists && !newExists) {
      await rename(oldDir, newDir);
      registerProjectFolder(projectId, newFolderName);
      notifyProjectDiskChanged();
      return { oldDir, newDir, dataFolder: newFolderName, renamed: true };
    }

    if (!oldExists) {
      registerProjectFolder(projectId, newFolderName);
      await mkdir(newDir, { recursive: true });
      return { oldDir, newDir, dataFolder: newFolderName, renamed: false };
    }

    console.warn('[fileService] Project data dir rename skipped because target exists:', newDir);
    return null;
  } catch (err) {
    console.warn('[fileService] renameProjectDataDir failed:', oldDir, '→', newDir, err);
    return null;
  }
}

/**
 * 在目标目录中为文件名找到不冲突的完整路径，冲突时在主名后追加 _1、_2 …
 * （exists 可能抛错，捕获后沿用当前路径）
 */
export async function resolveUniqueDestPath(dataDir: string, fileName: string): Promise<string> {
  const sanitized = sanitizeFileName(fileName);
  const dotIndex = sanitized.lastIndexOf('.');
  const baseName = dotIndex > 0 ? sanitized.slice(0, dotIndex) : sanitized;
  const ext = dotIndex > 0 ? sanitized.slice(dotIndex) : '';
  let destPath = joinPath(dataDir, sanitized);
  try {
    let counter = 1;
    while (await exists(destPath)) {
      destPath = joinPath(dataDir, `${baseName}_${counter}${ext}`);
      counter++;
    }
  } catch {
    // exists 抛错时沿用当前 destPath
  }
  return destPath;
}

/**
 * 由节点名 + 扩展名构造文件名；节点名为空时回退到 fallback。
 * 扩展名带点（如 ".png"），节点名会被 sanitize 并去掉首尾点/空白。
 */
export function buildNodeFileName(label: string | undefined, ext: string, fallback: string): string {
  const hasLabel = !!(label && label.trim());
  const base = hasLabel ? sanitizeFolderName(label) : sanitizeFolderName(fallback);
  const dottedExt = ext ? (ext.startsWith('.') ? ext : `.${ext}`) : '';
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

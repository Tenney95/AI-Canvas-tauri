/**
 * fileService 文件操作服务 — 封装 Tauri 原生文件对话框和读写能力，管理项目/工作流/配置的保存、加载、导出、导入（IndexedDB 降级）
 */
import { writeFile, readFile as tauriReadFile, mkdir, exists, stat, remove, readDir } from '@tauri-apps/plugin-fs';
import { open, save } from '@tauri-apps/plugin-dialog';
import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { appDataDir } from '@tauri-apps/api/path';
import {
  saveProjectToDb,
  getAllProjects,
  getProjectById,
  deleteProjectFromDb,
  saveWorkflowToDb,
  getAllWorkflows,
  deleteWorkflowFromDb,
  saveConfigToDb,
  loadConfigFromDb,
  savePresetToDb,
  getAllPresets,
  deletePresetFromDb,
  type WorkflowRecord,
  type PresetRecord,
} from './indexedDbService';

/** 检测是否运行在 Tauri 桌面环境中 */
function isTauriEnv(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
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

export interface ProjectSaveData {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  nodes: unknown;
  edges: unknown;
  groups?: unknown;
}

/** 保存项目到 IndexedDB */
export async function saveProject(data: ProjectSaveData): Promise<string> {
  try {
    await saveProjectToDb(data);
    console.log('Project saved to IndexedDB:', data.id);
    return data.id;
  } catch (error) {
    console.error('Save project to IndexedDB failed:', error);
    throw error;
  }
}

/** 从 IndexedDB 加载所有项目元数据 */
export async function loadProjectsList(): Promise<ProjectSaveData[]> {
  try {
    return await getAllProjects();
  } catch (error) {
    console.error('Load projects list failed:', error);
    return [];
  }
}

/** 从 IndexedDB 加载单个项目完整数据 */
export async function loadProjectData(id: string): Promise<ProjectSaveData | null> {
  try {
    const record = await getProjectById(id);
    return record ?? null;
  } catch (error) {
    console.error('Load project data failed:', error);
    return null;
  }
}

/** 从 IndexedDB 删除项目 */
export async function deleteProjectData(id: string): Promise<void> {
  try {
    await deleteProjectFromDb(id);
    console.log('Project deleted from IndexedDB:', id);
  } catch (error) {
    console.error('Delete project from IndexedDB failed:', error);
    throw error;
  }
}

// Export canvas as image (screenshot)
export async function exportAsImage(canvasDataUrl: string): Promise<void> {
  try {
    if (isTauriEnv()) {
      const filePath = await save({
        defaultPath: `ai-canvas-export-${Date.now()}.png`,
        filters: [{ name: 'PNG 图片', extensions: ['png'] }],
        title: '导出画布截图',
      });
      if (!filePath) return;

      const response = await fetch(canvasDataUrl);
      const blob = await response.blob();
      const buffer = await blob.arrayBuffer();
      await writeFile(filePath, new Uint8Array(buffer));
      return;
    }

    // 浏览器降级：触发图片下载
    const a = document.createElement('a');
    a.href = canvasDataUrl;
    a.download = `ai-canvas-export-${Date.now()}.png`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  } catch (error) {
    console.error('Export image failed:', error);
    throw error;
  }
}

// Upload file from disk
export async function uploadFile(): Promise<string | null> {
  try {
    if (isTauriEnv()) {
      const filePath = await open({
        multiple: false,
        title: '上传文件',
      });

      if (!filePath) return null;

      const content = await tauriReadFile(filePath);
      const base64 = arrayBufferToBase64(content.buffer);
      const ext = filePath.split('.').pop()?.toLowerCase() || '';
      const mimeType = getMimeType(ext);
      return `data:${mimeType};base64,${base64}`;
    }

    // 浏览器降级：通过 file input 读取
    const file = await browserOpenFile('*/*');
    if (!file) return null;

    const buffer = await file.arrayBuffer();
    const base64 = arrayBufferToBase64(buffer);
    const ext = file.name.split('.').pop()?.toLowerCase() || '';
    const mimeType = getMimeType(ext);

    return `data:${mimeType};base64,${base64}`;
  } catch (error) {
    console.error('Upload failed:', error);
    throw error;
  }
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

/** 读取本地文件路径，返回 data URL（供剪贴板粘贴等场景使用） */
export async function readFileToDataUrl(filePath: string): Promise<string | null> {
  try {
    // Normalize Windows backslash paths
    const normalized = filePath.replace(/\\/g, '/');
    const ext = normalized.split('.').pop()?.toLowerCase() || '';

    if (isTauriEnv()) {
      const content = await tauriReadFile(filePath);
      const base64 = arrayBufferToBase64(content.buffer);
      const mimeType = getMimeType(ext);
      return `data:${mimeType};base64,${base64}`;
    }

    // Browser fallback: try fetch for http(s) URLs, or file:// for local dev
    const resp = await fetch(normalized);
    const blob = await resp.blob();
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  } catch (error) {
    console.error('readFileToDataUrl failed:', filePath, error);
    return null;
  }
}

function getMimeType(ext: string): string {
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

export { getMimeType, arrayBufferToBase64 };

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
    let pathname = decodeURIComponent(url.pathname);
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

/** 项目媒体文件大小上限：2GB，超过则引用原路径不拷贝到项目目录（仅 Tauri 下生效） */
export const MAX_MEDIA_FILE_SIZE = 2 * 1024 * 1024 * 1024;

/** 获取 Tauri 的 convertFileSrc 函数 */
function getConvertFileSrc(): ((path: string) => string) | null {
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

/** 用户自定义的文件保存根目录，由 store.config 在加载配置时注入 */
let _baseDataDir: string | null = null;

/** 设置用户自定义的文件保存根目录 */
export function setBaseDataDir(dir: string | undefined): void {
  _baseDataDir = dir && dir.trim() ? dir.trim() : null;
}

/** 获取文件保存根目录（用户自定义或系统默认），不含项目 ID */
export async function getBaseDir(): Promise<string | null> {
  if (_baseDataDir) return _baseDataDir;
  const base = await getAppDataDir();
  if (!base) return null;
  return joinPath(base, 'data');
}

/** 获取项目的本地数据目录路径 */
export async function getProjectDataDir(projectId: string): Promise<string | null> {
  // 优先使用用户自定义的根目录，结构为 {baseDataDir}/{projectId}
  if (_baseDataDir) {
    return joinPath(_baseDataDir, projectId);
  }
  // 回退到系统应用数据目录
  const base = await getAppDataDir();
  if (!base) return null;
  return joinPath(base, 'data', projectId);
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

/**
 * 将文件拷贝到项目数据目录，返回本地路径和 asset URL
 * 如文件已存在于目标目录则跳过拷贝
 */
export async function copyFileToProjectData(
  sourcePath: string,
  projectId: string,
): Promise<{ filePath: string; assetUrl: string; fileName: string } | null> {
  if (!isTauriEnv()) return null;

  const dataDir = await ensureProjectDataDir(projectId);
  if (!dataDir) return null;

  const fileName = sourcePath.split(/[/\\]/).pop() || 'file';
  const sanitized = sanitizeFileName(fileName);

  // Base destination path
  let destPath = joinPath(dataDir, sanitized);

  // Handle name conflicts: append _1, _2 ...
  try {
    let counter = 1;
    const parts = sanitized.split('.');
    const ext = parts.length > 1 ? parts.pop()! : '';
    const baseName = parts.join('.');
    while (await exists(destPath)) {
      destPath = ext ? joinPath(dataDir, `${baseName}_${counter}.${ext}`) : joinPath(dataDir, `${sanitized}_${counter}`);
      counter++;
    }
  } catch {
    // exists may throw; proceed with current destPath
  }

  try {
    // Try to check source file size (may fail for paths outside fs scope, e.g., external drives)
    let sourceSize = 0;
    try {
      const sourceStat = await stat(sourcePath);
      sourceSize = sourceStat.size;
    } catch {
      // stat not allowed for this path — skip size check and proceed with read+write
    }

    if (sourceSize > MAX_MEDIA_FILE_SIZE) {
      console.warn('File too large for project data copy:', sourcePath, sourceSize);
      // For oversized files, use convertFileSrc on the original path instead
      const convertFileSrc = await getConvertFileSrc();
      if (!convertFileSrc) return null;
      return { filePath: sourcePath, assetUrl: convertFileSrc(sourcePath), fileName };
    }

    // Use readFile + writeFile instead of copyFile to avoid fs scope issues
    // readFile on drag-dropped paths bypasses fs scope permission check
    const content = await tauriReadFile(sourcePath);
    await writeFile(destPath, new Uint8Array(content));
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
    const match = dataUrl.match(/^data:(.+?);base64,(.+)$/);
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

    const destPath = joinPath(dataDir, fileName);
    await writeFile(destPath, bytes);

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

  const sanitized = sanitizeFileName(fileName);

  // Handle name conflicts
  let destPath = joinPath(dataDir, sanitized);
  try {
    let counter = 1;
    const parts = sanitized.split('.');
    const ext = parts.length > 1 ? parts.pop()! : '';
    const baseName = parts.join('.');
    while (await exists(destPath)) {
      destPath = ext ? joinPath(dataDir, `${baseName}_${counter}.${ext}`) : joinPath(dataDir, `${sanitized}_${counter}`);
      counter++;
    }
  } catch {
    // exists may throw; proceed with current destPath
  }

  try {
    await writeFile(destPath, data);
  } catch (err) {
    console.error('Failed to save binary to project data:', destPath, err);
    return null;
  }

  const convertFileSrc = await getConvertFileSrc();
  const assetUrl = convertFileSrc ? convertFileSrc(destPath) : '';

  return { filePath: destPath, assetUrl };
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

/**
 * 下载远程 URL 文件并保存到项目数据目录
 * @returns { filePath, assetUrl } 或 null（失败/非 Tauri）
 */
export async function downloadUrlAndSave(
  url: string,
  projectId: string,
  fallbackPrefix: string,
): Promise<{ filePath: string; assetUrl: string } | null> {
  if (!isTauriEnv()) return null;
  try {
    // 通过 Rust 原生 HTTP 下载（绕过 WebView CORS 限制），返回 base64 data URL
    const dataUrl: string = await invoke('fetch_image_data_url', { url });

    // 解析 data URL 还原为二进制
    const match = dataUrl.match(/^data:(.+?);base64,(.+)$/);
    if (!match) return null;
    const b64 = match[2];
    const binaryStr = atob(b64);
    const data = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) {
      data[i] = binaryStr.charCodeAt(i);
    }

    const fileName = extractFileNameFromUrl(url, fallbackPrefix);
    return await saveBinaryToProjectData(data, projectId, fileName);
  } catch (err) {
    console.warn('[fileService] downloadUrlAndSave failed:', url, err);
    return null;
  }
}

/**
 * 通过文件路径获取 asset URL（Tauri 端）
 */
export async function getAssetUrlFromPath(filePath: string): Promise<string> {
  const convertFileSrc = await getConvertFileSrc();
  return convertFileSrc ? convertFileSrc(filePath) : filePath;
}

// ============================================
// File & directory deletion
// ============================================

/** 将文件或目录移动到系统回收站（Tauri 端），浏览器环境无操作 */
export async function moveToTrash(filePath: string): Promise<void> {
  if (!isTauriEnv()) return;
  try {
    await invoke('move_to_trash', { path: filePath });
    console.log('[fileService] Moved to trash:', filePath);
  } catch (err) {
    console.warn('[fileService] Failed to move to trash:', filePath, err);
  }
}

// ============================================
// Undo-trash staging (project-level .trash/ dir — restored on undo, flushed to system trash on project delete)
// ============================================

/** Map: originalFilePath → trashFilePath */
const undoTrashMap = new Map<string, string>();

/** Compute the .trash directory for a given file path (same parent dir) */
function getUndoTrashDir(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const lastSep = normalized.lastIndexOf('/');
  return lastSep >= 0 ? joinPath(normalized.substring(0, lastSep), '.trash') : '.trash';
}

/** Move a file to the project-level .trash staging directory (for undo support) */
export async function moveToUndoTrash(filePath: string): Promise<void> {
  if (!isTauriEnv()) return;
  try {
    const existsFile = await exists(filePath);
    if (!existsFile) return;
    const trashDir = getUndoTrashDir(filePath);
    await mkdir(trashDir, { recursive: true });
    const fileName = filePath.split(/[/\\]/).pop() || 'file';
    const trashPath = joinPath(trashDir, `${Date.now()}-${fileName}`);
    // copy + delete (rename may fail across filesystems)
    const content = await tauriReadFile(filePath);
    await writeFile(trashPath, new Uint8Array(content));
    await remove(filePath);
    undoTrashMap.set(filePath, trashPath);
    console.log('[fileService] Staged in undo-trash:', filePath, '→', trashPath);
  } catch (err) {
    console.warn('[fileService] Failed to stage in undo-trash:', filePath, err);
    // Fallback: use system trash
    await moveToTrash(filePath).catch(() => {});
  }
}

/** Restore a file from undo-trash staging. Returns true on success. */
export async function restoreFromUndoTrash(filePath: string): Promise<boolean> {
  if (!isTauriEnv()) return false;
  const trashPath = undoTrashMap.get(filePath);
  if (!trashPath) return false;
  try {
    const trashExists = await exists(trashPath);
    if (!trashExists) { undoTrashMap.delete(filePath); return false; }
    const content = await tauriReadFile(trashPath);
    await writeFile(filePath, new Uint8Array(content));
    await remove(trashPath);
    undoTrashMap.delete(filePath);
    console.log('[fileService] Restored from undo-trash:', filePath);
    return true;
  } catch (err) {
    console.warn('[fileService] Failed to restore from undo-trash:', filePath, err);
    return false;
  }
}

/** Flush all undo-trash files to system recycle bin (called on project delete) */
export async function flushUndoTrashDirs(): Promise<void> {
  if (!isTauriEnv()) return;
  // Collect unique .trash directories
  const trashDirs = new Set<string>();
  for (const [origPath] of undoTrashMap) {
    trashDirs.add(getUndoTrashDir(origPath));
  }
  for (const dir of trashDirs) {
    try {
      if (await exists(dir)) {
        await invoke('move_to_trash', { path: dir });
        console.log('[fileService] Flushed undo-trash dir to system trash:', dir);
      }
    } catch (err) {
      console.warn('[fileService] Failed to flush undo-trash dir:', dir, err);
    }
  }
  undoTrashMap.clear();
}

/** 删除单个文件（Tauri 端），浏览器环境无操作 */
export async function deleteFile(filePath: string): Promise<void> {
  if (!isTauriEnv()) return;
  try {
    await remove(filePath);
    console.log('[fileService] Deleted file:', filePath);
  } catch (err) {
    console.warn('[fileService] Failed to delete file:', filePath, err);
  }
}

/** 将目录移至回收站（Tauri 端），trash crate 本身支持直接移动整个目录 */
async function removeDirRecursive(dirPath: string): Promise<void> {
  if (!isTauriEnv()) return;
  try {
    await invoke('move_to_trash', { path: dirPath });
    console.log('[fileService] Moved dir to trash:', dirPath);
  } catch (err) {
    console.warn('[fileService] Failed to move dir to trash:', dirPath, err);
  }
}

/** 删除项目的本地数据目录（Tauri 端），包括所有媒体文件 */
export async function deleteProjectDataDir(projectId: string): Promise<void> {
  if (!isTauriEnv()) return;
  const dirPath = await getProjectDataDir(projectId);
  if (!dirPath) return;
  try {
    await removeDirRecursive(dirPath);
    console.log('[fileService] Deleted project data dir:', dirPath);
  } catch (err) {
    console.warn('[fileService] Failed to delete project data dir:', dirPath, err);
  }
}

/** 尝试删除节点关联的本地文件（如果有 filePath，移入 undo-trash 暂存，撤销时可还原） */
export async function deleteNodeFile(nodeData: { filePath?: string }): Promise<void> {
  const fp = nodeData.filePath;
  if (fp && typeof fp === 'string') {
    await moveToUndoTrash(fp);
  }
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
      const content = await tauriReadFile(filePath);
      const base64 = arrayBufferToBase64(content.buffer);
      const ext = fileName.split('.').pop()?.toLowerCase() || '';
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

// ============================================
// Workflow CRUD
// ============================================

export async function saveWorkflow(record: WorkflowRecord): Promise<void> {
  try {
    await saveWorkflowToDb(record);
    console.log('Workflow saved to IndexedDB:', record.id);
  } catch (error) {
    console.error('Save workflow failed:', error);
    throw error;
  }
}

// ============================================
// Asset file management — 项目文件 & 永久保存
// ============================================

export type FileCategory = 'image' | 'video' | 'audio' | 'text' | 'other';

const CATEGORY_EXTENSIONS: Record<FileCategory, string[]> = {
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
  name: string;
  path: string;
  assetUrl?: string;
  size: number;
  category: FileCategory;
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

/** 获取项目文件列表 */
export async function listProjectFiles(projectId: string): Promise<AssetFileEntry[]> {
  const projectDir = await getProjectDataDir(projectId);
  if (!projectDir) return [];
  const allFiles = await listDirectoryFiles(projectDir);
  // Filter out files inside AppData subdirectory
  return allFiles.filter((f) => {
    const relative = f.path.substring(projectDir.length).replace(/\\/g, '/');
    return !relative.startsWith('/AppData/') && !relative.startsWith('AppData/');
  });
}


/* ============================================
   全局资产库（项目无关）+ 外部文件夹
   ============================================ */

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

/** 列出全局 file 目录（顶层）*/
export async function listGlobalFiles(): Promise<AssetFileEntry[]> {
  const dir = await getGlobalFilesDir();
  if (!dir) return [];
  if (!(await exists(dir).catch(() => false))) return [];
  const files = await listDirectoryFiles(dir);
  return files.map((f) => ({ ...f, source: 'global' as const }));
}

/**
 * 递归遍历目录收集文件（带数量/深度上限，避免超大目录卡死）。
 * 每个目录内的 stat 并行，整体用栈迭代而非深递归。
 */
export async function walkDirectoryFiles(
  rootDir: string,
  opts: { maxFiles?: number; maxDepth?: number } = {},
): Promise<AssetFileEntry[]> {
  if (!isTauriEnv()) return [];
  const maxFiles = opts.maxFiles ?? 3000;
  const maxDepth = opts.maxDepth ?? 8;
  const convertFileSrc = await getConvertFileSrc();
  const out: AssetFileEntry[] = [];
  const stack: { dir: string; depth: number }[] = [{ dir: rootDir, depth: 0 }];

  while (stack.length > 0 && out.length < maxFiles) {
    const { dir, depth } = stack.pop()!;
    let entries: Awaited<ReturnType<typeof readDir>>;
    try {
      entries = await readDir(dir);
    } catch {
      continue;
    }
    const fileEntries = entries.filter((e) => e.isFile);
    const subDirs = entries.filter((e) => e.isDirectory);

    const statResults = await Promise.all(
      fileEntries.map(async (e) => {
        const filePath = joinPath(dir, e.name);
        try {
          const s = await stat(filePath);
          return { name: e.name, filePath, size: s.size ?? 0 };
        } catch {
          return null;
        }
      }),
    );

    for (const r of statResults) {
      if (!r) continue;
      if (out.length >= maxFiles) break;
      const ext = `.${r.name.split('.').pop()?.toLowerCase()}`;
      let assetUrl: string | undefined;
      if (CATEGORY_EXTENSIONS.image.includes(ext) && convertFileSrc) {
        assetUrl = convertFileSrc(r.filePath);
      }
      out.push({
        name: r.name,
        path: r.filePath,
        assetUrl,
        size: r.size,
        category: getFileCategory(r.name),
      });
    }

    if (depth < maxDepth) {
      for (const d of subDirs) stack.push({ dir: joinPath(dir, d.name), depth: depth + 1 });
    }
  }
  return out;
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

/** 选择本地文件（可多选）拷贝到全局 file 目录，返回拷贝数量 */
export async function addAssetFilesToGlobal(): Promise<number> {
  if (!isTauriEnv()) return 0;
  const selected = await open({ multiple: true, title: '添加文件到资产库' });
  if (!selected) return 0;
  const paths = Array.isArray(selected) ? selected : [selected];
  const destDir = await ensureGlobalFilesDir();
  if (!destDir) return 0;

  let count = 0;
  for (const src of paths) {
    try {
      const fileName = src.split(/[\\/]/).pop() || 'file';
      let destPath = joinPath(destDir, fileName);
      if (await exists(destPath)) {
        let counter = 1;
        const dotIndex = fileName.lastIndexOf('.');
        const baseName = dotIndex > 0 ? fileName.substring(0, dotIndex) : fileName;
        const ext = dotIndex > 0 ? fileName.substring(dotIndex) : '';
        do {
          destPath = joinPath(destDir, `${baseName}_${counter}${ext}`);
          counter++;
        } while (await exists(destPath));
      }
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

/**
 * 从单个文件路径构建 AssetFileEntry（用于节点 filePath 引用）
 * 尝试 stat 获取文件大小，失败则返回 null
 */
export async function getFileEntryFromPath(filePath: string): Promise<AssetFileEntry | null> {
  if (!isTauriEnv()) return null;
  try {
    const fileStat = await stat(filePath);
    if (fileStat.size === undefined) return null;
    const fileName = filePath.split(/[\\/]/).pop() || 'file';
    const ext = `.${fileName.split('.').pop()?.toLowerCase()}`;
    const extLower = ext.toLowerCase();
    const convertFileSrc = await getConvertFileSrc();

    let assetUrl: string | undefined;
    if (CATEGORY_EXTENSIONS.image.includes(extLower) && convertFileSrc) {
      assetUrl = convertFileSrc(filePath);
    }

    return {
      name: fileName,
      path: filePath,
      assetUrl,
      size: fileStat.size,
      category: getFileCategory(fileName),
    };
  } catch {
    return null;
  }
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
    name,
    path: entryPath,
    assetUrl: assetUrl || undefined,
    size: 0,
    category,
  };
}

/** 将文件拷贝到全局永久目录 {baseDataDir}/file */
export async function saveToPermanent(filePath: string): Promise<string | null> {
  if (!isTauriEnv()) return null;
  const destDir = await ensureGlobalFilesDir();
  if (!destDir) return null;

  try {
    const fileName = filePath.split(/[\\/]/).pop() || 'file';
    let destPath = joinPath(destDir, fileName);
    // Avoid overwrite
    if (await exists(destPath)) {
      let counter = 1;
      const dotIndex = fileName.lastIndexOf('.');
      const baseName = dotIndex > 0 ? fileName.substring(0, dotIndex) : fileName;
      const ext = dotIndex > 0 ? fileName.substring(dotIndex) : '';
      do {
        destPath = joinPath(destDir, `${baseName}_${counter}${ext}`);
        counter++;
      } while (await exists(destPath));
    }

    // Copy file
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
      let destPath = joinPath(destDir, entry.name);
      if (await exists(destPath)) {
        let counter = 1;
        const dotIndex = entry.name.lastIndexOf('.');
        const baseName = dotIndex > 0 ? entry.name.substring(0, dotIndex) : entry.name;
        const ext = dotIndex > 0 ? entry.name.substring(dotIndex) : '';
        do {
          destPath = joinPath(destDir, `${baseName}_${counter}${ext}`);
          counter++;
        } while (await exists(destPath));
      }

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

/** 删除永久保存的文件（移入回收站） */
export async function deletePermanentFile(filePath: string): Promise<void> {
  await moveToTrash(filePath);
}

export async function loadWorkflows(): Promise<WorkflowRecord[]> {
  try {
    return await getAllWorkflows();
  } catch (error) {
    console.error('Load workflows failed:', error);
    return [];
  }
}

export async function deleteWorkflow(id: string): Promise<void> {
  try {
    await deleteWorkflowFromDb(id);
    console.log('Workflow deleted from IndexedDB:', id);
  } catch (error) {
    console.error('Delete workflow failed:', error);
    throw error;
  }
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

// ============================================
// Config persistence
// ============================================

/** 保存应用配置到 IndexedDB */
export async function saveConfig(data: unknown): Promise<void> {
  try {
    await saveConfigToDb(data);
    console.log('Config saved to IndexedDB');
  } catch (error) {
    console.error('Save config failed:', error);
    throw error;
  }
}

/** 从 IndexedDB 加载应用配置 */
export async function loadConfig(): Promise<unknown | null> {
  try {
    return await loadConfigFromDb();
  } catch (error) {
    console.error('Load config failed:', error);
    return null;
  }
}

// ============================================
// Presets CRUD
// ============================================

export async function savePreset(record: PresetRecord): Promise<void> {
  try {
    await savePresetToDb(record);
    console.log('Preset saved to IndexedDB:', record.id);
  } catch (error) {
    console.error('Save preset failed:', error);
    throw error;
  }
}

export async function loadPresets(): Promise<PresetRecord[]> {
  try {
    return await getAllPresets();
  } catch (error) {
    console.error('Load presets failed:', error);
    return [];
  }
}

export async function deletePreset(id: string): Promise<void> {
  try {
    await deletePresetFromDb(id);
    console.log('Preset deleted from IndexedDB:', id);
  } catch (error) {
    console.error('Delete preset failed:', error);
    throw error;
  }
}

// ============================================
// 系统文件管理器 — 打开文件所在位置
// ============================================

/**
 * 在系统文件管理器中显示文件位置
 * - Windows：资源管理器并高亮选中文件
 * - macOS：Finder 中显示文件
 * - Linux：打开文件所在文件夹
 */
export async function revealFileInFolder(filePath: string): Promise<void> {
  if (!isTauriEnv()) {
    console.warn('[fileService] revealFileInFolder: 仅 Tauri 桌面环境支持');
    return;
  }

  try {
    const { Command } = await import('@tauri-apps/plugin-shell');

    // 检测操作系统
    const plat = (navigator.platform || '').toLowerCase();
    const isWin = plat.includes('win');
    const isMac = plat.includes('mac');

    if (isWin) {
      // Windows: explorer /select, "path" — 必须用反斜杠
      const winPath = filePath.replace(/\//g, '\\');
      const cmd = Command.create('explorer', ['/select,', winPath]);
      await cmd.execute();
    } else if (isMac) {
      // macOS: open -R "path" (Reveal in Finder)
      // 注意：'mac-open' 是 capabilities 中的 name，会映射到 cmd: 'open'
      const cmd = Command.create('mac-open', ['-R', filePath]);
      await cmd.execute();
    } else {
      // Linux: xdg-open <dir>
      const sep = filePath.includes('\\') ? '\\' : '/';
      const dirPath = filePath.substring(0, filePath.lastIndexOf(sep));
      const cmd = Command.create('xdg-open', [dirPath]);
      await cmd.execute();
    }
  } catch (err) {
    console.error('[fileService] revealFileInFolder 失败:', filePath, err);
    throw err;
  }
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
      const data = await tauriReadFile(filePath);
      await writeFile(destPath, data);
      return destPath;
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

    // 3. asset:// URL — try fetch via convertFileSrc
    if (mediaUrl && mediaUrl.startsWith('asset://')) {
      const src = convertFileSrc(mediaUrl);
      const resp = await fetch(src);
      const buffer = await resp.arrayBuffer();
      await writeFile(destPath, new Uint8Array(buffer));
      return destPath;
    }

    // 4. HTTP media URL — fetch and save
    if (mediaUrl && (mediaUrl.startsWith('http://') || mediaUrl.startsWith('https://'))) {
      const resp = await fetch(mediaUrl);
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

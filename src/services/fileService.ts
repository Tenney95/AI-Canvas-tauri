/**
 * fileService 文件操作服务 — 封装 Tauri 原生文件对话框和读写能力，管理项目/工作流/配置的保存、加载、导出、导入（IndexedDB 降级）
 */
import { writeFile, readFile as tauriReadFile, mkdir, exists, stat, remove, readDir, type DirEntry } from '@tauri-apps/plugin-fs';
import { open, save } from '@tauri-apps/plugin-dialog';
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

/** 获取 Tauri 的 convertFileSrc 函数（浏览器端返回 null） */
let _convertFileSrc: ((path: string) => string) | null = null;
async function getConvertFileSrc(): Promise<((path: string) => string) | null> {
  if (_convertFileSrc !== null) return _convertFileSrc;
  if (!isTauriEnv()) return null;
  try {
    const core = await import('@tauri-apps/api/core');
    _convertFileSrc = (core as { convertFileSrc?: (path: string) => string }).convertFileSrc || null;
  } catch {
    _convertFileSrc = null;
  }
  return _convertFileSrc;
}

/** 获取应用数据根目录（Tauri: appDataDir, 浏览器: null） */
async function getAppDataDir(): Promise<string | null> {
  if (!isTauriEnv()) return null;
  try {
    const { appDataDir } = await import('@tauri-apps/api/path');
    return await appDataDir();
  } catch {
    return null;
  }
}

/** 获取项目的本地数据目录路径 */
export async function getProjectDataDir(projectId: string): Promise<string | null> {
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

/** 递归删除目录及其所有内容 */
async function removeDirRecursive(dirPath: string): Promise<void> {
  let entries: DirEntry[];
  try {
    entries = await readDir(dirPath);
  } catch {
    // Directory doesn't exist or can't be read
    return;
  }
  for (const entry of entries) {
    const fullPath = joinPath(dirPath, entry.name);
    if (entry.isDirectory) {
      await removeDirRecursive(fullPath);
    } else {
      try { await remove(fullPath); } catch { /* 忽略单个文件删除失败 */ }
    }
  }
  try {
    await remove(dirPath);
  } catch { /* 忽略目录删除失败 */ }
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

/** 尝试删除节点关联的本地文件（如果存在 filePath） */
export async function deleteNodeFile(nodeData: { filePath?: string }): Promise<void> {
  const fp = nodeData.filePath;
  if (fp && typeof fp === 'string') {
    await deleteFile(fp);
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
      const filePath = await open({
        multiple: false,
        title: '选择文件',
        filters: accept ? [{ name: '支持的文件', extensions: accept.split(',').map((e) => e.trim().replace('.', '')) }] : [],
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

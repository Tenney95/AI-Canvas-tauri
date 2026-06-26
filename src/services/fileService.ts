/**
 * fileService 文件操作服务 — 项目媒体文件的拷贝/保存/下载/重命名、源文件上传、
 * 节点输出另存为、系统文件管理器定位。基础设施见 ./fs/core，删除域见 ./fs/trash，
 * 全局资产库见 ./fs/assetLibrary（均通过本模块统一对外导出）。
 */
import { writeFile, readFile as tauriReadFile, stat, rename, readDir, exists, mkdir } from '@tauri-apps/plugin-fs';
import { open, save } from '@tauri-apps/plugin-dialog';
import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { appDataDir } from '@tauri-apps/api/path';
import {
  isTauriEnv,
  getMimeType,
  arrayBufferToBase64,
  sanitizeFileName,
  sanitizeFolderName,
  joinPath,
  getConvertFileSrc,
  ensureProjectDataDir,
  getProjectDataDir,
  resolveUniqueDestPath,
  buildNodeFileName,
  notifyProjectDiskChanged,
  listDirectoryFiles,
  getFileCategory,
  CATEGORY_EXTENSIONS,
  MAX_MEDIA_FILE_SIZE,
  type AssetFileEntry,
} from './fs/core';

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
export * from './fs/trash';
export * from './fs/assetLibrary';

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
): Promise<{ filePath: string; assetUrl: string; fileName: string } | null> {
  if (!isTauriEnv()) return null;

  const dataDir = await ensureProjectDataDir(projectId);
  if (!dataDir) return null;

  const fileName = sourcePath.split(/[/\\]/).pop() || 'file';
  const destPath = await resolveUniqueDestPath(dataDir, fileName);

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
): Promise<{ filePath: string; assetUrl: string } | null> {
  if (!isTauriEnv()) return null;
  try {
    // 通过 Rust 原生 HTTP 下载（绕过 WebView CORS 限制），返回 base64 data URL
    const dataUrl: string = await invoke('fetch_image_data_url', { url });

    // 解析 data URL 还原为二进制
    const match = dataUrl.match(/^data:(.+?);base64,(.+)$/);
    if (!match) return null;
    const mime = match[1];
    const b64 = match[2];
    const binaryStr = atob(b64);
    const data = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) {
      data[i] = binaryStr.charCodeAt(i);
    }

    // 优先用节点名命名；否则沿用从 URL 提取文件名的旧逻辑
    const fileName = baseName && baseName.trim()
      ? buildNodeFileName(baseName, guessExtension(url, mime, fallbackPrefix), fallbackPrefix)
      : extractFileNameFromUrl(url, fallbackPrefix);
    return await saveBinaryToProjectData(data, projectId, fileName);
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

  const normPath = filePath.replace(/\\/g, '/');
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
    const destPath = await resolveUniqueDestPath(projectDir, newName);
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
  const allFiles = await listDirectoryFiles(projectDir);
  // Filter out files inside AppData subdirectory
  return allFiles.filter((f) => {
    const relative = f.path.substring(projectDir.length).replace(/\\/g, '/');
    return !relative.startsWith('/AppData/') && !relative.startsWith('AppData/');
  });
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

export interface UploadedSkillFile {
  fileName: string;
  content: string;
  sourceType: 'file' | 'folder';
  storagePath?: string;
  entryFileName?: string;
}

export type SkillUploadSource = 'file' | 'folder';

function decodeUtf8Text(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('Skill 文件必须是 UTF-8 文本');
  }
}

const SKILL_TEXT_EXTENSIONS = new Set(['md', 'txt', 'json']);

function isSkillTextFile(fileName: string): boolean {
  const ext = fileName.split('.').pop()?.toLowerCase() || '';
  return SKILL_TEXT_EXTENSIONS.has(ext);
}

async function ensureSkillRootDir(): Promise<string> {
  const dir = joinPath(await appDataDir(), 'skill');
  if (!(await exists(dir))) await mkdir(dir, { recursive: true });
  return dir;
}

async function collectSkillFiles(dirPath: string, baseDir = dirPath): Promise<{ path: string; relativePath: string; name: string }[]> {
  const entries = await readDir(dirPath);
  const files: { path: string; relativePath: string; name: string }[] = [];

  for (const entry of entries) {
    const entryPath = joinPath(dirPath, entry.name);
    if (entry.isDirectory) {
      files.push(...await collectSkillFiles(entryPath, baseDir));
      continue;
    }
    if (!entry.isFile || !isSkillTextFile(entry.name)) continue;
    const normalizedBase = baseDir.replace(/\\/g, '/').replace(/\/+$/, '');
    const normalizedPath = entryPath.replace(/\\/g, '/');
    files.push({
      path: entryPath,
      relativePath: normalizedPath.startsWith(`${normalizedBase}/`)
        ? normalizedPath.slice(normalizedBase.length + 1)
        : entry.name,
      name: entry.name,
    });
  }

  return files.sort((a, b) => a.relativePath.localeCompare(b.relativePath, undefined, { numeric: true }));
}

function pickSkillEntry(files: { relativePath: string; name: string }[]): { relativePath: string; name: string } | null {
  return files.find((f) => f.name.toLowerCase() === 'skill.md')
    ?? files.find((f) => f.relativePath.toLowerCase().endsWith('/skill.md'))
    ?? files.find((f) => f.name.toLowerCase().endsWith('.md'))
    ?? files[0]
    ?? null;
}

async function uploadSkillFolder(): Promise<UploadedSkillFile | null> {
  const selected = await open({
    directory: true,
    multiple: false,
    title: '上传 Skill 文件夹',
  });
  if (!selected || Array.isArray(selected)) return null;

  const folderName = selected.split(/[\\/]/).filter(Boolean).pop() || 'skill';
  const files = await collectSkillFiles(selected);
  if (files.length === 0) {
    throw new Error('Skill 文件夹中没有可用的 .md / .txt / .json 文件');
  }

  const entry = pickSkillEntry(files);
  if (!entry) throw new Error('Skill 文件夹中没有可调用入口文件');

  const rootDir = await ensureSkillRootDir();
  const destDir = await resolveUniqueDestPath(rootDir, sanitizeFolderName(folderName));
  await mkdir(destDir, { recursive: true });

  let entryContent = '';
  for (const file of files) {
    const bytes = await tauriReadFile(file.path);
    const text = decodeUtf8Text(bytes);
    if (file.relativePath === entry.relativePath) entryContent = text;

    const relativeParts = file.relativePath.split(/[\\/]/).map((part) => sanitizeFileName(part));
    const destPath = joinPath(destDir, ...relativeParts);
    const parentDir = destPath.slice(0, destPath.lastIndexOf('/'));
    if (parentDir && !(await exists(parentDir))) await mkdir(parentDir, { recursive: true });
    await writeFile(destPath, bytes);
  }

  return {
    fileName: folderName,
    content: entryContent,
    sourceType: 'folder',
    storagePath: destDir,
    entryFileName: entry.relativePath,
  };
}

async function uploadSingleSkillFile(): Promise<UploadedSkillFile | null> {
  const filePath = await open({
    multiple: false,
    title: '上传 Skill 文件',
    filters: [{ name: 'Skill 文本文件', extensions: ['md', 'txt', 'json'] }],
  });
  if (!filePath || Array.isArray(filePath)) return null;

  const fileName = filePath.split(/[\\/]/).pop() || 'skill.txt';
  if (!isSkillTextFile(fileName)) {
    throw new Error('Skill 文件只支持 .md / .txt / .json');
  }

  const bytes = await tauriReadFile(filePath);
  const content = decodeUtf8Text(bytes);
  const rootDir = await ensureSkillRootDir();
  const destPath = await resolveUniqueDestPath(rootDir, fileName);
  await writeFile(destPath, bytes);

  return {
    fileName,
    content,
    sourceType: 'file',
    storagePath: destPath,
    entryFileName: fileName,
  };
}

/** 上传只读 Skill 文件或文件夹，读取为 UTF-8 文本内容 */
export async function uploadSkillFile(source: SkillUploadSource = 'folder'): Promise<UploadedSkillFile | null> {
  const accept = '.md,.txt,.json';
  try {
    if (isTauriEnv()) {
      return source === 'file'
        ? await uploadSingleSkillFile()
        : await uploadSkillFolder();
    }

    const file = await browserOpenFile(accept);
    if (!file) return null;
    return { fileName: file.name, content: await file.text(), sourceType: 'file', entryFileName: file.name };
  } catch (error) {
    console.error('Upload skill failed:', error);
    throw error;
  }
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

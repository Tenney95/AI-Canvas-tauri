import { writeFile, readFile as tauriReadFile } from '@tauri-apps/plugin-fs';
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
  type WorkflowRecord,
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
// Source node file upload (returns dataUrl + fileName)
// ============================================

export interface UploadResult {
  dataUrl: string;
  fileName: string;
  fileSize: number;
}

/** 为源节点上传文件 — 返回 data URL + 文件名 + 大小 */
export async function uploadSourceFile(accept?: string): Promise<UploadResult | null> {
  try {
    if (isTauriEnv()) {
      const filePath = await open({
        multiple: false,
        title: '选择文件',
        filters: accept ? [{ name: '支持的文件', extensions: accept.split(',').map((e) => e.trim().replace('.', '')) }] : [],
      });

      if (!filePath) return null;

      const content = await tauriReadFile(filePath);
      const base64 = arrayBufferToBase64(content.buffer);
      const fileName = filePath.split(/[\\/]/).pop() || 'file';
      const ext = fileName.split('.').pop()?.toLowerCase() || '';
      const mimeType = getMimeType(ext);
      return {
        dataUrl: `data:${mimeType};base64,${base64}`,
        fileName,
        fileSize: content.byteLength,
      };
    }

    // 浏览器降级：通过 file input 读取
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
    console.error('Source file upload failed:', error);
    throw error;
  }
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
